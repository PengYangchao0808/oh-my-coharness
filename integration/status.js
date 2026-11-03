/**
 * Execution status snapshot for `coharness doctor`, `/coharness status`, the
 * settings-card RPC and the acceptance tests.
 *
 * Read-only by construction: it reads the merged role configuration, the live
 * provider list and the static harness table. It never probes a CLI, never
 * starts a run and never returns secrets.
 */

import { HARNESSES } from '../src/harnesses.js'
import { resolveConfig } from '../src/config.js'
import { connectionTable } from '../src/connection.js'
import { describeExecution, EXTERNAL_ROLE_IDS } from './compatibility.js'
import { harnessReadOnlyClass, resolveExecution } from './execution.js'
import { createSessionRegistry } from './sessions.js'
import { policySummary, recommendRoute } from './model-policy.js'
import { catalogIndex, listProviderRoutes, readModelCatalog } from './catalog.js'

/** The single public preset id of the merged bundle. */
export const PRESET_ID = 'oh-my-coharness'

/** Resolve the bundled role configuration without throwing at the caller. */
export async function readRoleConfiguration(ctx) {
  try {
    const { loadConfig } = await import('../vendor/omd/npm-package/preset/config.js')
    return { ok: true, config: loadConfig(ctx) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** The live provider names, or an empty list when the service is unavailable. */
export function liveProviders(ctx) {
  try {
    return ctx.get?.('subagents')?.list?.() ?? []
  } catch {
    return []
  }
}

/**
 * One row per role, plus harness availability and the connection table.
 * @param ctx - any context that can reach `subagents` and the settings service.
 * @param rowConfig - the Host row config, so default-disabled harnesses report
 *   their real enabled state instead of "available".
 * @param options - `{ registry, report, connections }`: `registry` lets the Host
 *   reuse its live registry; `report` is a doctor report whose `rows` carry the
 *   auth verdicts; `connections` overrides the derived table. Without a report
 *   every harness degrades to `auth: 'unknown'`, which is never authenticated.
 * @returns a JSON-serializable status object.
 */
export async function buildExecutionStatus(ctx, rowConfig = {}, options = {}) {
  const cfg = resolveConfig(rowConfig)
  const registry = options.registry ?? createSessionRegistry(cfg.sessions)
  const providers = liveProviders(ctx)
  const loaded = await readRoleConfiguration(ctx)
  const catalog = await readModelCatalog(ctx).catch(() => [])
  const models = catalogIndex(catalog)
  // `subagents.list()` names subagent providers, not LLM routes. Native role
  // availability is a question about the LLM catalog, so check it separately.
  const nativeProviders = new Set(listProviderRoutes(ctx).map((row) => row.id))
  const billing = Object.fromEntries(
    HARNESSES.map((def) => [def.id, cfg.harnesses[def.id]?.billing ?? def.billing ?? 'unknown']),
  )
  const report = options.report ?? null
  const connections = options.connections ?? connectionTable({
    harnesses: HARNESSES,
    cfg,
    rows: report?.rows ?? [],
  })
  const roles = []
  // The observed request routes recorded by the preset's agent/request
  // listener (configured vs actual, so a stale creation description cannot be
  // mistaken for the route a child really runs on). Absent when the preset
  // plugin has not served any request in this process yet.
  let actualRoutes = {}
  try {
    let reader = null
    try { ({ readActualRoutes: reader } = await import('../vendor/omd/npm-package/preset/subagent-roles.js')) } catch { reader = null }
    actualRoutes = reader ? reader() : {}
  } catch {
    actualRoutes = {}
  }
  if (loaded.ok) {
    for (const [roleId, roleConfig] of Object.entries(loaded.config.roles)) {
      let resolved
      try {
        resolved = resolveExecution(roleId, roleConfig, providers, {
          routing: cfg.routing,
          billing,
          connections,
        })
      } catch (error) {
        roles.push({
          roleId,
          enabled: roleConfig.enabled !== false,
          execution: describeExecution(roleConfig),
          backend: roleConfig?.execution?.backend ?? 'native',
          blocked: true,
          code: error?.code ?? 'OMC/EXECUTION-INVALID',
          reason: String(error?.message ?? error),
          connection: null,
        })
        continue
      }
      const nativeProvider = typeof roleConfig.provider === 'string' ? roleConfig.provider.trim() : ''
      const nativeModel = typeof roleConfig.model === 'string' ? roleConfig.model.trim() : ''
      const nativeLabel = nativeProvider !== '' && nativeModel !== '' ? nativeProvider + '/' + nativeModel : ''
      const modelAvailable = nativeLabel !== '' && catalog.length > 0 ? models.has(nativeLabel) : undefined
      roles.push({
        roleId,
        enabled: roleConfig.enabled !== false,
        execution: resolved.external
          ? `omc:${resolved.harness}`
          : nativeLabel !== '' ? `native · ${nativeLabel}` : 'native · inherit session model',
        backend: resolved.backend,
        harness: resolved.harness,
        provider: resolved.external ? resolved.provider : nativeProvider,
        providerAvailable: resolved.external
          ? providers.includes(resolved.provider)
          : nativeProvider !== ''
            ? nativeProviders.size === 0 ? undefined : nativeProviders.has(nativeProvider)
            : true,
        // Native rows carry the DSH LLM route; external rows carry the CLI route
        // above and leave this empty.
        model: resolved.external ? '' : nativeModel,
        modelAvailable,
        readOnly: resolved.readOnly,
        // What an external run of this role may do; native rows have no mode.
        mode: resolved.mode,
        blocked: resolved.blocked === true,
        code: resolved.code,
        reason: resolved.reason,
        fallbackReason: resolved.fallbackReason,
        policy: resolved.policy,
        // The observed route of this role's latest request, when the preset
        // has served one in this process. Separate from the configured route
        // above on purpose: a reroute must stay visible.
        ...(actualRoutes[roleId] ? { actualRoute: actualRoutes[roleId] } : {}),
        // The connection an external row actually depends on; native rows have
        // no external target, so there is nothing to check.
        connection: resolved.external ? connections[resolved.harness] ?? null : null,
        externalCapable: EXTERNAL_ROLE_IDS.includes(roleId),
      })
    }
  }

  const policy = policySummary(cfg.routing)
  policy.recommendations = Object.fromEntries(
    roles.map((row) => [row.roleId, recommendRoute(row.roleId, cfg.routing, providers, { billing, connections })]),
  )

  return {
    presetId: PRESET_ID,
    source: loaded.ok ? loaded.config.source : undefined,
    configError: loaded.ok ? undefined : loaded.error,
    providers,
    roles,
    // Observed per-role request routes, keyed by role id plus 'orchestrator'.
    actualRoutes,
    sessions: registry.stats(),
    routing: policy,
    connections,
    // Honesty about provenance: without a probe pass these are conservative
    // guesses (`auth: unknown`), not facts.
    connectionSource: report ? 'doctor' : 'unknown',
    connectionAt: report?.at,
    harnesses: HARNESSES.map((def) => {
      const connection = connections[def.id] ?? null
      return {
        id: def.id,
        label: def.label,
        bin: def.bin,
        enabled: cfg.harnesses[def.id]?.enabled !== false,
        // Empty string, never undefined: the settings card renders this field
        // directly and a missing key would read as a lost setting.
        model: cfg.harnesses[def.id]?.model ?? '',
        readOnly: harnessReadOnlyClass(def.id),
        adapter: cfg.harnesses[def.id]?.adapter ?? 'cli',
        billing: cfg.harnesses[def.id]?.billing ?? def.billing ?? 'unknown',
        provider: `omc:${def.id}`,
        providerAvailable: providers.includes(`omc:${def.id}`),
        verified: def.verified === true,
        // Registration is not usability: the connection state says whether an
        // automatic route may pick this harness at all.
        state: connection?.state ?? (cfg.harnesses[def.id]?.enabled === false ? 'disabled' : 'installed'),
        reason: connection?.reason ?? 'connection unknown (run /coharness doctor)',
        routable: connection?.routable === true,
        authenticated: connection?.authenticated === true,
        authorization: connection?.authorization ?? 'blocked',
        auth: connection?.auth ?? 'unknown',
        // Session support is a fact of the adapter, separate from argv verification.
        session: def.session
          ? { format: def.session.format, confidence: def.session.confidence }
          : null,
      }
    }),
  }
}

/**
 * Report the previous OMD preset / plugin when it is still mounted.
 * Best effort: an empty answer means "not visible from this context", never a
 * claim that uninstalling is safe.
 */
export async function detectLegacyCompanion(ctx) {
  const presets = ctx.get?.('agentPresets')
  let presetIds = []
  try {
    presetIds = ((await presets?.list?.()) ?? []).map((row) => row.id)
  } catch {
    presetIds = []
  }
  const tools = ctx.get?.('tools')
  const tool = (name) => Boolean(tools?.get?.(name))
  return {
    presetIds,
    legacyPreset: presetIds.includes('oh-my-dsh-slim'),
    ourPreset: presetIds.includes('oh-my-coharness'),
    legacyRoleTools: ['subagent_oracle', 'subagent_fixer', 'subagent_councillor_alpha'].filter(tool),
  }
}

/** One harness's connection verdict, for the read-only class table. */
function connectionLabel(row) {
  const state = typeof row.state === 'string' ? row.state : 'unknown'
  const auth = typeof row.auth === 'string' ? row.auth : 'unknown'
  const authorization = typeof row.authorization === 'string' ? row.authorization : 'blocked'
  if (state === 'routable') return `routable (${authorization})`
  if (state === 'installed') return `${auth === 'ok' ? state : auth} · not routable`
  if (state === 'verified') {
    return authorization === 'blocked' ? 'verified · billing blocked · not routable' : 'verified · not routable'
  }
  return `${state} · not routable`
}

/** Render the role/execution block used by the doctor report. */
export function renderExecutionStatus(status, { legacy } = {}) {
  const lines = []
  lines.push(`preset: ${status.presetId ?? '(not mounted)'}${status.source ? ` · source: ${status.source}` : ''}`)
  lines.push(`role execution (providers: ${status.providers.length ? status.providers.join(', ') : 'none'}):`)
  for (const row of status.roles) {
    const flags = []
    if (row.blocked) flags.push(`${row.code}: ${row.reason}`)
    if (row.fallbackReason) flags.push(row.fallbackReason)
    if (row.readOnly) flags.push(`read-only ${row.readOnly}`)
    // A patch producer is read-only toward the tree but returns a diff a native
    // implementer applies; the flag keeps that distinction visible in doctor.
    if (row.mode === 'patch') flags.push('patch producer')
    if (row.providerAvailable === false) {
      flags.push(row.backend === 'native' ? 'model provider not registered' : 'provider unavailable')
    }
    // A pinned native model that is not in the live catalog is a configuration
    // error, not a runtime surprise; say it in the status line.
    if (row.backend === 'native' && row.model && row.modelAvailable === false) {
      flags.push('model not in the DSH catalog')
    }
    // Registered is not usable: an external row says so when its connection is
    // not routable, and a native row explains the automatic route it refused.
    if (row.connection && row.connection.routable !== true) {
      flags.push(`connection ${row.connection.state ?? 'unknown'} · not routable`)
    }
    if (row.backend === 'native' && Array.isArray(row.policy?.blocked) && row.policy.blocked.length) {
      flags.push(`auto-route refused: ${row.policy.blocked.map((entry) => entry.reason).join('; ')}`)
    }
    lines.push(
      `  ${row.roleId.padEnd(18)}${String(row.enabled === false ? 'off' : 'on').padEnd(4)}` +
        `${(row.backend ?? 'native').padEnd(7)}${(row.execution ?? 'native').padEnd(20)}` +
        (flags.length ? ` (${flags.join('; ')})` : ''),
    )
  }
  if (status.configError) lines.push(`  configuration error: ${status.configError}`)
  if (status.sessions) {
    const sessions = status.sessions
    const states = sessions.states ?? {}
    lines.push(
      `session reuse: ${sessions.enabled === false ? 'off' : 'on'} · policy ${sessions.resumePolicy ?? 'auto'} · ` +
        `${sessions.entries ?? 0} refs · ${sessions.lanes ?? 0} lane(s) · ${sessions.resumable ?? 0} resumable · ` +
        `idle ${states.idle ?? 0} / running ${states.running ?? 0} / failed ${states.failed ?? 0}`,
    )
    if (sessions.usage) {
      const usage = sessions.usage
      lines.push(
        `  usage: in ${usage.inputTokens ?? 0} · out ${usage.outputTokens ?? 0}` +
        (usage.costKnown ? ` · cost $${Number(usage.costUsd ?? 0).toFixed(4)}` : ' · cost unknown'),
      )
    }
    if (sessions.loadError) lines.push(`  session registry unreadable: ${sessions.loadError}`)
  }
  if (status.routing) {
    lines.push(
      `routing: ${status.routing.preset} (${status.routing.label}) · ` +
        `${status.routing.enabled ? 'advisory recommendations on' : 'advisory only, not applied'} · ` +
        `api ${status.routing.allowPaidApi ? 'allowed' : 'blocked'} · ` +
        `unknown ${status.routing.allowUnknownBilling ? 'allowed' : 'blocked'}`,
    )
    if (status.routing.enabled) {
      const connections = status.connections
      const recommended = Object.entries(status.routing.recommendations ?? {})
        .filter(([, route]) => route?.backend === 'omc')
        // A recommendation is a claim that the route is usable, so a
        // non-routable connection must never be printed as one.
        .filter(([, route]) => (connections ? connections[route.harness]?.routable === true : true))
        .map(([role, route]) => `${role}→omc:${route.harness}${route.billing ? ` (${route.billing})` : ''}`)
      if (recommended.length) lines.push(`  recommended: ${recommended.join(' · ')}`)
    }
  }
  lines.push(
    status.connectionSource === 'doctor'
      ? `connection: from doctor report${status.connectionAt ? ` at ${status.connectionAt}` : ''}`
      : 'connection: unknown (run /coharness doctor)',
  )
  lines.push('harness read-only class:')
  for (const row of status.harnesses) {
    const resume = row.session
      ? ` · resume ${row.session.confidence}`
      : ''
    // Without a connection state (older payloads) keep the pre-connection text
    // exactly, so nothing silently loses the registration fact.
    const connection = typeof row.state === 'string'
      ? `${connectionLabel(row)}${row.providerAvailable ? '' : ' · provider not registered'}`
      : `${row.providerAvailable ? 'provider registered' : 'provider missing'}${row.verified ? '' : ' · argv unverified'}`
    lines.push(
      `  ${row.id.padEnd(12)}${(row.enabled ? 'on' : 'off').padEnd(4)}${row.readOnly.padEnd(12)}` +
        `${connection}${resume}`,
    )
  }
  if (legacy) {
    lines.push(
      `legacy companion: preset ${legacy.legacyPreset ? 'mounted — uninstall oh-my-dsh-slim before v0.4' : 'not mounted'}` +
        `${legacy.legacyRoleTools.length ? ` · role tools visible: ${legacy.legacyRoleTools.join(', ')}` : ''}`,
    )
  }
  return lines
}

export { describeExecution }
