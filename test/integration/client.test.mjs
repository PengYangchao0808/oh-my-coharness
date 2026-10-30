import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadClientBundle } from '../helpers/client-loader.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const defaults = JSON.parse(readFileSync(join(root, 'vendor/omd/npm-package/preset/defaults.json'), 'utf8'))
const { definition, exports, source } = loadClientBundle()

const presetName = defaults.preset
const base = defaults

function effectiveWith(oracleExecution) {
  return {
    preset: presetName,
    presets: {
      [presetName]: oracleExecution === undefined ? {} : { oracle: { execution: oracleExecution } },
    },
    advanced: { roles: {} },
  }
}

test('the card loads under the merged package identity', () => {
  assert.equal(definition.id, 'oh-my-coharness')
  assert.equal(exports.name, 'oh-my-coharness')
  assert.equal(exports.VERSION, pkg.version)
  assert.match(source, /const NS = 'oh-my-coharness'/)
  assert.match(source, /PROFILE_RPC_PATH = '\/coharness'/)
  assert.doesNotMatch(source, /\/omds/)
  assert.match(source, /id: 'oh-my-coharness'/)
})

test('native is the default draft and writes no execution field', () => {
  const draft = exports.buildDraft(effectiveWith(undefined), { roles: {} }, base)
  assert.deepEqual(draft.roles.oracle.execution, { backend: 'native' })
  assert.equal(exports.executionForWrite({ backend: 'native' }), undefined)
  const ops = exports.planUserOps(base, {}, draft).filter((op) => op.path.join('.').endsWith('.execution'))
  assert.deepEqual(ops, [])
  const written = exports.draftToConfig(draft, {}, base)
  assert.equal(written.presets[presetName]?.oracle?.execution, undefined)
})

test('an external role round-trips through the write plan and profile document', () => {
  const effective = effectiveWith({ backend: 'omc', harness: 'codex' })
  const draft = exports.buildDraft(effective, { roles: {} }, base)
  assert.deepEqual(draft.roles.oracle.execution, { backend: 'omc', harness: 'codex' })

  const ops = exports.planUserOps(base, {}, draft).filter((op) => op.path.join('.') === `presets.${presetName}.oracle.execution`)
  assert.deepEqual(ops, [{
    op: 'set',
    path: ['presets', presetName, 'oracle', 'execution'],
    value: { backend: 'omc', harness: 'codex' },
  }])

  const written = exports.draftToConfig(draft, {}, base)
  assert.deepEqual(written.presets[presetName].oracle.execution, { backend: 'omc', harness: 'codex' })
  assert.equal(written.presets[presetName].fixer?.execution, undefined)

  // Round-trip: merging the written document must reproduce the execution block.
  const merged = exports.mergeProfileConfig(base, written)
  assert.deepEqual(merged.presets[presetName].oracle.execution, { backend: 'omc', harness: 'codex' })
  assert.equal(exports.buildDraft(merged, merged.advanced, base).roles.oracle.execution.backend, 'omc')
})

test('switch back to native removes the stored execution field', () => {
  const user = { presets: { [presetName]: { oracle: { execution: { backend: 'omc', harness: 'codex' } } } } }
  const draft = exports.buildDraft(effectiveWith(undefined), { roles: {} }, base)
  const ops = exports.planUserOps(base, user, draft).filter((op) => op.path.join('.') === `presets.${presetName}.oracle.execution`)
  assert.deepEqual(ops, [{ op: 'unset', path: ['presets', presetName, 'oracle', 'execution'] }])
})

test('defaults are omitted from the stored execution block', () => {
  assert.deepEqual(exports.executionForWrite({ backend: 'omc', harness: 'kimi' }), { backend: 'omc', harness: 'kimi' })
  assert.deepEqual(
    exports.executionForWrite({ backend: 'omc', harness: 'kimi', fallback: 'native', allowAdvisory: true }),
    { backend: 'omc', harness: 'kimi', fallback: 'native', allowAdvisory: true },
  )
  assert.deepEqual(exports.normalizeExecution({ backend: 'omc' }), { backend: 'omc', harness: 'codex' })
})

test('only external-capable roles may select an external backend', () => {
  for (const roleId of ['oracle', 'explorer', 'designer', 'councillor-alpha', 'councillor-beta', 'councillor-gamma']) {
    assert.equal(exports.externalRoleAllowed(roleId), true, roleId)
  }
  for (const roleId of ['fixer', 'librarian', 'observer', 'council']) {
    assert.equal(exports.externalRoleAllowed(roleId), false, roleId)
  }
})

test('harness labels state the read-only class and provider state', () => {
  const t = (key) => key
  assert.equal(
    exports.harnessLabel({ id: 'codex', label: 'Codex', readOnly: 'enforced', providerAvailable: true }, t),
    'Codex · executionReadOnlyEnforced',
  )
  assert.equal(
    exports.harnessLabel({ id: 'opencode', label: 'opencode', readOnly: 'advisory', providerAvailable: false }, t),
    'opencode · executionReadOnlyAdvisory · executionProviderMissing',
  )
})

test('the live harness list falls back to the static catalog', () => {
  assert.ok(exports.harnessOptions({ status: 'error' }).some((row) => row.id === 'codex'))
  const live = exports.harnessOptions({ execution: { harnesses: [{ id: 'codex', readOnly: 'enforced' }] } })
  assert.equal(live.length, 1)
})

test('harness editor rows merge live facts with the stored settings', () => {
  const status = {
    execution: {
      harnesses: [
        { id: 'codex', label: 'Codex', readOnly: 'enforced', providerAvailable: true, model: 'gpt-5' },
        { id: 'kimi', label: 'Kimi', readOnly: 'advisory', providerAvailable: false },
      ],
    },
  }
  const effective = { harnesses: { kimi: { enabled: false, model: 'k2' }, 'custom-cli': { model: 'x' } } }
  const rows = exports.harnessEditorRows(effective, status)

  // A stored id the live status omits still gets an editor, so it can be cleared.
  assert.deepEqual(rows.map((row) => row.id), ['codex', 'kimi', 'custom-cli'])
  // A live resolution fills a missing stored value; a stored value wins over it.
  assert.deepEqual(rows[0].value, { enabled: true, model: 'gpt-5' })
  assert.deepEqual(rows[1].value, { enabled: false, model: 'k2' })
  assert.deepEqual(rows[2].value, { enabled: true, model: 'x' })
  // Live facts are not rewritten by the editor.
  assert.equal(rows[0].readOnly, 'enforced')
  assert.equal(rows[1].providerAvailable, false)
})

test('the harness write plan is path-scoped and only writes staged changes', () => {
  const user = {
    harnesses: {
      codex: { command: 'codex', env: { A: '1' }, enabled: true, model: 'gpt-5' },
      kimi: { enabled: false },
    },
  }
  const shown = {
    codex: { enabled: true, model: 'gpt-5' },
    kimi: { enabled: false, model: '' },
  }
  const ops = exports.planHarnessOps(shown, user, {
    codex: { model: 'gpt-5-codex' },
    kimi: { enabled: true },
  })
  assert.deepEqual(ops, [
    { op: 'set', path: ['harnesses', 'codex', 'model'], value: 'gpt-5-codex' },
    { op: 'set', path: ['harnesses', 'kimi', 'enabled'], value: true },
  ])

  // An untouched or reverted field is not a write.
  assert.deepEqual(exports.planHarnessOps(shown, user, { codex: { enabled: true, model: 'gpt-5' } }), [])
})

test('clearing a harness model unsets it instead of pinning an empty string', () => {
  const user = { harnesses: { codex: { enabled: true, model: 'gpt-5' } } }
  const shown = { codex: { enabled: true, model: 'gpt-5' } }
  assert.deepEqual(exports.planHarnessOps(shown, user, { codex: { model: '  ' } }), [
    { op: 'unset', path: ['harnesses', 'codex', 'model'] },
  ])
})

test('resetting harness overrides keeps every non-editable sibling key', () => {
  const user = {
    harnesses: {
      codex: { command: 'codex', enabled: true, model: 'gpt-5' },
      kimi: { model: 'k2' },
      glm: { command: 'claude' },
    },
  }
  assert.deepEqual(exports.planHarnessReset(user), [
    { op: 'unset', path: ['harnesses', 'codex', 'enabled'] },
    { op: 'unset', path: ['harnesses', 'codex', 'model'] },
    { op: 'unset', path: ['harnesses', 'kimi', 'model'] },
  ])
  assert.deepEqual(exports.planHarnessReset({}), [])
})
