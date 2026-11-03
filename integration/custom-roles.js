/**
 * Custom external role templates.
 *
 * A custom role is a named (title + persona) external read-only specialist. It
 * is deliberately narrower than an in-process preset row:
 *
 *   - execution is always an external CLI in read-only mode;
 *   - it cannot become a writer, cannot enable a harness, and cannot change the
 *     project permission floor;
 *   - it reuses the normal `coharness dispatch` path, so fallback, project
 *     policy, timeout, output clipping and result classification stay in one
 *     place.
 *
 * This is a template registry, not a second Agent runtime.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const CUSTOM_ROLE_SCHEMA_VERSION = 1
export const MAX_CUSTOM_ROLES = 20

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

function roleError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function text(value, max = 4000) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function blank() {
  return { schemaVersion: CUSTOM_ROLE_SCHEMA_VERSION, updatedAt: null, roles: {} }
}

function readFile(file) {
  if (!existsSync(file)) return blank()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || parsed.schemaVersion !== CUSTOM_ROLE_SCHEMA_VERSION || typeof parsed.roles !== 'object') {
      throw new Error('unsupported custom role schema')
    }
    return { ...blank(), ...parsed, roles: parsed.roles }
  } catch (error) {
    throw roleError('OMC/ROLE-CORRUPT', `custom role file is unreadable: ${error?.message ?? error}`)
  }
}

/** Validate and normalize one role definition (user store or project file). */
export function normalizeCustomRole({ id, title, persona, harness, model, fallbacks, source = 'user' } = {}) {
  const roleId = text(id, 40).toLowerCase()
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(roleId)) {
    throw roleError('OMC/ROLE-INVALID', 'role id must be 2-32 lowercase letters, digits or dashes, starting with a letter')
  }
  const body = text(persona, 6000)
  if (body === '') throw roleError('OMC/ROLE-INVALID', 'role persona is required')
  const harnessId = text(harness, 40).toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(harnessId)) {
    throw roleError('OMC/ROLE-INVALID', 'role harness must be a valid harness id')
  }
  const fallbackIds = Array.isArray(fallbacks)
    ? [...new Set(fallbacks.map((value) => text(value, 40).toLowerCase()).filter(Boolean))]
      .filter((value) => value !== harnessId)
      .slice(0, 3)
    : []
  for (const fallback of fallbackIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(fallback)) {
      throw roleError('OMC/ROLE-INVALID', `fallback harness "${fallback}" is not a valid harness id`)
    }
  }
  return {
    id: roleId,
    title: text(title, 120) || roleId,
    persona: body,
    harness: harnessId,
    ...(text(model, 120) ? { model: text(model, 120) } : {}),
    fallbacks: fallbackIds,
    readOnly: true,
    mode: 'read-only',
    source,
    createdAt: null,
  }
}

/**
 * Read project-local role templates from `<cwd>/.omc/roles.json`.
 * Invalid entries are skipped with a warning; a project cannot produce a
 * writable role because normalization fixes readOnly/mode.
 */
export function readProjectRoles(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd)) {
    return { exists: false, path: null, roles: [], warnings: [] }
  }
  const path = join(cwd, '.omc', 'roles.json')
  if (!existsSync(path)) return { exists: false, path, roles: [], warnings: [] }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { exists: true, path, roles: [], warnings: [`project roles file is not valid JSON: ${error?.message ?? error}`] }
  }
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.roles) ? raw.roles : null
  if (entries === null) return { exists: true, path, roles: [], warnings: ['project roles file must be an array or { roles: [] }'] }
  const roles = []
  const warnings = []
  for (const entry of entries.slice(0, MAX_CUSTOM_ROLES)) {
    try {
      const role = normalizeCustomRole({ ...entry, source: 'project' })
      if (!roles.some((row) => row.id === role.id)) roles.push(role)
      else warnings.push(`duplicate project role id "${role.id}" ignored`)
    } catch (error) {
      warnings.push(String(error?.message ?? error))
    }
  }
  return { exists: true, path, roles, warnings }
}

export function buildRolePrompt(role, task) {
  return [
    role.title ? `Role: ${role.title}` : null,
    role.persona,
    '',
    'External read-only constraints:',
    '- Do not modify files, run state-changing commands, or delegate to another agent.',
    '- Report evidence for every claim; if the task needs a write, return a concrete proposal instead.',
    '',
    'Task:',
    task,
  ].filter((line) => line !== null).join('\n')
}

export function createCustomRoles({ dir, lockTimeoutMs = 10_000, maxRoles = MAX_CUSTOM_ROLES } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const root = durable ? dir : null
  const memory = blank()

  function fileFor() {
    return join(root, 'roles.json')
  }

  function read() {
    return durable ? readFile(fileFor()) : structuredClone(memory)
  }

  function write(document) {
    document.updatedAt = new Date().toISOString()
    if (!durable) {
      memory.schemaVersion = document.schemaVersion
      memory.updatedAt = document.updatedAt
      memory.roles = structuredClone(document.roles)
      return
    }
    atomicWrite(fileFor(), JSON.stringify(document, null, 2) + '\n')
  }

  function locked(fn) {
    if (!durable) return fn()
    const lock = acquireFileLockSync(join(root, 'roles'), { timeoutMs: lockTimeoutMs, label: 'custom-roles' })
    try {
      return fn()
    } finally {
      lock.release()
    }
  }

  return {
    list() {
      return Object.values(read().roles)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((role) => ({ ...role }))
    },
    get(id) {
      const role = read().roles[text(id, 40)]
      return role ? { ...role } : null
    },
    add(input = {}) {
      const normalized = normalizeCustomRole(input)
      return locked(() => {
        const document = read()
        if (document.roles[normalized.id]) {
          throw roleError('OMC/ROLE-EXISTS', `custom role "${normalized.id}" already exists`)
        }
        if (Object.keys(document.roles).length >= maxRoles) {
          throw roleError('OMC/ROLE-LIMIT', `at most ${maxRoles} custom roles are allowed`)
        }
        const role = { ...normalized, source: 'user', createdAt: new Date().toISOString() }
        document.roles[role.id] = role
        write(document)
        return { ...role }
      })
    },
    remove(id) {
      const roleId = text(id, 40)
      return locked(() => {
        const document = read()
        if (!document.roles[roleId]) return false
        delete document.roles[roleId]
        write(document)
        return true
      })
    },
    clear() {
      return locked(() => {
        write(blank())
        return true
      })
    },
    path: durable ? fileFor() : null,
    /** A safe directory segment for a role name, used only by diagnostics. */
    segment(id) {
      return safeSegment(id, 'role')
    },
  }
}
