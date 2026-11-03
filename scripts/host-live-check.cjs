// No-model installed-host check. Run using the host's Node/Electron runtime:
// DSH_HOST_ANCHOR=<absolute installed dsh/lib/bin.js> node --expose-internals scripts/host-live-check.cjs
// DSH_PROFILE_DIR must point at an ISOLATED profile that links this checkout.
// Host boot/anchor patterns adapted from oh-my-dsh-slim's MIT-licensed installed-
// host probes; Copyright (c) 2026 oh-my-dsh-slim contributors. See vendor/omd/LICENSE.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')

const anchor = process.env.DSH_HOST_ANCHOR
const configuredProfileDir = process.env.DSH_PROFILE_DIR
assert.ok(anchor && path.isAbsolute(anchor), 'DSH_HOST_ANCHOR must be an installed absolute host entry')
assert.ok(configuredProfileDir && path.isAbsolute(configuredProfileDir), 'DSH_PROFILE_DIR must name an isolated test profile')
const profileDir = path.resolve(configuredProfileDir)
const root = path.resolve(__dirname, '..')
assert.ok(profileDir.startsWith(root + path.sep + '.ops' + path.sep), 'the probe only accepts a workspace .ops profile')
const external = process.argv.includes('--external')
if (external) {
  const configPath = path.join(profileDir, 'omc-smoke-roles.json')
  fs.writeFileSync(configPath, JSON.stringify({ roles: { oracle: { execution: { backend: 'omc', harness: 'codex' } } } }))
  process.env.OH_MY_COHARNESS_CONFIG = configPath
}
process.argv[1] = anchor
process.env.DSH_HOME = path.dirname(path.dirname(profileDir))
const requireHost = createRequire(anchor)
const hostImport = name => import(pathToFileURL(requireHost.resolve(name)).href)
const hostBase = pathToFileURL(anchor).href
let ctx
const watchdog = setTimeout(() => { console.error('OMC_HOST_LIVE_TIMEOUT'); process.exit(1) }, 45000)
;(async () => {
  try {
    const { boot, readProfilePatches } = await hostImport('@deepseek-ai/dsh-app-boot')
    const { provideCmdline } = await hostImport('@deepseek-ai/dsh-cmdline')
    const profileContext = { home: process.env.DSH_HOME, dir: profileDir, patchPath: path.join(profileDir, 'cordis.patch.yml'),
      installAnchor: anchor, name: path.basename(profileDir), startedBundles: [],
      bundles: JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'))).dsh.profile.bundles, overlays: [] }
    const patches = readProfilePatches(profileContext.name, profileContext)
    const requirePackage = createRequire(path.join(root, 'package.json'))
    const anchorRows = rows => { for (const row of rows) {
      if (row.name?.startsWith('@deepseek-ai/')) row.name = pathToFileURL(requireHost.resolve(row.name)).href
      if (row.name?.startsWith('oh-my-coharness')) row.name = pathToFileURL(requirePackage.resolve(row.name)).href
      if (row.insert) anchorRows(row.insert)
      if (row.group && Array.isArray(row.config)) anchorRows(row.config)
      if (row.id === 'directory-picker' || row.id === 'hmr' || row.id === 'session-title-llm') row.disabled = true
      if (row.id === 'web-runtime') row.config = { ...row.config, printUrl: false }
    } }
    anchorRows(patches)
    ctx = await boot(profileContext.name, path.join(profileDir, 'cordis.yml'), patches, rootCtx => {
      rootCtx.provide('profileContext', profileContext)
      provideCmdline(rootCtx, { args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], exit: code => { throw new Error('unexpected app exit ' + code) } })
      rootCtx.get('loader').config.bareModuleBaseUrl = hostBase
    }, pathToFileURL(path.join(profileDir, 'package.json')).href)
    const presets = ctx.get('agentPresets')
    assert.equal((await presets.resolve('oh-my-coharness')).id, 'oh-my-coharness')
    const agents = ctx.get('agents')
    const { scopeOf } = await hostImport('@deepseek-ai/dsh-scope')
    const parent = (await agents.create({ sessionId: 'omc-live-' + randomUUID(), meta: { cwd: root, agentPreset: 'oh-my-coharness' },
      setup: async childCtx => { await presets.mount(childCtx, 'oh-my-coharness') } })).agent
    const tools = parent.ctx.get('tools')
    const getTool = name => tools.get(name, scopeOf(parent.ctx))
    for (const name of ['subagent_oracle', 'subagent_explorer', 'subagent_fixer', 'subagent_designer', 'subagent_librarian', 'send_message', 'interrupt_agent', 'subagent_result', 'coharness']) {
      assert.ok(getTool(name), 'missing mounted tool ' + name)
    }
    if (external) {
      assert.ok(getTool('subagent_oracle').parameters.lane, 'external lane parameter is mounted')
      assert.ok(getTool('subagent_oracle').parameters.changed_files, 'external handoff parameter is mounted')
    }
    const value = await getTool('coharness').execute({ action: 'tasks' }, { agent: parent, signal: new AbortController().signal })
    assert.deepEqual(JSON.parse(value.text), [])
    const settings = ctx.get('settings').describe().find(row => row.ns === 'oh-my-coharness')
    assert.ok(settings)
    const hostVersion = requireHost('@deepseek-ai/dsh/package.json').version
    console.log('OMC_HOST_LIVE_PASS ' + JSON.stringify({ hostVersion, preset: 'oh-my-coharness', externalOracle: external, tools: 9, modelCalls: 0 }))
  } finally {
    clearTimeout(watchdog)
    if (ctx) await ctx.fiber.dispose()
  }
})().then(() => process.exit(0), error => { console.error('OMC_HOST_LIVE_FAILED', error.stack); process.exit(1) })
