/**
 * Advisory model/executor policy.
 *
 * v0.5 does not elect a model per call. It provides an explainable default
 * preference per role, then lets an explicit `role.execution` choice win. The
 * policy never mutates configuration and never invents a provider: a
 * recommendation that is not currently registered degrades to native.
 *
 * Keeping this module pure is deliberate. The settings card, status and tests
 * can all ask the same question without a host context or a CLI probe.
 */

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
    description: 'Native for orchestration and exploration; a strong external reviewer; frontend work on a frontend CLI.',
    roles: {
      oracle: { backend: 'omc', harness: 'codex', trigger: 'complex-only' },
      explorer: { backend: 'native' },
      designer: {
        backend: 'omc',
        harness: 'kimi',
        fallback: { backend: 'omc', harness: 'antigravity' },
      },
      fixer: { backend: 'native' },
    },
  },
  quality: {
    label: 'Quality',
    description: 'Spend external calls on review, exploration and frontend design; keep writes native.',
    roles: {
      oracle: { backend: 'omc', harness: 'codex' },
      explorer: { backend: 'omc', harness: 'codex' },
      designer: {
        backend: 'omc',
        harness: 'antigravity',
        fallback: { backend: 'omc', harness: 'kimi' },
      },
      fixer: { backend: 'native' },
    },
  },
})

export const POLICY_PRESET_IDS = Object.freeze(Object.keys(POLICY_PRESETS))

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function routeFor(entry) {
  if (!isObject(entry)) return null
  if (entry.backend === 'native') return { backend: 'native', harness: null }
  if (entry.backend === 'omc' && typeof entry.harness === 'string' && entry.harness.trim() !== '') {
    return { backend: 'omc', harness: entry.harness.trim().toLowerCase() }
  }
  return null
}

/** The effective preference chain for one role, user override first. */
export function preferenceChain(roleId, routing = {}) {
  const preset = POLICY_PRESETS[routing.preset] ?? POLICY_PRESETS.balanced
  const override = isObject(routing.roles?.[roleId]) ? routing.roles[roleId] : {}
  const preferred = override.preferred ?? preset.roles?.[roleId]
  const fallback = override.fallback ?? (isObject(preferred) ? preferred.fallback : undefined)
  return [routeFor(preferred), routeFor(fallback)].filter(Boolean)
}

/**
 * Recommend one executor for a role.
 *
 * @param {string} roleId
 * @param {object} routing - `cfg.routing`.
 * @param {string[]} availableProviders - exact names from `ctx.subagents.list()`.
 * @returns {null|{backend:'native'|'omc', harness:string|null, source:string, reason:string}}
 */
export function recommendRoute(roleId, routing = {}, availableProviders = []) {
  if (routing?.enabled !== true) return null
  const chain = preferenceChain(roleId, routing)
  if (chain.length === 0) {
    return { backend: 'native', harness: null, source: 'default', reason: 'no external preference for this role' }
  }
  for (const [index, route] of chain.entries()) {
    if (route.backend === 'native') {
      return {
        backend: 'native',
        harness: null,
        source: index === 0 ? 'preference' : 'fallback',
        reason: 'this preset keeps the role in DSH native execution',
      }
    }
    const provider = `omc:${route.harness}`
    if (availableProviders.includes(provider)) {
      return {
        backend: 'omc',
        harness: route.harness,
        source: index === 0 ? 'preference' : 'fallback',
        reason: `policy prefers ${provider} and the provider is registered`,
      }
    }
  }
  return {
    backend: 'native',
    harness: null,
    source: 'fallback',
    reason: 'none of the preferred external providers is registered; native is the only runnable route',
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
  return `routing: ${summary.preset} (${summary.label}) · ${summary.enabled ? 'advisory recommendations on' : 'advisory only, not applied'}`
}
