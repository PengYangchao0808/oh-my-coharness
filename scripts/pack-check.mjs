/**
 * Tarball manifest check — what `npm publish` would actually ship.
 *
 * We cannot run `npm pack` on this machine (no npm), so this mirrors the documented
 * behaviour instead: package.json, README, LICENSE and the `main` entry are always
 * included, plus everything matched by `files`. Fails when a declared path is
 * missing, escapes the package root, or when a runtime file is not covered.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILLS } from '../src/skills.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const problems = []
const collected = new Set()

const toPosix = (value) => value.split(sep).join('/')

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.isFile()) collected.add(toPosix(relative(root, full)))
  }
}

function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      out += '.*'
      i += 1
    } else if (ch === '*') {
      out += '[^/]*'
    } else if ('\\^$+?.()|{}[]'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

async function expand(entry) {
  if (!entry.includes('*')) {
    const full = join(root, entry)
    try {
      const info = await stat(full)
      if (info.isDirectory()) {
        const before = new Set(collected)
        await walk(full)
        return [...collected].filter((file) => !before.has(file))
      }
      return [toPosix(entry)]
    } catch {
      problems.push(`declared path does not exist: ${entry}`)
      return []
    }
  }

  const matcher = globToRegExp(entry)
  const base = entry.slice(0, entry.indexOf('*')).replace(/[^/]*$/, '')
  const found = []
  await walk(join(root, base || '.'))
  for (const file of collected) {
    if (matcher.test(file)) found.push(file)
  }
  if (!found.length) problems.push(`glob matched nothing: ${entry}`)
  return found
}

// npm always ships these
const always = ['package.json', 'README.md', 'LICENSE']
for (const entry of always) {
  try {
    await stat(join(root, entry))
    collected.add(entry)
  } catch {
    problems.push(`npm always includes ${entry}, but it is missing`)
  }
}

for (const entry of pkg.files ?? []) {
  for (const file of await expand(entry)) {
    if (file.startsWith('..')) problems.push(`path escapes the package root: ${file}`)
    collected.add(file)
  }
}

// runtime contract: these must be inside the tarball
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'src/index.js',
  'src/entry.js',
  'src/harnesses.js',
  'src/transport.js',
  'src/provider.js',
  'src/dispatch.js',
  'src/doctor.js',
  'src/migrate.js',
  'src/skills.js',
  'src/config.js',
  'src/ids.js',
  'integration/compatibility.js',
  'integration/execution.js',
  'integration/external-brief.js',
  'integration/migration.js',
  'integration/status.js',
  'vendor/omd/LICENSE',
  'vendor/omd/UPSTREAM.json',
  'vendor/omd/npm-package/preset/preset.js',
  'vendor/omd/npm-package/preset/roles.js',
  'vendor/omd/npm-package/preset/config.js',
  'vendor/omd/npm-package/preset/defaults.json',
  'vendor/omd/npm-package/lib/index.js',
  'vendor/omd/npm-package/lib/config-settings.js',
  'vendor/omd/npm-package/lib/profile-registry.js',
  'vendor/omd/npm-package/client/client.js',
  ...SKILLS.map(({ dir }) => `skills/${dir}/SKILL.md`),
]
for (const file of required) {
  if (!collected.has(file)) problems.push(`required runtime file not shipped: ${file}`)
}

// entry points must resolve inside the package
const entries = [pkg.main, ...Object.values(pkg.exports ?? {}).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))]
for (const entry of entries) {
  if (typeof entry !== 'string' || entry.includes('*')) continue
  const clean = toPosix(entry).replace(/^\.\//, '')
  if (!collected.has(clean)) problems.push(`export target not shipped: ${entry}`)
}

const files = [...collected].sort()
let bytes = 0
for (const file of files) bytes += (await stat(join(root, file))).size

const byTop = new Map()
for (const file of files) {
  const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '(root)'
  byTop.set(top, (byTop.get(top) ?? 0) + 1)
}

if (problems.length) {
  console.error(`pack check failed (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`pack check ok: ${pkg.name}@${pkg.version}`)
console.log(`  files: ${files.length} · ${(bytes / 1024).toFixed(1)} KiB unpacked`)
console.log(`  groups: ${[...byTop].map(([top, n]) => `${top}(${n})`).join(' ')}`)
for (const file of files) console.log(`    ${file}`)
