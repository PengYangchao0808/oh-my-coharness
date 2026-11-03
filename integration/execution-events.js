/**
 * Execution lifecycle with acceptance kept apart (0.5.0-alpha.2 WP02).
 *
 * Execution answers "did the run itself finish, and how". Acceptance answers
 * "did the delivered work pass its验收". Conflating them is how an exit-0 run
 * with failing verification gets claimed as delivered. This store records both,
 * per attempt:
 *
 *   attemptId   one execution try; a retry or a model switch after a failure
 *               opens a NEW attempt under the SAME task (never a new task);
 *   execution   running | completed | failed | cancelled | unknown
 *   acceptance  pending | passed | failed | unknown — separate record,
 *               reset to pending on every new attempt (old evidence does not
 *               carry over automatically);
 *   cancelRequested  a flag, never a status: a request to stop while the
 *               process still runs changes nothing until a terminal event.
 *
 * Honesty rules (A08):
 *   - an attempt with no terminal event hydrates as `unknown`, never
 *     completed ("latest message exists" proves nothing);
 *   - settlement is idempotent per attempt; a conflicting re-settlement is
 *     recorded as a conflict, not silently overwritten;
 *   - reopening a settled task for changed requirements creates a new attempt
 *     and leaves the old attempt's history intact.
 *
 * Storage: one versioned JSON per task under the profile state root, guarded
 * by the shared cross-process file lock.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const EXECUTION_EVENTS_VERSION = 1
export const EXECUTION_STATES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'unknown'])
export const ACCEPTANCE_STATES = Object.freeze(['pending', 'passed', 'failed', 'unknown'])

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

function nowIso() {
  return new Date().toISOString()
}

function newAttempt(task, reason, meta) {
  task.attemptCount += 1
  return {
    attemptId: `${task.taskId}#a${task.attemptCount}`,
    index: task.attemptCount,
    openedAt: nowIso(),
    openedBy: reason ?? 'start',
    backend: meta?.backend ?? null,
    route: meta?.route ? { ...meta.route } : null,
    execution: 'running',
    stopReason: null,
    settledAt: null,
    settledBy: null,
    cancelRequested: false,
    cancelNote: null,
    conflicts: [],
  }
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 *   `dir` defaults to in-memory; the Host passes `<stateRoot>/execution`.
 */
export function createExecutionStore({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const memory = new Map()

  function fileFor(taskId) {
    return join(dir, safeSegment(taskId, 'task') + '.json')
  }

  function load(taskId) {
    if (!durable) return memory.get(taskId) ?? null
    const file = fileFor(taskId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.schemaVersion !== EXECUTION_EVENTS_VERSION || !Array.isArray(parsed.attempts)) return null
      return parsed
    } catch {
      return null
    }
  }

  function persist(task) {
    if (!durable) {
      memory.set(task.taskId, task)
      return
    }
    const file = fileFor(task.taskId)
    const lock = acquireFileLockSync(join(dir, safeSegment(task.taskId, 'task')), {
      timeoutMs: lockTimeoutMs, staleMs: Math.max(30_000, lockTimeoutMs * 2), label: 'execution-events',
    })
    try {
      atomicWrite(file, JSON.stringify(task, null, 2) + '\n')
    } finally {
      lock.release()
    }
  }

  function ensureTask({ taskId, parentId }) {
    let task = load(taskId)
    if (!task) {
      task = {
        schemaVersion: EXECUTION_EVENTS_VERSION,
        taskId,
        parentId: parentId ?? null,
        attemptCount: 0,
        attempts: [],
        acceptance: { state: 'unknown', attemptId: null, evidence: null, decidedAt: null },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
    }
    return task
  }

  function currentAttempt(task) {
    return task.attempts.at(-1) ?? null
  }

  function publicView(task) {
    const attempt = currentAttempt(task)
    return {
      taskId: task.taskId,
      parentId: task.parentId,
      attempts: task.attempts.map((row) => ({
        attemptId: row.attemptId,
        index: row.index,
        backend: row.backend,
        route: row.route,
        execution: row.execution,
        stopReason: row.stopReason,
        openedAt: row.openedAt,
        openedBy: row.openedBy,
        settledAt: row.settledAt,
        cancelRequested: row.cancelRequested,
        ...(row.cancelNote ? { cancelNote: row.cancelNote } : {}),
        conflicts: row.conflicts.length ? row.conflicts : undefined,
      })),
      currentAttemptId: attempt?.attemptId ?? null,
      execution: attempt ? attempt.execution : 'unknown',
      cancelRequested: attempt?.cancelRequested === true,
      // Acceptance is task-level verdict evidence tied to the attempt that
      // produced the work; it never copies the execution state.
      acceptance: { ...task.acceptance },
      delivered: attempt?.execution === 'completed' && task.acceptance.state === 'passed',
      updatedAt: task.updatedAt,
    }
  }

  return {
    /** Open a task (first attempt) or continue an existing one. */
    open({ taskId, parentId, backend, route, reason }) {
      const task = ensureTask({ taskId, parentId })
      const last = currentAttempt(task)
      if (!last) {
        task.attempts.push(newAttempt(task, reason ?? 'start', { backend, route }))
      } else if (last.execution !== 'running') {
        // Continuing a settled task is a reopen: new attempt, acceptance reset.
        task.attempts.push(newAttempt(task, reason ?? 'reopen', { backend, route }))
        task.acceptance = { state: 'pending', attemptId: null, evidence: null, decidedAt: null }
      }
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** A retry or model switch on a running/failed task: new attempt, same task. */
    retry(taskId, { reason, backend, route } = {}) {
      const task = load(taskId)
      if (!task) {
        const error = new Error('OMC/TASK-UNKNOWN: cannot retry an unknown task')
        error.code = 'OMC/TASK-UNKNOWN'
        throw error
      }
      const last = currentAttempt(task)
      if (last && last.execution === 'running') {
        // A retry while still running is recorded as a request, not a new
        // attempt: two execution tries cannot share one live process.
        last.cancelRequested = true
        last.cancelNote = `retry requested (${reason ?? 'no reason'}) while still running`
        task.updatedAt = nowIso()
        persist(task)
        return publicView(task)
      }
      task.attempts.push(newAttempt(task, reason ?? 'retry', { backend, route }))
      task.acceptance = { state: 'pending', attemptId: null, evidence: null, decidedAt: null }
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /**
     * Record one attempt's terminal execution event. Idempotent per attempt;
     * a contradictory second verdict is kept as a conflict instead of
     * overwriting history.
     */
    settle(taskId, attemptId, { execution, stopReason, by } = {}) {
      const task = load(taskId)
      if (!task) {
        const error = new Error('OMC/TASK-UNKNOWN: cannot settle an unknown task')
        error.code = 'OMC/TASK-UNKNOWN'
        throw error
      }
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) {
        const error = new Error('OMC/ATTEMPT-UNKNOWN: the task has no attempt to settle')
        error.code = 'OMC/ATTEMPT-UNKNOWN'
        throw error
      }
      const state = EXECUTION_STATES.includes(execution) ? execution : 'unknown'
      if (attempt.execution !== 'running' && attempt.execution !== state && state !== 'unknown') {
        attempt.conflicts.push({
          at: nowIso(),
          was: attempt.execution,
          claimed: state,
          by: by ?? null,
        })
        task.updatedAt = nowIso()
        persist(task)
        return publicView(task)
      }
      if (attempt.execution !== 'running') return publicView(task)
      attempt.execution = state
      attempt.stopReason = stopReason ?? null
      attempt.settledAt = nowIso()
      attempt.settledBy = by ?? null
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** A stop request is a flag, never a status change on its own. */
    cancelRequested(taskId, attemptId, note) {
      const task = load(taskId)
      if (!task) {
        const error = new Error('OMC/TASK-UNKNOWN: unknown task')
        error.code = 'OMC/TASK-UNKNOWN'
        throw error
      }
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) {
        const error = new Error('OMC/ATTEMPT-UNKNOWN: no attempt to flag')
        error.code = 'OMC/ATTEMPT-UNKNOWN'
        throw error
      }
      attempt.cancelRequested = true
      if (note) attempt.cancelNote = String(note)
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /**
     * Record the acceptance verdict for the work of one attempt. Separate
     * from execution by construction: `passed` here plus execution `completed`
     * is what `delivered` means; either alone never is.
     */
    acceptance(taskId, { state, evidence, attemptId } = {}) {
      const task = load(taskId)
      if (!task) {
        const error = new Error('OMC/TASK-UNKNOWN: unknown task')
        error.code = 'OMC/TASK-UNKNOWN'
        throw error
      }
      const verdict = ACCEPTANCE_STATES.includes(state) ? state : 'unknown'
      const attempt = attemptId
        ? task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
        : currentAttempt(task)
      task.acceptance = {
        state: verdict,
        attemptId: attempt?.attemptId ?? null,
        evidence: evidence ?? null,
        decidedAt: nowIso(),
      }
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    read(taskId) {
      const task = load(taskId)
      if (!task) return null
      // Hydration honesty: an attempt still marked running in a file we just
      // (re)loaded may belong to a dead process — but that judgement needs the
      // caller's liveness facts, so the raw state stays and reconciliation is
      // explicit below.
      return publicView(task)
    },

    /**
     * Restart reconciliation: attempts that were `running` when this process
     * died are marked `unknown` (their processes are gone, and no terminal
     * event will ever arrive). Returns what was reconciled.
     */
    reconcileAfterRestart(parentId, { isAlive = () => false } = {}) {
      const reconciled = []
      // In-memory mode has nothing durable to reconcile.
      if (!durable) return reconciled
      if (!existsSync(dir)) return reconciled
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const taskId = name.slice(0, -'.json'.length)
        const task = load(taskId)
        if (!task || (parentId && task.parentId !== parentId)) continue
        for (const attempt of task.attempts) {
          if (attempt.execution !== 'running') continue
          if (isAlive(attempt)) continue
          attempt.execution = 'unknown'
          attempt.stopReason = 'restart: no terminal event was observed'
          attempt.settledAt = nowIso()
          reconciled.push({ taskId, attemptId: attempt.attemptId })
        }
        if (reconciled.some((row) => row.taskId === taskId)) {
          task.updatedAt = nowIso()
          persist(task)
        }
      }
      return reconciled
    },
  }
}
