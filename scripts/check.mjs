/**
 * Package self-check — runs with the Node that ships inside DSH Desktop:
 *
 *   & 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' scripts/check.mjs
 *
 * No dependencies, no build step, no network. It answers one question:
 * would this directory survive being installed as a single bundle?
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseFrontmatter, SKILLS } from '../src/skills.js'

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
ok(pkg.version === '0.5.0-alpha.1', `package.json version must be 0.5.0-alpha.1 (got ${pkg.version})`)
ok(pkg.type === 'module', 'package.json must declare "type": "module"')
ok(Boolean(pkg.dsh?.bundle?.patch), 'package.json must declare dsh.bundle.patch')
ok(Boolean(pkg.engines?.dsh), 'package.json must declare engines.dsh')
ok(pkg.keywords?.includes('dsh-plugin'), 'keywords must include dsh-plugin')
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'the package must stay dependency-free')
ok(pkg.dsh?.client?.platform === 'web', 'the merged package ships one web settings card')
ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings'), 'the client must inject ui-settings')
for (const entry of ['.', './preset', './client', './orchestrator', './profile-registry']) {
  ok(typeof pkg.exports?.[entry] === 'string', `package.json exports must declare ${entry}`)
}
ok(pkg.exports?.['./client'] === './vendor/omd/npm-package/client/client.js', 'the client export must point at the vendored card')

const patchPath = pkg.dsh?.bundle?.patch
if (patchPath) {
  const patch = await readFile(join(root, patchPath), 'utf8')
  ok(patch.includes('id: oh-my-coharness'), 'cordis.patch.yml must insert the oh-my-coharness Host row')
  ok(patch.includes('preset-oh-my-coharness'), 'cordis.patch.yml must insert the single preset row')
  ok(patch.includes("name: 'oh-my-coharness/preset'"), 'the preset row must mount oh-my-coharness/preset')
  ok(patch.includes('oh-my-coharness/profile-registry'), 'cordis.patch.yml must mount the profile registry')
  ok(!patch.includes('preset-omc-harness'), 'the old omc-harness role preset must be gone')
  ok(!patch.includes("preset-oh-my-dsh-slim"), 'the old OMD preset must not be mounted')
  ok(/^\s+default: oh-my-coharness$/m.test(patch), 'the bundle must make Oh My CoHarness the new-session default')
}

const files = pkg.files ?? []
for (const required of ['src', 'integration', 'vendor/omd/npm-package', 'skills', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
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
const modules = ['config', 'harnesses', 'ids', 'transport', 'provider', 'dispatch', 'doctor', 'skills', 'migrate', 'index', 'entry', 'session-adapters']
for (const name of modules) {
  try {
    await import(pathToFileURL(join(root, 'src', `${name}.js`)).href)
  } catch (error) {
    failures.push(`src/${name}.js failed to load: ${error.message}`)
  }
}
for (const name of ['compatibility', 'execution', 'external-brief', 'migration', 'status', 'handoff', 'sessions', 'model-policy']) {
  try {
    await import(pathToFileURL(join(root, 'integration', `${name}.js`)).href)
  } catch (error) {
    failures.push(`integration/${name}.js failed to load: ${error.message}`)
  }
}
for (const relative of [
  'vendor/omd/npm-package/preset/preset.js',
  'vendor/omd/npm-package/preset/roles.js',
  'vendor/omd/npm-package/lib/index.js',
  'vendor/omd/npm-package/lib/profile-registry.js',
]) {
  try {
    await import(pathToFileURL(join(root, relative)).href)
  } catch (error) {
    failures.push(`${relative} failed to load: ${error.message}`)
  }
}

const entry = await import(pathToFileURL(join(root, 'src', 'index.js')).href)
ok(typeof entry.apply === 'function', 'src/index.js must export apply()')
ok(Array.isArray(entry.inject) && entry.inject.includes('tools'), 'src/index.js must inject tools')

const merged = await import(pathToFileURL(join(root, 'src', 'entry.js')).href)
ok(typeof merged.apply === 'function', 'src/entry.js must export apply()')

// The preset identity and role contract are product surface, not internals.
const preset = await import(pathToFileURL(join(root, 'vendor/omd/npm-package/preset/preset.js')).href)
ok(preset.PRESET_ID === 'oh-my-coharness', 'the preset id must be oh-my-coharness')
ok(preset.definition.name === 'Oh My CoHarness', 'the preset display name must be Oh My CoHarness')
const flattenRows = (rows, collected = []) => {
  for (const row of rows) {
    collected.push(row)
    if (Array.isArray(row.config)) flattenRows(row.config, collected)
  }
  return collected
}
const presetRows = flattenRows(preset.definition.plugins)
ok(presetRows.some((row) => row.id === 'tool-subagent-oracle'), 'the preset must keep the oracle role row')
ok(presetRows.some((row) => row.id === 'council-mode'), 'the preset must keep the Council')
ok(presetRows.some((row) => row.id === 'role-composition'), 'the preset must keep the native role composition')
ok(presetRows.some((row) => row.id === 'tool-subagent-councillor-alpha'), 'the preset must keep the alpha council seat')

const { EXTERNAL_ROLE_IDS, validateExecution } = await import(pathToFileURL(join(root, 'integration', 'compatibility.js')).href)
ok(EXTERNAL_ROLE_IDS.includes('oracle') && EXTERNAL_ROLE_IDS.includes('councillor-alpha'), 'oracle and council seats must allow external backends')
ok(EXTERNAL_ROLE_IDS.includes('designer'), 'designer may run external as a read-only patch producer')
for (const nativeOnly of ['fixer', 'librarian', 'observer', 'council']) {
  let threw = false
  try {
    validateExecution(nativeOnly, { execution: { backend: 'omc', harness: 'codex' } })
  } catch {
    threw = true
  }
  ok(threw, `${nativeOnly} must stay native-only in this release`)
}

// v0.5: native-session support is data, not an untyped claim.
const { HARNESSES } = await import(pathToFileURL(join(root, 'src', 'harnesses.js')).href)
const { SESSION_FORMATS } = await import(pathToFileURL(join(root, 'src', 'session-adapters.js')).href)
for (const def of HARNESSES) {
  if (!def.session) continue
  ok(SESSION_FORMATS.includes(def.session.format), `${def.id} has an unknown session format`)
  ok(['verified', 'documented', 'unverified'].includes(def.session.confidence), `${def.id} has an unknown session confidence`)
  ok(typeof def.session.resumeArgs === 'function', `${def.id} must declare resumeArgs`)
  ok(def.capabilities.resume === true, `${def.id} declares a session adapter but capabilities.resume is false`)
}
const sessions = await import(pathToFileURL(join(root, 'integration', 'sessions.js')).href)
ok(typeof sessions.createSessionRegistry === 'function', 'integration/sessions.js must export createSessionRegistry')
const handoff = await import(pathToFileURL(join(root, 'integration', 'handoff.js')).href)
ok(typeof handoff.createHandoff === 'function', 'integration/handoff.js must export createHandoff')

// ── skills ───────────────────────────────────────────────────────────────────
for (const { dir } of SKILLS) {
  try {
    const { data, body } = parseFrontmatter(await readFile(join(root, 'skills', dir, 'SKILL.md'), 'utf8'))
    ok(Boolean(data.name), `skills/${dir}/SKILL.md needs frontmatter name`)
    ok(data.name === dir, `skills/${dir}/SKILL.md frontmatter name must equal the directory (got "${data.name}")`)
    ok(Boolean(data.description), `skills/${dir}/SKILL.md needs frontmatter description`)
    ok(Boolean(data.whenToUse), `skills/${dir}/SKILL.md needs frontmatter whenToUse`)
    ok(body.length > 200, `skills/${dir}/SKILL.md body looks too short`)
  } catch (error) {
    failures.push(`skills/${dir}/SKILL.md unreadable: ${error.message}`)
  }
}
ok(SKILLS.length === 5, `0.4.0 ships five skills (found ${SKILLS.length})`)

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`check failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
for (const note of notes) console.log(`note: ${note}`)
console.log(`check ok: ${pkg.name}@${pkg.version} — manifest, patch, locales, icon, ${modules.length} modules, ${SKILLS.length} skills`)
