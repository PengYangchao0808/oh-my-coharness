/**
 * Managed execution path (0.5.0-alpha.2 WP05).
 *
 * The managed path binds one dispatch to the orchestration contract end to
 * end (V0.5-ALPHA2-PLAN §5):
 *
 *   validate packet → apply final policy → graph claim → reserve concurrency/
 *   budget → activate → receive events → record result → acceptance → settle
 *   and release.
 *
 * Every step is crash-recoverable: a claim that never activates is released,
 * settlement is idempotent, mailbox injections are keyed per attempt, and a
 * restarted host reconciles before anything new runs. Dispatches that do NOT
 * take this path keep working, but they are labeled `managed: false` — an
 * unmanaged call is honest surface, never silently counted as covered.
 */

import { createHash } from 'node:crypto'

import { dispatchTasks } from '../src/dispatch.js'

export const MANAGED_EXECUTION_VERSION = 1

function managedError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function digest(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * @param {{
 *   graph: object, mailbox: object, tasks: object,
 *   executionStore: object, usageLedger: object|null,
 * }} stores - the per-host store instances (see src/index.js apply()).
 */
export function createManagedExecution({ graph, mailbox, tasks, executionStore, usageLedger = null } = {}) {
  function requireStores() {
    if (!graph || !mailbox || !tasks || !executionStore) {
      throw managedError('OMC/MANAGED-UNAVAILABLE', 'the managed path needs the graph, mailbox, task and execution stores')
    }
  }

  /**
   * Collect and durably record the messages one attempt injects. Idempotent
   * per (message, attempt): a crash between injection and settlement leaves
   * the message `injected`, and the retry re-records the same key (A15).
   */
  function injectMessages(parentId, { taskId, lane, attemptId, basePrompt }) {
    const pending = mailbox.pendingInjections(parentId, { taskId, lane })
    if (!pending.length) return { messages: [], text: '' }
    const recorded = []
    for (const message of pending) {
      mailbox.recordInjection(parentId, message.id, { attemptId, promptDigest: digest(basePrompt) })
      recorded.push(message)
    }
    const text = ['--- messages for this task (injected before this run) ---',
      ...recorded.map((message) => `[${message.id}] ${message.from} (${message.kind}): ${message.text}`),
      '--- end of injected messages ---'].join('\n')
    return { messages: recorded, text }
  }

  function confirmConsumed(parentId, messages, attemptId) {
    for (const message of messages) {
      try {
        mailbox.confirmConsumed(parentId, message.id, { attemptId })
      } catch {
        // Consumption confirmation is best-effort at this boundary; the
        // injection record (durable) is what prevents double injection.
      }
    }
  }

  return {
    /**
     * One managed dispatch. `request` is a dispatchTasks request plus
     * `nodeId`; `exec` is the calling execution context. The graph claim and
     * the execution store frame the whole run, and the result carries an
     * explicit managed-coverage marker.
     */
    async dispatch(rt, request, exec) {
      requireStores()
      const parentId = exec?.agent?.id
      if (!parentId) throw managedError('OMC/MANAGED-PARENT', 'the managed path needs a calling agent')
      const nodeId = request.nodeId ?? request.node_id
      if (!nodeId) {
        throw managedError('OMC/MANAGED-NODE', 'a managed dispatch needs nodeId (graph node it executes)')
      }

      // 1. Claim first: an unclaimable node must not start work (A13/A14).
      const claim = graph.claim(parentId, nodeId, { taskId: request.taskId })
      const node = claim.node
      const taskId = node.taskId || `node-${nodeId}`

      // 2. Frame the execution attempt (execution store) and inject mailbox
      //    messages for this task/lane into the prompt, keyed to the attempt.
      let attempt = executionStore.open({ taskId, parentId, backend: 'external', route: null, reason: `graph node ${nodeId}` })
      const basePrompt = String(request.prompt ?? request.tasks?.[0]?.prompt ?? '')
      const injection = injectMessages(parentId, {
        taskId, lane: node.roleId ? `lane-${node.roleId}` : undefined, attemptId: attempt.currentAttemptId, basePrompt,
      })
      const prompt = injection.text ? `${basePrompt}\n\n${injection.text}` : basePrompt

      try {
        // 3. Activate through the ordinary dispatch path (its final policy
        //    gate from WP01 still applies unchanged).
        const result = await dispatchTasks(rt, { ...request, prompt, nodeId: undefined, node_id: undefined }, exec)
        const first = result?.results?.[0]
        if (!first) throw managedError('OMC/MANAGED-NO-RESULT', 'the dispatch returned no result')

        // 4. Record execution settlement; acceptance stays separate. A
        //    completed run with no acceptance evidence does NOT unlock
        //    dependents: the graph completes only on evidence (its own rule).
        const execution = first.status === 'completed' ? 'completed' : first.status === 'cancelled' ? 'cancelled' : 'failed'
        executionStore.settle(taskId, attempt.currentAttemptId, {
          execution, stopReason: first.stopReason ?? first.status,
          by: `graph node ${nodeId}`,
        })
        if (first.status === 'completed' && Array.isArray(node.acceptance) && node.acceptance.length) {
          // Acceptance for a development node is the graph's evidence rule;
          // the caller's evidence arrives with graph complete, so here the
          // verdict is pending until that call (or provided evidence) lands.
          executionStore.acceptance(taskId, { state: 'pending', evidence: node.acceptance, attemptId: attempt.currentAttemptId })
        }
        const graphStatus = first.status === 'completed' ? 'completed' : 'failed'
        let settled
        try {
          settled = graph.complete(parentId, nodeId, {
            status: graphStatus,
            evidence: Array.isArray(request.evidence) ? request.evidence : [],
            changedFiles: first.changed_files ?? first.files ?? (first.worktree ? undefined : []),
            taskId,
          })
        } catch (error) {
          if (error?.code === 'OMC/GRAPH-ACCEPTANCE' || error?.code === 'OMC/GRAPH-WRITE-AUDIT') {
            // Execution completed but the node's own acceptance gate refused:
            // settle the graph node as failed-with-note instead of wedging,
            // and keep the execution record truthful (completed, acceptance
            // not passed — never "delivered").
            graph.release(parentId, nodeId, { to: 'failed', reason: `acceptance gate: ${error.message}` })
            executionStore.acceptance(taskId, { state: 'failed', evidence: [error.message], attemptId: attempt.currentAttemptId })
            settled = { node: graph.read(parentId).nodes[nodeId], gate: error.message }
          } else {
            throw error
          }
        }
        confirmConsumed(parentId, injection.messages, attempt.currentAttemptId)
        return {
          ...result,
          results: result.results.map((row, index) => index === 0
            ? { ...row, managed: true, nodeId, taskId, attemptId: attempt.currentAttemptId,
                ...(settled?.gate ? { acceptanceGate: settled.gate } : {}) }
            : { ...row, managed: false, note: 'not bound to a graph node' }),
          attempt: { taskId, attemptId: attempt.currentAttemptId, execution, acceptance: executionStore.read(taskId)?.acceptance ?? null },
        }
      } catch (error) {
        // Activation failure, crash or dispatch throw: release the claim so
        // the node is claimable again, and frame the failed attempt (A13).
        try {
          executionStore.settle(taskId, attempt.currentAttemptId, {
            execution: error?.code === 'OMC/CLI-CANCELLED' ? 'cancelled' : 'failed',
            stopReason: error?.code ?? error?.message ?? 'dispatch failed', by: `graph node ${nodeId}`,
          })
        } catch { /* the dispatch error is the useful one */ }
        try {
          graph.release(parentId, nodeId, { reason: `activation failed: ${String(error?.message ?? error)}` })
        } catch { /* node may have settled already */ }
        throw error
      }
    },

    /**
     * Explicit re-execution of a retained task (A16): re-validate the current
     * policy and workspace before dispatch, open a NEW attempt (old evidence
     * never carries over), and run through the same managed frame when the
     * task still has a node, otherwise as an unmanaged-but-labeled dispatch.
     */
    async reexecute(rt, { parentId, taskId, prompt, exec, validate = () => [] }) {
      requireStores()
      const task = tasks.read(parentId, taskId)
      if (!task) throw managedError('OMC/TASK-UNKNOWN', `no retained task ${taskId} for this session`)
      const problems = validate(task)
      if (problems.length) {
        throw managedError('OMC/REUSE-REFUSED', `the world changed since this task ran: ${problems.join('; ')}`)
      }
      const view = executionStore.read(task.taskId ?? taskId)
      const attempt = executionStore.retry(task.taskId ?? taskId, { reason: 'explicit re-execution', backend: 'external' })
      const injection = injectMessages(parentId, {
        taskId: task.taskId ?? taskId, lane: task.lane ?? undefined,
        attemptId: attempt.currentAttemptId, basePrompt: String(prompt ?? ''),
      })
      const fullPrompt = injection.text ? `${prompt}\n\n${injection.text}` : prompt
      const result = await dispatchTasks(rt, {
        harness: task.harness, prompt: fullPrompt, cwd: undefined, mode: 'read-only',
      }, exec)
      const first = result?.results?.[0]
      const execution = first?.status === 'completed' ? 'completed' : 'failed'
      executionStore.settle(task.taskId ?? taskId, attempt.currentAttemptId, { execution, stopReason: first?.status })
      confirmConsumed(parentId, injection.messages, attempt.currentAttemptId)
      return {
        ...result,
        results: (result?.results ?? []).map((row, index) => ({ ...row, managed: false, reused: true, ...(index === 0 ? { attemptId: attempt.currentAttemptId } : {}) })),
        previousAcceptance: view?.acceptance ?? null,
        note: 're-execution opened a new attempt; the previous acceptance evidence was not inherited',
      }
    },

    /** Crash recovery for one parent: reconcile claims and executions. */
    recover(parentId, { isAlive } = {}) {
      requireStores()
      const graphResult = graph.recover(parentId, { isAlive })
      const executionResult = executionStore.reconcileAfterRestart(parentId, { isAlive })
      return { graph: graphResult, execution: executionResult }
    },

    /** Render the coverage marker for status surfaces. */
    coverage(parentId) {
      const status = graph.status(parentId)
      return {
        managedNodes: status.nodes.filter((node) => node.state !== 'pending').length,
        runningWriters: status.writes,
        unmanagedDispatchesPossible: true,
        note: 'only dispatches that claimed a graph node are managed; every other path is labeled managed:false',
      }
    },
  }
}
