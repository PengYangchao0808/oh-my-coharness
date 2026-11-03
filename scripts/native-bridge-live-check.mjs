/**
 * R01 no-model host probe: the native runtime bridge against a real installed host.
 *
 * This is NOT a unit test with hand-written payloads. It boots the installed
 * Desktop host, mounts this checkout through an isolated profile, registers a
 * synthetic provider adapter (zero model cost) and then:
 *
 *   1. drives a parent agent, a child agent and a nested child, so the host
 *      persists real `session/event` payloads (request/header, assistant/attempt,
 *      assistant/message with usage, turn/end with a reason);
 *   2. imports integration/native-runtime.js and feeds those durable events into
 *      it, which is how the bridge is expected to see them;
 *   3. checks the OMC plugin instance mounted in that same host reports the
 *      bridge as installed through `coharness {action:"usage"}`.
 *
 * Run (same contract as scripts/host-live-check.cjs):
 *
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   $env:DSH_HOST_ANCHOR = '<installed app.asar>\dsh\lib\bin.js'
 *   $env:DSH_PROFILE_DIR = '<checkout>\.ops\dsh-home\profiles\omc-test'
 *   & '<DeepSeek Harness.exe>' --expose-internals scripts/native-bridge-live-check.mjs
 *
 * Exit 0 only when every verdict passed. The JSON verdicts go to
 * docs/evidence/alpha.2/practice-r01-native-runtime.json (or --out <path>).
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const outPath = resolve(root, option('--out', 'docs/evidence/alpha.2/practice-r01-native-runtime.json'))

const anchor = process.env.DSH_HOST_ANCHOR
const configuredProfileDir = process.env.DSH_PROFILE_DIR
assert.ok(anchor.startsWith(root) || process.env.DSH_HOST_ANCHOR, 'DSH_HOST_ANCHOR is required')
assert.ok(configuredProfileDir, 'DSH_PROFILE_DIR is required')
const profileDir = resolve(configuredProfileDir)
assert.ok(profileDir.startsWith(root + '/.ops/') || profileDir.startsWith(root + '\\.ops\\'), 'the probe only accepts a workspace .ops profile')

process.argv[1] = anchor
process.env.DSH_HOME = dirname(dirname(profileDir))
const requireHost = createRequire(anchor)
const hostImport = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const hostBase = pathToFileURL(anchor).href
const packageImport = (relative) => import(pathToFileURL(join(root, relative)).href)

const PROVIDER = 'omc-native-probe'
const MODEL = 'probe-1'
const USAGE = Object.freeze({ inputTokens: 123, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 7 })

let ctx
const facts = { sessions: {}, children: [], adapterCalls: [], preSteps: [] }
const watchdog = setTimeout(() => {
  console.error('OMC_NATIVE_BRIDGE_TIMEOUT')
  process.exit(1)
}, 90_000)

async function main() {
  const { boot, readProfilePatches } = await hostImport('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await hostImport('@deepseek-ai/dsh-cmdline')
  const profileContext = {
    home: process.env.DSH_HOME,
    dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: anchor,
    name: profileDir.split(/[\\/]/).pop(),
    startedBundles: [],
    bundles: JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles,
    overlays: [],
  }
  const patches = readProfilePatches(profileContext.name, profileContext)
  const requirePackage = createRequire(join(root, 'package.json'))
  const anchorRows = (rows) => {
    for (const row of rows) {
      if (row.name?.startsWith('@deepseek-ai/')) row.name = pathToFileURL(requireHost.resolve(row.name)).href
      if (row.name?.startsWith('oh-my-coharness')) row.name = pathToFileURL(requirePackage.resolve(row.name)).href
      if (row.insert) anchorRows(row.insert)
      if (row.group && Array.isArray(row.config)) anchorRows(row.config)
      if (row.id === 'directory-picker' || row.id === 'hmr' || row.id === 'session-title-llm') row.disabled = true
      if (row.id === 'web-runtime') row.config = { ...row.config, printUrl: false }
    }
  }
  anchorRows(patches)
  ctx = await boot(
    profileContext.name,
    join(profileDir, 'cordis.yml'),
    patches,
    (rootCtx) => {
      rootCtx.provide('profileContext', profileContext)
      provideCmdline(rootCtx, { args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], exit: (code) => { throw new Error('unexpected app exit ' + code) } })
      rootCtx.get('loader').config.bareModuleBaseUrl = hostBase
    },
    pathToFileURL(join(profileDir, 'package.json')).href,
  )
  facts.hostVersion = requireHost('@deepseek-ai/dsh/package.json').version

  // ── synthetic provider: every dispatch is local, no model call ──────────────
  const llm = ctx.get('llm')
  const { LlmAdapter, createUserMessage } = await hostImport('@deepseek-ai/dsh-llm')
  const calls = new Map()
  class ProbeAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'OMC native bridge probe (synthetic)' } }
    async listModels(provider) { return [{ provider, id: MODEL, name: 'probe' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'probe' } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: 'probe' }, stream: (options) => this.dispatch(options) }
    }
    async *dispatch(options) {
      const id = options.sessionId ?? '(absent)'
      const count = (calls.get(id) ?? 0) + 1
      calls.set(id, count)
      facts.adapterCalls.push({ sessionId: id, call: count })
      if (count === 1 && !options.messages?.some((m) => String(m.content?.[0]?.text ?? '').includes('always-succeed'))) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'OMC probe induced failure', code: 'OMC_PROBE_INDUCED' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'OMC-NATIVE-PROBE-OK' }
      yield { type: 'usage', usage: { ...USAGE } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  llm.registerAdapter([PROVIDER], new ProbeAdapter())

  // ── capture the durable events the host really persists ────────────────────
  const captured = new Map()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const list = captured.get(session.id) ?? []
    list.push({ type: event.type, seq: event.seq, at: event.at, data: event.data, parentSession: session.header?.parentSession ?? null })
    captured.set(session.id, list)
  }), 'omc-native-bridge-probe: session/event')

  let rejectNextTurnOf = null
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    if (rejectNextTurnOf && payload.agent?.id === rejectNextTurnOf && payload.turn === 1 && payload.step === 1) {
      rejectNextTurnOf = null
      facts.preSteps.push({ agent: payload.agent.id, turn: payload.turn, decision: 'reject' })
      return { kind: 'reject' }
    }
    return next()
  }, { global: true }), 'omc-native-bridge-probe: agent/pre-step')

  const agents = ctx.get('agents')
  const mk = async ({ parentAgent = undefined, parentSession = undefined, suffix }) => {
    const sessionId = `omc-native-probe-${suffix}-${randomUUID()}`
    const created = await agents.create({
      sessionId,
      ...(parentAgent ? { parentAgent } : {}),
      agentOptions: { provider: PROVIDER, model: MODEL },
      meta: { cwd: root, agentPreset: 'oh-my-coharness', ...(parentSession ? { parentSession } : {}) },
      setup: async () => {},
    })
    return created.agent
  }
  const followup = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

  const parent = await mk({ suffix: 'parent' })
  await parent.whenIdle()
  followup(parent, 'parent turn that fails once then retries')
  await parent.whenIdle()

  const child = await mk({ parentAgent: parent, parentSession: parent.session.id, suffix: 'child' })
  await child.whenIdle()
  followup(child, 'always-succeed child turn')
  await child.whenIdle()

  const nested = await mk({ parentAgent: child, parentSession: child.session.id, suffix: 'nested' })
  await nested.whenIdle()
  rejectNextTurnOf = nested.id
  followup(nested, 'nested turn rejected before any send')
  await nested.whenIdle()
  // A rejected step produces no request at all; drive one real turn so the
  // nested child has a durable event stream to attribute.
  followup(nested, 'always-succeed nested turn after the reject')
  await nested.whenIdle()

  facts.sessions = {
    parent: { id: parent.session.id, parentSession: parent.session.header?.parentSession ?? null, events: (captured.get(parent.session.id) ?? []).length },
    child: { id: child.session.id, parentSession: child.session.header?.parentSession ?? null, events: (captured.get(child.session.id) ?? []).length },
    nested: { id: nested.session.id, parentSession: nested.session.header?.parentSession ?? null, events: (captured.get(nested.session.id) ?? []).length },
  }

  // ── the bridge, on the real event stream ───────────────────────────────────
  const { createUsageLedger } = await packageImport('integration/usage-ledger.js')
  const { createExecutionStore } = await packageImport('integration/execution-events.js')
  const { createNativeRuntime, nativeTaskIdFor } = await packageImport('integration/native-runtime.js')
  const { roleIdFromLabel } = await packageImport('vendor/omd/npm-package/preset/roles.js')

  const ledger = createUsageLedger()
  const executionStore = createExecutionStore()
  const runtime = createNativeRuntime({ usageLedger: ledger, executionStore, roleFromDescriptor: (event) => roleIdFromLabel(event?.data?.label) })
  const PARENT_ID = 'probe-parent'
  runtime.bindRoot({ sessionId: parent.session.id, parentId: PARENT_ID })

  const replies = new Map()
  for (const [sessionId, events] of captured) {
    replies.set(sessionId, runtime.ingest({
      sessionId,
      parentSessionId: events.find((event) => event.parentSession)?.parentSession ?? null,
      events,
    }))
  }

  const entries = ledger.entries({ parentId: PARENT_ID })
  const summary = runtime.summary({ parentId: PARENT_ID })
  const diagnostics = runtime.diagnostics()

  // Replay the same durable logs: nothing may be billed twice.
  const before = ledger.entries({ parentId: PARENT_ID }).length
  for (const [sessionId, events] of captured) {
    runtime.ingest({ sessionId, parentSessionId: events.find((event) => event.parentSession)?.parentSession ?? null, events })
  }
  const after = ledger.entries({ parentId: PARENT_ID }).length

  // ── the mounted plugin instance ────────────────────────────────────────────
  const { scopeOf } = await hostImport('@deepseek-ai/dsh-scope')
  const tools = parent.ctx.get('tools')
  const coharness = tools.get('coharness', scopeOf(parent.ctx))
  assert.ok(coharness, 'the mounted preset must expose the coharness tool')
  const usageText = await coharness.execute({ action: 'usage' }, { agent: parent, signal: new AbortController().signal })
  const usage = JSON.parse(usageText.text)

  // ── phase 2: the per-request budget gate on real host events ───────────────
  // The gate module is installed against THIS host context with an explicit
  // cap, so the refusal point (`agent/request`) and the counting point
  // (`session/event`) are exercised with real payloads. The mounted plugin runs
  // with no configured cap here, so its own gate stays advisory.
  const { createRequestGate } = await packageImport('integration/request-gate.js')
  const gate = createRequestGate({ dir: join(root, '.ops', 'probe-budget', randomUUID()), usageLedger: ledger })
  const BUDGET_PARENT = 'probe-budget-parent'
  const budgetAgent = await mk({ suffix: 'budget' })
  await budgetAgent.whenIdle()
  runtime.bindRoot({ sessionId: budgetAgent.session.id, parentId: BUDGET_PARENT })
  const budgetTaskId = nativeTaskIdFor(budgetAgent.session.id)
  const budgetFacts = { dispatches: 0, refusals: 0, lastCode: null, settled: 0 }

  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    if (payload.agent?.id !== budgetAgent.id) return next()
    const modelRequestId = gate.nextRequestId({
      taskId: budgetTaskId, sessionId: budgetAgent.session.id, turn: payload.turn ?? 0, step: payload.step ?? 0,
    })
    const verdict = gate.reserve({
      parentId: BUDGET_PARENT, taskId: budgetTaskId, modelRequestId,
      limits: { maxCalls: 1 }, source: { sessionId: budgetAgent.session.id, turn: payload.turn, step: payload.step },
    })
    if (!verdict.allowed) {
      budgetFacts.refusals += 1
      budgetFacts.lastCode = verdict.code
      const failure = new Error(`${verdict.code}: ${verdict.reason}`)
      failure.code = verdict.code
      throw failure
    }
    return next()
  }, { global: true }), 'omc-probe: budget gate request')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (session.id !== budgetAgent.session.id) return
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const open = gate.inFlight(BUDGET_PARENT)[0]
    if (!open) return
    // This probe does not book the entry into the gate's own ledger, so the
    // truthful outcome is `unknown`: the send happened, its cost is unproven.
    const settled = gate.settle({
      parentId: BUDGET_PARENT, modelRequestId: open.modelRequestId, outcome: 'unknown',
      sourceEventId: `seq:${event.seq}`, note: 'probe: entry not booked into the gate ledger',
    })
    if (settled.settled) budgetFacts.settled += 1
  }), 'omc-probe: budget settle')

  followup(budgetAgent, 'always-succeed budget turn one')
  await budgetAgent.whenIdle()
  const dispatchesAfterFirst = facts.adapterCalls.filter((call) => call.sessionId === budgetAgent.session.id).length
  followup(budgetAgent, 'always-succeed budget turn two (must be refused)')
  await budgetAgent.whenIdle()
  const dispatchesAfterSecond = facts.adapterCalls.filter((call) => call.sessionId === budgetAgent.session.id).length
  budgetFacts.dispatches = dispatchesAfterSecond
  const budgetView = gate.budgetView({ parentId: BUDGET_PARENT, limits: { maxCalls: 1 } })
  const budgetCheckpoint = gate.checkpoint(BUDGET_PARENT)
  const budgetTurnEnds = (captured.get(budgetAgent.session.id) ?? [])
    .filter((event) => event.type === 'turn/end')
    .map((event) => event.data?.reason?.kind ?? null)

  const verdicts = {
    realLineagePersisted: {
      pass: facts.sessions.child.parentSession === parent.session.id && facts.sessions.nested.parentSession === child.session.id,
      detail: `child.parentSession=${facts.sessions.child.parentSession === parent.session.id}; nested.parentSession=${facts.sessions.nested.parentSession === child.session.id}`,
    },
    usageBookedFromRealEvents: {
      pass: entries.some((row) => row.usage.uncachedInputTokens === USAGE.inputTokens && row.route?.provider === PROVIDER),
      detail: `entries=${entries.length}; routes=${JSON.stringify([...new Set(entries.map((row) => `${row.route?.provider}/${row.route?.model}`))])}`,
    },
    failedAttemptStayedUnknown: {
      pass: entries.some((row) => row.usage.uncachedInputTokens === null && row.coverage === 'unknown'),
      detail: `unknown rows=${entries.filter((row) => row.coverage === 'unknown').length}`,
    },
    replayBookedNothingNew: { pass: after === before, detail: `before=${before}; after=${after}` },
    childrenAttributedToParent: {
      pass: summary.tasks.length === 3
        && summary.tasks.every((task) => task.binding?.parentId === PARENT_ID)
        && summary.tasks.some((task) => task.binding?.parentTaskId === nativeTaskIdFor(parent.session.id)),
      detail: `tasks=${summary.tasks.length}; parents=${JSON.stringify(summary.tasks.map((task) => task.binding?.parentId))}`,
    },
    parentRollupEqualsTasks: {
      pass: summary.entries === entries.length && summary.totals.sums.uncachedInputTokens === entries.reduce((sum, row) => sum + (row.usage.uncachedInputTokens ?? 0), 0),
      detail: `rollup entries=${summary.entries}; booked=${entries.length}`,
    },
    settlementRecordedPerTurn: {
      pass: summary.tasks.every((task) => {
        const view = executionStore.read(task.taskId)
        // Acceptance must never be filled in by execution settlement: a reopen
        // legitimately resets it to pending, and nothing may read as delivered.
        return view !== null && view.attempts.length >= 1 && view.acceptance.state !== 'passed' && view.delivered === false
      }),
      detail: `tasks with attempts=${summary.tasks.filter((task) => (executionStore.read(task.taskId)?.attempts.length ?? 0) > 0).length}/${summary.tasks.length}`,
    },
    mountedPluginBridgeInstalled: {
      pass: usage.diagnostics?.installed === true && (usage.diagnostics?.listeners?.length ?? 0) === 2,
      detail: `installed=${usage.diagnostics?.installed}; listeners=${usage.diagnostics?.listeners?.length}`,
    },
    mountedPluginBookedItsOwnPreset: {
      // Setup events can arrive before the host announces the agent; what must
      // never happen is an unbound *usage* event.
      pass: (usage.diagnostics?.stats?.autoRoots ?? 0) >= 1
        && (usage.diagnostics?.stats?.booked ?? 0) >= 1
        && (usage.diagnostics?.stats?.unboundUsage ?? 1) === 0,
      detail: `autoRoots=${usage.diagnostics?.stats?.autoRoots}; booked=${usage.diagnostics?.stats?.booked}; unboundUsage=${usage.diagnostics?.stats?.unboundUsage}; unboundSessions=${usage.diagnostics?.stats?.unboundSessions}`,
    },
    budgetGateBlocksNextRealRequest: {
      // The second turn must never reach the adapter: the gate refuses before
      // llm.stream, and the refusal leaves a persisted checkpoint.
      pass: dispatchesAfterFirst === 1
        && dispatchesAfterSecond === 1
        && budgetFacts.refusals >= 1
        && budgetFacts.lastCode === 'OMC/BUDGET-EXHAUSTED'
        && budgetCheckpoint?.action === 'stop-partial',
      detail: `dispatches after turn1=${dispatchesAfterFirst}, after turn2=${dispatchesAfterSecond}; refusals=${budgetFacts.refusals}; code=${budgetFacts.lastCode}; checkpoint=${budgetCheckpoint?.action ?? 'none'}`,
    },
    budgetGateKeepsUnknownSlotAndCounts: {
      // The probe settles this send as `unknown` on purpose (its entry is not in
      // the gate ledger): an unknown outcome keeps holding the slot instead of
      // being refunded on a guess.
      pass: budgetView.consumed === 1 && budgetView.unknownReservations === 1 && budgetFacts.settled === 1,
      detail: `consumed=${budgetView.consumed}; unknown=${budgetView.unknownReservations}; settled=${budgetFacts.settled}; turnEnds=${JSON.stringify(budgetTurnEnds)}`,
    },
  }

  const failed = Object.entries(verdicts).filter(([, verdict]) => !verdict.pass)
  const evidence = {
    schemaVersion: 1,
    kind: 'practice-native-runtime-probe',
    task: 'R01+R02',
    at: new Date().toISOString(),
    host: { version: facts.hostVersion, preset: 'oh-my-coharness', profile: profileContext.name },
    modelCalls: 0,
    adapterDispatches: facts.adapterCalls.length,
    facts: { ...facts, events: Object.fromEntries([...captured].map(([id, events]) => [id, events.map((event) => ({ type: event.type, seq: event.seq, usage: event.data?.usage ?? null, reason: event.data?.reason?.kind ?? null }))])) },
    bridge: {
      entries: entries.length,
      coverage: [...new Set(entries.map((row) => row.coverage))],
      summary: { entries: summary.entries, tasks: summary.tasks.length, totals: summary.totals },
      diagnostics: { sessions: diagnostics.sessions, bindings: diagnostics.bindings, stats: diagnostics.stats },
    },
    mountedPlugin: usage.diagnostics,
    budgetGate: {
      parent: BUDGET_PARENT,
      limit: { maxCalls: 1 },
      dispatchesAfterFirstTurn: dispatchesAfterFirst,
      dispatchesAfterSecondTurn: dispatchesAfterSecond,
      refusals: budgetFacts.refusals,
      lastCode: budgetFacts.lastCode,
      settlements: budgetFacts.settled,
      view: budgetView,
      checkpoint: budgetCheckpoint,
      turnEnds: budgetTurnEnds,
    },
    verdicts,
    limits: [
      'The adapter is synthetic: this probe proves event wiring, attribution and settlement, not token cost against a real bill.',
      'The cancelled (aborted) reason is covered by the unit regressions, not by this probe; the probe exercises completed, failed and blocked.',
      'Replay here reuses the events captured during the run, not a cold restart of a persisted session log.',
    ],
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)

  if (failed.length) {
    console.error('OMC_NATIVE_BRIDGE_FAILED', JSON.stringify(verdicts, null, 2))
    process.exitCode = 1
    return
  }
  console.log(`OMC_NATIVE_BRIDGE_PASS ${JSON.stringify({
    hostVersion: facts.hostVersion, entries: entries.length, tasks: summary.tasks.length,
    modelCalls: 0, evidence: outPath,
  })}`)
}

main()
  .catch((error) => {
    console.error('OMC_NATIVE_BRIDGE_FAILED', error?.stack ?? error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearTimeout(watchdog)
    try {
      if (ctx) await ctx.fiber.dispose()
    } catch {
      /* teardown noise must not mask the verdict */
    }
    process.exit(process.exitCode ?? 0)
  })
