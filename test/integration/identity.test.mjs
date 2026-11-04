/**
 * PR-01 regressions (0.6 C01): trusted lineage, root/child/attempt identity and
 * cross-shard task attribution.
 *
 * These tests drive the stores directly with host-shaped facts. They pin the
 * three rules this stage introduces:
 *   1. lineage comes from the host session header/ancestor chain, never from a
 *      tool argument or a bare child_session_id;
 *   2. a delegated child lands in its root's shard, and a claim for another
 *      root/ticket is refused instead of writing across graphs;
 *   3. old schemaVersion 1 records stay readable (legacy), and a recovered /
 *      re-claimed node cannot be settled by an old ticket or attempt.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTaskRegistry } from '../../integration/tasks.js'
import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createNativeRuntime, nativeTaskIdFor } from '../../integration/native-runtime.js'
import { createNativeManaged } from '../../integration/native-managed.js'

const ROOT = 'agent-root'

function host({ ownPreset = null } = {}) {
  const ledger = createUsageLedger()
  const executionStore = createExecutionStore()
  const runtime = createNativeRuntime({ usageLedger: ledger, executionStore, ownPreset })
  return { ledger, executionStore, runtime }
}

function hostFacts() {
  const { runtime, executionStore, ledger } = host()
  const root = runtime.resolveCallingSession({ sessionId: 's-root', header: {}, agentId: ROOT })
  const child = runtime.resolveCallingSession({
    sessionId: 's-child',
    header: { parentSession: 's-root', origin: 'subagent', delegationDepth: 1 },
    agentId: 'agent-child',
  })
  return { runtime, executionStore, ledger, root, child }
}

// ── 1. host lineage: root → child → grandchild, children never new roots ─────

test('PR-01: host header derives root/child/grandchild lineage and the root shard', () => {
  const { runtime, root, child } = hostFacts()

  assert.equal(root.parentId, ROOT)
  assert.equal(root.depth, 0)
  assert.equal(root.lineage.source, 'host')
  assert.equal(root.rootTaskId, nativeTaskIdFor('s-root'))
  assert.equal(root.parentTaskId, null)

  // A child resolves to the root's shard, not to its own agent id.
  assert.equal(child.parentId, ROOT)
  assert.equal(child.unresolved, undefined)
  assert.equal(child.depth, 1)
  assert.equal(child.parentTaskId, nativeTaskIdFor('s-root'))
  assert.equal(child.rootTaskId, nativeTaskIdFor('s-root'))
  assert.equal(child.lineage.source, 'host')
  assert.equal(child.proven, true)

  const grandchild = runtime.resolveCallingSession({
    sessionId: 's-grandchild',
    header: { parentSession: 's-child', origin: 'subagent', delegationDepth: 2 },
    agentId: 'agent-grandchild',
  })
  assert.equal(grandchild.parentId, ROOT)
  assert.equal(grandchild.depth, 2)
  assert.equal(grandchild.parentTaskId, nativeTaskIdFor('s-child'))
  assert.equal(grandchild.rootTaskId, nativeTaskIdFor('s-root'))

  // Re-resolving is idempotent and never manufactures an autoRoot.
  runtime.resolveCallingSession({ sessionId: 's-child', header: { parentSession: 's-root' }, agentId: 'agent-child' })
  assert.equal(runtime.stats().autoRoots, 0)
})

test('PR-01: a host subagent header without a parentSession stays unknown, not a fabricated root', () => {
  const ledger = createUsageLedger()
  const runtime = createNativeRuntime({ usageLedger: ledger, executionStore: createExecutionStore(), ownPreset: 'oh-my-coharness' })
  const handlers = {}
  runtime.install({
    on: (event, handler) => { handlers[event] = handler; return () => {} },
    effect: (register) => register(),
  })

  const created = handlers['agent/created']({
    agent: { id: 'agent-orphan', session: { id: 's-orphan', header: { origin: 'subagent', agentPreset: 'oh-my-coharness' } } },
  })
  assert.equal(created.kind, 'unbound')
  assert.equal(runtime.bindingFor('s-orphan'), null)
  assert.equal(runtime.stats().autoRoots, 0)

  const resolved = runtime.resolveCallingSession({
    sessionId: 's-orphan',
    header: { origin: 'subagent', agentPreset: 'oh-my-coharness' },
    agentId: 'agent-orphan',
  })
  assert.equal(resolved.unresolved, true, 'a subagent with no proven parent is not promoted to root')
  assert.equal(resolved.lineage.source, 'unknown')
})

test('PR-01: the task started by a child inherits the root task and one extra depth', () => {
  const { runtime } = hostFacts()
  const lineage = runtime.taskLineage({
    sessionId: 's-child',
    header: { parentSession: 's-root', origin: 'subagent' },
    agentId: 'agent-child',
  })
  assert.equal(lineage.source, 'host')
  assert.equal(lineage.trusted, true)
  assert.equal(lineage.rootParentId, ROOT)
  assert.equal(lineage.parentTaskId, nativeTaskIdFor('s-child'))
  assert.equal(lineage.rootTaskId, nativeTaskIdFor('s-root'))
  assert.equal(lineage.depth, 2)
})

// ── 2. cross-shard task attribution ──────────────────────────────────────────

test('PR-01: a host-proven child task is written into the root shard; an unproven id cannot move it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-identity-tasks-'))
  try {
    const registry = createTaskRegistry({ dir })

    registry.start({
      id: 'run-child',
      parentId: 'agent-child',
      harness: 'codex',
      label: 'delegated review',
      lineage: {
        source: 'host',
        rootParentId: ROOT,
        parentSessionId: 's-child',
        rootSessionId: 's-root',
        parentTaskId: nativeTaskIdFor('s-child'),
        rootTaskId: nativeTaskIdFor('s-root'),
        depth: 2,
      },
    })

    const inRoot = registry.list(ROOT)
    assert.equal(inRoot.length, 1)
    assert.equal(inRoot[0].id, 'run-child')
    assert.equal(inRoot[0].parentId, ROOT)
    assert.equal(inRoot[0].rootTaskId, nativeTaskIdFor('s-root'))
    assert.equal(inRoot[0].parentTaskId, nativeTaskIdFor('s-child'))
    assert.equal(inRoot[0].depth, 2)
    assert.equal(inRoot[0].lineageSource, 'host')
    assert.equal(registry.list('agent-child').length, 0, 'the child agent did not open a second shard')
    assert.equal(registry.read(ROOT, 'run-child').id, 'run-child')

    // An argument-only lineage claim is `unknown`: it cannot select a shard.
    registry.start({
      id: 'run-forged',
      parentId: 'agent-child',
      harness: 'codex',
      label: 'forged shard',
      lineage: { source: 'unknown', rootParentId: 'another-root' },
    })
    assert.equal(registry.list('agent-child').length, 1)
    assert.equal(registry.list('another-root').length, 0)
    const forged = registry.read('agent-child', 'run-forged')
    assert.equal(forged.lineageSource, 'unknown')
    assert.equal(forged.rootTaskId, 'run-forged', 'root defaults to itself when no host root exists')
    assert.equal(forged.depth, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PR-01: replay of the same run id never creates a second row or rewrites a terminal result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-identity-replay-'))
  try {
    const registry = createTaskRegistry({ dir })
    const first = registry.start({ id: 'run-1', parentId: ROOT, harness: 'codex', label: 'one' })
    assert.equal(first.duplicate, undefined)
    const second = registry.start({ id: 'run-1', parentId: ROOT, harness: 'codex', label: 'two' })
    assert.equal(second.duplicate, true)
    assert.equal(registry.list(ROOT).length, 1)

    registry.settle('run-1', { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    const replay = registry.start({ id: 'run-1', parentId: ROOT, harness: 'codex', label: 'three' })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.status, 'completed')
    assert.equal(registry.read(ROOT, 'run-1').result.stopReason, 'completed', 'replay did not clear the result')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 3. graph identity, parent/depth/root validation ──────────────────────────

test('PR-01: graph nodes carry ticket/root/depth and a child inherits its parent root', () => {
  const graph = createGraphStore()
  graph.plan(ROOT, [
    { id: 'requirement', title: 'requirement', ticketId: 'ticket-1', workstream: 'plugin-runtime' },
    { id: 'ticket', title: 'child ticket', parentNodeId: 'requirement', workstream: 'plugin-runtime' },
  ], { rootTaskId: nativeTaskIdFor('s-root'), lineage: { source: 'host' } })

  const status = graph.status(ROOT)
  const requirement = status.nodes.find((node) => node.id === 'requirement')
  const ticket = status.nodes.find((node) => node.id === 'ticket')
  assert.equal(requirement.depth, 0)
  assert.equal(requirement.ticketId, 'ticket-1')
  assert.equal(requirement.workstream, 'plugin-runtime')
  assert.equal(requirement.lineage.source, 'host')
  assert.equal(ticket.depth, 1)
  assert.equal(ticket.ticketId, 'ticket', 'ticketId defaults to the node id')
  assert.equal(ticket.parentNodeId, 'requirement')
  assert.equal(ticket.rootTaskId, nativeTaskIdFor('s-root'))
  assert.equal(status.rootTaskId, nativeTaskIdFor('s-root'))
})

test('PR-01: workstream is a label, never required to equal the role', () => {
  const graph = createGraphStore()
  graph.plan('p', [
    { id: 'n1', role: 'oracle', workstream: 'docs' },
    { id: 'n2', role: 'fixer', workstream: 'plugin-runtime' },
  ])
  const node = graph.status('p').nodes.find((row) => row.id === 'n1')
  assert.equal(node.roleId, 'oracle')
  assert.equal(node.workstream, 'docs')
  assert.throws(
    () => graph.plan('p', [{ id: 'n3', workstream: 'not a valid id!' }]),
    (error) => error.code === 'OMC/GRAPH-WORKSTREAM',
  )
})

test('PR-01: a forged other-root claim or ticket is refused', () => {
  const graph = createGraphStore()
  graph.plan('root-a', [{ id: 'a1', ticketId: 'ticket-a' }], { rootTaskId: 'task-a', lineage: { source: 'host' } })
  graph.plan('root-b', [{ id: 'b1', ticketId: 'ticket-b' }], { rootTaskId: 'task-b', lineage: { source: 'host' } })

  assert.throws(
    () => graph.claim('root-a', 'a1', { rootTaskId: 'task-b', lineage: { source: 'host' } }),
    (error) => error.code === 'OMC/GRAPH-ROOT',
  )
  assert.throws(
    () => graph.plan('root-a', [{ id: 'a2' }], { rootTaskId: 'task-b', lineage: { source: 'host' } }),
    (error) => error.code === 'OMC/GRAPH-ROOT',
  )
  assert.throws(
    () => graph.claim('root-a', 'a1', { ticketId: 'ticket-b', lineage: { source: 'host' } }),
    (error) => error.code === 'OMC/GRAPH-TICKET',
  )

  // A host-proven child of root B cannot claim root A's node.
  const { runtime } = host()
  runtime.bindRoot({ sessionId: 's-b', parentId: 'root-b' })
  const executionStore = createExecutionStore()
  const native = createNativeRuntime({ usageLedger: createUsageLedger(), executionStore })
  native.bindRoot({ sessionId: 's-b', parentId: 'root-b' })
  const managed = createNativeManaged({ graph, native, executionStore })
  assert.throws(
    () => managed.bind({ parentId: 'root-a', nodeId: 'a1', sessionId: 's-b' }),
    (error) => error.code === 'OMC/NATIVE-MANAGED-CROSS-ROOT',
  )
})

test('PR-01: an orphan parent node is rejected at plan time; a released parent cannot authorise a child claim', () => {
  const graph = createGraphStore()
  assert.throws(
    () => graph.plan('p', [{ id: 'child', parentNodeId: 'ghost' }]),
    (error) => error.code === 'OMC/GRAPH-PARENT',
  )

  graph.plan('p', [{ id: 'parent' }])
  graph.plan('p', [{ id: 'child', parentNodeId: 'parent' }])
  graph.claim('p', 'parent')
  graph.release('p', 'parent', { reason: 'activation failed', to: 'ready' })
  assert.throws(
    () => graph.claim('p', 'child'),
    (error) => error.code === 'OMC/GRAPH-PARENT-STATE',
  )

  // A recovered parent is in the same position: re-claim it first.
  graph.claim('p', 'parent')
  graph.recover('p')
  assert.throws(
    () => graph.claim('p', 'child'),
    (error) => error.code === 'OMC/GRAPH-PARENT-STATE',
  )
})

test('PR-01: depth is derived and capped at 24, both at plan and at claim', async () => {
  const graph = createGraphStore()
  const chain = Array.from({ length: 25 }, (_, index) => ({
    id: `n${index}`,
    ...(index === 0 ? {} : { parentNodeId: `n${index - 1}` }),
  }))
  graph.plan('p', chain)
  assert.equal(graph.status('p').nodes.at(-1).depth, 24)

  assert.throws(
    () => graph.plan('deep', [
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `d${index}`,
        ...(index === 0 ? {} : { parentNodeId: `d${index - 1}` }),
      })),
      { id: 'd25', parentNodeId: 'd24' },
    ]),
    (error) => error.code === 'OMC/GRAPH-DEPTH',
  )

  // A stored depth that regressed below parent+1 is refused at claim time.
  const dir = await mkdtemp(join(tmpdir(), 'omc-identity-depth-'))
  try {
    const durable = createGraphStore({ dir })
    durable.plan('p', [{ id: 'parent' }, { id: 'child', parentNodeId: 'parent' }])
    durable.claim('p', 'parent', { taskId: 'parent-task' })
    const file = join(dir, 'p.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    raw.nodes.child.depth = 0
    await writeFile(file, JSON.stringify(raw), 'utf8')
    const reopened = createGraphStore({ dir })
    assert.throws(
      () => reopened.claim('p', 'child'),
      (error) => error.code === 'OMC/GRAPH-DEPTH',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 4. compat: old schemaVersion 1 records are legacy, not host ──────────────

test('PR-01: a schemaVersion 1 task row stays readable and is labeled legacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-identity-task-compat-'))
  try {
    await mkdir(join(dir, 'parent-old'), { recursive: true })
    await writeFile(join(dir, 'parent-old', 'index.json'), JSON.stringify({
      schemaVersion: 1,
      parentId: 'parent-old',
      rows: {
        'task-old': {
          id: 'task-old', parentId: 'parent-old', harness: 'codex', label: 'old run',
          lane: null, role: null, taskId: null, status: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z', settledAt: '2026-01-01T00:00:01.000Z',
          settledOrder: 1,
        },
      },
    }), 'utf8')

    const registry = createTaskRegistry({ dir })
    const [row] = registry.list('parent-old')
    assert.equal(row.id, 'task-old')
    assert.equal(row.parentTaskId, null)
    assert.equal(row.rootTaskId, 'task-old', 'old records default root to themselves')
    assert.equal(row.depth, 0)
    assert.equal(row.lineageSource, 'legacy')
    assert.equal(row.compat.legacy, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PR-01: a schemaVersion 1 graph node stays claimable as legacy, and strict mode refuses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-identity-graph-compat-'))
  try {
    await writeFile(join(dir, 'parent-old.json'), JSON.stringify({
      schemaVersion: 1,
      parentId: 'parent-old',
      nodes: {
        n1: {
          id: 'n1', roleId: 'oracle', title: 'old node', deps: [], write: false,
          writeScope: [], acceptance: [], state: 'pending', taskId: null, childId: null,
          evidence: [], note: '',
        },
      },
      claims: {},
    }), 'utf8')

    const graph = createGraphStore({ dir })
    const node = graph.status('parent-old').nodes[0]
    assert.equal(node.lineage.source, 'legacy')
    assert.equal(node.parentNodeId, null)
    assert.equal(node.depth, 0)
    assert.equal(node.ticketId, 'n1')
    assert.doesNotThrow(() => graph.claim('parent-old', 'n1', { taskId: 'old-work' }))
    graph.release('parent-old', 'n1', { reason: 'legacy retry', to: 'ready' })

    const strict = createGraphStore({ dir, strictLineage: true })
    assert.throws(
      () => strict.claim('parent-old', 'n1', { taskId: 'strict-work' }),
      (error) => error.code === 'OMC/GRAPH-LINEAGE',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PR-01: strict lineage refuses a task/claim with no host proof', () => {
  const tasks = createTaskRegistry({ strictLineage: true })
  assert.throws(
    () => tasks.start({ id: 'run', parentId: ROOT, harness: 'codex', label: 'no lineage' }),
    (error) => error.code === 'OMC/TASK-LINEAGE-REQUIRED',
  )

  const graph = createGraphStore({ strictLineage: true })
  graph.plan('p', [{ id: 'n1' }])
  assert.throws(
    () => graph.claim('p', 'n1', { lineage: { source: 'unknown', note: 'argument only' } }),
    (error) => error.code === 'OMC/GRAPH-LINEAGE',
  )
  assert.doesNotThrow(() => graph.claim('p', 'n1', { lineage: { source: 'host' } }))
})

// ── 5. managed bind: only host evidence may be marked host ──────────────────

test('PR-01: a bare child_session_id is claimed as unknown lineage, never host', () => {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const native = createNativeRuntime({ usageLedger: createUsageLedger(), executionStore })
  const managed = createNativeManaged({ graph, native, executionStore })
  graph.plan(ROOT, [{ id: 't1' }], { rootTaskId: 'task-root' })

  const bound = managed.bind({ parentId: ROOT, nodeId: 't1', sessionId: 's-unproven' })
  assert.equal(bound.trusted, false)
  assert.equal(bound.lineage.source, 'unknown')
  const node = graph.status(ROOT).nodes.find((row) => row.id === 't1')
  assert.equal(node.lineage.source, 'unknown')
  const claim = graph.status(ROOT).claims.t1
  assert.equal(claim.lineage.source, 'unknown')

  // Strict mode turns the same situation into a refusal instead of a record.
  const strictGraph = createGraphStore({ strictLineage: true })
  const strictManaged = createNativeManaged({ graph: strictGraph, native, executionStore })
  strictGraph.plan(ROOT, [{ id: 't1' }])
  assert.throws(
    () => strictManaged.bind({ parentId: ROOT, nodeId: 't1', sessionId: 's-unproven-2' }),
    (error) => error.code === 'OMC/GRAPH-LINEAGE',
  )
})

test('PR-01: a host-derived child binding is marked host and carries the same root', () => {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const ledger = createUsageLedger()
  const native = createNativeRuntime({ usageLedger: ledger, executionStore })
  const managed = createNativeManaged({ graph, native, executionStore })
  const rootTask = nativeTaskIdFor('s-root')

  native.resolveCallingSession({ sessionId: 's-root', header: {}, agentId: ROOT })
  native.resolveCallingSession({
    sessionId: 's-child',
    header: { parentSession: 's-root', origin: 'subagent' },
    agentId: 'agent-child',
  })
  graph.plan(ROOT, [{ id: 't1' }], { rootTaskId: rootTask, lineage: { source: 'host' } })

  const bound = managed.bind({ parentId: ROOT, nodeId: 't1', sessionId: 's-child' })
  assert.equal(bound.trusted, true)
  assert.equal(bound.lineage.source, 'host')
  assert.equal(bound.binding.parentId, ROOT)
  assert.equal(bound.binding.rootTaskId, rootTask)
  assert.equal(bound.binding.depth, 1)
  const claim = graph.status(ROOT).claims.t1
  assert.equal(claim.rootTaskId, rootTask)
  assert.equal(claim.lineage.source, 'host')
  assert.equal(claim.depth, 0, 'node depth stays plan-derived; session depth is recorded separately on the binding')
})

test('PR-01: re-binding the same session to another root is still refused', () => {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const native = createNativeRuntime({ usageLedger: createUsageLedger(), executionStore })
  native.bindRoot({ sessionId: 's-root', parentId: ROOT })
  assert.throws(
    () => native.bind({ sessionId: 's-root', parentId: 'somebody-else' }),
    /OMC\/NATIVE-BIND-CONFLICT/,
  )
  assert.equal(graph.status(ROOT).nodes.length, 0)
})

// ── 6. recover: an old ticket/attempt cannot settle re-claimed work ─────────

test('PR-01: after recover and re-claim, the old claim/task can no longer settle the node', () => {
  const graph = createGraphStore()
  graph.plan('p', [{ id: 'n1' }], { rootTaskId: 'root-task' })

  const first = graph.claim('p', 'n1', { taskId: 'old-task', lineage: { source: 'host' } })
  assert.ok(first.claimId)
  assert.deepEqual(graph.recover('p').recovered, ['n1'])

  const second = graph.claim('p', 'n1', { taskId: 'new-task', lineage: { source: 'host' } })
  assert.notEqual(second.claimId, first.claimId)

  assert.throws(
    () => graph.complete('p', 'n1', { status: 'completed', taskId: 'old-task' }),
    (error) => error.code === 'OMC/GRAPH-STALE-CLAIM',
  )
  assert.throws(
    () => graph.complete('p', 'n1', { status: 'completed', claimId: first.claimId }),
    (error) => error.code === 'OMC/GRAPH-STALE-CLAIM',
  )
  assert.throws(
    () => graph.release('p', 'n1', { reason: 'old worker died', claimId: first.claimId }),
    (error) => error.code === 'OMC/GRAPH-STALE-CLAIM',
  )
  assert.doesNotThrow(() => graph.complete('p', 'n1', {
    status: 'completed', taskId: 'new-task', claimId: second.claimId,
  }))
})

test('PR-01: a stale execution attempt cannot settle the re-claimed node', async () => {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const native = createNativeRuntime({ usageLedger: createUsageLedger(), executionStore })
  const managed = createNativeManaged({ graph, native, executionStore })
  graph.plan('p', [{ id: 'n1' }], { rootTaskId: 'root-task' })

  graph.claim('p', 'n1', { taskId: 'old-task', lineage: { source: 'host' } })
  graph.recover('p')
  graph.claim('p', 'n1', { taskId: 'new-task', lineage: { source: 'host' } })
  executionStore.open({ taskId: 'new-task', parentId: 'p', backend: 'native' })

  await assert.rejects(
    () => managed.settle({
      parentId: 'p', nodeId: 'n1', evidence: ['old evidence'], attemptId: 'old-task#a1',
    }),
    (error) => error.code === 'OMC/NATIVE-MANAGED-STALE-ATTEMPT',
  )
})

// ── 7. status/read surfaces keep the identity fields ────────────────────────

test('PR-01: status and claim records keep the identity fields after settle/release', () => {
  const graph = createGraphStore()
  graph.plan('p', [{ id: 'n1', ticketId: 'ticket-1', workstream: 'docs', parentNodeId: undefined }], {
    rootTaskId: 'root-task',
    lineage: { source: 'host' },
  })
  graph.claim('p', 'n1', {
    taskId: 'task-1', childId: 's-child', lineage: { source: 'host' }, ticketId: 'ticket-1', workstream: 'docs',
  })
  const running = graph.status('p')
  assert.equal(running.claims.n1.ticketId, 'ticket-1')
  assert.equal(running.claims.n1.workstream, 'docs')
  assert.equal(running.claims.n1.rootTaskId, 'root-task')
  assert.equal(running.claims.n1.lineage.source, 'host')

  graph.complete('p', 'n1', { status: 'failed', taskId: 'task-1' })
  const settled = graph.status('p').nodes.find((node) => node.id === 'n1')
  assert.equal(settled.ticketId, 'ticket-1')
  assert.equal(settled.workstream, 'docs')
  assert.equal(settled.rootTaskId, 'root-task')
  assert.equal(settled.lineage.source, 'host')
})

// ── 8. host entry: a child tool call lands in the existing root shard ───────

test('PR-01: a child agent calling coharness does not create a new autoRoot shard', async () => {
  const { apply } = await import('../../src/index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'omc-identity-host-'))
  try {
    const tools = new Map()
    const providers = new Map()
    const ctx = {
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      subprocess: { async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` }, spawn() { throw new Error('no spawn expected') } },
      get(name) {
        if (name === 'tools') return ctx.tools
        if (name === 'subagents') return { list: () => [...providers.keys()], registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name) } }
        if (name === 'subprocess') return ctx.subprocess
        if (name === 'workingDirectory') return { ensure: async () => cwd }
      },
      effect(fn) { return fn() },
      inject(_deps, fn) { fn(ctx) },
    }
    apply(ctx, {
      transport: 'native',
      stateDir: join(cwd, 'state'),
      sessions: { path: join(cwd, 'sessions.json') },
      harnesses: Object.fromEntries(['codex', 'claude', 'glm', 'gemini', 'antigravity', 'kimi', 'opencode', 'qwen']
        .map((id) => [id, { enabled: false }])),
    })

    const control = tools.get('coharness')
    const rootExec = { agent: { id: ROOT, session: { id: 's-root', header: {} } }, signal: new AbortController().signal }
    const childExec = {
      agent: { id: 'agent-child', session: { id: 's-child', header: { parentSession: 's-root', origin: 'subagent' } } },
      signal: new AbortController().signal,
    }

    // The root plans a node.
    await control.execute({ action: 'graph', graph_action: 'plan', nodes: [{ id: 'root-node', title: 'root work' }] }, rootExec)

    // The child reads and extends the same graph: it is attributed to the root
    // shard (parentNodeId resolves inside that graph) rather than a new one.
    const childStatus = JSON.parse((await control.execute({ action: 'graph', graph_action: 'status' }, childExec)).text)
    assert.deepEqual(childStatus.nodes.map((node) => node.id), ['root-node'])
    assert.equal(childStatus.parentId, ROOT)

    const childPlan = JSON.parse((await control.execute({
      action: 'graph',
      graph_action: 'plan',
      nodes: [{ id: 'child-node', parentNodeId: 'root-node', workstream: 'plugin-runtime' }],
    }, childExec)).text)
    assert.equal(childPlan.graph.nodes['child-node'].depth, 1)
    assert.equal(childPlan.graph.nodes['child-node'].lineage.source, 'host')
    assert.equal(childPlan.graph.nodes['child-node'].rootTaskId, nativeTaskIdFor('s-root'))

    const rootStatus = JSON.parse((await control.execute({ action: 'graph', graph_action: 'status' }, rootExec)).text)
    assert.deepEqual(rootStatus.nodes.map((node) => node.id).sort(), ['child-node', 'root-node'])
    assert.equal(rootStatus.rootTaskId, nativeTaskIdFor('s-root'))

    // The root claims its node; only then may the child claim under it.
    await control.execute({ action: 'graph', graph_action: 'claim', node_id: 'root-node' }, rootExec)

    // The child can claim its node and the identity is visible on the claim.
    const claimed = JSON.parse((await control.execute({
      action: 'graph', graph_action: 'claim', node_id: 'child-node', ticket_id: 'child-node',
    }, childExec)).text)
    assert.equal(claimed.node.state, 'running')
    assert.equal(claimed.node.ticketId, 'child-node')
    assert.equal(claimed.node.workstream, 'plugin-runtime')
    assert.equal(claimed.lineage.source, 'host')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

