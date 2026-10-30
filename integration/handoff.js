/**
 * Task handoff contract.
 *
 * The orchestrator is the only scheduler: agents never talk to each other. What
 * crosses an execution boundary is therefore not a conversation but a small,
 * validated record: who is being asked, for which long-lived lane, with which
 * evidence, and under which constraints.
 *
 * The record is also what makes session reuse safe. A native CLI session is
 * keyed by project + lane + role + harness + model + workspace + endpoint; the
 * marker travels inside the external brief and is stripped before the CLI sees
 * the prompt. Nothing here reads files or talks to a service.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

export const HANDOFF_VERSION = 1
export const HANDOFF_MARKER = 'omc-handoff'
export const MAX_HANDOFF_BYTES = 16 * 1024

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const MARKER_PATTERN = /<!--\s*omc-handoff:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*-->/
const LOOSE_MARKER_PATTERN = /<!--\s*omc-handoff:v1:[^>]*-->/
const ROLE_PATTERN = /^Role:\s*(.+?)\s*\(([^)]+)\)\s*$/m
const WORKSPACE_PATTERN = /^Workspace:\s*(.+)$/m

/**
 * Per-process signing key. A role brief is built by this Host process and read
 * by the provider in the same process; an arbitrary dispatch prompt must not be
 * able to name an existing session by embedding a hand-written marker.
 */
const HANDOFF_SECRET = randomBytes(32)

function sign(payload) {
  return createHmac('sha256', HANDOFF_SECRET).update(payload).digest('base64url')
}

function signatureMatches(payload, signature) {
  const expected = Buffer.from(sign(payload), 'utf8')
  const received = Buffer.from(String(signature ?? ''), 'utf8')
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function text(value, max = 300) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function list(value, { max = 32, maxLength = 300 } = {}) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, max)
}

/**
 * Canonical workspace string used by both the handoff and the session key.
 * Windows drives are lower-cased and separators normalised so the same project
 * cannot produce two lanes just because a path was typed differently.
 */
export function normalizeWorkspace(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '') return 'inherited'
  let value = resolvePath(raw).replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(value)) value = value[0].toLowerCase() + value.slice(1)
  return value.replace(/\/+$/, '') || '/'
}

/** Stable project id for a workspace. Never contains the path itself. */
export function projectIdFor(cwd) {
  const workspace = normalizeWorkspace(cwd)
  return `proj-${createHash('sha256').update(workspace).digest('hex').slice(0, 10)}`
}

/** Default lane: one long-lived direction per role inside one project. */
export function laneIdFor(roleId, projectId) {
  const role = text(roleId, 40).replace(/[^A-Za-z0-9-]/g, '-').toLowerCase() || 'role'
  const project = text(projectId, 40).replace(/[^A-Za-z0-9-]/g, '-') || 'project'
  return `lane-${role}-${project}`.slice(0, 80)
}

/** A fresh task id. It identifies one delegation, never a session. */
export function newTaskId(now = Date.now()) {
  return `task-${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

function invalid(message) {
  const error = new Error(`OMC/HANDOFF-INVALID: ${message}`)
  error.code = 'OMC/HANDOFF-INVALID'
  return error
}

function isSafeRelativeRef(ref) {
  if (ref === '' || ref.length > 300) return false
  if (ref.startsWith('/') || /^[A-Za-z]:/.test(ref) || ref.includes('\\')) return false
  const parts = ref.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * Validate one handoff record and return a defensive copy.
 * Throws a typed error for anything a run could not honour.
 */
export function validateHandoff(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('a handoff must be an object')
  if (raw.version !== HANDOFF_VERSION) throw invalid(`unsupported handoff version ${String(raw.version)}`)

  for (const field of ['taskId', 'projectId', 'laneId', 'role']) {
    const value = raw[field]
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalid(`${field} is not a valid id`)
  }

  const workspace = raw.workspace
  if (!workspace || typeof workspace !== 'object') throw invalid('workspace is required')
  if (typeof workspace.path !== 'string' || workspace.path === '') throw invalid('workspace.path is required')
  if (workspace.revision !== null && workspace.revision !== undefined && typeof workspace.revision !== 'string') {
    throw invalid('workspace.revision must be a string or null')
  }

  const context = raw.context ?? {}
  if (typeof context !== 'object' || Array.isArray(context)) throw invalid('context must be an object')
  if (context.summary !== undefined && typeof context.summary !== 'string') throw invalid('context.summary must be a string')
  if (context.changedFiles !== undefined && !Array.isArray(context.changedFiles)) {
    throw invalid('context.changedFiles must be an array')
  }
  if (context.artifactRefs !== undefined && !Array.isArray(context.artifactRefs)) {
    throw invalid('context.artifactRefs must be an array')
  }

  const changedFiles = list(context.changedFiles)
  if (changedFiles.length !== (context.changedFiles ?? []).length) throw invalid('context.changedFiles has too many entries')
  for (const file of changedFiles) {
    if (!isSafeRelativeRef(file)) throw invalid(`changed file is not workspace-relative: ${file}`)
  }
  const artifactRefs = list(context.artifactRefs, { max: 16 })
  if (artifactRefs.length !== (context.artifactRefs ?? []).length) throw invalid('context.artifactRefs has too many entries')
  for (const ref of artifactRefs) {
    if (!isSafeRelativeRef(ref)) throw invalid(`artifact ref is not workspace-relative: ${ref}`)
  }

  const acceptance = list(raw.acceptance, { max: 16 })
  if (acceptance.length !== (raw.acceptance ?? []).length) throw invalid('acceptance has too many entries')

  const constraints = raw.constraints ?? {}
  if (typeof constraints !== 'object' || Array.isArray(constraints)) throw invalid('constraints must be an object')

  return {
    version: HANDOFF_VERSION,
    taskId: raw.taskId,
    projectId: raw.projectId,
    laneId: raw.laneId,
    role: raw.role,
    workspace: {
      path: workspace.path,
      revision: workspace.revision ?? null,
    },
    context: {
      summary: text(context.summary, 2000),
      changedFiles,
      artifactRefs,
    },
    acceptance,
    constraints: {
      readOnly: constraints.readOnly !== false,
      maxReviewRounds: Number.isSafeInteger(constraints.maxReviewRounds)
        ? Math.min(5, Math.max(0, constraints.maxReviewRounds))
        : 1,
    },
  }
}

/**
 * Build a handoff from trusted task facts. Defaults derive only from the role
 * and workspace; the prompt text never decides a lane.
 */
export function createHandoff({
  roleId,
  cwd,
  taskId,
  projectId,
  laneId,
  revision,
  context = {},
  acceptance = [],
  constraints = {},
} = {}) {
  const role = text(roleId, 40) || 'unknown'
  const project = text(projectId, 40) || projectIdFor(cwd)
  return validateHandoff({
    version: HANDOFF_VERSION,
    taskId: text(taskId, 80) || newTaskId(),
    projectId: project,
    laneId: text(laneId, 80) || laneIdFor(role, project),
    role,
    workspace: {
      path: normalizeWorkspace(cwd),
      revision: text(revision, 80) || null,
    },
    context: {
      summary: text(context.summary, 2000),
      changedFiles: list(context.changedFiles),
      artifactRefs: list(context.artifactRefs, { max: 16 }),
    },
    acceptance: list(acceptance, { max: 16 }),
    constraints: {
      readOnly: constraints.readOnly !== false,
      maxReviewRounds: constraints.maxReviewRounds ?? 1,
    },
  })
}

/** Human-readable part of the brief. The machine marker is appended separately. */
export function renderHandoff(handoff) {
  const lines = [
    'Handoff:',
    `- Task: ${handoff.taskId}`,
    `- Project: ${handoff.projectId}`,
    `- Lane: ${handoff.laneId}`,
  ]
  if (handoff.workspace.revision) lines.push(`- Workspace revision: ${handoff.workspace.revision}`)
  if (handoff.context.summary) lines.push(`- Context: ${handoff.context.summary}`)
  if (handoff.context.changedFiles.length) lines.push(`- Changed files: ${handoff.context.changedFiles.join(', ')}`)
  if (handoff.context.artifactRefs.length) lines.push(`- Artifacts: ${handoff.context.artifactRefs.join(', ')}`)
  if (handoff.acceptance.length) {
    lines.push('- Acceptance:')
    for (const item of handoff.acceptance) lines.push(`  - ${item}`)
  }
  return lines.join('\n')
}

/** Encode and sign the marker. Base64url keeps arbitrary context from breaking the comment. */
export function encodeHandoffMarker(handoff) {
  const validated = validateHandoff(handoff)
  const payload = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url')
  return `<!-- ${HANDOFF_MARKER}:v1:${payload}.${sign(payload)} -->`
}

/**
 * Remove the marker and return the validated record.
 * @returns {{ handoff: object|null, text: string, malformed?: boolean }}
 */
export function extractHandoff(prompt) {
  const value = String(prompt ?? '')
  const match = MARKER_PATTERN.exec(value)
  if (!match) {
    // An unsigned marker is stripped but never trusted: it may be a copied or
    // hand-written string in a direct dispatch prompt.
    if (LOOSE_MARKER_PATTERN.test(value)) {
      return { handoff: null, text: value.replace(LOOSE_MARKER_PATTERN, '').replace(/\s+$/, ''), malformed: true }
    }
    return { handoff: null, text: value }
  }
  const without = value.replace(match[0], '').replace(/\s+$/, '')
  if (!signatureMatches(match[1], match[2])) return { handoff: null, text: without, malformed: true }
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8')
    if (Buffer.byteLength(decoded, 'utf8') > MAX_HANDOFF_BYTES) throw invalid('marker is too large')
    return { handoff: validateHandoff(JSON.parse(decoded)), text: without }
  } catch {
    return { handoff: null, text: without, malformed: true }
  }
}

/**
 * Resolve the identity of an external role prompt.
 *
 * A v0.5 brief carries a marker. A brief written by an older OMC only has the
 * `Role:` line; that is still enough to key a lane, but the task text is left
 * untouched. A direct `coharness` dispatch has neither and therefore never
 * resumes a role session.
 */
export function handoffFromPrompt(prompt, { cwd } = {}) {
  const extracted = extractHandoff(prompt)
  if (extracted.handoff) return { ...extracted, source: 'marker' }
  const value = extracted.text
  // A present-but-unreadable marker is not a licence to guess a lane from the
  // text. Drop identity for this run; the task still executes.
  if (extracted.malformed) return { handoff: null, text: value, source: 'malformed', malformed: true }
  const roleMatch = ROLE_PATTERN.exec(value)
  if (!roleMatch) return { handoff: null, text: value, source: 'none', malformed: false }
  const roleId = roleMatch[2].trim()
  const workspaceMatch = WORKSPACE_PATTERN.exec(value)
  const fromPrompt = workspaceMatch
    ? workspaceMatch[1].trim()
    : ''
  // A legacy brief may spell out a sentence instead of a path; only a plausible
  // path is accepted. The caller's cwd is always the trusted fallback.
  const plausible = /^(?:[A-Za-z]:[\\/]|\/|\\\\wsl)/.test(fromPrompt) ? fromPrompt : undefined
  return {
    handoff: createHandoff({ roleId, cwd: cwd ?? plausible }),
    text: value,
    source: 'legacy',
    malformed: false,
  }
}
