/**
 * `/coharness migrate` — host half of the OMD → OMC configuration migration.
 *
 * Reads only configuration documents. It never reads a CLI credential, a login
 * file, or a session body beyond the preset-id scan (which reports counts and
 * never rewrites a session).
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NEW_PROFILE_ENTRY_ID,
  NEW_SETTINGS_NS,
  OLD_PROFILE_ENTRY_ID,
  OLD_SETTINGS_NS,
  configPaths,
  detectLegacySessions,
  planFromSources,
  readBackup,
  readJsonDocument,
  renderMigrationPlan,
  writeBackup,
} from '../integration/migration.js'

function settingsService(ctx) {
  try {
    return ctx.get?.('settings')
  } catch {
    return undefined
  }
}

function descriptorFor(settings, ns) {
  return settings?.describe?.().find((row) => row.ns === ns)
}

function editorEntry(ctx, id) {
  const editor = ctx.get?.('configEditor')
  return editor?.entries?.().find((entry) => entry.options?.id === id)
}

function readProfiles(ctx, entryId) {
  const entry = editorEntry(ctx, entryId)
  return entry?.options?.config?.profiles ?? {}
}

/** Preview the migration without writing anything. */
export async function planMigrationCommand(ctx, { force = false } = {}) {
  const settings = settingsService(ctx)
  const paths = configPaths()
  const legacySettings = descriptorFor(settings, OLD_SETTINGS_NS)?.value
  const current = descriptorFor(settings, NEW_SETTINGS_NS)?.value
  const legacyFile = readJsonDocument(paths.legacyFile)
  const legacyProfiles = readProfiles(ctx, OLD_PROFILE_ENTRY_ID)
  const plan = planFromSources({
    settings: legacySettings,
    file: legacyFile,
    profiles: legacyProfiles,
    current,
    force,
  })
  const sessions = detectLegacySessions()
  return { plan, paths, sessions, legacySettings, legacyFile, legacyProfiles, current }
}

function renderPreview(preview) {
  const lines = [
    renderMigrationPlan(preview.plan, preview.paths),
    '',
    `legacy sessions: ${preview.sessions.sessions.length} bound to an old preset id` +
      (preview.sessions.scanned > 0
        ? ` (scanned ${preview.sessions.scanned} session files, skipped ${preview.sessions.skipped})`
        : ' (no readable session store)'),
  ]
  if (preview.sessions.sessions.length > 0) {
    lines.push('  those sessions cannot resolve the old composition after uninstalling OMD;')
    lines.push('  keep them for history and create new sessions under the Oh My CoHarness preset.')
  }
  return lines.join('\n')
}

function maskDocument(document) {
  return JSON.parse(JSON.stringify(document ?? {}))
}

/** Apply (or roll back) the migration. */
export async function applyMigrationCommand(ctx, { force = false, apply = false, rollback, backupFile } = {}) {
  const settings = settingsService(ctx)
  const paths = configPaths()

  if (rollback === true) {
    const file = backupFile ?? latestBackup(paths)
    if (!file || !existsSync(file)) {
      return { text: `no migration backup found in ${paths.backupDir}; nothing to roll back`, applied: false }
    }
    const backup = readBackup(file)
    const document = backup?.documents?.current ?? {}
    await writeConfiguration(ctx, settings, document)
    return {
      text: `rolled back to the pre-migration configuration from ${file}\n` +
        'The legacy JSON file was never modified. Restart the session/preset to reload it.',
      applied: true,
      rollback: true,
      backupFile: file,
    }
  }

  const preview = await planMigrationCommand(ctx, { force })
  const previewText = renderPreview(preview)
  if (!apply) {
    return { text: previewText + '\n\nPreview only. Re-run with `--apply` to write (a backup is always written first).', applied: false }
  }

  const backup = writeBackup(paths, {
    current: maskDocument(preview.current),
    legacySettings: maskDocument(preview.legacySettings),
    legacyFile: maskDocument(preview.legacyFile),
    legacyProfiles: maskDocument(preview.legacyProfiles),
  })
  await writeConfiguration(ctx, settings, preview.plan.document)

  const profilesImported = await importProfiles(ctx, preview.legacyProfiles)
  const lines = [
    previewText,
    '',
    `applied: ${preview.paths.currentFile}`,
    `backup: ${backup}`,
    `legacy JSON preserved: ${preview.paths.legacyFile}`,
    profilesImported > 0
      ? `custom profiles imported: ${profilesImported} (old row preserved)`
      : 'custom profiles imported: none',
    '',
    'Rollback: /coharness migrate --rollback',
  ]
  return { text: lines.join('\n'), applied: true, backupFile: backup, profilesImported }
}

function latestBackup(paths) {
  try {
    const entries = readdirSync(paths.backupDir)
      .filter((name) => name.startsWith('migrate-') && name.endsWith('.json'))
      .sort()
    return entries.length ? join(paths.backupDir, entries.at(-1)) : undefined
  } catch {
    return undefined
  }
}

/** Write the document through the settings service, or the documented file. */
async function writeConfiguration(ctx, settings, document) {
  const entry = descriptorFor(settings, NEW_SETTINGS_NS)
  if (entry && typeof settings?.update === 'function') {
    await settings.update(NEW_SETTINGS_NS, document, entry.revision)
    return
  }
  const paths = configPaths()
  writeFileSync(paths.currentFile, JSON.stringify(document ?? {}, null, 2) + '\n', 'utf8')
}

/** Copy custom profiles into the new registry row; never delete the old row. */
async function importProfiles(ctx, legacyProfiles) {
  if (!legacyProfiles || Object.keys(legacyProfiles).length === 0) return 0
  const editor = ctx.get?.('configEditor')
  const entry = editorEntry(ctx, NEW_PROFILE_ENTRY_ID)
  if (!editor?.edit || !entry) return 0
  const { validateConfigDocument } = await import('../vendor/omd/npm-package/preset/config.js')
  let imported = 0
  await editor.edit(entry, (current) => {
    const profiles = { ...(current.profiles ?? {}) }
    for (const [id, record] of Object.entries(legacyProfiles)) {
      if (profiles[id]) continue // never overwrite a profile authored after the merge
      try {
        validateConfigDocument(record?.config ?? {})
      } catch {
        continue
      }
      profiles[id] = structuredClone(record)
      imported += 1
    }
    return { ...current, profiles }
  })
  return imported
}
