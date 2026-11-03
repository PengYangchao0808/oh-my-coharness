import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  comparableRole,
  createPresetSnapshotStore,
  diffPresetSnapshot,
} from '../../integration/preset-snapshot.js'

const ROLES = {
  oracle: { enabled: true, provider: 'zai', model: 'glm-5.3', effort: 'high', tools: ['read'] },
  fixer: { enabled: true, provider: 'opencode', model: 'deepseek-v4-flash', deny: ['skill'] },
}

test('a manual snapshot is durable and the diff names changed roles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-preset-'))
  try {
    const store = createPresetSnapshotStore({ dir })
    const saved = store.write('parent', { source: 'settings', preset: 'default', orchestrator: { effort: 'max' }, roles: ROLES })
    assert.equal(saved.value.kind, 'manual')
    const reloaded = createPresetSnapshotStore({ dir }).read('parent')
    assert.equal(reloaded.manual.roles.oracle.model, 'glm-5.3')

    const changed = {
      ...ROLES,
      oracle: { ...ROLES.oracle, model: 'glm-5.4' },
      fixer: { ...ROLES.fixer, enabled: false },
    }
    const diff = diffPresetSnapshot(reloaded.manual, { orchestrator: { effort: 'max' }, roles: changed })
    assert.equal(diff.same, false)
    assert.deepEqual(diff.changed.map((row) => row.roleId).sort(), ['fixer', 'oracle'])
    assert.equal(diff.orchestratorChanged, false)

    const same = diffPresetSnapshot(reloaded.manual, { orchestrator: { effort: 'max' }, roles: structuredClone(ROLES) })
    assert.equal(same.same, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the startup baseline is written once and a manual snapshot cannot replace it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-preset-'))
  try {
    const store = createPresetSnapshotStore({ dir })
    const first = store.ensureStartup('parent', { roles: ROLES })
    assert.equal(first.created, true)
    assert.equal(first.value.kind, 'startup')
    const firstAt = first.value.at
    // A later observation with a changed config must NOT replace the baseline.
    const second = store.ensureStartup('parent', {
      roles: { ...ROLES, oracle: { ...ROLES.oracle, model: 'glm-5.4' } },
    })
    assert.equal(second.created, false)
    assert.equal(second.value.roles.oracle.model, 'glm-5.3')
    assert.equal(second.value.at, firstAt)
    // A manual snapshot is stored beside the baseline, labeled manual.
    const manual = store.write('parent', { roles: { ...ROLES, oracle: { ...ROLES.oracle, model: 'glm-5.4' } } })
    assert.equal(manual.value.kind, 'manual')
    const stored = createPresetSnapshotStore({ dir }).read('parent')
    assert.equal(stored.startup.kind, 'startup')
    assert.equal(stored.startup.roles.oracle.model, 'glm-5.3')
    assert.equal(stored.manual.kind, 'manual')
    assert.equal(stored.manual.roles.oracle.model, 'glm-5.4')
    // The diff against the baseline still sees the change the manual snapshot
    // tried to hide.
    const diff = diffPresetSnapshot(stored.startup, { roles: stored.manual.roles })
    assert.deepEqual(diff.changed.map((row) => row.roleId), ['oracle'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('execution and maxTokens changes are part of the diff', () => {
  const before = { execution: { backend: 'native' }, maxTokens: 4096, provider: 'p', model: 'm' }
  const after = { execution: { backend: 'omc', harness: 'codex' }, maxTokens: 8192, provider: 'p', model: 'm' }
  const diff = diffPresetSnapshot({ roles: { oracle: before } }, { roles: { oracle: after } })
  assert.equal(diff.same, false)
  const [row] = diff.changed
  assert.equal(row.roleId, 'oracle')
  assert.deepEqual(row.after.execution, { backend: 'omc', harness: 'codex' })
  assert.equal(row.after.maxTokens, 8192)
})

test('orchestrator changes are reported separately', () => {
  const diff = diffPresetSnapshot(
    { orchestrator: { effort: 'high' }, roles: ROLES },
    { orchestrator: { effort: 'max' }, roles: ROLES },
  )
  assert.equal(diff.orchestratorChanged, true)
  assert.equal(diff.same, false)
})

test('only comparable role fields enter the diff', () => {
  const left = comparableRole({ provider: 'p', model: 'm', temperature: 0.1, unknown: 'x' })
  assert.deepEqual(left, { provider: 'p', model: 'm' })
})
