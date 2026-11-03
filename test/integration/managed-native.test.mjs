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

const PARENT = 'parent-r03'

function fixture() {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const usageLedger = createUsageLedger()
  const native = createNativeRuntime({ usageLedger, executionStore })
  const managed = createNativeManaged({ graph, native, executionStore })
  graph.plan(PARENT, [
    { id: 'explore', roleId: 'explorer', write: false, deps: [], acceptance: ['files located'] },
    { id: 'fix', roleId: 'fixer', write: true, writeScope: ['src/'], deps: ['explore'], acceptance: ['tests pass'] },
    { id: 'review', roleId: 'oracle', write: false, deps: ['fix'], acceptance: ['no regression'] },
  ])
  return { graph, executionStore, usageLedger, native, managed }
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

test('R03: execution completion alone does not deliver; evidence unlocks dependants', () => {
  const { graph, native, managed } = fixture()
  const bound = managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  completedTurn(native, 's-explore')

  const pending = managed.settle({ parentId: PARENT, nodeId: 'explore' })
  assert.equal(pending.execution, 'completed')
  assert.equal(pending.acceptance, 'pending')
  assert.equal(pending.delivered, false)
  const stillRunning = graph.status(PARENT).nodes.find((row) => row.id === 'explore')
  assert.equal(stillRunning.state, 'running', 'no evidence means the node stays claimed')
  assert.equal(graph.status(PARENT).ready.length, 0, 'dependants stay locked')

  const delivered = managed.settle({ parentId: PARENT, nodeId: 'explore', evidence: ['src/usage-ledger.js located'] })
  assert.equal(delivered.acceptance, 'passed')
  assert.equal(delivered.delivered, true)
  const status = graph.status(PARENT)
  assert.equal(status.nodes.find((row) => row.id === 'explore').state, 'completed')
  assert.deepEqual(status.ready, ['fix'], 'the dependent becomes ready only now')

  const view = managed.coverage(PARENT)
  assert.equal(view.settled, 1)
  assert.match(view.note, /unmanaged/)
  assert.equal(bound.taskId, view.claims ?? bound.taskId)
})

test('R03: a failed execution releases the claim and never delivers', () => {
  const { graph, native, managed } = fixture()
  managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  const session = { id: 's-explore', header: { parentSession: 's-root' } }
  native.observe(session, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } } })
  native.observe(session, { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 1 } })
  native.observe(session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'blocked' } } })

  const result = managed.settle({ parentId: PARENT, nodeId: 'explore', evidence: ['ignored: execution failed'] })
  assert.equal(result.execution, 'failed')
  assert.equal(result.acceptance, 'failed')
  assert.equal(result.delivered, false)
  const node = graph.status(PARENT).nodes.find((row) => row.id === 'explore')
  assert.equal(node.state, 'failed')
})

test('R03: settle refuses a running task and a stale attempt', () => {
  const { executionStore, managed } = fixture()
  managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore', role: 'explorer' })
  // executionStore has no record yet for this task in this scenario: open one.
  const binding = managed.bind({ parentId: PARENT, nodeId: 'explore', sessionId: 's-explore' })
  executionStore.open({ taskId: binding.taskId, parentId: PARENT, backend: 'native' })

  assert.throws(
    () => managed.settle({ parentId: PARENT, nodeId: 'explore' }),
    /OMC\/NATIVE-MANAGED-RUNNING/,
  )
  // Settle the first attempt, then a second attempt exists after a reopen.
  executionStore.settle(binding.taskId, null, { execution: 'completed' })
  const second = executionStore.retry(binding.taskId, { reason: 'retest' })
  assert.notEqual(second.currentAttemptId, binding.taskId + '#a1')
  assert.throws(
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
