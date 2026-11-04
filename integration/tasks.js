/**
 * Parent-scoped external run receipts.
 *
 * No scheduler and no delivery channel: DSH still owns activation, capacity and
 * completion notices. What changed from the first alpha is that the receipt is
 * now durable. A parent session can still read the last result after the Host
 * restarts; when the result body is gone it reports `unknown` instead of
 * inventing `completed`.
 *
 * 0.6 (PR-01) adds identity, not authorization. A row now carries the host's
 * lineage — parent task, root task, depth, ticket and workstream — so a child
 * agent's delegated run can be attributed to the root shard instead of opening
 * a second parent. The lineage itself is never accepted from tool arguments:
 * callers pass what the host proved (native-runtime) and the row labels it
 * `host`, `legacy` or `unknown`. A missing proof is recorded, not fabricated.
 *
 * With no `dir`, the registry stays in memory (useful for tests and embedded
 * callers). The Host always supplies a profile-scoped directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

// v2 = rows carry identity. v1 stays readable: its rows are the `legacy` case.
const SCHEMA_VERSION = 2
const COMPAT_SCHEMA_VERSION = 1
const RESULT_FILE_SUFFIX = '.json'
const MAX_LINEAGE_DEPTH = 24
const LINEAGE_SOURCES = Object.freeze(['host', 'legacy', 'unknown'])

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function optionalText(value, max = 160) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed.slice(0, max)
}

function normalizeLineage(raw, { fallback = 'unknown', note = null } = {}) {
  const value = typeof raw === 'string' ? { source: raw } : (raw && typeof raw === 'object' ? raw : {})
  const source = LINEAGE_SOURCES.includes(value.source) ? value.source : fallback
  const trimmedNote = optionalText(value.note)
  return {
    source,
    parentSessionId: optionalText(value.parentSessionId),
    rootSessionId: optionalText(value.rootSessionId),
    ...(trimmedNote ?? note ? { note: trimmedNote ?? note } : {}),
  }
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
 * Give a row the identity fields every reader may rely on.
 *
 * A pre-0.6 (schemaVersion 1) row cannot have host lineage; it keeps the old
 * defaults — parentTaskId null, rootTaskId itself, depth 0 — and is labeled
 * `legacy`, never promoted to `host` by the compat path.
 */
function normalizeRow(row, parentId, { schemaVersion = SCHEMA_VERSION, legacy = false } = {}) {
  const id = String(row.id ?? '')
  const old = legacy || schemaVersion < SCHEMA_VERSION || row.lineage === undefined && row.parentTaskId === undefined && row.rootTaskId === undefined
  const depth = Number.isInteger(row.depth) && row.depth >= 0 && row.depth <= MAX_LINEAGE_DEPTH ? row.depth : 0
  return {
    ...row,
    parentId: row.parentId ?? parentId,
    parentTaskId: optionalText(row.parentTaskId),
    rootTaskId: optionalText(row.rootTaskId) ?? id,
    depth,
    ticketId: optionalText(row.ticketId),
    workstream: optionalText(row.workstream, 80),
    lineage: old
      ? normalizeLineage(row.lineage?.source === 'legacy' ? row.lineage : 'legacy', {
          note: 'pre-0.6 task row: lineage fields were not recorded',
        })
      : normalizeLineage(row.lineage, { fallback: 'unknown' }),
    legacy: old,
  }
}

export function createTaskRegistry({ maxRetained = 100, dir, lockTimeoutMs = 10_000, strictLineage = false } = {}) {
  const rows = new Map()
  let settledOrder = 0

  const durable = typeof dir === 'string' && dir.trim() !== ''
  const root = durable ? dir : null

  function parentDir(parentId) {
    return join(root, safeSegment(parentId, 'parent'))
  }

  function indexFile(parentId) {
    return join(parentDir(parentId), 'index.json')
  }

  function resultFile(parentId, id) {
    return join(parentDir(parentId), safeSegment(id, 'task') + RESULT_FILE_SUFFIX)
  }

  function readIndex(parentId) {
    if (!durable) return null
    const file = indexFile(parentId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const version = parsed?.schemaVersion
      if ((version !== SCHEMA_VERSION && version !== COMPAT_SCHEMA_VERSION) || typeof parsed?.rows !== 'object') return null
      return { version, rows: parsed.rows }
    } catch {
      return null
    }
  }

  function writeIndex(parentId, entries) {
    if (!durable) return
    atomicWrite(indexFile(parentId), JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      parentId: safeSegment(parentId, 'parent'),
      updatedAt: new Date().toISOString(),
      rows: entries,
    }, null, 2) + '\n')
  }

  function withParentLock(parentId, fn) {
    if (!durable) return fn()
    const lock = acquireFileLockSync(join(parentDir(parentId), 'index'), {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'task-index',
    })
    try {
      return fn()
    } finally {
      lock.release()
    }
  }

  /** Load durable rows for a parent into memory. Disk wins for terminal rows. */
  function hydrate(parentId) {
    if (!durable) return
    const read = readIndex(parentId)
    if (!read) return
    for (const [id, raw] of Object.entries(read.rows)) {
      const normalized = normalizeRow(raw, parentId, { schemaVersion: read.version })
      const live = rows.get(id)
      if (live && live.status === 'running' && live.cancel) continue
      rows.set(id, { ...normalized, parentId, cancel: live?.cancel })
    }
  }

  function prune(parentId) {
    const finished = [...rows.values()]
      .filter((row) => row.parentId === parentId && row.status !== 'running')
      .sort((a, b) => (a.settledOrder ?? 0) - (b.settledOrder ?? 0))
    const excess = finished.slice(0, Math.max(0, finished.length - maxRetained))
    for (const row of excess) {
      rows.delete(row.id)
      if (durable) {
        try { rmSync(resultFile(parentId, row.id), { force: true }) } catch { /* best effort */ }
      }
    }
    return excess.map((row) => row.id)
  }

  function owned(parentId, id) {
    if (!parentId) {
      throw Object.assign(new Error('OMC/TASK-PARENT-REQUIRED: task discovery requires a calling agent'), {
        code: 'OMC/TASK-PARENT-REQUIRED',
      })
    }
    hydrate(parentId)
    const row = rows.get(id)
    if (!row || row.parentId !== parentId) {
      throw Object.assign(new Error(
        'OMC/TASK-NOT-FOUND: no retained external task owned by this session; use action tasks to recover handles',
      ), { code: 'OMC/TASK-NOT-FOUND' })
    }
    return row
  }

  function readResult(parentId, row) {
    if (!durable) return row.result ?? null
    const file = resultFile(parentId, row.id)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed?.result ?? null
    } catch {
      return null
    }
  }

  function view(parentId, row, withResult = false) {
    const result = withResult ? readResult(parentId, row) : null
    const missingBody = withResult && row.status !== 'running' && result === null
    return {
      id: row.id,
      parentId: row.parentId,
      harness: row.harness,
      label: row.label,
      // A durable terminal row whose body cannot be read is unknown, never a
      // fabricated completion.
      status: missingBody ? 'unknown' : row.status,
      lane: row.lane,
      role: row.role,
      taskId: row.taskId,
      identity: {
        parentTaskId: row.parentTaskId ?? null,
        rootTaskId: row.rootTaskId ?? row.id,
        depth: Number.isInteger(row.depth) ? row.depth : 0,
        ticketId: row.ticketId ?? null,
        workstream: row.workstream ?? null,
        lineage: clone(row.lineage),
        legacy: row.legacy === true || row.lineage?.source === 'legacy',
      },
      parentTaskId: row.parentTaskId ?? null,
      rootTaskId: row.rootTaskId ?? row.id,
      depth: Number.isInteger(row.depth) ? row.depth : 0,
      ticketId: row.ticketId ?? null,
      workstream: row.workstream ?? null,
      lineage: clone(row.lineage),
      lineageSource: row.lineage?.source ?? 'unknown',
      // Compatibility marker: a pre-0.6 row stays usable and visibly legacy.
      ...(row.legacy === true || row.lineage?.source === 'legacy'
        ? { compat: { legacy: true, schemaVersion: COMPAT_SCHEMA_VERSION } }
        : {}),
      startedAt: row.startedAt,
      settledAt: row.settledAt,
      cancelRequested: row.cancelRequested ?? false,
      ...(row.cancelNote ? { cancelNote: row.cancelNote } : {}),
      ...(missingBody ? { unknown: true } : {}),
      ...(withResult && result ? { result } : {}),
    }
  }

  function identityOf(row) {
    return {
      parentTaskId: row.parentTaskId ?? null,
      rootTaskId: row.rootTaskId ?? row.id,
      depth: Number.isInteger(row.depth) ? row.depth : 0,
      ticketId: row.ticketId ?? null,
      workstream: row.workstream ?? null,
      lineage: clone(row.lineage),
    }
  }

  function persistRow(parentId, row) {
    if (!durable) return
    atomicWrite(resultFile(parentId, row.id), JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      row: {
        id: row.id,
        parentId: row.parentId,
        harness: row.harness,
        label: row.label,
        lane: row.lane,
        role: row.role,
        taskId: row.taskId,
        status: row.status,
        ...identityOf(row),
        startedAt: row.startedAt,
        settledAt: row.settledAt,
        settledOrder: row.settledOrder ?? 0,
        cancelRequested: row.cancelRequested ?? false,
        ...(row.cancelNote ? { cancelNote: row.cancelNote } : {}),
      },
      result: row.result ?? null,
    }, null, 2) + '\n')
  }

  return {
    /**
     * Record one run.
     *
     * `lineage` is what the host proved (see native-runtime.taskLineage). When
     * it carries a host-proven `rootParentId`, the row is written into that
     * root shard: a delegated child's run belongs to the root, not to a new
     * parent. Old callers that pass only `parentId` keep working and are
     * labeled `unknown`.
     */
    start({ id, parentId, harness, label, handoff, cancel, lineage, parentTaskId, rootTaskId, depth, ticketId, workstream } = {}) {
      if (!parentId) return null
      const normalizedLineage = normalizeLineage(lineage, {
        fallback: 'unknown',
        note: text(lineage?.source) ? null : 'no host lineage was supplied for this run',
      })
      if (strictLineage && normalizedLineage.source !== 'host') {
        throw Object.assign(new Error(
          'OMC/TASK-LINEAGE-REQUIRED: strict lineage is on and this run has no host-proven parent/root identity',
        ), { code: 'OMC/TASK-LINEAGE-REQUIRED' })
      }
      const trustedRoot = normalizedLineage.source === 'host' && text(lineage?.rootParentId)
        ? lineage.rootParentId
        : null
      // Cross-shard attribution only follows host-proven lineage; an argument
      // can never move a row into somebody else's shard.
      const shard = trustedRoot ?? parentId
      const resolvedRootTaskId = optionalText(rootTaskId) ?? optionalText(lineage?.rootTaskId) ?? id
      const resolvedDepth = Number.isInteger(depth)
        ? Math.max(0, Math.min(MAX_LINEAGE_DEPTH, depth))
        : Number.isInteger(lineage?.depth)
          ? Math.max(0, Math.min(MAX_LINEAGE_DEPTH, lineage.depth))
          : 0
      const row = {
        id, parentId: shard, harness, label: String(label ?? '').slice(0, 160),
        lane: handoff?.laneId ?? null, role: handoff?.role ?? null,
        taskId: handoff?.taskId ?? null, status: 'running', startedAt: new Date().toISOString(),
        settledAt: null, settledOrder: 0, cancelRequested: false, cancel, result: null,
        parentTaskId: optionalText(parentTaskId) ?? optionalText(lineage?.parentTaskId),
        rootTaskId: resolvedRootTaskId,
        depth: resolvedDepth,
        ticketId: optionalText(ticketId) ?? optionalText(lineage?.ticketId),
        workstream: optionalText(workstream) ?? optionalText(lineage?.workstream),
        lineage: normalizedLineage,
        legacy: false,
      }
      hydrate(shard)
      // Replay/retry of the same run id must not create a second row or reset a
      // terminal result. The existing record wins and says so.
      const existing = rows.get(id)
      if (existing && existing.parentId === shard) {
        return { ...view(shard, existing), duplicate: true }
      }
      rows.set(id, row)
      if (durable) {
        withParentLock(shard, () => {
          const entries = readIndex(shard)?.rows ?? {}
          entries[id] = { ...row, cancel: undefined, result: undefined }
          writeIndex(shard, entries)
          persistRow(shard, row)
        })
      }
      return view(shard, row)
    },
    settle(id, result) {
      const row = rows.get(id)
      if (!row) return
      row.result = clone(result)
      row.status = result.stopReason === 'completed'
        ? 'completed'
        : result.stopReason === 'aborted'
          ? 'cancelled'
          : result.stopReason === 'unknown'
            ? 'unknown'
            : 'failed'
      row.settledAt = new Date().toISOString()
      row.settledOrder = ++settledOrder
      row.cancel = null
      if (durable) {
        withParentLock(row.parentId, () => {
          const entries = readIndex(row.parentId)?.rows ?? {}
          entries[id] = { ...row, cancel: undefined, result: undefined }
          const removed = prune(row.parentId)
          for (const gone of removed) delete entries[gone]
          writeIndex(row.parentId, entries)
          persistRow(row.parentId, row)
        })
      } else {
        prune(row.parentId)
      }
    },
    list(parentId) {
      if (!parentId) throw new Error('OMC/TASK-PARENT-REQUIRED: task discovery requires a calling agent')
      hydrate(parentId)
      return [...rows.values()]
        .filter((row) => row.parentId === parentId)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map((row) => view(parentId, row))
    },
    read(parentId, id) { return view(parentId, owned(parentId, id), true) },
    async cancel(parentId, id) {
      const row = owned(parentId, id)
      if (row.status !== 'running') return view(parentId, row)
      if (typeof row.cancel === 'function') {
        await row.cancel()
        row.cancelRequested = true
      } else {
        // The Host restarted; the request is durable but there is no live handle
        // to interrupt. It is not a cancellation and it does not settle the run.
        row.cancelRequested = true
        row.cancelNote = 'host restarted: request recorded, but no live handle exists to interrupt'
      }
      if (durable) {
        withParentLock(parentId, () => {
          const entries = readIndex(parentId)?.rows ?? {}
          entries[id] = { ...row, cancel: undefined, result: undefined }
          writeIndex(parentId, entries)
          persistRow(parentId, row)
        })
      }
      return view(parentId, row)
    },
    /** Test/repair hook: drop only this process's in-memory cache. */
    clearMemory() { rows.clear() },
    /** All task ids currently on disk for one parent (repair/diagnostics). */
    diskIds(parentId) {
      if (!durable) return []
      const entries = readIndex(parentId)?.rows ?? {}
      return Object.keys(entries)
    },
    /** Files that exist without an index row, for a conservative recovery view. */
    orphanIds(parentId) {
      if (!durable) return []
      const dirPath = parentDir(parentId)
      if (!existsSync(dirPath)) return []
      const indexed = new Set(Object.keys(readIndex(parentId)?.rows ?? {}))
      return readdirSync(dirPath)
        .filter((name) => name.endsWith(RESULT_FILE_SUFFIX) && name !== 'index' + RESULT_FILE_SUFFIX)
        .map((name) => name.slice(0, -RESULT_FILE_SUFFIX.length))
        .filter((id) => !indexed.has(id))
    },
  }
}
