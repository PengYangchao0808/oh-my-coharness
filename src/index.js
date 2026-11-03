/**
 * Oh My CoHarness — Host entry.
 *
 * Surfaces, in order of importance (PLAN §3.1):
 *   provider  omc:<id>   → external CLI as a real DSH child session
 *   tool      coharness  → one tool, stable actions/schema
 *   command   /coharness → free, model-free diagnostics
 *   skills    coharness* → routing discipline the model can load on demand
 *
 * No client half, no dependencies, no build step.
 */

import { resolveConfig, isEnabled } from './config.js'
import { HARNESSES } from './harnesses.js'
import { makeProvider } from './provider.js'
import { dispatchTasks } from './dispatch.js'
import { detect, renderReport } from './doctor.js'
import { registerSkills } from './skills.js'
import { applyMigrationCommand } from './migrate.js'
import { buildExecutionStatus, detectLegacyCompanion, PRESET_ID, readRoleConfiguration, renderExecutionStatus } from '../integration/status.js'
import { createSessionRegistry } from '../integration/sessions.js'
import { createTaskRegistry } from '../integration/tasks.js'
import { statePath } from '../integration/state.js'
import { join } from 'node:path'
import { createGraphStore, mergeAcceptance } from '../integration/graph.js'
import { createMailbox } from '../integration/mailbox.js'
import { readProjectPolicy, renderProjectPolicy } from '../integration/project-policy.js'
import { createWorktreeStore, mergeWorktree } from '../integration/worktree.js'
import { buildRolePrompt, createCustomRoles, readProjectRoles } from '../integration/custom-roles.js'
import { externalRoleResult, renderRoleResult } from '../integration/role-result.js'
import { createPresetSnapshotStore, diffPresetSnapshot } from '../integration/preset-snapshot.js'
import { createUsageLedger } from '../integration/usage-ledger.js'
import { createExecutionStore } from '../integration/execution-events.js'
import { createArtifactStore } from '../integration/artifact-store.js'
import { createContextView } from '../integration/context-view.js'
import { createRetrievalCache } from '../integration/retrieval-cache.js'
import { createBudgetTracker } from '../integration/budget.js'
import { createProgressTracker } from '../integration/progress.js'
import { createManagedExecution } from '../integration/managed-execution.js'
import { createNativeRuntime } from '../integration/native-runtime.js'
import { createRequestGate } from '../integration/request-gate.js'
import { createNativeManaged } from '../integration/native-managed.js'
import { createWorkerRegistry } from '../integration/worker-registry.js'
import { createDecisionLog, decideSessionAction } from '../integration/session-strategy.js'
import { roleIdFromLabel } from '../vendor/omd/npm-package/preset/roles.js'
import { harnessReadOnlyClass } from '../integration/execution.js'
import { renderFleetPlan } from '../integration/fleet.js'
import { applyNativeFleet, buildNativeFleet, runNativeDemo } from './fleet.js'

export const inject = ['tools', 'subprocess']

const DESCRIPTION = [
  'Hand a task to an AI coding CLI that is installed on this machine (Codex, Claude Code, Gemini CLI, Kimi, opencode …)',
  'and get its real result back. Use it when the user names a specific CLI, asks for a second opinion from another agent,',
  'or when another toolchain/model should do the work.',
  '',
  "Actions: `list` shows what is installed (free, no model calls); `status` shows role → execution backend and which",
  '`omc:<id>` providers are registered (free); `doctor` returns a copyable diagnostic report (free); `sessions` lists the',
  'native CLI session references OMC may reuse (free; pass `clear: true` to forget them, which never deletes CLI history);',
  '`migrate` previews the pre-0.4 configuration migration (pass `apply: true` to write it); `fleet` pins native roles',
  'to distinct models from the live DSH catalog (preview by default, `apply: true` writes it); `demo` plans that fleet,',
  'seeds a deterministic workspace and returns the prompt for a real multi-model OMC run; `dispatch` runs real work and',
  'costs that CLI’s own quota. and clear removes both. Receipts are process-local and bounded.', 'preset = freeze this session’s startup baseline, compare the live config to it and record labeled manual snapshots (never a hot switch); status also shows each role’s observed request route next to its configured route. `tasks` lists this parent session’s retained external provider runs; `result` rereads a task_id without waking a model; `cancel` requests its interruption. Direct runs have no retained child receipt. Receipts are process-local and bounded.',
  '',
  'The specialist roles (`subagent_oracle`, `subagent_explorer`, council seats) may be configured to run on one of these',
  'providers. That provider surface is fixed read-only; `dispatch` with `mode: "in-place"` uses the direct surface.',
  'For an independent review, dispatch two read-only tasks to two different harnesses in one call; for multi-stage work',
  'load the `coharness-ulw` skill.',
  'Rules the tool enforces: dispatch defaults to read-only; an over-limit batch is refused instead of dropping tasks;',
  "and `delivery:'background'` returns a child id immediately — that is NOT completion, wait for the completion notice.",
  'Use the ordinary `subagent` tool for in-process DSH children; this one is for external harnesses.',
].join(' ')

function text(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

function compactRows(rows) {
  const lines = [`${'harness'.padEnd(12)}${'transport'.padEnd(10)}${'auth'.padEnd(12)}version`]
  for (const row of rows) {
    lines.push(`${row.id.padEnd(12)}${String(row.transport ?? '-').padEnd(10)}${String(row.auth).padEnd(12)}${row.version ?? '-'}`)
  }
  return lines.join('\n')
}

function renderDispatch(payload) {
  const lines = []
  for (const [index, result] of payload.results.entries()) {
    const surface = result.surface === 'provider' ? 'provider' : result.surface === 'direct' ? 'direct' : '-'
    const child = result.childId ? ` · child ${result.childId}` : ''
    const session = result.sessionOutcome ? ` · session ${result.sessionOutcome}` : ''
    lines.push(
      `#${index + 1} ${result.harnessId} · ${result.status} · ${((result.elapsedMs ?? 0) / 1000).toFixed(1)}s · surface: ${surface}${child}${session}`,
    )
    if (result.downgradeReason) lines.push(`   degraded: ${result.downgradeReason}`)
    // Never let a degraded surface go unexplained: silence reads as full support.
    else if (result.surface === 'direct') lines.push('   degraded: direct surface (no reason reported)')
    if (result.diagnostics?.length) lines.push(`   note: ${result.diagnostics.join(' · ')}`)
    if (result.truncated) lines.push('   note: output clipped; full stream in the spill file')
    if (result.output) lines.push(result.output)
    lines.push('')
  }
  lines.push(
    'note: `mode` maps onto the CLIs that expose a sandbox flag (codex `-s`, gemini `--approval-mode`, antigravity `--sandbox`); the others keep their own default permission model.',
  )
  lines.push('note: `omc:<id>` providers used by roles are fixed read-only; a write mode takes the `direct` surface.')
  lines.push('note: `surface: direct` has no childId, no host capacity slot and no sub-session; only `provider` gets those.')
  if (payload.project) {
    lines.push(`project policy: ${payload.project.path}`)
    for (const warning of payload.project.warnings ?? []) lines.push(`  note: ${warning}`)
  }
  if (payload.delivery === 'background') {
    lines.push('Background runs report through the completion notice. Do not claim them as finished before it arrives.')
  }
  return lines.join('\n').trim()
}

/** Session references are metadata, never a conversation or a credential. */
function renderSessions(registry, { lane } = {}) {
  const stats = registry.stats()
  const lines = [
    `session registry: ${stats.entries} entries · ${stats.lanes ?? 0} lane(s) · ${stats.resumable} resumable · ` +
    `reuse ${stats.enabled ? 'on' : 'off'} · policy ${stats.resumePolicy}`,
  ]
  if (stats.usage) {
    const usage = stats.usage
    lines.push(
      `  usage: in ${usage.inputTokens} · out ${usage.outputTokens}` +
      (usage.costKnown ? ` · cost $${usage.costUsd.toFixed(4)}` : ' · cost unknown'),
    )
  }
  if (stats.outcomes) {
    lines.push(
      `  session outcomes: new ${stats.outcomes.new} · resumed ${stats.outcomes.resumed} · ` +
      `unconfirmed ${stats.outcomes.unconfirmed} · unknown ${stats.outcomes.unknown}`,
    )
  }
  if (stats.loadError) lines.push(`  unreadable registry: ${stats.loadError}`)
  const rows = registry.list({ limit: 20, lane })
  if (!rows.length) {
    lines.push('  no native session references stored')
  } else {
    lines.push('  lane / role / harness / state / turns / last used / session')
    for (const row of rows) {
      lines.push(
        `  ${String(row.laneId).padEnd(28)}${String(row.role).padEnd(18)}${String(row.harness).padEnd(12)}` +
        `${String(row.state).padEnd(13)}${String(row.turns ?? 0).padEnd(6)}${String(row.lastUsedAt ?? '-').padEnd(22)}${row.sessionId || '-'}`,
      )
    }
  }
  lines.push('note: clearing references never deletes the CLI provider\'s own history.')
  return lines.join('\n')
}

/**
 * Role execution + provider state.
 *
 * The connection table is only as good as the doctor report behind it, so:
 * reuse the cached report when there is one, otherwise take a single non-forced
 * `detect()` pass (it caches, so doctor and later status calls are free, and it
 * re-probes only a cached report whose probe failed), and if that is unavailable
 * every row honestly degrades to `auth: unknown`.
 */
async function statusReport(rt) {
  const cached = rt.peekReport?.()
  if (cached) return cached
  try {
    return (await rt.detect?.()) ?? null
  } catch {
    return null
  }
}

async function executionStatusText(rt) {
  const [status, legacy] = await Promise.all([
    statusReport(rt).then((report) =>
      buildExecutionStatus(rt.ctx, rt.cfg, { registry: rt.sessions, report }),
    ),
    detectLegacyCompanion(rt.ctx),
  ])
  return [...renderExecutionStatus(status, { legacy }), ...runtimeFootnotes(rt)].join('\n')
}

/**
 * The runtime facts a status reader needs and a route table cannot show (R05):
 * how much was really booked, in which buckets, how much is unknown, whether
 * the budget gate is enforcing, and where the bridge stands. Everything here is
 * read from durable records — no model call, no guessed number.
 */
function runtimeFootnotes(rt) {
  const lines = []
  try {
    const diagnostics = rt.native?.diagnostics?.()
    if (diagnostics) {
      lines.push(
        `native bridge: ${diagnostics.installed ? 'installed' : 'NOT installed'} · ` +
        `${diagnostics.bindings} binding(s) · booked ${diagnostics.stats?.booked ?? 0} · ` +
        `unbound sessions ${diagnostics.stats?.unboundSessions ?? 0}` +
        (diagnostics.stats?.unboundUsage ? ` · ${diagnostics.stats.unboundUsage} UNBOUND USAGE event(s)` : ''),
      )
    }
    const limits = budgetLimits(rt.cfg)
    lines.push(
      `budget gate: ${limits.enforce ? 'enforcing' : 'advisory'} · ` +
      `maxCalls ${limits.maxCalls ?? '—'} · perTaskCalls ${limits.perTaskCalls ?? '—'} · maxUsd ${limits.maxUsd ?? '—'}`,
    )
    if (typeof rt.statusParentId === 'string' && rt.requestGate && rt.nativeManaged) {
      const view = rt.requestGate.budgetView({ parentId: rt.statusParentId, limits })
      lines.push(`budget now: ${rt.requestGate.describe(view)}`)
      const coverage = rt.nativeManaged.coverage(rt.statusParentId)
      lines.push(
        `managed coverage: ${coverage.boundNative} bound native child(ren) of ${coverage.nodes} node(s); ` +
        'unbound native work stays unmanaged',
      )
    }
  } catch (error) {
    lines.push(`runtime footnotes unavailable: ${String(error?.message ?? error)}`)
  }
  return lines.length ? ['', '— runtime —', ...lines] : []
}

/**
 * @param {{ ctx: any, cfg: any, registered: Set<string>, detect(force?: boolean): Promise<any> }} rt
 */
/**
 * Bind the calling session as an OMC parent (R01).
 *
 * Idempotent by construction: every tool call re-affirms the same root binding.
 * A session already bound to another parent is left alone — the bridge refuses
 * to re-attribute work that may already have been booked.
 */
/**
 * Resolve the effective budget limits from the configuration (R02).
 *
 * `enforce` is `'auto'` by default: a configured cap that never blocks would be
 * a lie, so a cap turns enforcement on. `observe` keeps counting through the
 * ledger either way; `off` and an explicit `enforce: false` stay advisory.
 */
function budgetLimits(cfg) {
  const budget = cfg?.efficiency?.budget ?? {}
  const maxCalls = Number.isSafeInteger(budget.maxCalls) && budget.maxCalls > 0 ? budget.maxCalls : null
  const perTaskCalls = Number.isSafeInteger(budget.perTaskCalls) && budget.perTaskCalls > 0 ? budget.perTaskCalls : null
  const maxUsd = typeof budget.maxUsd === 'number' && budget.maxUsd >= 0 ? budget.maxUsd : null
  const capsConfigured = maxCalls !== null || perTaskCalls !== null || maxUsd !== null
  const mode = cfg?.efficiency?.mode ?? 'observe'
  const declared = budget.enforce
  const enforce = declared === true ? true
    : declared === false ? false
      : mode !== 'off' && capsConfigured
  return { maxCalls, perTaskCalls, maxUsd, enforce }
}

/**
 * Install the per-request budget gate (R02).
 *
 * Two host facts shape this wiring (both verified by the WP00 probe):
 *   - `agent/request` runs inside prepareRequest before `llm.stream` on EVERY
 *     attempt, including a retry — so this is the one place that can both count
 *     a real send and stop it. Throwing here aborts the turn before any adapter
 *     dispatch, which is exactly "block the next real request".
 *   - `agent/pre-step` can reject a step before any send. It is used as the
 *     cheap early exit: it never throws, it just declines to enter the step.
 *
 * Settlement comes from the durable session events: one `assistant/message`
 * (success) or `assistant/attempt` (failed/aborted) closes exactly one send.
 * A turn that ends with reservations still open settles them as `unknown` —
 * they keep their slot instead of being refunded on a guess.
 */
function installBudgetGate(ctx, rt) {
  if (typeof ctx?.on !== 'function') return { installed: false, reason: 'this host exposes no event surface' }
  const limits = () => budgetLimits(rt.cfg)
  const name = 'omc: budget gate'
  /** @type {Map<string, string[]>} sessionId → modelRequestIds awaiting a terminal event */
  const inflight = new Map()
  const stats = { admitted: 0, refused: 0, settledBooked: 0, settledUnknown: 0, duplicates: 0 }

  const attach = (event, handler, label) => {
    const register = () => ctx.on(event, handler, { global: true })
    const disposer = typeof ctx.effect === 'function' ? ctx.effect(register, `${name} ${event}`) : register()
    return disposer
  }

  const bindingFor = (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId !== 'string') return null
    const binding = rt.native?.bindingFor?.(sessionId)
    return binding ? { sessionId, binding } : null
  }

  const reserveFor = (payload) => {
    const found = bindingFor(payload)
    if (!found) return null
    const { sessionId, binding } = found
    const modelRequestId = rt.requestGate.nextRequestId({
      taskId: binding.taskId,
      sessionId,
      turn: payload.turn ?? 0,
      step: payload.step ?? 0,
    })
    const verdict = rt.requestGate.reserve({
      parentId: binding.parentId,
      taskId: binding.taskId,
      attemptId: binding.taskId,
      modelRequestId,
      limits: limits(),
      source: { kind: 'native', sessionId, turn: payload.turn ?? 0, step: payload.step ?? 0 },
    })
    if (verdict.allowed) {
      stats.admitted += 1
      if (verdict.duplicate) stats.duplicates += 1
      const list = inflight.get(sessionId) ?? []
      list.push(modelRequestId)
      inflight.set(sessionId, list)
    }
    return { sessionId, binding, verdict }
  }

  attach('agent/pre-step', async (payload, next) => {
    if (!limits().enforce) return next()
    const found = bindingFor(payload)
    if (!found) return next()
    const view = rt.requestGate.budgetView({
      parentId: found.binding.parentId,
      taskId: found.binding.taskId,
      limits: limits(),
    })
    if (!view.exhausted) return next()
    stats.refused += 1
    return { kind: 'reject', reason: `OMC/BUDGET-EXHAUSTED: ${rt.requestGate.describe(view)}` }
  }, `${name} pre-step`)

  attach('agent/request', async (payload, next) => {
    if (!limits().enforce) return next()
    let reserved
    try {
      reserved = reserveFor(payload)
    } catch (error) {
      // A gate that cannot read its own state must not silently allow a send,
      // but it also must not take the whole session down: report and block.
      rt.ctx?.logger?.warn?.(`oh-my-coharness: budget gate error: ${String(error?.message ?? error)}`)
      const failure = new Error(`OMC/BUDGET-GATE-UNAVAILABLE: ${String(error?.message ?? error)}`)
      failure.code = 'OMC/BUDGET-GATE-UNAVAILABLE'
      throw failure
    }
    if (!reserved) return next()
    if (reserved.verdict.allowed) return next()
    stats.refused += 1
    const failure = new Error(`${reserved.verdict.code}: ${reserved.verdict.reason}`)
    failure.code = reserved.verdict.code
    throw failure
  }, `${name} request`)

  attach('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const list = inflight.get(sessionId)
    if (!list?.length) return
    const binding = rt.native?.bindingFor?.(sessionId)
    if (!binding) return
    const close = (modelRequestId, outcome, sourceEventId) => {
      try {
        const result = rt.requestGate.settle({ parentId: binding.parentId, modelRequestId, outcome, sourceEventId })
        if (result?.settled && outcome === 'booked') stats.settledBooked += 1
        if (result?.settled && outcome === 'unknown') stats.settledUnknown += 1
      } catch (error) {
        rt.ctx?.logger?.warn?.(`oh-my-coharness: budget settlement failed: ${String(error?.message ?? error)}`)
      }
    }
    if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') {
      const id = list.shift()
      if (id) close(id, event.type === 'assistant/message' ? 'booked' : 'unknown', `seq:${event.seq}`)
      return
    }
    if (event?.type === 'turn/end') {
      // Anything still open at the end of a turn never produced a terminal
      // event: it may have been sent, so it keeps its slot.
      for (const id of list.splice(0)) close(id, 'unknown', `turn-end:${event.seq}`)
    }
  }, `${name} session/event`)

  return {
    installed: true,
    labels: [`${name} pre-step`, `${name} request`, `${name} session/event`],
    stats: () => ({ ...stats, open: [...inflight.values()].reduce((total, list) => total + list.length, 0) }),
  }
}

function bindCallingSession(rt, exec) {
  const agent = exec?.agent
  const sessionId = agent?.session?.id
  const parentId = agent?.id
  if (!rt?.native || typeof sessionId !== 'string' || typeof parentId !== 'string') return null
  try {
    return rt.native.bindRoot({ sessionId, parentId })
  } catch (error) {
    try {
      rt.ctx?.logger?.warn?.(`oh-my-coharness: native binding skipped: ${String(error?.message ?? error)}`)
    } catch {
      // torn-down logger
    }
    return null
  }
}

function coharnessTool(rt) {
  return {
    name: 'coharness',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['dispatch', 'list', 'status', 'doctor', 'migrate', 'sessions', 'tasks', 'result', 'cancel', 'fleet', 'demo', 'graph', 'send', 'inbox', 'ack', 'thread', 'reuse', 'worktree', 'project', 'role', 'preset', 'usage', 'native', 'session'],
          description: 'dispatch = run work; list = who is available (free); status = role execution backends, provider state, native model routes and session reuse (free); usage = native event-bridge diagnostics plus this session’s derived token/cost rollup (free, no model call); doctor = full diagnostic report (free); sessions = OMC native-session references (free; clear:true forgets them); migrate = preview the pre-0.4 configuration migration (pass apply:true to write); fleet = plan native role routes from the live DSH model catalog (free; apply:true writes); demo = plan+apply the fleet, seed a demo workspace and return the run prompt (free; no model call); graph = plan/claim/complete a parent work graph (dependencies, acceptance, write-scope); send/inbox/ack/thread = durable parent mailbox; reuse = inspect a durable task for continued work; worktree = create/enter a retained DSH worktree or merge its recorded branch back with a clean-tree preflight (session-wide, not per child); project = show the restrictive .omc/project.json policy that a dispatch in cwd would apply; role = list/add/remove/run a named external read-only role template (enforced read-only harness only); preset = snapshot this session’s effective OMC role config and compare the live config to it (never claims a hot switch); native = bind an existing native child session to a graph node and settle it from its durable execution record; session = record the explainable resume/queue/compact/restart/new-packet decision and list the workers it owns.',
        },
        harness: {
          type: 'string',
          description: "Harness id such as 'codex', 'claude', 'gemini', 'kimi', or 'auto' to pick the first usable one.",
        },
        model: {
          type: 'string',
          description: 'Per-call CLI model override for dispatch (harnesses.<id>.model is the default).',
        },
        prompt: {
          type: 'string',
          description: 'Self-contained task for the external CLI. It cannot see this conversation, so include every needed fact.',
        },
        tasks: {
          type: 'array',
          description: 'Several independent tasks to run concurrently. Prefer this over separate calls when the work is parallel.',
          items: {
            type: 'object',
            properties: {
              harness: { type: 'string' },
              model: { type: 'string' },
              prompt: { type: 'string' },
              fallbacks: { type: 'array', items: { type: 'string' } },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
        fallbacks: {
          type: 'array',
          items: { type: 'string' },
          description: 'For dispatch: harness ids to try, in order, only when the previous attempt fails with a retryable CLI error. Explicit fallback keeps billing/authority visible; no automatic route change.',
        },
        cwd: { type: 'string', description: 'Working directory for a dispatch run. Defaults to the session directory.' },
        demo_dir: { type: 'string', description: 'For demo: exact empty directory to seed. Defaults to $DSH_HOME/omc-demo/run-<timestamp>.' },
        mode: {
          type: 'string',
          enum: ['read-only', 'in-place', 'worktree'],
          description: 'read-only (default) forbids edits; in-place lets the CLI write in this workspace (direct surface only); worktree creates a disposable branch checkout, runs the CLI there, and returns its diff/path without merging.',
        },
        delivery: {
          type: 'string',
          enum: ['await', 'background'],
          description: 'await returns the result in this call; background returns a child id and reports later.',
        },
        timeoutMs: { type: 'number', description: 'Deadline for this run in milliseconds.' },
        apply: { type: 'boolean', description: 'For action migrate: write the migrated configuration. Omit/false = preview only.' },
        force: { type: 'boolean', description: 'For action migrate: overwrite conflicting current values (a backup is always written first).' },
        rollback: { type: 'boolean', description: 'For action migrate: restore the latest migration backup.' },
        clear: { type: 'boolean', description: 'For action sessions: forget every OMC session reference. CLI-native histories are not deleted.' },
        clear_lane: { type: 'boolean', description: 'For action sessions: forget references for one lane (requires lane).' },
        task_id: { type: 'string', description: 'For result/cancel: exact external child id returned by a role tool or dispatch. Only this session’s runs are accessible.' },
        models: {
          type: 'object',
          description: 'For fleet/demo: explicit role → {provider, model} overrides. Omitted roles are chosen from the live DSH catalog. Roles: oracle, explorer, fixer, designer, librarian.',
          additionalProperties: {
            type: 'object',
            properties: { provider: { type: 'string' }, model: { type: 'string' } },
            required: ['model'],
            additionalProperties: false,
          },
        },
        refresh: { type: 'boolean', description: 'For fleet/demo: re-read the live DSH model catalog instead of using the 15s cache.' },
        graph_action: {
          type: 'string',
          enum: ['plan', 'status', 'claim', 'complete', 'fail', 'cancel', 'audit'],
          description: 'For graph: plan nodes, inspect status, claim a ready node, settle it, cancel it, or audit changed files against its write scope.',
        },
        nodes: {
          type: 'array',
          description: 'For graph plan: [{id, role, title, deps, write, writeScope, acceptance}].',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              role: { type: 'string' },
              title: { type: 'string' },
              deps: { type: 'array', items: { type: 'string' } },
              write: { type: 'boolean' },
              writeScope: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'array', items: { type: 'string' } },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        node_id: { type: 'string', description: 'For graph claim/complete/fail/cancel/audit: node id. On dispatch: binds the run to the managed path (claim → attempt → events → acceptance → settle; failure releases the claim).' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'For graph complete: acceptance evidence; required when the node declares acceptance.' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'For graph complete/audit on a write node: workspace-relative changed paths.' },
        native_action: { type: 'string', enum: ['bind', 'settle', 'coverage'], description: 'For native: bind = attach an existing native child session to a graph node (claim + single-writer scope); settle = apply the durable execution verdict, completing the node only with acceptance evidence; coverage = managed vs unmanaged counts.' },
        child_session_id: { type: 'string', description: 'For native bind: the native child session id that the host reported (the session id, not the role tool name).' },
        attempt_id: { type: 'string', description: 'For native settle: the exact execution attempt this evidence belongs to; a stale attempt is refused instead of settling the current one.' },
        session_action: { type: 'string', enum: ['decide', 'log', 'workers'], description: 'For session: decide = run the explainable resume/queue/compact/restart/new-packet rule table and record it; log = this session’s recorded decisions; workers = the logical workers (and their physical children/generations) this session owns.' },
        features: { type: 'object', description: 'For session decide: the observable facts (sameModule, independentReview, constraintsMatch, routeMatch, permissionMatch, workspaceMatch, factsStale, failureUnclear, childBusy, contextOverLimit, hasPriorWorker).', additionalProperties: true },
        capabilities: { type: 'object', description: 'For session decide: what the host supports today, e.g. {"compactAvailable": false}. A missing capability never justifies claiming it.', additionalProperties: true },
        to: { type: 'string', description: 'For send: target agent id, external task id, or * for a broadcast.' },
        text: { type: 'string', description: 'For send: durable message text.' },
        kind: { type: 'string', enum: ['note', 'task', 'result', 'question'], description: 'For send: message kind (default note).' },
        message_id: { type: 'string', description: 'For ack: one message id.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'For ack: message ids.' },
        agent_id: { type: 'string', description: 'For inbox/ack: agent id; defaults to the calling agent.' },
        unread_only: { type: 'boolean', description: 'For inbox: only unread messages (default true).' },
        lane: { type: 'string', description: 'For thread: filter by lane.' },
        execute: { type: 'boolean', description: 'For reuse: re-execute the retained task now (re-validates policy and harness, opens a NEW attempt; previous acceptance evidence is not inherited).' },
        name: { type: 'string', description: 'For worktree: branch/checkout name. Defaults to a generated worktree-<uuid>.' },
        merge: { type: 'boolean', description: 'For worktree: merge the recorded branch back into its source checkout (clean-tree preflight, --no-ff, abort on conflict).' },
        branch: { type: 'string', description: 'For worktree merge: explicit retained branch; defaults to the latest recorded worktree branch.' },
        require_acceptance: { type: 'boolean', description: 'For worktree merge: require the named graph node to be completed with its acceptance evidence before merging.' },
        role_action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'run'],
          description: 'For role: list templates, add one, remove one, or run one through the read-only dispatch path.',
        },
        role_id: { type: 'string', description: 'For role: custom role id.' },
        title: { type: 'string', description: 'For role add: display title.' },
        persona: { type: 'string', description: 'For role add: self-contained persona/instructions.' },
        role_harness: { type: 'string', description: 'For role add: external harness id; role runs only when that harness has enforced read-only.' },
        role_model: { type: 'string', description: 'For role add: optional CLI model override for this role.' },
        role_fallbacks: { type: 'array', items: { type: 'string' }, description: 'For role add: optional enforced read-only harness fallbacks.' },
        preset_action: {
          type: 'string',
          enum: ['snapshot', 'status', 'clear'],
          description: 'For preset: status freezes an immutable startup baseline at this session’s first OMC observation and diffs the live config against it; snapshot records a labeled manual snapshot beside it (never replacing the baseline); clear removes both. DSH still owns session preset switching.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return text(value?.text)
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      // A Loader may have loaded this plugin before the subagents service existed.
      // Retrying here is what turns the provider surface on without a restart.
      rt.ensureProviders?.()
      // R01: the calling session is an OMC parent. Re-affirming it here is what
      // lets the event bridge attribute the children this session delegates.
      bindCallingSession(rt, exec)
      const action = String(args?.action ?? '')

      if (action === 'project') {
        const result = readProjectPolicy(args.cwd)
        return { text: renderProjectPolicy(result) }
      }

      if (action === 'preset') {
        const parentId = exec?.agent?.id
        if (!parentId) return { text: 'OMC/PRESET-PARENT-REQUIRED: preset actions need a calling agent' }
        const subaction = String(args.preset_action ?? 'status')
        try {
          if (subaction === 'clear') {
            rt.presetSnapshots.clear(parentId)
            return { text: 'preset snapshots cleared for this session (startup baseline and manual)' }
          }
          const loaded = await readRoleConfiguration(rt.ctx)
          if (!loaded.ok) return { text: 'preset failed: ' + loaded.error }
          const current = {
            source: loaded.config.source,
            preset: loaded.config.preset,
            orchestrator: loaded.config.orchestrator,
            roles: loaded.config.roles,
          }
          // Freeze the startup baseline at the first OMC observation of this
          // session and never let a later call replace it: manual snapshots are
          // labeled and stored beside it, not over it.
          const startup = rt.presetSnapshots.ensureStartup(parentId, { ...current, source: current.source })
          if (subaction === 'snapshot') {
            const saved = rt.presetSnapshots.write(parentId, current)
            return {
              text: JSON.stringify({
                manual: saved,
                startup: { kind: startup.value.kind, at: startup.value.at, created: startup.created },
                hotSwitch: false,
                note: 'manual snapshots are labeled manual and never replace the immutable startup baseline',
              }, null, 2),
            }
          }
          if (subaction === 'status') {
            const stored = rt.presetSnapshots.read(parentId)
            const snapshot = stored?.startup ?? null
            const diff = snapshot ? diffPresetSnapshot(snapshot, current) : null
            return {
              text: JSON.stringify({
                startup: snapshot,
                manual: stored?.manual ?? null,
                current: { source: current.source, preset: current.preset },
                diff,
                hotSwitch: false,
                note: 'the startup baseline is frozen at this session’s first OMC observation and cannot be replaced; manual snapshots are kept separately',
              }, null, 2),
            }
          }
          return { text: `unknown preset_action "${subaction}"` }
        } catch (error) {
          return { text: `preset failed: ${String(error?.message ?? error)}` }
        }
      }

      if (action === 'role') {
        const subaction = String(args.role_action ?? 'list')
        try {
          if (subaction === 'list') {
            const project = readProjectRoles(args.cwd)
            const roles = [...rt.customRoles.list()]
            for (const role of project.roles) {
              if (!roles.some((row) => row.id === role.id)) roles.push(role)
            }
            return {
              text: JSON.stringify({
                roles,
                path: rt.customRoles.path,
                project: project.exists ? { path: project.path, warnings: project.warnings } : undefined,
              }, null, 2),
            }
          }
          if (subaction === 'add') {
            const role = rt.customRoles.add({
              id: args.role_id,
              title: args.title,
              persona: args.persona,
              harness: args.role_harness,
              model: args.role_model,
              fallbacks: args.role_fallbacks,
            })
            return { text: JSON.stringify({ role }, null, 2) }
          }
          if (subaction === 'remove') {
            return { text: JSON.stringify({ removed: rt.customRoles.remove(args.role_id) }, null, 2) }
          }
          if (subaction === 'run') {
            const project = readProjectRoles(args.cwd)
            const role = rt.customRoles.get(args.role_id)
              ?? project.roles.find((row) => row.id === args.role_id)
            if (!role) return { text: `OMC/ROLE-NOT-FOUND: no custom role "${args.role_id ?? ''}"` }
            const readOnly = harnessReadOnlyClass(role.harness)
            if (readOnly !== 'enforced') {
              return {
                text: `OMC/ROLE-READONLY-UNSUPPORTED: custom role "${role.id}" uses ${role.harness} (${readOnly}); ` +
                  'only an enforced read-only harness can run a custom role',
              }
            }
            if (typeof args.text !== 'string' || args.text.trim() === '') {
              return { text: 'OMC/ROLE-TASK: role run needs text (the task for the role)' }
            }
            const requestedFallbacks = Array.isArray(role.fallbacks) ? role.fallbacks : []
            const fallbacks = requestedFallbacks.filter((harness) => harnessReadOnlyClass(harness) === 'enforced')
            const skipped = requestedFallbacks.filter((harness) => !fallbacks.includes(harness))
            const payload = await dispatchTasks(rt, {
              harness: role.harness,
              ...(role.model ? { model: role.model } : {}),
              ...(fallbacks.length ? { fallbacks } : {}),
              prompt: buildRolePrompt(role, args.text),
              mode: 'read-only',
              cwd: args.cwd,
            }, { agent: exec.agent, signal: exec.signal ?? new AbortController().signal })
            return {
              text: `custom role ${role.id} (${role.harness}) read-only` +
                (fallbacks.length ? ` · fallbacks ${fallbacks.join(', ')}` : '') +
                (skipped.length ? ` · skipped non-enforced fallbacks ${skipped.join(', ')}` : '') +
                '\n' + renderDispatch(payload),
            }
          }
          return { text: `unknown role_action "${subaction}"` }
        } catch (error) {
          return { text: `role failed: ${String(error?.message ?? error)}` }
        }
      }

      if (action === 'worktree') {
        if (!exec?.agent) return { text: 'OMC/WORKTREE-PARENT-REQUIRED: worktree actions need a calling agent' }
        if (args.merge === true) {
          if (args.require_acceptance === true) {
            if (!args.node_id) return { text: 'OMC/WORKTREE-ACCEPTANCE: require_acceptance needs node_id' }
            const gate = mergeAcceptance(rt.graph.status(exec.agent.id), args.node_id)
            if (!gate.ok) return { text: `${gate.code}: ${gate.reason}; merge refused` }
          }
          const record = rt.worktrees.read(exec.agent.id)
          const branch = typeof args.branch === 'string' && args.branch.trim() !== ''
            ? args.branch.trim()
            : record?.branch
          const merged = await mergeWorktree(rt.ctx, record ? { ...record, branch } : null, { signal: exec.signal })
          return {
            text: JSON.stringify({
              merge: merged,
              note: 'A failed merge is aborted; the worktree branch and files are retained.',
            }, null, 2),
          }
        }
        const worktrees = rt.ctx.get?.('worktrees')
        if (!worktrees?.create) {
          return {
            text: 'worktree is unavailable: this DSH profile does not mount @deepseek-ai/dsh-experimental-worktree. ' +
              'Worktree creation is also session-wide, not per child — it cannot isolate a parallel external Fixer.',
          }
        }
        try {
          const record = await worktrees.create(exec.agent, { ...(args.name ? { name: args.name } : {}) }, exec.signal)
          rt.worktrees.record(exec.agent.id, record)
          return {
            text: JSON.stringify({
              worktree: record,
              note: 'This session now runs in the retained worktree. Its branch and files persist after leaving; ' +
                'this is a session-wide checkout, not a per-child isolation boundary.',
            }, null, 2),
          }
        } catch (error) {
          return { text: `worktree failed: ${String(error?.message ?? error)}` }
        }
      }

      if (action === 'graph' || action === 'send' || action === 'inbox' || action === 'ack' || action === 'thread' || action === 'reuse') {
        const parentId = exec?.agent?.id
        try {
          if (action === 'send') {
            const record = rt.mailbox.send({
              parentId,
              from: parentId,
              to: args.to,
              text: args.text,
              taskId: args.task_id,
              lane: args.lane,
              kind: args.kind,
            })
            let delivery = { delivered: false, reason: 'queued' }
            if (args.to && args.to !== '*') {
              const tools = exec?.agent?.ctx?.get?.('tools') ?? rt.ctx.get?.('tools')
              const sendTool = tools?.get?.('send_message')
              if (sendTool?.execute) {
                try {
                  await sendTool.execute({ agent_id: args.to, message: args.text }, {
                    agent: exec.agent,
                    signal: exec.signal ?? new AbortController().signal,
                  })
                  delivery = { delivered: true, reason: 'native send_message' }
                  rt.mailbox.markDelivered(parentId, record.id, { delivery: 'native' })
                } catch (error) {
                  delivery = { delivered: false, reason: String(error?.message ?? error) }
                }
              }
            }
            return { text: JSON.stringify({ message: record, delivery }, null, 2) }
          }
          if (action === 'inbox') {
            const agentId = args.agent_id ?? parentId
            const rows = rt.mailbox.inbox(parentId, agentId, { unreadOnly: args.unread_only !== false })
            return { text: JSON.stringify({ agentId, messages: rows }, null, 2) }
          }
          if (action === 'ack') {
            const ids = Array.isArray(args.ids) ? args.ids : args.message_id ? [args.message_id] : []
            return { text: JSON.stringify(rt.mailbox.ack(parentId, args.agent_id ?? parentId, ids), null, 2) }
          }
          if (action === 'thread') {
            return {
              text: JSON.stringify(rt.mailbox.thread(parentId, { taskId: args.task_id, lane: args.lane }), null, 2),
            }
          }
          if (action === 'reuse') {
            if (!args.task_id) return { text: 'reuse needs task_id; use action "tasks" to list this parent’s retained tasks' }
            const task = rt.tasks.read(parentId, args.task_id)
            const messages = rt.mailbox.thread(parentId, { taskId: args.task_id })
            if (args.execute === true) {
              if (typeof args.text !== 'string' || args.text.trim() === '') {
                return { text: 'OMC/REUSE-TASK: explicit re-execution needs text (the new prompt for the task)' }
              }
              // Re-validate the current world before spending anything: the
              // project policy must still allow a read-only dispatch, and the
              // harness must still be enabled (A16).
              const problems = []
              const project = readProjectPolicy(task.result?.cwd ?? args.cwd ?? exec?.agent?.session?.header?.cwd)
              if (project.exists && project.usable === false) problems.push('the project policy is unreadable now')
              if (task.harness && isEnabled(rt.cfg, task.harness) === false) problems.push(`${task.harness} is disabled now`)
              const result = await rt.managed.reexecute(rt, {
                parentId, taskId: args.task_id, prompt: args.text,
                exec: { agent: exec.agent, signal: exec.signal ?? new AbortController().signal },
                validate: () => problems,
              })
              return { text: JSON.stringify({ ...result, previousTask: task, messages }, null, 2) }
            }
            return {
              text: JSON.stringify({
                task,
                messages,
                next: 'Continue by calling the same role tool with the same cwd/lane and a new prompt; a matching native session is resumed when the harness supports it. Do not pass this external child id to send_message.',
              }, null, 2),
            }
          }

          const subaction = String(args.graph_action ?? 'status')
          if (!parentId) return { text: 'OMC/GRAPH-PARENT-REQUIRED: graph actions require a calling agent' }
          if (subaction === 'plan') {
            return { text: JSON.stringify(rt.graph.plan(parentId, args.nodes), null, 2) }
          }
          if (subaction === 'status') return { text: JSON.stringify(rt.graph.status(parentId), null, 2) }
          if (subaction === 'claim') {
            return {
              text: JSON.stringify(rt.graph.claim(parentId, args.node_id, { taskId: args.task_id }), null, 2),
            }
          }
          if (subaction === 'complete' || subaction === 'fail' || subaction === 'cancel') {
            if (subaction === 'cancel') {
              return { text: JSON.stringify(rt.graph.cancel(parentId, args.node_id, { reason: args.text }), null, 2) }
            }
            return {
              text: JSON.stringify(rt.graph.complete(parentId, args.node_id, {
                status: subaction === 'fail' ? 'failed' : 'completed',
                evidence: args.evidence,
                changedFiles: args.changed_files,
                taskId: args.task_id,
              }), null, 2),
            }
          }
          if (subaction === 'audit') {
            return {
              text: JSON.stringify(rt.graph.audit(parentId, args.node_id, args.changed_files), null, 2),
            }
          }
          return { text: `unknown graph_action "${subaction}"` }
        } catch (error) {
          return { text: `${action} failed: ${String(error?.message ?? error)}` }
        }
      }

      if (action === 'tasks' || action === 'result' || action === 'cancel') {
        const parentId = exec?.agent?.id
        if (action === 'result') {
          const task = rt.tasks.read(parentId, args.task_id)
          const roleResult = externalRoleResult(task)
          return {
            text: JSON.stringify({
              roleResult,
              rendered: renderRoleResult(roleResult),
              task,
            }, null, 2),
          }
        }
        const value = action === 'tasks' ? rt.tasks.list(parentId) : await rt.tasks.cancel(parentId, args.task_id)
        return { text: JSON.stringify(value, null, 2) }
      }

      if (action === 'list') {
        const report = await rt.detect()
        return { text: compactRows(report.rows) }
      }

      if (action === 'doctor') {
        const report = await rt.detect(true)
        return { text: renderReport(report, rt.cfg, rt.providerState?.()) }
      }

      if (action === 'status') {
        // The footnote section needs the calling parent to show its own budget.
        rt.statusParentId = exec?.agent?.id ?? null
        return { text: await executionStatusText(rt) }
      }

      if (action === 'native') {
        const parentId = exec?.agent?.id
        if (!parentId) return { text: 'OMC/NATIVE-PARENT-REQUIRED: native actions need a calling agent' }
        const subaction = String(args.native_action ?? 'coverage')
        try {
          if (subaction === 'coverage') {
            return { text: JSON.stringify({ coverage: rt.nativeManaged.coverage(parentId), diagnostics: rt.native.diagnostics().stats }, null, 2) }
          }
          if (subaction === 'bind') {
            if (!args.node_id) return { text: 'OMC/NATIVE-NODE: bind needs node_id (the graph node this child executes)' }
            if (!args.child_session_id) {
              return { text: 'OMC/NATIVE-CHILD: bind needs child_session_id — the native child session id, not the role tool name' }
            }
            return {
              text: JSON.stringify(rt.nativeManaged.bind({
                parentId,
                nodeId: args.node_id,
                sessionId: args.child_session_id,
                role: args.role_id ?? args.role ?? null,
              }), null, 2),
            }
          }
          if (subaction === 'settle') {
            if (!args.node_id) return { text: 'OMC/NATIVE-NODE: settle needs node_id' }
            const evidence = Array.isArray(args.evidence)
              ? args.evidence
              : typeof args.evidence === 'string' ? [args.evidence] : null
            return {
              text: JSON.stringify(rt.nativeManaged.settle({
                parentId,
                nodeId: args.node_id,
                evidence,
                changedFiles: Array.isArray(args.changed_files) ? args.changed_files : null,
                attemptId: args.attempt_id ?? null,
              }), null, 2),
            }
          }
          return { text: `unknown native_action "${subaction}"; use bind, settle, or coverage` }
        } catch (error) {
          return { text: `${error.code ?? 'OMC/NATIVE-FAILED'}: ${error.message}` }
        }
      }

      if (action === 'session') {
        const parentId = exec?.agent?.id
        if (!parentId) return { text: 'OMC/SESSION-PARENT-REQUIRED: session actions need a calling agent' }
        const subaction = String(args.session_action ?? 'log')
        try {
          if (subaction === 'workers') return { text: JSON.stringify(rt.workerRegistry.list(parentId), null, 2) }
          if (subaction === 'log') return { text: JSON.stringify(rt.decisionLog.list(parentId), null, 2) }
          if (subaction === 'decide') {
            const features = args.features && typeof args.features === 'object' ? args.features : {}
            const capabilities = args.capabilities && typeof args.capabilities === 'object' ? args.capabilities : {}
            const decision = decideSessionAction({ features, capabilities })
            const entry = rt.decisionLog.record({ parentId, features, capabilities, decision })
            return {
              text: JSON.stringify({
                decision,
                recorded: entry,
                note: 'the rule table explains the choice; reuse rate is not an objective, and a missing capability is never claimed',
              }, null, 2),
            }
          }
          return { text: `unknown session_action "${subaction}"; use decide, log, or workers` }
        } catch (error) {
          return { text: `${error.code ?? 'OMC/SESSION-FAILED'}: ${error.message}` }
        }
      }

      if (action === 'usage') {
        const parentId = exec?.agent?.id ?? null
        const diagnostics = rt.native.diagnostics()
        const summary = parentId ? rt.native.summary({ parentId }) : null
        const limits = budgetLimits(rt.cfg)
        const budget = parentId
          ? {
            limits,
            view: rt.requestGate.budgetView({ parentId, limits }),
            checkpoint: rt.requestGate.checkpoint(parentId),
            inFlight: rt.requestGate.inFlight(parentId),
            gate: rt.budgetGate ?? { installed: false, reason: 'not installed' },
            rendered: rt.requestGate.describe(rt.requestGate.budgetView({ parentId, limits })),
          }
          : { limits, gate: rt.budgetGate ?? null }
        return {
          text: JSON.stringify({
            diagnostics,
            summary,
            budget,
            note: diagnostics.installed
              ? 'Native usage is booked from host session events; the parent total is a derived rollup of its tasks, not a second booking. A missing number stays unknown.'
              : 'The native bridge is not installed in this host, so native usage is not being booked. Nothing here is a zero-cost claim.',
          }, null, 2),
        }
      }

      if (action === 'fleet' || action === 'demo') {
        try {
          if (action === 'demo') {
            const result = await runNativeDemo(rt.ctx, {
              models: args.models,
              // A demo is an explicit request; preview only when asked.
              apply: args.apply !== false,
              cwd: args.demo_dir,
              refresh: args.refresh === true,
            })
            return { text: result.text }
          }
          const { plan } = await buildNativeFleet(rt.ctx, { models: args.models, refresh: args.refresh === true })
          if (args.apply !== true) return { text: renderFleetPlan(plan) }
          const applied = await applyNativeFleet(rt.ctx, plan)
          const notes = [
            ...(applied.applied ? [] : ['not applied: ' + (applied.reason ?? 'unknown reason')]),
            ...(applied.mismatch ?? []).map((entry) => 'verify: ' + entry),
          ]
          return {
            text: [renderFleetPlan(plan, { applied: applied.applied, backup: applied.backup }), ...notes].join('\n'),
          }
        } catch (error) {
          return { text: `${action} failed: ${String(error?.message ?? error)}` }
        }
      }

      if (action === 'sessions') {
        if (args.clear_lane === true || (args.clear === true && typeof args.lane === 'string' && args.lane !== '')) {
          if (typeof args.lane !== 'string' || args.lane === '') {
            return { text: 'clear_lane needs lane; use action sessions with lane or clear:true for every reference' }
          }
          const removed = rt.sessions.forgetLane(args.lane)
          return { text: `forgot ${removed} OMC session reference(s) for lane "${args.lane}"; CLI-native histories were not touched` }
        }
        if (args.clear === true) {
          rt.sessions.clear()
          return { text: 'cleared OMC session references; CLI-native histories were not touched' }
        }
        return { text: renderSessions(rt.sessions, { lane: args.lane }) }
      }

      if (action === 'migrate') {
        const result = await applyMigrationCommand(rt.ctx, args.rollback === true
          ? { rollback: true }
          : { apply: args.apply === true, force: args.force === true })
        return { text: result.text }
      }

      if (action !== 'dispatch') {
        return { text: `unknown action "${action}"; use dispatch, list, status, doctor, fleet, demo, sessions, tasks, result, cancel, or migrate` }
      }

      // A dispatch bound to a graph node takes the managed path (WP05):
      // claim → attempt → events → acceptance → settle/release. Everything
      // else keeps the ordinary path and is labeled managed:false by the
      // managed wrapper only when it runs there; an ordinary result simply
      // does not claim managed coverage.
      if (args.node_id) {
        const payload = await rt.managed.dispatch(rt, { ...args, nodeId: args.node_id }, {
          agent: exec?.agent,
          signal: exec?.signal ?? new AbortController().signal,
        })
        return { text: renderDispatch(payload) }
      }

      const payload = await dispatchTasks(rt, args, {
        agent: exec?.agent,
        signal: exec?.signal ?? new AbortController().signal,
      })
      return { text: renderDispatch(payload) }
    },
  }
}

function coharnessCommand(rt) {
  return {
    name: 'coharness',
    description: 'Diagnose external CLIs, inspect role execution backends and native-session reuse, and migrate the pre-0.4 configuration.',
    input: { hint: 'doctor | status | sessions [--clear] | migrate [--apply] [--force] | migrate --rollback' },
    handler: async (invocation) => {
      rt.ensureProviders?.()
      const raw = String(invocation?.rawInput ?? '').trim()
      const tokens = raw.replace(/^\/?coharness\b/i, '').trim().split(/\s+/).filter(Boolean)
      const topic = tokens[0] ?? 'doctor'
      const flags = new Set(tokens.slice(1).map((token) => token.toLowerCase()))

      if (topic === 'doctor' || topic === 'help' || topic === '') {
        if (topic === 'help') {
          return {
            kind: 'success',
            text: [
              '/coharness doctor            full diagnostic report (CLIs, providers, role backends)',
              '/coharness status            role → backend table, provider registration and session reuse',
              '/coharness sessions          OMC native-session references and usage (filter with --lane=<id>)',
              '/coharness sessions --clear  forget every reference; --clear --lane=<id> forgets one lane',
              '/coharness fleet             preview native role routes from the live DSH model catalog',
              '/coharness fleet --apply     pin the native roles to those routes (backed up first)',
              '/coharness demo              apply the fleet, seed a demo workspace and print the run prompt',
              '/coharness demo --preview    seed the workspace without writing the role routes',
              '/coharness migrate           preview the OMD → OMC configuration migration',
              '/coharness migrate --apply   back up, then write the migrated configuration',
              '/coharness migrate --force   overwrite conflicting values (backup is still written)',
              '/coharness migrate --rollback restore the pre-migration configuration',
            ].join('\n'),
          }
        }
        const report = await rt.detect(true)
        return { kind: 'success', text: renderReport(report, rt.cfg, rt.providerState?.()) }
      }

      if (topic === 'status') {
        return { kind: 'success', text: await executionStatusText(rt) }
      }

      if (topic === 'fleet' || topic === 'demo') {
        try {
          if (topic === 'demo') {
            const result = await runNativeDemo(rt.ctx, {
              apply: !flags.has('--preview'),
              refresh: flags.has('--refresh'),
            })
            return { kind: 'success', text: result.text }
          }
          const { plan } = await buildNativeFleet(rt.ctx, { refresh: flags.has('--refresh') })
          if (!flags.has('--apply')) return { kind: 'success', text: renderFleetPlan(plan) }
          const applied = await applyNativeFleet(rt.ctx, plan)
          const notes = [
            ...(applied.applied ? [] : ['not applied: ' + (applied.reason ?? 'unknown reason')]),
            ...(applied.mismatch ?? []).map((entry) => 'verify: ' + entry),
          ]
          return {
            kind: 'success',
            text: [renderFleetPlan(plan, { applied: applied.applied, backup: applied.backup }), ...notes].join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `${topic} failed: ${String(error?.message ?? error)}` }
        }
      }

      if (topic === 'sessions') {
        const lane = tokens.find((token) => token.startsWith('--lane='))?.slice('--lane='.length) ?? ''
        if (flags.has('--clear') && lane !== '') {
          const removed = rt.sessions.forgetLane(lane)
          return {
            kind: 'success',
            text: `forgot ${removed} OMC session reference(s) for lane "${lane}"; CLI-native histories were not touched`,
          }
        }
        if (flags.has('--clear')) {
          rt.sessions.clear()
          return { kind: 'success', text: 'cleared OMC session references; CLI-native histories were not touched' }
        }
        return { kind: 'success', text: renderSessions(rt.sessions, { lane: lane || undefined }) }
      }

      if (topic === 'migrate') {
        try {
          const result = flags.has('--rollback')
            ? await applyMigrationCommand(rt.ctx, { rollback: true })
            : await applyMigrationCommand(rt.ctx, {
              apply: flags.has('--apply'),
              force: flags.has('--force'),
            })
          return { kind: 'success', text: result.text }
        } catch (error) {
          return { kind: 'error', text: `coharness migrate failed: ${String(error?.message ?? error)}` }
        }
      }

      return {
        kind: 'error',
        text: `unknown /coharness topic "${topic}"; use doctor, status, fleet, demo, sessions, or migrate`,
      }
    },
  }
}

/** How long a report containing a failed probe may be served before re-probing. */
export const REPORT_TTL_MS = 15_000

/**
 * Whether a cached doctor report is stale enough that `detect()` must re-probe.
 *
 * Only an unverifiable report is refreshed automatically: a row that failed its
 * probe (`probeFailed`) or that came back `auth: 'unknown'` from the probe
 * (`source: 'probe'`) is a transient verdict — a cold-start WSL probe, for
 * instance — and serving it forever turns a hiccup into a permanent "missing".
 * A report with no such row is the truth for this process and is never
 * auto-refreshed; only an explicit `detect(true)` (doctor) re-probes it.
 *
 * @param {any} report a doctor report (`{ rows: [...] }`) or null
 * @param {number} ageMs milliseconds since that report was cached
 * @param {number} [ttlMs] freshness window; defaults to {@link REPORT_TTL_MS}
 * @returns {boolean} true only when a failed probe is older than the TTL
 */
export function reportNeedsRefresh(report, ageMs, ttlMs = REPORT_TTL_MS) {
  const rows = Array.isArray(report?.rows) ? report.rows : []
  const unverifiable = rows.some(
    (row) => row?.probeFailed === true || (row?.auth === 'unknown' && row?.source === 'probe'),
  )
  if (!unverifiable) return false
  // An unclocked report cannot be proven fresh; treat it as stale.
  return !Number.isFinite(ageMs) || ageMs >= ttlMs
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const sessions = createSessionRegistry(cfg.sessions)
  const stateDir = cfg.stateDir || ''
  const tasks = createTaskRegistry({
    dir: stateDir ? join(stateDir, 'tasks') : statePath('tasks'),
    maxRetained: 100,
  })
  const graph = createGraphStore({ dir: stateDir ? join(stateDir, 'graph') : statePath('graph') })
  const mailbox = createMailbox({ dir: stateDir ? join(stateDir, 'mailbox') : statePath('mailbox') })
  const worktrees = createWorktreeStore({ dir: stateDir ? join(stateDir, 'worktrees') : statePath('worktrees') })
  const customRoles = createCustomRoles({ dir: stateDir ? join(stateDir, 'roles') : statePath('roles') })
  const presetSnapshots = createPresetSnapshotStore({
    dir: stateDir ? join(stateDir, 'presets') : statePath('presets'),
  })
  // 0.5.0-alpha.2 batch 1: the efficiency stores. They are wired in now so
  // later work packages (context view, managed graph, budget) share one
  // instance per host process instead of inventing their own roots.
  const usageLedger = createUsageLedger({ dir: stateDir ? join(stateDir, 'usage') : statePath('usage') })
  const executionStore = createExecutionStore({ dir: stateDir ? join(stateDir, 'execution') : statePath('execution') })
  const artifacts = createArtifactStore({ dir: stateDir ? join(stateDir, 'artifacts') : statePath('artifacts') })
  // WP04–WP06 surfaces. The context view and retrieval cache shape OMC's own
  // echo in every mode; the budget/progress trackers start in observe: they
  // record and advise, they do not change how a task runs (V0.5-ALPHA2 §2).
  const contextView = createContextView({ artifacts, maxToolTextChars: cfg.efficiency.context.maxToolTextChars })
  const retrievalCache = createRetrievalCache({ dir: stateDir ? join(stateDir, 'retrieval') : statePath('retrieval') })
  const budget = createBudgetTracker({ usageLedger, executionStore, maxCalls: cfg.efficiency.budget.maxCalls, maxUsd: cfg.efficiency.budget.maxUsd })
  const progress = createProgressTracker({ repeatWindow: cfg.efficiency.progress.repeatWindow, repeatThreshold: cfg.efficiency.progress.repeatThreshold })
  const managed = createManagedExecution({ graph, mailbox, tasks, executionStore, usageLedger })
  // R01: the native runtime bridge. It puts real host children into the same
  // task/usage records as everything else, from host events only — there is no
  // second agent runtime and no session-file rewriting. Installed below with
  // `ctx.effect`, so a plugin unload removes its listeners.
  const native = createNativeRuntime({
    usageLedger,
    executionStore,
    roleFromDescriptor: (event) => roleIdFromLabel(event?.data?.label),
    // Sessions created under this preset are OMC's own parents; another
    // preset's session is never adopted.
    ownPreset: PRESET_ID,
    warn: (line) => {
      try {
        ctx.logger?.warn?.(line)
      } catch {
        // A logger that is already torn down must not fail the bridge.
      }
    },
  })

  // R02: the authoritative per-request budget gate. The WP06 tracker keeps its
  // advisory checkpoint role; this one owns the reservations that cross
  // processes.
  const requestGate = createRequestGate({
    dir: stateDir ? join(stateDir, 'budget') : statePath('budget'),
    usageLedger,
  })

  // R03: binding a native child to a graph node. R04: the rotatable worker
  // registry and the explainable action log behind the session choice.
  const nativeManaged = createNativeManaged({ graph, native, executionStore })
  const workerRegistry = createWorkerRegistry({ dir: stateDir ? join(stateDir, 'workers') : statePath('workers') })
  const decisionLog = createDecisionLog({ dir: stateDir ? join(stateDir, 'decisions') : statePath('decisions') })

  /** @type {Set<string>} */
  const registered = new Set()
  /** @type {string[]} */
  const providerIssues = []
  let attempted = false
  let cachedReport = null
  let cachedAt = 0

  const rt = {
    ctx,
    cfg,
    registered,
    sessions,
    tasks,
    graph,
    mailbox,
    worktrees,
    customRoles,
    presetSnapshots,
    usageLedger,
    executionStore,
    artifacts,
    contextView,
    retrievalCache,
    budget,
    progress,
    managed,
    native,
    requestGate,
    nativeManaged,
    workerRegistry,
    decisionLog,
    /**
     * Registration is retried on every entry point. A Loader may apply this plugin
     * before the `subagents` row exists (row order is not ours to control), and a
     * one-shot attempt at apply time then silently loses the whole provider surface.
     * Registering again later is safe: the Set makes it idempotent.
     */
    ensureProviders,
    providerState() {
      return { registered: [...registered], issues: [...providerIssues], attempted }
    },
    async detect(force = false) {
      // A failed probe is a stale verdict, not a durable one: re-probe it after
      // the TTL so the first status/list after a restart cannot keep serving
      // "missing" to every later call. A clean report stays cached until a
      // forced `detect(true)` (doctor) asks for a fresh pass.
      const stale = cachedReport !== null && reportNeedsRefresh(cachedReport, Date.now() - cachedAt)
      if (!cachedReport || force || stale) {
        cachedReport = await detect(ctx, cfg)
        cachedAt = Date.now()
      }
      return cachedReport
    },
    /**
     * The cached report, never a fresh probe: dispatch uses it only to add a
     * best-effort `signed-out` warning and must not pay for a full discovery pass.
     */
    peekReport() {
      return cachedReport
    },
  }

  // ── providers ───────────────────────────────────────────────────────────────
  function ensureProviders() {
    const subagents = ctx.get('subagents')
    if (!subagents || cfg.surface === 'direct') return registered
    attempted = true

    const existing = new Set(subagents.list?.() ?? [])
    for (const def of HARNESSES) {
      if (!isEnabled(cfg, def.id) || registered.has(def.id)) continue
      const name = `omc:${def.id}`
      if (existing.has(name)) continue // another plugin already owns this name; never shadow it
      try {
        const provider = makeProvider(ctx, def, cfg, { readOnly: true, registry: sessions, tasks })
        ctx.effect(() => subagents.registerProvider(provider))
        registered.add(def.id)
      } catch (error) {
        // Keep the other harnesses usable; doctor prints the exact reason.
        const detail = `${def.id}: ${String(error?.message ?? error).slice(0, 200)}`
        if (!providerIssues.includes(detail)) providerIssues.push(detail)
      }
    }
    return registered
  }

  // `ctx.inject` runs the callback now if the service exists and again when it
  // appears, which is the load-order-safe path. Wrapped: an older Cordis without
  // this signature must not take the whole plugin down.
  try {
    ctx.inject?.(['subagents'], () => ensureProviders())
  } catch {
    // Fall back to the entry-point retries below.
  }
  ensureProviders()

  // ── native runtime bridge (R01) ─────────────────────────────────────────────
  // Subscribed once per host context. `session/event` is the durable stream the
  // host itself persists, and `agent/created` carries the child's lineage; the
  // bridge books usage and settlement from those, never from a session file.
  try {
    native.install(ctx)
  } catch (error) {
    // A host without a global event surface keeps every other OMC capability;
    // the bridge reports itself as not installed instead of failing the plugin.
    try {
      ctx.logger?.warn?.(`oh-my-coharness: native runtime bridge not installed: ${String(error?.message ?? error)}`)
    } catch {
      // torn-down logger
    }
  }

  // ── per-request budget gate (R02) ───────────────────────────────────────────
  // Registered AFTER the native bridge on purpose: a usage entry must be booked
  // before its reservation can settle as `booked`. The gate is authoritative
  // (cross-process, file-locked) and only blocks when a cap is configured.
  try {
    rt.budgetGate = installBudgetGate(ctx, rt)
  } catch (error) {
    rt.budgetGate = { installed: false, reason: String(error?.message ?? error) }
    try {
      ctx.logger?.warn?.(`oh-my-coharness: budget gate not installed: ${String(error?.message ?? error)}`)
    } catch {
      // torn-down logger
    }
  }

  // ── tool ────────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(coharnessTool(rt)))

  // ── command ─────────────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands?.register) {
    ctx.effect(() => commands.register(coharnessCommand(rt)))
  }

  // ── skills ──────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposers = registerSkills(ctx)
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
