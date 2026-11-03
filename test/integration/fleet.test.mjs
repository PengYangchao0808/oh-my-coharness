import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  FLEET_ROLE_IDS,
  fleetRolesPatch,
  normalizeCatalog,
  normalizeExplicit,
  planNativeFleet,
  renderFleetPlan,
  scoreModel,
} from '../../integration/fleet.js'
import {
  demoDirectory,
  demoFiles,
  demoPrompt,
  resolveNodePath,
  seedNativeDemo,
} from '../../integration/demo.js'
import { buildExecutionStatus } from '../../integration/status.js'
import { applyNativeFleet, buildNativeFleet } from '../../src/fleet.js'

const CATALOG_ROWS = [
  { provider: 'zai-coding-cn', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  {
    provider: 'opencode-go',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
  { provider: 'xiaomi-token-plan-cn', models: [{ id: 'mimo-v2.6-pro', name: 'MiMo v2.6 Pro' }] },
  {
    provider: 'kimi-coding',
    models: [
      { id: 'k3.1-pro', name: 'Kimi K3.1 Pro' },
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
    ],
  },
]

const CATALOG = normalizeCatalog(CATALOG_ROWS)

test('catalog normalization drops invalid rows and duplicate routes', () => {
  const rows = normalizeCatalog([
    { provider: 'a', models: [{ id: 'm1', name: 'M1' }, { id: '', name: 'bad' }, { id: 'm1', name: 'dup' }] },
    { provider: '', models: [{ id: 'm2' }] },
    { id: 'b', models: [{ id: 'm3', name: 'M3' }] },
    null,
  ])
  assert.deepEqual(rows.map((row) => row.label), ['a/m1', 'b/m3'])
  assert.equal(rows[0].name, 'M1')
  assert.equal(rows[1].name, 'M3')
})

test('the planner gives each role a distinct, explainable route', () => {
  const plan = planNativeFleet({ catalog: CATALOG, now: new Date('2026-11-02T00:00:00.000Z') })
  const byRole = Object.fromEntries(plan.assignments.map((row) => [row.roleId, row]))
  assert.deepEqual(plan.assignments.map((row) => row.roleId), [...FLEET_ROLE_IDS])
  assert.equal(byRole.oracle.label, 'kimi-coding/k3.1-pro')
  assert.equal(byRole.explorer.label, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(byRole.fixer.label, 'kimi-coding/kimi-for-coding')
  assert.equal(byRole.designer.label, 'xiaomi-token-plan-cn/mimo-v2.6-pro')
  assert.equal(byRole.librarian.label, 'opencode-go/deepseek-v4-flash')
  assert.equal(new Set(plan.assignments.map((row) => row.label)).size, 5)
  for (const row of plan.assignments) {
    assert.equal(row.available, true)
    assert.ok(row.reason.length > 0)
  }
  assert.match(byRole.oracle.reason, /reasoning|pro/i)
})

test('an explicit route wins and an unknown route is kept with a warning', () => {
  const plan = planNativeFleet({
    catalog: CATALOG,
    explicit: {
      oracle: { provider: 'zai-coding-cn', model: 'glm-5.3' },
      fixer: { provider: 'ghost', model: 'not-there' },
    },
  })
  const oracle = plan.assignments.find((row) => row.roleId === 'oracle')
  const fixer = plan.assignments.find((row) => row.roleId === 'fixer')
  assert.equal(oracle.label, 'zai-coding-cn/glm-5.3')
  assert.equal(oracle.explicit, true)
  assert.equal(fixer.label, 'ghost/not-there')
  assert.equal(fixer.available, false)
  assert.ok(plan.warnings.some((warning) => warning.includes('ghost/not-there')))
})

test('the fleet patch only writes a native route and preserves other role fields', () => {
  const plan = planNativeFleet({ catalog: CATALOG })
  const patch = fleetRolesPatch(plan.assignments)
  assert.equal(Object.keys(patch.roles).length, FLEET_ROLE_IDS.length)
  assert.deepEqual(patch.roles.oracle, {
    provider: 'kimi-coding',
    model: 'k3.1-pro',
    execution: { backend: 'native' },
  })
  assert.equal(patch.roles.fixer.execution.backend, 'native')
  assert.equal(patch.roles.orchestrator, undefined)
})

test('a small catalog reuses models and says so', () => {
  const plan = planNativeFleet({ catalog: normalizeCatalog([{ provider: 'p', models: [{ id: 'only' }] }]) })
  assert.equal(plan.assignments.length, FLEET_ROLE_IDS.length)
  assert.ok(plan.assignments.every((row) => row.label === 'p/only'))
  assert.ok(plan.warnings.some((warning) => warning.includes('some roles share a model')))
})

test('an empty catalog leaves roles on the session model', () => {
  const plan = planNativeFleet({ catalog: [] })
  assert.equal(plan.assignments.length, FLEET_ROLE_IDS.length)
  assert.ok(plan.assignments.every((row) => row.label === ''))
  assert.ok(plan.warnings.some((warning) => warning.includes('session model')))
})

test('explicit overrides normalize from both map and array shapes', () => {
  assert.deepEqual(normalizeExplicit([{ role: 'oracle', provider: 'p', model: 'm' }]), {
    oracle: { provider: 'p', model: 'm' },
  })
  assert.deepEqual(normalizeExplicit({ oracle: { model: 'm' }, explorer: {} }), {
    oracle: { provider: '', model: 'm' },
  })
})

test('the preview and the applied report are explicit about state', () => {
  const plan = planNativeFleet({ catalog: CATALOG })
  const preview = renderFleetPlan(plan)
  assert.match(preview, /Preview only/)
  assert.match(preview, /kimi-coding\/k3\.1-pro/)
  const applied = renderFleetPlan(plan, { applied: true, backup: 'C:/backup.json' })
  assert.match(applied, /applied to the live DSH profile/)
  assert.match(applied, /C:\/backup\.json/)
  assert.match(applied, /without a restart/)
})

test('status names the native model route and its catalog verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-fleet-status-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({
    roles: {
      oracle: { provider: 'zai-coding-cn', model: 'glm-5.3' },
      explorer: { provider: 'opencode-go', model: 'gone-model' },
    },
  }), 'utf8')
  const previous = process.env.OH_MY_COHARNESS_CONFIG
  process.env.OH_MY_COHARNESS_CONFIG = file
  try {
    const ctx = {
      get(name) {
        if (name === 'subagents') return { list: () => [] }
        if (name === 'llm') {
          return {
            listProviders: () => [{ id: 'zai-coding-cn' }, { id: 'opencode-go' }],
            listModels: async (provider) => provider === 'zai-coding-cn'
              ? [{ id: 'glm-5.3', name: 'GLM-5.3' }]
              : [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
          }
        }
        return undefined
      },
    }
    const status = await buildExecutionStatus(ctx, {})
    const oracle = status.roles.find((row) => row.roleId === 'oracle')
    const explorer = status.roles.find((row) => row.roleId === 'explorer')
    assert.equal(oracle.execution, 'native · zai-coding-cn/glm-5.3')
    assert.equal(oracle.model, 'glm-5.3')
    assert.equal(oracle.modelAvailable, true)
    assert.equal(explorer.execution, 'native · opencode-go/gone-model')
    assert.equal(explorer.modelAvailable, false)
  } finally {
    if (previous === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
    else process.env.OH_MY_COHARNESS_CONFIG = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fleet inherits complete role routes that already exist in OMD-Slim', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omc-fleet-omd-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const omc = { roles: {} }
  const omd = {
    preset: 'my-dsh-normal',
    presets: {
      'my-dsh-normal': {
        oracle: { provider: 'p', model: 'm1', mcps: [] },
        explorer: { provider: 'p', model: 'm2' },
        // Incomplete routes are ignored: a half route cannot be a DSH target.
        fixer: { model: 'm3' },
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') {
        return {
          describe: () => [
            { ns: 'oh-my-coharness', value: omc, user: omc, revision: 1 },
            { ns: 'oh-my-dsh-slim', value: omd, user: omd, revision: 1 },
          ],
        }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'p' }],
          listModels: async () => [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' }],
        }
      }
      if (name === 'subagents') return { list: () => [] }
      return undefined
    },
  }
  try {
    const { plan } = await buildNativeFleet(ctx)
    const oracle = plan.assignments.find((row) => row.roleId === 'oracle')
    const explorer = plan.assignments.find((row) => row.roleId === 'explorer')
    assert.equal(oracle.label, 'p/m1')
    assert.equal(oracle.preferred, true)
    assert.equal(oracle.reason, 'existing OMD-Slim route')
    assert.equal(explorer.label, 'p/m2')
    assert.equal(plan.assignments.find((row) => row.roleId === 'fixer').preferred, undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('applying a fleet preserves the rest of the settings document and is verifiable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omc-fleet-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let document = {
    dispatch: { maxParallel: 3 },
    roles: {
      oracle: { execution: { backend: 'omc', harness: 'codex' } },
      fixer: { tools: ['read', 'edit'] },
    },
  }
  let revision = 4
  const settings = {
    describe: () => [{ ns: 'oh-my-coharness', value: structuredClone(document), user: structuredClone(document), revision }],
    update: async (ns, next) => {
      assert.equal(ns, 'oh-my-coharness')
      document = structuredClone(next)
      revision += 1
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'p' }],
          listModels: async () => [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }],
        }
      }
      if (name === 'subagents') return { list: () => [] }
      return undefined
    },
  }
  try {
    const { plan } = await buildNativeFleet(ctx, {
      models: { oracle: { provider: 'p', model: 'm1' } },
    })
    const applied = await applyNativeFleet(ctx, plan)
    assert.equal(applied.applied, true)
    assert.equal(applied.mismatch.length, 0)
    assert.ok(applied.backup)
    assert.equal(document.dispatch.maxParallel, 3)
    assert.equal(document.roles.oracle.provider, 'p')
    assert.equal(document.roles.oracle.model, 'm1')
    assert.equal(document.roles.oracle.execution.backend, 'native')
    assert.deepEqual(document.roles.fixer.tools, ['read', 'edit'])
    assert.equal(revision, 5)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the demo seed is deterministic, refuses to overwrite, and names the node executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omc-demo-test-'))
  const dir = join(root, 'run')
  try {
    const seeded = seedNativeDemo({ dir, node: 'C:/node/node.exe' })
    assert.equal(seeded.dir, dir)
    assert.deepEqual(seeded.files, [
      '.omc-demo.json',
      'RUN.md',
      'TASK.md',
      'inventory.mjs',
      'inventory.test.mjs',
    ])
    assert.match(seeded.prompt, /subagent_explorer/)
    assert.match(seeded.prompt, /C:\/node\/node\.exe/)
    assert.match(await readFile(join(dir, 'RUN.md'), 'utf8'), /C:\/node\/node\.exe/)
    assert.match(await readFile(join(dir, 'inventory.mjs'), 'utf8'), /items\.length - 1/)
    assert.throws(() => seedNativeDemo({ dir, node: 'node' }), /OMC\/DEMO-EXISTS/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('demo helpers resolve a node executable and a timestamped directory', () => {
  assert.equal(resolveNodePath({ execPath: 'C:/node/node.exe', resourcesPath: undefined }), 'C:/node/node.exe')
  assert.equal(resolveNodePath({ execPath: 'C:/App.exe', resourcesPath: 'C:/missing' }), 'node')
  const at = new Date('2026-11-02T12:34:56.789Z')
  const dir = demoDirectory({ home: 'C:/home', at })
  assert.match(dir, /omc-demo[\\/]run-2026-11-02T12-34-56-789Z$/)
  assert.match(demoPrompt({ dir: 'C:/demo', node: 'node' }), /C:\/demo/)
  assert.match(demoFiles({ node: 'node' })['.omc-demo.json'], /"version": 1/)
})

test('scoring is stable for the same input', () => {
  const first = scoreModel('oracle', CATALOG.find((row) => row.label === 'zai-coding-cn/glm-5.3'))
  const second = scoreModel('oracle', CATALOG.find((row) => row.label === 'zai-coding-cn/glm-5.3'))
  assert.deepEqual(first, second)
  assert.ok(first.score > 0)
  assert.deepEqual(scoreModel('unknown-role', CATALOG[0]), { score: 0, reasons: [] })
})
