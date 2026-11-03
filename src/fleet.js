/**
 * Host glue for the native fleet and the demo.
 *
 * The planner and the fixture live in `integration/` and stay testable without a
 * Cordis context. This file is the only place that reads host services and
 * writes the profile.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPaths, dshHome, readJsonDocument } from '../integration/migration.js'
import { readModelCatalog } from '../integration/catalog.js'
import { COUNCIL_ROLE_IDS, FLEET_ROLE_IDS, fleetRolesPatch, planNativeFleet, renderFleetPlan } from '../integration/fleet.js'
import { demoDirectory, demoPrompt, resolveNodePath, seedNativeDemo } from '../integration/demo.js'
import { readRoleConfiguration } from '../integration/status.js'

export const SETTINGS_NS = 'oh-my-coharness'

function settingsService(ctx) {
  try {
    return ctx.get?.('settings')
  } catch {
    return undefined
  }
}

function descriptorFor(settings) {
  return settings?.describe?.().find((row) => row.ns === SETTINGS_NS)
}

/** The document the settings service currently holds for this plugin. */
export function currentSettingsDocument(entry) {
  // Prefer the user layer even when it is empty: copying `value` would persist
  // bundle/factory defaults into the user layer just to add a route.
  if (entry?.user && typeof entry.user === 'object') return structuredClone(entry.user)
  if (entry?.value && typeof entry.value === 'object') return structuredClone(entry.value)
  return {}
}

/** Merge only a role's route, keeping its tools/deny/MCP/persona fields. */
function mergeRoles(before, patch) {
  const roles = { ...(before ?? {}) }
  for (const [roleId, route] of Object.entries(patch ?? {})) {
    roles[roleId] = { ...(roles[roleId] ?? {}), ...route }
  }
  return roles
}

/**
 * The per-role routes the user already configured in OMD-Slim.
 *
 * The two plugins can coexist during the transition; reading OMD's live
 * settings is what makes "quickly reuse what already works" literal instead of
 * a second round of model selection. Only a complete provider/model pair is
 * taken, and an explicit `models` argument still wins.
 *
 * @param {any} ctx
 * @returns {Record<string, {provider: string, model: string}>}
 */
export function readOmdPreferences(ctx) {
  const settings = settingsService(ctx)
  const entry = settings?.describe?.().find((row) => row.ns === 'oh-my-dsh-slim')
  const document = entry?.user && typeof entry.user === 'object' && Object.keys(entry.user).length > 0
    ? entry.user
    : entry?.value
  if (!document || typeof document !== 'object') return {}
  const presetName = typeof document.preset === 'string' && document.preset.trim() !== ''
    ? document.preset
    : 'my-dsh-normal'
  const chosen = document.presets?.[presetName] ?? document.roles ?? {}
  const out = {}
  for (const roleId of [...FLEET_ROLE_IDS, ...COUNCIL_ROLE_IDS]) {
    const row = chosen?.[roleId]
    if (typeof row?.provider !== 'string' || row.provider.trim() === '') continue
    if (typeof row?.model !== 'string' || row.model.trim() === '') continue
    out[roleId] = { provider: row.provider.trim(), model: row.model.trim() }
  }
  return out
}

function backupDocument(document, plan, now = new Date()) {
  const paths = configPaths()
  mkdirSync(paths.backupDir, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const file = join(paths.backupDir, 'fleet-' + stamp + '.json')
  writeFileSync(file, JSON.stringify({
    createdAt: now.toISOString(),
    kind: 'native-fleet',
    before: document,
    plan: { assignments: plan.assignments, warnings: plan.warnings, catalog: plan.catalog },
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return file
}

/**
 * Preview a native fleet from the live DSH model catalog.
 * @param {any} ctx
 * @param {{models?: object|Array, refresh?: boolean}} [options]
 */
export async function buildNativeFleet(ctx, { models, refresh = false } = {}) {
  const catalog = await readModelCatalog(ctx, { refresh })
  const loaded = await readRoleConfiguration(ctx)
  const existing = loaded.ok ? loaded.config.roles : {}
  // Pin enabled council seats too: a "native fleet" that leaves two seats on an
  // external CLI is not native. Disabled seats stay untouched.
  const roles = [...FLEET_ROLE_IDS, ...COUNCIL_ROLE_IDS]
    .filter((roleId) => existing[roleId]?.enabled !== false)
  const preferred = readOmdPreferences(ctx)
  const plan = planNativeFleet({ catalog, roles, explicit: models, preferred, existing })
  if (!loaded.ok) plan.warnings.push('the current role configuration could not be read: ' + loaded.error)
  return { plan, loaded, existing }
}

/**
 * Persist the route half of a fleet into the live DSH profile.
 *
 * Only `roles.<id>.provider/model/execution` is touched. The previous document
 * is always backed up first. A settings write is preferred; the documented JSON
 * file is the fallback for a host without a settings service.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof planNativeFleet>} plan
 */
export async function applyNativeFleet(ctx, plan) {
  const patch = fleetRolesPatch(plan.assignments)
  if (Object.keys(patch.roles).length === 0) {
    return { applied: false, reason: 'the plan has no assignable roles; nothing was written' }
  }

  const settings = settingsService(ctx)
  const entry = descriptorFor(settings)
  const before = currentSettingsDocument(entry)
  const backup = backupDocument(before, plan)
  // Merge per role: replacing the whole role object would drop its tools, deny
  // list, MCP selection and persona append.
  const next = { ...before, roles: mergeRoles(before.roles, patch.roles) }

  if (settings && entry && typeof settings.update === 'function') {
    await settings.update(SETTINGS_NS, next, entry.revision)
  } else {
    const paths = configPaths()
    // A host without a settings service falls back to the documented JSON file;
    // merge into what is actually on disk instead of reusing the settings copy.
    const onDisk = readJsonDocument(paths.currentFile) ?? before
    const document = { ...onDisk, roles: mergeRoles(onDisk.roles, patch.roles) }
    mkdirSync(dirname(paths.currentFile), { recursive: true })
    writeFileSync(paths.currentFile, JSON.stringify(document, null, 2) + '\n', 'utf8')
  }

  const verified = await readRoleConfiguration(ctx)
  const mismatch = []
  if (verified.ok) {
    for (const row of plan.assignments) {
      const effective = verified.config.roles?.[row.roleId]
      if (!effective) continue
      if (effective.provider !== row.provider || effective.model !== row.model) {
        mismatch.push(`${row.roleId}: wanted ${row.label}, effective ` +
          `${effective.provider ?? '(inherit)'}/${effective.model ?? '(inherit)'}`)
      }
    }
  } else {
    mismatch.push('could not re-read the role configuration: ' + verified.error)
  }

  return { applied: true, backup, mismatch, effectiveSource: verified.ok ? verified.config.source : undefined }
}

/**
 * One command for the quick start: plan the fleet, optionally write it, seed a
 * deterministic workspace, and return the prompt to paste into a new session.
 *
 * @param {any} ctx
 * @param {{models?: object|Array, apply?: boolean, cwd?: string, refresh?: boolean}} [options]
 */
export async function runNativeDemo(ctx, { models, apply = true, cwd, refresh = false } = {}) {
  const { plan } = await buildNativeFleet(ctx, { models, refresh })

  // Seed before writing settings: an existing directory must not leave the
  // profile half-applied with no workspace to run.
  const dir = cwd && cwd.trim() !== '' ? cwd : demoDirectory({ home: dshHome() })
  const seeded = seedNativeDemo({ dir, node: resolveNodePath() })
  let applied = { applied: false }
  let applyError
  if (apply) {
    try {
      applied = await applyNativeFleet(ctx, plan)
    } catch (error) {
      applyError = String(error?.message ?? error)
    }
  }

  const lines = [renderFleetPlan(plan, { applied: applied.applied, backup: applied.backup })]
  if (applyError) {
    lines.push('fleet apply failed: ' + applyError)
    lines.push('The workspace was seeded, but the role routes were not written. Fix the settings error and rerun `/coharness fleet --apply`.')
  }
  for (const note of applied.mismatch ?? []) lines.push('verify: ' + note)
  lines.push('')
  lines.push('demo workspace: ' + seeded.dir)
  lines.push('files: ' + seeded.files.join(', '))
  lines.push('node: ' + seeded.node)
  lines.push('')
  lines.push('next:')
  lines.push('  1. 新建会话并选择 Oh My CoHarness preset（如果当前会话已经是该 preset，可直接继续）。')
  lines.push('  2. 把下面的 prompt 粘贴到该会话。')
  lines.push('  3. 结束后运行 `/coharness status`，核对每个角色实际钉住的 provider/model。')
  lines.push('')
  lines.push('--- prompt ---')
  lines.push(seeded.prompt)
  return {
    plan,
    applied,
    workspace: seeded.dir,
    node: seeded.node,
    files: seeded.files,
    prompt: seeded.prompt,
    text: lines.join('\n'),
  }
}

export { demoPrompt }
