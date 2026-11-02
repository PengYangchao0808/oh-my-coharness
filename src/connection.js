/**
 * The five-plus-one connection model.
 *
 * "Registered" is not "usable". A provider is registered as soon as an enabled
 * harness is mounted, but a route may still be dead: the binary can be absent,
 * the CLI signed out, the login impossible to verify non-interactively, the
 * read-only argv unfield-tested, or the endpoint billed in a way automatic
 * routing did not authorize. Automatic routing may only pick `routable`.
 *
 * Pure by construction: it reads a doctor report row (or nothing) and the
 * resolved configuration. It never probes a CLI, never touches the filesystem
 * and never starts a run.
 *
 * The states are ordered; a connection is exactly one of them:
 *   disabled → missing → installed → authenticated → verified → routable
 *
 * `auth: 'unknown'` is NOT authentication. It means "the login could not be
 * verified non-interactively"; only a recorded manual acceptance
 * (`harnesses.<id>.verify.accepted`) upgrades an unverifiable login.
 */

import { billingAuthorized } from '../integration/model-policy.js'

/** Every connection state, weakest first. */
export const CONNECTION_STATES = Object.freeze([
  'disabled',
  'missing',
  'installed',
  'authenticated',
  'verified',
  'routable',
])

/** Doctor auth verdicts. Anything else is treated as `unknown`. */
const AUTH_STATES = Object.freeze(['ok', 'signed-out', 'unknown', 'missing'])
const BILLINGS = Object.freeze(['subscription', 'api', 'unknown'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/** `authorization` is the cost verdict that automatic routing respects. */
function authorizationFor(billing, entry, routing) {
  const authorized = billingAuthorized({ authorizeBilling: entry.authorizeBilling === true }, billing, routing)
  if (billing === 'subscription') return 'subscription'
  if (!authorized) return 'blocked'
  return billing === 'api' ? 'api-authorized' : 'unknown-authorized'
}

/**
 * One harness connection.
 *
 * @param {{ id: string, def?: object, cfg?: object, auth?: string,
 *   verify?: object|null, routing?: object, billing?: string }} input
 *   `def` is the static harness definition (its `verified` flag means the argv
 *   was field-tested); `cfg` is the resolved configuration; `auth` is the
 *   doctor verdict for this harness, `unknown` when no probe ran.
 * @returns {{ id: string, state: string, installed: boolean,
 *   authenticated: boolean, verified: boolean, routable: boolean,
 *   auth: string, authorization: string, reason: string }}
 */
export function connectionFor({ id, def, cfg, auth, verify, routing, billing } = {}) {
  const entry = isObject(cfg?.harnesses?.[id]) ? cfg.harnesses[id] : {}
  const manual = isObject(verify) ? verify : isObject(entry.verify) ? entry.verify : null
  const manualAccepted = manual?.accepted === true
  const authState = AUTH_STATES.includes(auth) ? auth : 'unknown'
  const bin = text(def?.bin) || text(entry.command) || String(id ?? 'unknown')
  const effectiveBilling = BILLINGS.includes(billing)
    ? billing
    : BILLINGS.includes(entry.billing)
      ? entry.billing
      : BILLINGS.includes(def?.billing)
        ? def.billing
        : 'unknown'
  const effectiveRouting = isObject(routing) ? routing : isObject(cfg?.routing) ? cfg.routing : {}
  const authorization = authorizationFor(effectiveBilling, entry, effectiveRouting)

  const row = (state, reason, flags = {}) => ({
    id,
    state,
    installed: false,
    authenticated: false,
    verified: false,
    routable: false,
    ...flags,
    auth: authState,
    authorization,
    reason,
  })

  // `enabled !== true` is deliberate: an unresolved entry must never read as
  // enabled just because a key was missing.
  if (entry.enabled !== true) return row('disabled', 'disabled in config')

  // `missing` is the pre-state of installed: the binary itself is absent.
  if (authState === 'missing') return row('missing', `${bin} is not installed (binary missing)`)

  const installed = { installed: true }
  if (!(authState === 'ok' || manualAccepted)) {
    const reason = authState === 'signed-out'
      ? `signed-out: ${bin} is installed but has no usable login`
      : `auth unknown: the login could not be verified non-interactively; run ${bin} once or record harnesses.${id}.verify.accepted`
    return row('installed', reason, installed)
  }

  const manualNote = manualAccepted && authState !== 'ok' ? 'authenticated by manual verify' : `auth ${authState}`
  const authenticated = { ...installed, authenticated: true }
  // `def.verified` records a field-tested argv; a manual acceptance names the
  // mode it was validated in, so it upgrades the verification too.
  const verified = def?.verified === true || manualAccepted
  if (!verified) {
    return row(
      'authenticated',
      `${manualNote}; the invocation is not field-verified for read-only use`,
      authenticated,
    )
  }

  const verifiedFlags = { ...authenticated, verified: true }
  if (authorization === 'blocked') {
    return row(
      'verified',
      `${manualNote}; ${effectiveBilling} billing is not authorized for automatic routing`,
      verifiedFlags,
    )
  }

  return row(
    'routable',
    `${manualNote}; read-only invocation verified; ${effectiveBilling} billing authorized (${authorization})`,
    { ...verifiedFlags, routable: true },
  )
}

/** Accept a harness list as ids, defs, or a `{ id: def }` record. */
function harnessList(harnesses) {
  if (Array.isArray(harnesses)) {
    const out = []
    for (const entry of harnesses) {
      if (typeof entry === 'string' && entry.trim() !== '') out.push({ id: entry.trim(), def: undefined })
      else if (isObject(entry) && text(entry.id)) out.push({ id: text(entry.id), def: entry })
    }
    return out
  }
  if (isObject(harnesses)) {
    return Object.entries(harnesses)
      .filter(([id]) => text(id))
      .map(([id, def]) => ({ id: text(id), def: isObject(def) ? def : undefined }))
  }
  return []
}

/**
 * The whole table, keyed by harness id.
 *
 * @param {{ harnesses?: any, cfg?: object, rows?: any[], routing?: object }} input
 *   `rows` are doctor report rows; an empty list means every harness falls back
 *   to `auth: 'unknown'` unless a manual verify record says otherwise.
 * @returns {Record<string, ReturnType<typeof connectionFor>>}
 */
export function connectionTable({ harnesses = [], cfg = {}, rows = [], routing } = {}) {
  const reportRows = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isObject(row) && text(row.id)) reportRows.set(text(row.id), row)
  }
  const effectiveRouting = isObject(routing) ? routing : isObject(cfg?.routing) ? cfg.routing : {}

  const table = {}
  for (const { id, def } of harnessList(harnesses)) {
    const reportRow = reportRows.get(id)
    table[id] = connectionFor({
      id,
      def,
      cfg,
      auth: reportRow?.auth,
      routing: effectiveRouting,
    })
  }
  return table
}

/** Whether a route may be picked automatically: exactly `routable`. */
export function isRoutable(connection) {
  return connection?.routable === true && connection?.state === 'routable'
}
