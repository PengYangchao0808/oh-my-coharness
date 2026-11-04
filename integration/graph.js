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

export const GRAPH_SCHEMA_VERSION = 2
const COMPAT_GRAPH_SCHEMA_VERSION = 1
export const MAX_GRAPH_DEPTH = 24
export const GRAPH_STATES = Object.freeze(['pending', 'ready', 'running', 'completed', 'failed', 'cancelled'])
const LINEAGE_SOURCES = Object.freeze(['host', 'legacy', 'unknown'])

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

function optionalText(value, max = 160) {
  const trimmed = text(value, max)
  return trimmed === '' ? null : trimmed
}

function normalizeLineage(raw, { fallback = 'unknown', note = null } = {}) {
  const value = typeof raw === 'string' ? { source: raw } : (raw && typeof raw === 'object' ? raw : {})
  const source = LINEAGE_SOURCES.includes(value.source) ? value.source : fallback
  const trimmedNote = optionalText(value.note, 300)
  return {
    source,
    parentSessionId: optionalText(value.parentSessionId, 160),
    rootSessionId: optionalText(value.rootSessionId, 160),
    ...(trimmedNote ?? note ? { note: trimmedNote ?? note } : {}),
  }
}

/**
 * Workstream is a label, not a role: it only has to be a stable, path-safe id.
 * Requiring `workstream === roleId` would be wrong — one workstream may be
 * worked by several roles.
 */
export function normalizeWorkstream(value) {
  const raw = optionalText(value, 80)
  if (raw === null) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(raw)) {
    throw graphError('OMC/GRAPH-WORKSTREAM', `workstream "${raw}" must be a stable id (letters, digits, . _ : -)`)
  }
  return raw
}

function newClaimId() {
  return `claim-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
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
    rootTaskId: null,
    lineage: null,
    updatedAt: null,
    nodes: {},
    claims: {},
  }
}

/**
 * Give one node the identity fields every reader may rely on. A schemaVersion 1
 * node cannot have recorded identity; it keeps the old defaults and is labeled
 * `legacy` instead of being promoted to host-proven.
 */
function normalizeNode(raw, { legacy = false } = {}) {
  const id = text(raw?.id, 80)
  const ticketId = optionalText(raw?.ticketId, 80) ?? id
  const depth = Number.isInteger(raw?.depth) && raw.depth >= 0 && raw.depth <= MAX_GRAPH_DEPTH ? raw.depth : 0
  return {
    ...raw,
    id,
    parentNodeId: optionalText(raw?.parentNodeId, 80),
    parentTaskId: optionalText(raw?.parentTaskId, 160),
    rootTaskId: optionalText(raw?.rootTaskId, 160),
    depth,
    ticketId,
    workstream: optionalText(raw?.workstream, 80),
    lineage: legacy
      ? normalizeLineage(raw?.lineage?.source === 'legacy' ? raw.lineage : 'legacy', {
          note: 'pre-0.6 graph node: lineage fields were not recorded',
        })
      : normalizeLineage(raw?.lineage, { fallback: 'unknown' }),
    legacy,
    claimId: optionalText(raw?.claimId, 80),
    // 0.6 trusted acceptance: a runnable spec, the baseline frozen before
    // dispatch, and the trusted verdict that references them. Legacy
    // `acceptance` strings stay visible but can never become a passed verdict.
    acceptanceSpec: raw?.acceptanceSpec && typeof raw.acceptanceSpec === 'object' ? clone(raw.acceptanceSpec) : null,
    acceptanceBaseline: raw?.acceptanceBaseline && typeof raw.acceptanceBaseline === 'object' ? clone(raw.acceptanceBaseline) : null,
    acceptanceVerdict: raw?.acceptanceVerdict && typeof raw.acceptanceVerdict === 'object' ? clone(raw.acceptanceVerdict) : null,
    acceptanceState: ['pending', 'passed', 'failed', 'unknown'].includes(raw?.acceptanceState) ? raw.acceptanceState : 'pending',
    acceptanceAttemptId: optionalText(raw?.acceptanceAttemptId, 160),
    acceptanceHistory: Array.isArray(raw?.acceptanceHistory) ? clone(raw.acceptanceHistory).slice(-10) : [],
  }
}

export function validateNodes(input, { existingNodes = null, rootTaskId = null, parentTaskId = null, lineage = null } = {}) {
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
    const declaredDepth = Number.isInteger(raw?.depth) ? raw.depth : null
    if (declaredDepth !== null && (declaredDepth < 0 || declaredDepth > MAX_GRAPH_DEPTH)) {
      throw graphError('OMC/GRAPH-DEPTH', `node "${id}" declares depth ${declaredDepth}; the limit is ${MAX_GRAPH_DEPTH}`)
    }
    nodes.push({
      id,
      roleId: text(raw?.role, 40) || text(raw?.roleId, 40),
      title: text(raw?.title, 200) || id,
      deps,
      write: raw?.write === true,
      writeScope: normalizeScope(raw?.writeScope),
      acceptance,
      acceptanceSpec: raw?.acceptanceSpec && typeof raw.acceptanceSpec === 'object' ? clone(raw.acceptanceSpec) : null,
      // Optional identity. `rootTaskId`/`depth` are normally derived (from the
      // trusted caller lineage and the parent node) rather than self-declared.
      parentNodeId: optionalText(raw?.parentNodeId, 80),
      parentTaskId: optionalText(raw?.parentTaskId, 160) ?? optionalText(parentTaskId, 160),
      rootTaskId: optionalText(raw?.rootTaskId, 160) ?? optionalText(rootTaskId, 160),
      depth: declaredDepth,
      ticketId: optionalText(raw?.ticketId, 80) ?? id,
      workstream: raw?.workstream === undefined ? null : normalizeWorkstream(raw?.workstream),
      lineage: normalizeLineage(raw?.lineage ?? lineage, {
        fallback: 'unknown',
        note: raw?.lineage === undefined && lineage === null ? 'no host lineage was supplied for this node' : null,
      }),
      state: 'pending',
      taskId: null,
      childId: null,
      claimId: null,
      acceptanceState: 'pending',
      acceptanceBaseline: null,
      acceptanceVerdict: null,
      acceptanceAttemptId: null,
      acceptanceHistory: [],
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

  // Identity graph: the parent node may live in this plan or in the already
  // stored graph (a later ticket extending an existing graph). Depth is derived
  // in dependency order, so a parent declared later in the same plan works.
  const all = new Map(Object.entries(existingNodes ?? {}).map(([key, value]) => [key, normalizeNode(value)]))
  const pending = new Map()
  for (const node of nodes) {
    all.set(node.id, node)
    pending.set(node.id, node)
  }
  while (pending.size > 0) {
    let progressed = false
    for (const node of [...pending.values()]) {
      if (!node.parentNodeId) {
        if (node.depth === null) node.depth = 0
        pending.delete(node.id)
        progressed = true
        continue
      }
      const parent = all.get(node.parentNodeId)
      if (!parent) {
        throw graphError('OMC/GRAPH-PARENT', `node "${node.id}" names unknown parent node "${node.parentNodeId}"`)
      }
      if (node.parentNodeId === node.id) {
        throw graphError('OMC/GRAPH-PARENT', `node "${node.id}" cannot be its own parent`)
      }
      // Wait for a planned parent's own depth to resolve first.
      if (pending.has(parent.id) && parent.depth === null) continue
      const expected = (Number.isInteger(parent.depth) ? parent.depth : 0) + 1
      if (node.depth !== null && node.depth !== expected) {
        throw graphError('OMC/GRAPH-DEPTH', `node "${node.id}" declares depth ${node.depth}, but its parent "${parent.id}" makes it ${expected}`)
      }
      node.depth = expected
      const parentRoot = optionalText(parent.rootTaskId)
      if (parentRoot && node.rootTaskId && parentRoot !== node.rootTaskId) {
        throw graphError('OMC/GRAPH-ROOT', `node "${node.id}" and its parent "${parent.id}" belong to different roots`)
      }
      node.rootTaskId = node.rootTaskId ?? parentRoot ?? null
      pending.delete(node.id)
      progressed = true
    }
    if (!progressed) {
      const ids = [...pending.keys()].join(', ')
      throw graphError('OMC/GRAPH-PARENT', `parent chain cycle or unresolved parent depth at node(s) ${ids}`)
    }
  }
  for (const node of nodes) {
    if (node.depth === null) node.depth = 0
    if (node.depth > MAX_GRAPH_DEPTH) {
      throw graphError('OMC/GRAPH-DEPTH', `node "${node.id}" is at depth ${node.depth}; the limit is ${MAX_GRAPH_DEPTH}`)
    }
  }
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
    const version = parsed?.schemaVersion
    if ((version !== GRAPH_SCHEMA_VERSION && version !== COMPAT_GRAPH_SCHEMA_VERSION) || typeof parsed.nodes !== 'object') {
      throw new Error('unsupported graph schema')
    }
    const legacy = version < GRAPH_SCHEMA_VERSION
    const graph = {
      ...blank(parentId),
      ...parsed,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      rootTaskId: optionalText(parsed.rootTaskId, 160),
      lineage: legacy
        ? normalizeLineage('legacy', { note: 'pre-0.6 graph: lineage fields were not recorded' })
        : normalizeLineage(parsed.lineage, { fallback: 'unknown' }),
      nodes: {},
      claims: parsed.claims ?? {},
    }
    for (const [id, node] of Object.entries(parsed.nodes)) {
      graph.nodes[id] = normalizeNode(node, { legacy: legacy || node?.legacy === true })
    }
    return graph
  } catch (error) {
    throw graphError('OMC/GRAPH-CORRUPT', `graph file is unreadable: ${error?.message ?? error}`)
  }
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number, strictLineage?: boolean,
 *          acceptance?: object|null, writerLease?: object|null,
 *          writerLeaseFactory?: ((workspaceRoot: string) => object)|null,
 *          workspaceRoot?: string|null}} [options]
 */
export function createGraphStore({
  dir,
  lockTimeoutMs = 10_000,
  strictLineage = false,
  acceptance = null,
  writerLease = null,
  writerLeaseFactory = null,
  workspaceRoot = null,
} = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const rootDir = durable ? dir : null
  const cache = new Map()
  /** @type {Map<string, object>} workspaceRoot → writer lease */
  const leaseCache = new Map()
  /** @type {Map<string, {lease: object, token: string, timer: any, lost: string|null}>} */
  const activeLeases = new Map()
  let acceptanceAuthority = acceptance

  function fileFor(parentId) {
    return join(rootDir, safeSegment(parentId, 'parent') + '.json')
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
    const lock = acquireFileLockSync(join(rootDir, safeSegment(parentId, 'parent')), {
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

  // ── project writer lease (0.6 PR-03) ────────────────────────────────────────
  // Order is fixed everywhere: the parent graph lock is taken first, then the
  // project lease (inside `locked`). No other path may invert that order.
  function leaseFor(workspace) {
    if (writerLease && typeof writerLease.acquire === 'function') return writerLease
    const workspaceRootForLease = workspace ?? workspaceRoot
    if (!workspaceRootForLease || typeof writerLeaseFactory !== 'function') return null
    if (!leaseCache.has(workspaceRootForLease)) {
      leaseCache.set(workspaceRootForLease, writerLeaseFactory(workspaceRootForLease))
    }
    return leaseCache.get(workspaceRootForLease)
  }

  function leaseOwner(parentId, nodeId) {
    return `${parentId}#${nodeId}`
  }

  function stopHeartbeat(owner) {
    const entry = activeLeases.get(owner)
    if (!entry) return null
    if (entry.timer) {
      try { clearInterval(entry.timer) } catch { /* already gone */ }
    }
    activeLeases.delete(owner)
    return entry
  }

  function startHeartbeat(owner, lease, token, heartbeatMs) {
    const interval = Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 15_000
    const timer = setInterval(() => {
      const entry = activeLeases.get(owner)
      if (!entry) return
      try {
        lease.heartbeat({ owner, token: entry.token })
      } catch (error) {
        // A lost lease is reported, never silently reinterpreted: the writer
        // must stop, the claim record keeps the note.
        entry.lost = String(error?.code ?? error?.message ?? error)
        try { clearInterval(timer) } catch { /* already gone */ }
      }
    }, interval)
    // A heartbeat is housekeeping; it must never keep the host process alive.
    if (typeof timer.unref === 'function') timer.unref()
    activeLeases.set(owner, { lease, token, timer, lost: null })
  }

  function acquireLease({ parentId, node, workspace, claimId }) {
    if (node.write !== true) return null
    const lease = leaseFor(workspace)
    if (!lease || typeof lease.acquire !== 'function') return null
    const owner = leaseOwner(parentId, node.id)
    // Failure here is fail-closed and happens before the node state changes, so
    // a refused claim leaves no graph state and no lease behind.
    const acquired = lease.acquire({ owner })
    const binding = {
      owner,
      token: acquired?.token ?? null,
      key: acquired?.key ?? lease.key ?? null,
      path: acquired?.path ?? lease.path ?? null,
      claimId,
      heartbeatMs: Number.isSafeInteger(lease.heartbeatMs) ? lease.heartbeatMs : 15_000,
      at: new Date().toISOString(),
    }
    if (binding.token) startHeartbeat(owner, lease, binding.token, binding.heartbeatMs)
    return binding
  }

  function releaseLease(owner, { reason = null } = {}) {
    const entry = stopHeartbeat(owner)
    if (!entry) return null
    try {
      entry.lease.release({ owner, token: entry.token })
      return { released: true, reason }
    } catch (error) {
      // Not the owner (already taken over) is not a crash: the lease is gone.
      return { released: false, reason, error: String(error?.code ?? error?.message ?? error) }
    }
  }

  function leaseOwnerOf(node, graph) {
    const claim = graph?.claims?.[node?.id]
    return claim?.lease?.owner ?? null
  }

  function releaseNodeLease(node, graph) {
    const owner = leaseOwnerOf(node, graph)
    if (!owner) return
    releaseLease(owner)
    const claim = graph.claims?.[node.id]
    if (claim) {
      claim.lease = null
      claim.leaseReleasedAt = new Date().toISOString()
    }
  }

function statusFor(parentId, graph) {
    const nodes = Object.values(graph.nodes)
    return {
      parentId,
      rootTaskId: graph.rootTaskId ?? null,
      lineage: graph.lineage ? { ...graph.lineage } : null,
      nodes,
      claims: clone(graph.claims ?? {}),
      ready: readyNodes(graph),
      running: nodes.filter((node) => node.state === 'running').map((node) => node.id),
      blocked: nodes.filter((node) => node.state === 'pending' && node.deps.some((dep) =>
        !['completed'].includes(graph.nodes[dep]?.state))).map((node) => node.id),
      writes: nodes.filter((node) => node.state === 'running' && node.write).map((node) => node.id),
      acceptancePending: nodes.filter((node) => node.state === 'running'
        && ((node.acceptance?.length ?? 0) > 0 || node.acceptanceSpec)
        && node.acceptanceState !== 'passed').map((node) => node.id),
      acceptanceFailed: nodes.filter((node) => node.acceptanceState === 'failed').map((node) => node.id),
      updatedAt: graph.updatedAt,
    }
  }

  return {
    read,
    plan(parentId, input, options = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const plannedRoot = optionalText(options.rootTaskId, 160)
        if (plannedRoot && graph.rootTaskId && plannedRoot !== graph.rootTaskId) {
          throw graphError('OMC/GRAPH-ROOT',
            `this graph belongs to root ${graph.rootTaskId}; a plan from root ${plannedRoot} would mix two roots`)
        }
        const nodes = validateNodes(input, {
          existingNodes: graph.nodes,
          rootTaskId: plannedRoot ?? graph.rootTaskId ?? null,
          parentTaskId: options.parentTaskId ?? null,
          lineage: options.lineage ?? graph.lineage ?? null,
        })
        for (const node of nodes) {
          if (graph.rootTaskId && node.rootTaskId && node.rootTaskId !== graph.rootTaskId) {
            throw graphError('OMC/GRAPH-ROOT',
              `node "${node.id}" declares root ${node.rootTaskId}, but this graph belongs to root ${graph.rootTaskId}`)
          }
        }
        const now = new Date().toISOString()
        if (options.rootTaskId && !graph.rootTaskId) graph.rootTaskId = optionalText(options.rootTaskId, 160)
        if (options.lineage) graph.lineage = normalizeLineage(options.lineage, { fallback: 'unknown' })
        for (const node of nodes) {
          const existing = graph.nodes[node.id]
          if (existing && ['running', 'completed'].includes(existing.state)) {
            throw graphError('OMC/GRAPH-EXISTS', `node "${node.id}" is already ${existing.state}`)
          }
          // A re-plan of a pending/ready/failed node keeps the identity that was
          // already recorded; replay never duplicates or rewrites it.
          graph.nodes[node.id] = {
            ...node,
            parentNodeId: node.parentNodeId ?? existing?.parentNodeId ?? null,
            parentTaskId: node.parentTaskId ?? existing?.parentTaskId ?? null,
            rootTaskId: node.rootTaskId ?? existing?.rootTaskId ?? null,
            ticketId: node.ticketId ?? existing?.ticketId ?? node.id,
            workstream: node.workstream ?? existing?.workstream ?? null,
            lineage: node.lineage?.source === 'unknown' && existing?.lineage ? existing.lineage : node.lineage,
            claimId: existing?.claimId ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }
        }
        write(parentId, graph)
        return { graph, ready: readyNodes(graph), rootTaskId: graph.rootTaskId ?? null }
      })
    },
    status(parentId) {
      return statusFor(parentId, read(parentId))
    },
    claim(parentId, nodeId, { taskId, childId, rootTaskId, ticketId, workstream, lineage, claimId, strictLineage: strict, workspace } = {}) {
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
        // ── identity checks (PR-01) ─────────────────────────────────────────
        // The graph root is the shard's trusted root task; a node belongs to
        // it. A caller presenting a claim for another root is refusing to mix
        // two graphs, not silently writing across them.
        const graphRoot = optionalText(graph.rootTaskId, 160)
        const nodeRoot = optionalText(node.rootTaskId, 160) ?? graphRoot
        const claimRoot = optionalText(rootTaskId, 160) ?? optionalText(lineage?.rootTaskId, 160)
        if (claimRoot && nodeRoot && claimRoot !== nodeRoot) {
          throw graphError('OMC/GRAPH-ROOT',
            `node "${nodeId}" belongs to root ${nodeRoot}, but this claim carries root ${claimRoot}; cross-root claims are refused`)
        }
        const claimLineage = normalizeLineage(lineage, {
          fallback: 'unknown',
          note: lineage === undefined
            ? 'no host lineage was supplied for this claim'
            : null,
        })
        if ((strict ?? strictLineage) && claimLineage.source !== 'host') {
          throw graphError('OMC/GRAPH-LINEAGE',
            `node "${nodeId}" needs host-proven lineage under strict lineage; got ${claimLineage.source}`)
        }
        const suppliedTicket = optionalText(ticketId, 80)
        if (suppliedTicket && node.ticketId && suppliedTicket !== node.ticketId) {
          throw graphError('OMC/GRAPH-TICKET',
            `node "${nodeId}" is ticket ${node.ticketId}, not ${suppliedTicket}; a ticket from another graph cannot claim it`)
        }
        if (workstream !== undefined && workstream !== null) {
          const suppliedWorkstream = normalizeWorkstream(workstream)
          if (node.workstream && node.workstream !== suppliedWorkstream) {
            throw graphError('OMC/GRAPH-WORKSTREAM',
              `node "${nodeId}" belongs to workstream ${node.workstream}, not ${suppliedWorkstream}`)
          }
        }
        if (node.parentNodeId) {
          const parent = graph.nodes[node.parentNodeId]
          if (!parent) {
            throw graphError('OMC/GRAPH-PARENT', `node "${nodeId}" names unknown parent node "${node.parentNodeId}"`)
          }
          const parentClaim = graph.claims[parent.id] ?? {}
          // The parent must be live or delivered; released/recovered parents
          // have no authority to spawn a child claim any more.
          if (!['running', 'completed'].includes(parent.state)) {
            throw graphError('OMC/GRAPH-PARENT-STATE',
              `parent node "${parent.id}" is ${parent.state} (released/recovered); it cannot authorise "${nodeId}"`)
          }
          if (parentClaim.releasedAt && !parentClaim.settledAt) {
            throw graphError('OMC/GRAPH-PARENT-RELEASED',
              `parent node "${parent.id}" was released/recovered; re-claim it before its children can run`)
          }
          const parentRoot = optionalText(parent.rootTaskId, 160) ?? graphRoot
          if (parentRoot && nodeRoot && parentRoot !== nodeRoot) {
            throw graphError('OMC/GRAPH-ROOT',
              `parent node "${parent.id}" and node "${nodeId}" belong to different roots`)
          }
          const expectedDepth = (Number.isInteger(parent.depth) ? parent.depth : 0) + 1
          if (node.depth !== expectedDepth) {
            throw graphError('OMC/GRAPH-DEPTH',
              `node "${nodeId}" is at depth ${node.depth}; parent "${parent.id}" requires depth ${expectedDepth}`)
          }
          if (node.depth > MAX_GRAPH_DEPTH) {
            throw graphError('OMC/GRAPH-DEPTH', `node "${nodeId}" is at depth ${node.depth}; the limit is ${MAX_GRAPH_DEPTH}`)
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
        const resolvedClaimId = optionalText(claimId, 80) ?? newClaimId()
        // Project-level writer lease: acquired only after every graph-level
        // check passed, so a refused claim cannot leave a lease behind. The
        // parent graph lock is already held; that order never varies.
        const lease = acquireLease({ parentId, node, workspace, claimId: resolvedClaimId })
        node.state = 'running'
        node.taskId = text(taskId, 80) || null
        node.childId = text(childId, 120) || null
        node.claimId = resolvedClaimId
        node.claimLineage = claimLineage
        if (claimLineage.source === 'host' || !node.lineage || node.lineage.source === 'unknown') {
          node.lineage = claimLineage
        }
        if (!node.rootTaskId && nodeRoot) node.rootTaskId = nodeRoot
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = {
          at: node.updatedAt,
          taskId: node.taskId,
          childId: node.childId,
          claimId: resolvedClaimId,
          parentNodeId: node.parentNodeId ?? null,
          parentTaskId: node.parentTaskId ?? null,
          rootTaskId: nodeRoot ?? null,
          depth: node.depth ?? 0,
          ticketId: node.ticketId ?? null,
          workstream: node.workstream ?? normalizeWorkstream(workstream),
          lineage: claimLineage,
          lease: lease ? { ...lease } : null,
          settledAt: null,
          releasedAt: null,
        }
        try {
          write(parentId, graph)
        } catch (error) {
          if (lease) releaseLease(lease.owner)
          throw error
        }
        return { node, claimId: resolvedClaimId, lineage: claimLineage, lease: lease ? { ...lease } : null, status: statusFor(parentId, graph) }
      })
    },
    complete(parentId, nodeId, {
      status = 'completed', evidence = [], changedFiles, taskId, claimId,
      verdict = undefined, spec = undefined, workdir = null, attemptId = undefined, treeCheck = true,
    } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        // Duplicate completion events are the common case (host retries, double
        // notices): an identical re-settlement is idempotent, and only a
        // CONTRADICTORY one is refused (A13).
        if (node.state === status) {
          // A previous completion may have died between the state write and the
          // lease release; make the retry release it.
          releaseNodeLease(node, graph)
          write(parentId, graph)
          return { node: clone(node), status: statusFor(parentId, graph), duplicate: true }
        }
        // A settle event carries the claim it belongs to. After release/recover
        // and a re-claim, the old claim id no longer matches, so an old ticket
        // or attempt cannot settle new work.
        const suppliedClaimId = optionalText(claimId, 80)
        if (suppliedClaimId && node.claimId && suppliedClaimId !== node.claimId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM',
            `node "${nodeId}" is now claimed by ${node.claimId}; claim ${suppliedClaimId} is stale`)
        }
        if (text(taskId, 80) && node.taskId && text(taskId, 80) !== node.taskId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM',
            `node "${nodeId}" is now running under task ${node.taskId}; task ${taskId} is stale`)
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
        const hasAcceptance = (Array.isArray(node.acceptance) && node.acceptance.length > 0) || Boolean(node.acceptanceSpec)
        let trustedVerdict = null
        if (status === 'completed' && hasAcceptance) {
          // The single trusted path (PR-02): a caller string or a hand-made
          // `{state:'passed'}` object cannot complete an acceptance node. The
          // verdict must already exist in the OMC execution/verdict record and
          // match this node's task, current attempt, spec and baseline.
          if (!acceptanceAuthority || typeof acceptanceAuthority.resolveStored !== 'function') {
            throw graphError('OMC/GRAPH-ACCEPTANCE-UNAVAILABLE',
              'this graph has no acceptance authority, so a trusted acceptance verdict cannot be checked')
          }
          const decision = acceptanceAuthority.resolveStored({
            taskId: node.taskId || text(taskId, 80),
            nodeId,
            node,
            spec,
            workdir,
            verdict,
            attemptId,
            treeCheck,
          })
          if (!decision.ok) {
            throw graphError('OMC/GRAPH-ACCEPTANCE',
              `node "${nodeId}" cannot be completed: ${decision.reason ?? `no trusted passing verdict (state ${decision.state})`}`)
          }
          trustedVerdict = decision.verdict
          node.acceptanceVerdict = clone(trustedVerdict)
          node.acceptanceState = trustedVerdict.state
          node.acceptanceAttemptId = trustedVerdict.attemptId ?? null
          node.evidence = [
            ...proof,
            ...(typeof acceptanceAuthority.evidenceFor === 'function' ? acceptanceAuthority.evidenceFor(trustedVerdict) : []),
          ]
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
            releaseNodeLease(node, graph)
            graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), at: node.updatedAt, settledAt: node.updatedAt }
            write(parentId, graph)
            throw graphError('OMC/GRAPH-WRITE-SCOPE',
              `node "${nodeId}" changed paths outside its scope: ${outside.join(', ')}`)
          }
        }
        node.state = status
        if (!trustedVerdict) node.evidence = proof
        node.taskId = text(taskId, 80) || node.taskId
        node.note = ''
        node.updatedAt = new Date().toISOString()
        if (trustedVerdict) {
          node.acceptanceHistory.push({
            at: node.updatedAt,
            state: trustedVerdict.state,
            verdictId: trustedVerdict.id,
            attemptId: trustedVerdict.attemptId ?? null,
            baselineId: trustedVerdict.baselineId ?? null,
            specDigest: trustedVerdict.specDigest ?? null,
            completed: true,
          })
          if (node.acceptanceHistory.length > 10) node.acceptanceHistory.splice(0, node.acceptanceHistory.length - 10)
        }
        releaseNodeLease(node, graph)
        graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), settledAt: node.updatedAt }
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph), ...(trustedVerdict ? { verdict: trustedVerdict } : {}) }
      })
    },
    /**
     * Explicit acceptance verification: run the same judge path (or reuse its
     * trusted record) and stamp the node with the verdict. It does not complete
     * the node; a subsequent complete must cite this trusted verdict.
     */
    async verify(parentId, nodeId, {
      spec = undefined, workdir = null, baseline = undefined, verdict = undefined,
      attemptId = undefined, runner = null, timeoutMs = 120_000, treeCheck = true, taskId = undefined,
    } = {}) {
      const decision = await locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (node.state !== 'running') {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}; verify needs a running claim`)
        }
        if (!acceptanceAuthority || typeof acceptanceAuthority.resolve !== 'function') {
          throw graphError('OMC/GRAPH-ACCEPTANCE-UNAVAILABLE', 'this graph has no acceptance authority')
        }
        const resolution = acceptanceAuthority.resolve({
          taskId: text(taskId, 80) || node.taskId, nodeId, node, spec, workdir, baseline, verdict,
          attemptId, runner, timeoutMs, treeCheck, allowGenerate: true,
        })
        return { graph, node, resolution }
      })
      const { graph, node, resolution: pending } = decision
      const resolved = await pending
      return locked(parentId, () => {
        const fresh = read(parentId)
        const current = fresh.nodes[nodeId]
        if (!current || current.claimId !== node.claimId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM', `node "${nodeId}" was re-claimed while its verdict was being produced`)
        }
        if (resolved?.verdict) {
          current.acceptanceVerdict = clone(resolved.verdict)
          current.acceptanceState = resolved.state
          current.acceptanceAttemptId = resolved.verdict.attemptId ?? null
          current.acceptanceSpec = current.acceptanceSpec ?? (spec && typeof spec === 'object' ? clone(spec) : null)
          current.evidence = [
            ...(current.evidence ?? []).filter((entry) => !String(entry).startsWith('acceptance:')),
            ...(typeof acceptanceAuthority.evidenceFor === 'function' ? acceptanceAuthority.evidenceFor(resolved.verdict) : []),
          ]
          current.acceptanceHistory.push({
            at: new Date().toISOString(),
            state: resolved.state,
            verdictId: resolved.verdict.id,
            attemptId: resolved.verdict.attemptId ?? null,
            baselineId: resolved.verdict.baselineId ?? null,
            specDigest: resolved.verdict.specDigest ?? null,
          })
          if (current.acceptanceHistory.length > 10) current.acceptanceHistory.splice(0, current.acceptanceHistory.length - 10)
        } else {
          current.acceptanceState = 'unknown'
          current.acceptanceVerdict = null
        }
        current.updatedAt = new Date().toISOString()
        write(parentId, fresh)
        return {
          node: current,
          verdict: resolved?.verdict ?? null,
          state: resolved?.state ?? 'unknown',
          ok: resolved?.ok === true,
          reason: resolved?.reason ?? null,
          status: statusFor(parentId, fresh),
        }
      })
    },
    /** Freeze/store the pre-dispatch baseline on a claimed node. */
    setBaseline(parentId, nodeId, { baseline, spec = undefined, claimId = null, attemptId = null } = {}) {
      if (!baseline || typeof baseline !== 'object' || !text(baseline.id)) {
        throw graphError('OMC/GRAPH-BASELINE', 'setBaseline needs the frozen baseline record')
      }
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (node.state !== 'running') {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}; a baseline is frozen for a running claim`)
        }
        const suppliedClaimId = optionalText(claimId, 80)
        if (suppliedClaimId && node.claimId && suppliedClaimId !== node.claimId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM', `claim ${suppliedClaimId} is not the current claim ${node.claimId}`)
        }
        node.acceptanceBaseline = clone(baseline)
        if (spec && typeof spec === 'object') node.acceptanceSpec = clone(spec)
        node.acceptanceState = 'pending'
        node.acceptanceVerdict = null
        node.acceptanceAttemptId = attemptId ?? baseline.attemptId ?? null
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = { ...(graph.claims[node.id] ?? {}), baselineId: baseline.id, baselineAt: baseline.frozenAt ?? baseline.at ?? null }
        write(parentId, graph)
        return { node, baseline: clone(baseline), status: statusFor(parentId, graph) }
      })
    },
    /**
     * Explicit reopen for a settled node: a fresh attempt needs a fresh
     * baseline/verdict, so the old ones are cleared (history is kept). The
     * execution store's `retry()` is the caller's job; graph identity only.
     */
    reopen(parentId, nodeId, { reason, attemptId = null } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (!['completed', 'failed', 'cancelled'].includes(node.state)) {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}; only a settled node can be reopened`)
        }
        releaseNodeLease(node, graph)
        node.acceptanceHistory.push({
          at: new Date().toISOString(),
          reopenedFrom: node.state,
          state: node.acceptanceState,
          verdictId: node.acceptanceVerdict?.id ?? null,
          attemptId: node.acceptanceAttemptId ?? null,
          reason: text(reason, 300) || null,
        })
        if (node.acceptanceHistory.length > 10) node.acceptanceHistory.splice(0, node.acceptanceHistory.length - 10)
        node.state = 'pending'
        node.note = text(reason, 300) || 'reopened for a new attempt'
        node.taskId = null
        node.childId = null
        node.claimId = null
        node.evidence = []
        node.acceptanceState = 'pending'
        node.acceptanceVerdict = null
        node.acceptanceBaseline = null
        node.acceptanceAttemptId = null
        node.updatedAt = new Date().toISOString()
        graph.claims[node.id] = {
          ...(graph.claims[node.id] ?? {}),
          reopenedAt: node.updatedAt,
          releaseReason: node.note,
          active: false,
          lease: null,
          attemptId: attemptId ?? null,
        }
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    /**
     * Release a claim that never reached activation (or whose activation
     * died): the node returns to `ready`/`failed` and the writer slot frees,
     * so one failed start cannot wedge the whole graph (A13).
     */
    release(parentId, nodeId, { reason, to = 'ready', claimId, taskId } = {}) {
      return locked(parentId, () => {
        const graph = read(parentId)
        const node = graph.nodes[nodeId]
        if (!node) throw graphError('OMC/GRAPH-NOT-FOUND', `unknown node "${nodeId}"`)
        if (node.state !== 'running') {
          throw graphError('OMC/GRAPH-STATE', `node "${nodeId}" is ${node.state}; only a running claim can be released`)
        }
        const suppliedClaimId = optionalText(claimId, 80)
        if (suppliedClaimId && node.claimId && suppliedClaimId !== node.claimId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM',
            `node "${nodeId}" is now claimed by ${node.claimId}; claim ${suppliedClaimId} is stale`)
        }
        if (text(taskId, 80) && node.taskId && text(taskId, 80) !== node.taskId) {
          throw graphError('OMC/GRAPH-STALE-CLAIM',
            `node "${nodeId}" is now running under task ${node.taskId}; task ${taskId} is stale`)
        }
        if (!['ready', 'failed', 'cancelled'].includes(to)) {
          throw graphError('OMC/GRAPH-INVALID', `release target "${to}" is not allowed (ready, failed, cancelled)`)
        }
        node.state = to
        node.note = text(reason, 300) || 'claim released before settlement'
        node.taskId = null
        node.childId = null
        node.claimId = null
        node.updatedAt = new Date().toISOString()
        releaseNodeLease(node, graph)
        graph.claims[node.id] = {
          ...(graph.claims[node.id] ?? {}),
          releasedAt: node.updatedAt,
          releaseReason: node.note,
          active: false,
        }
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
          node.claimId = null
          node.updatedAt = new Date().toISOString()
          releaseNodeLease(node, graph)
          graph.claims[node.id] = {
            ...claim,
            releasedAt: node.updatedAt,
            recoveredAt: node.updatedAt,
            releaseReason: 'recovery',
            active: false,
          }
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
        releaseNodeLease(node, graph)
        write(parentId, graph)
        return { node, status: statusFor(parentId, graph) }
      })
    },
    /** Attach the trusted acceptance authority (index wires this at apply time). */
    setAcceptance(authority) {
      acceptanceAuthority = authority ?? null
      return { acceptance: Boolean(acceptanceAuthority) }
    },
    /** Release every heartbeat this process owns (plugin unload / tests). */
    dispose() {
      for (const owner of [...activeLeases.keys()]) {
        releaseLease(owner, { reason: 'graph store disposed' })
      }
      leaseCache.clear()
      return { released: true }
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

