/**
 * WP05 regressions (0.5.0-alpha.2): managed execution, claim lifecycle and
 * mailbox injection — A13–A16.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createGraphStore } from '../../integration/graph.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { resolveConfig } from '../../src/config.js'

function fakeCtx({ stdout = 'ok\n' } = {}) {
  const specs = []
  const subprocess = {
    async resolveExecutable(bin) { return bin.includes('\\') ? bin : `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      const read = (text) => ({ readFrom: () => ({ text, lossy: false }) })
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  return { specs, ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined), effect: (cb) => cb() } }
}

function stores() {
  const graph = createGraphStore({})
  const mailbox = createMailbox({})
  const executionStore = createExecutionStore({})
  const tasks = createTaskRegistry({})
  return { graph, mailbox, executionStore, tasks, managed: createManagedExecution({ graph, mailbox, executionStore, tasks }) }
}

function planWrite(id, { deps = [], scope = ['src/'] } = {}) {
  return { id, title: id, deps, write: true, writeScope: scope, acceptance: ['tests pass'] }
}

// ── A13: claim lifecycle, idempotent settlement, crash recovery ─────────────

test('A13: a claim released before settlement is claimable again', () => {
  const { graph } = stores()
  graph.plan('p', [planWrite('n1')])
  graph.claim('p', 'n1')
  // Activation failure → release to ready.
  const released = graph.release('p', 'n1', { reason: 'adapter died before spawn' })
  assert.equal(released.node.state, 'ready')
  assert.match(released.node.note, /adapter died/)
  // The node can be claimed again by the retry.
  const again = graph.claim('p', 'n1')
  assert.equal(again.node.state, 'running')
  assert.equal(graph.status('p').writes.length, 1)
})

test('A13: duplicate completion is idempotent; a contradictory one is refused', () => {
  const { graph } = stores()
  graph.plan('p', [planWrite('n1')])
  graph.claim('p', 'n1')
  const first = graph.complete('p', 'n1', { status: 'failed' })
  assert.equal(first.node.state, 'failed')
  const duplicate = graph.complete('p', 'n1', { status: 'failed' })
  assert.equal(duplicate.duplicate, true)
  assert.throws(
    () => graph.complete('p', 'n1', { status: 'completed' }),
    (error) => error.code === 'OMC/GRAPH-CONFLICT',
  )
})

test('A13: recovery frees dead running nodes and leaves live workers alone', () => {
  const { graph } = stores()
  graph.plan('p', [planWrite('n1'), planWrite('n2', { scope: ['docs/'] })])
  graph.claim('p', 'n1', { childId: 'child-live' })
  graph.claim('p', 'n2', { childId: 'child-dead' })
  const result = graph.recover('p', { isAlive: ({ claim }) => claim.childId === 'child-live' })
  assert.deepEqual(result.recovered.sort(), ['n2'])
  assert.equal(graph.status('p').nodes.find((n) => n.id === 'n1').state, 'running')
  assert.equal(graph.status('p').nodes.find((n) => n.id === 'n2').state, 'pending')
  // The freed, non-overlapping writer slot is claimable again; an overlapping
  // scope still is not, because the live writer keeps its claim.
  graph.claim('p', 'n2')
  assert.equal(graph.status('p').writes.includes('n2'), true)
  graph.plan('p', [planWrite('n3', { scope: ['src/other/'] })])
  assert.throws(() => graph.claim('p', 'n3'), (error) => error.code === 'OMC/GRAPH-WRITE-CONFLICT')
})

// ── A14: single writer per overlapping scope; managed coverage labels ───────

test('A14: a second overlapping writer is refused while the first runs', () => {
  const { graph } = stores()
  graph.plan('p', [planWrite('w1'), planWrite('w2', { scope: ['src/graph.js'] })])
  graph.claim('p', 'w1')
  assert.throws(
    () => graph.claim('p', 'w2'),
    (error) => error.code === 'OMC/GRAPH-WRITE-CONFLICT',
  )
  // Non-overlapping readers/workers may proceed.
  graph.plan('p', [{ id: 'r1', title: 'read', deps: [], write: false, writeScope: [], acceptance: [] }])
  assert.doesNotThrow(() => graph.claim('p', 'r1'))
})

test('A14: a managed dispatch labels its result and settles the node', async () => {
  const s = stores()
  s.graph.plan('p', [{ id: 'n1', title: 'audit', deps: [], write: false, writeScope: [], acceptance: [] }])
  const { ctx, specs } = fakeCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct' }), registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const result = await s.managed.dispatch(rt, {
    harness: 'codex', prompt: 'read-only audit', nodeId: 'n1',
  }, { agent: { id: 'p' }, signal: new AbortController().signal })
  assert.equal(specs.length, 1)
  assert.equal(result.results[0].managed, true)
  assert.equal(result.results[0].nodeId, 'n1')
  assert.equal(result.results[0].status, 'completed')
  assert.equal(s.graph.status('p').nodes.find((n) => n.id === 'n1').state, 'completed')
  assert.equal(result.attempt.execution, 'completed')
})

test('A14: activation failure inside a managed dispatch releases the claim', async () => {
  const s = stores()
  s.graph.plan('p', [{ id: 'n1', title: 'work', deps: [], write: false, writeScope: [], acceptance: [] }])
  const { ctx } = fakeCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct' }), registered: new Set(), async detect() { return { rows: [] } } }
  // An invalid request (empty prompt) throws INSIDE dispatchTasks after the
  // claim: the managed wrapper must release the node instead of wedging it.
  await assert.rejects(
    s.managed.dispatch(rt, { harness: 'codex', prompt: '', nodeId: 'n1' }, { agent: { id: 'p' }, signal: new AbortController().signal }),
    (error) => error.code === 'OMC/EMPTY-TASK',
  )
  const node = s.graph.status('p').nodes.find((n) => n.id === 'n1')
  assert.equal(node.state, 'ready', 'the failed activation released the node for a retry')
  const attempt = s.executionStore.read('node-n1')
  assert.equal(attempt.execution, 'failed')
})

// ── A15: injection/consumption idempotence ──────────────────────────────────

test('A15: messages inject once per attempt and consume only after durable injection', () => {
  const { mailbox } = stores()
  mailbox.send({ parentId: 'p', from: 'orchestrator', to: 'lane-oracle', text: 're-check the retry path', taskId: 'task-1', lane: 'lane-oracle', kind: 'task' })
  mailbox.send({ parentId: 'p', from: 'orchestrator', to: 'lane-oracle', text: 'also see #32', taskId: 'task-1', lane: 'lane-oracle', kind: 'note' })

  const pending = mailbox.pendingInjections('p', { taskId: 'task-1' })
  assert.equal(pending.length, 2)
  assert.deepEqual(pending.map((m) => m.id).sort(), ['msg-000001', 'msg-000002'])

  const a1 = mailbox.recordInjection('p', 'msg-000001', { attemptId: 'task-1#a1' })
  assert.equal(a1.duplicate, false)
  const a1again = mailbox.recordInjection('p', 'msg-000001', { attemptId: 'task-1#a1' })
  assert.equal(a1again.duplicate, true, 'a crash-retry re-records the same key harmlessly')

  // Consumption without a recorded injection for THIS attempt is refused.
  assert.throws(
    () => mailbox.confirmConsumed('p', 'msg-000001', { attemptId: 'task-1#a2' }),
    (error) => error.code === 'OMC/MAILBOX-NOT-INJECTED',
  )
  const consumed = mailbox.confirmConsumed('p', 'msg-000001', { attemptId: 'task-1#a1' })
  assert.equal(consumed.duplicate, false)
  const consumedAgain = mailbox.confirmConsumed('p', 'msg-000001', { attemptId: 'task-1#a1' })
  assert.equal(consumedAgain.duplicate, true)

  // The consumed message no longer awaits injection; the other still does.
  assert.deepEqual(mailbox.pendingInjections('p', { taskId: 'task-1' }).map((m) => m.id), ['msg-000002'])
  const stats = mailbox.stats('p')
  assert.equal(stats.consumed, 1)
  assert.equal(stats.queued, 1)
})

test('A15: a managed dispatch injects pending messages and consumes them on settlement', async () => {
  const s = stores()
  s.graph.plan('p', [{ id: 'n1', title: 'audit', deps: [], write: false, writeScope: [], acceptance: [] }])
  s.mailbox.send({ parentId: 'p', from: 'orchestrator', to: 'p', text: 'focus on the retry branch', taskId: 'node-n1', kind: 'task' })
  const { ctx, specs } = fakeCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct' }), registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const result = await s.managed.dispatch(rt, { harness: 'codex', prompt: 'audit', nodeId: 'n1' }, { agent: { id: 'p' }, signal: new AbortController().signal })
  // The injected text reached the CLI prompt.
  const prompt = specs[0].argv.at(-1)
  assert.match(prompt, /focus on the retry branch/)
  assert.match(prompt, /msg-000001/)
  // And it was consumed after the durable settlement.
  assert.equal(s.mailbox.stats('p').consumed, 1)
  assert.equal(result.results[0].managed, true)
})

// ── A16: explicit re-execution re-validates and never inherits evidence ─────

test('A16: re-execution refuses when the world changed, and never inherits acceptance', async () => {
  const s = stores()
  s.tasks.start({ id: 'child-1', parentId: 'p', harness: 'codex', label: 'audit', handoff: { taskId: 'task-re', laneId: 'lane-oracle', role: 'oracle' } })
  s.tasks.settle('child-1', { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  s.executionStore.open({ taskId: 'task-re', parentId: 'p', backend: 'external' })
  s.executionStore.settle('task-re', 'task-re#a1', { execution: 'completed' })
  s.executionStore.acceptance('task-re', { state: 'passed', evidence: ['suite green'] })

  // World changed → refused with the reason.
  await assert.rejects(
    s.managed.reexecute({}, {
      parentId: 'p', taskId: 'child-1', prompt: 'again',
      exec: { agent: { id: 'p' }, signal: new AbortController().signal },
      validate: () => ['workspace fingerprint changed since the run'],
    }),
    (error) => error.code === 'OMC/REUSE-REFUSED' && /fingerprint changed/.test(error.message),
  )

  // Unchanged → runs as a NEW attempt with acceptance reset.
  const { ctx } = fakeCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct' }), registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const result = await s.managed.reexecute(rt, {
    parentId: 'p', taskId: 'child-1', prompt: 'again',
    exec: { agent: { id: 'p' }, signal: new AbortController().signal },
    validate: () => [],
  })
  assert.equal(result.results[0].reused, true)
  assert.equal(result.results[0].managed, false, 'a reuse without a live node is labeled, not silently managed')
  assert.equal(result.previousAcceptance.state, 'passed')
  assert.match(result.note, /not inherited/)
  const view = s.executionStore.read('task-re')
  assert.equal(view.attempts.length, 2)
  assert.equal(view.acceptance.state, 'pending')
})
