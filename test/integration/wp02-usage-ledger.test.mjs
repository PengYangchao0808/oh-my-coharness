/**
 * WP02 regressions (0.5.0-alpha.2): the idempotent usage ledger and the
 * execution/acceptance separation — A05–A08.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createUsageLedger,
  nativeSessionUsageEntries,
  normalizeUsageBuckets,
  usageLedgerKey,
} from '../../integration/usage-ledger.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { externalRoleResult } from '../../integration/role-result.js'

// ── A05: four normalized buckets, traceable to the raw usage ────────────────

test('A05: native chunks map directly and keep missing buckets unknown', () => {
  const native = normalizeUsageBuckets({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 0 })
  assert.deepEqual(native.buckets, { uncachedInputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 7 })
  assert.equal(native.coverage, 'complete')

  const partial = normalizeUsageBuckets({ inputTokens: 100, outputTokens: 7 })
  assert.equal(partial.buckets.cacheReadTokens, null)
  assert.equal(partial.coverage, 'partial')

  assert.equal(normalizeUsageBuckets(undefined).coverage, 'unknown')
})

test('A05: OpenAI-style totals split into uncached + cached, never negative or zero-filled', () => {
  const codex = normalizeUsageBuckets({ input_tokens: 500, cached_input_tokens: 300, output_tokens: 20 })
  assert.equal(codex.buckets.uncachedInputTokens, 200)
  assert.equal(codex.buckets.cacheReadTokens, 300)
  assert.equal(codex.buckets.cacheWriteTokens, null, 'a count the CLI does not report stays unknown')
  assert.equal(codex.coverage, 'partial')

  const inconsistent = normalizeUsageBuckets({ input_tokens: 100, cached_input_tokens: 500 })
  assert.equal(inconsistent.buckets.uncachedInputTokens, null, 'an impossible pair is unknown, not -400')
})

test('A05: a ledger entry round-trips with its route and source, one entry per event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp02-'))
  try {
    const ledger = createUsageLedger({ dir })
    const first = ledger.append({
      parentId: 'parent-1', taskId: 'task-1', attemptId: 'task-1#a1', backend: 'native',
      source: { kind: 'dsh-session', sessionId: 'session-abc', seq: 12 },
      route: { provider: 'deepseek', model: 'deepseek-v4', effort: 'high', observed: true },
      usage: { uncachedInputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 7 },
      cost: { usd: 0.01, source: 'price-table@2026-11', priceVersion: 'v1' },
      coverage: 'complete',
    })
    assert.equal(first.stored, true)
    const rows = ledger.entries({ parentId: 'parent-1' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].route.model, 'deepseek-v4')
    assert.equal(rows[0].source.seq, 12)
    assert.equal(rows[0].usage.uncachedInputTokens, 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── A06: duplicates, restart replay, retries, cross-process ──────────────────

test('A06: duplicate events, restart replay and a second process all book once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp02-'))
  try {
    const entry = {
      parentId: 'parent-1', taskId: 'task-1', attemptId: 'task-1#a1', backend: 'external',
      source: { kind: 'external-cli', runId: 'run-42', eventId: 'turn.completed' },
      usage: { uncachedInputTokens: 200, outputTokens: 5 },
    }
    const a = createUsageLedger({ dir })
    assert.equal(a.append(entry).stored, true)
    assert.equal(a.append(entry).duplicate, true, 'the same source event twice books once')

    // A new process instance replays the same event after restart.
    const b = createUsageLedger({ dir })
    assert.equal(b.append(entry).duplicate, true, 'restart replay does not re-bill')

    // A retry is a new attempt: a different key, a second entry.
    const retried = b.append({ ...entry, attemptId: 'task-1#a2', source: { kind: 'external-cli', runId: 'run-43', eventId: 'turn.completed' } })
    assert.equal(retried.stored, true)

    const totals = b.totals({ parentId: 'parent-1' })
    assert.equal(totals.entries, 2)
    assert.equal(totals.sums.uncachedInputTokens, 400)
    assert.equal(totals.coverage, 'partial', 'missing buckets keep the rollup honest')
    assert.equal(totals.unknownCost, true)
    assert.equal(totals.costUsd, null, 'no price means no cost, never 0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A06: the ledger key separates sessions and event ids', () => {
  assert.notEqual(
    usageLedgerKey({ backend: 'native', sessionId: 's1', seq: 1 }),
    usageLedgerKey({ backend: 'native', sessionId: 's1', seq: 2 }),
  )
  assert.notEqual(
    usageLedgerKey({ backend: 'native', sessionId: 's1', seq: 1 }),
    usageLedgerKey({ backend: 'native', sessionId: 's2', seq: 1 }),
  )
})

test('A06: invalid entries are refused with a reason', () => {
  const ledger = createUsageLedger({})
  assert.throws(() => ledger.append({ parentId: 'p', taskId: 't', attemptId: 'a', backend: 'nonsense', source: {} }), /backend/)
  assert.throws(() => ledger.append({ parentId: 'p', taskId: 't', attemptId: 'a', backend: 'native', source: {}, usage: { unicorns: 1 } }), /usage bucket/)
  assert.throws(() => ledger.append({ parentId: 'p', taskId: 't', attemptId: 'a', backend: 'native', source: {}, cost: { usd: -1, source: 'x' } }), /cost/)
})

// ── A05 replay: durable native session events book per step ─────────────────

test('A05: native session events map to one entry per step, attempts without usage stay unknown', () => {
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } } } },
    { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, usage: { inputTokens: 80, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { provider: 'deepseek', model: 'deepseek-v4' } } } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 2, usage: { inputTokens: 30, outputTokens: 2 } } },
  ]
  const entries = nativeSessionUsageEntries(events, { parentId: 'p', taskId: 't', attemptOf: () => 't#a1' })
  assert.equal(entries.length, 3)
  assert.equal(entries[0].coverage, 'unknown', 'a failed attempt books no usage, not zero')
  assert.equal(entries[0].usage, null)
  assert.equal(entries[1].usage.uncachedInputTokens, 80)
  assert.equal(entries[1].route.model, 'deepseek-v4')
  assert.equal(entries[2].coverage, 'partial')

  // Booking the replay through the ledger is idempotent.
  const ledger = createUsageLedger({})
  for (const entry of entries) ledger.append(entry)
  for (const entry of entries) ledger.append(entry)
  assert.equal(ledger.entries({ parentId: 'p' }).length, 3)
})

// ── A08: execution and acceptance stay separate ─────────────────────────────

test('A08: acceptance is separate; exit-0 execution without acceptance is not delivered', () => {
  const store = createExecutionStore({})
  store.open({ taskId: 'task-9', parentId: 'p', backend: 'external' })
  let view = store.settle('task-9', 'task-9#a1', { execution: 'completed', stopReason: 'completed' })
  assert.equal(view.execution, 'completed')
  assert.equal(view.acceptance.state, 'unknown')
  assert.equal(view.delivered, false, 'execution completion alone never claims delivery')

  view = store.acceptance('task-9', { state: 'failed', evidence: { tests: ['A03 suite'], failed: 1 } })
  assert.equal(view.acceptance.state, 'failed')
  assert.equal(view.delivered, false)

  view = store.acceptance('task-9', { state: 'passed', evidence: { tests: ['A03 suite'], failed: 0 } })
  assert.equal(view.delivered, true)
})

test('A08: cancelRequested is a flag; a still-running attempt keeps its true state', () => {
  const store = createExecutionStore({})
  store.open({ taskId: 'task-c', parentId: 'p', backend: 'direct' })
  const view = store.cancelRequested('task-c', 'task-c#a1', 'user pressed stop')
  assert.equal(view.cancelRequested, true)
  assert.equal(view.execution, 'running', 'a stop request is not a settlement')
})

test('A08: retries reopen the same task as new attempts and reset acceptance', () => {
  const store = createExecutionStore({})
  store.open({ taskId: 'task-r', parentId: 'p', backend: 'native' })
  store.settle('task-r', 'task-r#a1', { execution: 'failed', stopReason: 'error' })
  store.acceptance('task-r', { state: 'failed' })
  const view = store.retry('task-r', { reason: 'model switch', route: { provider: 'zai', model: 'glm-5.3' } })
  assert.equal(view.attempts.length, 2)
  assert.equal(view.currentAttemptId, 'task-r#a2')
  assert.equal(view.execution, 'running')
  assert.equal(view.acceptance.state, 'pending', 'old evidence never carries to a new attempt')
})

test('A08: contradictory settlement is a recorded conflict, not a rewrite', () => {
  const store = createExecutionStore({})
  store.open({ taskId: 'task-x', parentId: 'p', backend: 'external' })
  store.settle('task-x', 'task-x#a1', { execution: 'failed' })
  const view = store.settle('task-x', 'task-x#a1', { execution: 'completed' })
  assert.equal(view.execution, 'failed')
  assert.equal(view.attempts[0].conflicts.length, 1)
  assert.deepEqual(Object.fromEntries(Object.entries(view.attempts[0].conflicts[0]).map(([k, v]) => [k, v])), view.attempts[0].conflicts[0])
  assert.equal(view.attempts[0].conflicts[0].claimed, 'completed')
})

test('A08: restart reconciliation marks lost running attempts unknown, never completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp02-exec-'))
  try {
    const first = createExecutionStore({ dir })
    first.open({ taskId: 'task-z', parentId: 'p', backend: 'external' })
    first.settle('task-z', 'task-z#a1', { execution: 'completed' })
    first.open({ taskId: 'task-y', parentId: 'p', backend: 'external' })

    const second = createExecutionStore({ dir })
    const reconciled = second.reconcileAfterRestart('p')
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].taskId, 'task-y')
    const view = second.read('task-y')
    assert.equal(view.execution, 'unknown')
    assert.equal(view.acceptance.state, 'unknown')
    // The completed task was left untouched.
    assert.equal(second.read('task-z').execution, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── A07: unknown/partial visibility in the RoleResult ───────────────────────

test('A07: RoleResult carries usage and cost only when a real record exists', () => {
  const task = { taskId: 't', id: 'c1', status: 'completed', startedAt: null, settledAt: null, result: { diagnostic: 'ok' } }
  const bare = externalRoleResult(task)
  assert.equal(bare.usage, null)
  assert.equal(bare.costUsd, null)
  assert.equal(bare.acceptanceState, 'unknown')
  assert.equal(bare.delivered, false)

  const withLedger = externalRoleResult(task, {
    usage: { uncachedInputTokens: 10, outputTokens: 2 },
    costUsd: 0.004,
    acceptanceState: 'passed',
  })
  assert.equal(withLedger.usage.cacheReadTokens, null)
  assert.equal(withLedger.costUsd, 0.004)
  assert.equal(withLedger.delivered, true)
})
