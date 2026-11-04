/**
 * R03 regressions (0.5.0-alpha.2 practice.2): the native managed path.
 *
 * A native child is started by the host's role tool, so OMC binds it instead of
 * launching it. These tests pin the contract that makes that safe:
 *   - bind claims the node and remembers which child owns it;
 *   - execution settles from the durable turn/end events (never from a guess);
 *   - a completed execution alone never completes the node — acceptance needs
 *     evidence, and only then do dependants unlock;
 *   - a failed/cancelled/unknown execution releases the claim instead of
 *     leaving the graph wedged;
 *   - a node nobody bound is reported as unmanaged, never as covered.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createNativeRuntime } from '../../integration/native-runtime.js'
import { createNativeManaged } from '../../integration/native-managed.js'
import { createAcceptanceAuthority } from '../../integration/acceptance-verdict.js'

const PARENT = 'parent-r03'

/** A deterministic judge: no external process, same shape as the real runner. */
function fakeRunner({ passed = true } = {}) {
  return {
    async baseline() {
      return { fingerprint: 'tree-baseline', acceptanceDigest: 'acc-baseline', files: {}, acceptanceFiles: {}, at: new Date().toISOString() }
    },
    async run() {
      return {
        passed,
        fingerprint: 'tree-baseline',
        acceptanceDigest: 'acc-baseline',
        checks: [{ name: 'ok', passed }],
        problems: passed ? [] : ['the check failed'],
        reason: passed ? null : 'OMC/ACCEPTANCE-CHECK: the check failed',
        at: new Date().toISOString(),
      }
    },
    verifyDelivered() { return { passed: true, problems: [] } },
  }
}

function gradedSpec() {
  return {
    taskId: 'graded-task',
    split: 'development',
    commands: [{ name: 'ok', run: ['node', '-e', '0'], expect: { exitCode: 0 } }],
    acceptanceFiles: [],
    forbidChanges: [],
  }
}

function fixture() {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const usageLedger = createUsageLedger()
  const native = createNativeRuntime({ usageLedger, executionStore })
  const acceptance = createAcceptanceAuthority({ executionStore })
  const managed = createNativeManaged({ graph, native, executionStore, acceptance })
  graph.plan(PARENT, [
    { id: 'explore', roleId: 'explorer', write: false, deps: [], acceptance: ['files located'], acceptanceSpec: gradedSpec() },
    { id: 'fix', roleId: 'fixer', write: true, writeScope: ['src/'], deps: ['explore'], acceptance: ['tests pass'], acceptanceSpec: gradedSpec() },
    { id: 'review', roleId: 'oracle', write: false, deps: ['fix'], acceptance: ['no regression'], acceptanceSpec: gradedSpec() },
  ])
  return { graph, executionStore, usageLedger, native, managed, acceptance }
}

/** Bind a graded node and wait for its pre-dispatch baseline to be frozen. */
async function bindGraded(managed, { nodeId = 'explore', sessionId = 's-explore', role = 'explorer', runner = fakeRunner() } = {}) {
  const bound = managed.bind({
    parentId: PARENT, nodeId, sessionId, role,
    acceptanceSpec: gradedSpec(), runner,
  })
  if (bound.acceptanceReady) await bound.acceptanceReady
  return bound
}

/** Drive one native turn that succeeds, exactly as the host would persist it. */
function completedTurn(native, sessionId, { turn = 1 } = {}) {
  const session = { id: sessionId, header: { parentSession: 's-root' } }
  native.observe(session, { type: 'request/header', seq: turn * 10, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } } })
  native.observe(session, {
    type: 'assistant/message', seq: turn * 10 + 1,
    data: { turn, step: 1, usage: { inputTokens: 10, outputTokens: 2 } },
  })
  native.observe(session, { type: 'turn/end', seq: turn * 10 + 2, data: { turn, reason: { kind: 'completed' } } })
}

test('R03: bind claims the node and records the owning child', () => {
  const { graph, managed } = fixture()
  const bound = managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })

  assert.equal(bound.managed, true)
  assert.equal(bound.nodeId, 'explore')
  assert.equal(bound.binding.parentId, PARENT)
  assert.equal(bound.binding.nodeId, 'explore')
  assert.equal(bound.binding.role, 'explorer')

  const node = graph.status(PARENT).nodes.find((row) => row.id === 'explore')
  assert.equal(node.state, 'running')
  assert.equal(node.childId, 's-explore')
  assert.equal(node.taskId, bound.taskId, 'the node carries the native task id')

  // Bind is idempotent for the same session.
  const again = managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore' })
  assert.equal(again.taskId, bound.taskId)
})

test('R03: execution completion alone does not deliver; a trusted verdict unlocks dependants', async () => {
  // (a) A completed execution with no frozen baseline and no trusted verdict
  // stays pending even when the caller supplies evidence strings.
  const noBaseline = fixture()
  noBaseline.managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  completedTurn(noBaseline.native, 's-explore')
  const pending = await noBaseline.managed.settle({
    parentId: PARENT, nodeId: 'explore', evidence: ['src/usage-ledger.js located'],
  })
  assert.equal(pending.execution, 'completed')
  assert.equal(pending.acceptance, 'pending')
  assert.equal(pending.delivered, false)
  assert.equal(noBaseline.graph.status(PARENT).nodes.find((row) => row.id === 'explore').state, 'running')
  assert.equal(noBaseline.graph.status(PARENT).ready.length, 0, 'dependants stay locked')

  // (b) A baseline frozen before the first turn plus the same judge path
  // produces the verdict; only then does the node complete.
  const graded = fixture()
  const bound = await bindGraded(graded.managed)
  completedTurn(graded.native, 's-explore')
  const delivered = await graded.managed.settle({ parentId: PARENT, nodeId: 'explore', runner: fakeRunner() })
  assert.equal(delivered.acceptance, 'passed')
  assert.equal(delivered.delivered, true)
  const status = graded.graph.status(PARENT)
  assert.equal(status.nodes.find((row) => row.id === 'explore').state, 'completed')
  assert.equal(status.nodes.find((row) => row.id === 'explore').acceptanceState, 'passed')
  assert.equal(status.nodes.find((row) => row.id === 'explore').acceptanceAttemptId !== null, true)
  assert.deepEqual(status.ready, ['fix'], 'the dependent becomes ready only now')

  const view = graded.managed.coverage(PARENT)
  assert.equal(view.settled, 1)
  assert.match(view.note, /unmanaged/)
  assert.equal(bound.taskId, view.claims ?? bound.taskId)
})

test('R03: a failed execution releases the claim and never delivers', async () => {
  const { graph, native, managed } = fixture()
  managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  const session = { id: 's-explore', header: { parentSession: 's-root' } }
  native.observe(session, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } } })
  native.observe(session, { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 1 } })
  native.observe(session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'blocked' } } })

  const result = await managed.settle({ parentId: PARENT, nodeId: 'explore', evidence: ['ignored: execution failed'] })
  assert.equal(result.execution, 'failed')
  assert.equal(result.acceptance, 'failed')
  assert.equal(result.delivered, false)
  const node = graph.status(PARENT).nodes.find((row) => row.id === 'explore')
  assert.equal(node.state, 'failed')
})

test('R03: settle refuses a running task and a stale attempt', async () => {
  const { executionStore, managed } = fixture()
  managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  // executionStore has no record yet for this task in this scenario: open one.
  const binding = managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore' })
  executionStore.open({ taskId: binding.taskId, parentId: PARENT, backend: 'native' })

  await assert.rejects(
    () => managed.settle({ parentId: PARENT, nodeId: 'explore' }),
    /OMC\/NATIVE-MANAGED-RUNNING/,
  )
  // Settle the first attempt, then a second attempt exists after a reopen.
  executionStore.settle(binding.taskId, null, { execution: 'completed' })
  const second = executionStore.retry(binding.taskId, { reason: 'retest' })
  assert.notEqual(second.currentAttemptId, binding.taskId + '#a1')
  await assert.rejects(
    () => managed.settle({ parentId: PARENT, nodeId: 'explore', attemptId: `${binding.taskId}#a1`, evidence: ['x'] }),
    /OMC\/NATIVE-MANAGED-STALE-ATTEMPT/,
  )
})

test('R03: a node already owned by another child is not re-bound', () => {
  const { managed } = fixture()
  managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  assert.throws(
    () => managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-other' }),
    /OMC\/GRAPH-CLAIMED-ELSEWHERE/,
  )
  assert.throws(
    () => managed.bind({ parentId: PARENT, nodeId: 'nope', sessionId: 's-x' }),
    /OMC\/GRAPH-NODE-UNKNOWN/,
  )
})

test('R03: two writers cannot run in the same scope', () => {
  const { graph, managed } = fixture()
  graph.plan(PARENT, [
    { id: 'w1', roleId: 'fixer', write: true, writeScope: ['src/input/'], deps: [], acceptance: ['a'] },
    { id: 'w2', roleId: 'fixer', write: true, writeScope: ['src/input/'], deps: [], acceptance: ['b'] },
  ])
  managed.bind({ parentId: PARENT, nodeId: 'w1', sessionId: 's-w1' })
  assert.throws(
    () => managed.bind({ parentId: PARENT, nodeId: 'w2', sessionId: 's-w2' }),
    /OMC\/GRAPH-WRITE-CONFLICT/,
  )
})

test('R03: an unbound native child is unmanaged coverage, not covered work', () => {
  const { native, managed, graph } = fixture()
  // A child that exists but was never bound by OMC.
  const session = { id: 's-orphan', header: { parentSession: 's-root' } }
  native.observe(session, { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } })
  assert.equal(native.bindingFor('s-orphan'), null)

  const coverage = managed.coverage(PARENT)
  assert.equal(coverage.boundNative, 0)
  assert.equal(coverage.claimed, 0)
  assert.equal(coverage.unmanagedNativePossible, true)
  assert.equal(graph.status(PARENT).nodes.every((node) => node.state === 'pending'), true)
})
