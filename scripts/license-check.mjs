/**
 * Offline licence and vendoring-provenance check.
 *
 *   node scripts/license-check.mjs            # human-readable report
 *   node scripts/license-check.mjs --json     # one JSON document on stdout
 *   node scripts/license-check.mjs --out docs/evidence/v0.9/license-check.json
 *
 * It answers four questions without touching the network:
 *
 *   1. Does vendor/omd/UPSTREAM.json pin a fixed upstream commit (40 hex chars),
 *      not a moving ref such as HEAD/main/latest?
 *   2. Does vendor/omd/PATCHES.md exist, and does every repository patch path it
 *      names actually exist?
 *   3. Do the OMD LICENSE and THIRD_PARTY_NOTICES.md carry the attribution the
 *      MIT terms require (copyright holder, upstream project, OMO persona
 *      attribution, full permission grant)?
 *   4. Does package.json `files` cover the vendored licence/provenance documents
 *      so they really ship in the tarball?
 *
 * This module deliberately does not analyse static imports. Cordis plugins are
 * registered dynamically through the host loader, so "no static import reaches
 * this file" is NOT evidence that a file is dead: deleting a dynamically
 * registered module because an import graph looks unreachable would break the
 * plugin. That judgement is out of scope here.
 *
 * The check is exported so scripts/check.mjs can fail the static pass without
 * spawning another process; running it directly is the CI/evidence entry point.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRoot = dirname(here)

export const LICENSE_CHECK_SCHEMA_VERSION = 1

const toPosix = (value) => value.split('\\').join('/')

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const readJson = (path) => {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One check record, shared by text and JSON output. */
function check(id, status, detail, evidence) {
  return { id, status, ...(detail === undefined ? {} : { detail }), ...(evidence === undefined ? {} : { evidence }) }
}

const has = (text, needle) => typeof text === 'string' && text.includes(needle)

/* ── static shape of a fixed upstream pin ─────────────────────────────────── */

const COMMIT = /^[0-9a-f]{40}$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/
const MOVING_REF = /^(?:HEAD|main|master|latest|develop|trunk|release)$/i

/**
 * Every repository-ish path a Markdown document names in backticks.
 *
 * Backticked spans used here are code identifiers, CLI flags and paths mixed
 * together. A span is treated as a path when it has a directory separator or a
 * known file extension. Bare filenames are checked opportunistically (a config
 * file name such as `oh-my-coharness.json` is not a repository file), while a
 * slash path MUST resolve — those are the patch paths the check exists for.
 */
export function referencedPaths(markdown) {
  const paths = []
  const seen = new Set()
  for (const match of String(markdown ?? '').matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1].trim()
    if (seen.has(raw)) continue
    seen.add(raw)
    const looksLikePath = raw.includes('/') || /\.(?:js|mjs|cjs|json|md|ya?ml)$/i.test(raw)
    if (!looksLikePath) continue
    if (raw.includes(' ') || raw.startsWith('/') || raw.startsWith('~') || raw.includes('://') || raw.includes('<')) continue
    paths.push(raw)
  }
  return paths
}

/**
 * Resolve one repository reference against the roots the vendored docs use.
 * @returns {{ ref: string, resolved?: string, directory?: boolean, bare?: boolean }}
 */
function resolveReference(reference, root) {
  const normalized = reference.replace(/\\/g, '/').replace(/\/+$/, '')
  const bare = !normalized.includes('/')
  if (!normalized) return { ref: reference, bare }
  for (const base of [root, join(root, 'vendor', 'omd'), join(root, 'vendor', 'omd', 'npm-package')]) {
    const full = join(base, normalized)
    if (!existsSync(full)) continue
    let directory = false
    try {
      directory = statSync(full).isDirectory()
    } catch {
      /* treated as a file */
    }
    const rel = toPosix(relative(root, full)) || '.'
    return { ref: reference, resolved: rel, directory, bare }
  }
  return { ref: reference, bare }
}

/**
 * Run the offline licence/provenance check.
 * @param {{ root?: string }} [options]
 * @returns {{ ok: boolean, checks: object[], failures: string[], notes: string[], offline: true, root: string }}
 */
export function checkLicenses({ root = defaultRoot } = {}) {
  const checks = []
  const failures = []
  const notes = []
  const fail = (id, detail) => {
    checks.push(check(id, 'fail', detail))
    failures.push(`[${id}] ${detail}`)
  }
  const pass = (id, detail, evidence) => checks.push(check(id, 'pass', detail, evidence))

  /* 1. upstream manifest ──────────────────────────────────────────────────── */
  const upstreamPath = join(root, 'vendor', 'omd', 'UPSTREAM.json')
  const upstream = readJson(upstreamPath)
  if (!upstream || typeof upstream !== 'object') {
    fail('upstream-json', 'vendor/omd/UPSTREAM.json is missing or not valid JSON')
  } else {
    pass('upstream-json', 'vendor/omd/UPSTREAM.json parses')
    const pin = upstream.upstream
    if (!pin || typeof pin !== 'object') {
      fail('upstream-pin', 'UPSTREAM.json has no "upstream" object')
    } else {
      const problems = []
      if (typeof pin.name !== 'string' || pin.name.length === 0) problems.push('upstream.name is empty')
      if (pin.name === 'oh-my-coharness') problems.push('upstream.name must name the upstream project, not this package')
      if (typeof pin.repository !== 'string' || !GITHUB_REPO.test(pin.repository)) {
        problems.push('upstream.repository must be a GitHub https URL')
      }
      if (typeof pin.version !== 'string' || !SEMVER.test(pin.version)) problems.push('upstream.version must be a semver version')
      if (typeof pin.commit !== 'string' || !COMMIT.test(pin.commit)) {
        problems.push('upstream.commit must be a fixed 40-character lowercase hex commit')
      } else if (MOVING_REF.test(pin.commit)) {
        problems.push('upstream.commit must not be a moving ref such as HEAD/main/latest')
      }
      if (typeof pin.commitSubject !== 'string' || pin.commitSubject.trim().length === 0) {
        problems.push('upstream.commitSubject is empty')
      }
      if (typeof pin.importedAt !== 'string' || !ISO_DATE.test(pin.importedAt)) {
        problems.push('upstream.importedAt must be an ISO date')
      }
      if (pin.license !== 'MIT') problems.push('upstream.license must be MIT for this import')
      if (pin.path !== 'vendor/omd') problems.push('upstream.path must be vendor/omd')
      if (problems.length) fail('upstream-pin', problems.join('; '))
      else pass('upstream-pin', `pinned ${pin.name}@${pin.version} at ${pin.commit}`)
    }
  }
  if (!existsSync(join(root, 'vendor', 'omd'))) {
    fail('upstream-path', 'vendor/omd does not exist')
  } else {
    pass('upstream-path', 'vendor/omd exists')
  }

  /* 2. PATCHES.md and the paths it names ──────────────────────────────────── */
  const patchesPath = join(root, 'vendor', 'omd', 'PATCHES.md')
  const patches = readText(patchesPath)
  if (patches === undefined) {
    fail('patches-exists', 'vendor/omd/PATCHES.md is missing')
  } else {
    pass('patches-exists', 'vendor/omd/PATCHES.md exists')
    const commit = upstream?.upstream?.commit
    if (typeof commit === 'string' && COMMIT.test(commit)) {
      if (has(patches, commit)) pass('patches-pin', `PATCHES.md names the pinned commit ${commit}`)
      else fail('patches-pin', `PATCHES.md does not name the pinned commit ${commit}`)
    }

    const references = referencedPaths(patches)
    const unresolved = []
    const resolved = []
    const skippedBare = []
    for (const reference of references) {
      const found = resolveReference(reference, root)
      if (found.resolved === undefined) {
        if (found.bare) skippedBare.push(found.ref)
        else unresolved.push(found.ref)
        continue
      }
      resolved.push({ ref: found.ref, resolved: found.resolved, directory: found.directory === true })
    }
    if (unresolved.length) {
      fail('patches-paths', `PATCHES.md names path(s) that do not exist: ${unresolved.join(', ')}`)
    } else if (resolved.length < 10) {
      fail('patches-paths', `PATCHES.md resolves only ${resolved.length} repository path(s); the patch list looks incomplete`)
    } else {
      pass('patches-paths', `PATCHES.md names ${resolved.length} existing repository paths`, resolved)
    }
    if (skippedBare.length) notes.push(`bare name(s) not treated as repository paths: ${skippedBare.join(', ')}`)
  }

  /* 3. licence text and notices ───────────────────────────────────────────── */
  const omdLicense = readText(join(root, 'vendor', 'omd', 'LICENSE'))
  if (omdLicense === undefined) {
    fail('omd-license', 'vendor/omd/LICENSE is missing')
  } else {
    const required = ['MIT License', 'oh-my-dsh-slim contributors', 'Permission is hereby granted']
    const missing = required.filter((needle) => !has(omdLicense, needle))
    if (missing.length) fail('omd-license', `vendor/omd/LICENSE is missing: ${missing.join(', ')}`)
    else pass('omd-license', 'vendor/omd/LICENSE carries the MIT grant and the OMD copyright')
  }

  const notices = readText(join(root, 'THIRD_PARTY_NOTICES.md'))
  if (notices === undefined) {
    fail('notices', 'THIRD_PARTY_NOTICES.md is missing')
  } else {
    const required = [
      'oh-my-dsh-slim',
      'https://github.com/ninipa/oh-my-dsh-slim',
      'oh-my-opencode-slim',
      'alvinunreal',
      'MIT',
      'Permission is hereby granted',
      'vendor/omd/LICENSE',
      'vendor/omd/PATCHES.md',
    ]
    const commit = upstream?.upstream?.commit
    const version = upstream?.upstream?.version
    if (typeof commit === 'string') required.push(commit)
    if (typeof version === 'string') required.push(version)
    const missing = required.filter((needle) => !has(notices, needle))
    if (missing.length) fail('notices', `THIRD_PARTY_NOTICES.md is missing: ${missing.join(', ')}`)
    else pass('notices', 'THIRD_PARTY_NOTICES.md carries OMD and OMO attribution and the MIT grant')
  }

  const rootLicense = readText(join(root, 'LICENSE'))
  if (rootLicense === undefined) {
    fail('root-license', 'LICENSE is missing')
  } else {
    const missing = ['MIT License', 'Oh My CoHarness contributors', 'Permission is hereby granted'].filter(
      (needle) => !has(rootLicense, needle),
    )
    if (missing.length) fail('root-license', `LICENSE is missing: ${missing.join(', ')}`)
    else pass('root-license', 'root LICENSE is MIT and keeps the vendored-code attribution')
  }

  /* 4. package.json files coverage ────────────────────────────────────────── */
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg || !Array.isArray(pkg.files)) {
    fail('package-files', 'package.json has no "files" array')
  } else {
    const required = [
      'vendor/omd/PATCHES.md',
      'vendor/omd/UPSTREAM.json',
      'vendor/omd/LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ]
    const covered = (file) =>
      pkg.files.some((entry) => {
        if (typeof entry !== 'string') return false
        const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
        return clean === file || file.startsWith(`${clean}/`)
      })
    const missing = required.filter((file) => !covered(file))
    if (missing.length) fail('package-files', `package.json files do not cover: ${missing.join(', ')}`)
    else pass('package-files', 'package.json files cover the vendored licence/provenance documents')
  }

  notes.push('offline check: no network access; a branch or HEAD is never accepted as the upstream pin')
  notes.push('static import reachability is not analysed; Cordis registers plugins dynamically through the host loader')

  return {
    schemaVersion: LICENSE_CHECK_SCHEMA_VERSION,
    kind: 'omc-license-check',
    ok: failures.length === 0,
    offline: true,
    root: toPosix(root),
    checks,
    failures,
    notes,
  }
}

function renderText(document) {
  const lines = [`license check (${document.root})`]
  for (const entry of document.checks) {
    lines.push(`  ${entry.status === 'pass' ? 'ok  ' : 'FAIL'} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  for (const note of document.notes) lines.push(`  note: ${note}`)
  if (!document.ok) {
    lines.push(`license check failed (${document.failures.length}):`)
    for (const failure of document.failures) lines.push(`  - ${failure}`)
  } else {
    lines.push('license check ok: pinned upstream, patch paths, attribution and packaged licence files are intact')
  }
  return `${lines.join('\n')}\n`
}

const option = (args, name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function isDirectInvocation() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  const self = fileURLToPath(import.meta.url)
  const normalize = (value) => {
    const absolute = isAbsolute(value) ? value : resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return normalize(entry) === normalize(self)
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2)
  const result = checkLicenses({})
  const out = option(args, 'out', undefined)
  if (out) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const absolute = resolve(process.cwd(), out)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`)
    process.stderr.write(`license check result: ${absolute}\n`)
  }
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (!out) process.stdout.write(renderText(result))
  else process.stdout.write(renderText(result))
  process.exit(result.ok ? 0 : 1)
}
