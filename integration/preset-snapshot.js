/**
 * Per-session OMC role-configuration snapshots.
 *
 * DSH locks an Agent's preset after its first turn, so OMC cannot honestly
 * hot-switch a running session. What it can do is answer the next question
 * precisely: what did this session actually start with, and how does the
 * current global configuration differ? Saving settings is still not a switch.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const PRESET_SNAPSHOT_VERSION = 2

const COMPARED_FIELDS = [
  'enabled', 'provider', 'model', 'effort', 'maxTokens', 'execution', 'tools', 'deny', 'mcps', 'personaAppend',
]

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

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** The stable subset of one role document that a snapshot compares. */
export function comparableRole(role = {}) {
  const out = {}
  for (const field of COMPARED_FIELDS) {
    if (role[field] !== undefined) out[field] = role[field]
  }
  return out
}

/**
 * Compare a snapshot with the current effective role config.
 * @param {object} snapshot - `{ roles, orchestrator }`
 * @param {object} current - `{ roles, orchestrator }`
 */
export function diffPresetSnapshot(snapshot, current) {
  const before = snapshot?.roles ?? {}
  const after = current?.roles ?? {}
  const roles = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const changes = []
  for (const roleId of roles) {
    const left = comparableRole(before[roleId])
    const right = comparableRole(after[roleId])
    if (!same(left, right)) changes.push({ roleId, before: left, after: right })
  }
  const orchestratorChanged = !same(snapshot?.orchestrator ?? null, current?.orchestrator ?? null)
  return {
    changed: changes,
    orchestratorChanged,
    same: changes.length === 0 && !orchestratorChanged,
  }
}

export function createPresetSnapshotStore({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const cache = new Map()

  function fileFor(parentId, kind) {
    return join(dir, safeSegment(parentId, 'parent') + (kind === 'manual' ? '.manual' : '') + '.json')
  }

  function writeKind(kind, parentId, snapshot, { once = false } = {}) {
    const value = {
      schemaVersion: PRESET_SNAPSHOT_VERSION,
      parentId,
      kind,
      at: new Date().toISOString(),
      source: snapshot?.source ?? null,
      preset: snapshot?.preset ?? null,
      orchestrator: snapshot?.orchestrator ?? {},
      roles: snapshot?.roles ?? {},
    }
    if (!durable) {
      const existing = cache.get(parentId + ':' + kind)
      if (once && existing) return { created: false, value: existing }
      cache.set(parentId + ':' + kind, value)
      return { created: true, value }
    }
    const file = fileFor(parentId, kind)
    if (once && existsSync(file)) {
      try {
        return { created: false, value: JSON.parse(readFileSync(file, 'utf8')) }
      } catch {
        // An unreadable baseline is overwritten rather than trusted: the file
        // claims to be the immutable startup record and cannot be read.
      }
    }
    const lock = acquireFileLockSync(file, { timeoutMs: lockTimeoutMs, label: 'preset-snapshot' })
    try {
      atomicWrite(file, JSON.stringify(value, null, 2) + '\n')
    } finally {
      lock.release()
    }
    return { created: true, value }
  }

  function readKind(kind, parentId) {
    if (!durable) return cache.get(parentId + ':' + kind) ?? null
    const file = fileFor(parentId, kind)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  return {
    /**
     * The immutable startup baseline: written once per parent session, never
     * replaced by a later manual snapshot. A manual `write()` cannot pose as
     * the startup record.
     */
    ensureStartup(parentId, snapshot) {
      return writeKind('startup', parentId, snapshot, { once: true })
    },
    /** A manual snapshot, labeled as such; it never touches the startup file. */
    write(parentId, snapshot) {
      return writeKind('manual', parentId, snapshot)
    },
    read(parentId) {
      const startup = readKind('startup', parentId)
      const manual = readKind('manual', parentId)
      return startup || manual ? { startup, manual } : null
    },
    clear(parentId) {
      if (!durable) {
        cache.delete(parentId + ':startup')
        cache.delete(parentId + ':manual')
        return true
      }
      let ok = true
      for (const kind of ['startup', 'manual']) {
        try { rmSync(fileFor(parentId, kind), { force: true }) } catch { ok = false }
      }
      return ok
    },
  }
}
