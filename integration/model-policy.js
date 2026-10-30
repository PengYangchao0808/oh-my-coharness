/**
 * Explainable executor policy, including the cost/authorization guard.
 *
 * v0.5 does not elect a model per call. It provides a default preference per
 * role, then lets an explicit `role.execution` choice win. A recommendation is
 * only usable when:
 *   - the provider is registered;
 *   - the endpoint is billed by a subscription, or API/unknown billing was
 *     explicitly authorized for that route.
 *
 * The policy never mutates configuration. "Unknown" billing is not treated as
 * free: an automatic route must be able to explain who pays for it.
 */

import { harnessDef } from '../src/harnesses.js'

const DEFAULT_BILLING = Object.freeze({
  codex: 'subscription',
  claude: 'subscription',
  kimi: 'subscription',
  glm: 'subscription',
  gemini: 'subscription',
  antigravity: 'subscription',
  opencode: 'unknown',
  qwen: 'unknown',
})

export const POLICY_PRESETS = Object.freeze({
  economy: {
    label: 'Economy',
    description: 'Native for everything that can be done in-process; no external calls by default.',
    roles: {
      oracle: { backend: 'native' },
      explorer: { backend: 'native' },
      designer: { backend: 'native' },
      fixer: { backend: 'native' },
    },
  },
  balanced: {
    label: 'Balanced',
    description: 'Native orchestration; Codex for hard review and for patch-producing frontend design; writes stay native.',
    roles: {
      oracle: { backend: 'omc', harness: 'codex', trigger: 'complex-only' },
      explorer: { backend: 'native' },
      designer: { backend: 'omc', harness: 'codex' },
      fixer: { backend: 'native' },
    },
  },
  quality: {
    label: 'Quality',
    description: 'External Codex for review/exploration and patch design; Native Fixer keeps the write path.',
    roles: {
      oracle: { backend: 'omc', harness: 'codex' },
      explorer: { backend: 'omc', harness: 'codex' },
      designer: { backend: 'omc', harness: 'codex', fallback: { backend: 'omc', harness: 'antigravity' } },
      fixer: { backend: 'native' },
    },
  },
})

export const POLICY_PRESET_IDS = Object.freeze(Object.keys(POLICY_PRESETS))

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value, max = 120) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''
}

function routeFor(entry, inheritedAuthorization = false) {
  if (!isObject(entry)) return null
  const authorizeBilling = entry.authorizeBilling === true || inheritedAuthorization === true
  if (entry.backend === 'native') {
    return { backend: 'native', harness: null, model: null, billing: null, authorizeBilling }
  }
  if (entry.backend === 'omc' && text(entry.harness)) {
    return {
      backend: 'omc',
      harness: text(entry.harness).toLowerCase(),
      model: text(entry.model),
      billing: ['subscription', 'api', 'unknown'].includes(entry.billing) ? entry.billing : null,
      authorizeBilling,
    }
  }
  return null
}

/** The effective preference chain for one role, user override first. */
export function preferenceChain(roleId, routing = {}) {
  const preset = POLICY_PRESETS[routing.preset] ?? POLICY_PRESETS.balanced
  const override = isObject(routing.roles?.[roleId]) ? routing.roles[roleId] : {}
  const preferred = override.preferred ?? preset.roles?.[roleId]
  const fallback = override.fallback ?? (isObject(preferred) ? preferred.fallback : undefined)
  const inheritedAuthorization = override.authorizeBilling === true
  return [routeFor(preferred, inheritedAuthorization), routeFor(fallback, inheritedAuthorization)].filter(Boolean)
}

function billingFor(route, routing, options) {
  const configured = options.billing?.[route.harness] ?? routing.billing?.[route.harness]
  if (['subscription', 'api', 'unknown'].includes(configured)) return configured
  if (route.billing) return route.billing
  return DEFAULT_BILLING[route.harness] ?? harnessDef(route.harness)?.billing ?? 'unknown'
}

function billingAuthorized(route, billing, routing) {
  if (billing === 'subscription') return true
  if (route.authorizeBilling === true) return true
  if (billing === 'api') return routing.allowPaidApi === true
  return routing.allowUnknownBilling === true
}

/**
 * Recommend one executor for a role.
 *
 * @param {string} roleId
 * @param {object} routing - `cfg.routing`.
 * @param {string[]} availableProviders - exact names from `ctx.subagents.list()`.
 * @param {{ billing?: Record<string,string> }} [options]
 * @returns {null|{backend:'native'|'omc', harness:string|null, model:string|null,
 *   source:string, reason:string, billing:string|null, authorized:boolean,
 *   blocked?: Array<{harness:string,billing:string,reason:string}>}}
 */
export function recommendRoute(roleId, routing = {}, availableProviders = [], options = {}) {
  if (routing?.enabled !== true) return null
  const chain = preferenceChain(roleId, routing)
  if (chain.length === 0) {
    return {
      backend: 'native',
      harness: null,
      model: null,
      source: 'default',
      reason: 'no external preference for this role',
      billing: null,
      authorized: true,
    }
  }

  const blocked = []
  for (const [index, route] of chain.entries()) {
    if (route.backend === 'native') {
      return {
        backend: 'native',
        harness: null,
        model: null,
        source: index === 0 ? 'preference' : 'fallback',
        reason: 'this preset keeps the role in DSH native execution',
        billing: null,
        authorized: true,
        ...(blocked.length ? { blocked } : {}),
      }
    }

    const provider = `omc:${route.harness}`
    const billing = billingFor(route, routing, options)
    if (!availableProviders.includes(provider)) {
      blocked.push({ harness: route.harness, billing, reason: 'provider is not registered' })
      continue
    }
    if (!billingAuthorized(route, billing, routing)) {
      blocked.push({
        harness: route.harness,
        billing,
        reason: `${billing} billing is not authorized for automatic routing`,
      })
      continue
    }
    return {
      backend: 'omc',
      harness: route.harness,
      model: route.model || null,
      source: index === 0 ? 'preference' : 'fallback',
      reason: `policy prefers ${provider} (${billing}) and the route is authorized`,
      billing,
      authorized: true,
      ...(blocked.length ? { blocked } : {}),
    }
  }

  return {
    backend: 'native',
    harness: null,
    model: null,
    source: 'fallback',
    reason: blocked.length
      ? `no authorized external route; native is the safe fallback (${blocked.map((row) => `${row.harness}: ${row.reason}`).join('; ')})`
      : 'none of the preferred external providers is registered; native is the only runnable route',
    billing: null,
    authorized: true,
    ...(blocked.length ? { blocked } : {}),
  }
}

/** Compact policy state for status and diagnostics. */
export function policySummary(routing = {}) {
  const preset = POLICY_PRESETS[routing.preset] ?? POLICY_PRESETS.balanced
  return {
    enabled: routing?.enabled === true,
    preset: POLICY_PRESETS[routing.preset] ? routing.preset : 'balanced',
    label: preset.label,
    description: preset.description,
    allowPaidApi: routing?.allowPaidApi === true,
    allowUnknownBilling: routing?.allowUnknownBilling === true,
    limits: {
      maxParallelExternal: routing?.limits?.maxParallelExternal ?? 3,
      maxOracleCallsPerTask: routing?.limits?.maxOracleCallsPerTask ?? 1,
      maxReviewRounds: routing?.limits?.maxReviewRounds ?? 1,
    },
  }
}

/** One-line status rendering; detailed recommendations stay structured. */
export function renderPolicy(routing = {}) {
  const summary = policySummary(routing)
  return `routing: ${summary.preset} (${summary.label}) · ${summary.enabled ? 'advisory recommendations on' : 'advisory only, not applied'} · api ${summary.allowPaidApi ? 'allowed' : 'blocked'} · unknown ${summary.allowUnknownBilling ? 'allowed' : 'blocked'}`
}
