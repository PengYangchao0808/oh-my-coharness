/**
 * R00 baseline evidence: freeze what is actually proven, per capability, per layer.
 *
 *   node scripts/practice-baseline.mjs                # write docs/evidence/alpha.2/practice-baseline.json
 *   node scripts/practice-baseline.mjs --out <path>   # write somewhere else
 *   node scripts/practice-baseline.mjs --stdout       # print instead of writing
 *
 * Inputs
 *   docs/evidence/alpha.2/practice-baseline.sources.json  authored claims + artifact refs
 *   docs/evidence/alpha.2/last-test-run.json              produced by scripts/run-tests.mjs
 *
 * The generated file separates authored claims (sources) from measured facts
 * (commit, tree digest, module check, suite results). A claim whose artifact is
 * missing, and a suite that is missing from the last run, are reported as
 * `unverified` instead of passed: the point of R00 is that an unverified item
 * must never be summarised as green.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const SKIP_DIRS = new Set(['.git', 'node_modules', '.ops', '.obsidian'])
const SKIP_FILES = new Set(['practice-baseline.json', 'last-test-run.json', '.baseline-test.log'])

function run(command, commandArgs, { cwd = root, timeout = 120_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'omc-baseline-'))
  const capture = join(scratch, 'out.log')
  const fd = openSync(capture, 'w')
  let result
  try {
    result = spawnSync(command, commandArgs, { cwd, stdio: ['ignore', fd, fd], timeout })
  } finally {
    closeSync(fd)
  }
  let output = ''
  try {
    output = readFileSync(capture, 'utf8')
  } catch {
    output = ''
  }
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  return { status: result.status ?? null, failed: Boolean(result.error) || result.status !== 0, output: output.trim() }
}

// ── measured facts ───────────────────────────────────────────────────────────
const gitCommit = run('git', ['rev-parse', 'HEAD'])
const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
const gitStatus = run('git', ['status', '--porcelain'])
const statusLines = gitStatus.output.split(/\r?\n/).filter(Boolean)
const changed = statusLines.filter((line) => !line.startsWith('??')).length
const untracked = statusLines.filter((line) => line.startsWith('??')).length

function walk(dir, collected = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), collected)
      continue
    }
    if (!entry.isFile()) continue
    const absolute = join(dir, entry.name)
    if (SKIP_FILES.has(entry.name)) continue
    collected.push(absolute)
  }
  return collected
}

const treeDigest = createHash('sha256')
const fileDigests = []
for (const absolute of walk(root).sort()) {
  const rel = relative(root, absolute).replace(/\\/g, '/')
  if (rel.startsWith('docs/evidence/alpha.2/') && SKIP_FILES.has(rel.split('/').pop())) continue
  let content
  try {
    content = readFileSync(absolute)
  } catch {
    continue
  }
  const digest = createHash('sha256').update(content).digest('hex')
  fileDigests.push({ path: rel, bytes: content.length, sha256: digest })
  treeDigest.update(`${rel}\u0000${content.length}\u0000${digest}\n`)
}
const treeFingerprint = {
  algorithm: 'sha256',
  files: fileDigests.length,
  digest: treeDigest.digest('hex'),
  excludes: [...SKIP_DIRS].map((dir) => `${dir}/`),
}

const check = run(process.execPath, ['scripts/check.mjs'], { timeout: 300_000 })

const readJsonIfPresent = (relativePath) => {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
  } catch {
    return null
  }
}
const lastRun = readJsonIfPresent('docs/evidence/alpha.2/last-test-run.json')
const suiteStatus = new Map((lastRun?.suites ?? []).map((suite) => [suite.file, suite]))

// ── authored claims, with every artifact resolved ────────────────────────────
const sources = readJsonIfPresent('docs/evidence/alpha.2/practice-baseline.sources.json')
if (!sources) {
  console.error('docs/evidence/alpha.2/practice-baseline.sources.json is missing: the baseline has no claims to check')
  process.exit(2)
}

const problems = []
const resolveRef = (ref) => {
  if (ref.startsWith('suite:')) {
    const file = ref.slice('suite:'.length)
    const suite = suiteStatus.get(file)
    if (!suite) {
      problems.push(`${ref}: no result in the last test run`)
      return { kind: 'test-suite', ref: file, resolved: false, status: 'unverified' }
    }
    return { kind: 'test-suite', ref: file, resolved: true, status: suite.status, durationMs: suite.durationMs }
  }
  const absolute = join(root, ref)
  try {
    if (!statSync(absolute).isFile()) throw new Error('not a file')
    return { kind: 'artifact', ref, resolved: true, bytes: statSync(absolute).size }
  } catch {
    problems.push(`${ref}: referenced artifact does not exist`)
    return { kind: 'artifact', ref, resolved: false }
  }
}

const capabilities = (sources.capabilities ?? []).map((capability) => {
  const layers = {}
  for (const [layer, claim] of Object.entries(capability.layers ?? {})) {
    const refs = (claim.refs ?? []).map(resolveRef)
    const declared = claim.status
    // A claim is only as strong as its artifacts: a declined layer stays
    // declined, but a claimed pass with an unresolvable artifact is demoted.
    const effective = declared !== 'passed' ? declared : refs.every((ref) => ref.resolved) ? 'passed' : 'unverified'
    if (effective !== declared) problems.push(`${capability.id}/${layer}: claimed ${declared} but evidence does not resolve`)
    layers[layer] = { status: effective, declared, note: claim.note ?? null, refs }
  }
  return { id: capability.id, title: capability.title, releaseScope: capability.releaseScope ?? null, layers }
})

const totals = {}
for (const capability of capabilities) {
  for (const [layer, entry] of Object.entries(capability.layers)) {
    totals[layer] ??= { passed: 0, partial: 0, 'not-run': 0, blocked: 0, unverified: 0 }
    totals[layer][entry.status] = (totals[layer][entry.status] ?? 0) + 1
  }
}

const document = {
  schemaVersion: 1,
  kind: 'practice-baseline',
  task: 'R00',
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/practice-baseline.mjs',
  packageVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  sources: 'docs/evidence/alpha.2/practice-baseline.sources.json',
  git: {
    commit: gitCommit.failed ? null : gitCommit.output,
    branch: gitBranch.failed ? null : gitBranch.output,
    workingTree: { changed, untracked, clean: changed + untracked === 0 },
  },
  treeFingerprint,
  moduleCheck: {
    command: 'node scripts/check.mjs',
    status: check.failed ? 'failed' : 'passed',
    detail: check.output.split(/\r?\n/).slice(-3).join(' | '),
  },
  testRun: lastRun
    ? {
        source: 'docs/evidence/alpha.2/last-test-run.json',
        startedAt: lastRun.startedAt,
        node: lastRun.node,
        platform: lastRun.platform,
        totals: lastRun.totals,
        failing: (lastRun.suites ?? []).filter((suite) => suite.status !== 'passed').map((suite) => suite.file),
      }
    : { source: null, status: 'not-run', note: 'run `node scripts/run-tests.mjs` before reading this baseline' },
  layers: ['implementation', 'tests', 'hostProbe', 'realModel', 'desktop', 'costCoverage'],
  capabilities,
  totals,
  unresolvedClaims: problems,
  notes: [
    'blocked/not-run/unverified are not passes; only a `passed` layer with resolved artifacts counts as proven',
    'hostProbe means a real installed host was booted; a CI placeholder or a mock never fills this layer',
    'implementation presence is not usability: every `implementation` claim is paired with a tests/hostProbe row',
  ],
}

const serialized = `${JSON.stringify(document, null, 2)}\n`
if (flag('stdout')) {
  process.stdout.write(serialized)
} else {
  const outPath = resolve(root, option('out', 'docs/evidence/alpha.2/practice-baseline.json'))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, serialized)
  process.stdout.write(`baseline written: ${outPath}\n`)
  for (const [layer, counts] of Object.entries(totals)) {
    process.stdout.write(
      `  ${layer.padEnd(14)} passed=${counts.passed ?? 0} partial=${counts.partial ?? 0} not-run=${counts['not-run'] ?? 0} blocked=${counts.blocked ?? 0} unverified=${counts.unverified ?? 0}\n`,
    )
  }
  if (problems.length) {
    process.stdout.write(`unresolved claims (${problems.length}):\n`)
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
  }
  if (check.failed || (lastRun && (lastRun.totals?.failed ?? 0) > 0)) process.exit(1)
}
