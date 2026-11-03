/**
 * R05 (partial) regressions: the runtime footnotes behind `/coharness status`.
 *
 * These lines are the only place a reader can see what actually happened —
 * bridge installed or not, gate enforcing or advisory, the current budget view,
 * managed vs unmanaged coverage. They are built from durable records, so the
 * test drives them with stand-in stores instead of a live host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { runtimeFootnotes } from '../../src/index.js'
import { createRequestGate } from '../../integration/request-gate.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'

function rtWith({ enforce = 'auto', maxCalls = null, unboundUsage = 0, diagnostics = {}, withUsage = false } = {}) {
  const ledger = createUsageLedger()
  if (withUsage) {
    ledger.append({
      parentId: 'parent-status', taskId: 'task-1', attemptId: 'task-1#a1', backend: 'native',
      source: { kind: 'dsh-session', sessionId: 'session-1', seq: 1 },
      route: { provider: 'deepseek', model: 'deepseek-v4', observed: true },
      usage: { uncachedInputTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 9 },
    })
  }
  const gate = createRequestGate({ usageLedger: ledger })
  return {
    cfg: { efficiency: { mode: 'observe', budget: { maxCalls, maxUsd: null, perTaskCalls: null, enforce } } },
    requestGate: gate,
    usageLedger: ledger,
    native: {
      diagnostics: () => ({
        installed: true,
        bindings: 2,
        stats: { booked: 7, unboundSessions: 1, unboundUsage },
        ...diagnostics,
      }),
    },
    nativeManaged: {
      coverage: () => ({ nodes: 3, boundNative: 1 }),
    },
    statusParentId: 'parent-status',
  }
}

test('R05: the footnotes report the bridge, the gate and the current budget', () => {
  const lines = runtimeFootnotes(rtWith({ maxCalls: 5 }))
  const text = lines.join('\n')
  assert.match(text, /— runtime —/)
  assert.match(text, /native bridge: installed · 2 binding\(s\) · booked 7/)
  assert.match(text, /budget gate: enforcing · maxCalls 5/)
  assert.match(text, /budget now: budget ok:/)
  assert.match(text, /managed coverage: 1 bound native child\(ren\) of 3 node\(s\)/)
})

test('R05: an advisory gate and unbound usage are visible, never silently green', () => {
  const advisory = runtimeFootnotes(rtWith({ enforce: false, unboundUsage: 3 })).join('\n')
  assert.match(advisory, /budget gate: advisory/)
  assert.match(advisory, /3 UNBOUND USAGE event\(s\)/, 'usage nobody could attribute must be loud')

  const missing = runtimeFootnotes({
    cfg: { efficiency: { budget: {} } },
    native: { diagnostics: () => ({ installed: false, bindings: 0, stats: {} }) },
  }).join('\n')
  assert.match(missing, /native bridge: NOT installed/)
  assert.doesNotMatch(missing, /managed coverage/, 'no parent means no per-parent coverage claim')
})

test('R05: the four usage buckets are shown separately, and an unknown cost is never $0', () => {
  const text = runtimeFootnotes(rtWith({ maxCalls: 5, withUsage: true })).join('\n')
  assert.match(text, /usage \(this parent\): in 120 · cache read 30 · cache write 0 · out 9 · 1 request\(s\)/)
  assert.match(text, /cost unknown \(never \$0\)/, 'no price was booked, so the cost is unknown')
  assert.match(text, /coverage partial/)

  // With no bookings at all the line says so instead of printing zero tokens
  // or a zero cost.
  const empty = runtimeFootnotes(rtWith({ maxCalls: 5 })).join('\n')
  assert.match(empty, /usage \(this parent\): no requests booked yet · nothing to show \(never a zero-cost claim\)/)
  assert.doesNotMatch(empty, /out 0/)
})
