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

// ── model catalog: envelope, options, diagnostics ────────────────────────────
const tZh = (key) => exports.dictionaries.zh[key] ?? key
const tEn = (key) => exports.dictionaries.en[key] ?? key

/** A catalog payload shaped like the documented DSH 0.2.1-rc.5 contract. */
function catalogValue(extra = {}) {
  return {
    default: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    routableProviders: ['deepseek', 'anthropic'],
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
            reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
          },
        ],
      },
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] },
      // buildModelCatalog drops empty provider groups; the card keeps that rule.
      { id: 'broken', name: 'Broken', models: [] },
    ],
    failures: [],
    ...extra,
  }
}

test('a successful catalog call becomes a ready state with every route selectable', () => {
  const state = exports.modelCatalogState({ ok: true, value: catalogValue() })
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.groups.map((group) => group.id), ['deepseek', 'anthropic'])
  assert.deepEqual(state.routableProviders, ['deepseek', 'anthropic'])
  assert.deepEqual(state.defaultRoute, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })

  const { options, value, notice } = exports.modelOptions(state, {}, tZh)
  // Inherit is a first-class first entry, never a placeholder.
  assert.deepEqual(options[0], { kind: 'inherit', value: '', label: exports.dictionaries.zh.modelInherit })
  assert.equal(value, '')
  assert.equal(notice, undefined)
  assert.deepEqual(
    options.filter((option) => option.kind === 'model').map((option) => option.value),
    ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'anthropic/claude'],
  )
  // A usable catalog is never reduced to the inherit entry alone.
  assert.ok(options.filter((option) => option.kind !== 'notice').length > 1)
  assert.equal(options.some((option) => option.kind === 'notice'), false)
})

test('a returned catalog error keeps the host message and its code', () => {
  const state = exports.modelCatalogState({
    ok: false,
    error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'provider registry unavailable' },
  })
  assert.equal(state.status, 'error')
  assert.equal(state.reason, 'provider registry unavailable (MODEL_CATALOG_UNAVAILABLE)')

  const notice = exports.modelOptions(state, {}, tZh).notice
  assert.equal(notice, '模型目录不可用：provider registry unavailable (MODEL_CATALOG_UNAVAILABLE)')
  // The notice is a disabled option, not the selected value.
  assert.equal(exports.modelOptions(state, {}, tZh).value, '')
})

test('a thrown catalog error and a missing remote face keep their own words', () => {
  const thrown = exports.modelCatalogState(undefined, new Error('boom'))
  assert.equal(thrown.status, 'error')
  assert.equal(thrown.reason, 'boom')

  const missing = exports.modelCatalogState(undefined, tZh('modelsUnavailable'))
  assert.equal(missing.status, 'error')
  assert.equal(missing.reason, '当前会话未提供模型目录接口')
  assert.equal(exports.modelOptions(missing, {}, tEn).notice, `Model catalog unavailable: ${missing.reason}`)

  // No envelope and no failure is "still loading", not an error.
  const loading = exports.modelCatalogState()
  assert.equal(loading.status, 'loading')
  assert.equal(exports.modelOptions(loading, {}, tZh).notice, '模型目录加载中…')
})

test('an empty catalog with provider failures names them instead of blaming the host', () => {
  const state = exports.modelCatalogState({
    ok: true,
    value: {
      groups: [],
      routableProviders: [],
      failures: [
        { id: 'anthropic', name: 'Anthropic', message: 'not signed in' },
        { id: 'deepseek', name: 'DeepSeek', message: 'no models returned' },
      ],
    },
  })
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.failures.map((row) => row.id), ['anthropic', 'deepseek'])

  const { notice, options } = exports.modelOptions(state, {}, tZh)
  assert.equal(notice, '没有可用模型（2 个 provider 失败）：Anthropic, DeepSeek')
  assert.match(notice, /没有可用模型/)
  assert.equal(options.at(-1).kind, 'notice')
  assert.equal(options.at(-1).disabled, true)

  const diagnostics = exports.modelCatalogDiagnostics(state, tZh)
  assert.equal(diagnostics.notice, notice)
  assert.deepEqual(
    diagnostics.failures.map((row) => row.text),
    ['Anthropic：not signed in', 'DeepSeek：no models returned'],
  )
  assert.equal(diagnostics.routableText, '可路由 provider：0')
  assert.equal(diagnostics.defaultText, undefined)
})

test('the diagnostics count routable providers and name the host default route', () => {
  const diagnostics = exports.modelCatalogDiagnostics(exports.modelCatalogState({ ok: true, value: catalogValue() }), tZh)
  assert.equal(diagnostics.notice, '模型目录已就绪（2 个 provider）')
  assert.equal(diagnostics.routableText, '可路由 provider：2 · deepseek, anthropic')
  assert.equal(diagnostics.defaultText, '默认模型：deepseek/deepseek-chat')
  assert.deepEqual(diagnostics.failures, [])
})

test('a stored route outside the catalog stays selectable as the current value', () => {
  const state = exports.modelCatalogState({ ok: true, value: catalogValue() })
  const outside = exports.modelOptions(state, { provider: 'local', model: 'my-model' }, tZh)
  assert.equal(outside.value, 'local/my-model')
  assert.equal(outside.options[0].kind, 'inherit')
  assert.deepEqual(
    outside.options.find((option) => option.kind === 'current'),
    { kind: 'current', value: 'local/my-model', label: '当前值: local/my-model' },
  )
  // A route the catalog DOES list needs no current-value duplicate.
  const inside = exports.modelOptions(state, { provider: 'deepseek', model: 'deepseek-chat' }, tZh)
  assert.equal(inside.value, 'deepseek/deepseek-chat')
  assert.equal(inside.options.some((option) => option.kind === 'current'), false)
})

// ── draft round-trip: dropdown and manual route boxes ────────────────────────
function roleOps(base, user, draft, roleId, fields) {
  return exports.planUserOps(base, user, draft)
    .filter((op) => op.path.at(-2) === roleId && fields.includes(op.path.at(-1)))
}

test('picking a model writes both route halves and inherit unsets them', () => {
  const roleId = 'oracle'
  const start = exports.buildDraft(effectiveWith(undefined), { roles: {} }, base)
  const routed = {
    ...start,
    roles: { ...start.roles, [roleId]: { ...start.roles[roleId], ...exports.roleModelPatch('deepseek', 'deepseek-reasoner') } },
  }
  assert.deepEqual(roleOps(base, {}, routed, roleId, ['provider', 'model']), [
    { op: 'set', path: ['presets', presetName, roleId, 'provider'], value: 'deepseek' },
    { op: 'set', path: ['presets', presetName, roleId, 'model'], value: 'deepseek-reasoner' },
  ])
  const written = exports.draftToConfig(routed, {}, base)
  assert.equal(written.presets[presetName][roleId].provider, 'deepseek')
  assert.equal(written.presets[presetName][roleId].model, 'deepseek-reasoner')

  // Choosing "inherit" clears both halves of the stored route.
  const user = { presets: { [presetName]: { [roleId]: { provider: 'deepseek', model: 'deepseek-reasoner' } } } }
  const inherited = {
    ...routed,
    roles: { ...routed.roles, [roleId]: { ...routed.roles[roleId], ...exports.roleModelPatch(undefined, undefined) } },
  }
  assert.deepEqual(roleOps(base, user, inherited, roleId, ['provider', 'model']), [
    { op: 'unset', path: ['presets', presetName, roleId, 'provider'] },
    { op: 'unset', path: ['presets', presetName, roleId, 'model'] },
  ])
  assert.equal(exports.draftToConfig(inherited, {}, base).presets[presetName]?.[roleId]?.provider, undefined)
})

test('the manual route boxes write the same two fields, and a half route saves as inherit', () => {
  const roleId = 'oracle'
  const start = exports.buildDraft(effectiveWith(undefined), { roles: {} }, base)
  const empty = start.roles[roleId]
  const typedProvider = { ...empty, ...exports.manualRoutePatch(empty, 'provider', ' deepseek ') }
  assert.deepEqual(exports.manualRoutePatch(empty, 'provider', ' deepseek '), { provider: 'deepseek' })
  assert.equal(typedProvider.provider, 'deepseek')
  // A single typed half keeps the other box untouched and the route-bound
  // settings alone: the user is still completing the route.
  assert.deepEqual(exports.manualRoutePatch(typedProvider, 'model', 'deepseek-reasoner'), { model: 'deepseek-reasoner' })
  const typed = { ...typedProvider, ...exports.manualRoutePatch(typedProvider, 'model', 'deepseek-reasoner') }
  const manual = { ...start, roles: { ...start.roles, [roleId]: typed } }
  assert.deepEqual(roleOps(base, {}, manual, roleId, ['provider', 'model']), [
    { op: 'set', path: ['presets', presetName, roleId, 'provider'], value: 'deepseek' },
    { op: 'set', path: ['presets', presetName, roleId, 'model'], value: 'deepseek-reasoner' },
  ])

  // Clearing both boxes is the dropdown's "inherit": route gone, and the
  // route-bound effort/cap cleared with it.
  const half = { ...typed, ...exports.manualRoutePatch(typed, 'model', '') }
  assert.equal(half.model, undefined)
  const user = { presets: { [presetName]: { [roleId]: { provider: 'deepseek', model: 'deepseek-reasoner' } } } }
  assert.deepEqual(roleOps(base, user, { ...start, roles: { ...start.roles, [roleId]: half } }, roleId, ['provider', 'model']), [
    { op: 'unset', path: ['presets', presetName, roleId, 'provider'] },
    { op: 'unset', path: ['presets', presetName, roleId, 'model'] },
  ])
  const cleared = { ...half, ...exports.manualRoutePatch(half, 'provider', '') }
  assert.equal(cleared.provider, undefined)
  assert.equal(cleared.model, undefined)
  assert.equal(cleared.effort, 'none')
  assert.equal(cleared.maxTokens, undefined)
  // A half route never reaches the stored document.
  const halfConfig = exports.draftToConfig({ ...start, roles: { ...start.roles, [roleId]: half } }, {}, base)
  assert.equal(halfConfig.presets[presetName]?.[roleId]?.provider, undefined)
  assert.equal(halfConfig.presets[presetName]?.[roleId]?.model, undefined)
})

// ── card structure ──────────────────────────────────────────────────────────
test('both dictionaries define the same labels', () => {
  const { zh, en } = exports.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', key)
    assert.ok(zh[key].length > 0, `zh.${key} is empty`)
    assert.ok(en[key].length > 0, `en.${key} is empty`)
  }
  for (const key of [
    'tabCli', 'tabRoles', 'tabsLabel', 'cliTabHint',
    'modelsRefresh', 'modelsErrorReason', 'modelsAllFailed', 'modelsFailureLine', 'modelsReady',
    'modelsRoutable', 'modelsDefault', 'modelsUnavailable',
    'manualProvider', 'manualModel', 'manualRouteHint',
    'harnessState', 'harnessRoutable', 'harnessNotRoutable',
  ]) {
    assert.ok(key in zh && key in en, `missing locale key ${key}`)
  }
})

test('the card is split into two accessible tabs above one shared save chrome', () => {
  assert.match(source, /role: 'tablist'/)
  assert.match(source, /role: 'tab'/)
  assert.match(source, /role: 'tabpanel'/)
  assert.match(source, /'aria-selected': active === entry\.id/)
  assert.match(source, /'aria-controls': `\$\{NS\}-panel-\$\{entry\.id\}`/)
  // Local tab state, defaulting to the external CLI tab.
  assert.match(source, /React\.useState\('cli'\)/)
  // The refresh button and the single automatic retry both exist, and the
  // retry timer is owned by an effect so an unmount clears it.
  assert.match(source, /t\('modelsRefresh'\)/)
  assert.match(source, /MODEL_RETRY_DELAY_MS/)
  assert.match(source, /clearTimeout\(timer\)/)
  assert.match(source, /modelsAllFailed/)
})

