/**
 * Native model fleet planning.
 *
 * OMC's native roles are only as useful as the DSH route they are pinned to.
 * This module turns the live DSH model catalog into a small, explainable
 * role → provider/model assignment. It is pure: the host reads the catalog,
 * this file decides, and the caller previews or applies the result.
 *
 * Design rules:
 *   - the orchestrator is never repinned; it keeps the session model;
 *   - every other role gets a distinct route when the catalog is large enough;
 *   - a role's existing enabled/tool/MCP settings are preserved;
 *   - reasons are evidence, not marketing: they name the tokens that matched.
 */

/** Roles a native fleet may pin. The orchestrator deliberately stays out. */
export const FLEET_ROLE_IDS = Object.freeze(['oracle', 'explorer', 'fixer', 'designer', 'librarian'])

/** Council seats are pinned only when they were enabled in the role config. */
export const COUNCIL_ROLE_IDS = Object.freeze(['councillor-alpha', 'councillor-beta', 'councillor-gamma'])

/**
 * Keyword profiles per role. Positive weights add, negative weights subtract;
 * the winning entry still reports only its positive matches, so a preview never
 * claims a negative token as a reason.
 */
const REASONING_PROFILE = {
  title: 'architecture, debugging and independent review',
  patterns: [
    [/(^|[^a-z0-9])(glm|k3|k2|opus|sonnet|gpt-5|o3|o4|r1)([^a-z0-9]|$)/, 6, 'strong reasoning family'],
    [/(pro|max|reason|think|ultra)/, 4, 'pro / reasoning tier'],
    [/(deepseek)/, 2, 'deepseek family'],
    [/(flash|mini|lite|fast|small|haiku|turbo)/, -6, 'small / fast tier'],
    [/(image|vision|tts|embed|whisper|audio)/, -8, 'not a chat model'],
  ],
}

const ROLE_PROFILES = Object.freeze({
  oracle: REASONING_PROFILE,
  'councillor-alpha': REASONING_PROFILE,
  'councillor-beta': REASONING_PROFILE,
  'councillor-gamma': REASONING_PROFILE,
  explorer: {
    title: 'fast repository reconnaissance',
    patterns: [
      [/(flash|fast|mini|lite|small|air|haiku|turbo|scout)/, 6, 'fast / small tier'],
      [/(deepseek|qwen|glm|kimi)/, 2, 'code-capable family'],
      [/(pro|max|opus|reason|think|ultra)/, -5, 'expensive reasoning tier'],
      [/(image|vision|tts|embed|whisper|audio)/, -8, 'not a chat model'],
    ],
  },
  fixer: {
    title: 'implementation inside the DSH sandbox',
    patterns: [
      [/(code|coder|coding)/, 5, 'coding-tuned'],
      [/(deepseek|sonnet|glm|kimi|qwen)/, 4, 'code-capable family'],
      [/(flash|pro|max)/, 2, 'capable chat tier'],
      [/(image|vision|tts|embed|whisper|audio)/, -8, 'not a chat model'],
    ],
  },
  designer: {
    title: 'UI/UX and frontend design',
    patterns: [
      [/(mimo|design|vision|image|gemini|ux|ui)/, 6, 'design / multi-modal family'],
      [/(pro|max)/, 3, 'capable tier'],
      [/(embed|tts|whisper|audio)/, -8, 'not a chat model'],
    ],
  },
  librarian: {
    title: 'tool-calling research and documentation',
    patterns: [
      [/(instruct|chat|tool)/, 4, 'tool / instruction tier'],
      [/(flash|fast|mini|pro)/, 2, 'usable chat tier'],
      [/(image|vision|tts|embed|whisper|audio)/, -8, 'not a chat model'],
    ],
  },
})

/** Stable display order inside one provider. */
function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Flatten the host's `{ provider, models[] }` rows into one catalog.
 *
 * Invalid rows are dropped rather than guessed at: a catalog entry that lacks a
 * provider or model id cannot become a DSH route.
 *
 * @param {Array<{provider?: string, models?: Array<{id?: string, name?: string}>}>} rows
 * @returns {Array<{provider: string, model: string, name: string, label: string, index: number}>}
 */
export function normalizeCatalog(rows) {
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const provider = text(row?.provider) ? row.provider.trim() : text(row?.id) ? row.id.trim() : ''
    if (provider === '') continue
    for (const model of Array.isArray(row?.models) ? row.models : []) {
      const id = text(model?.id) ? model.id.trim() : ''
      if (id === '') continue
      const key = provider + '/' + id
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        provider,
        model: id,
        name: text(model?.name) ? model.name.trim() : id,
        label: key,
        index: out.length,
      })
    }
  }
  return out
}

/** The searchable text for one catalog entry. The provider id is excluded on
 * purpose: a provider called "opencode-go" must not score as a coding model. */
function haystack(entry) {
  return (entry.model + ' ' + entry.name).toLowerCase()
}

/**
 * Score one model for one role.
 * @param {string} roleId
 * @param {{provider: string, model: string, name: string}} entry
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreModel(roleId, entry) {
  const profile = ROLE_PROFILES[roleId]
  if (!profile) return { score: 0, reasons: [] }
  const hay = haystack(entry)
  let score = 0
  const reasons = []
  for (const [pattern, weight, reason] of profile.patterns) {
    if (!pattern.test(hay)) continue
    score += weight
    if (weight > 0) reasons.push(reason)
  }
  return { score, reasons: [...new Set(reasons)] }
}

/** Normalize an explicit override map/array into `{roleId: {provider, model}}`. */
export function normalizeExplicit(explicit) {
  const out = {}
  if (Array.isArray(explicit)) {
    for (const row of explicit) {
      if (!row || !text(row.role) || !text(row.model)) continue
      out[row.role] = { provider: text(row.provider) ? row.provider : '', model: row.model }
    }
    return out
  }
  if (explicit && typeof explicit === 'object') {
    for (const [roleId, value] of Object.entries(explicit)) {
      if (!value || typeof value !== 'object') continue
      if (!text(value.model)) continue
      out[roleId] = { provider: text(value.provider) ? value.provider : '', model: value.model }
    }
  }
  return out
}

/** Resolve an explicit route against the catalog, or report it as unknown. */
export function resolveExplicit(catalog, route) {
  if (!text(route?.model)) return undefined
  const provider = text(route.provider) ? route.provider : ''
  const matches = catalog.filter((entry) =>
    entry.model === route.model && (provider === '' || entry.provider === provider))
  return matches[0]
}

/**
 * Build the fleet.
 *
 * @param {{
 *   catalog: Array<{provider: string, model: string, name: string, label: string}>,
 *   roles?: string[],
 *   explicit?: object|Array,
 *   existing?: object,
 *   now?: Date,
 * }} input
 * @returns {{at: string, catalog: object[], assignments: object[], warnings: string[], reusable: number}}
 */
export function planNativeFleet({
  catalog,
  roles = FLEET_ROLE_IDS,
  explicit,
  preferred,
  existing,
  now = new Date(),
} = {}) {
  const entries = Array.isArray(catalog) ? catalog : []
  const explicitRoutes = normalizeExplicit(explicit)
  // `preferred` is the fleet the user already configured in OMD-Slim. It is a
  // prior, not an override: an explicit `models` argument always wins.
  const preferredRoutes = normalizeExplicit(preferred)
  const warnings = []
  const used = new Set()
  const assignments = []

  if (entries.length === 0) {
    warnings.push(
      'no DSH model catalog was readable; native roles stay on the session model and ' +
      'external roles keep their current backend. Configure a provider under Settings → Models, ' +
      'or pass explicit models.',
    )
  }

  for (const roleId of roles) {
    const profile = ROLE_PROFILES[roleId]
    if (!profile) continue
    const explicitRoute = explicitRoutes[roleId]
    const preferredRoute = preferredRoutes[roleId]
    const route = explicitRoute ?? preferredRoute
    if (route) {
      const fromOmd = explicitRoute === undefined
      const match = resolveExplicit(entries, route)
      if (!match && (explicitRoute || entries.length > 0)) {
        warnings.push(
          `${fromOmd ? 'existing OMD-Slim' : 'explicit'} ${roleId} route ` +
          `${route.provider ? route.provider + '/' : ''}${route.model} ` +
          'is not in the live catalog; it is kept as written and may fail at spawn time.',
        )
      }
      const chosen = match ?? {
        provider: route.provider,
        model: route.model,
        name: route.model,
        label: (route.provider ? route.provider + '/' : '') + route.model,
      }
      assignments.push({
        roleId,
        provider: chosen.provider,
        model: chosen.model,
        label: chosen.label,
        name: chosen.name,
        reason: fromOmd ? 'existing OMD-Slim route' : 'explicit override',
        explicit: !fromOmd,
        preferred: fromOmd,
        available: match !== undefined,
      })
      if (match) used.add(chosen.label)
      continue
    }

    // A distinct route is the point of a multi-model fleet: try the unused set
    // first, and only fall back to a duplicate when every model is taken.
    const unused = entries.filter((entry) => !used.has(entry.label))
    const pool = unused.length > 0 ? unused : entries
    let best
    let bestScore = Number.NEGATIVE_INFINITY
    let bestReasons = []
    for (const entry of pool) {
      const scored = scoreModel(roleId, entry)
      if (scored.score > bestScore || (scored.score === bestScore && best && entry.index < best.index)) {
        best = entry
        bestScore = scored.score
        bestReasons = scored.reasons
      }
    }

    if (!best) {
      const external = existing?.[roleId]?.execution?.backend === 'omc'
      assignments.push({
        roleId,
        provider: '',
        model: '',
        label: '',
        name: '',
        reason: external
          ? 'no catalog entry; keeps the current external backend (not converted)'
          : 'no catalog entry; inherits the session model',
        explicit: false,
        available: false,
      })
      continue
    }

    used.add(best.label)
    assignments.push({
      roleId,
      provider: best.provider,
      model: best.model,
      label: best.label,
      name: best.name,
      reason: bestReasons.length > 0 ? bestReasons.join(', ') : 'fallback (no strong keyword match)',
      explicit: false,
      available: true,
    })
  }

  if (entries.length > 0 && entries.length < roles.length) {
    warnings.push(
      `the catalog has ${entries.length} model(s) for ${roles.length} roles; ` +
      'some roles share a model. Add another provider under Settings → Models for a fully distinct fleet.',
    )
  }

  const current = existing && typeof existing === 'object' ? existing : {}
  for (const assignment of assignments) {
    const row = current[assignment.roleId]
    if (row?.provider === assignment.provider && row?.model === assignment.model) {
      assignment.unchanged = true
    }
  }

  return {
    at: now.toISOString(),
    catalog: entries.map(({ provider, model, name, label }) => ({ provider, model, name, label })),
    assignments,
    warnings,
    reusable: entries.length,
  }
}

/**
 * The settings patch a fleet apply writes. Only the route and the native
 * backend are changed; tools, MCPs, persona text and enablement stay untouched.
 * @param {Array<object>} assignments
 * @returns {{roles: object}}
 */
export function fleetRolesPatch(assignments) {
  const roles = {}
  for (const row of Array.isArray(assignments) ? assignments : []) {
    if (!text(row?.roleId) || !text(row.provider) || !text(row.model)) continue
    roles[row.roleId] = {
      provider: row.provider,
      model: row.model,
      execution: { backend: 'native' },
    }
  }
  return { roles }
}

/** Human-readable fleet preview. */
export function renderFleetPlan(plan, { applied = false, backup } = {}) {
  const lines = []
  const models = plan?.catalog?.length ?? 0
  lines.push(`native fleet · ${plan?.assignments?.length ?? 0} role(s) · ${models} model(s) in the live DSH catalog`)
  if (models === 0) {
    lines.push('  (no catalog: no native route was assigned; external roles stay as configured)')
  }
  lines.push('  role               DSH route                          reason')
  for (const row of plan?.assignments ?? []) {
    const route = row.label || '(no route assigned)'
    const flags = []
    if (row.preferred) flags.push('from OMD-Slim')
    if (row.explicit) flags.push('explicit')
    if (row.available === false) flags.push('not in catalog')
    if (row.unchanged) flags.push('unchanged')
    lines.push(
      `  ${String(row.roleId).padEnd(18)}${route.padEnd(34)}${row.reason}` +
      (flags.length ? `  [${flags.join(' · ')}]` : ''),
    )
  }
  for (const warning of plan?.warnings ?? []) lines.push(`  note: ${warning}`)
  lines.push('')
  if (applied) {
    lines.push(`applied to the live DSH profile${backup ? ` · backup: ${backup}` : ''}.`)
    lines.push('New role delegations pick this up without a restart; already-running children keep their route.')
  } else {
    lines.push('Preview only. Run with apply:true (or `/coharness fleet --apply`) to write the routes.')
    lines.push('Only provider/model/execution are changed; per-role tools, MCPs and prompts are preserved.')
  }
  return lines.join('\n')
}
