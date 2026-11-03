/**
 * Per-request budget gate with a cross-process reservation (0.5.0-alpha.2 R02).
 *
 * The WP06 tracker could only *advise*: its reservations lived in one process's
 * Map, so two host processes could both believe the last call slot was free.
 * This module is the authority:
 *
 *   booked   ledger entries for the parent (one entry ≈ one real request attempt)
 *   inflight a reservation written before a send, released only at a terminal boundary
 *   unknown  a send that happened but whose result never arrived — it keeps its
 *            slot instead of being refunded on a guess
 *
 * Decisions happen INSIDE the shared file lock, over fresh input: the ledger is
 * re-read and the reservation file is re-read on every decision, so "booked +
 * in flight < cap" is evaluated against the same snapshot for every contender.
 *
 * The three identities stay separate (R02 §1):
 *   executionAttemptId  one task execution (many model calls)
 *   modelRequestId      one real send attempt, retries included ← the unit here
 *   sourceEventId       the returned event, used by the ledger for de-duplication
 *
 * Honest limits:
 *   - `maxUsd` blocks only on *known* cost. Unknown cost never blocks by itself
 *     (a lower bound is not a bill), and the verdict says so.
 *   - An `unknown` reservation is never silently released. `releaseUnknown()`
 *     requires a caller-supplied reason/evidence and is audited in the file.
 *   - External CLIs are gated between dispatches only; the caller must not
 *     present their caps as a hard per-call limit (see `hard` in `budgetView`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const REQUEST_GATE_VERSION = 1
export const RESERVATION_STATES = Object.freeze(['inflight', 'booked', 'unknown', 'refused'])
/** Reservations that still hold a slot. `booked` is already in the ledger. */
const SLOT_HOLDING = new Set(['inflight', 'unknown'])

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(temp, file)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      rmSync(file, { force: true })
      renameSync(temp, file)
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* consumed by rename */ }
  }
}

function gateError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Build one model-request id. The counter makes retries of the same
 * (session, turn, step) distinct attempts; the pid keeps two processes from
 * generating the same id for the same step.
 */
export function nextModelRequestId({ taskId, sessionId = 'session', turn = 0, step = 0, counter = 0, pid = process.pid }) {
  const short = String(sessionId).slice(-8)
  return `${taskId}#r${short}:${turn}:${step}:${pid}.${counter}`
}

/**
 * @param {{dir?: string, usageLedger?: object|null, lockTimeoutMs?: number,
 *          ownerPid?: number, now?: () => string}} [options]
 *   `dir` defaults to in-memory (tests/embedded); the Host passes
 *   `<stateRoot>/budget`.
 */
export function createRequestGate({ dir, usageLedger = null, lockTimeoutMs = 10_000, ownerPid = process.pid, now = () => new Date().toISOString() } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  /** @type {Map<string, any>} in-memory backend: parentId → file body */
  const memory = new Map()
  /** monotonic per (taskId, sessionId, turn, step) counters */
  const counters = new Map()

  function fileFor(parentId) {
    return join(dir, safeSegment(parentId, 'parent') + '.json')
  }

  function load(parentId) {
    const empty = {
      schemaVersion: REQUEST_GATE_VERSION,
      parentId,
      reservations: {},
      checkpoint: null,
      releases: [],
      updatedAt: now(),
    }
    if (!durable) return memory.get(parentId) ?? empty
    const file = fileFor(parentId)
    if (!existsSync(file)) return empty
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.schemaVersion !== REQUEST_GATE_VERSION || typeof parsed.reservations !== 'object') return empty
      return { ...empty, ...parsed }
    } catch {
      // A torn file is treated as empty rather than as permissive: the caller
      // still has the ledger, and a checkpoint is re-created on the next stop.
      return empty
    }
  }

  function persist(parentId, body) {
    body.updatedAt = now()
    if (!durable) {
      memory.set(parentId, body)
      return
    }
    atomicWrite(fileFor(parentId), JSON.stringify(body, null, 2) + '\n')
  }

  function underLock(parentId, fn) {
    if (!durable) return fn()
    return withFileLockSync(join(dir, safeSegment(parentId, 'parent')), fn, {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'request-gate',
    })
  }

  function bookedCounts(parentId, { taskId = null } = {}) {
    if (!usageLedger) return { calls: 0, usd: null, costKnown: false, unknownCost: false, coverage: 'unknown' }
    const rows = usageLedger.entries({ parentId, ...(taskId ? { taskId } : {}) })
    const totals = usageLedger.totals({ parentId, ...(taskId ? { taskId } : {}) })
    return {
      calls: rows.length,
      usd: totals.costKnown ? totals.costUsd : null,
      costKnown: totals.costKnown === true,
      unknownCost: totals.unknownCost === true,
      coverage: totals.coverage ?? 'unknown',
    }
  }

  function holding(body, { taskId = null } = {}) {
    const rows = Object.values(body.reservations ?? {}).filter((row) => SLOT_HOLDING.has(row.state))
    const scoped = taskId ? rows.filter((row) => row.taskId === taskId) : rows
    return {
      all: rows.length,
      scoped: scoped.length,
      unknown: rows.filter((row) => row.state === 'unknown').length,
      rows: scoped,
    }
  }

  function view(parentId, limits, body = load(parentId), taskId = null) {
    const booked = bookedCounts(parentId, { taskId })
    const held = holding(body, { taskId })
    const maxCalls = positiveInt(limits.maxCalls)
    const perTaskCalls = positiveInt(limits.perTaskCalls)
    const maxUsd = typeof limits.maxUsd === 'number' && limits.maxUsd >= 0 ? limits.maxUsd : null
    const consumed = booked.calls + held.scoped
    return {
      parentId,
      limits: { maxCalls, perTaskCalls, maxUsd },
      bookedCalls: booked.calls,
      inFlight: held.scoped,
      unknownReservations: held.unknown,
      consumed,
      callsLeft: maxCalls === null ? null : Math.max(0, maxCalls - consumed),
      usdSettled: booked.usd,
      costKnown: booked.costKnown,
      unknownCost: booked.unknownCost,
      coverage: booked.coverage,
      exhausted: (maxCalls !== null && consumed >= maxCalls)
        || (perTaskCalls !== null && taskId !== null && consumed >= perTaskCalls)
        || (maxUsd !== null && booked.costKnown && booked.usd !== null && booked.usd >= maxUsd),
      hard: limits.hard !== false,
      checkpoint: body.checkpoint ?? null,
    }
  }

  function stop(parentId, body, reasons, limits, taskId) {
    const snapshot = view(parentId, limits, body, taskId)
    body.checkpoint = {
      action: 'stop-partial',
      at: now(),
      reasons,
      budget: {
        maxCalls: snapshot.limits.maxCalls,
        perTaskCalls: snapshot.limits.perTaskCalls,
        maxUsd: snapshot.limits.maxUsd,
        bookedCalls: snapshot.bookedCalls,
        inFlight: snapshot.inFlight,
        unknownReservations: snapshot.unknownReservations,
        usdSettled: snapshot.usdSettled,
        costKnown: snapshot.costKnown,
        coverage: snapshot.coverage,
      },
    }
    return body.checkpoint
  }

  return {
    version: REQUEST_GATE_VERSION,

    /** Allocate the next model-request id for a step. Pure bookkeeping. */
    nextRequestId({ taskId, sessionId = 'session', turn = 0, step = 0 }) {
      const key = `${taskId}|${sessionId}|${turn}|${step}`
      const counter = (counters.get(key) ?? 0) + 1
      counters.set(key, counter)
      return nextModelRequestId({ taskId, sessionId, turn, step, counter, pid: ownerPid })
    },

    /**
     * Reserve one real send slot. The whole decision runs under the shared
     * lock over fresh numbers, so two processes racing for the last slot cannot
     * both win.
     *
     * @returns {{allowed: boolean, code?: string, reason?: string,
     *            reservation?: object, budget: object}}
     */
    reserve({ parentId, taskId, attemptId = null, modelRequestId, limits = {}, source = {} } = {}) {
      if (typeof parentId !== 'string' || parentId === '') throw gateError('OMC/GATE-INPUT', 'reserve needs parentId')
      if (typeof taskId !== 'string' || taskId === '') throw gateError('OMC/GATE-INPUT', 'reserve needs taskId')
      if (typeof modelRequestId !== 'string' || modelRequestId === '') throw gateError('OMC/GATE-INPUT', 'reserve needs modelRequestId')

      return underLock(parentId, () => {
        const body = load(parentId)
        const existing = body.reservations[modelRequestId]
        if (existing && SLOT_HOLDING.has(existing.state)) {
          // Same request id reserved twice (re-entrant listener, replay): the
          // slot is already held; this is not a second send.
          return { allowed: true, duplicate: true, reservation: { ...existing }, budget: view(parentId, limits, body, taskId) }
        }

        const budget = view(parentId, limits, body, taskId)
        const reasons = []
        if (budget.limits.maxCalls !== null && budget.consumed + 1 > budget.limits.maxCalls) {
          reasons.push(`call budget: ${budget.bookedCalls} booked + ${budget.inFlight} in flight + 1 would exceed maxCalls=${budget.limits.maxCalls}`)
        }
        if (budget.limits.perTaskCalls !== null && budget.consumed + 1 > budget.limits.perTaskCalls) {
          reasons.push(`task budget: ${budget.bookedCalls} booked + ${budget.inFlight} in flight + 1 would exceed perTaskCalls=${budget.limits.perTaskCalls} for ${taskId}`)
        }
        if (budget.limits.maxUsd !== null && budget.costKnown && budget.usdSettled !== null && budget.usdSettled >= budget.limits.maxUsd) {
          reasons.push(`cost budget: $${budget.usdSettled.toFixed(4)} settled of maxUsd=${budget.limits.maxUsd}`)
        }

        if (reasons.length) {
          stop(parentId, body, reasons, limits, taskId)
          persist(parentId, body)
          return {
            allowed: false,
            code: 'OMC/BUDGET-EXHAUSTED',
            reason: reasons.join('; '),
            budget: view(parentId, limits, body, taskId),
          }
        }

        const reservation = {
          modelRequestId,
          taskId,
          attemptId,
          state: 'inflight',
          ownerPid,
          at: now(),
          source: { ...source },
        }
        body.reservations[modelRequestId] = reservation
        // An admitted send makes the previous stop marker stale: the marker
        // means "the next request was refused". The next refusal re-creates it.
        body.checkpoint = null
        persist(parentId, body)
        const reason = budget.unknownCost
          ? 'the settled cost is a lower bound: at least one attempt has unknown cost'
          : undefined
        return { allowed: true, duplicate: false, reservation: { ...reservation }, budget: view(parentId, limits, body, taskId), ...(reason ? { reason } : {}) }
      })
    },

    /**
     * Terminal boundary for one reservation.
     * `outcome`: 'booked' (a ledger entry landed) | 'unknown' (sent, result
     * never arrived — keeps its slot) | 'refused' (nothing was sent).
     */
    settle({ parentId, modelRequestId, outcome, sourceEventId = null, note = null } = {}) {
      if (!RESERVATION_STATES.includes(outcome) || outcome === 'inflight') {
        throw gateError('OMC/GATE-INPUT', `settle needs outcome booked|unknown|refused (got ${String(outcome)})`)
      }
      return underLock(parentId, () => {
        const body = load(parentId)
        const row = body.reservations[modelRequestId]
        if (!row) return { settled: false, reason: 'no such reservation', reservation: null }
        if (row.state === outcome) return { settled: false, reason: 'already settled', reservation: { ...row } }
        if (row.state === 'booked' || row.state === 'refused') {
          // A booked/refused reservation is final; a later contradiction is
          // recorded instead of rewriting the count.
          body.releases.push({ at: now(), modelRequestId, was: row.state, claimed: outcome, note: note ?? 'contradictory settlement' })
          persist(parentId, body)
          return { settled: false, reason: `already ${row.state}`, reservation: { ...row }, conflict: true }
        }
        row.state = outcome
        row.settledAt = now()
        row.sourceEventId = sourceEventId
        if (note) row.note = String(note)
        persist(parentId, body)
        return { settled: true, reservation: { ...row } }
      })
    },

    /** Current consumption for one parent (or one task of it). */
    budgetView({ parentId, limits = {}, taskId = null } = {}) {
      return view(parentId, limits, load(parentId), taskId)
    },

    /** The persisted stop marker, or null. */
    checkpoint(parentId) {
      return load(parentId).checkpoint ?? null
    },

    inFlight(parentId) {
      return holding(load(parentId)).rows.filter((row) => row.state === 'inflight')
    },

    /**
     * Restart reconciliation: reservations held by a process that is gone
     * become `unknown` (their sends may have happened) instead of being
     * refunded. Returns what changed so the caller can report it.
     */
    reconcile({ parentId, isAlive = () => false } = {}) {
      return underLock(parentId, () => {
        const body = load(parentId)
        const reconciled = []
        for (const row of Object.values(body.reservations)) {
          if (row.state !== 'inflight') continue
          if (isAlive(row)) continue
          row.state = 'unknown'
          row.settledAt = now()
          row.note = 'reconciled after restart: no terminal event was observed'
          reconciled.push({ modelRequestId: row.modelRequestId, taskId: row.taskId })
        }
        if (reconciled.length) persist(parentId, body)
        return { reconciled, checkpoint: body.checkpoint ?? null }
      })
    },

    /**
     * Audited release of an `unknown` slot. Never automatic: the caller must
     * say why (host receipt, cancelled process, operator decision).
     */
    releaseUnknown({ parentId, modelRequestId, reason, evidence = null } = {}) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw gateError('OMC/GATE-INPUT', 'releaseUnknown needs a reason (audited release)')
      }
      return underLock(parentId, () => {
        const body = load(parentId)
        const row = body.reservations[modelRequestId]
        if (!row) return { released: false, reason: 'no such reservation' }
        if (row.state !== 'unknown') return { released: false, reason: `reservation is ${row.state}, not unknown` }
        row.state = 'refused'
        row.settledAt = now()
        row.note = `released: ${reason}`
        body.releases.push({ at: now(), modelRequestId, was: 'unknown', claimed: 'refused', note: reason, evidence })
        persist(parentId, body)
        return { released: true, reservation: { ...row } }
      })
    },

    /** Human-readable one-liner for status surfaces. */
    describe(budget) {
      const calls = `${budget.bookedCalls}${budget.limits.maxCalls === null ? '' : `/${budget.limits.maxCalls}`} booked · ${budget.inFlight} in flight`
      const cost = budget.costKnown ? `$${(budget.usdSettled ?? 0).toFixed(4)} settled${budget.limits.maxUsd === null ? '' : ` of $${budget.limits.maxUsd}`}` : 'cost unknown'
      return `budget ${budget.exhausted ? 'STOPPED' : 'ok'}: ${calls} · ${cost}${budget.unknownReservations ? ` · ${budget.unknownReservations} unknown` : ''}`
    },
  }
}
