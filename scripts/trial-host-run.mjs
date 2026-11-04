/**
 * PR-07 real host trial entry (zero/full model runs through the real tool).
 *
 * This script is only a boot shell plus the real coharness tool call. It does
 * not decide manifests, budgets or acceptance itself: the tool's trial service
 * performs every preflight, and `executePlan()`/`createHostExecutor()` do the
 * real dispatch. It refuses to run without explicit payment inputs.
 *
 * Usage (isolated .ops profile, installed host):
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   $env:DSH_HOST_ANCHOR = '<installed app.asar>\dsh\lib\bin.js'
 *   $env:DSH_PROFILE_DIR = '<workspace>\.ops\dsh-home\profiles\omc-test'
 *   & '<DeepSeek Harness.exe>' --expose-internals scripts/trial-host-run.mjs `
 *       --manifest <path> --max-usd <n> [--plan-only] `
 *       --receipt <workspace path> --confirm-paid-experiment
 *
 * `--plan-only` runs the real trial plan and writes nothing; it still requires
 * --manifest and --max-usd. An execute requires --receipt and
 * --confirm-paid-experiment as well.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const has = (name) => argv.includes(name)

const manifestPath = option('--manifest')
const receiptPath = option('--receipt')
const maxUsd = Number(option('--max-usd'))
const planOnly = has('--plan-only')
const confirmed = has('--confirm-paid-experiment')
const allowExistingDesktopProfile = has('--allow-existing-desktop-profile')
const nodeExecutableOption = option('--node-executable') ?? process.env.OMC_NODE_EXECUTABLE ?? null

const anchor = process.env.DSH_HOST_ANCHOR
const configuredProfileDir = process.env.DSH_PROFILE_DIR
assert.ok(anchor && isAbsolute(anchor), 'DSH_HOST_ANCHOR must be the installed dsh/lib/bin.js')
assert.ok(configuredProfileDir && isAbsolute(configuredProfileDir), 'DSH_PROFILE_DIR must be an absolute isolated profile')
const profileDir = resolve(configuredProfileDir)
const opsProfile = profileDir.startsWith(root + '/.ops/') || profileDir.startsWith(root + '\\.ops\\')
// The existing desktop profile is real user state. It is accepted only with the
// explicit opt-in and only for this exact, user-authorized path; the default
// remains the isolated .ops profile. This script never edits that profile.
const desktopProfile = resolve(homedir(), '.dsh', 'profiles', 'desktop')
const desktopProfileSelected = profileDir.toLowerCase() === desktopProfile.toLowerCase()
assert.ok(
  opsProfile || (allowExistingDesktopProfile && desktopProfileSelected),
  'the probe only accepts a workspace .ops profile by default; the exact existing desktop profile requires --allow-existing-desktop-profile',
)
let nodeExecutable = null
if (nodeExecutableOption !== null) {
  nodeExecutable = resolve(nodeExecutableOption)
  const name = basename(nodeExecutable).toLowerCase()
  assert.ok(isAbsolute(nodeExecutable) && existsSync(nodeExecutable) && (name === 'node' || name === 'node.exe'),
    '--node-executable must be an existing absolute node/node.exe file')
  process.env.OMC_NODE_EXECUTABLE = nodeExecutable
}
assert.ok(manifestPath && isAbsolute(resolve(manifestPath)), '--manifest <absolute path> is required')
assert.ok(Number.isFinite(maxUsd) && maxUsd > 0, '--max-usd <positive number> is required')
if (planOnly) {
  assert.ok(!receiptPath && !confirmed, '--plan-only never accepts a receipt or paid confirmation')
} else {
  assert.ok(receiptPath && resolve(receiptPath), '--receipt <path> is required for execute')
  assert.ok(confirmed, '--confirm-paid-experiment is required for execute')
}

process.argv[1] = anchor
process.env.DSH_HOME = dirname(dirname(profileDir))
const requireHost = createRequire(anchor)
const hostImport = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const hostBase = pathToFileURL(anchor).href

const watchdog = setTimeout(() => { console.error('OMC_TRIAL_HOST_TIMEOUT'); process.exit(1) }, planOnly ? 60_000 : 30 * 60_000)
let ctx
const runLog = {
  schemaVersion: 1,
  kind: 'omc-trial-host-run',
  at: new Date().toISOString(),
  argv,
  manifestPath: resolve(manifestPath),
  receiptPath: receiptPath ? resolve(receiptPath) : null,
  maxUsd,
  planOnly,
  confirmPaidExperiment: confirmed,
  profileMode: allowExistingDesktopProfile ? 'existing-desktop' : 'isolated-ops',
  nodeExecutable,
  host: null,
  modelCalls: null,
  plan: null,
  execute: null,
  exitCode: null,
}

async function main() {
  const { boot, readProfilePatches } = await hostImport('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await hostImport('@deepseek-ai/dsh-cmdline')
  const profileContext = {
    home: process.env.DSH_HOME,
    dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: anchor,
    name: profileDir.split(/[\\/]/).pop(),
    startedBundles: [],
    bundles: JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles,
    overlays: [],
  }
  const patches = readProfilePatches(profileContext.name, profileContext)
  const requirePackage = createRequire(join(root, 'package.json'))
  const anchorRows = (rows) => {
    for (const row of rows) {
      if (row.name?.startsWith('@deepseek-ai/')) row.name = pathToFileURL(requireHost.resolve(row.name)).href
      if (row.name?.startsWith('oh-my-coharness')) row.name = pathToFileURL(requirePackage.resolve(row.name)).href
      if (row.insert) anchorRows(row.insert)
      if (row.group && Array.isArray(row.config)) anchorRows(row.config)
      if (['directory-picker', 'hmr', 'session-title-llm'].includes(row.id)) row.disabled = true
      if (row.id === 'web-runtime') row.config = { ...row.config, printUrl: false }
    }
  }
  anchorRows(patches)
  ctx = await boot(profileContext.name, join(profileDir, 'cordis.yml'), patches, (rootCtx) => {
    rootCtx.provide('profileContext', profileContext)
    provideCmdline(rootCtx, {
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
      exit: (code) => { throw new Error(`unexpected app exit ${code}`) },
    })
    rootCtx.get('loader').config.bareModuleBaseUrl = hostBase
  }, pathToFileURL(join(profileDir, 'package.json')).href)

  const hostVersion = requireHost('@deepseek-ai/dsh/package.json').version
  runLog.host = { version: hostVersion, profile: profileContext.name, preset: 'oh-my-coharness' }

  const presets = ctx.get('agentPresets')
  const agents = ctx.get('agents')
  const { scopeOf } = await hostImport('@deepseek-ai/dsh-scope')
  const parent = (await agents.create({
    sessionId: 'omc-trial-' + randomUUID(),
    meta: { cwd: root, agentPreset: 'oh-my-coharness' },
    setup: async (childCtx) => { await presets.mount(childCtx, 'oh-my-coharness') },
  })).agent
  const tool = parent.ctx.get('tools').get('coharness', scopeOf(parent.ctx))
  assert.ok(tool, 'the mounted preset must expose the coharness tool')
  const exec = { agent: parent, signal: new AbortController().signal }

  const planValue = await tool.execute({
    action: 'trial',
    trial_action: 'plan',
    trial_manifest: resolve(manifestPath),
    max_usd: maxUsd,
  }, exec)
  const plan = JSON.parse(planValue.text)
  runLog.plan = plan
  console.log('TRIAL_HOST_PLAN ' + JSON.stringify({
    ok: plan.ok,
    mode: plan.mode,
    assignmentCount: plan.plan?.assignmentCount ?? null,
    warnings: plan.plan?.warnings ?? [],
    problems: plan.problems ?? [],
  }))
  if (!plan.ok || (plan.plan?.problems?.length ?? 0) > 0) {
    runLog.exitCode = 2
    console.error('TRIAL_HOST_FAILED ' + JSON.stringify(plan.problems ?? plan.plan?.problems ?? []))
    return
  }
  if (planOnly) {
    runLog.exitCode = 0
    console.log('TRIAL_HOST_PLAN_ONLY_PASS')
    return
  }
  if (existsSync(resolve(receiptPath))) {
    runLog.exitCode = 2
    console.error(`TRIAL_HOST_FAILED receipt already exists: ${resolve(receiptPath)}`)
    return
  }

  const value = await tool.execute({
    action: 'trial',
    trial_action: 'execute',
    trial_manifest: resolve(manifestPath),
    trial_receipt: resolve(receiptPath),
    max_usd: maxUsd,
    confirm_paid_experiment: true,
  }, exec)
  const result = JSON.parse(value.text)
  runLog.execute = result
  runLog.modelCalls = result.trials?.reduce((sum, trial) => sum + (Number.isFinite(trial.calls) ? trial.calls : 1), 0) ?? null
  const trialsOk = Array.isArray(result.trials)
    && result.trials.length > 0
    && result.trials.every((trial) => trial.execution === 'completed' && trial.acceptance === 'passed')
  console.log('TRIAL_HOST_RESULT ' + JSON.stringify({
    ok: result.ok,
    trialsOk,
    code: result.code,
    receiptPath: result.receiptPath,
    spentUsd: result.spentUsd,
    budget: result.budget,
    synthetic: result.synthetic,
    trials: result.trials,
    prerequisites: result.prerequisites,
  }))
  runLog.trialsOk = trialsOk
  runLog.exitCode = result.ok === true && trialsOk ? 0 : 1
  if (runLog.exitCode !== 0) {
    const failed = (result.trials ?? []).filter((trial) => trial.execution !== 'completed' || trial.acceptance !== 'passed')
    console.error('TRIAL_HOST_FAILED ' + JSON.stringify({
      problems: result.problems ?? [],
      failedTrials: failed.map((trial) => ({
        trialId: trial.trialId,
        execution: trial.execution,
        acceptance: trial.acceptance,
        error: trial.error ?? null,
        worktree: trial.worktree ?? null,
      })),
    }, null, 2))
  } else {
    console.log('TRIAL_HOST_PASS')
  }
}

main().catch((error) => {
  runLog.exitCode = 1
  console.error('TRIAL_HOST_FAILED ' + String(error?.stack ?? error))
}).finally(async () => {
  clearTimeout(watchdog)
  try {
    const logPath = receiptPath
      ? `${resolve(receiptPath)}.host.json`
      : join(root, 'docs', 'evidence', 'v0.8', `smoke-host-plan-${basename(resolve(manifestPath)).replace(/[^A-Za-z0-9._-]+/g, '-')}.json`)
    if (existsSync(dirname(logPath))) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(logPath, JSON.stringify(runLog, null, 2) + '\n', { flag: 'wx' })
    }
  } catch { /* the primary result is already reported */ }
  if (ctx) {
    try { await ctx.fiber.dispose() } catch { /* host teardown */ }
  }
  process.exit(runLog.exitCode ?? 1)
})
