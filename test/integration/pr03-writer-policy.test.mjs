/**
 * PR-03 (0.6 C04/C05/C06): writer lease, execution lifecycle and the final
 * permission/budget constraints.
 *
 * The graph lock already serialises one graph. The project writer lease is the
 * cross-graph/cross-process gate: one writer per workspace realpath. These tests
 * use a real second Node process to prove that, not a second Map in one test
 * process.
 *
 * The provider tests pin the other half:
 *   - a budget refusal happens before a CLI is spawned;
 *   - a project policy can only tighten the provider (timeout/mode), never be
 *     widened by request arguments;
 *   - the intent/launching/running/ended lifecycle is written before/around the
 *     spawn, and a launch failure after "launching" is unknown, not failed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGraphStore } from '../../integration/graph.js'
import { createWriterLease } from '../../integration/writer-lease.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createNativeRuntime, nativeTaskIdFor } from '../../integration/native-runtime.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createRequestGate } from '../../integration/request-gate.js'
import { resolveConfig } from '../../src/config.js'
import { harnessDef } from '../../src/harnesses.js'
import { makeProvider, providerConstraints } from '../../src/provider.js'
import { dispatchTasks } from '../../src/dispatch.js'

const CONTENDER_FLAG = '--pr03-contender'
const SELF = fileURLToPath(import.meta.url)
const BUNDLED_NODE = 'C:\\Users\\彭扬超\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe'
const NODE = process.env.OMC_TEST_NODE || (existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath)

function childEnv() {
  const path = `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`
  return { ...process.env, PATH: path }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/* ------------------------------------------------------------------ *
 * Contender mode: a real second process competing for the same project.
 * ------------------------------------------------------------------ */
if (process.argv.includes(CONTENDER_FLAG)) {
  const index = process.argv.indexOf(CONTENDER_FLAG)
  const [stateRoot, workspace, parentId, nodeId, flagDir] = process.argv.slice(index + 1)
  const leaseFor = (root) => createWriterLease({ stateRoot, workspaceRoot: root })
  const graph = createGraphStore({
    dir: join(stateRoot, 'graph'),
    writerLeaseFactory: leaseFor,
  })
  graph.plan(parentId, [{ id: nodeId, write: true, writeScope: ['src/'], acceptance: [] }])
  try {
    graph.claim(parentId, nodeId, { taskId: `${parentId}-task`, workspace, lineage: { source: 'host' } })
    writeFileSync(join(flagDir, `${parentId}.ok`), 'ok', 'utf8')
    const releaseFile = join(flagDir, 'release')
    for (let attempt = 0; attempt < 200 && !existsSync(releaseFile); attempt += 1) sleepSync(50)
    graph.release(parentId, nodeId, { reason: 'contender done', to: 'cancelled' })
    process.exit(0)
  } catch (error) {
    writeFileSync(join(flagDir, `${parentId}.err`), String(error?.code ?? error?.message ?? error), 'utf8')
    process.exit(0)
  }
}

function leaseFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr03-ws-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'omc-pr03-state-'))
  const factory = (root) => createWriterLease({ stateRoot, workspaceRoot: root })
  const graph = createGraphStore({ dir: join(stateRoot, 'graph'), writerLeaseFactory: factory })
  return { workspace, stateRoot, graph, factory }
}

function leaseStatus(workspace, stateRoot) {
  return createWriterLease({ stateRoot, workspaceRoot: workspace }).status()
}

test('PR-03: a write claim holds the project lease; a second graph in the same project is refused', async () => {
  const { workspace, stateRoot, graph, factory } = leaseFixture()
  try {
    graph.plan('parent-a', [{ id: 'a1', write: true, writeScope: ['src/'] }])
    graph.plan('parent-b', [{ id: 'b1', write: true, writeScope: ['src/'] }])
    graph.claim('parent-a', 'a1', { taskId: 'task-a', workspace, lineage: { source: 'host' } })
    const held = leaseStatus(workspace, stateRoot)
    assert.equal(held.state, 'held')
    assert.equal(held.owner, 'parent-a#a1')

    // A different graph/process in the same workspace cannot claim.
    const other = createGraphStore({ dir: join(stateRoot, 'graph'), writerLeaseFactory: factory })
    assert.throws(
      () => other.claim('parent-b', 'b1', { taskId: 'task-b', workspace, lineage: { source: 'host' } }),
      (error) => error.code === 'OMC/WRITER-BUSY',
    )
    // And that failed claim left no graph state behind.
    assert.equal(other.status('parent-b').nodes.find((node) => node.id === 'b1').state, 'pending')

    graph.release('parent-a', 'a1', { reason: 'done', to: 'cancelled' })
    assert.equal(leaseStatus(workspace, stateRoot).state, 'vacant')
    assert.doesNotThrow(() => other.claim('parent-b', 'b1', { taskId: 'task-b', workspace, lineage: { source: 'host' } }))
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('PR-03: a non-write node never takes the project lease', async () => {
  const { workspace, stateRoot, graph } = leaseFixture()
  try {
    graph.plan('p', [{ id: 'reader', write: false }])
    graph.claim('p', 'reader', { taskId: 'task-r', workspace, lineage: { source: 'host' } })
    assert.equal(leaseStatus(workspace, stateRoot).state, 'vacant')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('PR-03: complete, cancel and recover all release the lease', async () => {
  const { workspace, stateRoot, graph } = leaseFixture()
  try {
    graph.plan('p', [
      { id: 'done', write: true, writeScope: ['src/'] },
      { id: 'cancelled', write: true, writeScope: ['src/b/'] },
      { id: 'recovered', write: true, writeScope: ['src/c/'] },
    ])
    graph.claim('p', 'done', { taskId: 't1', workspace, lineage: { source: 'host' } })
    graph.complete('p', 'done', { status: 'completed', changedFiles: ['src/a.js'], taskId: 't1' })
    assert.equal(leaseStatus(workspace, stateRoot).state, 'vacant')

    graph.claim('p', 'cancelled', { taskId: 't2', workspace, lineage: { source: 'host' } })
    graph.cancel('p', 'cancelled', { reason: 'user stopped it' })
    assert.equal(leaseStatus(workspace, stateRoot).state, 'vacant')

    graph.claim('p', 'recovered', { taskId: 't3', workspace, lineage: { source: 'host' } })
    assert.equal(leaseStatus(workspace, stateRoot).state, 'held')
    graph.recover('p')
    assert.equal(leaseStatus(workspace, stateRoot).state, 'vacant')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('PR-03: a dead owner lease is taken over by the next claim', async () => {
  const { workspace, stateRoot } = leaseFixture()
  try {
    // A pid that has already exited.
    const dead = spawn(NODE, ['-e', ''], { stdio: 'ignore', env: childEnv() })
    const deadPid = dead.pid
    await new Promise((resolve, reject) => {
      dead.on('error', reject)
      dead.on('exit', resolve)
    })
    const stale = createWriterLease({ stateRoot, workspaceRoot: workspace, pid: deadPid })
    stale.acquire({ owner: 'old-writer#n1' })
    assert.equal(createWriterLease({ stateRoot, workspaceRoot: workspace }).status().state, 'stale')

    const graph = createGraphStore({
      dir: join(stateRoot, 'graph'),
      writerLeaseFactory: (root) => createWriterLease({ stateRoot, workspaceRoot: root }),
    })
    graph.plan('p', [{ id: 'n1', write: true, writeScope: ['src/'] }])
    assert.doesNotThrow(() => graph.claim('p', 'n1', { taskId: 't1', workspace, lineage: { source: 'host' } }))
    assert.equal(createWriterLease({ stateRoot, workspaceRoot: workspace }).status().owner, 'p#n1')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('PR-03: an expired foreign-host lease is taken over, a fresh one is not', async () => {
  const { workspace, stateRoot } = leaseFixture()
  try {
    const ttl = 45000
    const nowMs = Date.now()
    const oldClock = () => nowMs
    const old = createWriterLease({ stateRoot, workspaceRoot: workspace, host: 'another-host', ttlMs: ttl, heartbeatMs: 1000, now: oldClock })
    old.acquire({ owner: 'foreign#n1' })

    // Fresh heartbeat from the foreign host: no takeover.
    const freshGraph = createGraphStore({
      dir: join(stateRoot, 'graph'),
      writerLease: createWriterLease({
        stateRoot, workspaceRoot: workspace, host: 'this-host', ttlMs: ttl, heartbeatMs: 1000, now: () => nowMs + 1000,
      }),
    })
    freshGraph.plan('p', [{ id: 'n1', write: true, writeScope: ['src/'] }])
    assert.throws(
      () => freshGraph.claim('p', 'n1', { taskId: 't1', workspace, lineage: { source: 'host' } }),
      (error) => error.code === 'OMC/WRITER-BUSY',
    )

    // Heartbeat expired: the next claim takes the lease over.
    const expiredGraph = createGraphStore({
      dir: join(stateRoot, 'graph'),
      writerLease: createWriterLease({
        stateRoot, workspaceRoot: workspace, host: 'this-host', ttlMs: ttl, heartbeatMs: 1000, now: () => nowMs + ttl + 5000,
      }),
    })
    assert.doesNotThrow(() => expiredGraph.claim('p', 'n1', { taskId: 't1', workspace, lineage: { source: 'host' } }))
    assert.equal(expiredGraph.status('p').nodes.find((node) => node.id === 'n1').state, 'running')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('PR-03: two real processes compete for one workspace; exactly one writes', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr03-race-ws-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'omc-pr03-race-state-'))
  const flagDir = mkdtempSync(join(tmpdir(), 'omc-pr03-race-flags-'))
  const spawnContender = (parentId, nodeId) => spawn(NODE, [SELF, CONTENDER_FLAG, stateRoot, workspace, parentId, nodeId, flagDir], {
    cwd: dirname(SELF),
    stdio: 'ignore',
    env: childEnv(),
  })
  const children = []
  const exits = []
  try {
    const first = spawnContender('race-a', 'n1')
    const second = spawnContender('race-b', 'n1')
    children.push(first, second)
    exits.push(new Promise((resolve) => first.once('exit', resolve)))
    exits.push(new Promise((resolve) => second.once('exit', resolve)))

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const names = readdirSync(flagDir)
      if (names.some((name) => name === 'race-a.ok' || name === 'race-a.err')
        && names.some((name) => name === 'race-b.ok' || name === 'race-b.err')) break
      sleepSync(50)
    }
    const names = readdirSync(flagDir)
    const ok = names.filter((name) => name.endsWith('.ok'))
    const err = names.filter((name) => name.endsWith('.err'))
    assert.equal(ok.length, 1, `exactly one contender must hold the lease (saw ${names.join(', ') || 'no markers'})`)
    assert.equal(err.length, 1)
    assert.match(readFileSync(join(flagDir, err[0]), 'utf8'), /OMC\/WRITER-BUSY/)
  } finally {
    try { writeFileSync(join(flagDir, 'release'), 'go', 'utf8') } catch { /* best effort */ }
    // Even a failed assertion must not leave a contender holding the workspace.
    await Promise.race([
      Promise.all(exits),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    for (const child of children) {
      try { child.kill() } catch { /* already gone */ }
    }
    await rm(workspace, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
    await rm(flagDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * Provider lifecycle, project policy and budget boundary.
 * ------------------------------------------------------------------ */

function fakeProviderCtx({ stdout = 'ok\n', throws = false } = {}) {
  const specs = []
  const read = (text) => ({ readFrom: () => ({ text, lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      if (throws) throw new Error('spawn refused')
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  return {
    specs,
    ctx: {
      subprocess,
      get(name) { return name === 'subprocess' ? subprocess : undefined },
    },
  }
}

function simplePrompt() {
  return [{ type: 'text', text: 'Do the work.' }]
}

test('PR-03: provider start applies the project policy and cannot be widened by request arguments', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-policy-'))
  try {
    const cfg = resolveConfig({ transport: 'native', dispatch: { timeoutMs: 5000 } })
    const { ctx, specs } = fakeProviderCtx()
    const provider = makeProvider(ctx, harnessDef('codex'), cfg, { readOnly: true })
    const start = () => provider.start({
      prompt: simplePrompt(),
      cwd,
      timeoutMs: 999999,
      mode: 'read-only',
      constraints: { timeoutMs: 4000, mode: 'read-only' },
      signal: new AbortController().signal,
    })
    const run = await start()
    await run.result
    assert.equal(specs.length, 1)

    const limits = providerConstraints(cfg, harnessDef('codex'), {
      cwd, timeoutMs: 999999,
    })
    assert.equal(limits.timeoutMs, 5000, 'the configured ceiling wins over the larger request')
    const narrowed = providerConstraints(cfg, harnessDef('codex'), {
      cwd, timeoutMs: 999999, constraints: { timeoutMs: 4000 },
    })
    assert.equal(narrowed.timeoutMs, 4000, 'a materialized parent constraint only narrows further')
    // A project file may only lower it.
    const fs = await import('node:fs')
    fs.mkdirSync(join(cwd, '.omc'), { recursive: true })
    fs.writeFileSync(join(cwd, '.omc', 'project.json'), JSON.stringify({ dispatch: { timeoutMs: 1500 } }), 'utf8')
    const clamped = providerConstraints(cfg, harnessDef('codex'), {
      cwd, timeoutMs: 999999, constraints: { timeoutMs: 4000 },
    })
    assert.equal(clamped.timeoutMs, 1500)

    // A write mode is not a provider request.
    assert.throws(
      () => providerConstraints(cfg, harnessDef('codex'), { cwd, mode: 'in-place' }),
      (error) => error.code === 'OMC/PROVIDER-MODE',
    )
    await assert.rejects(
      () => provider.start({ prompt: simplePrompt(), cwd, mode: 'in-place', signal: new AbortController().signal }),
      (error) => error.code === 'OMC/PROVIDER-MODE',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: an unreadable project policy refuses a provider run before spawn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-badpolicy-'))
  try {
    const fs = await import('node:fs')
    fs.mkdirSync(join(cwd, '.omc'), { recursive: true })
    fs.writeFileSync(join(cwd, '.omc', 'project.json'), '{ not json', 'utf8')
    const { ctx, specs } = fakeProviderCtx()
    const provider = makeProvider(ctx, harnessDef('codex'), resolveConfig({ transport: 'native' }), { readOnly: true })
    await assert.rejects(
      () => provider.start({ prompt: simplePrompt(), cwd, signal: new AbortController().signal }),
      (error) => error.code === 'OMC/PROJECT-POLICY-UNREADABLE',
    )
    assert.equal(specs.length, 0)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: the budget refusal happens before the CLI is spawned', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-budget-'))
  try {
    const { ctx, specs } = fakeProviderCtx()
    const tasks = createTaskRegistry({})
    const executionStore = createExecutionStore({})
    const requestGate = {
      nextRequestId: () => 'req-1',
      reserve: () => ({ allowed: false, code: 'OMC/BUDGET-EXHAUSTED', reason: 'call budget exhausted' }),
      settle: () => ({ settled: true }),
    }
    const provider = makeProvider(ctx, harnessDef('codex'), resolveConfig({ transport: 'native' }), {
      readOnly: true, tasks, executionStore, requestGate,
    })
    await assert.rejects(
      () => provider.start({
        prompt: simplePrompt(), cwd,
        parent: { id: 'parent-1', session: { id: 's-1', header: {} } },
        signal: new AbortController().signal,
      }),
      (error) => error.code === 'OMC/BUDGET-EXHAUSTED',
    )
    assert.equal(specs.length, 0, 'no CLI spawn may happen after a budget refusal')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: provider lifecycle is intent → launching → running → ended', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-life-'))
  try {
    const tasks = createTaskRegistry({})
    const executionStore = createExecutionStore({})
    const { ctx } = fakeProviderCtx()
    const provider = makeProvider(ctx, harnessDef('codex'), resolveConfig({ transport: 'native' }), {
      readOnly: true, tasks, executionStore,
    })
    const run = await provider.start({
      prompt: simplePrompt(), cwd, signal: new AbortController().signal,
    })
    await run.result
    const attempt = executionStore.read(run.id)
    assert.ok(attempt)
    assert.equal(attempt.currentPhase, 'ended')
    const row = attempt.attempts[0]
    assert.ok(row.intent && row.intent.backend === 'external')
    assert.ok(row.intentAt && row.launchingAt && row.runningAt && row.endedAt)
    assert.ok(Date.parse(row.intentAt) <= Date.parse(row.launchingAt))
    assert.ok(Date.parse(row.launchingAt) <= Date.parse(row.runningAt))
    assert.equal(attempt.execution, 'completed')
    const task = tasks.list('parent-missing')
    assert.equal(task.length, 0, 'no fabricated parent when the caller has no parent id')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: a launch crash after "launching" is unknown, not failed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-crash-'))
  try {
    const tasks = createTaskRegistry({})
    const executionStore = createExecutionStore({})
    const { ctx } = fakeProviderCtx({ throws: true })
    const provider = makeProvider(ctx, harnessDef('codex'), resolveConfig({ transport: 'native' }), {
      readOnly: true, tasks, executionStore,
    })
    await assert.rejects(
      () => provider.start({
        prompt: simplePrompt(), cwd,
        parent: { id: 'parent-1', session: { id: 's-1', header: {} } },
        signal: new AbortController().signal,
      }),
    )
    const [row] = tasks.list('parent-1')
    assert.ok(row, 'the intent row was written before the launch')
    assert.equal(row.status, 'unknown')
    const attempt = executionStore.read(row.id)
    assert.equal(attempt.execution, 'unknown')
    assert.equal(attempt.currentPhase, 'unknown')
    assert.match(attempt.attempts[0].stopReason, /after launching|no terminal event/i)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: dispatch materializes constraints and passes them to the provider request', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-pr03-dispatch-'))
  try {
    const fs = await import('node:fs')
    fs.mkdirSync(join(cwd, '.omc'), { recursive: true })
    fs.writeFileSync(join(cwd, '.omc', 'project.json'), JSON.stringify({ dispatch: { timeoutMs: 2000 } }), 'utf8')
    const requests = []
    const rt = {
      ctx: {
        get(name) {
          if (name === 'subagents') {
            return {
              startActivation: async ({ request }) => {
                requests.push(request)
                return {
                  childId: 'child-1',
                  result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }], diagnostic: '' }),
                  dispose: async () => {},
                }
              },
            }
          }
          if (name === 'workingDirectory') return { ensure: async () => cwd }
          return undefined
        },
      },
      cfg: resolveConfig({ transport: 'native', dispatch: { timeoutMs: 9000 } }),
      registered: new Set(['codex']),
      async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } },
    }
    const result = await dispatchTasks(rt, {
      harness: 'codex', prompt: 'review', cwd, timeoutMs: 99000, mode: 'read-only',
    }, { agent: { id: 'parent-1', session: { id: 's-1', header: { cwd } } }, signal: new AbortController().signal })
    assert.equal(result.results[0].status, 'completed')
    assert.ok(requests[0].constraints, 'constraints were materialized')
    assert.equal(requests[0].constraints.project.exists, true)
    assert.equal(requests[0].constraints.timeoutMs, 2000)
    assert.equal(requests[0].timeoutMs, 2000)
    assert.equal(requests[0].mode, 'read-only')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('PR-03: budget evidence stays unknown when no usage was reported', async () => {
  const ledger = createUsageLedger({})
  const gate = createRequestGate({ usageLedger: ledger })
  const cfg = resolveConfig({ efficiency: { budget: { maxCalls: 1, enforce: true } } })
  const first = gate.reserve({ parentId: 'p', taskId: 't1', modelRequestId: 'r1', limits: { maxCalls: 1 }, source: {} })
  assert.equal(first.allowed, true)
  const second = gate.reserve({ parentId: 'p', taskId: 't1', modelRequestId: 'r2', limits: { maxCalls: 1 }, source: {} })
  assert.equal(second.allowed, false)
  assert.equal(second.code, 'OMC/BUDGET-EXHAUSTED')
  const view = gate.budgetView({ parentId: 'p', limits: { maxCalls: 1 } })
  assert.equal(view.usdSettled, null, 'unknown cost is never a fabricated zero')
  assert.equal(view.costKnown, false)
  assert.ok(cfg)
})

test('PR-03: an unrecognised native turn/end is unknown, never completed', async () => {
  const executionStore = createExecutionStore()
  const native = createNativeRuntime({ usageLedger: createUsageLedger(), executionStore })
  native.bindRoot({ sessionId: 's-root', parentId: 'p' })
  const session = { id: 's-root', header: {} }
  native.observe(session, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'm' } } } })
  native.observe(session, {
    type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } },
  })
  native.observe(session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'something-new' } } })
  const view = executionStore.read(nativeTaskIdFor('s-root'))
  assert.equal(view.execution, 'unknown')
  assert.equal(view.currentPhase, 'unknown')
  assert.notEqual(view.execution, 'completed')
})

test('PR-03: restart recovery marks work unknown and never dispatches anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-pr03-recover-'))
  try {
    const graph = createGraphStore()
    const executionStore = createExecutionStore({ dir })
    const managed = createManagedExecution({
      graph, mailbox: createMailbox({}), tasks: createTaskRegistry({}), executionStore,
    })
    graph.plan('p', [{ id: 'n1', write: false }], { rootTaskId: 'root' })
    graph.claim('p', 'n1', { taskId: 'task-1', lineage: { source: 'host' } })
    executionStore.open({ taskId: 'task-1', parentId: 'p', backend: 'native' })
    executionStore.launching('task-1', null, {})
    executionStore.running('task-1', null, {})

    const result = managed.recover('p', { isAlive: () => false })
    assert.deepEqual(result.graph.recovered, ['n1'])
    assert.equal(graph.status('p').nodes.find((node) => node.id === 'n1').state, 'pending')
    const view = executionStore.read('task-1')
    assert.equal(view.execution, 'unknown')
    assert.equal(view.currentPhase, 'unknown')
    assert.equal(view.attempts.length, 1, 'recovery never opens a new attempt or replays the work')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('PR-03: a schemaVersion 1 execution record stays readable and normalises its lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-pr03-v1-'))
  try {
    fsWriteV1Execution(join(dir, 'task-old.json'))
    const store = createExecutionStore({ dir })
    const view = store.read('task-old')
    assert.ok(view)
    assert.equal(view.execution, 'failed')
    assert.equal(view.currentPhase, 'ended')
    assert.deepEqual(view.acceptance.history ?? [], [], 'compat records get empty verdict history, never a fabricated verdict')
    // Normalisation is written back as v2 on the next mutation.
    store.acceptance('task-old', { state: 'unknown', evidence: ['compat'] })
    const raw = JSON.parse(readFileSync(join(dir, 'task-old.json'), 'utf8'))
    assert.equal(raw.schemaVersion, 2)
    assert.ok(Array.isArray(raw.verdicts))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function fsWriteV1Execution(file) {
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    taskId: 'task-old',
    parentId: 'p',
    attemptCount: 1,
    attempts: [{
      attemptId: 'task-old#a1',
      index: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      openedBy: 'legacy',
      backend: 'native',
      route: null,
      execution: 'failed',
      stopReason: 'legacy failure',
      settledAt: '2026-01-01T00:00:01.000Z',
      settledBy: 'legacy',
      cancelRequested: false,
      cancelNote: null,
      conflicts: [],
    }],
    acceptance: { state: 'unknown', attemptId: null, evidence: null, decidedAt: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }), 'utf8')
}

