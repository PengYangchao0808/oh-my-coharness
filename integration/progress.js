/**
 * No-progress detection over combined signals (0.5.0-alpha.2 WP06).
 *
 * Repeating the same call with no world change is a signal, never a verdict
 * (V0.5-ALPHA2-PLAN §4.5). The assessment combines:
 *   - call-argument fingerprints (similarity within a window),
 *   - code/artifact change events,
 *   - failing-test set changes,
 *   - verified-fact changes,
 * and it explicitly separates legitimate progress that must NOT be flagged:
 * asynchronous polling declared as waits, and retries taken AFTER a change.
 *
 * Pure bookkeeping: observing never costs a model call, and the output is an
 * explanation the orchestrator (or a human) can act on — not an automatic kill.
 */

import { createHash } from 'node:crypto'

export const PROGRESS_VERSION = 1
export const PROGRESS_SIGNALS = Object.freeze(['call', 'code-change', 'artifact-change', 'test-set', 'fact-change'])

function progressError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

export function callFingerprint(args) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().map((key) => [key, stable(value[key])])
    }
    return value ?? null
  }
  return createHash('sha256').update(JSON.stringify(stable(args))).digest('hex').slice(0, 16)
}

/**
 * @param {{repeatWindow?: number, repeatThreshold?: number}} [options]
 */
export function createProgressTracker({ repeatWindow = 6, repeatThreshold = 3 } = {}) {
  /** Ordered observations per lane/task key. */
  const lanes = new Map()

  function laneOf(key) {
    let lane = lanes.get(key)
    if (!lane) {
      lane = { observations: [], changeSeq: 0, waits: 0 }
      lanes.set(key, lane)
    }
    return lane
  }

  return {
    /**
     * Record one observation.
     * @param {object} input
     * `kind` selects the signal: 'call' (with `fingerprint` or `args`),
     * 'code-change'/'artifact-change' (the world changed), 'test-set'
     * (the failing set, compared as a set), 'fact-change', or 'wait'
     * (declared asynchronous waiting — legitimate polling).
     */
    observe(key, input = {}) {
      const lane = laneOf(key)
      const kind = PROGRESS_SIGNALS.includes(input.kind) ? input.kind : input.kind === 'wait' ? 'wait' : null
      if (!kind) throw progressError('OMC/PROGRESS-SIGNAL', `unknown observation kind "${input.kind}"`)
      const entry = {
        kind,
        at: new Date().toISOString(),
        ...(kind === 'call' ? { fingerprint: typeof input.fingerprint === 'string' ? input.fingerprint : callFingerprint(input.args) } : {}),
        ...(kind === 'test-set' ? { failing: [...new Set(Array.isArray(input.failing) ? input.failing.map(String) : [])].sort() } : {}),
        ...(input.note ? { note: String(input.note).slice(0, 200) } : {}),
      }
      if (kind === 'code-change' || kind === 'artifact-change' || kind === 'fact-change') {
        lane.changeSeq += 1
      }
      if (kind === 'wait') lane.waits += 1
      lane.observations.push(entry)
      if (lane.observations.length > 200) lane.observations.splice(0, lane.observations.length - 200)
      return entry
    },

    /**
     * Assess the tail of one lane. `stalled: true` means "the last
     * `repeatThreshold` calls inside the window repeat a fingerprint AND no
     * change/fact/test movement happened between them" — plus an explanation
     * of exactly which signals said so (A19).
     */
    assess(key, { window = repeatWindow, threshold = repeatThreshold } = {}) {
      const lane = laneOf(key)
      const tail = lane.observations.slice(-Math.max(2, window))
      const calls = tail.filter((entry) => entry.kind === 'call')
      const changes = tail.filter((entry) => entry.kind === 'code-change' || entry.kind === 'artifact-change' || entry.kind === 'fact-change')
      const waits = tail.filter((entry) => entry.kind === 'wait')
      const testSets = tail.filter((entry) => entry.kind === 'test-set')

      if (calls.length < threshold) {
        return {
          stalled: false,
          signals: { calls: calls.length, changes: changes.length, waits: waits.length },
          explanation: `only ${calls.length} call(s) in the window; the repeat threshold is ${threshold}`,
        }
      }

      const lastCalls = calls.slice(-threshold)
      const fingerprints = new Set(lastCalls.map((entry) => entry.fingerprint))
      const repeated = fingerprints.size === 1

      // A change observed AFTER the first of the repeating calls means those
      // calls were post-change retries: legitimate progress, not a loop.
      const firstRepeatAt = tail.indexOf(lastCalls[0])
      const changeAfterStart = tail.slice(firstRepeatAt).some((entry) =>
        entry.kind === 'code-change' || entry.kind === 'artifact-change' || entry.kind === 'fact-change')

      // A failing-test set that changed between repeats is movement too.
      let testSetMoved = false
      if (testSets.length >= 2) {
        const sets = testSets.map((entry) => entry.failing.join('|'))
        testSetMoved = new Set(sets).size > 1
      }

      if (repeated && !changeAfterStart && !testSetMoved && waits.length === 0) {
        return {
          stalled: true,
          signals: {
            calls: calls.length,
            repeatedFingerprint: lastCalls[0].fingerprint,
            repeats: threshold,
            changes: changes.length,
            waits: waits.length,
          },
          explanation:
            `${threshold} identical call fingerprint(s) with no code/artifact/fact change and no test-set movement in between; ` +
            'this is a signal to investigate, not a verdict — the checkpoint action decides',
        }
      }
      return {
        stalled: false,
        signals: { calls: calls.length, changes: changes.length, waits: waits.length, repeated: repeated || undefined },
        explanation: !repeated
          ? 'the recent calls differ (arguments changed)'
          : changeAfterStart
            ? 'a world change preceded the repeats: these are post-change retries, not a loop'
            : testSetMoved
              ? 'the failing-test set changed between repeats'
              : 'declared asynchronous waits dominate the window: legitimate polling',
      }
    },

    /** Observe-mode rendering for status surfaces. */
    render(verdict) {
      return verdict.stalled
        ? `progress warning: ${verdict.explanation}`
        : `progress ok: ${verdict.explanation}`
    },

    snapshot(key) {
      const lane = lanes.get(key)
      return lane ? { observations: lane.observations.slice(-repeatWindow), changeSeq: lane.changeSeq } : { observations: [], changeSeq: 0 }
    },
  }
}
