/**
 * Explainable session selection (0.5.0-alpha.2 R04).
 *
 * Choosing what to do with a previous worker's session is a RULE TABLE, not a
 * score. There is no model call here and no term that rewards reuse: "the
 * resume rate went up" is not evidence that reuse was correct. Every decision
 * names the rule that fired and the facts it used, so a later reader can
 * disagree with the reason rather than with a number.
 *
 * Precedence (first match wins, order is part of the contract):
 *   1. independentReview                                  → new-packet
 *   2. no prior worker                                    → new-packet
 *   3. constraints / route / permission / workspace
 *      mismatch, stale facts, unclear failure              → restart
 *   4. childBusy                                          → queue
 *      (never run two tasks on one session in parallel)
 *   5. contextOverLimit && compactAvailable               → compact
 *   6. contextOverLimit && !compactAvailable              → restart
 *      ("no legal compaction interface; recorded as restart, never a fake
 *      compact" — OMC's own history view may only trim its own echo, so a
 *      compaction it cannot perform is not reported as performed)
 *   7. sameModule                                         → resume
 *   8. otherwise                                          → new-packet
 *
 * Honesty rules:
 *   - a match flag must be positively `true` to justify reuse; a missing flag
 *     is unknown, and unknown never justifies reuse (it lands on restart at
 *     step 3, or on new-packet when there is no prior worker at all);
 *   - `options` lists the actions that were legal for the observed facts, so a
 *     queue that never happened can be explained;
 *   - the decision log is append-only JSONL per parent. An outcome revision is
 *     an extra line, never a rewrite; the newest revision wins on read.
 *
 * Storage: `${dir}/<parent>.jsonl` under the profile state root, guarded by the
 * shared cross-process file lock (in-memory when `dir` is absent).
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const SESSION_STRATEGY_VERSION = 1
export const STRATEGY_RULES_VERSION = 1
export const STRATEGY_ACTIONS = Object.freeze(['resume', 'queue', 'compact', 'restart', 'new-packet'])

function nowIso() {
  return new Date().toISOString()
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function err(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * The legal alternative set for these facts. Kept separate from the chosen
 * action so the log can show what was rejected without inventing a score.
 */
function candidateActions(features, capabilities) {
  const hasPrior = features.hasPriorWorker === true
  const legal = new Set(['new-packet'])
  if (hasPrior) {
    legal.add('resume')
    legal.add('restart')
    if (features.childBusy === true) legal.add('queue')
  }
  if (features.contextOverLimit === true) {
    if (capabilities.compactAvailable === true) legal.add('compact')
    else legal.add('restart')
  }
  return STRATEGY_ACTIONS.filter((action) => legal.has(action))
}

function restartBlockers(features) {
  const blockers = []
  if (features.constraintsMatch !== true) blockers.push('constraints: the recorded baseline/write scope is no longer proven valid')
  if (features.routeMatch !== true) blockers.push('route: provider/model/effort changed')
  if (features.permissionMatch !== true) blockers.push('permission: the effective permission changed')
  if (features.workspaceMatch !== true) blockers.push('workspace: the workspace changed')
  if (features.factsStale === true) blockers.push('facts: the recorded facts are stale')
  if (features.failureUnclear === true) blockers.push('failure: the previous failure cause is unclear')
  return blockers
}

/**
 * Pure rule-based choice. No I/O, no model call, no reuse incentive.
 *
 * @param {{features?: object, capabilities?: object}} [input]
 * @returns {{action: string, ruleId: string, reasons: string[], options: string[]}}
 */
export function decideSessionAction({ features, capabilities } = {}) {
  const f = features && typeof features === 'object' ? features : {}
  const c = capabilities && typeof capabilities === 'object' ? capabilities : {}
  const options = candidateActions(f, c)
  const done = (action, ruleId, reasons) => ({ action, ruleId, reasons, options })

  // 1. An independent review needs a view the implementer did not produce.
  if (f.independentReview === true) {
    return done('new-packet', 'S01-independent-review', [
      'independent review: a fresh packet is required; reusing the implementing session would make the review dependent on the work it checks',
    ])
  }

  // 2. Nothing to continue.
  if (f.hasPriorWorker !== true) {
    return done('new-packet', 'S02-no-prior-worker', [
      'no prior worker for this module/role/route: there is no session to continue',
    ])
  }

  // 3. Reuse is refused when the world moved. Every mismatch is reported, not
  // just the first, so the restart is explainable in one place.
  const blockers = restartBlockers(f)
  if (blockers.length > 0) {
    return done('restart', 'S03-reuse-refused', [
      'restart: a new child replaces the previous one',
      ...blockers,
    ])
  }

  // 4. One session serves one task at a time.
  if (f.childBusy === true) {
    return done('queue', 'S04-child-busy', [
      'queue: the previous child is still busy; two tasks never run on one session in parallel',
      'the work waits for the child to become idle instead of sharing its context',
    ])
  }

  // 5/6. Context pressure. Compaction only when a legal interface exists.
  if (f.contextOverLimit === true) {
    if (c.compactAvailable === true) {
      return done('compact', 'S05-context-compact', [
        'compact: the context limit is reached and a legal compaction interface is available',
        'the worker identity and route are unchanged, only its context is reduced',
      ])
    }
    return done('restart', 'S06-context-no-compaction', [
      'restart: the context limit is reached and no legal compaction interface exists',
      'no legal compaction interface; recorded as restart, never a fake compact',
    ])
  }

  // 7. Same module, same proven constraints: continue.
  if (f.sameModule === true) {
    return done('resume', 'S07-same-module', [
      'resume: the follow-up corrects work in the same module',
      'route, permission, workspace and baseline still match, and the child is idle',
    ])
  }

  // 8. A different module on the same worker slot: a new packet is cleaner than
  // carrying an unrelated context.
  return done('new-packet', 'S08-otherwise', [
    'new-packet: the work is not a continuation of the previous module',
    'the recorded worker stays available for its own module',
  ])
}

function atomicAppend(file, line) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw err('OMC/STRATEGY-DECISION-INVALID', 'a decision object is required')
  }
  const action = text(decision.action)
  if (!STRATEGY_ACTIONS.includes(action)) {
    throw err('OMC/STRATEGY-DECISION-INVALID', `unknown action ${action || '(empty)'}`)
  }
  return {
    action,
    ruleId: text(decision.ruleId) || null,
    reasons: Array.isArray(decision.reasons) ? decision.reasons.map(String) : [],
    options: Array.isArray(decision.options) ? decision.options.map(String) : [],
  }
}

function normalizeAction(value) {
  const action = text(value)
  if (action === '') return null
  if (!STRATEGY_ACTIONS.includes(action)) {
    throw err('OMC/STRATEGY-ACTION-INVALID', `unknown actual action ${action}`)
  }
  return action
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 *   `dir` defaults to in-memory; the Host passes `<stateRoot>/decisions`.
 */
export function createDecisionLog({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  /** @type {Map<string, string[]>} parentId → raw JSONL lines (in-memory mode) */
  const memoryLines = new Map()

  function fileFor(parentId) {
    return join(dir, safeSegment(parentId, 'parent') + '.jsonl')
  }

  function lockTargetFor(parentId) {
    // Bare parent segment: the lock file is `${target}.lock`, so it can never
    // collide with the `.jsonl` log itself.
    return join(dir, safeSegment(parentId, 'parent'))
  }

  function linesFor(parentId) {
    if (!durable) return [...(memoryLines.get(parentId) ?? [])]
    const file = fileFor(parentId)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n')
  }

  function append(parentId, record) {
    const line = JSON.stringify(record) + '\n'
    if (!durable) {
      const lines = memoryLines.get(parentId) ?? []
      lines.push(line)
      memoryLines.set(parentId, lines)
      return record
    }
    const lock = acquireFileLockSync(lockTargetFor(parentId), {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'session-strategy',
    })
    try {
      atomicAppend(fileFor(parentId), line)
      return record
    } finally {
      lock.release()
    }
  }

  /**
   * Replay the log: decisions in append order, each carrying the newest outcome
   * revision. Torn lines (a crash mid-append) are skipped, never repaired with
   * guessed content.
   */
  function replay(parentId) {
    const decisions = []
    const byId = new Map()
    const revisions = new Map()
    for (const raw of linesFor(parentId)) {
      const line = raw.trim()
      if (!line) continue
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || parsed.schemaVersion !== SESSION_STRATEGY_VERSION) continue
      if (parsed.kind === 'decision') {
        if (parsed.parentId !== parentId) continue
        if (!parsed.id || byId.has(parsed.id)) continue
        const entry = {
          id: parsed.id,
          at: parsed.at,
          rulesVersion: parsed.rulesVersion ?? STRATEGY_RULES_VERSION,
          parentId: parsed.parentId,
          features: parsed.features ?? {},
          capabilities: parsed.capabilities ?? {},
          decision: parsed.decision ?? null,
          actualAction: parsed.actualAction ?? null,
          outcome: parsed.outcome ?? null,
          outcomeAt: null,
          revisionCount: 0,
        }
        byId.set(entry.id, entry)
        decisions.push(entry)
        continue
      }
      if (parsed.kind === 'revision') {
        if (!parsed.id) continue
        const list = revisions.get(parsed.id) ?? []
        list.push({ at: parsed.at, outcome: parsed.outcome ?? null })
        revisions.set(parsed.id, list)
      }
    }
    for (const entry of decisions) {
      const list = revisions.get(entry.id)
      if (!list || list.length === 0) continue
      const last = list.at(-1)
      entry.outcome = last.outcome
      entry.outcomeAt = last.at
      entry.revisionCount = list.length
    }
    return decisions
  }

  return {
    /** Append one decision record (the facts it saw are kept as they were). */
    record({ parentId, features, capabilities, decision, actualAction, outcome } = {}) {
      const pid = text(parentId)
      if (!pid) throw err('OMC/STRATEGY-PARENT', 'parentId is required')
      const entry = {
        schemaVersion: SESSION_STRATEGY_VERSION,
        kind: 'decision',
        id: `sd-${randomUUID()}`,
        at: nowIso(),
        rulesVersion: STRATEGY_RULES_VERSION,
        parentId: pid,
        features: features && typeof features === 'object' ? { ...features } : {},
        capabilities: capabilities && typeof capabilities === 'object' ? { ...capabilities } : {},
        decision: normalizeDecision(decision),
        actualAction: normalizeAction(actualAction),
        outcome: outcome ?? null,
      }
      return append(pid, entry)
    },

    /** Every decision for one parent, newest facts applied, oldest first. */
    list(parentId) {
      const pid = text(parentId)
      if (!pid) return []
      return replay(pid)
    },

    /**
     * Append an outcome revision for an existing decision. History is never
     * rewritten; the latest revision wins on read.
     */
    recordOutcome(parentId, id, outcome) {
      const pid = text(parentId)
      if (!pid) throw err('OMC/STRATEGY-PARENT', 'parentId is required')
      const target = text(id)
      if (!target) throw err('OMC/STRATEGY-DECISION-UNKNOWN', 'a decision id is required')
      const known = replay(pid).some((entry) => entry.id === target)
      if (!known) throw err('OMC/STRATEGY-DECISION-UNKNOWN', `no decision ${target} for parent ${pid}`)
      return append(pid, {
        schemaVersion: SESSION_STRATEGY_VERSION,
        kind: 'revision',
        id: target,
        parentId: pid,
        at: nowIso(),
        outcome: outcome ?? null,
      })
    },
  }
}
