/**
 * Native Session Registry.
 *
 * OMC never stores a conversation. It stores the opaque session id a CLI
 * returned, plus the key that makes reusing it safe: project, lane, role,
 * harness, model, execution environment, workspace and endpoint fingerprint.
 *
 * Storage is one user-scoped JSON file, written atomically and readable only by
 * the user. A native session is shared by at most one local run at a time; the
 * in-process lease is what prevents two tasks from resuming the same CLI
 * conversation concurrently. This is deliberately not a server, a database or a
 * background process.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const SESSION_SCHEMA_VERSION = 1
export const RESUME_POLICIES = Object.freeze(['auto', 'new', 'require-resume'])
export const SESSION_STATES = Object.freeze(['idle', 'running', 'failed', 'expired', 'invalidated', 'unconfirmed'])

const SESSION_FILE = 'oh-my-coharness-sessions.json'
const DEFAULT_MAX_TURNS = 24
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LOCK_TIMEOUT_MS = 120_000
const DEFAULT_MAX_ENTRIES = 200

/** `$DSH_HOME` or `~/.dsh`; the same root the plugin configuration uses. */
export function defaultSessionFile(env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, SESSION_FILE)
}

function string(value, max = 200) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** Canonical key. Every field is part of the identity; none may be inferred later. */
export function sessionKeyFor({
  projectId = '',
  laneId = '',
  role = '',
  harness = '',
  model = '',
  environment = '',
  workspace = '',
  endpoint = '',
} = {}) {
  return {
    projectId: string(projectId, 80),
    laneId: string(laneId, 80),
    role: string(role, 40),
    harness: string(harness, 40),
    model: string(model, 120),
    environment: string(environment, 80),
    workspace: string(workspace, 400),
    endpoint: string(endpoint, 80),
  }
}

/** Stable hash used as the map key. The full key remains inside the record. */
export function sessionKeyHash(key) {
  const ordered = {}
  for (const name of Object.keys(key ?? {}).sort()) ordered[name] = key[name]
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

function mask(id) {
  const value = typeof id === 'string' ? id : ''
  if (value.length <= 8) return value ? '***' : ''
  return `${value.slice(0, 6)}…${value.slice(-2)}`
}

function sessionError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function blank() {
  return { schemaVersion: SESSION_SCHEMA_VERSION, updatedAt: null, sessions: {} }
}

function validRecord(record) {
  return record
    && typeof record === 'object'
    && record.key
    && typeof record.key === 'object'
    && SESSION_STATES.includes(record.state)
}

/**
 * A record is resumable only on an exact key match, after a successful run,
 * before its turn cap and inside its idle window.
 */
export function canResumeRecord(record, key, { maxTurns = DEFAULT_MAX_TURNS, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!validRecord(record)) return false
  if (record.state !== 'idle') return false
  if (typeof record.native?.sessionId !== 'string' || record.native.sessionId.length < 6) return false
  if (sessionKeyHash(record.key) !== sessionKeyHash(key)) return false
  if (!Number.isSafeInteger(record.turns) || record.turns < 0 || record.turns >= maxTurns) return false
  const used = Date.parse(record.lastUsedAt ?? '')
  if (!Number.isFinite(used)) return false
  return now - used <= ttlMs
}

function settingsOf(cfg) {
  if (cfg && typeof cfg === 'object' && cfg.sessions && typeof cfg.sessions === 'object') return cfg.sessions
  return cfg && typeof cfg === 'object' ? cfg : {}
}

function integer(value, min, max, fallback) {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/**
 * @param {{ sessions?: object }|object} cfg - either the full config or `cfg.sessions`.
 * @param {{ path?: string, now?: () => number, lockTimeoutMs?: number }} [options]
 */
export function createSessionRegistry(cfg = {}, options = {}) {
  const settings = settingsOf(cfg)
  const path = resolve(
    options.path
      ?? (typeof settings.path === 'string' && settings.path.trim() !== '' ? settings.path : defaultSessionFile()),
  )
  const now = options.now ?? (() => Date.now())
  const maxTurns = integer(settings.maxTurns, 1, 200, DEFAULT_MAX_TURNS)
  const ttlMs = integer(settings.idleTtlMs, 60_000, 365 * 24 * 60 * 60 * 1000, DEFAULT_TTL_MS)
  const lockTimeoutMs = integer(
    options.lockTimeoutMs ?? settings.lockTimeoutMs,
    1_000,
    30 * 60 * 1000,
    DEFAULT_LOCK_TIMEOUT_MS,
  )
  const maxEntries = integer(settings.maxEntries, 1, 10_000, DEFAULT_MAX_ENTRIES)

  let data = null
  let loadError = null
  let corruptSource = null
  const active = new Map()

  function load() {
    if (data) return data
    if (!existsSync(path)) {
      data = blank()
      return data
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (!parsed || parsed.schemaVersion !== SESSION_SCHEMA_VERSION || typeof parsed.sessions !== 'object') {
        throw new Error('unsupported session registry schema')
      }
      const sessions = {}
      for (const [hash, record] of Object.entries(parsed.sessions)) {
        if (validRecord(record)) sessions[hash] = record
      }
      data = { schemaVersion: SESSION_SCHEMA_VERSION, updatedAt: parsed.updatedAt ?? null, sessions }
      return data
    } catch (error) {
      // Never destroy a user file just because it cannot be parsed. The first
      // write moves it aside; until then the registry behaves as empty.
      loadError = String(error?.message ?? error)
      corruptSource = path
      data = blank()
      return data
    }
  }

  function prune(store) {
    const rows = Object.entries(store)
    if (rows.length <= maxEntries) return
    rows
      .filter(([, record]) => record.state !== 'running')
      .sort((a, b) => Date.parse(b[1].lastUsedAt ?? 0) - Date.parse(a[1].lastUsedAt ?? 0))
      .slice(maxEntries)
      .forEach(([hash]) => delete store[hash])
  }

  function save() {
    const store = load()
    store.updatedAt = new Date(now()).toISOString()
    prune(store.sessions)

    const dir = dirname(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (corruptSource === path) {
      // Preserve the unreadable file instead of silently overwriting it. The
      // user can inspect the backup; the registry starts from a clean document.
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`)
      } catch {
        // If it cannot be moved, the write below is still the user's explicit
        // action (a run or a clear), so replacing it is acceptable.
      }
      corruptSource = null
      loadError = null
    }
    const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    const body = `${JSON.stringify(store, null, 2)}\n`
    try {
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      try {
        renameSync(temp, path)
      } catch (error) {
        // Windows can refuse to replace an existing file; the fallback keeps the
        // update deterministic even though it is not a single atomic rename.
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
        rmSync(path, { force: true })
        renameSync(temp, path)
      }
      try {
        chmodSync(path, 0o600)
      } catch {
        // Best effort on Windows; the default ACL of the user's Home still applies.
      }
    } finally {
      try {
        rmSync(temp, { force: true })
      } catch {
        // The rename already consumed the temp file in the normal path.
      }
    }
  }

  function copy(record) {
    return record ? JSON.parse(JSON.stringify(record)) : null
  }

  function find(key) {
    const hash = sessionKeyHash(key)
    const record = load().sessions[hash]
    return record && canResumeRecord(record, key, { maxTurns, ttlMs, now: now() }) ? copy(record) : null
  }

  /**
   * Take the single writer lease for one key. A second caller waits for the
   * first to settle (or fails with OMC/SESSION-BUSY after the configured bound)
   * rather than resuming the same native conversation concurrently.
   */
  async function acquire(key) {
    const hash = sessionKeyHash(key)
    const started = now()
    while (active.has(hash)) {
      const remaining = lockTimeoutMs - (now() - started)
      if (remaining <= 0) {
        throw sessionError('OMC/SESSION-BUSY', `another run holds the session for lane "${key.laneId}"`)
      }
      await Promise.race([
        active.get(hash),
        new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(remaining, 1000))),
      ])
    }

    let releaseGate
    const gate = new Promise((resolvePromise) => {
      releaseGate = resolvePromise
    })
    active.set(hash, gate)

    const store = load()
    const existing = store.sessions[hash]
    const record = existing && canResumeRecord(existing, key, { maxTurns, ttlMs, now: now() }) ? copy(existing) : null
    const timestamp = new Date(now()).toISOString()
    if (!existing) {
      store.sessions[hash] = {
        key: { ...key },
        native: null,
        state: 'running',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        turns: 0,
        usage: { last: null, totals: null },
        lastTaskId: null,
        lastError: null,
      }
    } else {
      existing.state = 'running'
      existing.lastUsedAt = timestamp
    }
    try {
      save()
    } catch (error) {
      active.delete(hash)
      releaseGate()
      throw sessionError('OMC/SESSION-STORE', String(error?.message ?? error))
    }

    let released = false
    const lease = {
      hash,
      key: { ...key },
      record,
      release() {
        if (released) return
        released = true
        active.delete(hash)
        releaseGate()
      },
    }
    return lease
  }

  function complete(lease, { sessionId, format, usage, taskId } = {}) {
    const store = load()
    const record = store.sessions[lease.hash]
    if (!record) return null
    const timestamp = new Date(now()).toISOString()
    record.lastUsedAt = timestamp
    record.lastTaskId = string(taskId, 80) || record.lastTaskId
    record.lastError = null
    if (typeof sessionId === 'string' && sessionId.length >= 6) {
      record.native = { sessionId, format: string(format, 40) || null }
      record.state = 'idle'
      record.turns = (Number.isSafeInteger(record.turns) ? record.turns : 0) + 1
      if (usage) {
        record.usage = {
          last: usage,
          totals: mergeUsage(record.usage?.totals, usage),
        }
      }
    } else {
      // A resumed run that did not echo an id is not proof that the session is
      // still the same conversation. Keep the old id for audit, but do not
      // resume it again until a future run confirms identity.
      record.state = 'unconfirmed'
      record.lastError = 'native session id was not present in the CLI output'
    }
    save()
    return copy(record)
  }

  function fail(lease, { code, message, taskId } = {}) {
    const store = load()
    const record = store.sessions[lease.hash]
    if (!record) return null
    record.state = 'failed'
    record.lastUsedAt = new Date(now()).toISOString()
    record.lastTaskId = string(taskId, 80) || record.lastTaskId
    record.lastError = string(code ? `${code}: ${message ?? ''}` : message, 300) || 'run failed'
    save()
    return copy(record)
  }

  function unconfirmed(lease, { reason, taskId } = {}) {
    const store = load()
    const record = store.sessions[lease.hash]
    if (!record) return null
    record.state = 'unconfirmed'
    record.lastUsedAt = new Date(now()).toISOString()
    record.lastTaskId = string(taskId, 80) || record.lastTaskId
    record.lastError = string(reason, 300) || 'session identity was not confirmed'
    save()
    return copy(record)
  }

  function invalidate(keyOrHash) {
    const hash = typeof keyOrHash === 'string' ? keyOrHash : sessionKeyHash(keyOrHash)
    const record = load().sessions[hash]
    if (!record) return false
    record.state = 'invalidated'
    record.lastError = 'invalidated by the user'
    record.lastUsedAt = new Date(now()).toISOString()
    save()
    return true
  }

  function clear() {
    data = blank()
    save()
    return true
  }

  function stats() {
    const store = load()
    const states = Object.fromEntries(SESSION_STATES.map((state) => [state, 0]))
    const harnesses = {}
    let resumable = 0
    for (const record of Object.values(store.sessions)) {
      states[record.state] = (states[record.state] ?? 0) + 1
      const harness = string(record.key?.harness, 40) || 'unknown'
      harnesses[harness] = (harnesses[harness] ?? 0) + 1
      if (canResumeRecord(record, record.key, { maxTurns, ttlMs, now: now() })) resumable += 1
    }
    return {
      path,
      enabled: settings.enabled !== false,
      resumePolicy: RESUME_POLICIES.includes(settings.resumePolicy) ? settings.resumePolicy : 'auto',
      entries: Object.keys(store.sessions).length,
      states,
      harnesses,
      resumable,
      loadError,
      updatedAt: store.updatedAt,
    }
  }

  function list({ limit = 20 } = {}) {
    const store = load()
    return Object.values(store.sessions)
      .filter(validRecord)
      .sort((a, b) => Date.parse(b.lastUsedAt ?? 0) - Date.parse(a.lastUsedAt ?? 0))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((record) => ({
        laneId: record.key.laneId,
        projectId: record.key.projectId,
        role: record.key.role,
        harness: record.key.harness,
        model: record.key.model,
        state: record.state,
        turns: record.turns,
        lastUsedAt: record.lastUsedAt,
        lastTaskId: record.lastTaskId,
        sessionId: mask(record.native?.sessionId),
      }))
  }

  return {
    path,
    acquire,
    find,
    complete,
    fail,
    unconfirmed,
    invalidate,
    clear,
    stats,
    list,
    settings: { maxTurns, ttlMs, lockTimeoutMs, maxEntries },
  }
}

function mergeUsage(total, usage) {
  const base = total && typeof total === 'object' ? total : {}
  const add = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : a ?? b ?? null)
  return {
    inputTokens: add(base.inputTokens, usage.inputTokens),
    outputTokens: add(base.outputTokens, usage.outputTokens),
    cachedInputTokens: add(base.cachedInputTokens, usage.cachedInputTokens),
    costUsd: add(base.costUsd, usage.costUsd),
  }
}
