/**
 * Parent-session work graph.
 *
 * The graph is the orchestration contract, not a scheduler. DSH still owns the
 * child Agents and their lifecycle. This store adds what a prompt cannot:
 * dependencies, acceptance evidence, and a runtime write-scope claim that keeps
 * two write roles from editing the same tree at the same time.
 *
 * It is deliberately append-friendly and profile-scoped so a restarted Host can
 * answer "what was running, what completed, and what is still unproven".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const GRAPH_SCHEMA_VERSION = 1
export const GRAPH_STATES = Object.freeze(['pending', 'ready', 'running', 'completed', 'failed', 'cancelled'])

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
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

function graphError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function text(value, max = 200) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Normalize a write scope. Absolute paths and `..` are refused: the graph must
 * describe workspace-relative intent, never an escape.
 */
export function normalizeScope(scope) {
  if (!Array.isArray(scope)) return []
  const out = []
  for (const raw of scope.slice(0, 20)) {
    const value = text(raw, 400).replace(/\\/g, '/')
    if (value === '') continue
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
      throw graphError('OMC/GRAPH-SCOPE', `write scope "${value}" must be a workspace-relative path`)
    }
    out.push(value)
  }
  return [...new Set(out)]
}

function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + source.replace(/\/$/, '') + '(?:/.*)?$')
}

/** Whether one changed path is inside one scope entry. */
export function inScope(path, scope) {
  const file = String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (file === '' || file.split('/').includes('..')) return false
  const patterns = Array.isArray(scope) ? scope : []
  // An empty scope is the whole workspace, not "nothing".
  if (patterns.length === 0) return true
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === '**') return true
    return globToRegExp(pattern).test(file)
  })
}

/** Whether two write claims could touch the same path. */
export function scopesOverlap(a, b) {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  if (left.length === 0 || right.length === 0) return true
  return left.some((one) => right.some((two) =>
    one === two || one.startsWith(two.replace(/\/$/, '') + '/') || two.startsWith(one.replace(/\/$/, '') + '/') ||
    globToRegExp(one).test(two.replace(/\/$/, '') + '/x') || globToRegExp(two).test(one.replace(/\/$/, '') + '/x')))
}

function blank(parentId) {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    parentId,
    updatedAt: null,
    nodes: {},
    claims: {},
  }
}

export function validateNodes(input) {
  if (!Array.isArray(input) || input.length === 0) throw graphError('OMC/GRAPH-INVALID', 'graph plan needs a non-empty nodes array')
  if (input.length > 40) throw graphError('OMC/GRAPH-INVALID', 'graph plan is limited to 40 nodes')
  const ids = new Set()
  const nodes = []
  for (const raw of input) {
    const id = text(raw?.id, 80)
    if (id === '') throw graphError('OMC/GRAPH-INVALID', 'every node needs an id')
    if (ids.has(id)) throw graphError('OMC/GRAPH-INVALID', `duplicate node id "${id}"`)
    ids.add(id)
    const deps = Array.isArray(raw?.deps) ? [...new Set(raw.deps.map((dep) => text(dep, 80)).filter(Boolean))] : []
    if (deps.includes(id)) throw graphError('OMC/GRAPH-INVALID', `node "${id}" depends on itself`)
    const acceptance = Array.isArray(raw?.acceptance)
      ? raw.acceptance.map((entry) => text(entry, 300)).filter(Boolean).slice(0, 16)
      : []
    nodes.push({
      id,
      roleId: text(raw?.role, 40) || text(raw?.roleId, 40),
      title: text(raw?.title, 200) || id,
      deps,
      write: raw?.write === true,
      writeScope: normalizeScope(raw?.writeScope),
      acceptance,
      state: 'pending',
      taskId: null,
      childId: null,
      evidence: [],
      note: '',
      createdAt: null,
      updatedAt: null,
    })
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) throw graphError('OMC/GRAPH-INVALID', `node "${node.id}" depends on unknown node "${dep}"`)
    }
  }
  // Reject cycles with a DFS; a cycle is a plan error, not a runtime discovery.
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visit = (id, trail) => {
    if (trail.has(id)) throw graphError('OMC/GRAPH-INVALID', `dependency cycle: ${[...trail, id].join(' -> ')}`)
    trail.add(id)
    for (const dep of byId.get(id)?.deps ?? []) visit(dep, new Set(trail))
  }
  for (const node of nodes) visit(node.id, new Set())
  return nodes
}

/** Nodes whose dependencies are completed, excluding already-run nodes. */
export function readyNodes(graph) {
  const nodes = Object.values(graph?.nodes ?? {})
  const done = new Set(nodes.filter((node) => node.state === 'completed').map((node) => node.id))
  return nodes
    .filter((node) => (node.state === 'pending' || node.state === 'ready') && node.deps.every((dep) => done.has(dep)))
    .map((node) => node.id)
}

function readGraph(file, parentId) {
  if (!existsSync(file)) return blank(parentId)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || parsed.schemaVersion !== GRAPH_SCHEMA_VERSION || typeof parsed.nodes !== 'object') {
      throw new Error('unsupported graph schema')
    }
    return { ...blank(parentId), ...parsed, nodes: parsed.nodes, claims: parsed.claims ?? {} }
  } catch (error) {
    throw graphError('OMC/GRAPH-CORRUPT', `graph file is unreadable: ${error?.message ?? error}`)
  }
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number}} [options]
 */
export function createGraphStore({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const root = durable ? dir : null
  const cache = new Map()

  function fileFor(parentId) {
    return join(root, safeSegment(parentId, 'parent') + '.json')
  }

  function read(parentId) {
    if (!durable) return clone(cache.get(parentId) ?? blank(parentId))
    return readGraph(fileFor(parentId), parentId)
  }

  function write(parentId, graph) {
    graph.updatedAt = new Date().toISOString()
    if (!durable) {
      cache.set(parentId, clone(graph))
      return
    }
    atomicWrite(fileFor(parentId), JSON.stringify(graph, null, 2) + '\n')
  }

  function locked(parentId, fn) {
    if (!durable) return fn()
    const lock = acquireFileLockSync(join(root, safeSegment(parentId, 'parent')), {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'graph',
    })
    try {
      return fn()
    } finally {
      lock.release()
    }
  }

function statusFor(parentId, graph) {
    const nodes = Object.values(graph.nodes)
    return {
      parentId,
      nodes,
      ready: readyNodes(graph),
      running: nodes.filter((node) => node.state === 'running').map((node) => node.id),
      blocked: nodes.filter((node) => node.state === 'pending' && node.deps.some((dep) =>
        !['completed'].includes(graph.nodes[dep]?.state))).map((node) => node.id),
      writes: nodes.filter((node) => node.state === 'running' && node.write).map((node) => node.id),
      updatedAt: graph.updatedAt,
    }
  }

  return {
    read,
    plan(parentId, input) {
      const nodes = validateNodes(input)
      return locked(parentId, () => {
        const graph = read(parentId)
        const now = new Date().toISOString()
        for (const node of nodes) {
          const existing = graph.nodes[node.id]
          if (existing && ['running', 'completed'].includes(existing.state)) {
            throw graphError('OMC/GRAPH-EXISTS', `node "${node.id}" is already ${existing.state}`)
          }
          graph.nodes[node.id] = { ...node, createdAt: existing?.createdAt ?? now, updatedAt: now }
        }
        write(parentId, graph)
        return { graph, ready: readyNodes(graph) }
      })
    },
    status(parentId) {
      return statusFor(parentId, read(parentId))
    },
    claim(parentId, nodeId, { taskId, childId } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (!['pending', 'ready'].includes(node.state)) {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}, not claimable`)
        }
        for (const dep of node.deps) {
          if (graph.nodes[dep]?.state !== 'completed') {
            throw graphError('OMC/GRAPH-DEPENDENCY', `node "${nodeId}" waits for "${dep}"`)
          }
        }
        if (node.write) {
          for (const other of Object.values(graph.nodes)) {
            if (other.id === node.id || other.state !== 'running' || !other.write) continue
            if (scopesOverlap(node.writeScope, other.writeScope)) {
              throw graphError('OMC/GRAPH-WRITE-CONFLICT',
                `write node "${node.id}" overlaps running node "${other.id}" (${other.writeScope.join(', ') || 'whole workspace'})`)
            }
          }
        }
        node.state = 'running'
        node.taskId = text(taskId, 80) || null
        node.childId = text(childId, 120) || null
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = { at: node.updatedAt, taskId: node.taskId, childId: node.childId }
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    complete(parentId, nodeId, { status = 'completed', evidence = [], changedFiles, taskId } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        // Duplicate completion events are the common case (host retries, double
        // notices): an identical re-settlement is idempotent, and only a
        // CONTRADICTORY one is refused (A13).
        if (node.state === status) {
          return { node: clone(node), status: statusFor(parentId, graph), duplicate: true }
        }
        if (node.state !== 'running') {
          if (['completed', 'failed', 'cancelled'].includes(node.state)) {
            throw graphError('OMC/GRAPH-CONFLICT',
              `node "${nodeId}" already settled as ${node.state}; refusing to rewrite it to ${status}`)
          }
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}, not running`)
        }
        if (!['completed', 'failed', 'cancelled'].includes(status)) {
          throw graphError('OMC/GRAPH-INVALID', `completion status "${status}" is not allowed`)
        }
        const proof = Array.isArray(evidence) ? evidence.map((entry) => text(entry, 500)).filter(Boolean) : []
        if (status === 'completed' && node.acceptance.length > 0 && proof.length === 0) {
          throw graphError('OMC/GRAPH-ACCEPTANCE', `node "${nodeId}" has acceptance criteria but no evidence; completion refused`)
        }
        if (status === 'completed' && node.write && !Array.isArray(changedFiles)) {
          throw graphError('OMC/GRAPH-WRITE-AUDIT',
            `write node "${nodeId}" needs the changed-file list before it can be marked complete`)
        }
        if (status === 'completed' && node.write && Array.isArray(changedFiles)) {
          const outside = changedFiles
            .map((entry) => String(entry).replace(/\\/g, '/').replace(/^\.\//, ''))
            .filter((entry) => entry !== '' && !inScope(entry, node.writeScope))
          if (outside.length > 0) {
            node.state = 'failed'
            node.note = 'write scope violation: ' + outside.join(', ')
            node.updatedAt = new Date().toISOString()
            graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), at: node.updatedAt }
            write(parentId, graph)
            throw graphError('OMC/GRAPH-WRITE-SCOPE',
              `node "${nodeId}" changed paths outside its scope: ${outside.join(', ')}`)
          }
        }
        node.state = status
        node.evidence = proof
        node.taskId = text(taskId, 80) || node.taskId
        node.note = ''
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), settledAt: node.updatedAt }
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    /**
     * Release a claim that never reached activation (or whose activation
     * died): the node returns to `ready`/`failed` and the writer slot frees,
     * so one failed start cannot wedge the whole graph (A13).
     */
    release(parentId, nodeId, { reason, to = 'ready' } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (node.state !== 'running') {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}; only a running claim can be released`)
        }
        if (!['ready', 'failed', 'cancelled'].includes(to)) {
          throw graphError('OMC/GRAPH-INVALID', `release target "${to}" is not allowed (ready, failed, cancelled)`)
        }
        node.state = to
        node.note = text(reason, 300) || 'claim released before settlement'
        node.taskId = null
        node.childId = null
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), releasedAt: node.updatedAt, releaseReason: node.note }
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    /**
     * Crash recovery: `running` nodes whose worker is provably gone return to
     * `pending` with a note, their claims close, and the writer slot frees.
     * A node still attached to a live worker is left untouched (A13).
     */
    recover(parentId, { isAlive = () => false } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const recovered = []
        for (const node of Object.values(graph.nodes)) {
          if (node.state !== 'running') continue
          const claim = graph.claims[node.id] ?? {}
          if (isAlive({ node, claim })) continue
          node.state = 'pending'
          node.note = 'recovered after restart: the claim had no live worker'
          node.taskId = null
          node.childId = null
          node.updatedAt = new Date().toISOString()
          graph.claims[node.id] = { ...claim, releasedAt: node.updatedAt, releaseReason: 'recovery' }
          recovered.push(node.id)
        }
        if (recovered.length) write(parentId, graph)
        return { recovered, status: statusFor(parentId, graph) }
      })
    },
    cancel(parentId, nodeId, { reason } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        node.state = 'cancelled'
        node.note = text(reason, 300)
        node.updatedAt = new Date().toISOString()
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    /** Audit a completed write node against its declared scope. */
    audit(parentId, nodeId, changedFiles) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        const files = (Array.isArray(changedFiles) ? changedFiles : []).map((entry) => String(entry).replace(/\\/g, '/').replace(/^\.\//, ''))
        const outside = files.filter((entry) => entry !== '' && !inScope(entry, node.writeScope))
        return { nodeId, files, outside, ok: outside.length === 0 }
      })
    },
  }
}

/**
 * Merge acceptance gate: a write node may merge only after it completed with
 * the evidence its plan demanded. This is intentionally separate from git's
 * clean-tree check: a clean tree does not prove the acceptance criteria.
 */
export function mergeAcceptance(status, nodeId) {
  const node = (status?.nodes ?? []).find((row) => row.id === nodeId)
  if (!node) return { ok: false, code: 'OMC/WORKTREE-ACCEPTANCE', reason: `unknown graph node "${nodeId}"` }
  if (node.state !== 'completed') {
    return { ok: false, code: 'OMC/WORKTREE-ACCEPTANCE', reason: `node "${nodeId}" is ${node.state}, not completed` }
  }
  if (Array.isArray(node.acceptance) && node.acceptance.length > 0 && (!Array.isArray(node.evidence) || node.evidence.length === 0)) {
    return { ok: false, code: 'OMC/WORKTREE-ACCEPTANCE', reason: `node "${nodeId}" has no acceptance evidence` }
  }
  return { ok: true, node }
}

