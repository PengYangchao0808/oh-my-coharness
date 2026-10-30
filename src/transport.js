/**
 * Transport: discovery, argv assembly, process launch, output facts.
 *
 * Everything runs through `ctx.subprocess`, never `node:child_process`: the seam
 * already owns executable resolution, bounded collection, spill files, process-tree
 * termination and the grace period (PLAN §2, row 3).
 *
 * Discovery order matters more than it looks. A GUI-launched app inherits the
 * system PATH, not the PATH a shell profile builds, so "installed" CLIs are often
 * invisible to `resolveExecutable`. We therefore also check the usual per-user
 * install roots, then the distributions of WSL — which is where a Linux-only CLI
 * actually lives (this machine's opencode is one of those, PLAN §1.6).
 */

import { existsSync, readFileSync } from 'node:fs'
import { harnessConfig } from './config.js'

/** Combine a caller signal with our own deadline. */
export function withTimeout(parentSignal, ms) {
  const controller = new AbortController()
  let timedOut = false

  const onAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal) {
    if (parentSignal.aborted) onAbort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }

  const timer =
    ms > 0
      ? setTimeout(() => {
          timedOut = true
          const error = new Error(`OMC/CLI-TIMEOUT after ${ms}ms`)
          error.code = 'OMC/CLI-TIMEOUT'
          controller.abort(error)
        }, ms)
      : null

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (timer) clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
    },
  }
}

/** POSIX single-quote, safe for `bash -lc`. */
export function shellQuote(value) {
  const text = String(value)
  if (text === '') return "''"
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Windows path → WSL path. Unknown shapes pass through untouched. */
export function toWslPath(winPath) {
  const text = String(winPath ?? '')
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(text)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`

  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/.exec(text)
  if (unc) return `/${unc[1].replace(/\\/g, '/')}`

  return text
}

/** Head/tail clip with an explicit marker; never silently drop bytes. */
export function clip(text, maxBytes) {
  const value = String(text ?? '')
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= maxBytes) return { text: value, truncated: false }

  const headBytes = Math.max(256, Math.floor(maxBytes * 0.4))
  const tailBytes = Math.max(256, maxBytes - headBytes)
  const head = value.slice(0, headBytes)
  const tail = value.slice(-tailBytes)
  return {
    text: `${head}\n… [omc: clipped ${bytes - headBytes - tailBytes} of ${bytes} bytes] …\n${tail}`,
    truncated: true,
  }
}

/** Read both collected streams once, at offset 0. */
export function readCollected(handle, maxBytes) {
  const out = handle.collected?.stdout?.readFrom(0)
  const err = handle.collected?.stderr?.readFrom(0)

  const stdout = clip(out?.text ?? '', maxBytes)
  const stderr = clip(err?.text ?? '', Math.min(8192, maxBytes))

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: Boolean(stdout.truncated || stderr.truncated || out?.lossy || err?.lossy),
    spillPath: out?.spillPath,
  }
}

function stdio(maxBytes) {
  return {
    stdin: { data: '' }, // explicit EOF: a headless CLI must never wait on a terminal
    stdout: { maxBytes, spill: { maxBytes: 64 * 1024 * 1024 } },
    stderr: { maxBytes: Math.min(8192, maxBytes) },
  }
}

function wslCwd() {
  return process.env.SystemRoot ? `${process.env.SystemRoot}\\` : 'C:\\Windows'
}

/**
 * Install roots a GUI-launched process never inherits from a shell profile.
 * @param {string} bin
 */
export function hostCandidates(bin) {
  const home = process.env.USERPROFILE ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'

  const roots = [
    `${local}\\Programs\\${bin}\\${bin}.exe`,
    `${local}\\Programs\\${bin}\\bin\\${bin}.exe`,
    `${local}\\${bin}\\${bin}.exe`,
    `${roaming}\\npm\\${bin}.cmd`,
    `${home}\\.${bin}\\bin\\${bin}.exe`,
    `${home}\\.local\\bin\\${bin}.exe`,
    `${home}\\.bun\\bin\\${bin}.exe`,
    `${home}\\scoop\\shims\\${bin}.exe`,
    `${local}\\Microsoft\\WinGet\\Links\\${bin}.exe`,
    `${programFiles}\\${bin}\\${bin}.exe`,
  ]
  return roots.filter((candidate) => candidate && existsSync(candidate))
}

/** One bash probe: PATH first, then every root a Linux installer actually uses. */
function wslLookupScript(bin) {
  const quoted = shellQuote(bin)
  return [
    `c=$(command -v ${quoted} 2>/dev/null || true)`,
    `[ -n "$c" ] && { printf '%s\\n' "$c"; exit 0; }`,
    `for p in "$HOME/.${bin}/bin/${bin}" "/root/.${bin}/bin/${bin}" "$HOME/.local/bin/${bin}" "/root/.local/bin/${bin}" "$HOME/.nvm/versions/node/"*/bin/${bin} "/root/.nvm/versions/node/"*/bin/${bin} "$HOME/.volta/bin/${bin}" "$HOME/.local/share/pnpm/${bin}" "/usr/local/bin/${bin}" "/usr/bin/${bin}" "/opt/${bin}/${bin}" "$HOME/.bun/bin/${bin}" "/root/.bun/bin/${bin}"; do`,
    `[ -x "$p" ] && { printf '%s\\n' "$p"; exit 0; }`,
    `done`,
    // Bounded last resort: an installer that used neither PATH nor a known prefix.
    `h=$(timeout 8 find /root /home /usr/local /opt -maxdepth 6 -name ${quoted} \\( -type f -o -type l \\) 2>/dev/null | head -n 1 || true)`,
    `[ -n "$h" ] && { printf '%s\\n' "$h"; exit 0; }`,
    `exit 127`,
  ].join('\n')
}

/**
 * `KEY=VALUE` lines, `#` comments; quotes stripped. Used for secrets that must not
 * live in the profile patch (the convention dsh-media-skills already established).
 * @param {string} path
 */
export function parseEnvFile(path) {
  if (!path) return {}
  try {
    const text = readFileSync(path, 'utf8')
    const out = {}
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** `${VAR}` → the host process value; left literal when absent so the CLI fails loudly. */
export function expandEnv(value) {
  return String(value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
}

/**
 * Final environment for one harness: definition defaults < row config < secret file.
 * Precedence is deliberate — a user's env file must be able to override a default.
 */
export function harnessEnv(def, hcfg) {
  const merged = { ...(def.defaultEnv ?? {}) }
  for (const [key, value] of Object.entries(hcfg?.env ?? {})) merged[key] = expandEnv(value)
  return Object.assign(merged, parseEnvFile(hcfg?.envFile))
}

/**
 * Build argv + cwd for one harness invocation in the chosen execution world.
 * Shared by real dispatches and by version/auth probes so both speak one dialect.
 */
export function buildArgv(def, plan, args, cwd, env) {
  if (plan.transport === 'wsl') {
    const linuxCwd = cwd ? toWslPath(cwd) : ''
    // Environment goes inside the bash script: WSLENV translation is fiddly, while
    // `export K=V` in the shell is exact and preserves the login PATH.
    const exports = Object.entries(env ?? {})
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(' ')
    const prefix = exports ? `export ${exports}; ` : ''
    const command = [plan.exe ?? def.bin, ...args].map(shellQuote).join(' ')
    const script = `${prefix}${linuxCwd ? `cd ${shellQuote(linuxCwd)} && ` : ''}${command}`
    return {
      argv: ['wsl.exe', ...(plan.distro ? ['-d', plan.distro] : []), '-e', 'bash', '-lc', script],
      cwd: wslCwd(),
    }
  }
  return { argv: [plan.exe ?? def.bin, ...args], cwd }
}

/**
 * Start one harness process.
 *
 * `sessionId` selects the CLI's native resume form when the harness declares
 * one; `json` asks for the machine-readable output that carries the session id
 * and usage. Neither changes the read-only contract of the role provider.
 *
 * @param {{ subprocess: any }} ctx
 * @param {import('./harnesses.js').HarnessDef} def
 * @param {{
 *   task: string, cwd?: string, model?: string, mode?: string,
 *   sessionId?: string, json?: boolean,
 *   plan: { transport: 'native' | 'wsl', exe?: string, distro?: string },
 *   timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal,
 * }} options
 */
export async function launch(ctx, def, options) {
  const { task, cwd, model, mode, sessionId, json, plan, timeoutMs, maxOutputBytes, signal, env } = options
  const deadline = withTimeout(signal, timeoutMs)
  const args = sessionId && typeof def.session?.resumeArgs === 'function'
    ? def.session.resumeArgs(sessionId, task, { model, mode, json })
    : def.argv(task, { model, mode, json })
  const { argv, cwd: spawnCwd } = buildArgv(def, plan, args, cwd, env)

  const handle = ctx.subprocess.spawn({
    argv,
    cwd: spawnCwd,
    stdio: stdio(maxOutputBytes),
    // Short grace: a deadline must feel like a deadline. The provider still escalates
    // to a hard kill after this window, so no orphan survives.
    graceMs: 1500,
    signal: deadline.signal,
    // The seam applies no defaults, so a native child needs the base environment we
    // want it to inherit; the harness variables overlay it.
    ...(env && plan.transport === 'native' ? { env: { ...process.env, ...env } } : {}),
  })

  return { handle, argv, cwd: spawnCwd, deadline }
}

/** Resolve one executable for this execution world; throws when absent. */
export async function resolveExecutable(ctx, bin, signal) {
  return ctx.subprocess.resolveExecutable(bin, undefined, signal)
}

async function runProbe(ctx, argv, timeoutMs, signal, cwd) {
  const deadline = withTimeout(signal, timeoutMs)
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: cwd ?? wslCwd(),
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

/** Which distributions exist, according to `wsl.exe -l -q`. */
export async function listWslDistros(ctx, signal) {
  const result = await runProbe(ctx, ['wsl.exe', '-l', '-q'], 8000, signal)
  if (result.error) {
    return { ok: false, distros: [], detail: String(result.error?.code ?? result.error?.message ?? 'launch failed') }
  }
  if (result.exitCode !== 0) {
    const code = /Wsl\/Service\/[A-Z_]+/.exec(result.stderr)?.[0] ?? `exit ${result.exitCode ?? result.signal}`
    return { ok: false, distros: [], detail: code }
  }
  const distros = result.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter(Boolean)
  return { ok: true, distros, detail: '' }
}

/** Is `bin` runnable inside one distribution? Returns its absolute Linux path. */
export async function probeWslCommand(ctx, bin, distro, signal) {
  const result = await runProbe(
    ctx,
    ['wsl.exe', ...(distro ? ['-d', distro] : []), '-e', 'bash', '-lc', wslLookupScript(bin)],
    20000,
    signal,
  )
  if (result.error) return { ok: false, detail: String(result.error?.code ?? 'launch failed') }
  const path = result.stdout.trim()
  if (result.exitCode === 0 && path !== '') return { ok: true, path }
  const code = /Wsl\/Service\/[A-Z_]+/.exec(result.stderr)?.[0]
  return { ok: false, detail: code ?? `not on PATH in WSL (exit ${result.exitCode ?? result.signal})` }
}

/**
 * A successful transport plan is stable for a short window. CLI discovery can
 * spend seconds in WSL (`wsl.exe -l -q` plus a login-shell lookup); repeating it
 * for every role turn is pure latency. Failures are never cached, so installing
 * a CLI still takes effect on the next attempt.
 */
const PLAN_CACHE = new WeakMap()
const PLAN_TTL_MS = 60_000

function planCacheKey(def, cfg, hcfg) {
  return JSON.stringify([
    def.id,
    hcfg.command,
    hcfg.transport,
    hcfg.distro,
    cfg.transport,
    cfg.wsl.distro,
    process.env.DSH_WSL_DISTRO ?? '',
  ])
}

function cachedPlan(ctx, key) {
  if (!ctx || typeof ctx !== 'object') return null
  const entry = PLAN_CACHE.get(ctx)?.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > PLAN_TTL_MS) return null
  return entry.plan
}

function rememberPlan(ctx, key, plan) {
  if (!ctx || typeof ctx !== 'object') return
  let map = PLAN_CACHE.get(ctx)
  if (!map) {
    map = new Map()
    PLAN_CACHE.set(ctx, map)
  }
  map.set(key, { plan, at: Date.now() })
}

/** Tests and config reloads can force a fresh discovery pass. */
export function clearTransportPlanCache(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  PLAN_CACHE.delete(ctx)
}

/**
 * Choose an execution world for one harness.
 *
 * @returns {Promise<{ transport: 'native' | 'wsl', exe?: string, distro?: string, via: string }>}
 */
export async function planTransport(ctx, def, cfg, signal) {
  const hcfg = harnessConfig(cfg, def.id)
  const forced = hcfg.transport !== 'auto' ? hcfg.transport : cfg.transport
  const cacheKey = planCacheKey(def, cfg, hcfg)
  const cached = cachedPlan(ctx, cacheKey)
  if (cached) return cached
  const nativeError = []
  const wslError = []

  const native = async () => {
    if (hcfg.command) {
      try {
        const exe = await resolveExecutable(ctx, hcfg.command, signal)
        return { transport: 'native', exe, via: 'config' }
      } catch (error) {
        nativeError.push(`config command: ${error?.code ?? error?.message}`)
      }
    }
    try {
      const exe = await resolveExecutable(ctx, def.bin, signal)
      return { transport: 'native', exe, via: 'path' }
    } catch (error) {
      nativeError.push(`PATH: ${error?.code ?? error?.message}`)
    }
    const candidates = hostCandidates(def.bin)
    if (candidates.length) return { transport: 'native', exe: candidates[0], via: 'search' }
    nativeError.push('search: none of the known install roots contain it')
    return null
  }

  const wsl = async () => {
    const listed = await listWslDistros(ctx, signal)
    if (!listed.ok) {
      wslError.push(`wsl: ${listed.detail}`)
      return null
    }
    const preferred = hcfg.distro || cfg.wsl.distro || process.env.DSH_WSL_DISTRO || ''
    const order = preferred && listed.distros.includes(preferred)
      ? [preferred, ...listed.distros.filter((d) => d !== preferred)]
      : listed.distros

    if (!order.length) {
      wslError.push('wsl: no distribution installed')
      return null
    }
    for (const distro of order) {
      const probe = await probeWslCommand(ctx, def.bin, distro, signal)
      if (probe.ok) return { transport: 'wsl', exe: probe.path, distro, via: 'wsl' }
      wslError.push(`${distro}: ${probe.detail}`)
    }
    return null
  }

  let found = null
  if (forced === 'wsl') {
    found = await wsl()
  } else if (forced === 'native') {
    found = await native()
  } else {
    found = (await native()) ?? (await wsl())
  }
  if (found) {
    rememberPlan(ctx, cacheKey, found)
    return found
  }

  const error = new Error(
    `OMC/CLI-MISSING: ${def.bin} not found (${[...nativeError, ...wslError].join(' · ') || 'no probe succeeded'})`,
  )
  error.code = 'OMC/CLI-MISSING'
  throw error
}

/** Turn a settled subprocess outcome into our status vocabulary. */
export function statusOf(outcome, deadline, signal) {
  if (deadline?.timedOut()) return 'timeout'
  if (signal?.aborted) return 'cancelled'
  return outcome.exitCode === 0 ? 'completed' : 'failed'
}
