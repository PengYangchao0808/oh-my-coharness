/**
 * Package self-check — runs with the Node that ships inside DSH Desktop:
 *
 *   & 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' scripts/check.mjs
 *
 * No dependencies, no build step, no network. It answers one question:
 * would this directory survive being installed as a bundle?
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseFrontmatter } from '../src/skills.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const notes = []

function ok(condition, message) {
  if (!condition) failures.push(message)
}

async function readJson(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'))
}

// ── manifest ─────────────────────────────────────────────────────────────────
const pkg = await readJson('package.json')
ok(pkg.name === 'oh-my-coharness', 'package.json name must be oh-my-coharness')
ok(pkg.type === 'module', 'package.json must declare "type": "module"')
ok(Boolean(pkg.dsh?.bundle?.patch), 'package.json must declare dsh.bundle.patch')
ok(Boolean(pkg.engines?.dsh), 'package.json must declare engines.dsh')
ok(pkg.keywords?.includes('dsh-plugin'), 'keywords must include dsh-plugin')
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'v0.1 must stay dependency-free')
ok(!pkg.dsh?.client, 'v0.1 is Host-only: dsh.client must stay absent')

const patchPath = pkg.dsh?.bundle?.patch
if (patchPath) {
  const patch = await readFile(join(root, patchPath), 'utf8')
  ok(patch.includes('oh-my-coharness'), 'cordis.patch.yml must insert the oh-my-coharness row')
}

const files = pkg.files ?? []
for (const required of ['src', 'skills', 'cordis.patch.yml', 'README.md']) {
  ok(files.includes(required), `package.json files must include ${required}`)
}

// ── locales + icon ───────────────────────────────────────────────────────────
for (const locale of ['en', 'zh']) {
  const document = await readJson(`locale/${locale}.json`)
  ok(typeof document.meta?.title === 'string' && document.meta.title.length > 0, `locale/${locale}.json needs meta.title`)
  ok(
    typeof document.meta?.description === 'string' && document.meta.description.length > 0,
    `locale/${locale}.json needs meta.description`,
  )
}

try {
  const icon = await stat(join(root, 'icon.svg'))
  ok(icon.size > 0 && icon.size <= 256 * 1024, 'icon.svg must exist and stay under 256 KiB')
} catch {
  failures.push('icon.svg is missing')
}

// ── modules load ─────────────────────────────────────────────────────────────
const modules = ['config', 'harnesses', 'ids', 'transport', 'provider', 'dispatch', 'doctor', 'skills', 'index']
for (const name of modules) {
  try {
    await import(pathToFileURL(join(root, 'src', `${name}.js`)).href)
  } catch (error) {
    failures.push(`src/${name}.js failed to load: ${error.message}`)
  }
}

const entry = await import(pathToFileURL(join(root, 'src', 'index.js')).href)
ok(typeof entry.apply === 'function', 'src/index.js must export apply()')
ok(Array.isArray(entry.inject) && entry.inject.includes('tools'), 'src/index.js must inject tools')

// ── skills ───────────────────────────────────────────────────────────────────
for (const dir of ['coharness', 'coharness-setup']) {
  try {
    const { data, body } = parseFrontmatter(await readFile(join(root, 'skills', dir, 'SKILL.md'), 'utf8'))
    ok(Boolean(data.name), `skills/${dir}/SKILL.md needs frontmatter name`)
    ok(Boolean(data.description), `skills/${dir}/SKILL.md needs frontmatter description`)
    ok(body.length > 200, `skills/${dir}/SKILL.md body looks too short`)
  } catch (error) {
    failures.push(`skills/${dir}/SKILL.md unreadable: ${error.message}`)
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`check failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
for (const note of notes) console.log(`note: ${note}`)
console.log(`check ok: ${pkg.name}@${pkg.version} — manifest, patch, locales, icon, ${modules.length} modules, 2 skills`)
