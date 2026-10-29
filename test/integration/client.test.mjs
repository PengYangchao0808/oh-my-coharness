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

test('only read-only roles may select an external backend', () => {
  for (const roleId of ['oracle', 'explorer', 'councillor-alpha', 'councillor-beta', 'councillor-gamma']) {
    assert.equal(exports.externalRoleAllowed(roleId), true, roleId)
  }
  for (const roleId of ['fixer', 'designer', 'librarian', 'observer', 'council']) {
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
