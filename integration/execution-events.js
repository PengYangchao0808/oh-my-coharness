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

export const EXECUTION_EVENTS_VERSION = 2
const COMPAT_EXECUTION_EVENTS_VERSION = 1
export const EXECUTION_STATES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'unknown'])
export const ACCEPTANCE_STATES = Object.freeze(['pending', 'passed', 'failed', 'unknown'])
/**
 * The external-run lifecycle (0.6). `execution` stays the public verdict field;
 * `phase` records how far the run got, so a crash between "we wrote intent" and
 * "the process confirmed it is running" is `unknown`, never a fabricated
 * terminal state.
 */
export const EXECUTION_PHASES = Object.freeze(['intent', 'launching', 'running', 'ended', 'unknown'])

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
    // 0.6 lifecycle: intent → launching → running → ended | unknown
    phase: 'intent',
    intentAt: nowIso(),
    launchingAt: null,
    runningAt: null,
    endedAt: null,
    intent: meta?.intent ? { ...meta.intent } : null,
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
    if (!durable) return normalizeLoaded(memory.get(taskId) ?? null)
    const file = fileFor(taskId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const version = parsed?.schemaVersion
      if ((version !== EXECUTION_EVENTS_VERSION && version !== COMPAT_EXECUTION_EVENTS_VERSION) || !Array.isArray(parsed.attempts)) {
        return null
      }
      return normalizeLoaded(parsed, version)
    } catch {
      return null
    }
  }

  /**
   * Fill fields a pre-0.6 record (or a fresh task) does not have. Old attempts
   * get an explicit `ended`/`unknown` phase from their recorded execution state;
   * the schema-compat path never invents a lifecycle it cannot prove.
   */
  function normalizeLoaded(task, version = EXECUTION_EVENTS_VERSION) {
    if (!task) return null
    task.schemaVersion = EXECUTION_EVENTS_VERSION
    if (!Array.isArray(task.verdicts)) task.verdicts = []
    if (!Array.isArray(task.verdictConflicts)) task.verdictConflicts = []
    if (!task.acceptance || typeof task.acceptance !== 'object') {
      task.acceptance = { state: 'unknown', attemptId: null, evidence: null, decidedAt: null, verdictId: null }
    }
    for (const attempt of task.attempts) {
      if (!EXECUTION_PHASES.includes(attempt.phase)) {
        if (version < EXECUTION_EVENTS_VERSION) {
          attempt.phase = attempt.execution === 'running' ? 'running' : attempt.execution === 'unknown' ? 'unknown' : 'ended'
          attempt.legacy = true
        } else {
          attempt.phase = attempt.execution === 'running' ? 'running' : 'ended'
        }
      }
      attempt.intentAt ??= attempt.openedAt ?? null
      attempt.launchingAt ??= null
      attempt.runningAt ??= attempt.phase === 'running' || attempt.phase === 'ended' ? attempt.openedAt ?? null : null
      attempt.endedAt ??= attempt.settledAt ?? null
      if (!attempt.intent) attempt.intent = null
    }
    return task
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

  function taskUnknown() {
    const error = new Error('OMC/TASK-UNKNOWN: unknown task')
    error.code = 'OMC/TASK-UNKNOWN'
    return error
  }

  function attemptUnknown() {
    const error = new Error('OMC/ATTEMPT-UNKNOWN: the task has no attempt to settle')
    error.code = 'OMC/ATTEMPT-UNKNOWN'
    return error
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
        acceptance: { state: 'unknown', attemptId: null, evidence: null, decidedAt: null, verdictId: null },
        verdicts: [],
        verdictConflicts: [],
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
    const currentVerdict = task.acceptance?.verdictId
      ? task.verdicts.find((row) => row.id === task.acceptance.verdictId) ?? null
      : null
    return {
      taskId: task.taskId,
      parentId: task.parentId,
      attempts: task.attempts.map((row) => ({
        attemptId: row.attemptId,
        index: row.index,
        backend: row.backend,
        route: row.route,
        execution: row.execution,
        phase: row.phase ?? null,
        stopReason: row.stopReason,
        openedAt: row.openedAt,
        openedBy: row.openedBy,
        intentAt: row.intentAt ?? null,
        launchingAt: row.launchingAt ?? null,
        runningAt: row.runningAt ?? null,
        endedAt: row.endedAt ?? null,
        intent: row.intent ? { ...row.intent } : null,
        settledAt: row.settledAt,
        cancelRequested: row.cancelRequested,
        ...(row.cancelNote ? { cancelNote: row.cancelNote } : {}),
        conflicts: row.conflicts.length ? row.conflicts : undefined,
      })),
      currentAttemptId: attempt?.attemptId ?? null,
      currentPhase: attempt?.phase ?? null,
      execution: attempt ? attempt.execution : 'unknown',
      cancelRequested: attempt?.cancelRequested === true,
      // Acceptance is task-level verdict evidence tied to the attempt that
      // produced the work; it never copies the execution state.
      acceptance: {
        ...task.acceptance,
        verdict: currentVerdict,
        history: task.verdicts.slice(-10),
        conflicts: task.verdictConflicts.slice(-10),
      },
      delivered: attempt?.execution === 'completed' && task.acceptance.state === 'passed'
        && (!task.acceptance.attemptId || task.acceptance.attemptId === attempt?.attemptId),
      updatedAt: task.updatedAt,
    }
  }

  return {
    /** Open a task (first attempt) or continue an existing one. */
    open({ taskId, parentId, backend, route, reason, intent = null }) {
      const task = ensureTask({ taskId, parentId })
      const last = currentAttempt(task)
      if (!last) {
        task.attempts.push(newAttempt(task, reason ?? 'start', { backend, route, intent }))
      } else if (last.execution !== 'running') {
        // Continuing a settled task is a reopen: new attempt, acceptance reset.
        task.attempts.push(newAttempt(task, reason ?? 'reopen', { backend, route, intent }))
        task.acceptance = { state: 'pending', attemptId: null, evidence: null, decidedAt: null, verdictId: null }
      } else if (intent && !last.intent) {
        last.intent = { ...intent }
      }
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** Record the explicit launching phase, BEFORE the external process starts. */
    launching(taskId, attemptId, { intent = null, pid = null, command = null, by = null } = {}) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) throw attemptUnknown()
      attempt.phase = 'launching'
      attempt.launchingAt = attempt.launchingAt ?? nowIso()
      if (intent) attempt.intent = { ...(attempt.intent ?? {}), ...intent }
      if (pid !== null) attempt.launchPid = pid
      if (command !== null) attempt.launchCommand = String(command)
      if (by !== null) attempt.launchingBy = by
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** Record the running phase once the process/child is actually observed. */
    running(taskId, attemptId, { pid = null, route = null, by = null } = {}) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) throw attemptUnknown()
      if (attempt.execution !== 'running') return publicView(task)
      attempt.phase = 'running'
      attempt.runningAt = attempt.runningAt ?? nowIso()
      if (pid !== null) attempt.launchPid = pid
      if (route) attempt.route = { ...route }
      if (by !== null) attempt.runningBy = by
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** A retry or model switch on a running/failed task: new attempt, same task. */
    retry(taskId, { reason, backend, route, intent = null } = {}) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
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
      task.attempts.push(newAttempt(task, reason ?? 'retry', { backend, route, intent }))
      task.acceptance = { state: 'pending', attemptId: null, evidence: null, decidedAt: null, verdictId: null }
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
      if (!task) throw taskUnknown()
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) throw attemptUnknown()
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
      attempt.phase = state === 'unknown' ? 'unknown' : 'ended'
      attempt.endedAt = attempt.settledAt
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /**
     * Explicitly mark one attempt unknown: the process may have run, but no
     * terminal event was observed. Never used to mean "failed".
     */
    markUnknown(taskId, attemptId = null, { reason = 'no terminal event was observed', by = null } = {}) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
      const attempt = attemptId
        ? task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
        : currentAttempt(task)
      if (!attempt) throw attemptUnknown()
      if (attempt.execution !== 'running') return publicView(task)
      attempt.execution = 'unknown'
      attempt.phase = 'unknown'
      attempt.stopReason = reason
      attempt.settledAt = nowIso()
      attempt.settledBy = by ?? null
      attempt.endedAt = attempt.settledAt
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** A stop request is a flag, never a status change on its own. */
    cancelRequested(taskId, attemptId, note) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
      const attempt = task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
      if (!attempt) throw attemptUnknown()
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
     *
     * 0.6: a verdict object is durable and bound to (task, attempt, spec,
     * baseline, tree fingerprint). The same verdict is idempotent; a
     * contradictory verdict for the same attempt/spec/baseline is recorded as a
     * conflict and never rewrites the earlier one.
     */
    acceptance(taskId, { state, evidence, attemptId, verdict = null, by = null } = {}) {
      const task = load(taskId)
      if (!task) throw taskUnknown()
      const attempt = attemptId
        ? task.attempts.find((row) => row.attemptId === attemptId) ?? currentAttempt(task)
        : currentAttempt(task)

      if (verdict && typeof verdict === 'object') {
        const record = {
          ...verdict,
          taskId: verdict.taskId ?? task.taskId,
          attemptId: verdict.attemptId ?? attempt?.attemptId ?? null,
          state: ACCEPTANCE_STATES.includes(verdict.state) ? verdict.state : 'unknown',
        }
        if (typeof record.id !== 'string' || record.id === '') {
          throw Object.assign(new Error('OMC/ACCEPTANCE-VERDICT: a verdict needs an id'), { code: 'OMC/ACCEPTANCE-VERDICT' })
        }
        const existing = task.verdicts.find((row) => row.id === record.id)
        if (existing) {
          if (existing.state === record.state) {
            return { ...publicView(task), duplicate: true }
          }
          task.verdictConflicts.push({ at: nowIso(), verdictId: record.id, was: existing.state, claimed: record.state, by })
          task.updatedAt = nowIso()
          persist(task)
          return { ...publicView(task), conflict: true }
        }
        const competing = task.verdicts.find((row) => row.attemptId === record.attemptId
          && row.baselineId === record.baselineId
          && row.specDigest === record.specDigest)
        if (competing && competing.state !== record.state) {
          task.verdictConflicts.push({
            at: nowIso(), verdictId: record.id, competingId: competing.id,
            was: competing.state, claimed: record.state, by,
          })
          task.updatedAt = nowIso()
          persist(task)
          return { ...publicView(task), conflict: true }
        }
        task.verdicts.push(record)
        if (task.verdicts.length > 50) task.verdicts.splice(0, task.verdicts.length - 50)
        task.acceptance = {
          state: record.state,
          attemptId: record.attemptId,
          evidence: record.evidence ?? evidence ?? null,
          decidedAt: nowIso(),
          verdictId: record.id,
        }
        task.updatedAt = nowIso()
        persist(task)
        return publicView(task)
      }

      const verdictState = ACCEPTANCE_STATES.includes(state) ? state : 'unknown'
      task.acceptance = {
        state: verdictState,
        attemptId: attempt?.attemptId ?? null,
        evidence: evidence ?? null,
        decidedAt: nowIso(),
        verdictId: null,
      }
      task.updatedAt = nowIso()
      persist(task)
      return publicView(task)
    },

    /** Look up one stored verdict by id or by (attempt, spec, baseline). */
    verdict(taskId, { verdictId = null, attemptId = null, specDigest = null, baselineId = null } = {}) {
      const task = load(taskId)
      if (!task) return null
      if (verdictId) return task.verdicts.find((row) => row.id === verdictId) ?? null
      return [...task.verdicts].reverse().find((row) =>
        (attemptId === null || row.attemptId === attemptId)
        && (specDigest === null || row.specDigest === specDigest)
        && (baselineId === null || row.baselineId === baselineId)) ?? null
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
          // A run that was only `intent`/`launching`/`running` when the host
          // died may or may not have reached the external process: it is
          // unknown, never failed/completed, and it is never replayed here.
          if (attempt.execution !== 'running') continue
          if (isAlive(attempt)) continue
          const priorPhase = attempt.phase
          attempt.execution = 'unknown'
          attempt.phase = 'unknown'
          attempt.stopReason = priorPhase === 'intent'
            ? 'restart: the host died before launch was confirmed'
            : 'restart: no terminal event was observed'
          attempt.settledAt = nowIso()
          attempt.endedAt = attempt.settledAt
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
