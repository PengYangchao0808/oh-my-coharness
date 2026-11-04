/**
 * Project-level Writer Lease (0.6).
 *
 * `graph.claim` already stops two write nodes in the SAME graph from overlapping
 * their write scopes. It cannot stop two DSH host processes that both work
 * against the same project on disk. This module adds that missing project-level
 * exclusion: at most one active writer per project (a project is identified by
 * the realpath of its workspace root), no matter how many graphs, sessions or
 * processes exist.
 *
 * The lease record is a small JSON file under
 * `<stateRoot>/writer/<key>.json`, where `key = sha256(realpath(workspaceRoot))`.
 * It is mutated under the real file lock from `./file-lock.js`, so a takeover
 * race across processes has one winner. The record never contains prompts,
 * credentials or workspace source.
 *
 * Ownership is proven by a random `token`. Repeated acquisition by the same
 * owner with the same token is idempotent (host restarts retry claims). Another
 * owner is refused with `OMC/WRITER-BUSY`. A lease can be taken over only when
 * the owner process is demonstrably gone (or, across hosts, when its heartbeat
 * has expired) — never merely because a record "looks old" while its process is
 * still alive.
 *
 * Default heartbeat cadence is 15s and the default TTL is 45s. Callers are
 * expected to call `heartbeat()` at that cadence; both values are injectable,
 * and `now` is injectable for tests.
 *
 * Node ESM, no dependencies, all failures are fail-closed and carry an
 * `OMC/WRITER-*` code.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import { acquireFileLockSync } from './file-lock.js'

export const WRITER_LEASE_SCHEMA_VERSION = 1
export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_TTL_MS = 45_000

const realpath = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
const US = 'OMC/WRITER-'

function leaseError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function invalid(message) {
  return leaseError(`${US}INVALID`, message)
}

function corrupt(reason, path) {
  return leaseError(`${US}CORRUPT`, `writer lease record "${path}" is not trustworthy (${reason}); refusing to treat the project as free`)
}

function busy(message) {
  return leaseError(`${US}BUSY`, message)
}

function lost(message) {
  return leaseError(`${US}LOST`, message)
}

function notOwner(action) {
  return leaseError(`${US}NOT-OWNER`, `only the lease holder may ${action}`)
}

function ioError(action, path, error) {
  return leaseError(`${US}IO`, `${action} "${path}" failed: ${error?.message ?? error}`)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function normalizeText(value, label, max = 400) {
  if (typeof value !== 'string') throw invalid(`${label} must be a non-empty string`)
  const text = value.trim()
  if (text === '') throw invalid(`${label} must be a non-empty string`)
  if (text.length > max) throw invalid(`${label} must be at most ${max} characters`)
  if (/[\u0000-\u001f]/.test(text)) throw invalid(`${label} must not contain control characters`)
  return text
}

function normalizePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${label} must be a positive safe integer`)
  return value
}

function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw invalid('workspaceRoot must be a non-empty path')
  }
  let canonical
  try {
    canonical = realpath(workspaceRoot)
  } catch (error) {
    throw invalid(`workspaceRoot "${workspaceRoot}" does not resolve: ${error?.message ?? error}`)
  }
  let isDirectory = false
  try {
    isDirectory = statSync(canonical).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw invalid(`workspaceRoot "${workspaceRoot}" is not an existing directory`)
  return canonical
}

/** Stable project key: `sha256(realpath(workspaceRoot))`, hex encoded. */
export function writerLeaseKey(workspaceRoot) {
  return sha256(canonicalWorkspaceRoot(workspaceRoot))
}

/** True when `pid` names a live process this machine can still signal. */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * @param {object} options
 * @param {string} options.stateRoot state directory; leases live under `<stateRoot>/writer/`
 * @param {string} options.workspaceRoot project root whose realpath is the lease key
 * @param {string} [options.owner] default owner (`parentId#nodeId`) for acquire/heartbeat/release
 * @param {number} [options.heartbeatMs] expected heartbeat cadence (default 15000)
 * @param {number} [options.ttlMs] takeover threshold (default 45000)
 * @param {() => number} [options.now] injectable clock for tests
 * @param {number} [options.pid] owner pid override for tests (default `process.pid`)
 * @param {string} [options.host] host override for tests (default `hostname()`)
 * @param {number} [options.lockTimeoutMs] file-lock wait for the short critical section
 * @param {number} [options.lockStaleMs] file-lock stale threshold (crash recovery of the mutex)
 */
export function createWriterLease({
  stateRoot,
  workspaceRoot,
  owner,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  pid = process.pid,
  host = hostname(),
  lockTimeoutMs = 5_000,
  lockStaleMs = 30_000,
} = {}) {
  if (typeof stateRoot !== 'string' || stateRoot.trim() === '') {
    throw invalid('stateRoot must be a non-empty path')
  }
  if (typeof now !== 'function') throw invalid('now must be a function returning epoch milliseconds')
  if (typeof host !== 'string' || host.trim() === '') throw invalid('host must be a non-empty string')
  if (!Number.isSafeInteger(pid) || pid <= 0) throw invalid('pid must be a positive safe integer')

  const heartbeatInterval = normalizePositiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS, 'heartbeatMs')
  const ttl = normalizePositiveInteger(ttlMs, DEFAULT_TTL_MS, 'ttlMs')
  if (ttl < heartbeatInterval) throw invalid('ttlMs must be greater than or equal to heartbeatMs')
  const lockTimeout = normalizePositiveInteger(lockTimeoutMs, 5_000, 'lockTimeoutMs')
  const lockStale = normalizePositiveInteger(lockStaleMs, 30_000, 'lockStaleMs')

  const canonicalStateRoot = resolve(stateRoot)
  const canonicalWorkspace = canonicalWorkspaceRoot(workspaceRoot)
  const key = sha256(canonicalWorkspace)
  const writerDir = join(canonicalStateRoot, 'writer')
  const recordPath = join(writerDir, `${key}.json`)
  const lockTarget = join(writerDir, key)
  const defaultOwner = owner === undefined || owner === null ? null : normalizeText(owner, 'owner')

  try {
    mkdirSync(writerDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw ioError('create writer lease directory', writerDir, error)
  }

  function clock() {
    const value = now()
    if (!Number.isFinite(value)) throw invalid('now() must return a finite epoch-millisecond number')
    return value
  }

  function resolveOwner(value) {
    if (value === undefined || value === null) {
      if (defaultOwner === null) throw invalid('owner is required (expected "parentId#nodeId")')
      return defaultOwner
    }
    return normalizeText(value, 'owner')
  }

  function resolveToken(value) {
    if (value === undefined || value === null) throw invalid('token is required to prove lease ownership')
    return normalizeText(value, 'token', 200)
  }

  function readRecord() {
    let raw
    try {
      raw = readFileSync(recordPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { record: null, problem: null }
      throw ioError('read writer lease record', recordPath, error)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { record: null, problem: `invalid JSON: ${error?.message ?? error}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { record: null, problem: 'not a JSON object' }
    }
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== WRITER_LEASE_SCHEMA_VERSION) {
      return { record: null, problem: `unsupported schemaVersion ${String(parsed.schemaVersion)}` }
    }
    if (parsed.key !== key) return { record: null, problem: 'lease key does not match this project workspace' }
    if (typeof parsed.workspaceRoot !== 'string' || parsed.workspaceRoot !== canonicalWorkspace) {
      return { record: null, problem: 'workspaceRoot does not match this project workspace' }
    }
    if (typeof parsed.token !== 'string' || parsed.token.trim() === '') {
      return { record: null, problem: 'missing token' }
    }
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      return { record: null, problem: 'invalid pid' }
    }
    if (typeof parsed.owner !== 'string' || parsed.owner.trim() === '') {
      return { record: null, problem: 'missing owner' }
    }
    if (!Number.isFinite(parsed.heartbeatAt)) {
      return { record: null, problem: 'missing heartbeatAt' }
    }
    if (parsed.expiresAt !== undefined && !Number.isFinite(parsed.expiresAt)) {
      return { record: null, problem: 'invalid expiresAt' }
    }
    return { record: parsed, problem: null }
  }

  function readOrThrow() {
    const { record, problem } = readRecord()
    if (problem) throw corrupt(problem, recordPath)
    return record
  }

  function expiredAt(record, nowMs) {
    if (Number.isFinite(record.expiresAt)) return nowMs >= record.expiresAt
    return nowMs - record.heartbeatAt > ttl
  }

  function foreignHost(record) {
    return typeof record.host === 'string' && record.host !== host
  }

  function mayTakeOver(record, nowMs) {
    const expired = expiredAt(record, nowMs)
    if (foreignHost(record)) {
      return expired
        ? { allowed: true, reason: 'foreign owner heartbeat expired', expired }
        : { allowed: false, reason: `held by another host ("${record.host}") with a fresh heartbeat`, expired }
    }
    if (processAlive(record.pid)) {
      return { allowed: false, reason: `owner process ${record.pid} is still alive`, expired }
    }
    return {
      allowed: true,
      reason: expired ? `owner process ${record.pid} is gone and its heartbeat expired` : `owner process ${record.pid} is gone`,
      expired,
    }
  }

  function makeRecord(token, targetOwner, heartbeatAt) {
    const timestamp = new Date(heartbeatAt).toISOString()
    return {
      schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
      key,
      token,
      pid,
      owner: targetOwner,
      workspaceRoot: canonicalWorkspace,
      host,
      createdAt: timestamp,
      updatedAt: timestamp,
      heartbeatAt,
      expiresAt: heartbeatAt + ttl,
      heartbeatMs: heartbeatInterval,
      ttlMs: ttl,
    }
  }

  function writeRecord(record) {
    const temp = `${recordPath}.${pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        renameSync(temp, recordPath)
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
        rmSync(recordPath, { force: true })
        renameSync(temp, recordPath)
      }
    } catch (error) {
      throw ioError('persist writer lease record', recordPath, error)
    } finally {
      try { rmSync(temp, { force: true }) } catch { /* consumed by rename */ }
    }
    return record
  }

  function withLock(fn) {
    let lock
    try {
      lock = acquireFileLockSync(lockTarget, {
        timeoutMs: lockTimeout,
        staleMs: lockStale,
        label: `writer-lease:${key}`,
      })
    } catch (error) {
      if (error?.code === 'OMC/LOCK-TIMEOUT') {
        throw busy(`timed out updating the project writer lease (${key})`)
      }
      if (typeof error?.code === 'string' && error.code.startsWith('OMC/')) throw error
      throw ioError('acquire writer lease lock', lockTarget, error)
    }
    try {
      return fn()
    } finally {
      try { lock.release() } catch { /* the record, not the mutex, is the authority */ }
    }
  }

  function result(record, { idempotent, renewed }) {
    return {
      ok: true,
      key,
      owner: record.owner,
      token: record.token,
      pid: record.pid,
      path: recordPath,
      idempotent,
      renewed,
      record: clone(record),
    }
  }

  /**
   * Acquire the project's writer lease.
   * Same owner + same token is idempotent; any other live holder refuses with
   * `OMC/WRITER-BUSY`. A corrupt record refuses with `OMC/WRITER-CORRUPT`.
   */
  function acquire(options = {}) {
    const request = typeof options === 'string' ? { owner: options } : (options ?? {})
    const targetOwner = resolveOwner(request.owner)
    const requestedToken = request.token === undefined || request.token === null
      ? null
      : normalizeText(request.token, 'token', 200)
    const token = requestedToken ?? randomUUID()

    return withLock(() => {
      const existing = readOrThrow()
      if (existing) {
        const sameOwner = existing.owner === targetOwner
        const sameToken = requestedToken !== null && existing.token === token
        if (sameOwner && (requestedToken === null || sameToken)) {
          const nowMs = clock()
          const expired = expiredAt(existing, nowMs)
          const ownerAlive = !foreignHost(existing) && processAlive(existing.pid)
          if (existing.pid !== pid && ownerAlive) {
            // A live process still owns this exact owner+token; do not steal its
            // pid, just confirm the lease instead.
            return result(existing, { idempotent: true, renewed: false })
          }
          if (existing.pid !== pid || foreignHost(existing) || expired) {
            const renewed = writeRecord({
              ...existing,
              pid,
              host,
              updatedAt: new Date(nowMs).toISOString(),
              heartbeatAt: nowMs,
              expiresAt: nowMs + ttl,
            })
            return result(renewed, { idempotent: true, renewed: true })
          }
          return result(existing, { idempotent: true, renewed: false })
        }
        const verdict = mayTakeOver(existing, clock())
        if (!verdict.allowed) {
          throw busy(
            `project "${canonicalWorkspace}" already has a writer lease owned by "${existing.owner}" ` +
            `(pid ${existing.pid}); ${verdict.reason}`,
          )
        }
      }
      const nowMs = clock()
      const record = writeRecord(makeRecord(token, targetOwner, nowMs))
      return result(record, { idempotent: false, renewed: false })
    })
  }

  /** Renew the lease. Only the token holder may heartbeat. */
  function heartbeat(options = {}) {
    const request = typeof options === 'string' ? { token: options } : (options ?? {})
    const token = resolveToken(request.token)
    const expectedOwner = request.owner === undefined || request.owner === null
      ? defaultOwner
      : normalizeText(request.owner, 'owner')

    return withLock(() => {
      const record = readOrThrow()
      if (!record) throw lost(`no writer lease exists for project "${canonicalWorkspace}"`)
      if (record.token !== token) throw notOwner('heartbeat')
      if (expectedOwner !== null && record.owner !== expectedOwner) throw notOwner('heartbeat')
      const nowMs = clock()
      const updated = writeRecord({
        ...record,
        pid,
        host,
        updatedAt: new Date(nowMs).toISOString(),
        heartbeatAt: nowMs,
        expiresAt: nowMs + ttl,
      })
      return {
        ok: true,
        key,
        owner: updated.owner,
        token,
        path: recordPath,
        heartbeatAt: updated.heartbeatAt,
        expiresAt: updated.expiresAt,
        record: clone(updated),
      }
    })
  }

  /** Release the lease. Only the token holder may release; a missing lease is idempotent. */
  function release(options = {}) {
    const request = typeof options === 'string' ? { token: options } : (options ?? {})
    const token = resolveToken(request.token)
    const expectedOwner = request.owner === undefined || request.owner === null
      ? defaultOwner
      : normalizeText(request.owner, 'owner')

    return withLock(() => {
      const record = readOrThrow()
      if (!record) {
        return { ok: true, key, released: false, idempotent: true, path: recordPath }
      }
      if (record.token !== token) throw notOwner('release')
      if (expectedOwner !== null && record.owner !== expectedOwner) throw notOwner('release')
      try {
        rmSync(recordPath, { force: true })
      } catch (error) {
        throw ioError('remove writer lease record', recordPath, error)
      }
      return { ok: true, key, released: true, idempotent: false, path: recordPath }
    })
  }

  /**
   * Read-only inspection. A corrupt record is reported as `corrupt`, never as
   * `vacant`: fail-closed callers must not mistake damage for freedom.
   */
  function status() {
    const { record, problem } = readRecord()
    if (problem) {
      return {
        key,
        path: recordPath,
        state: 'corrupt',
        corrupt: true,
        error: problem,
        owner: null,
        record: null,
        alive: false,
        expired: false,
        ageMs: null,
        heartbeatMs: heartbeatInterval,
        ttlMs: ttl,
      }
    }
    if (!record) {
      return {
        key,
        path: recordPath,
        state: 'vacant',
        corrupt: false,
        owner: null,
        record: null,
        alive: false,
        expired: false,
        ageMs: null,
        heartbeatMs: heartbeatInterval,
        ttlMs: ttl,
      }
    }
    const nowMs = clock()
    const expired = expiredAt(record, nowMs)
    const foreign = foreignHost(record)
    const alive = foreign ? null : processAlive(record.pid)
    let state = 'held'
    if (!foreign && !alive) state = 'stale'
    else if (expired) state = 'expired'
    return {
      key,
      path: recordPath,
      state,
      corrupt: false,
      owner: record.owner,
      record: clone(record),
      alive,
      expired,
      foreign,
      ageMs: nowMs - record.heartbeatAt,
      heartbeatMs: heartbeatInterval,
      ttlMs: ttl,
    }
  }

  return {
    key,
    workspaceRoot: canonicalWorkspace,
    stateRoot: canonicalStateRoot,
    writerDirectory: writerDir,
    path: recordPath,
    owner: defaultOwner,
    heartbeatMs: heartbeatInterval,
    ttlMs: ttl,
    acquire,
    heartbeat,
    release,
    status,
  }
}
