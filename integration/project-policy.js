/**
 * Project-level policy floor.
 *
 * A repository may tighten what its external dispatch is allowed to do, but it
 * may never widen the operator's authority. This is the same principle as the
 * OMP project settings: project files can disable a harness, lower concurrency,
 * shorten a deadline, force read-only mode or forbid direct fallback; they
 * cannot enable a harness, raise a limit, allow paid API billing or turn
 * routing on.
 *
 * The file is JSON at `<cwd>/.omc/project.json`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const PROJECT_FILE = '.omc/project.json'

export const MODE_RANK = Object.freeze({ 'read-only': 0, 'in-place': 1, 'worktree': 2 })

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function modeOf(value) {
  return Object.prototype.hasOwnProperty.call(MODE_RANK, value) ? value : undefined
}

/**
 * Read and normalize one project file. Invalid values are ignored with a
 * warning; a malformed file never silently becomes permissive.
 *
 * `usable` is false only when the file exists but could not be understood at
 * all (invalid JSON, not an object, unreadable). An existing-but-unusable
 * policy is NOT an empty policy: callers must refuse side-effect dispatch and
 * report the reason instead of treating the project as unconstrained.
 */
export function readProjectPolicy(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd)) {
    // A relative cwd is resolved by the transport against the session directory,
    // which this pure reader cannot know. Skip it rather than reading the Host's
    // own process directory and applying the wrong project policy.
    return { exists: false, path: null, policy: {}, warnings: [], usable: true }
  }
  const path = join(resolve(cwd), PROJECT_FILE)
  if (!existsSync(path)) return { exists: false, path, policy: {}, warnings: [], usable: true }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { exists: true, path, policy: {}, warnings: [`${PROJECT_FILE} is not valid JSON: ${error?.message ?? error}`], usable: false }
  }
  if (!isObject(raw)) return { exists: true, path, policy: {}, warnings: [`${PROJECT_FILE} must contain an object`], usable: false }

  const warnings = []
  const policy = {}

  if (isObject(raw.dispatch)) {
    const dispatch = {}
    const parallel = positiveInt(raw.dispatch.maxParallel)
    if (parallel !== undefined) dispatch.maxParallel = parallel
    const timeout = positiveInt(raw.dispatch.timeoutMs)
    if (timeout !== undefined) dispatch.timeoutMs = timeout
    const mode = modeOf(raw.dispatch.defaultMode)
    if (mode !== undefined) dispatch.defaultMode = mode
    if (raw.dispatch.allowDirectFallback === false) dispatch.allowDirectFallback = false
    else if (raw.dispatch.allowDirectFallback === true) warnings.push('allowDirectFallback:true is ignored; a project cannot enable it')
    policy.dispatch = dispatch
  }

  if (isObject(raw.harnesses)) {
    const harnesses = {}
    for (const [id, entry] of Object.entries(raw.harnesses)) {
      if (!isObject(entry)) continue
      if (entry.enabled === false) harnesses[id] = { enabled: false }
      else if (entry.enabled === true) warnings.push(`harnesses.${id}.enabled:true is ignored; a project cannot enable a harness`)
    }
    policy.harnesses = harnesses
  }

  if (isObject(raw.routing)) {
    const routing = {}
    if (raw.routing.enabled === false) routing.enabled = false
    else if (raw.routing.enabled === true) warnings.push('routing.enabled:true is ignored; a project cannot enable routing')
    if (raw.routing.allowPaidApi === false) routing.allowPaidApi = false
    else if (raw.routing.allowPaidApi === true) warnings.push('routing.allowPaidApi:true is ignored')
    if (raw.routing.allowUnknownBilling === false) routing.allowUnknownBilling = false
    else if (raw.routing.allowUnknownBilling === true) warnings.push('routing.allowUnknownBilling:true is ignored')
    policy.routing = routing
  }

  return { exists: true, path, policy, warnings, usable: true }
}

/**
 * Apply a project policy to a copy of the effective config. The result is always
 * equal to or stricter than the input.
 */
export function applyProjectPolicy(cfg, policy = {}) {
  const next = structuredClone(cfg)
  if (policy.dispatch) {
    if (Number.isSafeInteger(policy.dispatch.maxParallel)) {
      next.dispatch.maxParallel = Math.min(next.dispatch.maxParallel, policy.dispatch.maxParallel)
    }
    if (Number.isSafeInteger(policy.dispatch.timeoutMs)) {
      next.dispatch.timeoutMs = Math.min(next.dispatch.timeoutMs, policy.dispatch.timeoutMs)
    }
    if (policy.dispatch.defaultMode && MODE_RANK[policy.dispatch.defaultMode] < MODE_RANK[next.dispatch.defaultMode]) {
      next.dispatch.defaultMode = policy.dispatch.defaultMode
    }
    if (policy.dispatch.allowDirectFallback === false) next.dispatch.allowDirectFallback = false
  }
  for (const [id, entry] of Object.entries(policy.harnesses ?? {})) {
    if (entry.enabled === false && next.harnesses[id]) next.harnesses[id] = { ...next.harnesses[id], enabled: false }
  }
  if (policy.routing) {
    if (policy.routing.enabled === false) next.routing.enabled = false
    if (policy.routing.allowPaidApi === false) next.routing.allowPaidApi = false
    if (policy.routing.allowUnknownBilling === false) next.routing.allowUnknownBilling = false
  }
  return next
}

export function renderProjectPolicy(result) {
  if (!result.exists) return `project policy: none (${PROJECT_FILE} absent)`
  const lines = [`project policy: ${result.path}`]
  if (result.usable === false) {
    lines.push('  UNREADABLE: this project policy exists but cannot be understood; side-effect dispatch is refused until it is fixed or removed')
  }
  const policy = result.policy ?? {}
  if (Object.keys(policy.dispatch ?? {}).length) lines.push('  dispatch: ' + JSON.stringify(policy.dispatch))
  if (Object.keys(policy.harnesses ?? {}).length) lines.push('  harnesses: ' + JSON.stringify(policy.harnesses))
  if (Object.keys(policy.routing ?? {}).length) lines.push('  routing: ' + JSON.stringify(policy.routing))
  for (const warning of result.warnings ?? []) lines.push('  note: ' + warning)
  return lines.join('\n')
}
