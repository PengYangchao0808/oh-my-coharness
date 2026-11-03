/**
 * Rotatable worker ownership (0.5.0-alpha.2 R04).
 *
 * A WORKER is a logical slot: one project/module/role served over one route
 * (provider + model + effort), under one permission set, inside one workspace,
 * from one recorded source baseline. A CHILD is the physical thing currently
 * serving that slot. Keeping them apart is what makes "the worker is still the
 * same, but its process was replaced" a fact instead of a guess.
 *
 * Rules (and their honest limits):
 *   - the worker key is a digest of the DECLARED identity only — project,
 *     module, role, route identity, permission and workspace. Unrelated source
 *     changes do not move it (that is the point); a changed route, permission,
 *     workspace or module always does. Missing fields are normalised to an
 *     empty value, never thrown on: an incomplete identity produces a stable,
 *     less specific key, and the caller can see the facts it stored;
 *   - a worker belongs to exactly ONE parent session. Registering the same key
 *     under a different parent is refused with `{ conflict: true }` and the
 *     first owner is kept, the same way integration/native-runtime.js refuses
 *     to re-bind a live session to another parent — silently moving it would
 *     re-attribute work that is already booked;
 *   - `register` is idempotent for the same (workerKey, generation): facts may
 *     be merged, but the child and generation never move behind the caller's
 *     back. A different generation is a rotation, and the previous child is
 *     kept in `history` rather than overwritten;
 *   - a physical child may only change through `rotate`; `setHealth` with a
 *     different childId is refused (`OMC/WORKER-CHILD-MISMATCH`) instead of
 *     quietly repointing the slot;
 *   - health and busy are observations, not verdicts: an unobserved worker
 *     stays `unknown`, never "healthy".
 *
 * Storage: one versioned JSON per parent under the profile state root
 * (`<dir>/<parent>.json`), guarded by the shared cross-process file lock. The
 * ownership scan for a conflicting parent reads other parents' files; that read
 * is not locked (it changes nothing) and is re-checked under this parent's lock
 * before a fresh record is written.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const WORKER_REGISTRY_VERSION = 1
export const WORKER_HEALTH = Object.freeze(['unknown', 'ready', 'busy', 'degraded', 'failed'])

/** Rotation history is bounded; the newest children are the ones that matter. */
const HISTORY_LIMIT = 50

function err(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
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

function nowIso() {
  return new Date().toISOString()
}

function normText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Deterministic serialisation: object keys sorted, no locale or timing input. */
function canonical(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map((row) => canonical(row)).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return 'null'
}

/**
 * Route identity is provider + model + effort + endpoint. Extra routing fields
 * are deliberately not identity: observing `route.observed` or a UI label must
 * not rotate a worker.
 */
function normRoute(route) {
  if (typeof route === 'string') return canonical({ id: route.trim() })
  if (!route || typeof route !== 'object' || Array.isArray(route)) return canonical(null)
  return canonical({
    provider: normText(route.provider),
    model: normText(route.model),
    effort: normText(route.effort),
    endpoint: normText(route.endpoint),
  })
}

function routeValue(route) {
  if (typeof route === 'string') return { id: route.trim() }
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null
  return {
    provider: normText(route.provider) || null,
    model: normText(route.model) || null,
    effort: normText(route.effort) || null,
    endpoint: normText(route.endpoint) || null,
  }
}

/**
 * Permission identity accepts a string (`read-only`), a list of capability
 * names, or a plain object. All three shape into one canonical form so the same
 * effective permission always hashes the same way.
 */
function permissionValue(permission) {
  if (typeof permission === 'string') return permission.trim() || null
  if (Array.isArray(permission)) {
    const rows = permission.map((row) => normText(row)).filter(Boolean).sort()
    return rows.length ? rows : null
  }
  if (permission && typeof permission === 'object') return canonical(permission)
  return null
}

function normWorkspace(workspace) {
  const text = normText(workspace)
  if (text === '') return ''
  // One separator spelling per workspace: `C:/a/b` and `C:\a\b` are the same
  // tree, and a trailing separator must not fork a worker.
  return text.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Stable, short, sha256-based worker key.
 *
 * @param {{projectId?: string, moduleId?: string, roleId?: string, route?: any, permission?: any, workspace?: string}} [identity]
 * @returns {string} `wk_<16 hex chars>`
 */
export function workerKeyFor(identity = {}) {
  const input = identity && typeof identity === 'object' ? identity : {}
  const digest = canonical({
    projectId: normText(input.projectId),
    moduleId: normText(input.moduleId),
    roleId: normText(input.roleId),
    route: normRoute(input.route),
    permission: permissionValue(input.permission),
    workspace: normWorkspace(input.workspace),
  })
  return `wk_${createHash('sha256').update(digest, 'utf8').digest('hex').slice(0, 16)}`
}

function workerView(record) {
  if (!record) return null
  return {
    workerKey: record.workerKey,
    parentId: record.parentId,
    moduleId: record.moduleId,
    roleId: record.roleId,
    route: record.route ? { ...record.route } : null,
    permission: record.permission ?? null,
    workspace: record.workspace ?? null,
    childId: record.childId,
    generation: record.generation,
    baseline: record.baseline ?? null,
    busy: record.busy === true,
    health: record.health,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    retiredAt: record.retiredAt ?? null,
    retireReason: record.retireReason ?? null,
    history: (record.history ?? []).map((row) => ({ ...row })),
  }
}

function normalizeGeneration(generation) {
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 1
}

/** A rotation: the logical worker keeps its identity, the child is replaced. */
function rotateInPlace(record, { childId, generation, reason } = {}) {
  const requested = Number.isSafeInteger(generation) && generation > 0 ? generation : 0
  record.history.push({
    childId: record.childId ?? null,
    generation: record.generation,
    replacedAt: nowIso(),
    reason: reason ?? 'rotate',
  })
  if (record.history.length > HISTORY_LIMIT) record.history = record.history.slice(-HISTORY_LIMIT)
  record.childId = normText(childId) || null
  record.generation = Math.max(record.generation + 1, requested)
  record.busy = false
  record.health = 'unknown'
  record.status = 'active'
  record.retiredAt = null
  record.retireReason = null
  record.updatedAt = nowIso()
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 *   `dir` defaults to in-memory (tests/embedded); the Host passes the
 *   profile-scoped `<stateRoot>/workers` directory.
 */
export function createWorkerRegistry({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  /** @type {Map<string, any>} parentId → registry document (in-memory mode) */
  const memoryDocs = new Map()

  function fileFor(parentId) {
    return join(dir, safeSegment(parentId, 'parent') + '.json')
  }

  // The lock file is `${target}.lock`; targeting the bare parent segment keeps
  // it from ever colliding with the `.json` registry file.
  function lockTargetFor(parentId) {
    return join(dir, safeSegment(parentId, 'parent'))
  }

  function emptyDoc(parentId) {
    return {
      schemaVersion: WORKER_REGISTRY_VERSION,
      parentId,
      workers: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
  }

  function loadDoc(parentId) {
    if (!durable) return memoryDocs.get(parentId) ?? emptyDoc(parentId)
    const file = fileFor(parentId)
    if (!existsSync(file)) return emptyDoc(parentId)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.schemaVersion !== WORKER_REGISTRY_VERSION) return emptyDoc(parentId)
      if (!parsed.workers || typeof parsed.workers !== 'object') parsed.workers = {}
      return parsed
    } catch {
      return emptyDoc(parentId)
    }
  }

  /** Read-modify-write one parent's document under that parent's lock. */
  function mutate(parentId, fn) {
    if (!durable) {
      const doc = loadDoc(parentId)
      const result = fn(doc)
      doc.updatedAt = nowIso()
      memoryDocs.set(parentId, doc)
      return result
    }
    const lock = acquireFileLockSync(lockTargetFor(parentId), {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'worker-registry',
    })
    try {
      const doc = loadDoc(parentId)
      // `fn` may throw (an ownership or child mismatch); nothing is written then.
      const result = fn(doc)
      doc.updatedAt = nowIso()
      atomicWrite(fileFor(parentId), JSON.stringify(doc, null, 2) + '\n')
      return result
    } finally {
      lock.release()
    }
  }

  /**
   * Find the first owner of a worker key, across all parent documents.
   * The durable read of other parents is intentionally unlocked: it observes
   * files it does not mutate, and every write re-checks under its own lock.
   */
  function locate(workerKey) {
    if (!durable) {
      for (const doc of memoryDocs.values()) {
        const record = doc.workers?.[workerKey]
        if (record) return { parentId: doc.parentId, record }
      }
      return null
    }
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let doc = null
      try {
        doc = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        // A torn or foreign file is skipped, not trusted.
        continue
      }
      if (doc?.schemaVersion !== WORKER_REGISTRY_VERSION) continue
      const record = doc.workers?.[workerKey]
      if (record) return { parentId: doc.parentId, record }
    }
    return null
  }

  function applyRegister(doc, { workerKey, moduleId, roleId, route, permission, workspace, childId, generation, baseline }) {
    const existing = doc.workers[workerKey]
    if (!existing) {
      const record = {
        workerKey,
        parentId: doc.parentId,
        moduleId: normText(moduleId) || null,
        roleId: normText(roleId) || null,
        route: routeValue(route),
        permission: permissionValue(permission),
        workspace: normWorkspace(workspace) || null,
        childId: normText(childId) || null,
        generation: normalizeGeneration(generation),
        baseline: baseline ?? null,
        busy: false,
        health: 'unknown',
        status: 'active',
        history: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        retiredAt: null,
        retireReason: null,
      }
      doc.workers[workerKey] = record
      return { conflict: false, created: true, rotated: false, worker: workerView(record) }
    }

    // Same parent. Facts may be refreshed, ownership and generation may not.
    existing.moduleId = normText(moduleId) || existing.moduleId
    existing.roleId = normText(roleId) || existing.roleId
    if (route !== undefined && route !== null) existing.route = routeValue(route)
    if (permission !== undefined && permission !== null) existing.permission = permissionValue(permission)
    if (workspace !== undefined && workspace !== null) existing.workspace = normWorkspace(workspace) || existing.workspace
    if (baseline !== undefined && baseline !== null) existing.baseline = baseline
    existing.updatedAt = nowIso()

    const requested = normalizeGeneration(generation)
    if (existing.generation === requested) {
      return { conflict: false, created: false, rotated: false, worker: workerView(existing) }
    }
    // A different generation on a known worker is a rotation, recorded with a
    // history row: the previous child is never silently overwritten.
    rotateInPlace(existing, { childId, generation: requested, reason: 'register:generation-change' })
    return { conflict: false, created: false, rotated: true, worker: workerView(existing) }
  }

  return {
    /**
     * Register (or re-register) one logical worker.
     * Idempotent for the same (workerKey, generation); returns
     * `{ conflict: true }` and keeps the first owner when the key already
     * belongs to another parent session.
     */
    register({ parentId, workerKey, moduleId, roleId, route, permission, workspace, childId, generation, baseline } = {}) {
      const pid = normText(parentId)
      const key = normText(workerKey)
      if (!pid) throw err('OMC/WORKER-PARENT', 'parentId is required')
      if (!key) throw err('OMC/WORKER-KEY', 'workerKey is required')

      const owner = locate(key)
      if (owner && owner.parentId !== pid) {
        return {
          conflict: true,
          created: false,
          rotated: false,
          moved: false,
          worker: workerView(owner.record),
          reason: `worker ${key} is already owned by parent ${owner.parentId}`,
        }
      }
      return mutate(pid, (doc) => applyRegister(doc, {
        workerKey: key, moduleId, roleId, route, permission, workspace, childId, generation, baseline,
      }))
    },

    /**
     * Replace the physical child serving a logical worker: generation bumps and
     * the previous child moves into `history`.
     */
    rotate(workerKey, { childId, generation, reason } = {}) {
      const key = normText(workerKey)
      const owner = locate(key)
      if (!owner) throw err('OMC/WORKER-UNKNOWN', `cannot rotate an unknown worker ${key || '(empty key)'}`)
      return mutate(owner.parentId, (doc) => {
        const record = doc.workers[key]
        if (!record) throw err('OMC/WORKER-UNKNOWN', 'the worker disappeared before rotation')
        rotateInPlace(record, { childId, generation, reason: reason ?? 'rotate' })
        return workerView(record)
      })
    },

    /**
     * Record observed busy/health facts. A different childId is a rotation
     * request in disguise and is refused.
     */
    setHealth(workerKey, { busy, health, childId } = {}) {
      const key = normText(workerKey)
      const owner = locate(key)
      if (!owner) throw err('OMC/WORKER-UNKNOWN', `cannot update an unknown worker ${key || '(empty key)'}`)
      return mutate(owner.parentId, (doc) => {
        const record = doc.workers[key]
        if (!record) throw err('OMC/WORKER-UNKNOWN', 'the worker disappeared before the health update')
        const nextChild = normText(childId)
        if (nextChild && record.childId && nextChild !== record.childId) {
          throw err(
            'OMC/WORKER-CHILD-MISMATCH',
            `worker ${key} is served by child ${record.childId}; rotate() is required to change the child`,
          )
        }
        if (typeof busy === 'boolean') record.busy = busy
        if (typeof health === 'string' && health.trim() !== '') record.health = health.trim()
        if (nextChild && !record.childId) record.childId = nextChild
        record.updatedAt = nowIso()
        return workerView(record)
      })
    },

    /** One worker, or null when this registry has never seen the key. */
    get(workerKey) {
      const key = normText(workerKey)
      if (!key) return null
      return workerView(locate(key)?.record ?? null)
    },

    /** Every worker owned by one parent session, oldest first. */
    list(parentId) {
      const pid = normText(parentId)
      if (!pid) return []
      const doc = loadDoc(pid)
      return Object.values(doc.workers ?? {})
        .filter((record) => record.parentId === pid)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.workerKey).localeCompare(String(b.workerKey)))
        .map(workerView)
    },

    /**
     * Retire a worker without deleting it: the slot stays readable (baseline,
     * last child, history) but is no longer active.
     */
    retire(workerKey, { reason } = {}) {
      const key = normText(workerKey)
      const owner = locate(key)
      if (!owner) throw err('OMC/WORKER-UNKNOWN', `cannot retire an unknown worker ${key || '(empty key)'}`)
      return mutate(owner.parentId, (doc) => {
        const record = doc.workers[key]
        if (!record) throw err('OMC/WORKER-UNKNOWN', 'the worker disappeared before retirement')
        record.status = 'retired'
        record.busy = false
        record.retiredAt = nowIso()
        record.retireReason = reason ?? null
        record.updatedAt = nowIso()
        return workerView(record)
      })
    },
  }
}
