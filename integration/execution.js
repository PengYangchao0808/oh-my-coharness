/**
 * Role → execution backend resolver.
 *
 * Pure function: it receives the live provider list from the caller and never
 * guesses from OMC's static harness registry. A configured `omc:<harness>` that
 * is not actually registered is a blocked role with a structured reason, not a
 * silent fallback and not a native child with the wrong persona.
 *
 * Blocked roles are returned, not thrown, so a misconfigured external Oracle
 * cannot take the native Fixer/Designer/Council rows down with it. Structural
 * configuration errors (unknown backend, an external writer) still throw from
 * validateExecution().
 */

import { HARNESSES, harnessDef } from '../src/harnesses.js'
import {
  describeExecution,
  executionError,
  normalizeExecution,
  validateExecution,
} from './compatibility.js'

/** Conventional provider name for an external harness. */
export function executionProviderName(harness) {
  return `omc:${harness}`
}

/**
 * How strongly this CLI enforces read-only. Unknown harnesses are
 * `unsupported`: an unverified argv form must never be advertised as safe.
 * @param harness - harness id.
 */
export function harnessReadOnlyClass(harness) {
  return harnessDef(harness)?.readOnly ?? 'unsupported'
}

function nativeResult() {
  return {
    backend: 'native',
    provider: 'spawn',
    backgroundMode: 'continuable',
    external: false,
    readOnly: null,
    available: true,
    blocked: false,
  }
}

/**
 * Resolve one role's execution.
 *
 * @param roleId - roster id.
 * @param roleConfig - one merged role entry from the effective configuration.
 * @param availableProviders - exact names from `ctx.subagents.list()`.
 * @returns {{
 *   backend: 'native'|'omc', provider: string, backgroundMode: 'continuable'|'one-shot',
 *   external: boolean, harness?: string, readOnly?: string, available: boolean,
 *   blocked: boolean, code?: string, reason?: string, fallbackReason?: string,
 *   requested?: object,
 * }}
 */
export function resolveExecution(roleId, roleConfig, availableProviders = []) {
  const execution = validateExecution(roleId, roleConfig)
  if (execution.backend === 'native') return nativeResult()

  const harness = execution.harness
  const provider = executionProviderName(harness)
  const readOnly = harnessReadOnlyClass(harness)
  const registered = Array.isArray(availableProviders) && availableProviders.includes(provider)
  const requested = {
    backend: 'omc',
    harness,
    provider,
    readOnly,
    fallback: execution.fallback,
    allowAdvisory: execution.allowAdvisory,
  }

  /** Build a blocked external result, or fall back to native when configured. */
  const blocked = (code, reason) => {
    if (execution.fallback === 'native') {
      return {
        ...nativeResult(),
        fallbackReason: `${code}: ${reason}; fell back to native by role configuration`,
        requested,
      }
    }
    return {
      backend: 'omc',
      provider,
      backgroundMode: 'one-shot',
      external: true,
      harness,
      readOnly,
      available: false,
      blocked: true,
      code,
      reason,
      requested,
    }
  }

  if (harnessDef(harness) === undefined) {
    return blocked(
      'OMC/EXECUTION-UNKNOWN-HARNESS',
      `unknown harness "${harness}"; known harnesses: ${HARNESSES.map((def) => def.id).join(', ')}`,
    )
  }
  if (!registered) {
    return blocked(
      'OMC/EXECUTION-UNAVAILABLE',
      `provider "${provider}" is not registered (disabled harness, missing CLI, or a provider-registration failure); run /coharness doctor`,
    )
  }
  if (readOnly === 'unsupported') {
    return blocked(
      'OMC/EXECUTION-READONLY-UNSUPPORTED',
      `harness "${harness}" has no verified read-only invocation; read-only roles cannot use it`,
    )
  }
  if (readOnly !== 'enforced' && execution.allowAdvisory !== true) {
    return blocked(
      'OMC/EXECUTION-READONLY-ADVISORY',
      `harness "${harness}" only supports advisory read-only (the CLI may still write); set execution.allowAdvisory=true to accept that risk`,
    )
  }

  return {
    backend: 'omc',
    provider,
    backgroundMode: 'one-shot',
    external: true,
    harness,
    readOnly,
    available: true,
    blocked: false,
    fallbackReason: undefined,
    requested,
  }
}

/**
 * Assert that a resolved execution is runnable. Used only where a blocked role
 * has no safe stub path (the role tool's execute).
 * @param resolved - output of resolveExecution().
 */
export function assertRunnableExecution(resolved) {
  if (resolved?.blocked) throw executionError(resolved.code ?? 'OMC/EXECUTION-UNAVAILABLE', resolved.reason ?? 'execution backend unavailable')
  return resolved
}

export { normalizeExecution, validateExecution, describeExecution }
