/**
 * Cross-process file locks.
 *
 * The host may run two DSH processes against the same `$DSH_HOME` (Desktop and a
 * CLI/headless host are the common pair). Cordis fibers give us no process
 * boundary, so persistence writes and native-session leases need an OS-level
 * exclusion. This module is deliberately dependency-free: an exclusive-create
 * lock file, a token to prove ownership, a heartbeat for long leases, and a
 * stale-owner takeover for a crashed process.
 *
 * Sync acquisition uses `Atomics.wait` for a short backoff. It is only used for
 * short store transactions. Long-running leases use the async API so the host
 * event loop keeps turning while another process finishes.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
const held = new Map()

function sleepSync(ms) {
  try {
    Atomics.wait(sleepBuffer, 0, 0, Math.max(1, ms))
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* last resort; never reached on Node */ }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)))
}

function lockError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function readLock(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function ageOf(file) {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function stale(file, staleMs) {
  const info = readLock(file)
  if (info && Number.isSafeInteger(info.pid) && info.pid !== process.pid && !ownerAlive(info.pid)) return true
  return ageOf(file) > staleMs
}

function tryTake(file, { token, pid, now, label }) {
  try {
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify({
        token,
        pid,
        host: hostname(),
        label: label ?? null,
        at: new Date(now()).toISOString(),
      }) + '\n')
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

function makeHandle(file, token, onRelease) {
  let released = false
  const handle = {
    path: file,
    token,
    get released() { return released },
    touch() {
      if (released) throw lockError('OMC/LOCK-LOST', `lock ${file} was released`)
      const current = readLock(file)
      if (!current || current.token !== token) {
        throw lockError('OMC/LOCK-LOST', `lock ${file} is no longer owned by this process`)
      }
      const now = new Date()
      try {
        utimesSync(file, now, now)
      } catch (error) {
        throw lockError('OMC/LOCK-LOST', `lock ${file} heartbeat failed: ${error?.message ?? error}`)
      }
    },
    release() {
      if (released) return
      released = true
      const current = readLock(file)
      if (current && current.token !== token) return
      try {
        unlinkSync(file)
      } catch {
        // Another process may have taken over after a stale sweep; never unlink
        // a lock this handle does not own.
      }
      onRelease?.()
    },
  }
  return handle
}

/**
 * Acquire one lock synchronously.
 * @param {string} target resource path; the lock lives at `${target}.lock`
 * @param {{timeoutMs?: number, staleMs?: number, label?: string, now?: () => number}} [options]
 */
export function acquireFileLockSync(target, {
  timeoutMs = 5_000,
  staleMs = 30_000,
  label,
  now = () => Date.now(),
} = {}) {
  const file = `${target}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const existing = held.get(file)
  if (existing) {
    existing.count += 1
    return {
      path: file,
      token: existing.handle.token,
      reentrant: true,
      touch: () => existing.handle.touch(),
      release: () => {
        existing.count -= 1
        if (existing.count <= 0) {
          held.delete(file)
          existing.handle.release()
        }
      },
    }
  }

  const token = randomUUID()
  const started = now()
  for (;;) {
    if (tryTake(file, { token, pid: process.pid, now, label })) break
    if (stale(file, staleMs)) {
      try { unlinkSync(file) } catch { /* another contender may have won */ }
      continue
    }
    const remaining = timeoutMs - (now() - started)
    if (remaining <= 0) throw lockError('OMC/LOCK-TIMEOUT', `could not lock ${target} within ${timeoutMs}ms`)
    sleepSync(Math.min(50, Math.max(5, remaining)))
  }

  const entry = { count: 1, handle: null }
  const handle = makeHandle(file, token, () => held.delete(file))
  entry.handle = handle
  held.set(file, entry)
  return handle
}

/**
 * Acquire one lock without blocking the event loop.
 * @param {string} target
 * @param {{timeoutMs?: number, staleMs?: number, label?: string, signal?: AbortSignal, now?: () => number}} [options]
 */
export async function acquireFileLock(target, {
  timeoutMs = 5_000,
  staleMs = 30_000,
  label,
  signal,
  now = () => Date.now(),
} = {}) {
  const file = `${target}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const existing = held.get(file)
  if (existing) {
    existing.count += 1
    return {
      path: file,
      token: existing.handle.token,
      reentrant: true,
      touch: () => existing.handle.touch(),
      release: () => {
        existing.count -= 1
        if (existing.count <= 0) {
          held.delete(file)
          existing.handle.release()
        }
      },
    }
  }

  const token = randomUUID()
  const started = now()
  for (;;) {
    signal?.throwIfAborted()
    if (tryTake(file, { token, pid: process.pid, now, label })) break
    if (stale(file, staleMs)) {
      try { unlinkSync(file) } catch { /* contender race */ }
      continue
    }
    const remaining = timeoutMs - (now() - started)
    if (remaining <= 0) throw lockError('OMC/LOCK-TIMEOUT', `could not lock ${target} within ${timeoutMs}ms`)
    await delay(Math.min(100, Math.max(10, remaining)))
  }

  const entry = { count: 1, handle: null }
  const handle = makeHandle(file, token, () => held.delete(file))
  entry.handle = handle
  held.set(file, entry)
  return handle
}

/** Run `fn` under one synchronous lock, always releasing it. */
export function withFileLockSync(target, fn, options) {
  const handle = acquireFileLockSync(target, options)
  try {
    return fn()
  } finally {
    handle.release()
  }
}

/** Run `fn` under one async lock, always releasing it. */
export async function withFileLock(target, fn, options) {
  const handle = await acquireFileLock(target, options)
  try {
    return await fn()
  } finally {
    handle.release()
  }
}

/** Test/cleanup hook: release every lock held by this process. */
export function releaseAllLocks() {
  for (const [file, entry] of held) {
    try { entry.handle.release() } catch { /* best effort */ }
    held.delete(file)
  }
}
