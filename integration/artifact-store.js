/**
 * Controlled artifact storage (0.5.0-alpha.2 WP03).
 *
 * Long material (tool output, briefs, reports) that would otherwise bloat a
 * handoff or a model context is stored once and referenced by a stable id.
 *
 * Guarantees (V0.5-ALPHA2-PLAN §4.3):
 *   - every artifact has a stable id, a content hash and provenance
 *     (parent/task/attempt that produced it);
 *   - expansion is bounded and reports truncation; it never silently expands
 *     gigabytes into a context;
 *   - a missing artifact, a tampered blob or an out-of-store path is a typed
 *     error, never "content not found" rendered as empty text;
 *   - readers can verify the content hash, so a changed file is detected as
 *     stale instead of masquerading as the recorded fact.
 *
 * Storage: content blob + metadata JSON per artifact under the profile state
 * root. No credentials, no prompts beyond what the caller explicitly stores.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const ARTIFACT_STORE_VERSION = 1
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

const ARTIFACT_ID = /^art-[A-Za-z0-9_-]{6,32}$/

function artifactError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

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

/**
 * @param {{dir?: string, lockTimeoutMs?: number, maxBytes?: number}} [options]
 *   `dir` defaults to in-memory; the Host passes `<stateRoot>/artifacts`.
 */
export function createArtifactStore({ dir, lockTimeoutMs = 10_000, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const memory = new Map()

  function metaFile(artifactId) {
    return join(dir, safeSegment(artifactId, 'art') + '.json')
  }

  function blobFile(artifactId) {
    return join(dir, safeSegment(artifactId, 'art') + '.txt')
  }

  function loadMeta(artifactId) {
    if (!ARTIFACT_ID.test(String(artifactId ?? ''))) {
      throw artifactError('OMC/ARTIFACT-INVALID-ID', `"${String(artifactId ?? '')}" is not an artifact id`)
    }
    if (!durable) return memory.get(artifactId) ?? null
    const file = metaFile(artifactId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed?.schemaVersion === ARTIFACT_STORE_VERSION ? parsed : null
    } catch {
      return null
    }
  }

  function loadBlob(artifactId) {
    if (!durable) return memory.get(artifactId)?.content ?? null
    const file = blobFile(artifactId)
    if (!existsSync(file)) return null
    return readFileSync(file, 'utf8')
  }

  return {
    /**
     * Store one artifact. `content` is text (the common case: tool output,
     * briefs, reports); `kind` names what it is ("tool-output", "brief",
     * "test-log" …) and provenance travels in the record.
     */
    put({ parentId, taskId, attemptId = null, kind = 'material', label = null, content, contentType = 'text/plain' }) {
      if (typeof content !== 'string') throw artifactError('OMC/ARTIFACT-CONTENT', 'content must be a string')
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > maxBytes) {
        throw artifactError('OMC/ARTIFACT-TOO-LARGE', `content is ${bytes} bytes; the store limit is ${maxBytes}`)
      }
      const artifactId = `art-${randomBytes(9).toString('base64url')}`
      const digest = createHash('sha256').update(content, 'utf8').digest('hex')
      const record = {
        schemaVersion: ARTIFACT_STORE_VERSION,
        artifactId,
        kind,
        label: label ? String(label).slice(0, 160) : null,
        contentType,
        contentHash: digest,
        bytes,
        chars: content.length,
        source: { parentId: parentId ?? null, taskId: taskId ?? null, attemptId: attemptId ?? null },
        storedAt: new Date().toISOString(),
      }
      if (!durable) {
        memory.set(artifactId, { ...record, content })
        return { ...record }
      }
      const lock = acquireFileLockSync(join(dir, safeSegment(artifactId, 'art')), {
        timeoutMs: lockTimeoutMs, staleMs: Math.max(30_000, lockTimeoutMs * 2), label: 'artifact-store',
      })
      try {
        atomicWrite(blobFile(artifactId), content)
        atomicWrite(metaFile(artifactId), JSON.stringify(record, null, 2) + '\n')
      } finally {
        lock.release()
      }
      return { ...record }
    },

    /** Metadata without the content. Throws a typed error for bad ids. */
    meta(artifactId) {
      const meta = loadMeta(artifactId)
      if (!meta) {
        throw artifactError('OMC/ARTIFACT-MISSING', `no artifact ${artifactId} in this store`)
      }
      return { ...meta }
    },

    /**
     * Bounded expansion. `maxChars` defaults to the record size; a smaller
     * limit truncates and says so. A hash mismatch is corruption, not stale
     * content: the caller gets OMC/ARTIFACT-CORRUPT.
     */
    read(artifactId, { maxChars = Number.MAX_SAFE_INTEGER } = {}) {
      const meta = this.meta(artifactId)
      const blob = loadBlob(artifactId)
      if (blob === null) {
        throw artifactError('OMC/ARTIFACT-MISSING', `artifact ${artifactId} has metadata but no content blob`)
      }
      const digest = createHash('sha256').update(blob, 'utf8').digest('hex')
      if (digest !== meta.contentHash) {
        throw artifactError('OMC/ARTIFACT-CORRUPT', `artifact ${artifactId} content does not match its recorded hash`)
      }
      const truncated = blob.length > maxChars
      return {
        artifactId,
        text: truncated ? blob.slice(0, maxChars) : blob,
        truncated,
        chars: blob.length,
        meta: { ...meta },
      }
    },

    /**
     * Detect invalidation: the recorded fact is only current while the blob
     * still hashes to the recorded value AND the optional `mustMatch` digest
     * (e.g. a worktree fingerprint captured with the fact) still agrees.
     */
    verify(artifactId, { mustMatch } = {}) {
      const meta = loadMeta(artifactId)
      if (!meta) {
        return { artifactId, ok: false, reason: 'OMC/ARTIFACT-MISSING' }
      }
      const blob = loadBlob(artifactId)
      if (blob === null) return { artifactId, ok: false, reason: 'OMC/ARTIFACT-MISSING' }
      const digest = createHash('sha256').update(blob, 'utf8').digest('hex')
      if (digest !== meta.contentHash) return { artifactId, ok: false, reason: 'OMC/ARTIFACT-CORRUPT' }
      if (typeof mustMatch === 'string' && mustMatch !== meta.contentHash) {
        return { artifactId, ok: false, reason: 'OMC/ARTIFACT-STALE', expected: mustMatch, actual: meta.contentHash }
      }
      return { artifactId, ok: true }
    },

    /** The stable reference form embedded in packets and briefs. */
    reference(artifactId) {
      this.meta(artifactId)
      return `omc-artifact:${artifactId}`
    },

    /** Resolve a reference string back to an artifact id (null when not one). */
    resolveReference(value) {
      const match = /^omc-artifact:(art-[A-Za-z0-9_-]{6,32})$/.exec(String(value ?? '').trim())
      return match ? match[1] : null
    },
  }
}
