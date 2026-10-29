/**
 * Doctor: what exists, where, and whether we may trust it.
 *
 * Rules this module keeps (PLAN §6.6):
 *   - no network, no model calls, no CLI login flows;
 *   - every probe has a hard deadline, and one failure only reddens that row;
 *   - authentication is `unknown` unless a cheap, stable status subcommand says otherwise;
 *   - the rendered report never contains tokens, env values, prompts, or conversation text.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { HARNESSES, harnessDef } from './harnesses.js'
import { isEnabled } from './config.js'
import { buildArgv, listWslDistros, planTransport, withTimeout } from './transport.js'

const require_ = createRequire(import.meta.url)

function firstLine(text) {
  const line = String(text ?? '').trim().split(/\r?\n/)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/** Run one argv and return `{ exitCode, stdout, stderr }`; never throws. */
async function runOnce(ctx, def, plan, args, timeoutMs, signal) {
  const deadline = withTimeout(signal, timeoutMs)
  try {
    const { argv, cwd } = buildArgv(def, plan, args, undefined)
    const handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 2000,
      signal: deadline.signal,
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
      stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
    }
  } catch (error) {
    return { exitCode: null, signal: null, stdout: '', stderr: '', error }
  } finally {
    deadline.dispose()
  }
}

async function probeVersion(ctx, def, plan, signal) {
  const result = await runOnce(ctx, def, plan, def.versionArgs, 6000, signal)
  if (result.error || result.exitCode !== 0) return undefined
  const text = firstLine(result.stdout || result.stderr)
  return text === '' ? undefined : text
}

async function probeAuth(ctx, def, plan, signal) {
  if (!def.authProbe) return 'unknown'
  const result = await runOnce(ctx, def, plan, def.authProbe.argv, 8000, signal)
  if (result.error || result.exitCode === null) return 'unknown'
  return result.exitCode === def.authProbe.okExit ? 'ok' : 'signed-out'
}

/** Same-class plugins we must not duplicate (PLAN §4.6). */
export function probePlugins(ctx) {
  const tool = (name) => Boolean(ctx.get('tools')?.get?.(name))
  return {
    conductor: tool('conductor_dispatch'),
    wsl: tool('wsl'),
    providerNames: ctx.get('subagents')?.list?.() ?? [],
  }
}

function dshVersion() {
  try {
    const file = require_.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(readFileSync(file, 'utf8')).version
  } catch {
    // Packaged Desktop: the runtime manifest lives beside the asar.
    try {
      if (process.resourcesPath) {
        const file = `${process.resourcesPath}\\app.asar\\dsh\\package.json`
        return JSON.parse(readFileSync(file, 'utf8')).version
      }
    } catch {
      // fall through
    }
    return process.env.DSH_VERSION ?? 'unknown'
  }
}

export function hostFacts() {
  return {
    dsh: dshVersion(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    // The host process is not given DSH_PROFILE (that is injected into shells only).
    profile: process.env.DSH_PROFILE ?? process.env.DSH_HOME?.split(/[\\/]/).pop() ?? 'active',
  }
}

/**
 * Probe every enabled harness once.
 * @returns {Promise<{ rows: any[], wsl: any, plugins: any, host: any, subagents: string[], at: string }>}
 */
export async function detect(ctx, cfg, { signal } = {}) {
  const rows = []

  for (const def of HARNESSES) {
    if (!isEnabled(cfg, def.id)) continue
    try {
      const plan = await planTransport(ctx, def, cfg, signal)
      const [version, auth] = await Promise.all([
        probeVersion(ctx, def, plan, signal),
        probeAuth(ctx, def, plan, signal),
      ])
      rows.push({
        id: def.id,
        label: def.label,
        surface: 'provider',
        transport: plan.transport,
        via: plan.via,
        command: plan.exe ?? def.bin,
        version,
        auth,
        distro: plan.distro,
        capabilities: def.capabilities,
        source: plan.via,
        verified: def.verified,
      })
    } catch (error) {
      rows.push({
        id: def.id,
        label: def.label,
        surface: 'provider',
        transport: 'native',
        via: 'probe',
        command: def.bin,
        version: undefined,
        auth: 'missing',
        capabilities: def.capabilities,
        source: 'probe',
        verified: def.verified,
        detail: String(error?.code ?? error?.message ?? 'probe failed'),
      })
    }
  }

  const wsl = await listWslDistros(ctx, signal)
  const plugins = probePlugins(ctx)

  return {
    at: new Date().toISOString(),
    host: hostFacts(),
    rows,
    wsl,
    plugins,
    subagents: plugins.providerNames,
  }
}

function pad(value, width) {
  const text = String(value ?? '-')
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function shortVersion(text) {
  if (!text) return '-'
  const match = /(\d+\.\d+\.\d+\S*)/.exec(text)
  return (match ? match[1] : text).slice(0, 20)
}

/** Render the copy-pasteable report. Text only: no JSON, no markup. */
export function renderReport(report, cfg) {
  const { host, rows, wsl, plugins, subagents } = report
  const ready = rows.filter((row) => row.auth !== 'missing')
  const missing = rows.filter((row) => row.auth === 'missing')

  const lines = []
  lines.push(`Oh My CoHarness doctor — ${report.at}`)
  lines.push(`host: DSH ${host.dsh} · ${host.profile} profile · ${host.platform} · node ${host.node}`)
  lines.push(`subagents: ${subagents.length ? subagents.join(', ') : '(service unavailable)'}`)
  lines.push(`capacity: omc maxParallel=${cfg.dispatch.maxParallel}`)
  lines.push('')
  lines.push(`${pad('harness', 12)}${pad('exec', 18)}${pad('version', 18)}${pad('auth', 12)}state`)

  for (const row of rows) {
    const exec = row.transport === 'wsl' ? `wsl:${row.distro ?? '*'}` : `native:${row.via}`
    const state = row.auth === 'missing' ? 'missing' : row.detail ? 'degraded' : 'usable'
    const flags = []
    if (row.detail) flags.push(row.detail)
    if (row.auth !== 'missing' && row.verified === false) flags.push('argv unverified')
    lines.push(
      `${pad(row.id, 12)}${pad(exec, 18)}${pad(shortVersion(row.version), 18)}${pad(row.auth, 12)}${state}` +
        (flags.length ? ` (${flags.join('; ')})` : ''),
    )
  }
  if (!rows.length) lines.push('(no harness enabled in config)')

  lines.push('')
  lines.push(
    `wsl: ${wsl.ok ? `ok${wsl.distros.length ? ` · ${wsl.distros.join(', ')}` : ' · no distribution'}` : `unavailable (${wsl.detail})`}`,
  )

  const conflicts = []
  if (plugins.conductor) conflicts.push('conductor_dispatch')
  if (plugins.wsl) conflicts.push('wsl (dsh-wsl)')
  lines.push(`plugins: ${conflicts.length ? `${conflicts.join(' · ')} present — see PLAN §4.6` : 'no same-class plugin detected'}`)
  lines.push('')

  if (!ready.length) {
    lines.push('next: 先装一个 CLI（下面是官方安装命令），然后重启 DSH 再运行本诊断。')
    for (const row of missing) {
      const def = harnessDef(row.id)
      lines.push(`  ${pad(row.id, 12)}${def?.install ?? ''}`)
    }
  } else {
    const first = ready[0]
    lines.push(`next: 在任意会话里说「用 ${first.id} 读一下 README 并给三条建议」，或调用 coharness({action:'dispatch'})。`)
  }

  lines.push('redaction: 未包含 token / env / prompt / 对话内容')
  return lines.join('\n')
}
