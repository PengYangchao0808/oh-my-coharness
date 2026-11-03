/**
 * Run the package test list and record a machine-readable result file.
 *
 *   node scripts/run-tests.mjs              # full list from package.json scripts.test
 *   node scripts/run-tests.mjs --only wp06  # substring filter, for one work package
 *   node scripts/run-tests.mjs --out docs/evidence/alpha.2/last-test-run.json
 *
 * Each test file runs in its own Node process with inherited stdio. Pipes are
 * deliberately avoided: a confined host sandbox refuses to open them for a
 * child, and a piped run would then look like a test failure. Inherited stdio
 * behaves identically in a normal shell.
 *
 * This runner is the only supported way to produce the machine-readable result
 * that scripts/practice-baseline.mjs ingests. A hand-written result file is not
 * evidence.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test ?? ''
const all = script
  .split('&&')
  .map((entry) => entry.trim().replace(/^node\s+/, ''))
  .filter(Boolean)
const only = option('only', null)
const suites = only ? all.filter((entry) => entry.includes(only)) : all
if (suites.length === 0) {
  console.error(only ? `no test file matches --only ${only}` : 'package.json has no scripts.test entries')
  process.exit(2)
}

const outPath = resolve(root, option('out', 'docs/evidence/alpha.2/last-test-run.json'))
const startedAt = new Date().toISOString()
const records = []
for (const file of suites) {
  const began = Date.now()
  process.stdout.write(`\n=== ${file} ===\n`)
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit', timeout: 900_000 })
  const durationMs = Date.now() - began
  const passed = result.status === 0 && !result.error
  records.push({
    file,
    status: passed ? 'passed' : result.error ? `blocked:${result.error.code ?? 'spawn'}` : 'failed',
    exitCode: result.status ?? null,
    durationMs,
  })
  process.stdout.write(`--- ${file}: ${records.at(-1).status} (${durationMs} ms)\n`)
}

const failed = records.filter((record) => record.status !== 'passed')
const document = {
  schemaVersion: 1,
  kind: 'omc-test-run',
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cwd: root,
  command: 'node scripts/run-tests.mjs',
  suites: records,
  totals: {
    suites: records.length,
    passed: records.length - failed.length,
    failed: failed.length,
    durationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
  },
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`)

process.stdout.write(
  `\ntest run: ${document.totals.passed}/${document.totals.suites} suites passed in ${Math.round(document.totals.durationMs / 1000)}s\n`,
)
if (failed.length) {
  for (const record of failed) process.stdout.write(`  - ${record.status}: ${record.file}\n`)
  process.stdout.write(`result file: ${outPath}\n`)
  process.exit(1)
}
process.stdout.write(`result file: ${outPath}\n`)
