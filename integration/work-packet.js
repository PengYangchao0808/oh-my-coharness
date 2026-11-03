/**
 * The WorkPacket: one minimal, honest task contract shared by native and
 * external execution (0.5.0-alpha.2 WP03).
 *
 * A packet is what crosses an execution boundary when a task is delegated:
 * goal, acceptance, read locations, write responsibility, the baseline the
 * work starts from, verified facts and decisions, open questions, artifact
 * references and the budget it runs under. It reuses the handoff identity
 * (task/lane/role/workspace) so native children and external CLIs accept the
 * SAME task semantics, and the external signature + session-key constraints
 * keep working unchanged.
 *
 * Honesty rules (V0.5-ALPHA2-PLAN §4.3):
 *   - a verified fact must carry sourceRef + sourceDigest + observedAt;
 *     anything less is an open question, not a fact;
 *   - the baseline carries BOTH the commit (when there is one) and a
 *     work-tree content fingerprint, so uncommitted changes and non-Git
 *     workspaces are still attributable;
 *   - acceptance, budget and permission constraints are never dropped to fit
 *     a size limit: over-limit material is externalized into artifacts, and a
 *     packet that is still too large is refused, not trimmed silently.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { HANDOFF_VERSION, validateHandoff } from './handoff.js'

export const WORK_PACKET_VERSION = 1
export const MAX_PACKET_CHARS = 24_000

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SAFE_REF = /^[^\\/]+(\/[^\\/]+)*$/

function packetError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function isWorkspaceRelative(ref) {
  return typeof ref === 'string' && ref.length <= 300 && SAFE_REF.test(ref)
}

/**
 * Content fingerprint of one workspace tree: sorted relative paths plus file
 * content hashes, bounded by `maxFiles`/`maxFileBytes` (larger files hash by
 * their length + head, and the bound is part of the digest string so two
 * fingerprints taken under different bounds never compare equal by accident).
 * Works without Git; uncommitted edits change the digest by construction.
 */
export function treeFingerprint(workspacePath, { maxFiles = 5000, maxFileBytes = 512 * 1024, now = () => new Date().toISOString() } = {}) {
  const root = resolve(workspacePath)
  const hash = createHash('sha256')
  hash.update(`omc-tree:v1:files=${maxFiles}:bytes=${maxFileBytes}\n`)
  let files = 0
  let truncated = false
  const walk = (dir) => {
    if (files >= maxFiles) { truncated = true; return }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files >= maxFiles) { truncated = true; return }
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.ops') continue
        hash.update(`d ${rel}\n`)
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        let size = 0
        let fileHash = ''
        try {
          const info = statSync(full)
          size = info.size
          if (size <= maxFileBytes) {
            fileHash = createHash('sha256').update(readFileSync(full)).digest('hex')
          } else {
            // Large file: length + first 64 KiB identify it well enough for a
            // change fingerprint; the bound is already in the header.
            const head = readFileSync(full).subarray(0, 64 * 1024)
            fileHash = `${size}:${createHash('sha256').update(head).digest('hex')}`
          }
        } catch {
          fileHash = 'unreadable'
        }
        hash.update(`f ${rel} ${fileHash}\n`)
      }
    }
  }
  walk(root)
  return {
    digest: hash.digest('hex'),
    files,
    truncated,
    capturedAt: now(),
    ...(truncated ? { note: `fingerprint covers the first ${maxFiles} files only` } : {}),
  }
}

function validateFact(raw, index) {
  if (!raw || typeof raw !== 'object') throw packetError('OMC/PACKET-INVALID', `facts[${index}] must be an object`)
  const statement = text(raw.statement, 600)
  if (!statement) throw packetError('OMC/PACKET-INVALID', `facts[${index}].statement is required`)
  const sourceRef = text(raw.sourceRef, 300)
  const sourceDigest = text(raw.sourceDigest, 200)
  const observedAt = text(raw.observedAt, 40)
  if (!sourceRef || !sourceDigest || !observedAt) {
    throw packetError('OMC/PACKET-INVALID',
      `facts[${index}] is not verifiable: sourceRef, sourceDigest and observedAt are all required — anything less is an open question, not a fact`)
  }
  return { statement, sourceRef, sourceDigest, observedAt }
}

/**
 * Validate one work packet and return a defensive copy.
 */
export function validateWorkPacket(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw packetError('OMC/PACKET-INVALID', 'a work packet must be an object')
  if (raw.version !== WORK_PACKET_VERSION) throw packetError('OMC/PACKET-INVALID', `unsupported packet version ${String(raw.version)}`)

  const goal = text(raw.goal, 4000)
  if (!goal) throw packetError('OMC/PACKET-INVALID', 'goal is required')

  const acceptance = (Array.isArray(raw.acceptance) ? raw.acceptance : []).map((row, i) => {
    const value = text(row, 300)
    if (!value) throw packetError('OMC/PACKET-INVALID', `acceptance[${i}] is empty`)
    return value
  })
  if (!acceptance.length) throw packetError('OMC/PACKET-INVALID', 'a work packet needs at least one acceptance criterion')

  for (const field of ['taskId']) {
    if (typeof raw[field] !== 'string' || !ID_PATTERN.test(raw[field])) {
      throw packetError('OMC/PACKET-INVALID', `${field} is not a valid id`)
    }
  }

  const reads = (Array.isArray(raw.reads) ? raw.reads : []).map((row, i) => {
    const ref = typeof row === 'string' ? row : text(row?.ref, 300)
    const why = typeof row === 'string' ? '' : text(row?.why, 200)
    if (!ref) throw packetError('OMC/PACKET-INVALID', `reads[${i}] is empty`)
    return { ref, why }
  })

  const writes = raw.writes && typeof raw.writes === 'object' && !Array.isArray(raw.writes) ? raw.writes : {}
  const writeScope = (Array.isArray(writes.scope) ? writes.scope : []).filter(Boolean)
  for (const ref of writeScope) {
    if (!isWorkspaceRelative(ref)) {
      throw packetError('OMC/PACKET-INVALID', `write scope entry is not workspace-relative: ${ref}`)
    }
  }

  const baseline = raw.baseline && typeof raw.baseline === 'object' ? raw.baseline : {}
  if (baseline.commit !== null && baseline.commit !== undefined && typeof baseline.commit !== 'string') {
    throw packetError('OMC/PACKET-INVALID', 'baseline.commit must be a string or null')
  }
  if (baseline.treeDigest !== null && baseline.treeDigest !== undefined && typeof baseline.treeDigest !== 'string') {
    throw packetError('OMC/PACKET-INVALID', 'baseline.treeDigest must be a string or null')
  }
  if (!baseline.commit && !baseline.treeDigest) {
    throw packetError('OMC/PACKET-INVALID', 'baseline needs at least a commit or a tree fingerprint')
  }

  const facts = (Array.isArray(raw.facts) ? raw.facts : []).map(validateFact)
  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : []).map((row, i) => {
    const value = text(row, 300)
    if (!value) throw packetError('OMC/PACKET-INVALID', `decisions[${i}] is empty`)
    return value
  })
  const openQuestions = (Array.isArray(raw.openQuestions) ? raw.openQuestions : []).map((row, i) => {
    const value = text(row, 300)
    if (!value) throw packetError('OMC/PACKET-INVALID', `openQuestions[${i}] is empty`)
    return value
  })
  const artifacts = (Array.isArray(raw.artifacts) ? raw.artifacts : []).map((row, i) => {
    const value = text(row, 300)
    if (!value) throw packetError('OMC/PACKET-INVALID', `artifacts[${i}] is empty`)
    return value
  })

  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {}
  if (budget.maxCalls !== null && budget.maxCalls !== undefined && !(Number.isSafeInteger(budget.maxCalls) && budget.maxCalls > 0)) {
    throw packetError('OMC/PACKET-INVALID', 'budget.maxCalls must be a positive integer or null')
  }
  if (budget.maxUsd !== null && budget.maxUsd !== undefined && !(typeof budget.maxUsd === 'number' && budget.maxUsd >= 0)) {
    throw packetError('OMC/PACKET-INVALID', 'budget.maxUsd must be a non-negative number or null')
  }

  const handoff = raw.handoff ? validateHandoff(raw.handoff) : null

  return {
    version: WORK_PACKET_VERSION,
    taskId: raw.taskId,
    laneId: text(raw.laneId, 80) || null,
    role: text(raw.role, 40) || null,
    goal,
    acceptance,
    reads,
    writes: { scope: writeScope, ...(writes.mode ? { mode: text(writes.mode, 20) } : {}) },
    baseline: {
      commit: baseline.commit ?? null,
      treeDigest: baseline.treeDigest ?? null,
      ...(baseline.capturedAt ? { capturedAt: text(baseline.capturedAt, 40) } : {}),
    },
    facts,
    decisions,
    openQuestions,
    artifacts,
    budget: {
      maxCalls: budget.maxCalls ?? null,
      maxUsd: budget.maxUsd ?? null,
      ...(budget.ledgerRef ? { ledgerRef: text(budget.ledgerRef, 200) } : {}),
    },
    constraints: {
      readOnly: (raw.constraints ?? {}).readOnly !== false,
    },
    ...(handoff ? { handoff } : {}),
  }
}

/**
 * Build a packet from trusted task facts. Only fields the caller actually has
 * are filled; nothing is inferred (A09: no invented baselines or budgets).
 */
export function buildWorkPacket({
  taskId, laneId, role, goal, acceptance, reads = [], writeScope = [],
  commit = null, treeDigest = null, capturedAt = null,
  facts = [], decisions = [], openQuestions = [], artifacts = [],
  maxCalls = null, maxUsd = null, ledgerRef = null, readOnly = true, handoff = null,
} = {}) {
  return validateWorkPacket({
    version: WORK_PACKET_VERSION,
    taskId,
    laneId,
    role,
    goal,
    acceptance,
    reads,
    writes: { scope: writeScope },
    baseline: { commit, treeDigest, ...(capturedAt ? { capturedAt } : {}) },
    facts,
    decisions,
    openQuestions,
    artifacts,
    budget: { maxCalls, maxUsd, ...(ledgerRef ? { ledgerRef } : {}) },
    constraints: { readOnly },
    ...(handoff ? { handoff } : {}),
  })
}

/** Compact, model-facing rendering (the brief an executor actually reads). */
export function renderWorkPacket(packet) {
  const validated = validateWorkPacket(packet)
  const lines = [
    `WorkPacket ${validated.taskId}${validated.role ? ` · role ${validated.role}` : ''}${validated.laneId ? ` · lane ${validated.laneId}` : ''}`,
    `Goal: ${validated.goal}`,
  ]
  lines.push('Acceptance:')
  for (const item of validated.acceptance) lines.push(`  - ${item}`)
  if (validated.reads.length) {
    lines.push('Read:')
    for (const row of validated.reads) lines.push(`  - ${row.ref}${row.why ? ` (${row.why})` : ''}`)
  }
  if (validated.writes.scope.length) lines.push(`Write scope: ${validated.writes.scope.join(', ')}`)
  lines.push(`Baseline: commit ${validated.baseline.commit ?? 'none'} · tree ${validated.baseline.treeDigest?.slice(0, 16) ?? 'none'}`)
  if (validated.facts.length) {
    lines.push('Verified facts:')
    for (const fact of validated.facts) {
      lines.push(`  - ${fact.statement} [${fact.sourceRef} @ ${fact.sourceDigest.slice(0, 12)} ${fact.observedAt}]`)
    }
  }
  for (const [label, rows] of [['Decisions', validated.decisions], ['Open questions', validated.openQuestions]]) {
    if (rows.length) {
      lines.push(`${label}:`)
      for (const row of rows) lines.push(`  - ${row}`)
    }
  }
  if (validated.artifacts.length) lines.push(`Artifacts: ${validated.artifacts.join(', ')}`)
  lines.push(`Budget: maxCalls ${validated.budget.maxCalls ?? 'unlimited'} · maxUsd ${validated.budget.maxUsd ?? 'unlimited'}`)
  lines.push(`Constraints: ${validated.constraints.readOnly ? 'read-only' : 'write allowed within scope'}`)
  return lines.join('\n')
}

/**
 * Fit one packet under a character budget for transport.
 *
 * Over-limit material is externalized into artifacts (via the provided
 * store): facts and long read notes move first, as references. Acceptance,
 * budget, constraints, write scope and baseline are NEVER externalized or
 * dropped — if the packet is still too large, it is refused with
 * OMC/PACKET-TOO-LARGE and the caller must shrink the task itself.
 */
export function fitWorkPacket(packet, { maxChars = MAX_PACKET_CHARS, artifactStore = null } = {}) {
  let current = validateWorkPacket(packet)
  const externalized = []

  const size = (value) => renderWorkPacket(value).length
  if (size(current) <= maxChars) return { packet: current, externalized }

  // 1. Externalize fact statements (the digest/reference metadata stays).
  if (current.facts.length && artifactStore) {
    const factText = current.facts.map((fact, i) => `${i + 1}. ${fact.statement} [${fact.sourceRef} @ ${fact.sourceDigest.slice(0, 12)}]`).join('\n')
    const artifact = artifactStore.put({
      parentId: current.taskId, taskId: current.taskId, kind: 'packet-facts',
      label: `facts for ${current.taskId}`, content: factText,
    })
    externalized.push(artifact.artifactId)
    current = validateWorkPacket({
      ...current,
      facts: [],
      openQuestions: [...current.openQuestions, `full verified facts are externalized in ${artifactStore.reference(artifact.artifactId)}`],
      artifacts: [...current.artifacts, artifactStore.reference(artifact.artifactId)],
    })
    if (size(current) <= maxChars) return { packet: current, externalized }
  }

  // 2. Externalize the goal's overflow: keep a hard head, reference the rest.
  if (current.goal.length > 2000 && artifactStore) {
    const artifact = artifactStore.put({
      parentId: current.taskId, taskId: current.taskId, kind: 'packet-goal',
      label: `full goal for ${current.taskId}`, content: current.goal,
    })
    externalized.push(artifact.artifactId)
    current = validateWorkPacket({
      ...current,
      goal: `${current.goal.slice(0, 2000)}… [full goal externalized in ${artifactStore.reference(artifact.artifactId)}]`,
      artifacts: [...current.artifacts, artifactStore.reference(artifact.artifactId)],
    })
    if (size(current) <= maxChars) return { packet: current, externalized }
  }

  // Nothing left to externalize without touching acceptance, budget or
  // constraints: refuse rather than trim the contract.
  throw packetError('OMC/PACKET-TOO-LARGE',
    `the work packet does not fit ${maxChars} characters even after externalizing ${externalized.length} artifact(s); shrink the task or raise the limit explicitly`)
}
