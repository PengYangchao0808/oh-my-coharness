/**
 * Idempotent usage ledger (0.5.0-alpha.2 WP02).
 *
 * One entry per real model response attempt, in four mutually exclusive token
 * buckets, booked from the path that actually produced it:
 *
 *   native    durable DSH session events (assistant/message usage chunks)
 *   external  an external CLI's machine-readable stream (per dispatch)
 *   direct    a directly spawned CLI run (whatever it printed, often nothing)
 *
 * Booking rules (V0.5-ALPHA2-PLAN §4.2):
 *   - idempotent by (source kind, session/run identity, event seq/id): a
 *     restart replay re-appends the same key and is ignored, never re-billed;
 *   - a missing number stays null (rendered unknown), never 0;
 *   - cost carries its own source and price version; without a price the cost
 *     is unknown, and today's price never stands in for a historical bill;
 *   - reasoning content inside the output is not added on top of the output
 *     bucket: the provider's output count already contains it;
 *   - child rollups are derived by reading entries, never re-booked as a
 *     second parent entry.
 *
 * Storage: append-only JSONL per parent under the profile state root, guarded
 * by the shared cross-process file lock. No credentials, prompts or internal
 * reasoning text are ever stored.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const USAGE_LEDGER_VERSION = 1
export const USAGE_BUCKETS = Object.freeze([
  'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
])
export const USAGE_BACKENDS = Object.freeze(['native', 'external', 'direct'])

function atomicAppend(file, line) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
}

function tokenCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  return null
}

/**
 * Normalize one raw usage object into the four buckets.
 *
 * The input semantics are the one provider difference that matters (A05):
 *  - DSH native chunks report camelCase `inputTokens` as the UNCACHED input
 *    plus explicit cache read/write buckets;
 *  - OpenAI-compatible CLIs (codex et al.) report a total `input_tokens` /
 *    `prompt_tokens` with a `cached_input_tokens` subset — the uncached bucket
 *    is the difference, and a cache-write count is not reported (null, not 0).
 * OMC's own `normalizeUsage` (session-adapters) also emits camelCase
 * `inputTokens` + `cachedInputTokens` for the external TOTAL form, so the
 * default disambiguation is by the companion keys, with an explicit
 * `inputSemantics` hint overriding it.
 *
 * @param {object} raw - one usage object from a session event or CLI stream.
 * @param {{inputSemantics?: 'uncached'|'total'}} [options]
 * @returns {{buckets: Record<string, number|null>, coverage: 'complete'|'partial'|'unknown', inputSemantics: 'uncached'|'total'}}
 */
export function normalizeUsageBuckets(raw, { inputSemantics } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const nested = source.usage && typeof source.usage === 'object' ? { ...source, ...source.usage } : source
  const pick = (...keys) => {
    for (const key of keys) {
      if (nested[key] !== undefined && nested[key] !== null) return nested[key]
    }
    return undefined
  }
  const outputTokens = tokenCount(pick('outputTokens', 'output_tokens'))
  let uncachedInputTokens = tokenCount(pick('uncachedInputTokens', 'uncached_input_tokens'))
  // Cached input tokens are cache READS in every source we meet; the
  // OpenAI-compatible spelling (cached_input_tokens) and OMC's own
  // (cachedInputTokens) name the same bucket.
  const cacheReadTokens = tokenCount(pick(
    'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens',
    'cached_input_tokens', 'cachedInputTokens', 'cached_tokens',
  ))
  const cacheWriteTokens = tokenCount(pick('cacheWriteTokens', 'cache_write_tokens', 'cacheWriteTokens', 'cache_write_input_tokens'))
  let inputTotal = tokenCount(pick('inputTokens', 'input_tokens', 'prompt_tokens'))

  const splitKeysPresent = nested.cached_input_tokens !== undefined
    || nested.cachedInputTokens !== undefined
    || nested.cached_tokens !== undefined
  const totalKeysPresent = nested.input_tokens !== undefined || nested.prompt_tokens !== undefined
  const semantics = inputSemantics === 'uncached' || inputSemantics === 'total'
    ? inputSemantics
    : totalKeysPresent || splitKeysPresent ? 'total' : 'uncached'

  if (semantics === 'total') {
    if (uncachedInputTokens === null && inputTotal !== null) {
      if (cacheReadTokens === null) {
        // A total without a cache split: the uncached bucket carries it all
        // and the cache buckets stay unknown (unreported, not zero).
        uncachedInputTokens = inputTotal
        inputTotal = null
      } else if (inputTotal >= cacheReadTokens) {
        uncachedInputTokens = inputTotal - cacheReadTokens
        inputTotal = null
      } else {
        // Inconsistent pair: refuse to invent a number.
        uncachedInputTokens = null
      }
    }
  } else {
    // Native semantics: `inputTokens` IS the uncached input; a total was
    // never reported by this source shape.
    if (uncachedInputTokens === null && inputTotal !== null) uncachedInputTokens = inputTotal
    inputTotal = null
  }

  const buckets = { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
  const known = Object.values(buckets).filter((value) => value !== null).length
  const coverage = known === 4 ? 'complete' : known > 0 ? 'partial' : 'unknown'
  return { buckets, coverage, inputSemantics: semantics }
}

/** The idempotency key: one booking per source event, ever. */
export function usageLedgerKey(source) {
  const kind = USAGE_BACKENDS.includes(source?.backend) ? source.backend : String(source?.kind ?? 'unknown')
  const session = String(source?.sessionId ?? source?.runId ?? source?.taskId ?? '_')
  const event = String(source?.seq ?? source?.eventId ?? source?.attemptId ?? '_')
  return `${kind}|${session}|${event}`
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'entry must be an object'
  if (typeof entry.parentId !== 'string' || entry.parentId.trim() === '') return 'parentId is required'
  if (typeof entry.taskId !== 'string' || entry.taskId.trim() === '') return 'taskId is required'
  if (!USAGE_BACKENDS.includes(entry.backend)) return `backend must be one of ${USAGE_BACKENDS.join(', ')}`
  if (typeof entry.attemptId !== 'string' || entry.attemptId.trim() === '') return 'attemptId is required'
  if (!entry.source || typeof entry.source !== 'object') return 'source is required'
  if (entry.usage && typeof entry.usage !== 'object') return 'usage must be an object when present'
  if (entry.usage) {
    for (const key of Object.keys(entry.usage)) {
      if (!USAGE_BUCKETS.includes(key)) return `usage bucket "${key}" is not one of ${USAGE_BUCKETS.join(', ')}`
      const value = entry.usage[key]
      if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) return `usage bucket "${key}" must be a non-negative integer or null`
    }
  }
  if (entry.cost !== undefined && entry.cost !== null) {
    if (typeof entry.cost !== 'object') return 'cost must be an object, null or absent'
    if (typeof entry.cost.usd !== 'number' || !(entry.cost.usd >= 0)) return 'cost.usd must be a non-negative number'
    if (typeof entry.cost.source !== 'string' || entry.cost.source.trim() === '') return 'cost.source is required when a cost is booked'
  }
  return null
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 *   `dir` defaults to in-memory (tests/embedded); the Host passes the
 *   profile-scoped `<stateRoot>/usage` directory.
 */
export function createUsageLedger({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const memory = new Map()

  function fileFor(parentId) {
    return join(dir, safeSegment(parentId, 'parent') + '.jsonl')
  }

  function loadLines(parentId) {
    if (!durable) return [...memory.entries()]
    const file = fileFor(parentId)
    if (!existsSync(file)) return []
    const entries = new Map()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed?.key) entries.set(parsed.key, parsed)
      } catch {
        // A torn final line from a crash is skipped, not trusted.
      }
    }
    return [...entries.entries()]
  }

  return {
    /**
     * Book one usage entry. Re-appending the same source event (restart
     * replay, duplicate delivery, cross-process double read) is a no-op that
     * reports `duplicate: true`; it never bills twice.
     */
    append(entry) {
      const invalid = validEntry(entry)
      if (invalid) {
        const error = new Error(`OMC/USAGE-ENTRY-INVALID: ${invalid}`)
        error.code = 'OMC/USAGE-ENTRY-INVALID'
        throw error
      }
      const key = usageLedgerKey({ ...entry.source, backend: entry.backend })
      const record = {
        schemaVersion: USAGE_LEDGER_VERSION,
        key,
        parentId: entry.parentId,
        taskId: entry.taskId,
        attemptId: entry.attemptId,
        backend: entry.backend,
        source: {
          kind: entry.source.kind ?? entry.backend,
          sessionId: entry.source.sessionId ?? null,
          runId: entry.source.runId ?? null,
          seq: entry.source.seq ?? null,
          eventId: entry.source.eventId ?? null,
          requestId: entry.source.requestId ?? null,
        },
        route: {
          provider: entry.route?.provider ?? null,
          model: entry.route?.model ?? null,
          effort: entry.route?.effort ?? null,
          observed: entry.route?.observed === true,
        },
        usage: entry.usage
          ? Object.fromEntries(USAGE_BUCKETS.map((bucket) => [bucket, entry.usage[bucket] ?? null]))
          : Object.fromEntries(USAGE_BUCKETS.map((bucket) => [bucket, null])),
        cost: entry.cost ?? null,
        coverage: entry.coverage ?? (entry.usage ? 'partial' : 'unknown'),
        at: entry.at ?? new Date().toISOString(),
        recordedAt: new Date().toISOString(),
      }

      if (!durable) {
        if (memory.has(key)) return { stored: false, duplicate: true, key, entry: memory.get(key) }
        memory.set(key, record)
        return { stored: true, duplicate: false, key, entry: record }
      }

      const file = fileFor(entry.parentId)
      // The lock file is `${target}.lock` (see file-lock.js); target the bare
      // parent segment so it can never collide with the `.jsonl` ledger.
      const lock = acquireFileLockSync(join(dir, safeSegment(entry.parentId, 'parent')), {
        timeoutMs: lockTimeoutMs, staleMs: Math.max(30_000, lockTimeoutMs * 2), label: 'usage-ledger',
      })
      try {
        const known = new Set(loadLines(entry.parentId).map(([k]) => k))
        if (known.has(key)) return { stored: false, duplicate: true, key, entry: null }
        atomicAppend(file, JSON.stringify(record) + '\n')
        return { stored: true, duplicate: false, key, entry: record }
      } finally {
        lock.release()
      }
    },

    /** All entries for one parent, optionally narrowed to a task or attempt. */
    entries({ parentId, taskId, attemptId } = {}) {
      const rows = loadLines(parentId).map(([, value]) => value)
      return rows
        // The in-memory backend stores every parent in one map, so the parent
        // filter belongs here as well: a rollup for one parent must never
        // include another parent's bookings (the durable backend gets the same
        // filter for free from its per-parent file).
        .filter((row) => (parentId ? row.parentId === parentId : true))
        .filter((row) => (taskId ? row.taskId === taskId : true))
        .filter((row) => (attemptId ? row.attemptId === attemptId : true))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    },

    /**
     * Derived rollup (never booked back): bucket sums over known values plus
     * an honest coverage verdict — any null bucket or unknown cost keeps the
     * rollup from claiming completeness.
     */
    totals({ parentId, taskId } = {}) {
      const rows = this.entries({ parentId, taskId })
      const sums = Object.fromEntries(USAGE_BUCKETS.map((bucket) => [bucket, 0]))
      let entriesWithUsage = 0
      let completeCoverage = rows.length > 0
      let anyCost = false
      let unknownCost = false
      for (const row of rows) {
        const hasAny = Object.values(row.usage ?? {}).some((value) => value !== null)
        if (hasAny) entriesWithUsage += 1
        else completeCoverage = false
        for (const bucket of USAGE_BUCKETS) {
          const value = row.usage?.[bucket]
          if (value === null || value === undefined) completeCoverage = false
          else sums[bucket] += value
        }
        if (row.cost?.usd !== undefined) anyCost = true
        else unknownCost = true
      }
      const coverage = !rows.length
        ? 'unknown'
        : completeCoverage && !unknownCost
          ? 'complete'
          : entriesWithUsage > 0
            ? 'partial'
            : 'unknown'
      return {
        entries: rows.length,
        entriesWithUsage,
        sums,
        coverage,
        costUsd: anyCost ? rows.reduce((total, row) => total + (row.cost?.usd ?? 0), 0) : null,
        costKnown: anyCost && !unknownCost,
        unknownCost,
      }
    },
  }
}

/**
 * Map durable DSH session events (the `session/event` shapes persisted by the
 * host: request/header + assistant/message with a usage payload) into ledger
 * entries. Pure: the caller owns reading the log and parent/task identity.
 *
 * Native semantics verified by WP00: `inputTokens` is the uncached input,
 * a failed attempt logs `assistant/attempt` WITHOUT usage (booked as an
 * unknown-cost attempt entry, not zero), and the route is the nearest earlier
 * request/header plus the message source.
 */
export function nativeSessionUsageEntries(events, { parentId, taskId, attemptOf } = {}) {
  const entries = []
  let route = { provider: null, model: null, effort: null }
  let requestCount = 0
  let assistantAttempts = 0
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    if (event?.type === 'request/header') {
      const config = data.header?.config ?? {}
      route = {
        provider: config.provider ?? null,
        model: config.model ?? null,
        effort: config.reasoningEffort ?? null,
      }
      requestCount += 1
      continue
    }
    if (event?.type === 'assistant/attempt') {
      assistantAttempts += 1
      entries.push({
        parentId,
        taskId,
        attemptId: attemptOf?.(event) ?? `${taskId}#a${data.turn ?? '?'}-${data.step ?? '?'}`,
        backend: 'native',
        source: { kind: 'dsh-session', sessionId: event.sessionId ?? null, seq: event.seq },
        route: { ...route, observed: true },
        usage: null,
        coverage: 'unknown',
        at: event.at ?? new Date().toISOString(),
      })
      continue
    }
    if (event?.type === 'assistant/message') {
      const usage = data.usage ? normalizeUsageBuckets(data.usage) : null
      entries.push({
        parentId,
        taskId,
        attemptId: attemptOf?.(event) ?? `${taskId}#a${data.turn ?? '?'}-${data.step ?? '?'}`,
        backend: 'native',
        source: { kind: 'dsh-session', sessionId: event.sessionId ?? null, seq: event.seq },
        route: {
          provider: data.message?.source?.provider ?? route.provider,
          model: data.message?.source?.model ?? route.model,
          effort: route.effort,
          observed: true,
        },
        usage: usage ? usage.buckets : null,
        coverage: usage ? usage.coverage : 'unknown',
        at: event.at ?? new Date().toISOString(),
      })
    }
  }
  return entries
}
