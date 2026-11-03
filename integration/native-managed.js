/**
 * Managed path for native children (0.5.0-alpha.2 R03).
 *
 * The external managed path (integration/managed-execution.js) starts the work
 * itself. A native child is started by the host's own role tool, so OMC cannot
 * claim a node "instead of" the child — it can only *bind* a child that already
 * exists to a node, then settle that node from the durable records the bridge
 * already produces.
 *
 * That is the whole contract here, and it is deliberately explicit:
 *
 *   bind    claim the node (or reuse the claim) and attach a native session to
 *           it: parent task, node, role, single-writer scope.
 *   settle  apply the execution store's verdict. Execution `completed` alone
 *           never completes the node: acceptance needs supplied evidence, and
 *           only then do dependants unlock.
 *   coverage managed vs unmanaged counts, so "my child ran" is never sold as
 *           "the whole run was managed".
 *
 * Honest limits:
 *   - A native child that nobody bound stays `managed: false`; OMC does not
 *     retroactively claim a run it did not frame.
 *   - `settle` refuses while the execution is still running (no early settle),
 *     and refuses an acceptance verdict for an attempt other than the current
 *     one (old evidence never carries over to new requirements).
 *   - The graph claim is a coordination constraint, not a file permission.
 */

import { nativeTaskIdFor } from './native-runtime.js'

export const NATIVE_MANAGED_VERSION = 1

function managedError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * @param {{graph: object, native: object, executionStore: object}} stores
 */
export function createNativeManaged({ graph, native, executionStore } = {}) {
  function requireStores() {
    if (!graph || !native || !executionStore) {
      throw managedError('OMC/NATIVE-MANAGED-UNAVAILABLE', 'the native managed path needs graph, native runtime and execution store')
    }
  }

  function nodeOf(parentId, nodeId) {
    const status = graph.status(parentId)
    return status.nodes.find((node) => node.id === nodeId || node.nodeId === nodeId) ?? null
  }

  return {
    version: NATIVE_MANAGED_VERSION,

    /**
     * Bind one existing native child session to a graph node.
     *
     * Re-binding the same (node, session) pair is idempotent; binding a
     * different session to a node that already has one is refused, because that
     * would re-attribute work already framed under another child.
     */
    bind({ parentId, nodeId, sessionId, role = null, taskId = null } = {}) {
      requireStores()
      if (typeof parentId !== 'string' || parentId === '') throw managedError('OMC/NATIVE-MANAGED-INPUT', 'bind needs parentId')
      if (typeof nodeId !== 'string' || nodeId === '') throw managedError('OMC/NATIVE-MANAGED-INPUT', 'bind needs nodeId')
      if (typeof sessionId !== 'string' || sessionId === '') throw managedError('OMC/NATIVE-MANAGED-INPUT', 'bind needs the native child sessionId')

      const existing = native.bindingFor(sessionId)
      if (existing && existing.nodeId && existing.nodeId !== nodeId) {
        throw managedError('OMC/NATIVE-MANAGED-CONFLICT', `session ${sessionId} is already bound to node ${existing.nodeId}`)
      }

      const node = nodeOf(parentId, nodeId)
      if (!node) throw managedError('OMC/GRAPH-NODE-UNKNOWN', `node ${nodeId} is not in this parent's graph`)

      // The node must carry the task id the bridge will book under, so it is
      // resolved before the claim instead of after it.
      const resolvedTaskId = taskId ?? existing?.taskId ?? nativeTaskIdFor(sessionId)
      let claim = null
      if (node.state === 'pending' || node.state === 'ready') {
        claim = graph.claim(parentId, nodeId, { taskId: resolvedTaskId, childId: sessionId })
      } else if (node.state === 'running') {
        // Already claimed: accept it only when this session (or nobody) owns it.
        const owner = node.childId ?? node.taskId ?? null
        if (owner && owner !== sessionId && owner !== resolvedTaskId) {
          throw managedError('OMC/GRAPH-CLAIMED-ELSEWHERE', `node ${nodeId} is already running under ${owner}`)
        }
        claim = { node, reused: true }
      } else {
        throw managedError('OMC/GRAPH-SETTLED', `node ${nodeId} is already ${node.state}; a settled node needs a new attempt, not a bind`)
      }

      const binding = native.bind({
        sessionId,
        parentId,
        taskId: resolvedTaskId,
        nodeId,
        ...(role ? { role } : {}),
        source: 'managed',
      })
      return {
        managed: true,
        nodeId,
        taskId: binding.taskId,
        sessionId,
        binding,
        graph: graph.status(parentId),
        note: 'execution settles from the native turn/end events; acceptance still needs evidence',
      }
    },

    /**
     * Apply the durable execution verdict to the node.
     *
     * @param {{parentId: string, nodeId: string, evidence?: string[],
     *          changedFiles?: string[], attemptId?: string}} input
     */
    settle({ parentId, nodeId, evidence = null, changedFiles = null, attemptId = null } = {}) {
      requireStores()
      const node = nodeOf(parentId, nodeId)
      if (!node) throw managedError('OMC/GRAPH-NODE-UNKNOWN', `node ${nodeId} is not in this parent's graph`)
      const taskId = node.taskId
      if (!taskId) throw managedError('OMC/NATIVE-MANAGED-UNBOUND', `node ${nodeId} has no native task; bind a child first`)

      const view = executionStore.read(taskId)
      if (!view) throw managedError('OMC/EXECUTION-UNKNOWN', `no execution record for ${taskId}`)
      const currentAttempt = attemptId ?? view.currentAttemptId
      if (attemptId && view.currentAttemptId !== attemptId) {
        throw managedError(
          'OMC/NATIVE-MANAGED-STALE-ATTEMPT',
          `attempt ${attemptId} is not the current attempt (${view.currentAttemptId}); old evidence never settles a new attempt`,
        )
      }
      if (view.execution === 'running') {
        throw managedError('OMC/NATIVE-MANAGED-RUNNING', `task ${taskId} is still running; a native child is settled only by its terminal turn/end`)
      }

      if (view.execution === 'completed') {
        if (!Array.isArray(evidence) || evidence.length === 0) {
          return {
            managed: true,
            nodeId,
            execution: view.execution,
            acceptance: 'pending',
            delivered: false,
            graph: graph.status(parentId),
            note: 'execution completed but no acceptance evidence was supplied; the node stays claimed and dependants stay locked',
          }
        }
        const completed = graph.complete(parentId, nodeId, {
          status: 'completed',
          evidence,
          ...(Array.isArray(changedFiles) ? { changedFiles } : {}),
          taskId,
        })
        const acceptance = executionStore.acceptance(taskId, { state: 'passed', evidence, attemptId: currentAttempt })
        return {
          managed: true,
          nodeId,
          execution: view.execution,
          acceptance: acceptance.acceptance.state,
          delivered: acceptance.delivered === true,
          graph: graph.status(parentId),
          completed,
        }
      }

      // failed | cancelled | unknown all release the claim; unknown says so
      // rather than pretending the work failed on purpose.
      const target = view.execution === 'cancelled' ? 'cancelled' : 'failed'
      const released = graph.release(parentId, nodeId, {
        to: target,
        reason: view.stopReason ?? view.execution,
      })
      const acceptance = executionStore.acceptance(taskId, {
        state: view.execution === 'unknown' ? 'unknown' : 'failed',
        evidence: [view.stopReason ?? view.execution],
        attemptId: currentAttempt,
      })
      return {
        managed: true,
        nodeId,
        execution: view.execution,
        acceptance: acceptance.acceptance.state,
        delivered: false,
        graph: graph.status(parentId),
        released,
      }
    },

    /** Managed vs unmanaged coverage for one parent. */
    coverage(parentId) {
      requireStores()
      const status = graph.status(parentId)
      const nodes = status.nodes ?? []
      const bound = nodes.filter((node) => node.childId).length
      const settled = nodes.filter((node) => node.state === 'completed' || node.state === 'failed' || node.state === 'cancelled').length
      return {
        nodes: nodes.length,
        claimed: nodes.filter((node) => node.state === 'running').length,
        settled,
        boundNative: bound,
        unmanagedNativePossible: true,
        note: 'a native child nobody bound is unmanaged; this count never implies full coverage',
      }
    },
  }
}
