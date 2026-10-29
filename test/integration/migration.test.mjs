import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configPaths,
  detectLegacySessions,
  mergeMissing,
  planFromSources,
  planMigration,
  readBackup,
  renderMigrationPlan,
  writeBackup,
} from '../../integration/migration.js'
import { applyMigrationCommand, planMigrationCommand } from '../../src/migrate.js'

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'omc-migrate-'))
}

test('an empty current document receives the full legacy document', () => {
  const legacy = {
    preset: 'my-dsh-normal',
    roles: { oracle: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' } },
    presets: { 'my-dsh-normal': { fixer: { enabled: false } } },
    mcpServers: { context7: { transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' } },
  }
  const plan = planMigration({ current: {}, legacy })
  assert.deepEqual(plan.document, legacy)
  assert.ok(plan.changes.length > 0)
  assert.equal(plan.warnings.length, 0)
})

test('a conflicting value is preserved unless force is explicit', () => {
  const current = { roles: { oracle: { effort: 'max' } } }
  const legacy = { roles: { oracle: { effort: 'high' }, fixer: { enabled: false } } }
  const dry = planMigration({ current, legacy })
  assert.equal(dry.document.roles.oracle.effort, 'max')
  assert.equal(dry.document.roles.fixer.enabled, false)
  assert.ok(dry.warnings.some((line) => line.includes('--force')))
  assert.ok(dry.changes.some((change) => change.kind === 'conflict-kept'))

  const forced = planMigration({ current, legacy, force: true })
  assert.equal(forced.document.roles.oracle.effort, 'high')
  assert.ok(forced.changes.some((change) => change.kind === 'overwrite'))
})

test('nested role settings merge key by key', () => {
  const merged = mergeMissing(
    { roles: { oracle: { provider: 'deepseek', model: 'a' } } },
    { roles: { oracle: { effort: 'high' }, explorer: { enabled: false } } },
  )
  assert.deepEqual(merged.document.roles.oracle, { provider: 'deepseek', model: 'a', effort: 'high' })
  assert.equal(merged.document.roles.explorer.enabled, false)
})

test('custom profiles are reported, never silently imported', () => {
  const plan = planFromSources({
    current: {},
    settings: { roles: { oracle: { effort: 'high' } } },
    profiles: { 'profile-review': { displayName: 'Review', config: {} } },
  })
  assert.ok(plan.warnings.some((line) => line.includes('custom profile')))
  assert.equal(Object.keys(plan.profiles).length, 1)
})

test('presetId/verbose are dropped from the migrated document', () => {
  const plan = planMigration({ current: {}, legacy: { presetId: 'x', verbose: true, roles: {} } })
  assert.equal(plan.document.presetId, undefined)
  assert.equal(plan.document.verbose, undefined)
})

test('the preview names the source, backup and change', () => {
  const paths = {
    currentFile: 'C:\\home\\oh-my-coharness.json',
    legacyFile: 'C:\\home\\oh-my-dsh-slim.json',
    backupDir: 'C:\\home\\coharness-backups',
  }
  const plan = planMigration({ current: {}, legacy: { roles: { oracle: { effort: 'high' } } } })
  const text = renderMigrationPlan(plan, paths)
  assert.match(text, /Oh My CoHarness migration preview/)
  assert.match(text, /oh-my-dsh-slim\.json/)
  assert.match(text, /coharness-backups/)
  assert.match(text, /\+ roles\.oracle\.effort/)
  assert.match(text, /never copies credentials/)
})

test('a backup is written and can be read back', async () => {
  const home = await tempHome()
  const paths = configPaths({ env: { DSH_HOME: home }, home })
  const file = writeBackup(paths, { current: { a: 1 }, legacy: { b: 2 } }, new Date('2026-10-30T00:00:00.000Z'))
  assert.match(file, /migrate-2026-10-30T00-00-00-000Z\.json$/)
  const backup = readBackup(file)
  assert.equal(backup.documents.current.a, 1)
  assert.equal(backup.documents.legacy.b, 2)
  assert.equal(backup.from.settings, 'oh-my-dsh-slim')
  assert.equal(backup.to.preset, 'oh-my-coharness')
  assert.match(await readFile(file, 'utf8'), /oh-my-coharness/)
})

test('legacy session detection reports old preset ids without rewriting anything', async () => {
  const home = await tempHome()
  const dir = join(home, 'sessions', 'workspace')
  await mkdir(join(dir, 'session-old'), { recursive: true })
  await mkdir(join(dir, 'session-new'), { recursive: true })
  await writeFile(join(dir, 'session-old', 'session.v4.jsonl'), '{"header":{"agentPreset":"oh-my-dsh-slim"}}\n', 'utf8')
  await writeFile(join(dir, 'session-new', 'session.v4.jsonl'), '{"header":{"agentPreset":"oh-my-coharness"}}\n', 'utf8')
  const result = detectLegacySessions({ home })
  assert.equal(result.sessions.length, 1)
  assert.deepEqual(result.sessions[0].presetIds, ['oh-my-dsh-slim'])
  assert.equal(result.scanned, 2)
})

test('config paths honour DSH_HOME', () => {
  const paths = configPaths({ env: { DSH_HOME: 'D:\\dsh-home' }, home: 'D:\\dsh-home' })
  assert.equal(paths.currentFile, join('D:\\dsh-home', 'oh-my-coharness.json'))
  assert.equal(paths.legacyFile, join('D:\\dsh-home', 'oh-my-dsh-slim.json'))
  assert.equal(paths.backupDir, join('D:\\dsh-home', 'coharness-backups'))
})

test('the host migration command previews, writes, imports profiles and rolls back', async () => {
  const home = await tempHome()
  const previousHome = process.env.DSH_HOME
  const previousConfig = process.env.OH_MY_COHARNESS_CONFIG
  process.env.DSH_HOME = home
  delete process.env.OH_MY_COHARNESS_CONFIG
  try {
    let stored = {}
    const oldProfiles = {
      'profile-review': { displayName: 'Review', config: { roles: { oracle: { effort: 'high' } } } },
    }
    const newEntry = { options: { id: 'oh-my-coharness-profiles', config: { profiles: {} } } }
    const editor = {
      entries: () => [
        { options: { id: 'oh-my-dsh-slim-profiles', config: { profiles: oldProfiles } } },
        newEntry,
      ],
      edit: async (entry, change) => { entry.options.config = change(entry.options.config) },
    }
    const settings = {
      describe: () => [
        { ns: 'oh-my-dsh-slim', value: { roles: { oracle: { effort: 'high' } } }, revision: 1 },
        { ns: 'oh-my-coharness', value: {}, revision: 2 },
      ],
      update: async (ns, document) => { stored = document },
    }
    const ctx = {
      get(name) {
        if (name === 'settings') return settings
        if (name === 'configEditor') return editor
        return undefined
      },
    }

    const preview = await planMigrationCommand(ctx)
    assert.equal(preview.plan.document.roles.oracle.effort, 'high')
    assert.equal(preview.sessions.sessions.length, 0)

    const applied = await applyMigrationCommand(ctx, { apply: true })
    assert.equal(applied.applied, true)
    assert.equal(stored.roles.oracle.effort, 'high')
    assert.equal(newEntry.options.config.profiles['profile-review'].displayName, 'Review')
    const backup = readBackup(applied.backupFile)
    assert.deepEqual(backup.documents.current, {})

    const rolled = await applyMigrationCommand(ctx, { rollback: true })
    assert.equal(rolled.rollback, true)
    assert.deepEqual(stored, {})
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousConfig === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
    else process.env.OH_MY_COHARNESS_CONFIG = previousConfig
  }
})
