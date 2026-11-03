/**
 * Retrieval cache for provably side-effect-free reads (0.5.0-alpha.2 WP04).
 *
 * Only retrievals whose inputs can be fingerprinted are cached: the key is
 * (workspace identity, tool, tool version, arguments, input file digests).
 * A read failure, an unverifiable invalidation condition, a tool that is not
 * on the read-only allowlist, or any input whose digest changed is a MISS —
 * never a stale hit (V0.5-ALPHA2-PLAN §4.4).
 *
 * Test results may be stored as reusable EVIDENCE, but an evidence entry is
 * marked `evidenceOnly` on lookup: it informs the next run and never replaces
 * the final acceptance test of a delivering node.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const RETRIEVAL_CACHE_VERSION = 1
/** Tools whose result is provably a pure function of the fingerprinted inputs. */
export const RETRIEVAL_SAFE_TOOLS = Object.freeze(['read', 'grep', 'glob', 'ls'])

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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function fileDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * The cache key. `inputs` is the list of files the answer depends on; a null
 * digest (unreadable) or a missing list makes the entry unprovable, and
 * `key()` returns null — callers treat null as "cannot cache" (miss).
 */
export function retrievalKey({ workspace, tool, toolVersion, args, inputs }) {
  if (!RETRIEVAL_SAFE_TOOLS.includes(tool)) return null
  if (!Array.isArray(inputs) || inputs.length === 0) return null
  const digestParts = []
  for (const input of inputs) {
    if (typeof input?.path !== 'string' || typeof input?.digest !== 'string' || input.digest === '') return null
    digestParts.push(`${input.path}:${input.digest}`)
  }
  const payload = stableStringify({
    v: RETRIEVAL_CACHE_VERSION, workspace: String(workspace ?? ''), tool,
    toolVersion: String(toolVersion ?? ''), args: args ?? {}, inputs: digestParts,
  })
  return `rc-${createHash('sha256').update(payload).digest('hex').slice(0, 24)}`
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 */
export function createRetrievalCache({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const memory = new Map()

  function fileFor(key) {
    return join(dir, `${safeSegment(key, 'rc')}.json`)
  }

  function load(key) {
    if (!durable) return memory.get(key) ?? null
    const file = fileFor(key)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed?.schemaVersion === RETRIEVAL_CACHE_VERSION ? parsed : null
    } catch {
      return null
    }
  }

  return {
    /**
     * Fingerprint one file for the caller (or null when unreadable — an
     * unreadable input can never prove freshness).
     */
    fingerprint(path) {
      return fileDigest(path)
    },

    /**
     * Look up one retrieval. The caller re-computes the input digests (or
     * passes `fingerprint` results); a key that cannot be built is a miss by
     * construction.
     */
    lookup({ workspace, tool, toolVersion, args, inputs, kind = 'retrieval' }) {
      const key = retrievalKey({ workspace, tool, toolVersion, args, inputs })
      if (!key) return { hit: false, reason: 'unprovable-inputs' }
      const entry = load(key)
      if (!entry) return { hit: false, reason: 'not-cached', key }
      return {
        hit: true,
        key,
        value: entry.value,
        exitCode: entry.exitCode,
        storedAt: entry.storedAt,
        kind: entry.kind,
        // Test evidence informs; it never replaces final acceptance.
        evidenceOnly: entry.kind === 'test-evidence',
        ...(entry.kind === 'test-evidence' ? { note: 'reusable evidence only; the delivering node still runs its final acceptance test' } : {}),
      }
    },

    /**
     * Store one successful retrieval (or a test-evidence result). Failures
     * are never cached; a side-effect tool never gets here (key null).
     */
    store({ workspace, tool, toolVersion, args, inputs, value, exitCode = 0, kind = 'retrieval' }) {
      const key = retrievalKey({ workspace, tool, toolVersion, args, inputs })
      if (!key) return { stored: false, reason: 'unprovable-inputs' }
      if (exitCode !== 0) return { stored: false, reason: 'read-failed' }
      const entry = {
        schemaVersion: RETRIEVAL_CACHE_VERSION,
        key, tool, toolVersion, kind,
        args: args ?? {},
        inputs: inputs.map((input) => ({ path: input.path, digest: input.digest })),
        exitCode,
        value: typeof value === 'string' ? value : JSON.stringify(value ?? null),
        storedAt: new Date().toISOString(),
      }
      if (!durable) {
        memory.set(key, entry)
        return { stored: true, key }
      }
      const lock = acquireFileLockSync(join(dir, safeSegment(key, 'rc')), {
        timeoutMs: lockTimeoutMs, staleMs: Math.max(30_000, lockTimeoutMs * 2), label: 'retrieval-cache',
      })
      try {
        atomicWrite(fileFor(key), JSON.stringify(entry, null, 2) + '\n')
      } finally {
        lock.release()
      }
      return { stored: true, key }
    },

    /** Drop entries matching a predicate over the stored entry. */
    invalidate(match) {
      const dropped = []
      const visit = (key, entry) => {
        if (match(entry)) {
          dropped.push(key)
          if (durable) {
            try { rmSync(fileFor(key), { force: true }) } catch { /* best effort */ }
          } else {
            memory.delete(key)
          }
        }
      }
      if (durable) {
        if (!existsSync(dir)) return dropped
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.json')) continue
          const key = name.slice(0, -'.json'.length)
          const entry = load(key)
          if (entry) visit(key, entry)
        }
      } else {
        for (const [key, entry] of [...memory.entries()]) visit(key, entry)
      }
      return dropped
    },
  }
}
