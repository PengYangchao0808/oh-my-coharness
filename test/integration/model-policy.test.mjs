import assert from 'node:assert/strict'
import test from 'node:test'

import {
  POLICY_PRESETS,
  billingAuthorized,
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
  assert.match(missing.reason, /native is the safe fallback/)
})

test('a role fallback is used before giving up on external execution', () => {
  const routing = { enabled: true, preset: 'quality' }
  const route = recommendRoute('designer', routing, ['omc:antigravity'])
  assert.equal(route.backend, 'omc')
  assert.equal(route.harness, 'antigravity')
  assert.equal(route.source, 'fallback')
})

test('API and unknown billing are blocked unless explicitly authorized', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const api = recommendRoute('oracle', routing, providers, { billing: { codex: 'api' } })
  assert.equal(api.backend, 'native')
  assert.match(api.reason, /api billing is not authorized/)

  const apiAllowed = recommendRoute('oracle', { ...routing, allowPaidApi: true }, providers, {
    billing: { codex: 'api' },
  })
  assert.equal(apiAllowed.backend, 'omc')
  assert.equal(apiAllowed.billing, 'api')

  const unknown = recommendRoute('oracle', routing, providers, { billing: { codex: 'unknown' } })
  assert.equal(unknown.backend, 'native')
  assert.match(unknown.reason, /unknown billing is not authorized/)
  const unknownAllowed = recommendRoute('oracle', { ...routing, allowUnknownBilling: true }, providers, {
    billing: { codex: 'unknown' },
  })
  assert.equal(unknownAllowed.backend, 'omc')

  const override = {
    enabled: true,
    preset: 'balanced',
    roles: { oracle: { preferred: { backend: 'omc', harness: 'codex', authorizeBilling: true } } },
  }
  assert.equal(recommendRoute('oracle', override, providers, { billing: { codex: 'api' } }).backend, 'omc')
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

test('a registered but non-routable provider is skipped for the next route', () => {
  const routing = { enabled: true, preset: 'quality' }
  const connections = {
    codex: { state: 'installed', auth: 'signed-out', routable: false },
    antigravity: { state: 'routable', auth: 'ok', routable: true },
  }
  const route = recommendRoute('designer', routing, ['omc:codex', 'omc:antigravity'], { connections })
  assert.equal(route.backend, 'omc')
  assert.equal(route.harness, 'antigravity')
  assert.equal(route.source, 'fallback')
  assert.deepEqual(route.blocked.map((row) => row.harness), ['codex'])
  assert.equal(route.blocked[0].reason, 'omc:codex is not routable (signed-out)')
  assert.equal(route.blocked[0].billing, 'subscription')
})

test('no routable connection falls back to native and names the state', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const unknown = recommendRoute('oracle', routing, ['omc:codex'], {
    connections: { codex: { state: 'installed', auth: 'unknown', routable: false } },
  })
  assert.equal(unknown.backend, 'native')
  assert.equal(unknown.harness, null)
  assert.match(unknown.reason, /omc:codex is not routable \(unknown\)/)

  const disabled = recommendRoute('oracle', routing, ['omc:codex'], {
    connections: { codex: { state: 'disabled', routable: false } },
  })
  assert.match(disabled.reason, /omc:codex is not routable \(disabled\)/)

  const missing = recommendRoute('oracle', routing, ['omc:codex'], {
    connections: { codex: { state: 'missing', routable: false } },
  })
  assert.match(missing.reason, /omc:codex is not routable \(missing\)/)

  // A registered harness with no record at all is not routable either.
  const unrecorded = recommendRoute('oracle', routing, ['omc:codex'], { connections: {} })
  assert.match(unrecorded.reason, /omc:codex is not routable \(no connection record\)/)
})

test('a billing-blocked connection says which billing blocked it', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const route = recommendRoute('oracle', routing, ['omc:codex'], {
    connections: { codex: { state: 'verified', auth: 'ok', routable: false } },
    billing: { codex: 'api' },
  })
  assert.equal(route.backend, 'native')
  assert.match(route.reason, /omc:codex is not routable \(api billing is not authorized\)/)

  // Routable means the cost question was already answered, so a paid route is
  // picked only when its connection says it may be.
  const authorized = recommendRoute('oracle', routing, ['omc:codex'], {
    connections: { codex: { state: 'routable', auth: 'ok', routable: true } },
    billing: { codex: 'api' },
  })
  assert.equal(authorized.backend, 'native', 'billing authorization still applies on top')
  assert.match(authorized.reason, /api billing is not authorized/)
})

test('omitting connections preserves the pre-connection behaviour exactly', () => {
  const routing = { enabled: true, preset: 'balanced' }
  const legacy = recommendRoute('oracle', routing, ['omc:codex'])
  assert.equal(legacy.backend, 'omc')
  assert.equal(legacy.harness, 'codex')
  assert.equal(legacy.blocked, undefined)

  const withBilling = recommendRoute('oracle', routing, ['omc:codex'], { billing: { codex: 'api' } })
  assert.equal(withBilling.backend, 'native')
  assert.match(withBilling.reason, /api billing is not authorized/)

  // Passing the option as `undefined` is the same as omitting it.
  assert.deepEqual(recommendRoute('oracle', routing, ['omc:codex'], { connections: undefined }), legacy)
})

test('billingAuthorized is exported with the same rule the connection model uses', () => {
  assert.equal(billingAuthorized({ harness: 'codex' }, 'subscription', {}), true)
  assert.equal(billingAuthorized({ harness: 'codex' }, 'api', {}), false)
  assert.equal(billingAuthorized({ harness: 'codex' }, 'api', { allowPaidApi: true }), true)
  assert.equal(billingAuthorized({ harness: 'codex' }, 'unknown', {}), false)
  assert.equal(billingAuthorized({ harness: 'codex' }, 'unknown', { allowUnknownBilling: true }), true)
  assert.equal(billingAuthorized({ authorizeBilling: true }, 'api', {}), true)
})
