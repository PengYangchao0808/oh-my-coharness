/**
 * One-way, previewable, reversible migration from the two pre-0.4 plugins.
 *
 * Three kinds of old data exist:
 *   1. OMC harness/WSL/CLI configuration — lives in the profile patch and is
 *      already valid after the merge. Never touched.
 *   2. OMD role/Council/model/profile configuration — a JSON document, either
 *      in the DSH settings namespace `oh-my-dsh-slim`, in
 *      `$DSH_HOME/oh-my-dsh-slim.json`, or in the profile's `profile.json`.
 *   3. Sessions whose header names the old preset id — these can no longer
 *      resolve their composition. We detect them and tell the user to create a
 *      new session; we never rewrite or delete a session.
 *
 * Credentials are references (env files / CLI logins), never copied: migration
 * reads configuration documents only.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const NEW_CONFIG_FILE = 'oh-my-coharness.json'
export const OLD_CONFIG_FILE = 'oh-my-dsh-slim.json'
export const NEW_SETTINGS_NS = 'oh-my-coharness'
export const OLD_SETTINGS_NS = 'oh-my-dsh-slim'
export const NEW_PROFILE_ENTRY_ID = 'oh-my-coharness-profiles'
export const OLD_PROFILE_ENTRY_ID = 'oh-my-dsh-slim-profiles'
export const OLD_PRESET_IDS = Object.freeze(['oh-my-dsh-slim', 'omc-harness'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** DSH_HOME, honouring the environment override. */
export function dshHome(env = process.env) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** Candidate configuration files, newest name first. */
export function configPaths({ env = process.env, home = dshHome(env) } = {}) {
  return {
    currentFile: join(home, NEW_CONFIG_FILE),
    legacyFile: join(home, OLD_CONFIG_FILE),
    envCurrent: env.OH_MY_COHARNESS_CONFIG,
    envLegacy: env.OH_MY_DSH_SLIM_CONFIG,
    backupDir: join(home, 'coharness-backups'),
  }
}

/** Read a JSON document, or undefined when absent/invalid. */
export function readJsonDocument(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Deep merge `source` into `target` without overwriting existing values. */
export function mergeMissing(target, source, path = []) {
  const out = isObject(target) ? structuredClone(target) : {}
  const changes = []
  for (const [key, value] of Object.entries(source ?? {})) {
    const here = [...path, key]
    if (!(key in out) || out[key] === undefined) {
      out[key] = structuredClone(value)
      changes.push({ kind: 'add', path: here, value: structuredClone(value) })
    } else if (isObject(out[key]) && isObject(value)) {
      const nested = mergeMissing(out[key], value, here)
      out[key] = nested.document
      changes.push(...nested.changes)
    } else if (JSON.stringify(out[key]) !== JSON.stringify(value)) {
      changes.push({ kind: 'conflict', path: here, current: structuredClone(out[key]), legacy: structuredClone(value) })
    }
  }
  return { document: out, changes }
}

/** Flatten a document to leaf paths, for a readable preview. */
export function flattenDocument(value, prefix = []) {
  const rows = []
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) rows.push(...flattenDocument(child, [...prefix, key]))
  } else {
    rows.push({ path: prefix.join('.'), value })
  }
  return rows
}

/**
 * Build a migration plan. Pure: no writes.
 *
 * @param {{
 *   current?: object, legacy?: object, legacyProfiles?: object,
 *   force?: boolean,
 * }} input
 * @returns {{ document: object, changes: object[], warnings: string[], profiles: object }}
 */
export function planMigration({ current, legacy, legacyProfiles, force = false } = {}) {
  const warnings = []
  const legacyDoc = isObject(legacy) ? legacy : {}
  let document = isObject(current) ? structuredClone(current) : {}
  let changes = []

  if (Object.keys(legacyDoc).length === 0) {
    warnings.push('no legacy oh-my-dsh-slim configuration was found')
  } else if (Object.keys(document).length === 0) {
    document = structuredClone(legacyDoc)
    changes = flattenDocument(legacyDoc).map((row) => ({ kind: 'add', path: row.path.split('.'), value: row.value }))
  } else {
    const merged = mergeMissing(document, legacyDoc)
    document = merged.document
    changes = merged.changes.filter((change) => change.kind !== 'conflict')
    const conflicts = merged.changes.filter((change) => change.kind === 'conflict')
    if (conflicts.length > 0) {
      if (force) {
        // Force overwrites only the conflicting leaves with the legacy value.
        for (const conflict of conflicts) {
          let cursor = document
          for (const key of conflict.path.slice(0, -1)) cursor = cursor?.[key]
          if (cursor && typeof cursor === 'object') cursor[conflict.path.at(-1)] = structuredClone(conflict.legacy)
          changes.push({ kind: 'overwrite', path: conflict.path, value: conflict.legacy })
        }
      } else {
        warnings.push(
          `${conflicts.length} value(s) differ between the current and legacy configuration; ` +
            'rerun with --force to overwrite them (a backup is always written first)',
        )
        changes.push(...conflicts.map((conflict) => ({ ...conflict, kind: 'conflict-kept' })))
      }
    }
  }

  // Remove top-level fields that belonged to the old companion's private
  // document shape but are not part of the role configuration.
  delete document.presetId
  delete document.verbose

  const profiles = isObject(legacyProfiles) ? structuredClone(legacyProfiles) : {}
  if (Object.keys(profiles).length > 0) {
    warnings.push(`${Object.keys(profiles).length} custom profile(s) can be imported into ${NEW_PROFILE_ENTRY_ID}`)
  }

  return { document, changes, warnings, profiles }
}

/** Render a plan as text for `/coharness migrate`. */
export function renderMigrationPlan(plan, paths = configPaths()) {
  const lines = []
  lines.push('Oh My CoHarness migration preview')
  lines.push(`  current: ${paths.currentFile}${existsSync(paths.currentFile) ? '' : ' (absent)'}`)
  lines.push(`  legacy:  ${paths.legacyFile}${existsSync(paths.legacyFile) ? '' : ' (absent)'}`)
  lines.push(`  backup:  ${paths.backupDir}`)
  lines.push('')
  if (plan.changes.length === 0) lines.push('  no configuration changes')
  else {
    lines.push('  changes:')
    for (const change of plan.changes.slice(0, 200)) {
      const where = change.path.join('.')
      if (change.kind === 'add') lines.push(`    + ${where} = ${JSON.stringify(change.value)}`)
      else if (change.kind === 'overwrite') lines.push(`    ~ ${where} = ${JSON.stringify(change.value)}`)
      else if (change.kind === 'conflict') {
        lines.push(`    ! ${where}: current ${JSON.stringify(change.current)} vs legacy ${JSON.stringify(change.legacy)}`)
      } else if (change.kind === 'conflict-kept') {
        lines.push(`    = ${where}: kept current ${JSON.stringify(change.current)}`)
      }
    }
  }
  if (plan.warnings.length > 0) {
    lines.push('')
    lines.push('  warnings:')
    for (const warning of plan.warnings) lines.push(`    - ${warning}`)
  }
  lines.push('')
  lines.push('  The migration never copies credentials: only configuration references move.')
  return lines.join('\n')
}

/** Write a timestamped backup of every source document. */
export function writeBackup(paths, documents, now = new Date()) {
  mkdirSync(paths.backupDir, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const payload = {
    createdAt: now.toISOString(),
    from: { settings: OLD_SETTINGS_NS, presetIds: OLD_PRESET_IDS },
    to: { settings: NEW_SETTINGS_NS, preset: 'oh-my-coharness' },
    documents,
  }
  const file = join(paths.backupDir, `migrate-${stamp}.json`)
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return file
}

/** Read the newest backup, or one exact path. */
export function readBackup(file) {
  return readJsonDocument(file)
}

/**
 * Detect sessions bound to the old preset ids. Detection only; sessions are
 * never rewritten.
 *
 * @param {{ home?: string, limitFiles?: number, limitBytes?: number }} options
 * @returns {{ scanned: number, skipped: number, sessions: Array<{id:string, presetIds:string[]}> }}
 */
export function detectLegacySessions({ home = dshHome(), limitFiles = 400, limitBytes = 128 * 1024 * 1024 } = {}) {
  const root = join(home, 'sessions')
  const matches = []
  let scanned = 0
  let skipped = 0
  let budget = limitBytes
  if (!existsSync(root)) return { scanned, skipped, sessions: matches }

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      skipped += 1
      return
    }
    for (const entry of entries) {
      if (scanned >= limitFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) continue
      let size
      try {
        size = statSync(full).size
      } catch {
        skipped += 1
        continue
      }
      if (size > budget) {
        skipped += 1
        continue
      }
      budget -= size
      scanned += 1
      try {
        const raw = readFileSync(full)
        const text = entry.name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
        const found = OLD_PRESET_IDS.filter((id) => text.includes(`"${id}"`))
        if (found.length > 0) matches.push({ id: entry.name, presetIds: found })
      } catch {
        skipped += 1
      }
    }
  }
  walk(root)
  return { scanned, skipped, sessions: matches }
}

/**
 * Combine every legacy source into one plan.
 * @param {{ settings?: object, file?: object, profiles?: object, current?: object, force?: boolean }} input
 */
export function planFromSources({ settings, file, profiles, current, force } = {}) {
  const warnings = []
  const candidates = [settings, file].filter((doc) => isObject(doc) && Object.keys(doc).length > 0)
  if (candidates.length > 1) warnings.push('both a settings document and a legacy JSON file exist; the settings document wins')
  const plan = planMigration({ current, legacy: candidates[0], legacyProfiles: profiles, force })
  return { ...plan, warnings: [...warnings, ...plan.warnings] }
}
