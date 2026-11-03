/**
 * Fixed grader for `should-restart-stale-api`.
 *
 * It proves the caller works against the CURRENT contract (async loader) and
 * that the removed synchronous name is gone from src/. Both matter: patching the
 * caller to keep the old name can never pass.
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const cwd = process.cwd()
const cases = []
const check = (name, ok, detail) => cases.push({ name, ok, detail })
const target = pathToFileURL(join(cwd, 'src', 'read-settings.mjs')).href

let readSettings
try {
  ;({ readSettings } = await import(target))
} catch (error) {
  console.log(`fail import: ${String(error?.message ?? error)}`)
  console.log('fail 0/4')
  process.exit(1)
}

check('readSettings is async', readSettings.constructor.name === 'AsyncFunction', readSettings.constructor.name)

const dir = mkdtempSync(join(tmpdir(), 'probe-settings-'))
const settingsPath = join(dir, 'settings.json')
writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', density: 'compact' }), 'utf8')

const loaded = await readSettings(settingsPath)
check('settings are read from disk', loaded.theme === 'dark' && loaded.density === 'compact', JSON.stringify(loaded))
check('missing keys fall back to defaults', loaded.telemetry === false, String(loaded.telemetry))

const missing = await readSettings(join(dir, 'no-such-file.json'))
check('a missing file yields defaults', missing.theme === 'light' && missing.telemetry === false, JSON.stringify(missing))

// The removed synchronous API must not survive in the delivered source.
function sourceFiles(root) {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(absolute))
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry.name))) found.push(absolute)
  }
  return found
}
const stale = sourceFiles(join(cwd, 'src'))
  .filter((file) => readFileSync(file, 'utf8').includes('loadConfigSync'))
  .map((file) => file.slice(cwd.length + 1))
check('the removed synchronous loader is gone', stale.length === 0, stale.join(', '))

const failed = cases.filter((row) => !row.ok)
for (const row of failed) console.log(`fail ${row.name}: ${row.detail}`)
if (failed.length) {
  console.log(`fail ${cases.length - failed.length}/${cases.length}`)
  process.exit(1)
}
console.log(`ok ${cases.length}/${cases.length}`)
