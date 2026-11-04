/**
 * PR-04 (0.7): routable + billing-aware automatic routing, and the
 * session/worker decision entering the dispatch path.
 *
 * The connection model already distinguishes registered from routable. These
 * tests pin that dispatch actually uses it:
 *   - automatic routing is OFF unless routing.enabled is true;
 *   - it may only pick a `routable` connection (authenticated + field-verified
 *     + billing authorized), never a signed-out or unknown-billing CLI;
 *   - registration alone is not routability, and an empty connection table does
 *     not resurrect the old auth-only heuristic;
 *   - an explicit harness stays the user's call;
 *   - native role preferences are not silently replaced by an external run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../../src/config.js'
import { harnessDef } from '../../src/harnesses.js'
import { dispatchTasks } from '../../src/dispatch.js'
import { makeProvider } from '../../src/provider.js'
import { createSessionRegistry } from '../../integration/sessions.js'
import { createWorkerRegistry, workerKeyFor } from '../../integration/worker-registry.js'
import { createDecisionLog } from '../../integration/session-strategy.js'
import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { createHandoff, encodeHandoffMarker, normalizeWorkspace, projectIdFor, laneIdFor } from '../../integration/handoff.js'

const ALL_HARNESSES = ['codex', 'claude', 'glm', 'gemini', 'antigravity', 'kimi', 'opencode', 'qwen']

function cfgWith({ enabled = ['codex'], routing = {}, harnesses = {}, sessions = {} } = {}) {
  return resolveConfig({
    transport: 'native',
    routing,
    sessions,
    harnesses: Object.fromEntries(ALL_HARNESSES.map((id) => [id, {
      enabled: enabled.includes(id),
      billing: 'subscription',
      ...(harnesses[id] ?? {}),
    }])),
  })
}

function rtFor(cfg, { rows = [{ id: 'codex', auth: 'ok' }], registered = new Set(['codex']) } = {}) {
  const activations = []
  const ctx = {
    get(name) {
      if (name !== 'subagents') return undefined
      return {
        startActivation: async ({ request }) => {
          activations.push(request)
          return {
            childId: 'child-1',
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }], diagnostic: '' }),
            dispose: async () => {},
          }
        },
      }
    },
  }
  return { activations, ctx }
}

function execFor(cwd, id = 'parent-1') {
  return { agent: { id, session: { id: `s-${id}`, header: { cwd } } }, signal: new AbortController().signal }
}

function failed(result, codePattern) {
  const row = result.results[0]
  assert.equal(row.status, 'failed')
  assert.match((row.diagnostics ?? []).join(' '), codePattern)
  return row
}

test('PR-04: automatic routing is refused unless routing.enabled is true', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-off-'))
  const cfg = cfgWith({ routing: {} })
  const { ctx, activations } = rtFor(cfg)
  const result = await dispatchTasks({ ctx, cfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }) },
    { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  failed(result, /OMC\/ROUTING-DISABLED/)
  assert.equal(activations.length, 0)
})

test('PR-04: auto picks only a routable connection and records its billing state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-auto-'))
  const cfg = cfgWith({ enabled: ['codex', 'qwen'], routing: { enabled: true } })
  const { ctx, activations } = rtFor(cfg, { registered: new Set(['codex', 'qwen']) })
  const result = await dispatchTasks({
    ctx, cfg, registered: new Set(['codex', 'qwen']),
    detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }, { id: 'qwen', auth: 'ok' }] }),
  }, { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  assert.equal(result.results[0].status, 'completed')
  assert.equal(result.results[0].harnessId, 'codex')
  assert.equal(result.results[0].route.source, 'auto')
  assert.equal(result.results[0].route.state, 'routable')
  assert.equal(result.results[0].route.billing, 'subscription')
  assert.equal(result.results[0].modelSource, 'configured', 'the configured model is not presented as an observed one')
  assert.equal(result.results[0].packetCoverage, 'unmanaged')
  assert.equal(activations.length, 1)
})

test('PR-04: a signed-out or unknown-billing connection is never auto-consumed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-blocked-'))
  const cfg = cfgWith({ routing: { enabled: true } })
  const { ctx, activations } = rtFor(cfg, { rows: [{ id: 'codex', auth: 'signed-out' }] })
  const signedOut = await dispatchTasks({ ctx, cfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'signed-out' }] }) },
    { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  failed(signedOut, /OMC\/NO-ROUTABLE-PROVIDER.*signed-out/)
  assert.equal(activations.length, 0)

  // Unknown billing is blocked unless explicitly authorized.
  const unknownCfg = cfgWith({ routing: { enabled: true }, harnesses: { codex: { billing: 'unknown' } } })
  const unknown = await dispatchTasks({
    ctx, cfg: unknownCfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }),
  }, { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  failed(unknown, /OMC\/NO-ROUTABLE-PROVIDER.*unknown billing/)
  assert.equal(activations.length, 0)

  const authorizedCfg = cfgWith({
    routing: { enabled: true, allowUnknownBilling: true },
    harnesses: { codex: { billing: 'unknown' } },
  })
  const allowed = await dispatchTasks({
    ctx, cfg: authorizedCfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }),
  }, { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  assert.equal(allowed.results[0].status, 'completed')
  assert.equal(allowed.results[0].route.billing, 'unknown-authorized')
})

test('PR-04: registration alone is not routability, and an empty table does not revive the old heuristic', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-noreg-'))
  const cfg = cfgWith({ routing: { enabled: true } })
  const { ctx, activations } = rtFor(cfg, { rows: [], registered: new Set(['codex']) })
  const result = await dispatchTasks({ ctx, cfg, registered: new Set(['codex']), detect: async () => ({ rows: [] }) },
    { harness: 'auto', prompt: 'review', cwd }, execFor(cwd))
  failed(result, /OMC\/NO-ROUTABLE-PROVIDER/)
  assert.equal(activations.length, 0)
})

test('PR-04: an explicit harness still runs while auto routing is disabled', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-explicit-'))
  const cfg = cfgWith({ routing: {} })
  const { ctx, activations } = rtFor(cfg)
  const result = await dispatchTasks({
    ctx, cfg, registered: new Set(['codex']),
    detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }), peekReport: () => ({ rows: [{ id: 'codex', auth: 'ok' }] }),
  }, { harness: 'codex', prompt: 'review', cwd }, execFor(cwd))
  assert.equal(result.results[0].status, 'completed', JSON.stringify(result.results[0]))
  assert.equal(result.results[0].route.source, 'explicit')
  assert.equal(activations.length, 1)
})

test('PR-04: a native role preference is not silently routed to an external CLI', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-native-'))
  const cfg = cfgWith({ routing: { enabled: true, preset: 'balanced' } })
  const { ctx, activations } = rtFor(cfg)
  const nativeResult = await dispatchTasks({ ctx, cfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }) },
    { harness: 'auto', roleId: 'fixer', prompt: 'fix', cwd }, execFor(cwd))
  failed(nativeResult, /OMC\/ROUTE-NATIVE/)
  assert.equal(activations.length, 0)

  // Oracle prefers Codex in the balanced preset and is authorized here.
  const oracle = await dispatchTasks({ ctx, cfg, registered: new Set(['codex']), detect: async () => ({ rows: [{ id: 'codex', auth: 'ok' }] }) },
    { harness: 'auto', roleId: 'oracle', prompt: 'review', cwd }, execFor(cwd))
  assert.equal(oracle.results[0].harnessId, 'codex')
  assert.equal(oracle.results[0].route.roleId, 'oracle')
})

/* 鈹€鈹€ worker / session decision path 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

function fakeProviderCtx(threadId = 'thread-1') {
  const specs = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      const stdout = [
        JSON.stringify({ type: 'thread.started', thread_id: threadId }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
      ].join('\n')
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  return { specs, ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined) } }
}

function rolePrompt({ cwd, roleId = 'oracle', taskId = 'task-1', revision = null }) {
  const handoff = createHandoff({ roleId, cwd, taskId, revision })
  return `Role: ${roleId} (${roleId})\n\nTask:\nDo the work.\n\n${encodeHandoffMarker(handoff)}`
}

function startProvider(provider, { cwd, parentId = 'parent-1', roleId = 'oracle', taskId = 'task-1', revision = null, prompt = null }) {
  return provider.start({
    prompt: [{ type: 'text', text: prompt ?? rolePrompt({ cwd, roleId, taskId, revision }) }],
    cwd,
    parent: { id: parentId, session: { id: `s-${parentId}`, header: { cwd } } },
    mode: 'read-only',
    signal: new AbortController().signal,
  })
}

function makeWorkerProvider({ ctx, cfg, workerRegistry = null, decisionLog = null, registry = null, sessionStore = null, executionStore = null }) {
  return makeProvider(ctx, harnessDef('codex'), cfg, {
    readOnly: true,
    registry: sessionStore ?? registry,
    workerRegistry,
    decisionLog,
    executionStore,
  })
}


test('PR-04: worker decision records new-packet/resume/queue/restart with rules and generation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-worker-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'omc-pr04-sessions-'))
  const cfg = cfgWith({ sessions: { path: join(sessionsDir, 'sessions.json'), maxTurns: 5 } })
  const sessions = createSessionRegistry(cfg.sessions)
  const workers = createWorkerRegistry({})
  const decisions = createDecisionLog({})
  const { ctx } = fakeProviderCtx('thread-worker')

  // Compute the exact worker identity the provider will use.
  const projectId = projectIdFor(cwd)
  const laneId = laneIdFor('oracle', projectId)
  const workerKey = workerKeyFor({
    projectId,
    moduleId: laneId,
    roleId: 'oracle',
    route: { provider: 'omc:codex', model: null },
    permission: 'read-only',
    workspace: normalizeWorkspace(cwd),
  })

  // 1. First run: no prior worker → new-packet, and no session reuse.
  const firstProvider = makeWorkerProvider({ ctx, cfg, workerRegistry: workers, decisionLog: decisions, sessionStore: sessions })
  const firstRun = await startProvider(firstProvider, { cwd })
  await firstRun.result
  let [entry] = decisions.list('parent-1')
  assert.equal(entry.rulesVersion, 1)
  assert.equal(entry.decision.action, 'new-packet')
  assert.equal(entry.decision.ruleId, 'S02-no-prior-worker')
  assert.equal(entry.actualAction, 'new-packet')
  assert.ok(entry.features && entry.capabilities)
  const worker = workers.get(workerKey)
  assert.equal(worker.generation, 1)
  assert.equal(worker.roleId, 'oracle')
  assert.equal(worker.busy, false)

  // 2. Bootstrap a stored native session for this lane with the worker gate off
  //    (the only way the registry ever holds a role session).
  const ungated = makeWorkerProvider({ ctx: fakeProviderCtx('thread-worker').ctx, cfg, sessionStore: sessions })
  const ungatedRun = await startProvider(ungated, { cwd, taskId: 'task-bootstrap' })
  await ungatedRun.result
  assert.ok(sessions.stats().resumable >= 1)

  // 3. A prior idle worker + matching facts → resume the same generation.
  const resumed = await startProvider(
    makeWorkerProvider({ ctx: fakeProviderCtx('thread-worker').ctx, cfg, workerRegistry: workers, decisionLog: decisions, sessionStore: sessions }),
    { cwd, taskId: 'task-2' },
  )
  await resumed.result
  const resumeEntry = decisions.list('parent-1').at(-1)
  assert.equal(resumeEntry.decision.action, 'resume', `features=${JSON.stringify(resumeEntry.features)} prior=${JSON.stringify(workers.get(workerKey))}`)
  assert.equal(resumeEntry.decision.ruleId, 'S07-same-module')
  assert.equal(resumeEntry.actualAction, 'resume')
  assert.equal(resumeEntry.outcome.generation, 1)

  // 4. A busy worker is queued, not run in parallel; the decision is recorded
  //    but the CLI is never spawned.
  workers.setHealth(workerKey, { busy: true })
  const busyCtx = fakeProviderCtx('thread-worker')
  await assert.rejects(
    () => startProvider(
      makeWorkerProvider({ ctx: busyCtx.ctx, cfg, workerRegistry: workers, decisionLog: decisions, sessionStore: sessions }),
      { cwd, taskId: 'task-3' },
    ),
    (error) => error.code === 'OMC/WORKER-BUSY',
  )
  assert.equal(busyCtx.specs.length, 0)
  assert.equal(decisions.list('parent-1').at(-1).decision.action, 'queue')
  workers.setHealth(workerKey, { busy: false })

  // 5. Changed constraints → restart: a new generation/child, old one retained.
  const before = workers.get(workerKey)
  const restarted = await startProvider(
    makeWorkerProvider({ ctx: fakeProviderCtx('thread-worker').ctx, cfg, workerRegistry: workers, decisionLog: decisions, sessionStore: sessions }),
    { cwd, taskId: 'task-4', revision: 'rev-b' },
  )
  await restarted.result
  const restartEntry = decisions.list('parent-1').at(-1)
  assert.equal(restartEntry.decision.action, 'restart')
  assert.equal(restartEntry.decision.ruleId, 'S03-reuse-refused')
  const after = workers.get(workerKey)
  assert.equal(after.generation, before.generation + 1)
  assert.ok(after.history.some((row) => row.childId === before.childId))

  // 6. A direct unsigned prompt never reaches the worker gate and never resumes.
  const directCount = decisions.list('parent-1').length
  const directCtx = fakeProviderCtx('thread-direct')
  const direct = await makeWorkerProvider({ ctx: directCtx.ctx, cfg, workerRegistry: workers, decisionLog: decisions, sessionStore: sessions })
    .start({
      prompt: [{ type: 'text', text: 'Just look at this file.' }],
      cwd,
      parent: { id: 'parent-1', session: { id: 's-parent-1', header: { cwd } } },
      signal: new AbortController().signal,
    })
  const directValue = await direct.result
  assert.equal(decisions.list('parent-1').length, directCount, 'an unsigned prompt records no role-session decision')
  assert.match(directValue.diagnostic, /session reuse off/)
  assert.equal(directCtx.specs.length, 1)
})

test('PR-04: managed dispatch records the same worker decision for a signed role prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr04-managed-decide-'))
  const cfg = cfgWith({ sessions: { path: join(cwd, 'sessions.json') } })
  const tasks = createTaskRegistry({})
  const executionStore = createExecutionStore({})
  const usageLedger = createUsageLedger({})
  const graph = createGraphStore()
  const managed = createManagedExecution({
    graph, mailbox: createMailbox({}), tasks, executionStore, usageLedger,
  })
  graph.plan('parent-1', [{ id: 'n1' }])

  const workers = createWorkerRegistry({})
  const decisions = createDecisionLog({})
  const { ctx: providerCtx } = fakeProviderCtx('thread-managed')
  const provider = makeProvider(providerCtx, harnessDef('codex'), cfg, {
    readOnly: true, tasks, usageLedger, executionStore, workerRegistry: workers, decisionLog: decisions,
  })
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => cwd }
      if (name === 'subagents') {
        return {
          list: () => ['omc:codex'],
          startActivation: async ({ request }) => {
            const run = await provider.start(request)
            return { childId: run.id, result: run.result, dispose: run.dispose }
          },
        }
      }
      return undefined
    },
  }
  const rt = { ctx, cfg, registered: new Set(['codex']), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const result = await managed.dispatch(rt, {
    harness: 'codex',
    prompt: rolePrompt({ cwd }),
    nodeId: 'n1',
    cwd,
  }, { agent: { id: 'parent-1', session: { id: 's-parent-1', header: { cwd } } }, signal: new AbortController().signal })
  assert.equal(result.results[0].status, 'completed')
  assert.equal(result.results[0].packetCoverage, 'legacy', 'a node without acceptance keeps the legacy label')
  assert.ok(result.results[0].sessionDecision, 'the managed result carries the rule-table decision')
  assert.equal(result.results[0].sessionDecision.action, 'new-packet')
  assert.equal(result.results[0].sessionDecision.rulesVersion, 1)
  const [entry] = decisions.list('parent-1')
  assert.equal(entry.decision.action, 'new-packet')
  assert.equal(entry.actualAction, 'new-packet')
  assert.equal(workers.list('parent-1').length, 1)
})
