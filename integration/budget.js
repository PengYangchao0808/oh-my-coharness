/**
 * Budget checkpoints over the usage ledger (0.5.0-alpha.2 WP06).
 *
 * Program counting only: updating a budget never adds a model call. The
 * counts come from booked ledger entries plus in-flight attempt reservations,
 * so a budget survives a restart without double counting (A06 idempotence is
 * the ledger's; reservations are re-derived from the execution store).
 *
 * What a checkpoint may decide is a closed set (V0.5-ALPHA2-PLAN §4.5):
 * continue | shrink-scope | externalize-context | switch-hypothesis |
 * one-bounded-escalation | wait-for-external | stop-partial. Running out of
 * budget never marks a task completed — the caller sees `stop-partial` and
 * keeps the true execution state.
 *
 * Honest limits (A17): maxCalls counts REAL request attempts booked in the
 * ledger (retries included). Hard per-request gating was verified only for
 * the native agent loop (WP00); external/direct lanes get checkpoint verdicts
 * between dispatches, never a "hard cap" promise.
 */

export const BUDGET_VERSION = 1
export const CHECKPOINT_ACTIONS = Object.freeze([
  'continue', 'shrink-scope', 'externalize-context', 'switch-hypothesis',
  'one-bounded-escalation', 'wait-for-external', 'stop-partial',
])

/** Error classes that may justify one bounded model escalation (A20). */
export const ESCALATION_CLASSES = Object.freeze({
  auth: 'never', // a bigger model cannot fix credentials
  quota: 'never', // billing/quota is authorization, not capability
  rate: 'retry-first', // transient: retry the same route before paying more
  network: 'retry-first',
  context: 'may-escalate', // a larger context window is a capability need
  unknown: 'may-escalate', // unclassified failures keep the option, bounded
})

/**
 * Decide one bounded escalation (at most one per task, A20).
 *
 * Authorization beats capability: a paid/billing-unknown target is refused
 * unless `authorized` names it, the task budget must still have room, and an
 * already-used escalation is never repeated. Team size never grows here.
 */
export function decideEscalation({
  failureClass = 'unknown', alreadyEscalated = false, budgetCallsLeft = null,
  authorized = false, targetBilling = 'unknown',
}) {
  const cls = ESCALATION_CLASSES[failureClass] ?? ESCALATION_CLASSES.unknown
  if (alreadyEscalated) {
    return { escalate: false, reason: 'the task already used its one escalation' }
  }
  if (cls === 'never') {
    return { escalate: false, reason: `class "${failureClass}" is authorization/billing, not capability; escalate the authorization, not the model` }
  }
  if (cls === 'retry-first') {
    return { escalate: false, retryFirst: true, reason: `class "${failureClass}" is transient; retry the same route before considering an escalation` }
  }
  if (targetBilling !== 'free' && !authorized) {
    return { escalate: false, reason: `the escalation target's billing is "${targetBilling}" and it is not authorized for this task` }
  }
  if (Number.isSafeInteger(budgetCallsLeft) && budgetCallsLeft <= 0) {
    return { escalate: false, reason: 'the task budget has no room for another attempt' }
  }
  return { escalate: true, reason: `one bounded escalation approved for class "${failureClass}"` }
}

function budgetError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function sumBooked(ledger, parentId, taskId) {
  if (!ledger) return { calls: 0, usd: 0, costKnown: false }
  const totals = ledger.totals({ parentId, ...(taskId ? { taskId } : {}) })
  const calls = totals.entries // one booked entry = one real request attempt
  const usd = totals.costKnown ? totals.costUsd : null
  return { calls, usd, costKnown: totals.costKnown, unknownCost: totals.unknownCost, totals }
}

/**
 * @param {{usageLedger?: object|null, executionStore?: object|null,
 *          maxCalls?: number|null, maxUsd?: number|null}} [options]
 */
export function createBudgetTracker({ usageLedger = null, executionStore = null, maxCalls = null, maxUsd = null } = {}) {
  /** In-flight attempts opened but not yet settled, by `${taskId}#${attemptId}`. */
  const reserved = new Map()

  function inFlightCount(parentId) {
    // Reservations are per tracker (one host process). Cross-process callers
    // read the ledger, which only ever grows by real bookings — a reservation
    // alone is never billed until its entry lands.
    let count = 0
    for (const entry of reserved.values()) {
      if (entry.parentId === parentId) count += 1
    }
    return count
  }

  return {
    /**
     * Reserve one attempt slot before activation. Atomic within the tracker:
     * the last slot under concurrency goes to exactly one reservation, and a
     * refused reservation leaves nothing behind (A17).
     */
    reserveAttempt({ parentId, taskId, attemptId }) {
      if (!parentId || !taskId || !attemptId) {
        throw budgetError('OMC/BUDGET-RESERVE', 'reserveAttempt needs parentId, taskId and attemptId')
      }
      const key = `${taskId}#${attemptId}`
      if (reserved.has(key)) return { reserved: true, duplicate: true }
      if (Number.isSafeInteger(maxCalls) && maxCalls > 0) {
        const { calls } = sumBooked(usageLedger, parentId, null)
        if (calls + inFlightCount(parentId) + 1 > maxCalls) {
          return {
            reserved: false,
            reason: `call budget exhausted: ${calls} booked + ${inFlightCount(parentId)} in flight would exceed maxCalls=${maxCalls}`,
          }
        }
      }
      reserved.set(key, { parentId, taskId, attemptId, at: new Date().toISOString() })
      return { reserved: true, duplicate: false }
    },

    /** Release a reservation at its terminal boundary (settled or failed to start). */
    releaseAttempt(taskId, attemptId) {
      return reserved.delete(`${taskId}#${attemptId}`)
    },

    /**
     * Checkpoint verdict for one task. Program counting only — no model call.
     * @returns {{action: string, budget: object, reasons: string[]}}
     */
    checkpoint({ parentId, taskId, bookedCalls = null }) {
      const booked = sumBooked(usageLedger, parentId, taskId)
      const calls = bookedCalls ?? booked.calls
      const reasons = []
      let action = 'continue'

      if (Number.isSafeInteger(maxCalls) && maxCalls > 0 && calls >= maxCalls) {
        action = 'stop-partial'
        reasons.push(`call budget exhausted: ${calls} of maxCalls=${maxCalls} booked attempts`)
      }
      if (typeof maxUsd === 'number' && maxUsd >= 0 && booked.costKnown && booked.usd !== null && booked.usd >= maxUsd) {
        action = 'stop-partial'
        reasons.push(`cost budget reached: $${booked.usd.toFixed(4)} of maxUsd=${maxUsd} settled`)
      }
      if (booked.unknownCost && action === 'continue') {
        // Unknown cost never blocks by itself (plan §4.2.4), but the verdict
        // says so: the caller cannot claim "within budget".
        reasons.push('cost unknown for at least one attempt; the settled figure is a lower bound')
      }
      if (!CHECKPOINT_ACTIONS.includes(action)) action = 'continue'
      return {
        action,
        budget: {
          maxCalls: maxCalls ?? null,
          maxUsd: maxUsd ?? null,
          callsBooked: calls,
          callsInFlight: inFlightCount(parentId),
          usdSettled: booked.costKnown ? booked.usd : null,
          costKnown: booked.costKnown === true,
          coverage: booked.totals?.coverage ?? 'unknown',
        },
        reasons,
      }
    },

    /** Render the observe-mode note for status surfaces. */
    renderCheckpoint(verdict) {
      const b = verdict.budget
      const parts = [
        `calls ${b.callsBooked}${Number.isSafeInteger(b.maxCalls) ? `/${b.maxCalls}` : ''} booked · ${b.callsInFlight} in flight`,
        b.costKnown ? `cost $${(b.usdSettled ?? 0).toFixed(4)}${b.maxUsd !== null ? ` of $${b.maxUsd}` : ''}` : 'cost unknown (never shown as $0)',
      ]
      return `budget ${verdict.action}: ${parts.join(' · ')}${verdict.reasons.length ? ` — ${verdict.reasons.join('; ')}` : ''}`
    },

    /** Snapshot for diagnostics; reservations are process-local facts. */
    snapshot(parentId) {
      return {
        maxCalls: maxCalls ?? null,
        maxUsd: maxUsd ?? null,
        booked: sumBooked(usageLedger, parentId, null),
        inFlight: [...reserved.values()].filter((entry) => !parentId || entry.parentId === parentId),
      }
    },
  }
}
