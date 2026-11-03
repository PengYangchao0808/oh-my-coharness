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

function rtWith({ enforce = 'auto', maxCalls = null, unboundUsage = 0, diagnostics = {} } = {}) {
  const ledger = createUsageLedger()
  const gate = createRequestGate({ usageLedger: ledger })
  return {
    cfg: { efficiency: { mode: 'observe', budget: { maxCalls, maxUsd: null, perTaskCalls: null, enforce } } },
    requestGate: gate,
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
