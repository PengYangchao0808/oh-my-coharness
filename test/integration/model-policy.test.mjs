import assert from 'node:assert/strict'
import test from 'node:test'

import {
  POLICY_PRESETS,
  policySummary,
  preferenceChain,
  recommendRoute,
  renderPolicy,
} from '../../integration/model-policy.js'

const providers = ['spawn', 'fork', 'omc:codex', 'omc:kimi', 'omc:antigravity']

test('the policy is inert until it is explicitly enabled', () => {
  assert.equal(recommendRoute('oracle', { preset: 'balanced', enabled: false }, providers), null)
  assert.equal(policySummary({}).enabled, false)
  assert.match(renderPolicy({}), /not applied/)
})

test('economy keeps every role native', () => {
  const routing = { enabled: true, preset: 'economy' }
  for (const roleId of ['oracle', 'explorer', 'designer', 'fixer']) {
    const route = recommendRoute(roleId, routing, providers)
    assert.equal(route.backend, 'native', roleId)
  }
})

test('balanced recommends Codex for Oracle only when its provider exists', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const ready = recommendRoute('oracle', routing, providers)
  assert.equal(ready.backend, 'omc')
  assert.equal(ready.harness, 'codex')

  const missing = recommendRoute('oracle', routing, ['spawn', 'fork'])
  assert.equal(missing.backend, 'native')
  assert.match(missing.reason, /none of the preferred external providers/)
})

test('a role fallback is used before giving up on external execution', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const route = recommendRoute('designer', routing, ['omc:antigravity'])
  assert.equal(route.backend, 'omc')
  assert.equal(route.harness, 'antigravity')
  assert.equal(route.source, 'fallback')
})

test('an explicit user preference outranks the preset', () => {
  const routing = {
    enabled: true,
    preset: 'economy',
    roles: {
      oracle: {
        preferred: { backend: 'omc', harness: 'claude' },
        fallback: { backend: 'omc', harness: 'codex' },
      },
    },
  }
  const route = recommendRoute('oracle', routing, ['omc:codex'])
  assert.equal(route.backend, 'omc')
  assert.equal(route.harness, 'codex')
  assert.equal(route.source, 'fallback')
  assert.deepEqual(preferenceChain('oracle', routing).map((row) => row.harness), ['claude', 'codex'])
})

test('the preset table documents every route it offers', () => {
  for (const [id, preset] of Object.entries(POLICY_PRESETS)) {
    assert.ok(preset.label, id)
    assert.ok(preset.description, id)
    for (const [role, entry] of Object.entries(preset.roles)) {
      assert.ok(['native', 'omc'].includes(entry.backend), `${id}/${role}`)
      if (entry.backend === 'omc') assert.ok(entry.harness, `${id}/${role}`)
    }
  }
  assert.match(policySummary({ enabled: true, preset: 'quality' }).label, /Quality/)
})
