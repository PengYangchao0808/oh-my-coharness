/**
 * WP06 regressions (0.5.0-alpha.2): budget checkpoints, no-progress
 * assessment and bounded escalation — A17–A20.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createBudgetTracker, decideEscalation } from '../../integration/budget.js'
import { createProgressTracker } from '../../integration/progress.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { resolveConfig } from '../../src/config.js'

function bookCall(ledger, { parentId = 'p', taskId = 't', n = 1, usd = null }) {
  for (let i = 0; i < n; i += 1) {
    ledger.append({
      parentId, taskId, attemptId: `${taskId}#a${i + 1}`, backend: 'native',
      source: { kind: 'dsh-session', sessionId: 's', seq: i + 1 },
      usage: { uncachedInputTokens: 10, outputTokens: 1 },
      ...(usd !== null ? { cost: { usd, source: 'price-table@t', priceVersion: 'v1' } } : {}),
    })
  }
}

// ── A17: reservation + accounting ───────────────────────────────────────────

test('A17: the last call slot goes to exactly one concurrent reservation', () => {
  const ledger = createUsageLedger({})
  bookCall(ledger, { n: 2 })
  const tracker = createBudgetTracker({ usageLedger: ledger, maxCalls: 3 })
  const first = tracker.reserveAttempt({ parentId: 'p', taskId: 't', attemptId: 't#a3' })
  assert.equal(first.reserved, true)
  // The third booked call plus one in flight already fills maxCalls=3.
  const second = tracker.reserveAttempt({ parentId: 'p', taskId: 't', attemptId: 't#a4' })
  assert.equal(second.reserved, false)
  assert.match(second.reason, /call budget exhausted/)
  // Re-requesting the SAME attempt is idempotent, not a new slot.
  const sameAgain = tracker.reserveAttempt({ parentId: 'p', taskId: 't', attemptId: 't#a3' })
  assert.equal(sameAgain.duplicate, true)
  // Releasing the reservation frees the slot.
  assert.equal(tracker.releaseAttempt('t', 't#a3'), true)
  const afterRelease = tracker.reserveAttempt({ parentId: 'p', taskId: 't', attemptId: 't#a4' })
  assert.equal(afterRelease.reserved, true)
})

test('A17: a checkpoint counts booked attempts from the ledger, program-only', () => {
  const ledger = createUsageLedger({})
  bookCall(ledger, { n: 4 })
  const tracker = createBudgetTracker({ usageLedger: ledger, maxCalls: 4 })
  const verdict = tracker.checkpoint({ parentId: 'p', taskId: 't' })
  assert.equal(verdict.action, 'stop-partial')
  assert.equal(verdict.budget.callsBooked, 4)
  assert.match(verdict.reasons.join(' '), /maxCalls=4/)
  assert.match(tracker.renderCheckpoint(verdict), /stop-partial/)
  // stop-partial is a decision for the caller; nothing here is "completed".
})

test('A17: unknown cost is visible and never zero; settled cost gates on maxUsd', () => {
  const ledger = createUsageLedger({})
  bookCall(ledger, { n: 1 }) // no cost booked
  const tracker = createBudgetTracker({ usageLedger: ledger, maxUsd: 1 })
  const unknown = tracker.checkpoint({ parentId: 'p', taskId: 't' })
  assert.equal(unknown.action, 'continue')
  assert.equal(unknown.budget.costKnown, false)
  assert.match(unknown.reasons.join(' '), /cost unknown/)

  const pricedLedger = createUsageLedger({})
  bookCall(pricedLedger, { n: 2, usd: 0.6 })
  const priced = createBudgetTracker({ usageLedger: pricedLedger, maxUsd: 1 })
  const verdict = priced.checkpoint({ parentId: 'p', taskId: 't' })
  assert.equal(verdict.action, 'stop-partial')
  assert.ok(verdict.budget.usdSettled >= 1.19)
})

// ── A19: no-progress over combined signals ──────────────────────────────────

test('A19: repeated identical calls with no movement stall; changes and waits do not', () => {
  const tracker = createProgressTracker({ repeatWindow: 6, repeatThreshold: 3 })
  const args = { command: 'npm test' }
  for (let i = 0; i < 3; i += 1) tracker.observe('lane', { kind: 'call', args })
  const stalled = tracker.assess('lane')
  assert.equal(stalled.stalled, true)
  assert.match(stalled.explanation, /identical call fingerprint/)
  assert.match(tracker.render(stalled), /progress warning/)

  // A code change between the repeats makes them post-change retries.
  const moving = createProgressTracker({ repeatWindow: 6, repeatThreshold: 3 })
  moving.observe('lane2', { kind: 'call', args })
  moving.observe('lane2', { kind: 'code-change' })
  moving.observe('lane2', { kind: 'call', args })
  moving.observe('lane2', { kind: 'call', args })
  assert.equal(moving.assess('lane2').stalled, false)

  // Declared async waits are legitimate polling.
  const waiting = createProgressTracker({ repeatWindow: 6, repeatThreshold: 3 })
  for (let i = 0; i < 3; i += 1) {
    waiting.observe('lane3', { kind: 'wait', note: 'build finishing' })
    waiting.observe('lane3', { kind: 'call', args })
  }
  assert.equal(waiting.assess('lane3').stalled, false)

  // A changed failing-test set is movement.
  const testing = createProgressTracker({ repeatWindow: 8, repeatThreshold: 3 })
  testing.observe('lane4', { kind: 'call', args })
  testing.observe('lane4', { kind: 'test-set', failing: ['a.test', 'b.test'] })
  testing.observe('lane4', { kind: 'call', args })
  testing.observe('lane4', { kind: 'test-set', failing: ['a.test'] })
  testing.observe('lane4', { kind: 'call', args })
  assert.equal(testing.assess('lane4').stalled, false)

  // Different arguments are different work.
  const varied = createProgressTracker({ repeatWindow: 6, repeatThreshold: 3 })
  varied.observe('lane5', { kind: 'call', args: { command: 'a' } })
  varied.observe('lane5', { kind: 'call', args: { command: 'b' } })
  varied.observe('lane5', { kind: 'call', args: { command: 'c' } })
  assert.equal(varied.assess('lane5').stalled, false)
})

test('A19: observing never needs a model call and rejects unknown kinds', () => {
  const tracker = createProgressTracker({})
  assert.throws(() => tracker.observe('lane', { kind: 'magic' }), /OMC\/PROGRESS-SIGNAL/)
  tracker.observe('lane', { kind: 'fact-change' })
  assert.equal(tracker.snapshot('lane').changeSeq, 1)
})

// ── A20: one bounded escalation under error class and authorization ─────────

test('A20: escalation follows class rules, one shot, authorization and budget', () => {
  // Authorization/billing classes never escalate.
  assert.equal(decideEscalation({ failureClass: 'auth' }).escalate, false)
  assert.match(decideEscalation({ failureClass: 'quota' }).reason, /authorization, not the model/)
  // Transient classes retry first.
  const rate = decideEscalation({ failureClass: 'rate' })
  assert.equal(rate.escalate, false)
  assert.equal(rate.retryFirst, true)
  // Capability class escalates once, under authorization and budget.
  assert.equal(decideEscalation({ failureClass: 'context', authorized: true, targetBilling: 'api' }).escalate, true)
  assert.equal(decideEscalation({ failureClass: 'context', authorized: false, targetBilling: 'api' }).escalate, false)
  assert.match(decideEscalation({ failureClass: 'context', authorized: false, targetBilling: 'api' }).reason, /not authorized/)
  assert.equal(decideEscalation({ failureClass: 'context', authorized: true, alreadyEscalated: true }).escalate, false)
  assert.match(decideEscalation({ failureClass: 'context', authorized: true, alreadyEscalated: true }).reason, /one escalation/)
  assert.equal(decideEscalation({ failureClass: 'context', authorized: true, budgetCallsLeft: 0 }).escalate, false)
})

// ── efficiency config plumbing (§2) ─────────────────────────────────────────

test('the efficiency config validates bounds and defaults to observe', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.efficiency.mode, 'observe')
  assert.equal(cfg.efficiency.team.maxActiveWorkers, 2)
  assert.equal(cfg.efficiency.checkpoints.fixerSteps, 40)
  assert.equal(cfg.efficiency.budget.maxCalls, null)

  const weird = resolveConfig({ efficiency: { mode: 'strict', checkpoints: { fixerSteps: 99999 }, budget: { maxCalls: -3 }, progress: { repeatThreshold: 99 } } })
  assert.equal(weird.efficiency.mode, 'observe', 'an unknown mode falls back to the upgrade default')
  assert.equal(weird.efficiency.checkpoints.fixerSteps, 1000)
  assert.equal(weird.efficiency.budget.maxCalls, null)
  assert.equal(weird.efficiency.progress.repeatThreshold, 10, 'numeric bounds clamp rather than reject')
})
