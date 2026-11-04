/**
 * Real install check: pack this repository, install the tarball into a scratch
 * project, and prove the published package resolves for a consumer.
 *
 *   node scripts/install-check.mjs
 *   node scripts/install-check.mjs --json
 *   node scripts/install-check.mjs --json --out docs/evidence/v0.9/install-check.json
 *
 * This is deliberately NOT pack-check: it runs the real npm pipeline
 * (`npm pack` → `npm init -y` → `npm install <tgz>` → `require.resolve`) in a
 * temporary directory and never runs `npm publish`. pack-check only mirrors the
 * manifest rules and must not be reported as a real installation.
 *
 * Every artifact (tarball, scratch project, npm cache, npm config and a
 * synthetic HOME/USERPROFILE) lives under one temp directory, so a run never
 * reads or writes a real user profile.
 *
 * When npm cannot be found the check reports `status: "blocked"` with the
 * concrete reason and the locations it searched, then exits non-zero. It never
 * degrades into pack-check and never claims a successful install.
 */

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const isWindows = process.platform === 'win32'
const packageName = 'oh-my-coharness'

export const INSTALL_CHECK_SCHEMA_VERSION = 1

const toPosix = (value) => value.split(sep).join('/')

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

/** PATH entries, deduplicated and without empty segments. */
function pathDirectories() {
  const seen = new Set()
  const dirs = []
  for (const entry of String(process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue
    const normalized = resolve(entry)
    const key = isWindows ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(entry)
  }
  return dirs
}

/**
 * Every plausible npm entry point, in preference order.
 *
 * `npm_execpath` is what npm itself sets for lifecycle scripts and is the only
 * reliable anchor on a Windows runner. The directory of the running Node binary
 * is next (a normal Node install keeps npm beside it); then the platform's
 * usual install roots; then PATH.
 */
function npmCandidates() {
  const candidates = []
  const checked = []
  const seen = new Set()
  const add = (command, args, source) => {
    const key = isWindows ? `${command}|${args.join('|')}`.toLowerCase() : `${command}|${args.join('|')}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ command, args, source })
  }
  /** Record the location even when nothing is there, so `blocked` can say where we looked. */
  const consider = (path, source, asScript = false) => {
    const display = asScript ? `${process.execPath} ${path}` : path
    checked.push(`${display} (${source})${existsSync(path) || (asScript && existsSync(path)) ? '' : ' — missing'}`)
    if (!existsSync(path)) return
    if (asScript) add(process.execPath, [path], source)
    else add(path, [], source)
  }

  const execPath = process.env.npm_execpath
  if (execPath && execPath.length > 0) {
    if (/\.(?:mjs|cjs|js)$/i.test(execPath)) consider(execPath, 'npm_execpath (node script)', true)
    else consider(execPath, 'npm_execpath')
  } else {
    checked.push('npm_execpath (not set)')
  }

  const nodeDir = dirname(process.execPath)
  const nodeRoot = dirname(nodeDir)
  consider(join(nodeDir, 'npm.cmd'), 'Node install directory')
  consider(join(nodeDir, 'npm'), 'Node install directory')
  consider(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'Node install directory', true)
  consider(join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'Node install directory', true)

  if (isWindows) {
    const windowsRoots = [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'npm.cmd') : undefined,
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'npm.cmd') : undefined,
      process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'nodejs', 'npm.cmd') : undefined,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.cmd') : undefined,
    ].filter(Boolean)
    for (const candidate of windowsRoots) consider(candidate, 'Windows install root')
  } else {
    for (const candidate of ['/usr/local/bin/npm', '/usr/bin/npm', '/opt/homebrew/bin/npm']) {
      consider(candidate, 'Unix install root')
    }
  }

  const pathNames = isWindows ? ['npm.cmd', 'npm.exe', 'npm.bat', 'npm'] : ['npm']
  for (const dir of pathDirectories()) {
    checked.push(`${join(dir, isWindows ? 'npm{.cmd,.exe,.bat}' : 'npm')} (PATH)`)
    for (const name of pathNames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) add(candidate, [], 'PATH')
    }
  }

  return { candidates, checked }
}

/** Quote one argument for a cmd.exe command line. */
function quoteWindowsArgument(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"&|<>^]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function runNpm(npm, args, cwd, env, timeoutMs = 300_000) {
  const shell = isWindows && /\.(?:cmd|bat)$/i.test(npm.command)
  // cmd.exe needs the shim path quoted when it contains spaces (e.g. Program Files).
  const command = shell ? `"${npm.command}"` : npm.command
  const finalArgs = shell ? [...npm.args, ...args].map(quoteWindowsArgument) : [...npm.args, ...args]
  const result = spawnSync(command, finalArgs, {
    cwd,
    env,
    shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return {
    command: `${npm.command} ${[...npm.args, ...args].join(' ')}`,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : undefined,
  }
}

const tail = (text, limit = 1200) => {
  const value = String(text ?? '').trim()
  return value.length <= limit ? value : `…${value.slice(-limit)}`
}

function findNpm(env) {
  const { candidates, checked } = npmCandidates()
  const searched = [...checked]
  for (const candidate of candidates) {
    searched.push(`probe: ${candidate.command}${candidate.args.length ? ` ${candidate.args.join(' ')}` : ''} (${candidate.source})`)
    const probe = runNpm(candidate, ['--version'], root, env, 20_000)
    if (probe.status !== 0) continue
    const version = probe.stdout.trim().split(/\r?\n/).pop() ?? ''
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    return { ...candidate, version, searched }
  }
  return { missing: true, searched }
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else if (entry.isFile()) visit(full)
  }
}

function renderText(document) {
  const lines = [`install check (${document.root})`]
  if (document.status === 'blocked') {
    lines.push(`  BLOCKED ${document.reason}`)
    if (document.npm?.searched?.length) {
      lines.push('  searched:')
      for (const candidate of document.npm.searched) lines.push(`    - ${candidate}`)
    }
    lines.push('install check blocked: a successful installation was NOT verified')
  } else {
    for (const entry of document.checks) {
      lines.push(`  ${entry.status === 'pass' ? 'ok  ' : 'FAIL'} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`)
    }
    for (const failure of document.failures) lines.push(`  - ${failure}`)
    lines.push(
      document.status === 'ok'
        ? `install check ok: ${document.tarball?.filename} installed into a scratch project and resolved as ${packageName}`
        : 'install check failed',
    )
  }
  if (document.scratchDir) lines.push(`  scratch kept: ${document.scratchDir}`)
  return `${lines.join('\n')}\n`
}

function writeDocument(document, out) {
  if (!out) return undefined
  const absolute = isAbsolute(out) ? out : resolve(process.cwd(), out)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`)
  return absolute
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const keepTemp = args.includes('--keep-temp')
const out = option(args, 'out', undefined)

const document = {
  schemaVersion: INSTALL_CHECK_SCHEMA_VERSION,
  kind: 'omc-install-check',
  status: 'failed',
  root: toPosix(root),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  npm: null,
  tarball: null,
  install: null,
  resolution: null,
  checks: [],
  failures: [],
  scratchDir: undefined,
}

const checks = document.checks
const failures = document.failures
const pass = (id, detail, evidence) => checks.push({ id, status: 'pass', ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) })
const fail = (id, detail) => {
  checks.push({ id, status: 'fail', ...(detail ? { detail } : {}) })
  failures.push(`[${id}] ${detail}`)
}

let scratch
try {
  scratch = mkdtempSync(join(tmpdir(), 'omc-install-check-'))
  const home = join(scratch, 'home')
  const cache = join(scratch, 'cache')
  const packDir = join(scratch, 'pack')
  const projectDir = join(scratch, 'project')
  for (const dir of [home, cache, packDir, projectDir]) mkdirSync(dir, { recursive: true })

  // An empty user/global npmrc and a synthetic HOME keep npm away from the real
  // profile's config and cache.
  const userConfig = join(scratch, 'npmrc')
  const globalConfig = join(scratch, 'global-npmrc')
  writeFileSync(userConfig, '')
  writeFileSync(globalConfig, '')

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_prefix: join(scratch, 'prefix'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true',
  }

  const npm = findNpm(env)
  if (npm.missing) {
    document.status = 'blocked'
    document.npm = { found: false, searched: npm.searched }
    document.reason =
      'npm executable not found. install-check needs the real npm CLI (not pnpm) to run npm pack, npm init and npm install. '
      + 'Add npm to PATH, place it beside the running Node binary, or point npm_execpath at npm-cli.js.'
    process.stderr.write(`install check blocked: ${document.reason}\n`)
  } else {
    document.npm = { found: true, command: npm.command, args: npm.args, version: npm.version, source: npm.source }
    pass('npm', `npm ${npm.version} (${npm.source})`)

    // 1. Pack the repository into the scratch pack directory.
    const pack = runNpm(npm, ['pack', '--json', '--pack-destination', packDir], root, env)
    if (pack.status !== 0) {
      fail('npm-pack', `npm pack failed (exit ${pack.status ?? pack.signal}): ${tail(pack.stderr || pack.stdout)}`)
    } else {
      let meta
      try {
        const parsed = JSON.parse(pack.stdout)
        meta = Array.isArray(parsed) ? parsed[0] : parsed
      } catch {
        meta = undefined
      }
      const filename = meta?.filename
      const tarball = filename ? (isAbsolute(filename) ? filename : join(packDir, filename)) : undefined
      if (!filename || !tarball || !existsSync(tarball)) {
        fail('npm-pack', `npm pack reported no readable tarball: ${tail(pack.stdout)}`)
      } else {
        const size = statSync(tarball).size
        document.tarball = { filename, path: toPosix(tarball), bytes: size, files: meta.files?.length ?? null }
        pass('npm-pack', `packed ${filename} (${size} bytes${meta.files ? `, ${meta.files.length} entries` : ''})`)

        // 2. Scratch project.
        const init = runNpm(npm, ['init', '-y'], projectDir, env, 120_000)
        if (init.status !== 0) {
          fail('npm-init', `npm init -y failed (exit ${init.status ?? init.signal}): ${tail(init.stderr || init.stdout)}`)
        } else {
          pass('npm-init', 'scratch package initialised')

          // 3. Install the tarball (never publish it).
          const install = runNpm(
            npm,
            ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', tarball],
            projectDir,
            env,
            600_000,
          )
          if (install.status !== 0) {
            fail('npm-install', `npm install failed (exit ${install.status ?? install.signal}): ${tail(install.stderr || install.stdout)}`)
          } else {
            const packageDir = join(projectDir, 'node_modules', packageName)
            document.install = { project: toPosix(projectDir), packageDir: toPosix(packageDir) }
            if (!existsSync(packageDir)) {
              fail('installed-tree', `npm install succeeded but ${packageName} is not under node_modules`)
            } else {
              pass('npm-install', `installed ${packageName} into the scratch project`)

              // 4. Resolution from an independent consumer anchor.
              const consumer = createRequire(join(projectDir, 'package.json'))
              const inside = (path) => {
                const rel = relative(packageDir, path)
                return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
              }
              let manifestPath
              let entryPath
              try {
                manifestPath = consumer.resolve(`${packageName}/package.json`)
              } catch (error) {
                fail('resolve-package-json', `${packageName}/package.json does not resolve: ${String(error?.message ?? error)}`)
              }
              try {
                entryPath = consumer.resolve(packageName)
              } catch (error) {
                fail('resolve-entry', `${packageName} does not resolve: ${String(error?.message ?? error)}`)
              }
              if (manifestPath && entryPath) {
                document.resolution = { packageJson: toPosix(manifestPath), entry: toPosix(entryPath) }
                if (!inside(manifestPath)) fail('resolve-package-json', `resolved package.json outside the installed package: ${manifestPath}`)
                else pass('resolve-package-json', toPosix(manifestPath))
                if (!inside(entryPath)) fail('resolve-entry', `resolved entry outside the installed package: ${entryPath}`)
                else if (!toPosix(entryPath).endsWith('/src/entry.js')) {
                  fail('resolve-entry', `the package entry resolves to ${toPosix(entryPath)}, expected src/entry.js`)
                } else pass('resolve-entry', toPosix(entryPath))

                const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
                if (installed.private !== true) fail('installed-private', 'the installed package.json must keep private=true')
                else pass('installed-private', 'installed package.json is private=true')
                if (installed.name !== packageName) fail('installed-name', `installed name is ${installed.name}`)
                else pass('installed-name', installed.name)

                // The subpath exports are how the host mounts the preset.
                try {
                  const presetPath = consumer.resolve(`${packageName}/preset`)
                  if (!inside(presetPath)) fail('resolve-preset', `preset export resolved outside the package: ${presetPath}`)
                  else pass('resolve-preset', toPosix(presetPath))
                } catch (error) {
                  fail('resolve-preset', `${packageName}/preset does not resolve: ${String(error?.message ?? error)}`)
                }

                // 5. The tarball really contains the licence/provenance files
                //    and none of the forbidden repository-only paths.
                const required = [
                  'package.json',
                  'src/entry.js',
                  'src/index.js',
                  'integration/execution.js',
                  'vendor/omd/LICENSE',
                  'vendor/omd/UPSTREAM.json',
                  'vendor/omd/PATCHES.md',
                  'vendor/omd/npm-package/preset/preset.js',
                  'THIRD_PARTY_NOTICES.md',
                ]
                const missing = required.filter((file) => !existsSync(join(packageDir, ...file.split('/'))))
                if (missing.length) fail('installed-files', `installed package is missing: ${missing.join(', ')}`)
                else pass('installed-files', `${required.length} required files are installed`)

                const forbidden = []
                walk(packageDir, (file) => {
                  const rel = toPosix(relative(packageDir, file))
                  if (/^(?:\.github|docs\/archive)(?:\/|$)/.test(rel)) forbidden.push(rel)
                })
                if (forbidden.length) fail('forbidden-files', `installed package ships forbidden path(s): ${forbidden.join(', ')}`)
                else pass('forbidden-files', 'no .github/** or docs/archive/** file is installed')
              }
            }
          }
        }
      }
    }

    document.status = failures.length === 0 ? 'ok' : 'failed'
  }
} catch (error) {
  document.status = 'failed'
  fail('install-check', `unexpected error: ${String(error?.stack ?? error?.message ?? error)}`)
} finally {
  if (document.status === 'ok' || document.status === 'failed') {
    if (keepTemp && scratch) document.scratchDir = toPosix(scratch)
    else if (scratch && !keepTemp) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  } else if (scratch && !keepTemp) {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

const written = writeDocument(document, out)
if (written && !json) process.stderr.write(`install check result: ${written}\n`)
if (json) process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
else process.stdout.write(renderText(document))

if (document.status === 'blocked') process.exit(3)
if (document.status === 'failed') process.exit(1)
process.exit(0)
