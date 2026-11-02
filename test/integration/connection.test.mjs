import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONNECTION_STATES,
  connectionFor,
  connectionTable,
  isRoutable,
} from '../../src/connection.js'
import { harnessDef } from '../../src/harnesses.js'
import { buildExecutionStatus, renderExecutionStatus } from '../../integration/status.js'

/** A minimal resolved-config shape: one harness entry plus routing. */
function cfgFor({ id = 'codex', enabled = true, billing, verify = null, authorizeBilling } = {}, routing = {}) {
  const entry = { enabled }
  if (billing !== undefined) entry.billing = billing
  if (verify !== null) entry.verify = verify
  if (authorizeBilling !== undefined) entry.authorizeBilling = authorizeBilling
  return { harnesses: { [id]: entry }, routing }
}

const manualVerify = {
  accepted: true,
  at: '2026-10-30T09:00:00.000Z',
  mode: 'read-only',
  note: 'ran agy once and read a file',
}

test('the state list is frozen and ordered weakest-first', () => {
  assert.deepEqual([...CONNECTION_STATES], [
    'disabled',
    'missing',
    'installed',
    'authenticated',
    'verified',
    'routable',
  ])
  assert.equal(Object.isFrozen(CONNECTION_STATES), true)
  assert.deepEqual(
    [connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor(), auth: 'ok' }).id],
    ['codex'],
  )
})

test('a disabled harness stops at disabled with every flag false', () => {
  const connection = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ enabled: false }),
    auth: 'ok',
  })
  assert.equal(connection.state, 'disabled')
  for (const flag of ['installed', 'authenticated', 'verified', 'routable']) {
    assert.equal(connection[flag], false, flag)
  }
  assert.equal(connection.reason, 'disabled in config')
  // A missing key is not an enabled harness either.
  assert.equal(connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: { harnesses: {} } }).state, 'disabled')
})

test('missing is the pre-state of installed: the binary is absent', () => {
  const connection = connectionFor({
    id: 'antigravity',
    def: harnessDef('antigravity'),
    cfg: cfgFor({ id: 'antigravity' }),
    auth: 'missing',
  })
  assert.equal(connection.state, 'missing')
  assert.equal(connection.installed, false)
  assert.equal(connection.authenticated, false)
  assert.equal(connection.routable, false)
  assert.equal(connection.reason, 'agy is not installed (binary missing)')
})

test('a signed-out CLI is installed but not authenticated', () => {
  const connection = connectionFor({
    id: 'antigravity',
    def: harnessDef('antigravity'),
    cfg: cfgFor({ id: 'antigravity' }),
    auth: 'signed-out',
  })
  assert.equal(connection.state, 'installed')
  assert.equal(connection.installed, true)
  assert.equal(connection.authenticated, false)
  assert.equal(connection.verified, false)
  assert.equal(connection.routable, false)
  assert.match(connection.reason, /^signed-out: agy is installed but has no usable login$/)
})

test('unknown auth is never authenticated', () => {
  for (const auth of ['unknown', undefined, null, '', 'weird']) {
    const connection = connectionFor({
      id: 'codex',
      def: harnessDef('codex'),
      cfg: cfgFor(),
      auth,
    })
    assert.equal(connection.auth, 'unknown', String(auth))
    assert.equal(connection.state, 'installed', String(auth))
    assert.equal(connection.authenticated, false, String(auth))
    assert.equal(connection.routable, false, String(auth))
    assert.match(connection.reason, /^auth unknown: the login could not be verified non-interactively/)
    assert.match(connection.reason, /record harnesses\.codex\.verify\.accepted/)
  }
})

test('an authenticated but argv-unverified harness stops at authenticated', () => {
  const connection = connectionFor({
    id: 'qwen',
    def: harnessDef('qwen'),
    cfg: cfgFor({ id: 'qwen' }),
    auth: 'ok',
  })
  assert.equal(harnessDef('qwen').verified, false)
  assert.equal(connection.state, 'authenticated')
  assert.equal(connection.authenticated, true)
  assert.equal(connection.verified, false)
  assert.equal(connection.routable, false)
  assert.equal(connection.reason, 'auth ok; the invocation is not field-verified for read-only use')
})

test('a manual verify record upgrades unknown auth to authenticated and verified', () => {
  const connection = connectionFor({
    id: 'antigravity',
    def: harnessDef('antigravity'),
    cfg: cfgFor({ id: 'antigravity', verify: manualVerify }),
    auth: 'unknown',
  })
  assert.equal(connection.authenticated, true)
  assert.equal(connection.verified, true)
  assert.equal(connection.routable, true)
  assert.equal(connection.state, 'routable')
  assert.match(connection.reason, /^authenticated by manual verify; read-only invocation verified/)

  // The record upgrades verification even for a def whose argv was never tested.
  const custom = { id: 'custom', bin: 'custom', billing: 'subscription', verified: false }
  const upgraded = connectionFor({
    id: 'custom',
    def: custom,
    cfg: cfgFor({ id: 'custom', verify: manualVerify }),
    auth: 'unknown',
  })
  assert.equal(upgraded.verified, true)
  assert.equal(upgraded.routable, true)
})

test('api and unknown billing block routable unless the routing authorizes it', () => {
  const paid = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ billing: 'api' }),
    auth: 'ok',
  })
  assert.equal(paid.state, 'verified')
  assert.equal(paid.verified, true)
  assert.equal(paid.routable, false)
  assert.equal(paid.authorization, 'blocked')
  assert.equal(paid.reason, 'auth ok; api billing is not authorized for automatic routing')

  const paidAllowed = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ billing: 'api' }, { allowPaidApi: true }),
    auth: 'ok',
  })
  assert.equal(paidAllowed.state, 'routable')
  assert.equal(paidAllowed.authorization, 'api-authorized')

  const unknown = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ billing: 'unknown' }),
    auth: 'ok',
  })
  assert.equal(unknown.routable, false)
  assert.equal(unknown.reason, 'auth ok; unknown billing is not authorized for automatic routing')

  const unknownAllowed = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ billing: 'unknown' }, { allowUnknownBilling: true }),
    auth: 'ok',
  })
  assert.equal(unknownAllowed.routable, true)
  assert.equal(unknownAllowed.authorization, 'unknown-authorized')
})

test('a per-harness authorizeBilling wins over the routing switches', () => {
  const connection = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ billing: 'api', authorizeBilling: true }),
    auth: 'ok',
  })
  assert.equal(connection.authorization, 'api-authorized')
  assert.equal(connection.routable, true)
})

test('a subscription route is routable when the login and argv are proven', () => {
  const connection = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor(),
    auth: 'ok',
  })
  assert.equal(connection.state, 'routable')
  assert.equal(connection.authorization, 'subscription')
  assert.equal(connection.reason, 'auth ok; read-only invocation verified; subscription billing authorized (subscription)')
  assert.equal(isRoutable(connection), true)
  assert.equal(isRoutable({ routable: true, state: 'verified' }), false)
  assert.equal(isRoutable(undefined), false)
})

test('the six states are all reachable and nothing else is produced', () => {
  const reached = new Set([
    connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor({ enabled: false }), auth: 'ok' }).state,
    connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor(), auth: 'missing' }).state,
    connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor(), auth: 'signed-out' }).state,
    connectionFor({ id: 'qwen', def: harnessDef('qwen'), cfg: cfgFor({ id: 'qwen' }), auth: 'ok' }).state,
    connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor({ billing: 'api' }), auth: 'ok' }).state,
    connectionFor({ id: 'codex', def: harnessDef('codex'), cfg: cfgFor(), auth: 'ok' }).state,
  ])
  assert.deepEqual([...reached].sort(), [...CONNECTION_STATES].sort())
})

test('the table is built from doctor rows and degrades without them', () => {
  const harnesses = [harnessDef('codex'), harnessDef('antigravity'), harnessDef('qwen')]
  const rows = [
    { id: 'codex', auth: 'ok' },
    { id: 'antigravity', auth: 'signed-out' },
    { id: 'not-a-harness', auth: 'ok' },
  ]
  const table = connectionTable({
    harnesses,
    cfg: { harnesses: { codex: { enabled: true }, antigravity: { enabled: true }, qwen: { enabled: true } } },
    rows,
  })
  assert.deepEqual(Object.keys(table).sort(), ['antigravity', 'codex', 'qwen'])
  assert.equal(table.codex.state, 'routable')
  assert.equal(table.antigravity.state, 'installed')
  assert.equal(table.antigravity.authenticated, false)
  assert.equal(table.qwen.auth, 'unknown')

  // No report at all: every row is `auth: unknown`, which is never authenticated.
  const blind = connectionTable({
    harnesses,
    cfg: { harnesses: { codex: { enabled: true }, antigravity: { enabled: true }, qwen: { enabled: true } } },
  })
  for (const id of ['codex', 'antigravity', 'qwen']) {
    assert.equal(blind[id].auth, 'unknown', id)
    assert.equal(blind[id].authenticated, false, id)
    assert.equal(blind[id].routable, false, id)
  }
})

test('the table lets a manual verify record survive a missing report', () => {
  const table = connectionTable({
    harnesses: [harnessDef('antigravity')],
    cfg: { harnesses: { antigravity: { enabled: true, verify: manualVerify } } },
  })
  assert.equal(table.antigravity.auth, 'unknown')
  assert.equal(table.antigravity.authenticated, true)
  assert.equal(table.antigravity.routable, true)
})

test('the table accepts ids and records as well as definitions', () => {
  const byId = connectionTable({ harnesses: ['codex'], cfg: { harnesses: { codex: { enabled: true } } }, rows: [{ id: 'codex', auth: 'ok' }] })
  const byRecord = connectionTable({
    harnesses: { codex: harnessDef('codex') },
    cfg: { harnesses: { codex: { enabled: true } } },
    rows: [{ id: 'codex', auth: 'ok' }],
  })
  // An id alone proves the login but not the argv: `def.verified` lives on the def.
  assert.equal(byId.codex.state, 'authenticated')
  assert.equal(byRecord.codex.state, 'routable')
  assert.equal(byRecord.codex.reason, 'auth ok; read-only invocation verified; subscription billing authorized (subscription)')
})

test('a failed probe is installed-unverifiable, never missing and never routable', () => {
  // Cold start: the WSL probe threw before it could prove anything. The verdict
  // is unavailable, not negative.
  const failed = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor(),
    auth: 'unknown',
    probeFailed: true,
    detail: 'Wsl/E_DISTRO_UNAVAILABLE',
  })
  assert.equal(failed.state, 'installed')
  assert.equal(failed.installed, true)
  assert.equal(failed.authenticated, false)
  assert.equal(failed.verified, false)
  assert.equal(failed.routable, false)
  assert.equal(isRoutable(failed), false)
  assert.match(failed.reason, /probe failed \(Wsl\/E_DISTRO_UNAVAILABLE\)/)
  assert.match(failed.reason, /re-run \/coharness doctor/)
  assert.doesNotMatch(failed.reason, /not installed/)

  // The same row *without* the flag is a completed negative verdict.
  const absent = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor(),
    auth: 'missing',
    detail: 'OMC/CLI-MISSING',
  })
  assert.equal(absent.state, 'missing')
  assert.equal(absent.installed, false)
  assert.equal(absent.routable, false)
  assert.equal(absent.reason, 'codex is not installed (binary missing)')

  // A failed probe is not routable even when the row would otherwise qualify:
  // the login was never verified, so no route may be picked automatically.
  const healthyLooking = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor(),
    auth: 'ok',
    probeFailed: true,
    detail: 'OMC/SPAWN-TIMEOUT',
  })
  assert.equal(healthyLooking.state, 'installed')
  assert.equal(healthyLooking.routable, false)
  assert.match(healthyLooking.reason, /probe failed \(OMC\/SPAWN-TIMEOUT\)/)

  // A disabled harness stays disabled: a failed probe never enables anything.
  const off = connectionFor({
    id: 'codex',
    def: harnessDef('codex'),
    cfg: cfgFor({ enabled: false }),
    probeFailed: true,
    detail: 'ENOENT',
  })
  assert.equal(off.state, 'disabled')
})

test('the table forwards a failed probe instead of flattening it to missing', () => {
  const table = connectionTable({
    harnesses: [harnessDef('codex'), harnessDef('opencode')],
    cfg: { harnesses: { codex: { enabled: true }, opencode: { enabled: true } } },
    rows: [
      { id: 'codex', auth: 'unknown', source: 'probe', probeFailed: true, detail: 'Wsl/E_NO_DISTRO' },
      { id: 'opencode', auth: 'missing', source: 'probe', detail: 'OMC/CLI-MISSING' },
    ],
  })
  assert.equal(table.codex.state, 'installed')
  assert.equal(table.codex.routable, false)
  assert.match(table.codex.reason, /probe failed \(Wsl\/E_NO_DISTRO\)/)
  assert.equal(table.opencode.state, 'missing')
})

function statusCtx(providers) {
  return {
    get(name) {
      if (name === 'subagents') return { list: () => providers }
      return undefined
    },
  }
}

/** Status fixtures read the role config from a temp file, like the real seam. */
async function withRoleConfig(document, run) {
  const dir = await mkdtemp(join(tmpdir(), 'omc-connection-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify(document), 'utf8')
  const previous = process.env.OH_MY_COHARNESS_CONFIG
  process.env.OH_MY_COHARNESS_CONFIG = file
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
    else process.env.OH_MY_COHARNESS_CONFIG = previous
  }
}

test('status carries a connection per role and per harness and hides unusable recommendations', async () => {
  const report = { at: '2026-10-30T09:00:00.000Z', rows: [{ id: 'codex', auth: 'signed-out' }] }
  const status = await withRoleConfig({ preset: 'my-dsh-normal', roles: {}, presets: { 'my-dsh-normal': {} } }, () =>
    buildExecutionStatus(
      statusCtx(['spawn', 'omc:codex']),
      { routing: { enabled: true, preset: 'balanced' } },
      { report },
    ),
  )
  assert.equal(status.connectionSource, 'doctor')
  assert.equal(status.connectionAt, report.at)
  assert.equal(status.connections.codex.state, 'installed')
  assert.equal(status.connections.codex.routable, false)

  const codex = status.harnesses.find((row) => row.id === 'codex')
  assert.equal(codex.state, 'installed')
  assert.match(codex.reason, /^signed-out: codex is installed but has no usable login/)
  assert.equal(codex.routable, false)
  assert.equal(codex.auth, 'signed-out')

  // Oracle prefers Codex, but a signed-out CLI is never auto-selected.
  const oracle = status.roles.find((row) => row.roleId === 'oracle')
  assert.equal(oracle.backend, 'native')
  assert.equal(oracle.connection, null)
  assert.match(oracle.policy.reason, /omc:codex is not routable \(signed-out\)/)

  const lines = renderExecutionStatus(status)
  const harnessLine = lines.find((line) => line.startsWith('  codex '))
  assert.match(harnessLine, /enforced\s+signed-out · not routable/)
  assert.ok(lines.includes(`connection: from doctor report at ${report.at}`))
  assert.ok(!lines.some((line) => /recommended:/.test(line)), 'a non-routable harness must not be recommended')
})

test('status degrades to auth unknown without a report and says so', async () => {
  const status = await withRoleConfig({ preset: 'my-dsh-normal', roles: {}, presets: { 'my-dsh-normal': {} } }, () =>
    buildExecutionStatus(statusCtx(['spawn', 'omc:codex']), { routing: { enabled: true, preset: 'balanced' } }),
  )
  assert.equal(status.connectionSource, 'unknown')
  assert.equal(status.connections.codex.auth, 'unknown')
  assert.equal(status.connections.codex.authenticated, false)
  assert.equal(status.connections.codex.routable, false)
  const lines = renderExecutionStatus(status)
  assert.ok(lines.includes('connection: unknown (run /coharness doctor)'))
  assert.ok(!lines.some((line) => /recommended:/.test(line)))
})

test('a doctor-accepted route is the only one status recommends', async () => {
  const report = { at: '2026-10-30T09:00:00.000Z', rows: [{ id: 'codex', auth: 'ok' }] }
  const status = await withRoleConfig({ preset: 'my-dsh-normal', roles: {}, presets: { 'my-dsh-normal': {} } }, () =>
    buildExecutionStatus(
      statusCtx(['spawn', 'omc:codex']),
      // Billing must be stated explicitly: an unset endpoint is `unknown`, and
      // unknown billing is never treated as free by automatic routing.
      { routing: { enabled: true, preset: 'balanced' }, harnesses: { codex: { billing: 'subscription' } } },
      { report },
    ),
  )
  assert.equal(status.connections.codex.state, 'routable')
  assert.equal(status.connections.codex.authorization, 'subscription')
  const lines = renderExecutionStatus(status)
  assert.ok(lines.some((line) => /recommended: oracle→omc:codex \(subscription\)/.test(line)))
  const harnessLine = lines.find((line) => line.startsWith('  codex '))
  assert.match(harnessLine, /enforced\s+routable \(subscription\)/)
})

test('an unset billing keeps a healthy CLI out of automatic routing', async () => {
  // Same probe result, but the endpoint billing is unknown: registered and
  // signed in is still not routable, and the reason names the gate.
  const report = { at: '2026-10-30T09:00:00.000Z', rows: [{ id: 'codex', auth: 'ok' }] }
  const status = await withRoleConfig({ preset: 'my-dsh-normal', roles: {}, presets: { 'my-dsh-normal': {} } }, () =>
    buildExecutionStatus(statusCtx(['spawn', 'omc:codex']), { routing: { enabled: true, preset: 'balanced' } }, { report }),
  )
  assert.equal(status.connections.codex.state, 'verified')
  assert.equal(status.connections.codex.authorization, 'blocked')
  assert.match(status.connections.codex.reason, /unknown billing is not authorized/)
  assert.equal(status.routing.recommendations.oracle.backend, 'native')
})
