/**
 * PR-05 (0.7): the three executable chains share one Graph/Ledger/Acceptance
 * authority.
 *
 *   Native:   Explorer → Fixer → Verify
 *   Mixed:    External Oracle → Native Fixer → Verify
 *   Council:  Seats → native Synthesizer → Decision (explicit managed entry)
 *
 * The prompt-only Council Mode is NOT intercepted by the host; it stays
 * unmanaged unless these explicit nodes are bound. A failed seat never becomes
 * consensus: the synthesizer depends on every seat completing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createNativeRuntime, nativeTaskIdFor } from '../../integration/native-runtime.js'
import { createNativeManaged } from '../../integration/native-managed.js'
import { createAcceptanceAuthority } from '../../integration/acceptance-verdict.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { createArtifactStore } from '../../integration/artifact-store.js'
import { treeFingerprint } from '../../integration/work-packet.js'
import { resolveConfig } from '../../src/config.js'
import { harnessDef } from '../../src/harnesses.js'
import { makeProvider } from '../../src/provider.js'
import { apply } from '../../src/index.js'

const PARENT = 'parent-pr05'

function specFor(id) {
  return {
    taskId: id,
    split: 'development',
    commands: [{ name: 'ok', run: ['node', '-e', '0'], expect: { exitCode: 0 } }],
    acceptanceFiles: [],
    forbidChanges: [],
  }
}

function fakeJudge({ fingerprint = 'tree-state', passed = true } = {}) {
  return {
    async baseline() {
      return { fingerprint, acceptanceDigest: 'acc-state', files: {}, acceptanceFiles: {}, at: new Date().toISOString() }
    },
    async run() {
      return {
        passed,
        fingerprint,
        acceptanceDigest: 'acc-state',
        checks: [{ name: 'ok', passed }],
        problems: passed ? [] : ['the fixed check failed'],
        reason: passed ? null : 'OMC/ACCEPTANCE-CHECK: the fixed check failed',
        at: new Date().toISOString(),
      }
    },
    verifyDelivered() { return { passed: true, problems: [] } },
  }
}

function stores() {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const usageLedger = createUsageLedger({})
  const native = createNativeRuntime({ usageLedger, executionStore })
  const acceptance = createAcceptanceAuthority({ executionStore })
  graph.setAcceptance(acceptance)
  const managed = createNativeManaged({ graph, native, executionStore, acceptance })
  return { graph, executionStore, usageLedger, native, acceptance, managed }
}

async function nativeRun(fixture, {
  nodeId, sessionId, role, spec, runner, changedFiles = null, failed = false, usage = true,
}) {
  const bound = fixture.managed.bind({
    parentId: PARENT, nodeId, sessionId, role, acceptanceSpec: spec, runner,
  })
  if (bound.acceptanceReady) await bound.acceptanceReady
  assert.ok(bound.taskId)
  const session = { id: sessionId, header: { parentSession: 's-root' } }
  fixture.native.observe(session, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'm' } } } })
  if (usage) {
    fixture.native.observe(session, {
      type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 2 } },
    })
  }
  fixture.native.observe(session, {
    type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: failed ? 'blocked' : 'completed' } },
  })
  return fixture.managed.settle({
    parentId: PARENT, nodeId, runner, changedFiles,
    attemptId: fixture.executionStore.read(bound.taskId)?.currentAttemptId,
  })
}

test('PR-05 Native chain: Explorer → Fixer → Verify share graph, ledger and verdicts', async () => {
  const fixture = stores()
  const runner = fakeJudge()
  fixture.graph.plan(PARENT, [
    { id: 'explore', roleId: 'explorer', acceptance: ['files located'], acceptanceSpec: specFor('explore') },
    { id: 'fix', roleId: 'fixer', deps: ['explore'], write: true, writeScope: ['src/'], acceptance: ['fix applied'], acceptanceSpec: specFor('fix') },
    { id: 'verify', roleId: 'oracle', deps: ['fix'], acceptance: ['no regression'], acceptanceSpec: specFor('verify') },
  ], { rootTaskId: nativeTaskIdFor('s-root'), lineage: { source: 'host' } })

  const explore = await nativeRun(fixture, { nodeId: 'explore', sessionId: 's-explore', role: 'explorer', spec: specFor('explore'), runner })
  assert.equal(explore.acceptance, 'passed')
  const fix = await nativeRun(fixture, {
    nodeId: 'fix', sessionId: 's-fix', role: 'fixer', spec: specFor('fix'), runner, changedFiles: ['src/a.js'],
  })
  assert.equal(fix.acceptance, 'passed')
  const verify = await nativeRun(fixture, { nodeId: 'verify', sessionId: 's-verify', role: 'oracle', spec: specFor('verify'), runner })
  assert.equal(verify.acceptance, 'passed')

  const status = fixture.graph.status(PARENT)
  assert.deepEqual(status.nodes.map((node) => node.state), ['completed', 'completed', 'completed'])
  assert.ok(status.nodes.every((node) => node.acceptanceState === 'passed' && node.acceptanceVerdict))
  const attempts = status.nodes.map((node) => fixture.executionStore.read(node.taskId).attempts[0])
  assert.ok(attempts.every((attempt) => attempt.backend === 'native'))
  assert.ok(fixture.usageLedger.entries({ parentId: PARENT }).length >= 3, 'native events are booked under the root parent')
})

test('PR-05 Mixed chain: external Oracle feeds a native Fixer through the same authority', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr05-mixed-'))
  const fixture = stores()
  // Root native binding: the external provider must attribute to the same shard.
  fixture.native.resolveCallingSession({ sessionId: 's-root', header: {}, agentId: PARENT })
  const runner = fakeJudge({ fingerprint: treeFingerprint(cwd).digest })
  const artifactStore = createArtifactStore({})
  const taskStore = createTaskRegistry({})
  const managed = createManagedExecution({
    graph: fixture.graph, mailbox: createMailbox({}), tasks: taskStore,
    executionStore: fixture.executionStore, usageLedger: fixture.usageLedger,
    acceptance: fixture.acceptance, artifactStore,
  })
  fixture.graph.plan(PARENT, [
    { id: 'oracle', roleId: 'oracle', acceptance: ['review delivered'], acceptanceSpec: specFor('oracle') },
    { id: 'fix', roleId: 'fixer', deps: ['oracle'], write: true, writeScope: ['src/'], acceptance: ['fix applied'], acceptanceSpec: specFor('fix') },
    { id: 'verify', roleId: 'oracle', deps: ['fix'], acceptance: ['no regression'], acceptanceSpec: specFor('verify') },
  ], { rootTaskId: nativeTaskIdFor('s-root'), lineage: { source: 'host' } })

  // A real provider run through a fake CLI: this is the external ledger entry.
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn() {
      const stdout = [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-oracle' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'review complete' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 3 } }),
      ].join('\n')
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    },
  }
  const cfg = resolveConfig({ transport: 'native' })
  const provider = makeProvider({ subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined) }, harnessDef('codex'), cfg, {
    readOnly: true, tasks: taskStore, usageLedger: fixture.usageLedger, executionStore: fixture.executionStore, native: fixture.native,
  })
  const ctx = {
    subprocess,
    get(name) {
      if (name === 'subprocess') return subprocess
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
  const rt = {
    ctx,
    cfg,
    native: fixture.native,
    registered: new Set(['codex']),
    async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } },
  }
  const exec = {
    agent: { id: PARENT, session: { id: 's-root', header: { cwd } } },
    signal: new AbortController().signal,
  }
  const external = await managed.dispatch(rt, {
    harness: 'codex', prompt: 'review the fix', nodeId: 'oracle',
    acceptanceSpec: specFor('oracle'), acceptanceRunner: runner, cwd,
  }, exec)
  assert.equal(external.results[0].status, 'completed')
  assert.equal(external.results[0].packetCoverage, 'managed')
  assert.ok(external.results[0].packet, 'the managed dispatch built a WorkPacket')
  assert.equal(fixture.graph.status(PARENT).nodes.find((node) => node.id === 'oracle').state, 'completed', JSON.stringify(external.attempt))

  // The native tier continues on the same graph and the same acceptance store.
  const fix = await nativeRun(fixture, {
    nodeId: 'fix', sessionId: 's-fix', role: 'fixer', spec: specFor('fix'), runner, changedFiles: ['src/a.js'],
  })
  assert.equal(fix.acceptance, 'passed')
  const verify = await nativeRun(fixture, { nodeId: 'verify', sessionId: 's-verify', role: 'oracle', spec: specFor('verify'), runner })
  assert.equal(verify.acceptance, 'passed')

  const status = fixture.graph.status(PARENT)
  assert.ok(status.nodes.every((node) => node.state === 'completed'))
  const oracleAttempt = fixture.executionStore.read(status.nodes.find((node) => node.id === 'oracle').taskId).attempts[0]
  const fixAttempt = fixture.executionStore.read(status.nodes.find((node) => node.id === 'fix').taskId).attempts[0]
  assert.equal(oracleAttempt.backend, 'external')
  assert.equal(fixAttempt.backend, 'native')
  assert.ok(fixture.usageLedger.entries({ parentId: PARENT }).length >= 2, 'external and native work share one ledger parent')
})

/* ── WorkPacket production injection ─────────────────────────────────────── */

function directCtx() {
  const specs = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      return {
        collected: { stdout: read('ok\n'), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    },
  }
  return { specs, ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined), effect: (fn) => fn() } }
}

async function packetDispatch({ cwd, packetFacts, packetMaxChars }) {
  const fixture = stores()
  const artifactStore = createArtifactStore({})
  const managed = createManagedExecution({
    graph: fixture.graph, mailbox: createMailbox({}), tasks: createTaskRegistry({}),
    executionStore: fixture.executionStore, usageLedger: fixture.usageLedger,
    acceptance: fixture.acceptance, artifactStore,
  })
  fixture.graph.plan(PARENT, [
    { id: 'n1', roleId: 'explorer', acceptance: ['packet test'], acceptanceSpec: specFor('packet-node') },
  ], { rootTaskId: nativeTaskIdFor('s-root'), lineage: { source: 'host' } })
  const runner = fakeJudge({ fingerprint: treeFingerprint(cwd).digest })
  const { ctx, specs } = directCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct' }), registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const run = () => managed.dispatch(rt, {
    harness: 'codex', prompt: 'do the packet task', nodeId: 'n1', cwd,
    acceptanceSpec: specFor('packet-node'), acceptanceRunner: runner,
    packetFacts, packetMaxChars,
  }, { agent: { id: PARENT }, signal: new AbortController().signal })
  return { fixture, run, specs }
}

test('PR-05 WorkPacket: managed dispatch fits and injects the packet, externalizing overflow', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr05-packet-'))
  const facts = Array.from({ length: 24 }, (_, index) => ({
    statement: `fact ${index} ${'x'.repeat(240)}`,
    sourceRef: 'src/work-packet.js',
    sourceDigest: `digest-${index}`,
    observedAt: '2026-11-04T00:00:00.000Z',
  }))
  const { fixture, run, specs } = await packetDispatch({ cwd, packetFacts: facts, packetMaxChars: 1400 })
  const result = await run()
  assert.equal(result.results[0].status, 'completed')
  assert.equal(result.results[0].packetCoverage, 'managed')
  const packet = result.results[0].packet
  assert.ok(packet && packet.treeDigest)
  assert.ok(packet.externalized.length >= 1, 'over-limit facts were externalized into artifacts')
  assert.equal(packet.acceptanceCount, 1)
  assert.equal(packet.lineage.rootTaskId, nativeTaskIdFor('s-root'))
  assert.equal(result.attempt.packet.digest, packet.digest, 'the attempt records the same packet identity')
  const prompt = specs[0].argv.at(-1)
  assert.match(prompt, /WorkPacket/)
  assert.match(prompt, /Acceptance:/)
  assert.match(prompt, /Constraints:/)
  const node = fixture.graph.status(PARENT).nodes.find((row) => row.id === 'n1')
  assert.equal(node.state, 'completed')
  assert.equal(node.acceptanceState, 'passed')
  assert.deepEqual(node.acceptance, ['packet test'], 'externalization never drops the node acceptance')
})

test('PR-05 WorkPacket: a malformed packet is refused before spawn and releases the claim', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr05-packet-bad-'))
  const { fixture, run, specs } = await packetDispatch({
    cwd,
    packetFacts: [{ statement: 'no provenance' }],
    packetMaxChars: 24000,
  })
  await assert.rejects(run(), (error) => error.code === 'OMC/PACKET-INVALID')
  assert.equal(specs.length, 0, 'the CLI must not be spawned for an invalid packet')
  assert.equal(fixture.graph.status(PARENT).nodes.find((row) => row.id === 'n1').state, 'ready')
})

/* ── Council: explicit managed entry ─────────────────────────────────────── */

function councilFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr05-council-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'omc-pr05-council-state-'))
  const tools = new Map()
  const handlers = {}
  const providers = new Map()
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn() {
      return {
        collected: { stdout: read('ok\n'), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subprocess,
    on(event, handler) { (handlers[event] ??= []).push(handler); return () => {} },
    effect(fn) { return fn() },
    inject(_deps, fn) { fn(ctx) },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      if (name === 'subagents') return { list: () => [...providers.keys()], registerProvider(p) { providers.set(p.name, p); return () => providers.delete(p.name) } }
      return undefined
    },
  }
  apply(ctx, {
    transport: 'native',
    stateDir,
    sessions: { path: join(stateDir, 'sessions.json') },
    harnesses: Object.fromEntries(['codex', 'claude', 'glm', 'gemini', 'antigravity', 'kimi', 'opencode', 'qwen'].map((id) => [id, { enabled: false }])),
  })
  return { workspace, stateDir, tools, handlers }
}

function councilExec(workspace, id = 'agent-root') {
  return { agent: { id, session: { id: `s-${id}`, header: { cwd: workspace } } }, signal: new AbortController().signal }
}

function emit(handlers, session, event) {
  for (const handler of handlers['session/event'] ?? []) handler(session, event)
}

function driveNativeTurn(handlers, sessionId, { failed = false, usage = true, root = 's-agent-root' } = {}) {
  const session = { id: sessionId, header: { parentSession: root } }
  emit(handlers, session, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'm' } } } })
  if (usage) {
    emit(handlers, session, {
      type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 2 } },
    })
  }
  emit(handlers, session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: failed ? 'blocked' : 'completed' } } })
}

test('PR-05 Council: each seat and the native synthesizer enter graph/ledger/acceptance', async () => {
  const { workspace, stateDir, tools, handlers } = councilFixture()
  const control = tools.get('coharness')
  const exec = councilExec(workspace)
  const planned = JSON.parse((await control.execute({
    action: 'council',
    council_action: 'plan',
    council_seats: [
      { id: 'seat-a', role: 'councillor-alpha', acceptance: ['seat a replied'] },
      { id: 'seat-b', role: 'councillor-beta', acceptance: ['seat b replied'] },
    ],
    synthesis_node_id: 'decision',
  }, exec)).text)
  assert.deepEqual(planned.graph.nodes.decision.deps, ['seat-a', 'seat-b'])

  for (const [node, session, role, taskId] of [
    ['seat-a', 's-seat-a', 'councillor-alpha', 'seat-a'],
    ['seat-b', 's-seat-b', 'councillor-beta', 'seat-b'],
  ]) {
    const rawBound = (await control.execute({
      action: 'council', council_action: 'seat', node_id: node,
      child_session_id: session, role_id: role, acceptance_spec: specFor(taskId),
    }, exec)).text
    assert.ok(rawBound.trimStart().startsWith('{'), rawBound)
    const bound = JSON.parse(rawBound)
    assert.equal(bound.managed, true)
    assert.ok(bound.baseline, `seat bind did not freeze a baseline: ${JSON.stringify(bound)}`)
    driveNativeTurn(handlers, session)
    const rawSettled = (await control.execute({
      action: 'council', council_action: 'settle', node_id: node, acceptance_spec: specFor(taskId),
    }, exec)).text
    assert.ok(rawSettled.trimStart().startsWith('{'), rawSettled)
    const settled = JSON.parse(rawSettled)
    assert.equal(settled.delivered, true, JSON.stringify(settled))
    assert.equal(settled.acceptance, 'passed')
  }

  // The synthesizer must stay native: a write role may not front the council.
  const wrongSynth = await control.execute({
    action: 'council', council_action: 'synthesize', node_id: 'decision',
    child_session_id: 's-synth', role_id: 'fixer', acceptance_spec: specFor('decision'),
  }, exec)
  assert.match(wrongSynth.text, /COUNCIL-SYNTH-NATIVE/)

  const synth = JSON.parse((await control.execute({
    action: 'council', council_action: 'synthesize', node_id: 'decision',
    child_session_id: 's-synth', role_id: 'council', acceptance_spec: specFor('decision'),
  }, exec)).text)
  assert.equal(synth.managed, true)
  driveNativeTurn(handlers, 's-synth')
  const decision = JSON.parse((await control.execute({
    action: 'council', council_action: 'settle', node_id: 'decision', acceptance_spec: specFor('decision'),
  }, exec)).text)
  assert.equal(decision.delivered, true)

  const status = JSON.parse((await control.execute({ action: 'council', council_action: 'status' }, exec)).text)
  assert.ok(status.graph.nodes.every((node) => node.state === 'completed'))
  assert.ok(status.graph.nodes.every((node) => node.acceptanceState === 'passed'))
  assert.match(status.note, /prompt-only/i)
  assert.ok(Object.keys(status.graph.claims).length >= 3)
  const durableLedger = createUsageLedger({ dir: join(stateDir, 'usage') })
  const ledgerRows = durableLedger.entries({ parentId: 'agent-root' })
  assert.ok(ledgerRows.length >= 3, `each seat and the synthesizer must book its own ledger entry (got ${ledgerRows.length})`)
  assert.ok(ledgerRows.every((row) => row.backend === 'native'))
})

test('PR-05 Council: a failed seat blocks the synthesizer instead of becoming consensus', async () => {
  const { workspace, tools, handlers } = councilFixture()
  const control = tools.get('coharness')
  const exec = councilExec(workspace)
  await control.execute({
    action: 'council', council_action: 'plan',
    council_seats: [
      { id: 'seat-a', role: 'councillor-alpha', acceptance: ['seat a replied'] },
      { id: 'seat-b', role: 'councillor-beta', acceptance: ['seat b replied'] },
    ],
    synthesis_node_id: 'decision',
  }, exec)

  await control.execute({
    action: 'council', council_action: 'seat', node_id: 'seat-a',
    child_session_id: 's-seat-a', role_id: 'councillor-alpha', acceptance_spec: specFor('seat-a'),
  }, exec)
  driveNativeTurn(handlers, 's-seat-a')
  await control.execute({ action: 'council', council_action: 'settle', node_id: 'seat-a', acceptance_spec: specFor('seat-a') }, exec)

  await control.execute({
    action: 'council', council_action: 'seat', node_id: 'seat-b',
    child_session_id: 's-seat-b', role_id: 'councillor-beta', acceptance_spec: specFor('seat-b'),
  }, exec)
  driveNativeTurn(handlers, 's-seat-b', { failed: true })
  const failed = JSON.parse((await control.execute({
    action: 'council', council_action: 'settle', node_id: 'seat-b', acceptance_spec: specFor('seat-b'),
  }, exec)).text)
  assert.equal(failed.delivered, false)
  assert.equal(failed.execution, 'failed')

  const synth = await control.execute({
    action: 'council', council_action: 'synthesize', node_id: 'decision',
    child_session_id: 's-synth', role_id: 'council', acceptance_spec: specFor('decision'),
  }, exec)
  assert.match(synth.text, /GRAPH-DEPENDENCY|failed|waits for/)
  const status = JSON.parse((await control.execute({ action: 'council', council_action: 'status' }, exec)).text)
  const decisionNode = status.graph.nodes.find((node) => node.id === 'decision')
  assert.equal(decisionNode.state, 'pending', 'a failed seat must not be wrapped as consensus')
  assert.equal(status.graph.nodes.find((node) => node.id === 'seat-b').state, 'failed')
})
