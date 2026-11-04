/**
 * Subagent provider factory.
 *
 * One provider per harness, named `omc:<id>`. Registering these is what turns
 * "run a CLI" into a first-class DSH child session: capacity, cancellation,
 * catalogue, completion notice and interrupt all come from `ctx.subagents`
 * (PLAN §3.2, ADAPTER §5).
 *
 * v0.5 adds a second, independent identity. The DSH child id belongs to this
 * run; a native CLI session id belongs to the CLI's own conversation. They are
 * never interchangeable. The provider may resume the latter through the
 * registry, but every DSH run still gets a fresh child id.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { handoffFromPrompt, normalizeWorkspace } from '../integration/handoff.js'
import { sessionKeyFor } from '../integration/sessions.js'
import { workerKeyFor } from '../integration/worker-registry.js'
import { decideSessionAction, STRATEGY_RULES_VERSION } from '../integration/session-strategy.js'
import { readProjectPolicy } from '../integration/project-policy.js'
import { resolveBudgetLimits } from '../integration/request-gate.js'
import { adapterFor } from './adapters.js'
import { harnessConfig } from './config.js'
import { mintRunId } from './ids.js'
import { maskSessionId } from './session-adapters.js'
import { clip, harnessEnv, planTransport } from './transport.js'
import { classifyCliResult } from '../integration/cli-result.js'
import { normalizeUsageBuckets } from '../integration/usage-ledger.js'

/** Prompt content blocks → plain task text. Never invents capabilities. */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(String(block.text ?? ''))
    else if (block.type === 'image') parts.push('[omc: image attachment omitted — this harness cannot receive images from DSH]')
    else if (block.type === 'file') parts.push(`[omc: file attachment omitted: ${block.attachment?.name ?? 'file'}]`)
  }
  return parts.join('\n').trim()
}

function failureText(def, status, outcome, captured, parsedText) {
  const exit = outcome.exitCode === null ? outcome.signal : outcome.exitCode
  const tail = parsedText || captured.stderr || captured.stdout || '(no output)'
  return `${def.label} did not complete (${status}, exit ${exit}).\n\n${tail}`
}

function providerError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * Endpoint identity without the secret. The env-file mtime is included so a
 * rotated token in the same file starts a new native session instead of
 * silently continuing under a different account.
 */
function endpointFingerprint(def, hcfg, env) {
  const baseUrl = env.ANTHROPIC_BASE_URL
    ?? env.OPENAI_BASE_URL
    ?? env.OPENAI_API_BASE
    ?? env.GEMINI_API_BASE_URL
    ?? env.MOONSHOT_BASE_URL
    ?? ''
  let envFileEpoch = ''
  if (hcfg.envFile) {
    try {
      envFileEpoch = String(statSync(hcfg.envFile).mtimeMs)
    } catch {
      envFileEpoch = 'missing'
    }
  }
  return createHash('sha256')
    .update(`${def.id}|${baseUrl}|${hcfg.envFile ?? ''}|${envFileEpoch}`)
    .digest('hex')
    .slice(0, 12)
}

function usageText(usage) {
  if (!usage) return ''
  const parts = []
  if (usage.inputTokens !== null) parts.push(`in ${usage.inputTokens}`)
  if (usage.outputTokens !== null) parts.push(`out ${usage.outputTokens}`)
  if (usage.cachedInputTokens !== null) parts.push(`cached ${usage.cachedInputTokens}`)
  if (usage.costUsd !== null) parts.push(`cost $${usage.costUsd}`)
  return parts.join(' / ')
}

/**
 * @param {{ subprocess: any }} ctx
 * @param {import('./harnesses.js').HarnessDef} def
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} cfg
 * @param {{ readOnly?: boolean, registry?: object }} [options] - the provider
 *   surface is read-only by design; `registry` is the shared session registry.
 */
/**
 * Resolve the bounds one provider run actually uses. Exported so tests and
 * status surfaces can assert the clamp without spawning a CLI. A provider is
 * always read-only; a project or parent constraint may only tighten it.
 */
export function providerConstraints(cfg, def, request) {
  const requestedMode = typeof request?.mode === 'string' ? request.mode : 'read-only'
  if (requestedMode !== 'read-only') {
    throw providerError('OMC/PROVIDER-MODE',
      `provider ${def.id} is a fixed read-only surface and cannot run mode "${requestedMode}"`)
  }
  const cwd = typeof request?.cwd === 'string' && isAbsolute(request.cwd) ? resolve(request.cwd) : null
  const project = cwd ? readProjectPolicy(cwd) : { exists: false, usable: true, policy: {}, path: null, warnings: [] }
  if (project.exists && project.usable === false) {
    throw providerError('OMC/PROJECT-POLICY-UNREADABLE',
      `${project.path}: ${project.warnings?.[0] ?? 'the project policy exists but cannot be read'}; refusing to start a provider run`)
  }
  const constraints = request?.constraints && typeof request.constraints === 'object' ? request.constraints : {}
  let timeoutMs = Number.isSafeInteger(cfg.dispatch.timeoutMs) ? cfg.dispatch.timeoutMs : 120000
  const candidates = [
    harnessConfig(cfg, def.id).timeoutMs,
    Number.isSafeInteger(request?.timeoutMs) ? request.timeoutMs : null,
    Number.isSafeInteger(constraints.timeoutMs) ? constraints.timeoutMs : null,
    project.usable !== false ? project.policy?.dispatch?.timeoutMs : null,
  ].filter((value) => Number.isSafeInteger(value) && value > 0)
  for (const value of candidates) timeoutMs = Math.min(timeoutMs, value)
  return { mode: 'read-only', timeoutMs, project, constraints }
}

export function makeProvider(ctx, def, cfg, options = {}) {
  const registry = options.registry ?? null
  const usageLedger = options.usageLedger ?? null
  const native = options.native ?? null
  const executionStore = options.executionStore ?? null
  const requestGate = options.requestGate ?? null
  const workerRegistry = options.workerRegistry ?? null
  const decisionLog = options.decisionLog ?? null

  /** The provider is a fixed read-only surface; this clamps every input. */
  function effectiveConstraints(request) {
    return providerConstraints(cfg, def, request)
  }

  /**
   * The caller's host-proven identity, used to place this run's task row.
   *
   * The `request.parent` object comes from the host, not from the CLI's prompt,
   * so its session header is authoritative. When no binding exists the run is
   * still recorded, but as `unknown` — a child id argument can never upgrade it
   * to host lineage.
   */
  function callerLineage(request) {
    const parent = request?.parent ?? null
    const agentId = parent?.id ?? null
    const sessionId = parent?.session?.id ?? null
    const header = parent?.session?.header ?? null
    const fallback = {
      source: 'unknown',
      trusted: false,
      rootParentId: null,
      parentSessionId: null,
      rootSessionId: null,
      parentTaskId: null,
      rootTaskId: null,
      depth: null,
      shardParentId: agentId,
      note: 'the provider had no host binding for the calling session',
    }
    if (!native || typeof native.taskLineage !== 'function' || typeof sessionId !== 'string') return fallback
    try {
      const resolved = native.taskLineage({ sessionId, header, agentId })
      if (!resolved) return fallback
      return {
        ...resolved,
        // Cross-shard routing is allowed only for host-proven lineage.
        shardParentId: resolved.trusted && typeof resolved.rootParentId === 'string' && resolved.rootParentId !== ''
          ? resolved.rootParentId
          : agentId,
      }
    } catch {
      return fallback
    }
  }

  /**
   * Book one external dispatch into the usage ledger (R02/R05).
   *
   * One dispatch is one booked attempt: the CLI's own internal rounds are
   * invisible to OMC, so this is an attempt record, not a per-request one.
   * Without a reported usage the entry stays `unknown`; it is never zero.
   * A missing parent identity means the cost cannot be attributed, so nothing
   * is booked and the caller sees no fabricated figure.
   */
  function bookExternalUsage({ runId, taskId = null, parentId, model, usage, sessionId }) {
    if (!usageLedger || typeof usageLedger.append !== 'function') return null
    if (typeof parentId !== 'string' || parentId === '' || typeof runId !== 'string' || runId === '') return null
    const normalized = usage ? normalizeUsageBuckets(usage) : null
    try {
      return usageLedger.append({
        parentId,
        taskId: typeof taskId === 'string' && taskId !== '' ? taskId : runId,
        attemptId: `${runId}#dispatch`,
        backend: 'external',
        source: { kind: 'external-cli', runId, eventId: runId, sessionId: sessionId ?? null },
        // The CLI decides its own model; the configured route is what was asked
        // for, so it is recorded but never marked as an observed request route.
        route: { provider: `omc:${def.id}`, model: model ?? null, effort: null, observed: false },
        usage: normalized ? normalized.buckets : null,
        coverage: normalized ? normalized.coverage : 'unknown',
        cost: usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0
          ? { usd: usage.costUsd, source: 'cli-reported' }
          : null,
      })
    } catch {
      // Accounting must never turn a completed dispatch into a failure.
      return null
    }
  }

  return {
    name: `omc:${def.id}`,
    // An external CLI cannot see this conversation; the host turns that flag into
    // the correct model-facing wording for free.
    inheritsParentContext: false,
    capabilities: {
      agentOptions: false, // do not impose DSH model routing on a CLI
      agentPreset: false,
      outputSchema: false,
      depthLimit: false, // recursion budget belongs to the CLI
    },

    async start(request) {
      const sessionCfg = cfg.sessions ?? {}
      const rawPrompt = blocksToText(request.prompt)
      const identity = handoffFromPrompt(rawPrompt, { cwd: request.cwd })
      const task = identity.text
      const handoff = identity.handoff
      const hcfg = harnessConfig(cfg, def.id)
      const plan = await planTransport(ctx, def, cfg, request.signal)
      const env = harnessEnv(def, hcfg)
      const harnessAdapter = adapterFor(def, cfg)
      if (harnessAdapter.supported !== true) {
        throw providerError(
          'OMC/ADAPTER-UNSUPPORTED',
          `${def.id}: ${harnessAdapter.reason ?? 'this transport is not available'}`,
        )
      }

      // Policy/bounds are resolved before any session lease is taken: a refusal
      // must not strand a lease, and no request argument may widen them.
      const limits = effectiveConstraints(request)

      const sessionAdapter = def.session
      const confidence = sessionAdapter?.confidence ?? 'unverified'
      const adapterAllowed = confidence === 'verified'
        || confidence === 'documented'
        || sessionCfg.allowUnverified === true
      const sessionsOn = sessionCfg.enabled !== false
      // A session key needs a real workspace. Without an explicit cwd the CLI
      // inherits the Host process directory, which is not the user's project;
      // reusing across that boundary would mix unrelated projects.
      const hasWorkspace = typeof request.cwd === 'string' && request.cwd.trim() !== ''
      // Only a signed marker built by this Host process may name a lane. A
      // legacy v0.4 brief or a direct dispatch prompt never resumes a session.
      const workspace = normalizeWorkspace(request.cwd ?? process.cwd())
      // PR-01 attribution is resolved here, before session/worker decisions:
      // the decision log and worker registry live in the root shard, exactly
      // like the task row.
      const attribution = callerLineage(request)
      const attributionParentId = attribution.shardParentId ?? request.parent?.id
      const baseCapture = Boolean(
        sessionsOn && sessionAdapter && adapterAllowed && handoff && identity.source === 'marker' && hasWorkspace && registry
        && handoff.workspace.path === workspace,
      )
      let capture = baseCapture

      // PR-04: the explainable session/worker choice gates resume. A direct
      // dispatch has no signed handoff, so it never reaches this block and can
      // never acquire role-session Resume permission.
      let workerDecision = null
      let workerKey = null
      let priorWorker = null
      let decisionEntry = null
      let workerGeneration = null
      let actualWorkerAction = null
      let decisionFeatures = null
      let decisionCapabilities = null
      let workerOutcome = 'unknown'
      let forceFresh = false
      let lease = null
      let resumeId = null
      let sessionNote = ''
      const workersEnabled = Boolean(workerRegistry && decisionLog && handoff && identity.source === 'marker')
      if (workersEnabled) {
        const route = { provider: `omc:${def.id}`, model: hcfg.model || null }
        const permission = 'read-only'
        workerKey = workerKeyFor({
          projectId: handoff.projectId,
          moduleId: handoff.laneId,
          roleId: handoff.role,
          route,
          permission,
          workspace,
        })
        try {
          priorWorker = workerRegistry.get(workerKey)
        } catch {
          priorWorker = null
        }
        const features = {
          hasPriorWorker: Boolean(priorWorker),
          childBusy: priorWorker?.busy === true,
          sameModule: Boolean(priorWorker),
          constraintsMatch: priorWorker
            ? (priorWorker.baseline ?? null) === (handoff.workspace.revision ?? null)
            : undefined,
          routeMatch: priorWorker
            ? priorWorker.route?.provider === route.provider
              && (priorWorker.route?.model ?? null) === (route.model ?? null)
            : undefined,
          permissionMatch: priorWorker ? priorWorker.permission === permission : undefined,
          workspaceMatch: priorWorker ? priorWorker.workspace === workspace : undefined,
          factsStale: request.factsStale === true,
          failureUnclear: request.failureUnclear === true,
          independentReview: request.independentReview === true,
          contextOverLimit: request.contextOverLimit === true,
        }
        // A provider cannot compact another CLI's context; never claim a
        // compaction interface that does not exist (the rule then restarts).
        const capabilities = { compactAvailable: false }
        decisionFeatures = features
        decisionCapabilities = capabilities
        try {
          workerDecision = decideSessionAction({ features, capabilities })
          decisionEntry = decisionLog.record({
            parentId: attributionParentId,
            features,
            capabilities,
            decision: workerDecision,
          })
        } catch (error) {
          // Registry/log failure must not fabricate permission; run as a fresh
          // session so the run is still recorded and a future decision can be
          // made from real facts.
          workerDecision = null
          decisionEntry = null
          forceFresh = true
          sessionNote = `${error?.code ?? 'OMC/WORKER'}: ${String(error?.message ?? error)}; running without a retained worker`
        }
        if (workerDecision?.action === 'queue') {
          throw providerError('OMC/WORKER-BUSY',
            `worker ${workerKey} is busy with another task; two tasks never run on one session in parallel`)
        }
        // `new-packet`/`restart` mean a fresh context, not "do not record a
        // session": the run still stores its native session for later resume.
        if (workerDecision && workerDecision.action !== 'resume') forceFresh = true
      }
      if (sessionCfg.resumePolicy === 'require-resume' && (!capture || forceFresh)) {
        throw providerError('OMC/SESSION-REQUIRED', 'require-resume needs a trusted role handoff, an explicit workspace, an enabled registry and an allowed session adapter')
      }
      const key = capture
        ? sessionKeyFor({
            projectId: handoff.projectId,
            laneId: handoff.laneId,
            role: handoff.role,
            harness: def.id,
            model: hcfg.model || '',
            environment: plan.transport === 'wsl' ? `wsl:${plan.distro ?? ''}` : 'native',
            workspace,
            endpoint: endpointFingerprint(def, hcfg, env),
          })
        : null

      if (capture) {
        try {
          lease = await registry.acquire(key, {
            signal: request.signal,
            ...(forceFresh ? { fresh: true } : {}),
            requireResume: sessionCfg.resumePolicy === 'require-resume',
          })
          resumeId = forceFresh ? null : lease.record?.native?.sessionId ?? null
        } catch (error) {
          if (request.signal?.aborted) throw error
          if (sessionCfg.resumePolicy === 'require-resume') {
            lease = null
            throw error
          }
          // A busy or unwritable registry must not turn a read-only delegation
          // into a failure; it only loses the efficiency optimisation.
          sessionNote = `${error.code ?? 'OMC/SESSION'}: ${error.message}; running without session reuse`
          lease = null
        }
      }

      if (capture && sessionCfg.resumePolicy === 'require-resume' && lease && !resumeId) {
        lease.release()
        throw providerError(
          'OMC/SESSION-REQUIRED',
          `resumePolicy is require-resume but the lane "${handoff.laneId}" has no usable native session`,
        )
      }

      const collectBytes = capture
        ? Math.max(cfg.dispatch.maxOutputBytes, 256 * 1024)
        : cfg.dispatch.maxOutputBytes

      // ── 0.6 lifecycle: intent → launching → running → ended | unknown ──────
      // The task row and the attempt intent are written BEFORE the CLI is
      // spawned, so a crash between "we started something" and "we know what
      // happened" is visible as unknown instead of vanishing.
      const runId = mintRunId()
      // PR-07: a trial may require the usage ledger and the collector to read
      // the SAME task identity. The child run id stays the run id; only the
      // ledger attribution can be pinned by the caller.
      const ledgerTaskId = typeof request.ledgerTaskId === 'string' && request.ledgerTaskId.trim() !== ''
        ? request.ledgerTaskId.trim()
        : runId

      // Budget is checked BEFORE the side effect (CLI spawn).
      let reservation = null
      if (requestGate && typeof requestGate.reserve === 'function' && typeof attributionParentId === 'string' && attributionParentId !== '') {
        const modelRequestId = requestGate.nextRequestId({
          taskId: runId,
          sessionId: request.parent?.session?.id ?? 'provider',
          turn: 0,
          step: 0,
        })
        const verdict = requestGate.reserve({
          parentId: attributionParentId,
          taskId: runId,
          attemptId: `${runId}#dispatch`,
          modelRequestId,
          limits: resolveBudgetLimits(cfg),
          source: { kind: 'external-provider', harness: def.id },
        })
        if (!verdict.allowed) {
          throw providerError(verdict.code ?? 'OMC/BUDGET-EXHAUSTED', verdict.reason ?? 'budget exhausted before the provider was started')
        }
        reservation = { modelRequestId }
      }

      let taskRecord = null
      try {
        taskRecord = options.tasks?.start({
          id: runId, parentId: attributionParentId, harness: def.id,
          label: request.label, handoff,
          lineage: attribution,
          cancel: () => {
            const subagents = ctx.get?.('subagents')
            if (!subagents?.interrupt) throw providerError('OMC/CANCEL-UNAVAILABLE', 'the host subagent interruption service is unavailable; use the host interrupt_agent tool')
            return subagents.interrupt(runId, { kind: 'ancestor', agent: request.parent })
          },
        })
      } catch (error) {
        if (reservation) requestGate.settle({ parentId: attributionParentId, modelRequestId: reservation.modelRequestId, outcome: 'refused', note: 'task intent was refused' })
        lease?.release()
        throw error
      }

      let attempt = null
      if (executionStore && typeof executionStore.open === 'function') {
        try {
          attempt = executionStore.open({
            taskId: runId,
            parentId: attributionParentId,
            backend: 'external',
            route: { provider: `omc:${def.id}`, model: hcfg.model ?? null },
            reason: `provider ${def.id}`,
            intent: {
              backend: 'external',
              harness: def.id,
              cwd: request.cwd ?? null,
              mode: limits.mode,
              timeoutMs: limits.timeoutMs,
            },
          })
        } catch {
          attempt = null
        }
      }
      const settleAttempt = (execution, stopReason) => {
        if (!attempt?.currentAttemptId || !executionStore) return
        try {
          executionStore.settle(runId, attempt.currentAttemptId, { execution, stopReason, by: 'provider' })
        } catch { /* lifecycle must not turn a dispatch into a different failure */ }
      }
      const markRunning = () => {
        if (!attempt?.currentAttemptId || !executionStore) return
        try {
          executionStore.running(runId, attempt.currentAttemptId, { by: 'provider' })
        } catch { /* best effort */ }
      }
      const markUnknown = (reason) => {
        if (!attempt?.currentAttemptId || !executionStore) return
        try {
          executionStore.markUnknown(runId, attempt.currentAttemptId, { reason, by: 'provider' })
        } catch { /* best effort */ }
      }

      let launched
      try {
        if (attempt?.currentAttemptId && executionStore) {
          executionStore.launching(runId, attempt.currentAttemptId, {
            intent: { backend: 'external', harness: def.id, cwd: request.cwd ?? null },
            by: 'provider',
          })
        }
        const optionsForRun = {
          task,
          cwd: request.cwd,
          model: hcfg.model || undefined,
          // A role provider is a read-only surface. `dispatch.defaultMode` governs
          // the direct `coharness` tool only; letting a global default widen a
          // role would silently turn Oracle/Explorer/Council seats into writers.
          mode: limits.mode,
          sessionId: resumeId ?? undefined,
          json: capture,
          env,
          plan,
          // JSON event streams are much larger than the human answer. Collect
          // enough to find the final message; clip what the model sees below.
          timeoutMs: limits.timeoutMs,
          maxOutputBytes: collectBytes,
          signal: request.signal,
        }
        launched = resumeId
          ? await harnessAdapter.resume(ctx, optionsForRun)
          : await harnessAdapter.start(ctx, optionsForRun)
        markRunning()
        if (workersEnabled) {
          const route = { provider: `omc:${def.id}`, model: hcfg.model || null }
          actualWorkerAction = capture && resumeId
            ? 'resume'
            : priorWorker ? (workerDecision?.action === 'restart' ? 'restart' : 'new-packet') : 'new-packet'
          workerGeneration = priorWorker
            ? (actualWorkerAction === 'resume' ? priorWorker.generation : priorWorker.generation + 1)
            : 1
          try {
            workerRegistry.register({
              parentId: attributionParentId,
              workerKey,
              moduleId: handoff.laneId,
              roleId: handoff.role,
              route,
              permission: 'read-only',
              workspace,
              childId: runId,
              generation: workerGeneration,
              baseline: handoff.workspace.revision ?? null,
            })
            workerRegistry.setHealth(workerKey, { busy: true, childId: runId })
          } catch (error) {
            // A worker registry failure is reported, not turned into a run
            // failure; correctness of the dispatch does not depend on it.
            sessionNote = `${error?.code ?? 'OMC/WORKER'}: ${String(error?.message ?? error)}`
          }
        }
      } catch (error) {
        // Launching was recorded before the call, so a throw is unknown: the
        // CLI may have started. Never report it as completed or failed, and
        // never auto-replay it.
        markUnknown(`provider start failed after launching: ${String(error?.code ?? error?.message ?? error)}`)
        settleAttempt('unknown', error?.code ?? 'provider start failed')
        if (workersEnabled && decisionEntry) {
          try {
            decisionLog.recordOutcome(attributionParentId, decisionEntry.id, {
              action: 'new-packet',
              workerKey: null,
              childId: null,
              status: 'unknown',
              note: 'launch failed before a worker child existed',
            })
          } catch { /* best effort */ }
        }
        if (taskRecord) {
          options.tasks.settle(runId, {
            output: [{ type: 'text', text: `OMC/RUN-UNKNOWN: ${error?.message ?? error}` }],
            stopReason: 'unknown',
          })
        }
        if (reservation) {
          requestGate.settle({ parentId: attributionParentId, modelRequestId: reservation.modelRequestId, outcome: 'unknown', note: 'provider start threw after launching' })
        }
        if (lease) {
          try {
            registry.fail(lease, { code: error?.code, message: error?.message, taskId: handoff?.taskId })
          } catch {
            // The original launch error is the useful one.
          }
          lease.release()
        }
        throw error
      }

      const result = (async () => {
        try {
          const outcome = await launched.handle.done
          const captured = harnessAdapter.collect(launched.handle, collectBytes)
          const transportStatus = harnessAdapter.status(outcome, launched.deadline, request.signal)
          const parsed = capture ? harnessAdapter.parse(captured.stdout) : null
          const classification = classifyCliResult({
            status: transportStatus,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            captured,
            parsed,
            expectJson: Boolean(capture),
            resumeId,
            requireContent: true,
          })
          const status = classification.status
          const ok = status === 'completed'
          const answer = clip(parsed?.text ?? captured.stdout ?? '', cfg.dispatch.maxOutputBytes).text
          const meta = [`omc:${def.id}`]

          if (capture) {
            if (resumeId) meta.push(`session resumed ${maskSessionId(resumeId)} (turn ${(lease?.record?.turns ?? 0) + 1})`)
            else meta.push('session new')
          } else if (sessionAdapter) {
            meta.push('session reuse off')
          }
          if (handoff?.taskId) meta.push(`task ${handoff.taskId}`)
          if (attribution.trusted) meta.push(`lineage host (root ${attribution.rootTaskId ?? '?'} · depth ${attribution.depth ?? '?'})`)
          else if (attribution.source !== 'host') meta.push(`lineage ${attribution.source}: not attributed to a proven root`)
          if (classification.idChanged) {
            meta.push('session id changed: the CLI started a different native conversation')
          }
          if (classification.code) meta.push(`${classification.code}: ${classification.message}`)
          const usage = sessionCfg.captureUsage !== false ? parsed?.usage : null
          if (usage) meta.push(`usage ${usageText(usage)}`)
          const booking = bookExternalUsage({
            runId,
            taskId: ledgerTaskId,
            parentId: attributionParentId,
            model: hcfg.model ?? null,
            usage,
            sessionId: parsed?.sessionId ?? null,
          })
          if (booking) meta.push(booking.stored ? 'attempt booked into the usage ledger' : 'attempt was already booked')
          if (sessionNote) meta.push(sessionNote)

          if (lease) {
            try {
              if (ok) {
                if (parsed?.sessionId) {
                  registry.complete(lease, {
                    sessionId: parsed.sessionId,
                    format: sessionAdapter.format,
                    usage,
                    taskId: handoff.taskId,
                    sessionOutcome: resumeId ? 'resumed' : 'new',
                  })
                } else if (resumeId) {
                  registry.unconfirmed(lease, {
                    reason: 'the resumed CLI did not echo its native session id',
                    taskId: handoff.taskId,
                  })
                  meta.push('resume unconfirmed: the CLI did not echo its session id')
                } else {
                  registry.complete(lease, { sessionId: null, usage, taskId: handoff.taskId })
                }
              } else {
                registry.fail(lease, {
                  code: `OMC/RUN-${status.toUpperCase()}`,
                  message: captured.stderr || captured.stdout,
                  taskId: handoff.taskId,
                })
              }
            } catch (error) {
              meta.push(`${error.code ?? 'OMC/SESSION-STORE'}: ${error.message}`)
            }
          }

          const executionState = ok ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed'
          workerOutcome = executionState
          settleAttempt(executionState, status)
          if (reservation) {
            requestGate.settle({
              parentId: attributionParentId,
              modelRequestId: reservation.modelRequestId,
              outcome: booking ? 'booked' : 'unknown',
              sourceEventId: `run:${runId}`,
            })
          }

          const value = {
            output: [
              {
                type: 'text',
                text: ok
                  ? answer || '(completed with no output)'
                  : failureText(def, status, outcome, captured, parsed?.text),
              },
            ],
            stopReason: ok ? 'completed' : status === 'cancelled' ? 'aborted' : 'error',
            diagnostic: meta.join(' · '),
            ...(workerDecision ? {
              sessionDecision: {
                ...workerDecision,
                rulesVersion: STRATEGY_RULES_VERSION,
                features: decisionFeatures,
                capabilities: decisionCapabilities,
                actualAction: actualWorkerAction,
                workerKey,
                generation: workerGeneration,
                childId: runId,
              },
              worker: { workerKey, generation: workerGeneration, childId: runId },
            } : {}),
          }
          if (taskRecord) options.tasks.settle(runId, value)
          return value
        } catch (error) {
          if (lease) {
            try { registry.fail(lease, { code: error?.code, taskId: handoff?.taskId }) } catch { /* preserve original failure */ }
          }
          // The process may have run and then the result pipeline died: this is
          // unknown, never "failed on purpose", and it is never auto-replayed.
          workerOutcome = 'unknown'
          markUnknown(`provider result failed: ${String(error?.message ?? error)}`)
          if (reservation) {
            requestGate.settle({
              parentId: attributionParentId,
              modelRequestId: reservation.modelRequestId,
              outcome: 'unknown',
              note: 'result pipeline failed after launch',
            })
          }
          // A dispatch that threw still consumed a slot somewhere: book it as
          // `unknown` rather than pretending nothing was spent.
          bookExternalUsage({ runId, taskId: ledgerTaskId, parentId: attributionParentId, model: hcfg?.model ?? null, usage: null, sessionId: null })
          if (taskRecord) options.tasks.settle(runId, {
            output: [{ type: 'text', text: `OMC/RUN-UNKNOWN: ${error?.message ?? error}` }], stopReason: 'unknown',
          })
          throw error
        } finally {
          lease?.release()
          launched.deadline.dispose()
          if (workersEnabled) {
            if (workerKey) {
              try { workerRegistry.setHealth(workerKey, { busy: false, childId: runId }) } catch { /* best effort */ }
            }
            if (decisionEntry) {
              try {
                decisionLog.recordOutcome(attributionParentId, decisionEntry.id, {
                  action: actualWorkerAction ?? 'new-packet',
                  workerKey,
                  generation: workerGeneration,
                  childId: runId,
                  status: workerOutcome,
                })
              } catch { /* best effort */ }
            }
          }
        }
      })()

      return {
        id: runId,
        result,
        dispose: async () => {
          await harnessAdapter.cancel(launched.handle)
        },
      }
    },
  }
}
