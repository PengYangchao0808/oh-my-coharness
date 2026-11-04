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
import { isAbsolute, resolve } from 'node:path'

import { dispatchTasks } from '../src/dispatch.js'
import {
  MAX_PACKET_CHARS, buildWorkPacket, fitWorkPacket, renderWorkPacket, treeFingerprint,
} from './work-packet.js'

export const MANAGED_EXECUTION_VERSION = 1

const PRE_SPAWN_CODES = new Set([
  'OMC/EMPTY-TASK', 'OMC/TOO-MANY-TASKS', 'OMC/ROUTING-LIMIT', 'OMC/BUDGET-EXHAUSTED',
  'OMC/PROJECT-POLICY-UNREADABLE', 'OMC/PROJECT-POLICY-MODE', 'OMC/PARALLEL-WRITE',
  'OMC/NO-PROVIDER', 'OMC/UNKNOWN-HARNESS', 'OMC/ADAPTER-UNSUPPORTED',
])

function managedError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function digest(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function callerWorkspace(request, exec) {
  const raw = typeof request?.cwd === 'string' && request.cwd.trim() !== '' ? request.cwd.trim() : null
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (raw && isAbsolute(raw)) return resolve(raw)
  if (raw && typeof headerCwd === 'string' && headerCwd !== '') return resolve(headerCwd, raw)
  if (typeof headerCwd === 'string' && headerCwd !== '') return resolve(headerCwd)
  return process.cwd()
}

/**
 * @param {{
 *   graph: object, mailbox: object, tasks: object,
 *   executionStore: object, usageLedger: object|null,
 *   acceptance?: object|null, acceptanceRunnerFor?: ((cwd: string) => object)|null,
 *   artifactStore?: object|null, packetMaxChars?: number,
 * }} stores - the per-host store instances (see src/index.js apply()).
 */
export function createManagedExecution({
  graph, mailbox, tasks, executionStore, usageLedger = null,
  acceptance = null, acceptanceRunnerFor = null,
  artifactStore = null, packetMaxChars = MAX_PACKET_CHARS,
} = {}) {
  if (acceptance && typeof graph?.setAcceptance === 'function') graph.setAcceptance(acceptance)

  function requireStores() {
    if (!graph || !mailbox || !tasks || !executionStore) {
      throw managedError('OMC/MANAGED-UNAVAILABLE', 'the managed path needs the graph, mailbox, task and execution stores')
    }
  }

  function runnerFor(cwd, request) {
    if (request?.acceptanceRunner && typeof request.acceptanceRunner.run === 'function') return request.acceptanceRunner
    if (typeof acceptanceRunnerFor === 'function') return acceptanceRunnerFor(cwd)
    return null
  }

  const PACKET_TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

  /**
   * Build/fit the managed WorkPacket in the same pre-dispatch stage as the
   * acceptance baseline. A node without acceptance criteria keeps its legacy
   * execution-only semantics and is labelled `legacy` rather than claiming the
   * three-chain contract.
   */
  function preparePacket({ request, node, taskId, workspace, caller, acceptanceSpec }) {
    if (request?.packet && typeof request.packet === 'object') {
      const fit = fitWorkPacket(request.packet, { maxChars: request.packetMaxChars ?? packetMaxChars, artifactStore })
      return {
        packet: fit.packet,
        text: renderWorkPacket(fit.packet),
        externalized: fit.externalized,
        coverage: 'managed',
        digest: digest(renderWorkPacket(fit.packet)),
      }
    }
    const acceptance = Array.isArray(request?.packetAcceptance) && request.packetAcceptance.length
      ? request.packetAcceptance
      : Array.isArray(node.acceptance) && node.acceptance.length
        ? node.acceptance
        : acceptanceSpec?.rubric?.length
          ? acceptanceSpec.rubric
          : acceptanceSpec?.commands?.map((command) => command.name ?? command.label).filter(Boolean) ?? []
    if (!acceptance.length) {
      return { packet: null, text: '', externalized: [], coverage: 'legacy', digest: null }
    }
    const prompt = String(request?.prompt ?? request?.tasks?.[0]?.prompt ?? '')
    const packetTaskId = PACKET_TASK_PATTERN.test(String(taskId)) ? String(taskId) : `node-${digest(taskId).slice(0, 12)}`
    const tree = treeFingerprint(workspace)
    const packet = buildWorkPacket({
      taskId: packetTaskId,
      laneId: node.roleId ? `lane-${node.roleId}` : request?.laneId ?? null,
      role: node.roleId || null,
      goal: String(request?.packetGoal ?? prompt).trim().slice(0, 4000) || `complete graph node ${node.id}`,
      acceptance,
      reads: Array.isArray(request?.packetReads) ? request.packetReads : [],
      writeScope: node.writeScope ?? [],
      commit: request?.baseCommit ?? null,
      treeDigest: tree.digest,
      capturedAt: tree.capturedAt,
      facts: Array.isArray(request?.packetFacts) ? request.packetFacts : [],
      decisions: Array.isArray(request?.packetDecisions) ? request.packetDecisions : [],
      openQuestions: Array.isArray(request?.packetOpenQuestions) ? request.packetOpenQuestions : [],
      artifacts: Array.isArray(request?.packetArtifacts) ? request.packetArtifacts : [],
      maxCalls: request?.packetBudget?.maxCalls ?? null,
      maxUsd: request?.packetBudget?.maxUsd ?? null,
      readOnly: !node.write,
    })
    const fit = fitWorkPacket(packet, { maxChars: request?.packetMaxChars ?? packetMaxChars, artifactStore })
    return {
      packet: fit.packet,
      text: renderWorkPacket(fit.packet),
      externalized: fit.externalized,
      coverage: 'managed',
      digest: digest(renderWorkPacket(fit.packet)),
    }
  }

  /**
   * The root shard and the host-proven lineage of the calling agent.
   *
   * A child agent's dispatch belongs to the root's graph/task shard; it must
   * not open a second parent. When the host cannot prove the chain the caller's
   * own id is used and the lineage is labeled unknown, never host.
   */
  function callerIdentity(rt, exec) {
    const agentId = exec?.agent?.id
    const sessionId = exec?.agent?.session?.id
    const header = exec?.agent?.session?.header ?? null
    if (!agentId) return { parentId: null, lineage: null, rootTaskId: null, trusted: false }
    let binding = null
    try {
      binding = rt?.native?.bindingFor?.(sessionId)
        ?? rt?.native?.resolveCallingSession?.({ sessionId, header, agentId })
        ?? null
    } catch {
      binding = null
    }
    if (binding && binding.unresolved !== true) {
      return {
        parentId: binding.parentId ?? agentId,
        lineage: binding.lineage ?? { source: 'unknown' },
        rootTaskId: binding.rootTaskId ?? null,
        trusted: binding.lineage?.source === 'host',
      }
    }
    return {
      parentId: agentId,
      lineage: binding?.lineage ?? {
        source: 'unknown',
        parentSessionId: null,
        rootSessionId: null,
        note: 'no host binding proved this caller; the graph claim stays legacy/unknown',
      },
      rootTaskId: null,
      trusted: false,
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
      const caller = callerIdentity(rt, exec)
      const parentId = caller.parentId
      if (!parentId) throw managedError('OMC/MANAGED-PARENT', 'the managed path needs a calling agent')
      const nodeId = request.nodeId ?? request.node_id
      if (!nodeId) {
        throw managedError('OMC/MANAGED-NODE', 'a managed dispatch needs nodeId (graph node it executes)')
      }

      const workspace = callerWorkspace(request, exec)
      // 1. Claim first: an unclaimable node must not start work (A13/A14). The
      //    claim carries the trusted lineage so a child of another root cannot
      //    claim this graph instead of silently writing across shards. A write
      //    node also takes the project writer lease here.
      const claim = graph.claim(parentId, nodeId, {
        taskId: request.taskId,
        rootTaskId: caller.rootTaskId,
        lineage: caller.lineage,
        strictLineage: rt?.lineageStrict === true,
        workspace,
      })
      const node = claim.node
      const taskId = node.taskId || `node-${nodeId}`

      // 2. Frame the execution attempt (intent), freeze the acceptance baseline
      //    BEFORE anything is launched, then record launching. A baseline taken
      //    after this point is refused by the acceptance authority.
      let attempt = executionStore.open({
        taskId,
        parentId,
        backend: 'external',
        route: null,
        reason: `graph node ${nodeId}`,
        intent: { backend: 'external', nodeId, cwd: workspace, mode: request.mode ?? null },
      })
      const acceptanceSpec = request.acceptanceSpec ?? node.acceptanceSpec ?? null
      // 2b. WorkPacket: built and fitted in the SAME pre-dispatch stage as the
      //     acceptance baseline. A node without acceptance keeps its legacy
      //     execution-only contract and is labelled `legacy`, never "managed".
      let prepared = { packet: null, text: '', externalized: [], coverage: 'legacy', digest: null }
      try {
        prepared = preparePacket({ request, node, taskId, workspace, caller, acceptanceSpec })
      } catch (error) {
        executionStore.settle(taskId, attempt.currentAttemptId, {
          execution: 'failed', stopReason: error?.code ?? 'work packet refused', by: `graph node ${nodeId}`,
        })
        graph.release(parentId, nodeId, {
          reason: `work packet refused: ${String(error?.message ?? error)}`,
          claimId: claim.claimId,
        })
        throw error
      }
      let baseline = null
      let runner = null
      if (acceptance && acceptanceSpec && typeof acceptance.freeze === 'function') {
        runner = runnerFor(workspace, request)
        if (runner) {
          try {
            baseline = await acceptance.freeze({
              spec: acceptanceSpec,
              workdir: workspace,
              runner,
              taskId,
              nodeId,
              attemptId: attempt.currentAttemptId,
            })
            graph.setBaseline(parentId, nodeId, {
              baseline,
              spec: acceptanceSpec,
              claimId: claim.claimId,
              attemptId: attempt.currentAttemptId,
            })
          } catch (error) {
            executionStore.settle(taskId, attempt.currentAttemptId, {
              execution: 'failed', stopReason: error?.code ?? 'acceptance baseline failed', by: `graph node ${nodeId}`,
            })
            graph.release(parentId, nodeId, {
              reason: `acceptance baseline failed: ${String(error?.message ?? error)}`,
              claimId: claim.claimId,
            })
            throw error
          }
        }
      }
      const packetIntent = prepared.packet ? {
        taskId: prepared.packet.taskId,
        digest: prepared.digest,
        treeDigest: prepared.packet.baseline.treeDigest,
        acceptanceCount: prepared.packet.acceptance.length,
        externalized: prepared.externalized,
        coverage: prepared.coverage,
        lineage: { rootTaskId: caller.rootTaskId ?? node.rootTaskId ?? null, parentTaskId: node.parentTaskId ?? null },
      } : { coverage: prepared.coverage }
      executionStore.launching(taskId, attempt.currentAttemptId, {
        intent: { backend: 'external', nodeId, cwd: workspace, packet: packetIntent },
        by: `graph node ${nodeId}`,
      })
      const basePrompt = String(request.prompt ?? request.tasks?.[0]?.prompt ?? '')
      const injection = injectMessages(parentId, {
        taskId, lane: node.roleId ? `lane-${node.roleId}` : undefined, attemptId: attempt.currentAttemptId, basePrompt,
      })
      const packetPrompt = prepared.text ? `${prepared.text}\n\n--- task ---\n${basePrompt}` : basePrompt
      const prompt = injection.text ? `${packetPrompt}\n\n${injection.text}` : packetPrompt

      try {
        // 3. Activate through the ordinary dispatch path (its final policy
        //    gate from WP01 still applies unchanged).
        const result = await dispatchTasks(rt, {
          ...request,
          roleId: request.roleId ?? node.roleId ?? request.role ?? null,
          prompt,
          nodeId: undefined,
          node_id: undefined,
        }, exec)
        const first = result?.results?.[0]
        if (!first) throw managedError('OMC/MANAGED-NO-RESULT', 'the dispatch returned no result')
        if (first.status === 'started') {
          // A background dispatch has no terminal event yet: it is running, not
          // completed, and the host notice owns the eventual settlement.
          executionStore.running(taskId, attempt.currentAttemptId, { by: `graph node ${nodeId}` })
          confirmConsumed(parentId, injection.messages, attempt.currentAttemptId)
          return {
            ...result,
            results: result.results.map((row, index) => index === 0 ? {
              ...row, managed: true, nodeId, taskId, attemptId: attempt.currentAttemptId,
              packetCoverage: prepared.coverage,
              ...(prepared.packet ? { packet: packetIntent } : {}),
            } : row),
            attempt: {
              taskId, attemptId: attempt.currentAttemptId, execution: 'running', phase: 'running',
              lineage: caller.lineage ?? null, packet: packetIntent,
            },
          }
        }

        // 4. Record execution settlement; acceptance stays separate. A
        //    completed run with no acceptance verdict does NOT unlock
        //    dependents: the node completes only on a trusted verdict.
        const execution = first.status === 'completed' ? 'completed' : first.status === 'cancelled' ? 'cancelled' : 'failed'
        executionStore.running(taskId, attempt.currentAttemptId, { by: `graph node ${nodeId}` })
        executionStore.settle(taskId, attempt.currentAttemptId, {
          execution, stopReason: first.stopReason ?? first.status,
          by: `graph node ${nodeId}`,
        })
        const hasAcceptance = (Array.isArray(node.acceptance) && node.acceptance.length > 0) || Boolean(node.acceptanceSpec)
        let acceptedVerdict = null
        if (first.status === 'completed' && hasAcceptance) {
          let verification = null
          try {
            verification = await graph.verify(parentId, nodeId, {
              taskId,
              spec: acceptanceSpec ?? node.acceptanceSpec ?? node.acceptance,
              workdir: workspace,
              baseline: baseline ?? node.acceptanceBaseline ?? undefined,
              verdict: request.acceptanceVerdict ?? undefined,
              attemptId: attempt.currentAttemptId,
              runner,
              timeoutMs: request.acceptanceTimeoutMs,
            })
          } catch (error) {
            graph.release(parentId, nodeId, {
              to: 'failed',
              reason: `acceptance unavailable: ${String(error?.message ?? error)}`,
              claimId: claim.claimId,
            })
            executionStore.acceptance(taskId, {
              state: 'unknown',
              evidence: [String(error?.message ?? error)],
              attemptId: attempt.currentAttemptId,
            })
            throw error
          }
          if (verification.state === 'passed' && verification.verdict) acceptedVerdict = verification.verdict
          else {
            graph.release(parentId, nodeId, {
              to: verification.state === 'failed' ? 'failed' : 'ready',
              reason: verification.reason ?? `acceptance ${verification.state}`,
              claimId: claim.claimId,
            })
            confirmConsumed(parentId, injection.messages, attempt.currentAttemptId)
            return {
              ...result,
              results: result.results.map((row, index) => index === 0
                ? {
                    ...row, managed: true, nodeId, taskId, attemptId: attempt.currentAttemptId,
                    acceptanceGate: verification.reason ?? null,
                    packetCoverage: prepared.coverage,
                    ...(prepared.packet ? { packet: packetIntent } : {}),
                  }
                : { ...row, managed: false, note: 'not bound to a graph node' }),
              attempt: {
                taskId, attemptId: attempt.currentAttemptId, execution,
                acceptance: verification.state, verdict: verification.verdict ?? null,
                lineage: caller.lineage ?? null, packet: packetIntent,
              },
              note: 'execution finished but acceptance did not pass; the node was not completed',
            }
          }
        }
        const graphStatus = first.status === 'completed' ? 'completed' : 'failed'
        let settled
        try {
          settled = graph.complete(parentId, nodeId, {
            status: graphStatus,
            evidence: Array.isArray(request.evidence) ? request.evidence : [],
            changedFiles: first.changed_files ?? first.files ?? (first.worktree ? undefined : []),
            taskId,
            ...(claim.claimId ? { claimId: claim.claimId } : {}),
            ...(acceptedVerdict ? { verdict: acceptedVerdict, workdir: workspace, attemptId: attempt.currentAttemptId } : {}),
          })
        } catch (error) {
          if (error?.code === 'OMC/GRAPH-ACCEPTANCE' || error?.code === 'OMC/GRAPH-WRITE-AUDIT') {
            // Execution completed but the node's own acceptance gate refused:
            // settle the graph node as failed-with-note instead of wedging,
            // and keep the execution record truthful (completed, acceptance
            // not passed — never "delivered").
            graph.release(parentId, nodeId, {
              to: 'failed',
              reason: `acceptance gate: ${error.message}`,
              ...(claim.claimId ? { claimId: claim.claimId } : {}),
            })
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
                packetCoverage: prepared.coverage,
                ...(prepared.packet ? { packet: packetIntent } : {}),
                ...(settled?.gate ? { acceptanceGate: settled.gate } : {}) }
            : { ...row, managed: false, note: 'not bound to a graph node' }),
          attempt: {
            taskId, attemptId: attempt.currentAttemptId, execution,
            acceptance: executionStore.read(taskId)?.acceptance ?? null,
            lineage: caller.lineage ?? null, packet: packetIntent,
          },
        }
      } catch (error) {
        // Activation failure, crash or dispatch throw. The distinction matters:
        // a refusal known to happen BEFORE any spawn is a failed attempt; once
        // launching was recorded, an unexplained crash is unknown (it may have
        // run) and is never auto-replayed.
        const preSpawn = PRE_SPAWN_CODES.has(error?.code) || error?.code === 'OMC/CLI-CANCELLED'
        try {
          if (preSpawn) {
            executionStore.settle(taskId, attempt.currentAttemptId, {
              execution: error?.code === 'OMC/CLI-CANCELLED' ? 'cancelled' : 'failed',
              stopReason: error?.code ?? error?.message ?? 'dispatch failed', by: `graph node ${nodeId}`,
            })
          } else {
            executionStore.markUnknown(taskId, attempt.currentAttemptId, {
              reason: `dispatch failed after launch was recorded: ${String(error?.code ?? error?.message ?? error)}`,
              by: `graph node ${nodeId}`,
            })
          }
        } catch { /* the dispatch error is the useful one */ }
        try {
          graph.release(parentId, nodeId, {
            reason: `activation failed: ${String(error?.message ?? error)}`,
            ...(claim.claimId ? { claimId: claim.claimId } : {}),
          })
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
      executionStore.launching(task.taskId ?? taskId, attempt.currentAttemptId, {
        intent: { backend: 'external', reused: true }, by: 'explicit re-execution',
      })
      const injection = injectMessages(parentId, {
        taskId: task.taskId ?? taskId, lane: task.lane ?? undefined,
        attemptId: attempt.currentAttemptId, basePrompt: String(prompt ?? ''),
      })
      const fullPrompt = injection.text ? `${prompt}\n\n${injection.text}` : prompt
      let result
      try {
        result = await dispatchTasks(rt, {
          harness: task.harness, prompt: fullPrompt, cwd: undefined, mode: 'read-only',
        }, exec)
      } catch (error) {
        // An explicit re-execution that died after launch is unknown, not
        // failed: the CLI may have run. It is never retried automatically.
        try {
          executionStore.markUnknown(task.taskId ?? taskId, attempt.currentAttemptId, {
            reason: `re-execution failed after launch: ${String(error?.code ?? error?.message ?? error)}`,
            by: 'explicit re-execution',
          })
        } catch { /* preserve the dispatch error */ }
        throw error
      }
      const first = result?.results?.[0]
      const execution = first?.status === 'completed' ? 'completed' : 'failed'
      executionStore.running(task.taskId ?? taskId, attempt.currentAttemptId, { by: 'explicit re-execution' })
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
