/**
 * Role ↔ execution-backend compatibility contract.
 *
 * Pure data and pure functions: this module is imported by the Host (doctor,
 * providers), the vendored preset (roles.js, config validation) and the tests.
 * It must never touch Cordis services, the filesystem, or a CLI.
 *
 * Two axes are deliberately separate:
 *   - the ROLE decides WHAT the work is (oracle, explorer, council seat …);
 *   - the BACKEND decides WHO executes it (DSH native child or an external CLI).
 *
 * A role's DSH model route (`provider`/`model`) therefore never doubles as an
 * execution backend. External execution uses `omc:<harness>`, which is a DSH
 * subagent provider, not an LLM provider.
 */

/** Execution backends supported by 0.4.0-alpha.1. */
export const BACKENDS = Object.freeze(['native', 'omc'])

/** What to do when a configured external backend cannot run. */
export const FALLBACKS = Object.freeze(['fail', 'native'])

/**
 * How strongly a CLI's read-only mode is actually enforced.
 *
 * - `enforced`: the CLI's own sandbox/approval flag refuses writes.
 * - `advisory`: the prompt says read-only, but the CLI keeps its default
 *   permission model and may still write.
 * - `unsupported`: the invocation shape is unverified; never expose it as a
 *   read-only role backend.
 */
export const READ_ONLY_CLASSES = Object.freeze(['enforced', 'advisory', 'unsupported'])

/**
 * What an external run of a role is allowed to do.
 *
 * Both modes leave the workspace untouched, so the external CLI stays read-only
 * either way:
 *   - `read-only`: inspect and report.
 *   - `patch`: inspect, design the change and return it as a unified diff. A
 *     native role applies that diff; the external CLI still never writes.
 */
export const EXTERNAL_MODES = Object.freeze(['read-only', 'patch'])

/** External roles that must return a patch instead of an implementation. */
export const PATCH_ONLY_ROLE_IDS = Object.freeze(['designer'])

/**
 * Roles that may execute on an external CLI in this release.
 *
 * Every external role is read-only toward the workspace. Oracle, Explorer and
 * the council seats report only; Designer may run external as a patch producer
 * only (`externalModeFor('designer') === 'patch'`), so a native Fixer still
 * lands every write. Fixer therefore keeps the DSH native write path until
 * external workspaces are isolated; Librarian keeps its native MCP tools;
 * Observer needs a vision-capable DSH route; the Council synthesizer must stay
 * native so that synthesis never depends on another CLI.
 */
export const EXTERNAL_ROLE_IDS = Object.freeze([
  'oracle',
  'explorer',
  'councillor-alpha',
  'councillor-beta',
  'councillor-gamma',
  'designer',
])

/** Roles that must stay on the DSH native backend in this release. */
export const NATIVE_ONLY_ROLE_IDS = Object.freeze([
  'fixer',
  'librarian',
  'observer',
  'council',
])

/** The roles this release knows about, in roster order. */
export const COMPATIBLE_ROLE_IDS = Object.freeze([
  'oracle',
  'designer',
  'fixer',
  'explorer',
  'librarian',
  'observer',
  'councillor-alpha',
  'councillor-beta',
  'councillor-gamma',
  'council',
])

/** Typed error helper shared by the preset and the Host. */
export function executionError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Normalize a raw `execution` block. Never throws; unknown values survive for validation. */
export function normalizeExecution(raw) {
  const value = isObject(raw) ? raw : {}
  return {
    backend: text(value.backend) ? value.backend.trim() : 'native',
    ...(text(value.harness) ? { harness: value.harness.trim().toLowerCase() } : {}),
    ...(text(value.fallback) ? { fallback: value.fallback.trim() } : {}),
    ...(value.allowAdvisory === true ? { allowAdvisory: true } : {}),
  }
}

/** Whether a role may be configured for external execution at all. */
export function canUseExternal(roleId) {
  return EXTERNAL_ROLE_IDS.includes(roleId)
}

/**
 * What an external run of this role may do. Native-only roles never reach an
 * external run, but they classify as `read-only` so callers never have to
 * branch on role ids themselves.
 * @param roleId - roster id.
 * @returns {'read-only'|'patch'}
 */
export function externalModeFor(roleId) {
  return PATCH_ONLY_ROLE_IDS.includes(roleId) ? 'patch' : 'read-only'
}

/**
 * Validate one role's execution block against the release contract.
 *
 * Structural errors throw: they describe a configuration no run can honour.
 * Environment errors (provider missing, advisory-only CLI) are NOT thrown here;
 * they are resolved per session by resolveExecution() and surfaced as a blocked
 * role plus a doctor row, so one broken role cannot take the whole preset down.
 *
 * @param roleId - roster id.
 * @param roleConfig - one merged role entry.
 * @returns the normalized execution block, carrying the resolved external mode.
 */
export function validateExecution(roleId, roleConfig) {
  const execution = normalizeExecution(roleConfig?.execution)
  if (!BACKENDS.includes(execution.backend)) {
    throw executionError(
      'OMC/EXECUTION-INVALID',
      `role "${roleId}" uses unknown execution backend "${execution.backend}"; use ${BACKENDS.join(' or ')}`,
    )
  }
  if (execution.backend === 'native') return { backend: 'native' }
  if (!canUseExternal(roleId)) {
    const why = roleId === 'council'
      ? 'the council synthesizer must stay native so synthesis never depends on another CLI'
      : 'this role keeps the DSH native path in 0.4.0-alpha.1'
    throw executionError('OMC/EXECUTION-ROLE-UNSUPPORTED', `role "${roleId}" cannot use an external backend: ${why}`)
  }
  if (!execution.harness) {
    throw executionError('OMC/EXECUTION-INVALID', `role "${roleId}" selects the omc backend without a harness id`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(execution.harness)) {
    throw executionError('OMC/EXECUTION-INVALID', `role "${roleId}" has an invalid harness id "${execution.harness}"`)
  }
  const fallback = execution.fallback ?? 'fail'
  if (!FALLBACKS.includes(fallback)) {
    throw executionError(
      'OMC/EXECUTION-INVALID',
      `role "${roleId}" has unknown fallback "${fallback}"; use ${FALLBACKS.join(' or ')}`,
    )
  }
  return {
    backend: 'omc',
    harness: execution.harness,
    fallback,
    allowAdvisory: execution.allowAdvisory === true,
    mode: externalModeFor(roleId),
  }
}

/**
 * Human-readable execution label for reports and the settings card.
 * @param execution - a normalized block, or a raw role config.
 */
export function describeExecution(execution) {
  const value = isObject(execution?.execution) ? execution.execution : execution
  const normalized = normalizeExecution(value)
  if (normalized.backend === 'native') return 'native'
  return `omc:${normalized.harness ?? '?'}`
}

/**
 * Whether a role is read-only by contract, using the role roster this module
 * knows. Kept here so both the Host and the preset classify the same way.
 *
 * Every external role is read-only toward the workspace, including the patch
 * producers: a `patch` role designs a diff instead of writing one, so it cannot
 * modify the tree either.
 */
export function isReadOnlyRole(roleId) {
  return EXTERNAL_ROLE_IDS.includes(roleId)
}
