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
import { describeExecution, EXTERNAL_ROLE_IDS } from './compatibility.js'
import { harnessReadOnlyClass, resolveExecution } from './execution.js'
import { createSessionRegistry } from './sessions.js'
import { policySummary, recommendRoute } from './model-policy.js'

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
 * One row per role, plus harness availability.
 * @param ctx - any context that can reach `subagents` and the settings service.
 * @param rowConfig - the Host row config, so default-disabled harnesses report
 *   their real enabled state instead of "available".
 * @param options - `{ registry }` lets the Host reuse its live registry; status
 *   otherwise opens the same file read-only.
 * @returns a JSON-serializable status object.
 */
export async function buildExecutionStatus(ctx, rowConfig = {}, options = {}) {
  const cfg = resolveConfig(rowConfig)
  const registry = options.registry ?? createSessionRegistry(cfg.sessions)
  const providers = liveProviders(ctx)
  const loaded = await readRoleConfiguration(ctx)
  const roles = []
  if (loaded.ok) {
    for (const [roleId, roleConfig] of Object.entries(loaded.config.roles)) {
      let resolved
      try {
        resolved = resolveExecution(roleId, roleConfig, providers)
      } catch (error) {
        roles.push({
          roleId,
          enabled: roleConfig.enabled !== false,
          execution: describeExecution(roleConfig),
          backend: roleConfig?.execution?.backend ?? 'native',
          blocked: true,
          code: error?.code ?? 'OMC/EXECUTION-INVALID',
          reason: String(error?.message ?? error),
        })
        continue
      }
      roles.push({
        roleId,
        enabled: roleConfig.enabled !== false,
        execution: describeExecution(roleConfig),
        backend: resolved.backend,
        harness: resolved.harness,
        provider: resolved.provider,
        providerAvailable: resolved.external ? providers.includes(resolved.provider) : true,
        readOnly: resolved.readOnly,
        // What an external run of this role may do; native rows have no mode.
        mode: resolved.mode,
        blocked: resolved.blocked === true,
        code: resolved.code,
        reason: resolved.reason,
        fallbackReason: resolved.fallbackReason,
        externalCapable: EXTERNAL_ROLE_IDS.includes(roleId),
      })
    }
  }

  const policy = policySummary(cfg.routing)
  policy.recommendations = Object.fromEntries(
    roles.map((row) => [row.roleId, recommendRoute(row.roleId, cfg.routing, providers)]),
  )

  return {
    presetId: PRESET_ID,
    source: loaded.ok ? loaded.config.source : undefined,
    configError: loaded.ok ? undefined : loaded.error,
    providers,
    roles,
    sessions: registry.stats(),
    routing: policy,
    harnesses: HARNESSES.map((def) => ({
      id: def.id,
      label: def.label,
      bin: def.bin,
      enabled: cfg.harnesses[def.id]?.enabled !== false,
      // Empty string, never undefined: the settings card renders this field
      // directly and a missing key would read as a lost setting.
      model: cfg.harnesses[def.id]?.model ?? '',
      readOnly: harnessReadOnlyClass(def.id),
      provider: `omc:${def.id}`,
      providerAvailable: providers.includes(`omc:${def.id}`),
      verified: def.verified === true,
      // Session support is a fact of the adapter, separate from argv verification.
      session: def.session
        ? { format: def.session.format, confidence: def.session.confidence }
        : null,
    })),
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
    if (row.external && row.providerAvailable === false) flags.push('provider unavailable')
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
        `${sessions.entries ?? 0} refs · ${sessions.resumable ?? 0} resumable · ` +
        `idle ${states.idle ?? 0} / running ${states.running ?? 0} / failed ${states.failed ?? 0}`,
    )
    if (sessions.loadError) lines.push(`  session registry unreadable: ${sessions.loadError}`)
  }
  if (status.routing) {
    lines.push(
      `routing: ${status.routing.preset} (${status.routing.label}) · ` +
        `${status.routing.enabled ? 'advisory recommendations on' : 'advisory only, not applied'}`,
    )
    if (status.routing.enabled) {
      const recommended = Object.entries(status.routing.recommendations ?? {})
        .filter(([, route]) => route?.backend === 'omc')
        .map(([role, route]) => `${role}→omc:${route.harness}`)
      if (recommended.length) lines.push(`  recommended: ${recommended.join(' · ')}`)
    }
  }
  lines.push('harness read-only class:')
  for (const row of status.harnesses) {
    const resume = row.session
      ? ` · resume ${row.session.confidence}`
      : ''
    lines.push(
      `  ${row.id.padEnd(12)}${(row.enabled ? 'on' : 'off').padEnd(4)}${row.readOnly.padEnd(12)}` +
        `${row.providerAvailable ? 'provider registered' : 'provider missing'}${row.verified ? '' : ' · argv unverified'}${resume}`,
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
