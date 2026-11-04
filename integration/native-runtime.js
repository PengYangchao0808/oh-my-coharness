/**
 * Native runtime bridge (0.5.0-alpha.2 R01).
 *
 * The stores from WP02 know how to *record* an attempt; this module is what
 * connects them to a running host. One rule frames every decision here: the
 * bridge observes, it never invents.
 *
 * What it does
 *   1. Identity. A native child session is attached to the OMC work item that
 *      owns it, through the durable lineage the host itself persists
 *      (`session.header.parentSession`) plus explicit bindings OMC makes when
 *      it starts work. An OMC task therefore has a parent id, a task id, a
 *      graph node id, a role and a route —for the main agent and for nested
 *      children alike.
 *   2. Usage. Every `assistant/message` usage chunk and every usage-less
 *      `assistant/attempt` becomes one ledger entry, in the four buckets, route
 *      taken from the nearest `request/header` (the route the request actually
 *      ran on) —never from creation metadata.
 *   3. Settlement. A `turn/end` reason closes the attempt that was open:
 *      completed →completed, aborted →cancelled, blocked/error/max-tokens → *      failed, an unrecognised reason →unknown. Execution state never implies
 *      acceptance; the acceptance row stays untouched.
 *   4. Idempotency. Booking is keyed by (native, session, event seq), so a
 *      restart replay or a duplicate delivery re-appends the same key and the
 *      ledger says `duplicate: true`. Nothing is billed twice.
 *
 * What it deliberately does NOT do
 *   - It never reads or rewrites session files to control a running agent: the
 *     only inputs are host events (`session/event`, `agent/created`).
 *   - It never books a parent rollup as its own calls: `summary()` derives the
 *     total by reading entries. A child's request is booked once, under the
 *     child's task.
 *   - It never attaches a session nobody bound or that does not descend from a
 *     bound one. Another plugin's children and another parent's sessions stay
 *     untracked (`unboundSessions` counts them) instead of being adopted.
 *   - It never claims a fee it cannot see: a request with no usage number keeps
 *     the unknown coverage the ledger already renders.
 */

import { createHash } from 'node:crypto'
import { nativeSessionUsageEntries } from './usage-ledger.js'

export const NATIVE_RUNTIME_VERSION = 1
export const NATIVE_SOURCES = Object.freeze(['root', 'tool', 'managed', 'derived'])

/** Host `turn/end` reason kinds →OMC execution state. */
export const TURN_END_MAP = Object.freeze({
  completed: 'completed',
  aborted: 'cancelled',
  blocked: 'failed',
  error: 'failed',
  'max-tokens': 'failed',
})

const MAX_SESSIONS = 500
export const MAX_LINEAGE_DEPTH = 24

/**
 * How much a piece of lineage can be trusted.
 *
 *   host     the host persisted it: a session header's parentSession/origin/
 *            delegationDepth, or a binding OMC derived from that chain.
 *   legacy   a pre-0.6 record, or an explicit binding made before the host
 *            evidence was available; usable, but never presented as proven.
 *   unknown  somebody supplied an id (a tool argument, another plugin) and no
 *            host evidence backs it. Never accepted as host lineage.
 */
export const LINEAGE_SOURCES = Object.freeze(['host', 'legacy', 'unknown'])

function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function optionalText(value, max = 160) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed.slice(0, max)
}

/**
 * Normalize a lineage record. A bare source string is accepted; any unknown
 * source degrades to `unknown` (never silently to `host`).
 */
export function normalizeLineage(raw, { fallback = 'unknown', note = null } = {}) {
  const value = typeof raw === 'string' ? { source: raw } : (raw && typeof raw === 'object' ? raw : {})
  const source = LINEAGE_SOURCES.includes(value.source) ? value.source : fallback
  return {
    source,
    parentSessionId: optionalText(value.parentSessionId),
    rootSessionId: optionalText(value.rootSessionId),
    ...(optionalText(value.note) ?? note ? { note: optionalText(value.note) ?? note } : {}),
  }
}

/** A fresh lineage record from a source and host-observed ids. */
export function lineageRecord(source, { parentSessionId = null, rootSessionId = null, note = null } = {}) {
  return normalizeLineage({ source, parentSessionId, rootSessionId, ...(note ? { note } : {}) }, { fallback: 'unknown' })
}

/** Stable OMC task id for a native session: one task per physical session. */
export function nativeTaskIdFor(sessionId) {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  return `native:${digest}`
}

/**
 * Map one host `turn/end` reason to an execution verdict.
 * An unknown kind is `unknown`, never a hopeful `completed`.
 */
export function executionFromTurnEnd(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  const execution = TURN_END_MAP[kind] ?? 'unknown'
  return { execution, stopReason: kind ?? null }
}

/** The session a host session object names, tolerating a bare id. */
function sessionFacts(session) {
  if (typeof session === 'string') return { sessionId: session, parentSessionId: null, header: null }
  return {
    sessionId: session?.id ?? session?.session?.id ?? null,
    parentSessionId: session?.header?.parentSession ?? session?.session?.header?.parentSession ?? null,
    header: session?.header ?? session?.session?.header ?? null,
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./usage-ledger.js').createUsageLedger>} options.usageLedger
 * @param {ReturnType<import('./execution-events.js').createExecutionStore>} [options.executionStore]
 * @param {(event: object) => string|undefined} [options.roleFromDescriptor]
 *   the preset's `subagent/descriptor` label reader; kept injected so this
 *   module never depends on the vendored preset.
 * @param {string} [options.ownPreset]
 *   Agent-preset id this plugin owns. A *top-level* session created under that
 *   preset is that session's own OMC parent (`/coharness` tool call or not);
 *   any other unbound session stays untracked. Omitted = only explicit roots.
 * @param {(line: string) => void} [options.warn]
 */
export function createNativeRuntime({
  usageLedger,
  executionStore = null,
  roleFromDescriptor = null,
  ownPreset = null,
  warn = () => {},
  now = () => new Date().toISOString(),
  maxSessions = MAX_SESSIONS,
} = {}) {
  if (!usageLedger || typeof usageLedger.append !== 'function') {
    throw new Error('OMC/NATIVE-RUNTIME: usageLedger with append() is required')
  }

  /** @type {Map<string, any>} sessionId →binding */
  const bindings = new Map()
  /** @type {Map<string, any>} taskId →binding (the ledger rolls up by task) */
  const byTask = new Map()
  /** @type {Map<string, string>} childSessionId →parentSessionId (lineage the host persisted) */
  const lineage = new Map()
  /** @type {Map<string, any>} sessionId →per-session observation state */
  const sessions = new Map()
  const installed = new Set()
  const listeners = []
  const stats = {
    events: 0,
    booked: 0,
    duplicates: 0,
    settlements: 0,
    unboundSessions: 0,
    unboundEvents: 0,
    // Unbound *usage* events are the only unbound ones that cost real money;
    // the rest are setup noise that arrived before the agent was announced.
    unboundUsage: 0,
    bindConflicts: 0,
    autoRoots: 0,
    handlerErrors: 0,
    replayRuns: 0,
    lastEventAt: null,
  }

  function trim() {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    while (bindings.size > maxSessions * 2) {
      const oldest = bindings.keys().next().value
      const dropped = bindings.get(oldest)
      bindings.delete(oldest)
      if (dropped && byTask.get(dropped.taskId) === dropped) byTask.delete(dropped.taskId)
    }
  }

  function sessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { sessionId, lastHeader: null, role: null, turns: 0, events: 0, lastSeq: -1, unbound: false }
      sessions.set(sessionId, state)
      trim()
    }
    return state
  }

  function publicBinding(binding) {
    if (!binding) return null
    return {
      sessionId: binding.sessionId,
      taskId: binding.taskId,
      parentId: binding.parentId,
      parentTaskId: binding.parentTaskId ?? null,
      rootTaskId: binding.rootTaskId ?? binding.taskId,
      rootSessionId: binding.rootSessionId ?? binding.sessionId,
      depth: Number.isInteger(binding.depth) ? binding.depth : 0,
      nodeId: binding.nodeId ?? null,
      role: binding.role ?? null,
      route: binding.route ? { ...binding.route } : null,
      source: binding.source,
      lineage: binding.lineage ? { ...binding.lineage } : null,
      proven: binding.lineage?.source === 'host',
      boundAt: binding.boundAt,
    }
  }

  /**
   * Fill the identity of a binding from the lineage map and the ancestor that
   * was actually bound. Returns only facts that are derivable: every depth is a
   * counted hop, never a declared number.
   */
  function identityFromAncestor(sessionId, ancestor, hops, { immediateParentId = null, source = null } = {}) {
    return {
      parentId: ancestor.parentId,
      parentTaskId: immediateParentId ? nativeTaskIdFor(immediateParentId) : ancestor.taskId,
      rootTaskId: ancestor.rootTaskId ?? ancestor.taskId,
      rootSessionId: ancestor.rootSessionId ?? ancestor.sessionId,
      depth: (Number.isInteger(ancestor.depth) ? ancestor.depth : 0) + Math.max(1, hops),
      lineage: lineageRecord(source ?? ancestor.lineage?.source ?? 'host', {
        parentSessionId: immediateParentId ?? lineage.get(sessionId) ?? null,
        rootSessionId: ancestor.rootSessionId ?? ancestor.sessionId,
        note: 'derived from the host parentSession chain',
      }),
    }
  }

  /**
   * Bind one native session to an OMC work item.
   *
   * Re-binding the same session to the same parent is idempotent and only
   * merges new facts (node, role, route). Re-binding it to a *different* parent
   * is refused: silently moving a session would re-attribute work that has
   * already been booked.
   */
  function bind(record = {}) {
    const sessionId = text(record.sessionId) ? record.sessionId : null
    const parentId = text(record.parentId) ? record.parentId : null
    if (!sessionId) throw new Error('OMC/NATIVE-BIND: sessionId is required')
    if (!parentId) throw new Error('OMC/NATIVE-BIND: parentId is required')
    const existing = bindings.get(sessionId)
    if (existing && existing.parentId !== parentId) {
      stats.bindConflicts += 1
      throw new Error(
        `OMC/NATIVE-BIND-CONFLICT: session ${sessionId} is already bound to parent ${existing.parentId}`,
      )
    }
    const observedParent = lineage.get(sessionId) ?? null
    const declaredParent = optionalText(record.parentSessionId)
    if (declaredParent) lineage.set(sessionId, declaredParent)
    const parentSessionId = declaredParent ?? observedParent
    // Host trust requires a parentSession the host actually persisted; an
    // explicit binding argument alone is kept as legacy, never promoted.
    const hostObservedParent = Boolean(parentSessionId && observedParent === parentSessionId)
    const ancestor = parentSessionId ? bindings.get(parentSessionId) ?? null : null
    const declaredSource = LINEAGE_SOURCES.includes(record.lineage?.source) ? record.lineage.source : null
    const identitySource = record.source === 'root'
      ? 'host'
      : declaredSource && declaredSource !== 'host'
        ? declaredSource
        : hostObservedParent && ancestor?.lineage?.source === 'host'
          ? 'host'
          : declaredSource === 'legacy' || declaredSource === 'unknown' ? declaredSource : 'legacy'
    const resolvedTaskId = text(record.taskId) ? record.taskId : existing?.taskId ?? nativeTaskIdFor(sessionId)
    const derived = !existing && ancestor
      ? identityFromAncestor(sessionId, ancestor, 1, { immediateParentId: parentSessionId, source: identitySource })
      : null
    const binding = existing ?? {
      sessionId,
      parentId,
      taskId: resolvedTaskId,
      parentTaskId: optionalText(record.parentTaskId) ?? derived?.parentTaskId ?? null,
      rootTaskId: optionalText(record.rootTaskId) ?? derived?.rootTaskId ?? resolvedTaskId,
      rootSessionId: optionalText(record.rootSessionId) ?? derived?.rootSessionId ?? sessionId,
      depth: Number.isInteger(record.depth) && record.depth >= 0 ? record.depth : derived?.depth ?? 0,
      nodeId: record.nodeId ?? null,
      role: record.role ?? null,
      route: record.route ? { ...record.route } : null,
      source: NATIVE_SOURCES.includes(record.source) ? record.source : 'tool',
      lineage: normalizeLineage(record.lineage ?? derived?.lineage ?? { source: identitySource, parentSessionId, rootSessionId: sessionId }, {
        fallback: identitySource,
      }),
      ticketId: optionalText(record.ticketId),
      workstream: optionalText(record.workstream),
      boundAt: now(),
    }
    if (existing) {
      if (record.nodeId) binding.nodeId = record.nodeId
      if (record.role) binding.role = record.role
      if (record.parentTaskId) binding.parentTaskId = record.parentTaskId
      if (record.rootTaskId) binding.rootTaskId = record.rootTaskId
      if (record.rootSessionId) binding.rootSessionId = record.rootSessionId
      if (Number.isInteger(record.depth) && record.depth >= 0) binding.depth = record.depth
      if (record.ticketId) binding.ticketId = optionalText(record.ticketId)
      if (record.workstream) binding.workstream = optionalText(record.workstream)
      if (record.lineage) {
        const merged = normalizeLineage(record.lineage, { fallback: binding.lineage?.source ?? 'unknown' })
        // Never downgrade a host-proven binding through a later explicit record.
        if (binding.lineage?.source !== 'host' || merged.source === 'host') binding.lineage = merged
      }
      if (record.route) binding.route = { ...binding.route, ...record.route }
    }
    bindings.set(sessionId, binding)
    byTask.set(binding.taskId, binding)
    trim()
    return publicBinding(binding)
  }

  /** Bind the calling (root) session; `parentId` defaults to the session itself. */
  function bindRoot({ sessionId, parentId = null, taskId, role = 'orchestrator', route = null, nodeId = null } = {}) {
    const resolvedTaskId = text(taskId) ? taskId : nativeTaskIdFor(sessionId)
    return bind({
      sessionId,
      parentId: parentId ?? sessionId,
      taskId: resolvedTaskId,
      parentTaskId: null,
      rootTaskId: resolvedTaskId,
      rootSessionId: sessionId,
      depth: 0,
      ...(nodeId ? { nodeId } : {}),
      role,
      route,
      source: 'root',
      lineage: lineageRecord('host', {
        parentSessionId: null,
        rootSessionId: sessionId,
        note: 'host session has no parentSession: this is the root of its own lineage',
      }),
    })
  }

  function bindingFor(sessionId) {
    return publicBinding(bindings.get(sessionId) ?? null)
  }

  /**
   * Resolve a binding for a session that was not bound explicitly, by walking
   * the host's own parent chain up to a bound ancestor.
   *
   * Only an ancestor *someone already bound* can authorise a descendant: this
   * is what keeps the bridge from adopting another plugin's children.
   */
  function deriveBinding(sessionId) {
    const explicit = bindings.get(sessionId)
    if (explicit) return explicit
    let cursor = sessionId
    let hops = 0
    let ancestor = null
    let immediateParentId = null
    while (hops < MAX_LINEAGE_DEPTH) {
      const parent = lineage.get(cursor)
      if (!parent) break
      if (hops === 0) immediateParentId = parent
      ancestor = bindings.get(parent) ?? null
      cursor = parent
      hops += 1
      if (ancestor) break
    }
    if (!ancestor) return null
    const state = sessions.get(sessionId)
    const identity = identityFromAncestor(sessionId, ancestor, hops, { immediateParentId, source: 'host' })
    const binding = {
      sessionId,
      taskId: nativeTaskIdFor(sessionId),
      nodeId: null,
      role: state?.role ?? null,
      route: state?.lastHeader ?? null,
      source: 'derived',
      boundAt: now(),
      ...identity,
    }
    bindings.set(sessionId, binding)
    byTask.set(binding.taskId, binding)
    trim()
    return binding
  }

  /**
   * Resolve the calling session's identity for a tool call.
   *
   * A session with a host `parentSession` header is never promoted to a new
   * root: its binding is derived from the already-bound ancestor, so a child
   * agent's OMC calls land in its root's shard. Only a session the host says
   * has no parent may become a root.
   */
  function resolveCallingSession({ sessionId, header = null, agentId = null } = {}) {
    if (!text(sessionId)) return null
    const observedParent = optionalText(header?.parentSession)
    if (observedParent) lineage.set(sessionId, observedParent)
    const explicit = bindings.get(sessionId)
    if (explicit) return publicBinding(explicit)
    const parentSessionId = observedParent ?? lineage.get(sessionId) ?? null
    if (parentSessionId) {
      const derived = deriveBinding(sessionId)
      if (derived) return publicBinding(derived)
      return {
        sessionId,
        unresolved: true,
        proven: false,
        lineage: lineageRecord('unknown', {
          parentSessionId,
          note: 'the host header names a parent session, but no bound ancestor proves the root; lineage stays unknown until the host can supply it',
        }),
      }
    }
    // A session the host marks as a subagent is never its own root, even when
    // the parent id is unavailable. Fabricating a root here is the bug PR-01
    // exists to remove.
    const origin = optionalText(header?.origin)
    if (origin === 'subagent') {
      return {
        sessionId,
        unresolved: true,
        proven: false,
        lineage: lineageRecord('unknown', {
          note: 'the host marks this session as a subagent but exposes no parentSession; lineage stays unknown',
        }),
      }
    }
    if (text(agentId)) return bindRoot({ sessionId, parentId: agentId })
    return null
  }

  /**
   * The host-provable lineage for a session, or null. `trusted` is true only
   * when every hop of the chain came from the host's own persisted headers.
   */
  function trustedLineageFor(sessionId, { header = null } = {}) {
    if (!text(sessionId)) return null
    const observedParent = optionalText(header?.parentSession)
    if (observedParent) lineage.set(sessionId, observedParent)
    const binding = bindings.get(sessionId) ?? deriveBinding(sessionId)
    if (!binding) return null
    return { ...publicBinding(binding), trusted: binding.lineage?.source === 'host' }
  }

  /**
   * Identity for one task row started by this session: the caller's own task is
   * the parent task, and the root task/shard are inherited, never accepted from
   * a caller-supplied id.
   */
  function taskLineage({ sessionId, header = null, agentId = null } = {}) {
    const resolved = resolveCallingSession({ sessionId, header, agentId })
    if (!resolved) return null
    if (resolved.unresolved) {
      return {
        source: 'unknown',
        trusted: false,
        rootParentId: null,
        parentSessionId: resolved.lineage?.parentSessionId ?? null,
        rootSessionId: null,
        parentTaskId: null,
        rootTaskId: null,
        depth: null,
        lineage: resolved.lineage,
      }
    }
    const binding = resolved
    const source = binding.lineage?.source ?? 'unknown'
    return {
      source,
      trusted: source === 'host',
      rootParentId: binding.parentId,
      parentSessionId: binding.sessionId,
      rootSessionId: binding.rootSessionId ?? null,
      parentTaskId: binding.taskId,
      rootTaskId: binding.rootTaskId ?? binding.taskId,
      depth: (Number.isInteger(binding.depth) ? binding.depth : 0) + 1,
      lineage: binding.lineage ?? lineageRecord(source, {
        parentSessionId: binding.lineage?.parentSessionId ?? null,
        rootSessionId: binding.rootSessionId ?? null,
      }),
    }
  }

  function ensureAttempt(binding, route) {
    if (!executionStore) return null
    let view = null
    try {
      view = executionStore.read(binding.taskId)
    } catch {
      view = null
    }
    if (view && view.execution === 'running') return view
    return executionStore.open({
      taskId: binding.taskId,
      parentId: binding.parentId,
      backend: 'native',
      route: route ?? binding.route ?? null,
      reason: view ? 'native turn' : 'native session',
      intent: { backend: 'native', sessionId: binding.sessionId, route: route ?? binding.route ?? null },
    })
  }

  /** The first observed request/turn is the running phase, not a guess. */
  function markRunning(binding, route) {
    if (!executionStore) return
    let view = null
    try {
      view = executionStore.read(binding.taskId)
    } catch {
      return
    }
    if (!view?.currentAttemptId) return
    try {
      executionStore.running(binding.taskId, view.currentAttemptId, { route: route ?? null, by: 'native' })
    } catch {
      // Lifecycle bookkeeping must not break event ingestion.
    }
  }

  function settleAttempt(binding, reason) {
    if (!executionStore) return null
    const verdict = executionFromTurnEnd(reason)
    try {
      const view = executionStore.settle(binding.taskId, null, {
        execution: verdict.execution,
        stopReason: verdict.stopReason,
        by: 'native',
      })
      stats.settlements += 1
      return verdict
    } catch (error) {
      // A turn that ends before any attempt opened: record the attempt first so
      // the settlement is not lost (an empty-run session is still a real run).
      if (error?.code === 'OMC/TASK-UNKNOWN') {
        ensureAttempt(binding, binding.route)
        try {
          executionStore.settle(binding.taskId, null, {
            execution: verdict.execution,
            stopReason: verdict.stopReason,
            by: 'native',
          })
          stats.settlements += 1
          return verdict
        } catch (again) {
          warn(`native runtime: settlement failed for ${binding.taskId}: ${String(again?.message ?? again)}`)
          return null
        }
      }
      warn(`native runtime: settlement failed for ${binding.taskId}: ${String(error?.message ?? error)}`)
      return null
    }
  }

  function book(entry) {
    try {
      const result = usageLedger.append(entry)
      if (result?.stored) stats.booked += 1
      else if (result?.duplicate) stats.duplicates += 1
      return result
    } catch (error) {
      // A malformed entry must never take the host's event loop down; it is a
      // visible diagnostic instead of a silent zero.
      stats.handlerErrors += 1
      warn(`native runtime: ledger append failed: ${String(error?.message ?? error)}`)
      return null
    }
  }

  /**
   * Observe one durable session event. This is the single ingest point for the
   * live path (`session/event`) and the replay path (`ingest`).
   */
  function observe(session, event) {
    const facts = sessionFacts(session)
    const eventSessionId = facts.sessionId ?? event?.sessionId ?? null
    if (!eventSessionId || !event || typeof event.type !== 'string') {
      return { kind: 'ignored', reason: 'event lacks session identity' }
    }
    stats.events += 1
    stats.lastEventAt = now()
    if (facts.parentSessionId) lineage.set(eventSessionId, facts.parentSessionId)
    const state = sessionState(eventSessionId)
    state.events += 1
    if (Number.isFinite(event.seq) && event.seq > state.lastSeq) state.lastSeq = event.seq

    if (event.type === 'subagent/descriptor') {
      let role = null
      try {
        role = roleFromDescriptor ? roleFromDescriptor(event) : null
      } catch {
        role = null
      }
      if (text(role)) {
        state.role = role
        const binding = bindings.get(eventSessionId)
        if (binding && !binding.role) binding.role = role
      }
      return { kind: 'descriptor', role: state.role }
    }

    const binding = deriveBinding(eventSessionId)
    if (!binding) {
      // Not ours: an unbound root, or a child of a parent nobody bound.
      state.unbound = true
      stats.unboundEvents += 1
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') stats.unboundUsage += 1
      if (state.events === 1) stats.unboundSessions += 1
      return { kind: 'unbound' }
    }

    if (event.type === 'request/header') {
      const config = event.data?.header?.config ?? {}
      const route = {
        provider: config.provider ?? null,
        model: config.model ?? null,
        effort: config.reasoningEffort ?? null,
        observed: true,
      }
      state.lastHeader = route
      binding.route = route
      ensureAttempt(binding, route)
      markRunning(binding, route)
      return { kind: 'route', route: { ...route }, taskId: binding.taskId }
    }

    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      if (event.type === 'assistant/attempt') state.turns += 1
      ensureAttempt(binding, state.lastHeader)
      markRunning(binding, state.lastHeader)
      const attemptId = `${binding.taskId}#t${event.data?.turn ?? state.turns}`
      const entries = nativeSessionUsageEntries(
        [state.lastHeader ? { type: 'request/header', data: { header: { config: {
          provider: state.lastHeader.provider, model: state.lastHeader.model, reasoningEffort: state.lastHeader.effort,
        } } } } : {}, event],
        { parentId: binding.parentId, taskId: binding.taskId, attemptOf: () => attemptId },
      )
      const booked = []
      for (const entry of entries) {
        const source = { ...entry.source, sessionId: eventSessionId, seq: event.seq }
        if (!Number.isFinite(source.seq)) {
          // Without a durable event seq there is no idempotency key; the ledger
          // would key it on a placeholder and could collide. Refuse instead.
          stats.handlerErrors += 1
          warn(`native runtime: ${event.type} for ${eventSessionId} has no seq; not booked`)
          continue
        }
        const result = book({ ...entry, source, attemptId: entry.attemptId ?? attemptId })
        if (result) booked.push({ key: result.key, stored: result.stored, duplicate: result.duplicate })
      }
      return { kind: event.type, taskId: binding.taskId, booked }
    }

    if (event.type === 'turn/end') {
      const verdict = settleAttempt(binding, event.data?.reason)
      return { kind: 'turn/end', taskId: binding.taskId, verdict }
    }

    return { kind: 'observed', type: event.type, taskId: binding.taskId }
  }

  const onSessionEvent = (session, event) => {
    try {
      return observe(session, event)
    } catch (error) {
      stats.handlerErrors += 1
      warn(`native runtime: session/event handler failed: ${String(error?.message ?? error)}`)
      return { kind: 'error' }
    }
  }

  const onAgentCreated = (payload) => {
    try {
      const agent = payload?.agent ?? payload
      const sessionFactsValue = sessionFacts(agent?.session ?? null)
      const parentSessionId = sessionFactsValue.parentSessionId
        ?? (typeof agent?.session?.header?.parentSession === 'string' ? agent.session.header.parentSession : null)
      if (!sessionFactsValue.sessionId) return { kind: 'ignored' }
      if (parentSessionId) lineage.set(sessionFactsValue.sessionId, parentSessionId)
      // A top-level session created under the preset this plugin owns *is* an
      // OMC parent, whether or not it has called an OMC tool yet. That is what
      // keeps a plain conversation's usage from being unrecorded, without
      // adopting anybody else's session: another preset's root stays untracked.
      const presetId = sessionFactsValue.header?.agentPreset ?? agent?.session?.header?.agentPreset ?? null
      // A session the host says was spawned as a subagent can never be its own
      // root, even when the parent id is unavailable: an unknown parent is
      // reported, not replaced by a fabricated root.
      const origin = sessionFactsValue.header?.origin ?? agent?.session?.header?.origin ?? null
      if (!parentSessionId && origin === 'subagent') {
        return {
          kind: 'unbound',
          reason: 'host marks this session as a subagent but exposes no parentSession; lineage stays unknown',
        }
      }
      if (!parentSessionId && ownPreset && presetId === ownPreset) {
        const parentId = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : sessionFactsValue.sessionId
        const root = bindRoot({ sessionId: sessionFactsValue.sessionId, parentId })
        stats.autoRoots = (stats.autoRoots ?? 0) + 1
        return { kind: 'agent/created', binding: root, autoRoot: true }
      }
      const binding = deriveBinding(sessionFactsValue.sessionId)
      return binding ? { kind: 'agent/created', binding: publicBinding(binding) } : { kind: 'unbound' }
    } catch (error) {
      stats.handlerErrors += 1
      warn(`native runtime: agent/created handler failed: ${String(error?.message ?? error)}`)
      return { kind: 'error' }
    }
  }

  /**
   * Replay a session's durable events (restart backfill, a cold resume, or a
   * test fixture). Same keys as the live path, so a replay after a live run
   * books nothing new.
   */
  function ingest({ sessionId, parentSessionId = null, events = [] } = {}) {
    if (!text(sessionId)) throw new Error('OMC/NATIVE-INGEST: sessionId is required')
    if (parentSessionId) lineage.set(sessionId, parentSessionId)
    stats.replayRuns += 1
    const results = []
    for (const event of events) {
      results.push(observe({ id: sessionId, header: { parentSession: parentSessionId } }, event))
    }
    return results
  }

  /**
   * Derived rollup for one OMC parent: every task booked under it, the totals,
   * and the honesty flags. Never books anything itself.
   */
  function summary({ parentId } = {}) {
    const rows = usageLedger.entries({ parentId })
    const rollupByTask = new Map()
    for (const row of rows) {
      const record = rollupByTask.get(row.taskId) ?? {
        taskId: row.taskId,
        binding: publicBinding(byTask.get(row.taskId) ?? null),
        entries: 0,
        attempts: new Set(),
        buckets: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        unknownUsage: 0,
        unknownCost: 0,
        routes: new Set(),
      }
      record.entries += 1
      if (row.attemptId) record.attempts.add(row.attemptId)
      const known = Object.values(row.usage ?? {}).some((value) => value !== null)
      if (!known) record.unknownUsage += 1
      for (const [bucket, value] of Object.entries(row.usage ?? {})) {
        if (typeof value === 'number') record.buckets[bucket] += value
      }
      if (row.cost?.usd === undefined || row.cost === null) record.unknownCost += 1
      if (row.route?.provider || row.route?.model) {
        record.routes.add(`${row.route.provider ?? '?'}/${row.route.model ?? '?'}${row.route.effort ? `/${row.route.effort}` : ''}`)
      }
      rollupByTask.set(row.taskId, record)
    }
    const tasks = [...rollupByTask.values()].map((record) => ({
      taskId: record.taskId,
      binding: record.binding,
      entries: record.entries,
      attempts: record.attempts.size,
      buckets: record.buckets,
      unknownUsage: record.unknownUsage,
      unknownCost: record.unknownCost,
      routes: [...record.routes],
    }))
    return {
      parentId,
      derived: true,
      note: 'derived rollup: the parent total is the sum of its tasks and is never booked again as a parent call',
      entries: rows.length,
      tasks,
      totals: usageLedger.totals({ parentId }),
    }
  }

  /**
   * Attach to a host context. Idempotent per context: a second call returns the
   * same disposer instead of installing a second listener pair.
   */
  function install(ctx, { labels = {} } = {}) {
    if (!ctx || typeof ctx.on !== 'function') {
      throw new Error('OMC/NATIVE-RUNTIME: install needs a host ctx with on()')
    }
    if (installed.has(ctx)) {
      return { installed: false, alreadyInstalled: true, listeners: listeners.length }
    }
    const attach = (event, handler, label) => {
      const register = () => ctx.on(event, handler)
      const disposer = typeof ctx.effect === 'function' ? ctx.effect(register, label) : register()
      listeners.push({ event, label })
      return disposer
    }
    attach('session/event', onSessionEvent, labels.sessionEvent ?? 'omc: native runtime session/event')
    attach('agent/created', onAgentCreated, labels.agentCreated ?? 'omc: native runtime agent/created')
    installed.add(ctx)
    return { installed: true, alreadyInstalled: false, listeners: listeners.length }
  }

  function dispose() {
    installed.clear()
    listeners.length = 0
    bindings.clear()
    byTask.clear()
    lineage.clear()
    sessions.clear()
  }

  function diagnostics() {
    const roles = new Map()
    const parents = new Set()
    for (const binding of bindings.values()) {
      parents.add(binding.parentId)
      const role = binding.role ?? '(unknown role)'
      roles.set(role, (roles.get(role) ?? 0) + 1)
    }
    return {
      version: NATIVE_RUNTIME_VERSION,
      installed: installed.size > 0,
      listeners: listeners.map((entry) => ({ ...entry })),
      sessions: sessions.size,
      bindings: bindings.size,
      parents: [...parents],
      roles: Object.fromEntries(roles),
      stats: { ...stats },
      lastEventAt: stats.lastEventAt,
    }
  }

  return {
    version: NATIVE_RUNTIME_VERSION,
    bind,
    bindRoot,
    bindingFor,
    deriveBinding,
    resolveCallingSession,
    trustedLineageFor,
    lineageFor: trustedLineageFor,
    taskLineage,
    observe,
    ingest,
    summary,
    install,
    dispose,
    diagnostics,
    execStateFromTurnEnd: executionFromTurnEnd,
    stats: () => ({ ...stats }),
  }
}
