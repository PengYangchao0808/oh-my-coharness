/**
 * R01 regressions (0.5.0-alpha.2 practice): the native runtime bridge that puts
 * real host events into the same task and usage records — A05/A06/A08/A13.
 *
 * These tests drive the bridge with host-shaped event streams (the payloads the
 * installed host actually persists) and assert only what the stores can prove:
 * task identity, one booking per source event, real route attribution, honest
 * settlement and a derived parent rollup.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import {
  createNativeRuntime,
  executionFromTurnEnd,
  nativeTaskIdFor,
} from '../../integration/native-runtime.js'

const PARENT = 'parent-root'

/** A host `subagent/descriptor` label carries the role before the first separator. */
const roleFromDescriptor = (event) => {
  const label = event?.data?.label
  return typeof label === 'string' && label.includes('|') ? label.slice(0, label.indexOf('|')) : null
}

function host({ roleReader = roleFromDescriptor } = {}) {
  const ledger = createUsageLedger()
  const executionStore = createExecutionStore()
  const runtime = createNativeRuntime({ usageLedger: ledger, executionStore, roleFromDescriptor: roleReader })
  return { ledger, executionStore, runtime }
}

const header = (provider, model, effort = 'high') => ({
  header: { config: { provider, model, reasoningEffort: effort } },
})

/** The event stream the host persists for one native turn. */
function turn({ turn: turnNumber, provider, model, usage, failedAttempt = false }) {
  return [
    { type: 'request/header', seq: 10 + turnNumber * 10, data: header(provider, model) },
    ...(failedAttempt ? [{ type: 'assistant/attempt', seq: 11 + turnNumber * 10, data: { turn: turnNumber, step: 1 } }] : []),
    {
      type: 'assistant/message',
      seq: 12 + turnNumber * 10,
      data: { turn: turnNumber, step: 1, usage, message: { source: { provider, model } } },
    },
    { type: 'turn/end', seq: 13 + turnNumber * 10, data: { turn: turnNumber, reason: { kind: 'completed' } } },
  ]
}

test('R01: a root session and two native children land on the right parent and task', () => {
  const { runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })

  const root = { id: 's-root', header: {} }
  for (const event of turn({ turn: 1, provider: 'deepseek', model: 'deepseek-v4', usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 0 } })) {
    runtime.observe(root, event)
  }

  // Two children spawned by the host's own subagent tool: lineage comes from
  // the session header the host persists, never from a guess.
  const fixer = { id: 's-fixer', header: { parentSession: 's-root' } }
  runtime.observe(fixer, { type: 'subagent/descriptor', seq: 1, data: { label: 'fixer|patch-mode' } })
  runtime.observe(fixer, { type: 'request/header', seq: 2, data: header('openai', 'gpt-x') })
  runtime.observe(fixer, {
    type: 'assistant/message',
    seq: 3,
    data: { turn: 1, step: 1, usage: { inputTokens: 50, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 0 } },
  })
  runtime.observe(fixer, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })

  const explorer = { id: 's-explorer', header: { parentSession: 's-root' } }
  runtime.observe(explorer, { type: 'subagent/descriptor', seq: 1, data: { label: 'explorer|recon' } })
  runtime.observe(explorer, { type: 'request/header', seq: 2, data: header('deepseek', 'deepseek-v4') })
  runtime.observe(explorer, {
    type: 'assistant/message',
    seq: 3,
    data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 2 } },
  })
  runtime.observe(explorer, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'aborted' } } })

  const fixerBinding = runtime.bindingFor('s-fixer')
  assert.equal(fixerBinding.parentId, PARENT)
  assert.equal(fixerBinding.parentTaskId, nativeTaskIdFor('s-root'))
  assert.equal(fixerBinding.role, 'fixer')
  assert.equal(fixerBinding.source, 'derived')

  const explorerBinding = runtime.bindingFor('s-explorer')
  assert.equal(explorerBinding.parentId, PARENT)
  assert.equal(explorerBinding.role, 'explorer')

  // A nested child is attributed through its own parent, up to the same root.
  const nested = { id: 's-nested', header: { parentSession: 's-fixer' } }
  runtime.observe(nested, { type: 'request/header', seq: 1, data: header('openai', 'gpt-x') })
  runtime.observe(nested, {
    type: 'assistant/message',
    seq: 2,
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } },
  })
  assert.equal(runtime.bindingFor('s-nested').parentId, PARENT)
  assert.equal(runtime.bindingFor('s-nested').parentTaskId, fixerBinding.taskId)
})

test('R01: route comes from the request header, so a model switch is visible per entry', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const root = { id: 's-root', header: {} }

  runtime.observe(root, { type: 'request/header', seq: 1, data: header('deepseek', 'deepseek-v4') })
  runtime.observe(root, { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } })
  runtime.observe(root, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })

  runtime.observe(root, { type: 'request/header', seq: 4, data: header('zai-coding-cn', 'glm-5.3') })
  runtime.observe(root, { type: 'assistant/message', seq: 5, data: { turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 2 } } })
  runtime.observe(root, { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } })

  const rows = ledger.entries({ parentId: PARENT })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].route.provider, 'deepseek')
  assert.equal(rows[0].route.model, 'deepseek-v4')
  assert.equal(rows[1].route.provider, 'zai-coding-cn')
  assert.equal(rows[1].route.model, 'glm-5.3')
  assert.equal(rows[1].route.effort, 'high')
  assert.equal(rows[0].route.observed, true)
})

test('R01: a failed attempt without usage is booked as unknown, never as zero', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const root = { id: 's-root', header: {} }

  for (const event of turn({ turn: 1, provider: 'deepseek', model: 'deepseek-v4', usage: { inputTokens: 9, outputTokens: 2 }, failedAttempt: true })) {
    runtime.observe(root, event)
  }

  const rows = ledger.entries({ parentId: PARENT })
  assert.equal(rows.length, 2, 'one entry for the failed attempt, one for the settled message')

  const failed = rows.find((row) => row.usage.uncachedInputTokens === null)
  assert.ok(failed, 'the failed attempt row exists')
  assert.equal(failed.coverage, 'unknown')
  assert.equal(failed.usage.outputTokens, null)
  assert.equal(failed.cost, null)
  assert.equal(failed.route.model, 'deepseek-v4', 'the failed attempt still carries the route it ran on')

  const settled = rows.find((row) => row.usage.uncachedInputTokens === 9)
  assert.ok(settled)
  assert.equal(settled.coverage, 'partial', 'a chunk that reports no cache buckets stays partial, not complete')
  assert.equal(settled.usage.cacheReadTokens, null)
  assert.equal(settled.usage.outputTokens, 2)
  assert.notEqual(failed.key, settled.key)
})

test('R01: retry and cancel settle the attempt without claiming acceptance', () => {
  const { executionStore, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const root = { id: 's-root', header: {} }

  runtime.observe(root, { type: 'request/header', seq: 1, data: header('deepseek', 'deepseek-v4') })
  runtime.observe(root, { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 1 } })
  runtime.observe(root, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMITED' } } } })

  const afterFailure = executionStore.read(nativeTaskIdFor('s-root'))
  assert.equal(afterFailure.execution, 'failed')
  assert.equal(afterFailure.attempts.length, 1)
  assert.equal(afterFailure.acceptance.state, 'unknown', 'execution settled, acceptance untouched')
  assert.equal(afterFailure.delivered, false)

  // The retry opens a new attempt under the same task and is then cancelled.
  runtime.observe(root, { type: 'request/header', seq: 4, data: header('deepseek', 'deepseek-v4') })
  runtime.observe(root, { type: 'assistant/message', seq: 5, data: { turn: 2, step: 1, usage: { inputTokens: 4, outputTokens: 1 } } })
  runtime.observe(root, { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'aborted', reason: 'user cancel' } } })

  const afterCancel = executionStore.read(nativeTaskIdFor('s-root'))
  assert.equal(afterCancel.attempts.length, 2, 'the retry is a new attempt, not a new task')
  assert.equal(afterCancel.execution, 'cancelled')
  assert.equal(afterCancel.delivered, false)

  assert.deepEqual(executionFromTurnEnd({ kind: 'max-tokens' }), { execution: 'failed', stopReason: 'max-tokens' })
  assert.deepEqual(executionFromTurnEnd({ kind: 'something-new' }), { execution: 'unknown', stopReason: 'something-new' })
})

test('R01: duplicate delivery and restart replay never bill twice', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const root = { id: 's-root', header: {} }
  const events = turn({ turn: 1, provider: 'deepseek', model: 'deepseek-v4', usage: { inputTokens: 11, outputTokens: 3 } })

  for (const event of events) runtime.observe(root, event)
  const booked = ledger.entries({ parentId: PARENT })
  assert.equal(booked.length, 1)

  // Same event delivered again (double listener, re-entrant host emit).
  const messageEvent = events.find((event) => event.type === 'assistant/message')
  const duplicate = runtime.observe(root, messageEvent)
  assert.equal(duplicate.booked[0].duplicate, true)
  assert.equal(ledger.entries({ parentId: PARENT }).length, 1)

  // Restart replay of the same durable session log.
  const replay = runtime.ingest({ sessionId: 's-root', events })
  assert.equal(replay.filter((result) => result.kind === 'assistant/message').length, 1)
  assert.equal(ledger.entries({ parentId: PARENT }).length, 1, 'a replay after a live run adds nothing')
  assert.equal(runtime.stats().booked, 1)
  assert.equal(runtime.stats().duplicates, 2)
})

test('R01: an event without a durable seq is refused instead of booked under a placeholder', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const result = runtime.observe(
    { id: 's-root', header: {} },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
  )
  assert.deepEqual(result.booked, [])
  assert.equal(ledger.entries({ parentId: PARENT }).length, 0)
  assert.equal(runtime.diagnostics().stats.handlerErrors, 1)
})

test('R01: sessions nobody bound are not adopted', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })

  const other = { id: 's-other', header: { parentSession: 's-other-root' } }
  const result = runtime.observe(other, {
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, usage: { inputTokens: 999, outputTokens: 9 } },
  })
  assert.equal(result.kind, 'unbound')
  assert.equal(ledger.entries({ parentId: PARENT }).length, 0)
  assert.equal(runtime.bindingFor('s-other'), null)
  assert.equal(runtime.diagnostics().stats.unboundSessions, 1)

  // And a session cannot be silently moved to another parent.
  assert.throws(
    () => runtime.bind({ sessionId: 's-other', parentId: 'somebody-else', parentSessionId: 's-root' })
      && runtime.bind({ sessionId: 's-root', parentId: 'somebody-else' }),
    /OMC\/NATIVE-BIND-CONFLICT/,
  )
})

test('R01: the parent rollup is derived and equals its tasks, never a second booking', () => {
  const { ledger, runtime } = host()
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  runtime.observe({ id: 's-root', header: {} }, { type: 'request/header', seq: 1, data: header('deepseek', 'deepseek-v4') })
  runtime.observe(
    { id: 's-root', header: {} },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 } } },
  )
  runtime.observe({ id: 's-child', header: { parentSession: 's-root' } }, { type: 'request/header', seq: 1, data: header('openai', 'gpt-x') })
  runtime.observe(
    { id: 's-child', header: { parentSession: 's-root' } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 4 } } },
  )

  const summary = runtime.summary({ parentId: PARENT })
  assert.equal(summary.derived, true)
  assert.equal(summary.entries, 2)
  assert.equal(summary.tasks.length, 2)
  assert.equal(summary.totals.sums.uncachedInputTokens, 140)
  assert.equal(summary.totals.sums.outputTokens, 14)
  assert.equal(ledger.entries({ parentId: PARENT }).length, 2, 'the rollup did not append anything')
  assert.equal(summary.totals.coverage, 'partial', 'a missing cost keeps the rollup from claiming completeness')

  const routes = summary.tasks.flatMap((task) => task.routes).sort()
  assert.deepEqual(routes, ['deepseek/deepseek-v4/high', 'openai/gpt-x/high'])
})

test('R01: a top-level session of the owned preset becomes its own parent; others are left alone', () => {
  const ledger = createUsageLedger()
  const runtime = createNativeRuntime({
    usageLedger: ledger,
    executionStore: createExecutionStore(),
    roleFromDescriptor,
    ownPreset: 'oh-my-coharness',
  })
  const handlers = {}
  runtime.install({
    on: (event, handler) => {
      handlers[event] = handler
      return () => {}
    },
    effect: (register) => register(),
  })

  const own = handlers['agent/created']({
    agent: { id: 'agent-own', session: { id: 's-own', header: { agentPreset: 'oh-my-coharness' } } },
  })
  assert.equal(own.kind, 'agent/created')
  assert.equal(own.autoRoot, true)
  assert.equal(runtime.bindingFor('s-own').parentId, 'agent-own')

  handlers['session/event'](
    { id: 's-own', header: { agentPreset: 'oh-my-coharness' } },
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } },
  )
  assert.equal(ledger.entries({ parentId: 'agent-own' }).length, 1, 'the owned root now books its usage')

  // A session of another preset is never adopted, even at top level.
  const foreign = handlers['agent/created']({
    agent: { id: 'agent-x', session: { id: 's-x', header: { agentPreset: 'some-other-preset' } } },
  })
  assert.equal(foreign.kind, 'unbound')
  assert.equal(runtime.bindingFor('s-x'), null)
  handlers['session/event'](
    { id: 's-x', header: { agentPreset: 'some-other-preset' } },
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 1 } } },
  )
  assert.equal(ledger.entries({ parentId: 'agent-x' }).length, 0)

  // A child of the owned root is attributed by lineage, not by its own preset.
  const child = handlers['agent/created']({
    agent: { id: 'agent-child', session: { id: 's-child', header: { parentSession: 's-own', agentPreset: 'oh-my-coharness' } } },
  })
  assert.equal(child.kind, 'agent/created')
  assert.equal(runtime.bindingFor('s-child').parentId, 'agent-own')
})

test('R01: installing twice does not register a second pair of listeners', () => {
  const { runtime } = host()
  const handlers = []
  const ctx = {
    on(event, handler) {
      handlers.push({ event, handler })
      return () => {}
    },
    effect(register) {
      return register()
    },
  }
  const first = runtime.install(ctx)
  const second = runtime.install(ctx)
  assert.equal(first.installed, true)
  assert.equal(second.alreadyInstalled, true)
  assert.equal(handlers.length, 2, 'one session/event plus one agent/created listener')
  assert.deepEqual(handlers.map((entry) => entry.event).sort(), ['agent/created', 'session/event'])

  // The installed handlers are the bridge itself.
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const sessionHandler = handlers.find((entry) => entry.event === 'session/event').handler
  sessionHandler({ id: 's-root', header: {} }, { type: 'request/header', seq: 1, data: header('deepseek', 'deepseek-v4') })
  assert.equal(runtime.diagnostics().stats.events, 1)

  runtime.dispose()
  assert.equal(runtime.diagnostics().installed, false)
})

test('R01: a handler failure is contained, never thrown into the host loop', () => {
  const ledger = {
    append() {
      throw new Error('disk full')
    },
    entries: () => [],
    totals: () => ({}),
  }
  const runtime = createNativeRuntime({ usageLedger: ledger, roleFromDescriptor })
  runtime.bindRoot({ sessionId: 's-root', parentId: PARENT })
  const result = runtime.observe(
    { id: 's-root', header: {} },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
  )
  assert.equal(result.kind, 'assistant/message')
  assert.deepEqual(result.booked, [])
  assert.equal(runtime.diagnostics().stats.handlerErrors, 1)
})
