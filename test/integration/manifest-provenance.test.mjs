/**
 * Benchmark fixture provenance (0.8 / PR-06).
 *
 * The benchmark set mixes three sources:
 *
 *   A = 4 JavaScript tasks imported from latitude-dev/coding-agent-benchmark
 *   B = 2 Python tasks imported from sipratt-p/coding-agent-bench
 *   C = 3 OMC-authored continuous tasks in test/benchmarks/session-strategies
 *
 * A benchmark number is only evidence if the task it came from is real: the
 * upstream bytes, the frozen commit, the license and the grading program must
 * all be checkable from the checkout, without a network call and without
 * trusting the manifest that asserts them. This file therefore:
 *
 *   1. recomputes every recorded sha256 and re-derives every upstream git blob
 *      sha1 from the vendored bytes on disk (a match proves the vendored file is
 *      byte-identical to the blob at the frozen commit);
 *   2. re-derives the imported grading artifact from the vendored upstream
 *      source (the frozen test file for A, the hidden test_code literal for B)
 *      instead of trusting the copy under `acceptance/`;
 *   3. checks that every declared path stays inside its fixture, that grading
 *      commands are literal argv arrays (never a shell string), and that the
 *      license/commit/dataset triple agrees between the manifest and each spec;
 *   4. grades each imported task both ways through the real acceptance runner:
 *      the start state must fail and the reference solution must pass, with the
 *      frozen acceptance files untouched.
 *
 * Honest limits: B's upstream score also includes a `code_quality` text
 * heuristic and partial-credit group mapping that this repo does not reproduce.
 * Those components are recorded as quarantined/unknown, are excluded from the
 * score claims, and this file does not pretend to reproduce the official score.
 * The B tasks are one-shot generation tasks upstream and ship no start
 * workspace, so their start state is an explicitly labelled OMC-authored stub.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcceptanceRunner, validateAcceptanceSpec } from '../../integration/acceptance-runner.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BENCH = join(root, 'test', 'benchmarks')
const MANIFEST_PATH = join(BENCH, 'MANIFEST.json')

const DATASET_A = 'latitude-dev/coding-agent-benchmark'
const DATASET_B = 'sipratt-p/coding-agent-bench'
const DATASET_C = 'omc-authored'
const COMMIT_A = 'cd28f3965d4d9d2fc9a49faca573f16b5102b488'
const COMMIT_B = '3e9bca9b78790c0d537a505a4f5850e4c7cb35d8'
const GROUP_COUNTS = { A: 4, B: 2, C: 3 }
const EXPERIMENT_COUNTS = { E1: 4, E2: 3, E3: 2 }

// ------------------------------------------------------------------- helpers
/** Does a single `forbidChanges` entry cover the given frozen acceptance file? */
function coversOne(ref, file) {
  const dir = ref.replace(/\/+$/, '')
  return file === dir || file.startsWith(`${dir}/`) || dir.startsWith(`${file}/`)
}

/** Is every frozen acceptance file covered by some `forbidChanges` entry? */
function coversAll(forbidChanges, files) {
  return files.every((file) => forbidChanges.some((ref) => coversOne(ref, file)))
}

const normalize = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
const sha256 = (buffer) => createHash('sha256').update(normalize(buffer)).digest('hex')
const sha256File = async (file) => sha256(await readFile(file))
const gitBlobSha1 = (buffer) => {
  const body = normalize(buffer)
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}
const posix = (path) => path.split(sep).join('/')
const repoRel = (base, file) => posix(resolve(base, file).slice(root.length + 1))

async function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

/** A repo-relative path that cannot escape the checkout. */
function assertRepoRelative(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.length > 0, `${label} must not be empty`)
  assert.ok(!value.includes('\\'), `${label} must use forward slashes: ${value}`)
  assert.ok(!value.startsWith('/'), `${label} must be relative: ${value}`)
  assert.ok(!/^[A-Za-z]:/.test(value), `${label} must not be an absolute Windows path: ${value}`)
  assert.ok(!value.split('/').includes('..'), `${label} must not climb out with ..: ${value}`)
  const absolute = resolve(root, value)
  assert.ok(absolute === root || absolute.startsWith(`${root}${sep}`), `${label} escapes the checkout: ${value}`)
  return absolute
}

/** A fixture-relative path (resolved against the fixture dir, never the checkout). */
function assertFixtureRelative(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.length > 0, `${label} must not be empty`)
  assert.ok(!value.includes('\\'), `${label} must use forward slashes: ${value}`)
  assert.ok(!value.startsWith('/'), `${label} must be relative: ${value}`)
  assert.ok(!/^[A-Za-z]:/.test(value), `${label} must not be an absolute path: ${value}`)
  assert.ok(!value.split('/').includes('..'), `${label} must not climb out with ..: ${value}`)
  return value
}

async function readSpec(task) {
  return JSON.parse(await readFile(join(root, task.specPath), 'utf8'))
}

function pythonCandidates() {
  const candidates = []
  if (process.env.OMC_BENCH_PYTHON) candidates.push(process.env.OMC_BENCH_PYTHON)
  // process.execPath is .../dependencies/node/bin/node[.exe]; the bundled
  // runtimes keep python as a sibling of node.
  const dependencies = resolve(dirname(process.execPath), '..', '..')
  candidates.push(
    join(dependencies, 'python', 'python.exe'),
    join(dependencies, 'python', 'bin', 'python3'),
    join(dependencies, 'python', 'python3.exe'),
  )
  candidates.push('python', 'python3')
  return candidates
}

function probePython() {
  for (const command of pythonCandidates()) {
    try {
      const probe = spawnSync(command, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' })
      if (probe.status !== 0 || probe.error) continue
      const [major, minor] = String(probe.stdout).trim().split('.').map(Number)
      if (Number.isFinite(major) && Number.isFinite(minor)) return { command, major, minor }
    } catch { /* try the next interpreter */ }
  }
  return null
}

const NODE_MAJOR = Number(process.versions.node.split('.')[0])
const NODE_FLOOR = 24

function toolchainPath() {
  const path = [dirname(process.execPath), python && python.command !== 'python' && python.command !== 'python3' ? dirname(python.command) : null, process.env.PATH]
    .filter(Boolean).join(delimiter)
  return path
}

async function copyContents(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) await copyContents(source, dest)
    else await copyFile(source, dest)
  }
}

/**
 * Materialise one task the way the runner expects it: the start tree, then the
 * pristine frozen grading file(s) restored over it (upstream restores test
 * files before scoring), then the reference overlay when grading the fix.
 */
async function materialize(task, spec, fix) {
  const fixture = join(root, task.fixture)
  for (const ref of spec.acceptanceFiles) assertFixtureRelative(ref, `${task.taskId} acceptanceFiles`)
  const dir = await mkdtemp(join(tmpdir(), 'omc-provenance-'))
  await copyContents(join(fixture, 'start'), dir)
  for (const ref of spec.acceptanceFiles) {
    const frozen = join(fixture, 'acceptance', basename(ref))
    if (!existsSync(frozen)) continue
    const dest = join(dir, ...ref.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(frozen, dest)
  }
  if (fix === 'reference') await copyContents(join(fixture, 'reference'), dir)
  return { dir, fixture, spec }
}

async function grade(task, spec, fix) {
  const materialized = await materialize(task, spec, fix)
  try {
    const runner = createAcceptanceRunner({ cwd: materialized.dir })
    const baseline = await runner.baseline({ spec, workdir: materialized.dir })
    // The A fixtures grade themselves with `node --test`; inheriting this
    // process's NODE_TEST_CONTEXT would make the child think it is a nested
    // test file and skip the run, so drop the key for the child.
    const verdict = await runner.run({
      spec,
      workdir: materialized.dir,
      baseline,
      env: { PATH: toolchainPath(), NODE_TEST_CONTEXT: undefined },
    })
    const delivered = fix === 'reference'
      ? runner.verifyDelivered({ spec, workdir: materialized.dir, baseline })
      : null
    return { verdict, delivered, baseline }
  } finally {
    await rm(materialized.dir, { recursive: true, force: true })
  }
}

function extractTestCode(source, marker) {
  const from = source.indexOf(marker)
  if (from < 0) return null
  const token = '"test_code": r"""'
  const start = source.indexOf(token, from)
  if (start < 0) return null
  const bodyStart = start + token.length
  const end = source.indexOf('"""', bodyStart)
  if (end < 0) return null
  return source.slice(bodyStart, end)
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
// Shared prerequisites are registered fixtures too, but they are not trials:
// E1/E2/E3 counts only ever come from `tasks`.
const PREREQUISITES = manifest.prerequisites ?? []
const REGISTERED = [...manifest.tasks, ...PREREQUISITES]
const python = probePython()

// -------------------------------------------------------------- the registry
test('the manifest freezes the three datasets with a real commit and license', async () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(Object.keys(manifest.datasets).sort(), [DATASET_A, DATASET_B, DATASET_C].sort())

  const licenseText = async (path) => readFile(assertRepoRelative(path, 'license.path'), 'utf8')
  for (const [id, dataset] of Object.entries(manifest.datasets)) {
    assert.equal(dataset.id, id, `${id}: dataset id must match its key`)
    assert.match(dataset.repoUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, `${id}: repoUrl must be a GitHub repo`)
    assert.match(dataset.baseCommit, /^[a-f0-9]{40}$/, `${id}: baseCommit must be a full SHA`)
    assert.equal(dataset.license.spdx, 'MIT', `${id}: expected an MIT dataset`)
    assert.match(dataset.license.url, new RegExp(dataset.baseCommit), `${id}: license url must pin the commit`)
    assert.equal(dataset.grading.argv[0], id === DATASET_B ? 'python' : 'node', `${id}: unexpected grading executable`)
    for (const entry of Object.entries(dataset.upstreamDigests)) {
      assertRepoRelative(entry[1].localPath, `${id} upstreamDigests[${entry[0]}].localPath`)
    }
    assert.match(await licenseText(dataset.license.path), /MIT License/, `${id}: the vendored LICENSE is not an MIT license`)
    assert.ok(dataset.verification?.checkedAt, `${id}: the environment that verified the dataset must be recorded`)
    assert.match(dataset.verification.node, /^\d+\.\d+\.\d+$/, `${id}: the verifying Node version must be recorded`)
  }
  assert.equal(manifest.datasets[DATASET_A].baseCommit, COMMIT_A)
  assert.equal(manifest.datasets[DATASET_B].baseCommit, COMMIT_B)
  assert.equal(manifest.datasets[DATASET_C].baseCommit, manifest.omcBaseline.baseCommit)
  assert.equal(manifest.datasets[DATASET_C].authoredBy, 'OMC')
  assert.deepEqual(manifest.datasets[DATASET_C].upstreamDigests, {})
})

test('the A/B/C experiment quotas are registered as 4 / 2 / 3', () => {
  assert.deepEqual(Object.keys(manifest.experiments).sort(), ['E1', 'E2', 'E3'])
  for (const [experiment, expected] of Object.entries(EXPERIMENT_COUNTS)) {
    const entry = manifest.experiments[experiment]
    assert.equal(entry.count, expected, `${experiment} must register ${expected} tasks`)
    assert.equal(entry.taskIds.length, expected, `${experiment} taskIds length must match its count`)
    const registered = manifest.tasks.filter((task) => task.experiment === experiment).map((task) => task.taskId)
    assert.deepEqual([...registered].sort(), [...entry.taskIds].sort(), `${experiment} taskIds must match the task registry`)
  }

  const byDataset = {}
  for (const task of manifest.tasks) byDataset[task.dataset] = (byDataset[task.dataset] ?? 0) + 1
  assert.equal(byDataset[DATASET_A], GROUP_COUNTS.A)
  assert.equal(byDataset[DATASET_B], GROUP_COUNTS.B)
  assert.equal(byDataset[DATASET_C], GROUP_COUNTS.C)
  assert.deepEqual(manifest.counts, { A: 4, B: 2, C: 3, total: 9 })
  assert.equal(manifest.tasks.length, 9)
  assert.equal(manifest.prerequisiteCount, PREREQUISITES.length)
})

test('shared prerequisites are registered but never counted as trials', () => {
  assert.equal(manifest.prerequisiteCount, PREREQUISITES.length)
  assert.ok(PREREQUISITES.length >= 1, 'E2 needs a registered shared prerequisite fixture')
  const trialIds = new Set(manifest.tasks.map((task) => task.taskId))
  for (const prerequisite of PREREQUISITES) {
    assert.ok(!trialIds.has(prerequisite.taskId), `${prerequisite.taskId}: a prerequisite must not also be a trial task`)
    for (const [experiment, entry] of Object.entries(manifest.experiments)) {
      assert.ok(!entry.taskIds.includes(prerequisite.taskId), `${prerequisite.taskId} must not be counted in ${experiment}`)
    }
    assert.match(prerequisite.purpose, /not counted as a trial/i, `${prerequisite.taskId}: the purpose must say it is not a trial`)
    assert.ok(manifest.datasets[prerequisite.dataset], `${prerequisite.taskId}: unknown dataset`)
    assert.ok(existsSync(join(root, prerequisite.fixture)), `${prerequisite.taskId}: fixture directory is missing`)
  }
  assert.deepEqual(manifest.experiments.E2.taskIds, manifest.tasks.filter((task) => task.experiment === 'E2').map((task) => task.taskId))
})

test('every registered task points at a real spec that agrees with the registry', async () => {
  const ids = new Set()
  const families = new Set()
  for (const task of REGISTERED) {
    assert.match(task.taskId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
    assert.ok(!ids.has(task.taskId), `duplicate taskId ${task.taskId}`)
    ids.add(task.taskId)
    assert.ok(!families.has(task.family), `duplicate family ${task.family}: a split could not keep it whole`)
    families.add(task.family)
    assert.equal(task.split, 'development')

    assertRepoRelative(task.fixture, `${task.taskId}.fixture`)
    assertRepoRelative(task.specPath, `${task.taskId}.specPath`)
    assert.ok(existsSync(join(root, task.fixture)), `${task.taskId}: fixture directory is missing`)
    assert.ok(existsSync(join(root, task.specPath)), `${task.taskId}: spec.json is missing`)

    const spec = await readSpec(task)
    validateAcceptanceSpec(spec) // a malformed spec would be a caller bug
    const dataset = manifest.datasets[task.dataset]
    assert.ok(dataset, `${task.taskId}: unknown dataset ${task.dataset}`)
    assert.equal(spec.taskId, task.taskId)
    assert.equal(spec.family, task.family)
    assert.equal(spec.split, task.split)
    assert.equal(spec.provenance?.dataset, task.dataset)
    assert.equal(spec.provenance?.repoUrl, dataset.repoUrl)
    assert.equal(spec.provenance?.baseCommit, dataset.baseCommit)
    assert.deepEqual(spec.provenance?.license, dataset.license)
    assert.equal(spec.provenance?.status, task.status)
    assert.deepEqual((spec.provenance?.quarantined ?? []).map((row) => row.component), task.quarantined)
    assert.match(spec.provenance?.taskId ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
    assert.match(spec.provenance?.importedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.equal(await sha256File(join(root, task.specPath)), task.specSha256, `${task.taskId}: spec.json changed after registration`)
  }

  // No fixture may exist without being registered.
  const onDisk = (await walk(BENCH))
    .filter((file) => basename(file) === 'spec.json')
    .map((file) => repoRel(root, file))
    .sort()
  const registered = REGISTERED.map((task) => task.specPath).sort()
  assert.deepEqual(onDisk, registered, 'every spec.json on disk must be registered, and every registration must exist')
})

test('quarantined components are declared instead of silently scored', () => {
  for (const task of REGISTERED) {
    if (task.quarantined.length > 0) {
      assert.equal(task.status, 'verified-functional', `${task.taskId}: a task with quarantined components is not fully verified`)
      assert.ok(!task.scoreComponents.includes('code_quality'), `${task.taskId}: a quarantined component must not be scored`)
      assert.ok(!task.scoreComponents.includes('official_score'))
    } else {
      assert.equal(task.status, 'verified', `${task.taskId}: an unquarantined task must be verified`)
      assert.deepEqual(task.scoreComponents, ['functional'])
    }
  }
  const b = manifest.tasks.filter((task) => task.dataset === DATASET_B)
  assert.equal(b.length, 2)
  for (const task of b) {
    assert.ok(task.quarantined.includes('code_quality'), `${task.taskId}: code_quality must be marked unknown`)
    assert.ok(task.quarantined.includes('official_score'), `${task.taskId}: the official score must be marked unknown`)
  }
})

// -------------------------------------------------------------------- digests
test('the vendored upstream bytes still hash to the recorded sha256 and git blob', async () => {
  let checked = 0
  for (const [id, dataset] of Object.entries(manifest.datasets)) {
    for (const [upstreamPath, entry] of Object.entries(dataset.upstreamDigests)) {
      const file = assertRepoRelative(entry.localPath, `${id} upstreamDigests[${upstreamPath}]`)
      assert.ok(existsSync(file), `${id}: vendored ${upstreamPath} is missing at ${entry.localPath}`)
      const bytes = await readFile(file)
      assert.equal(gitBlobSha1(bytes), entry.gitBlobSha1, `${id}: ${upstreamPath} is not the blob at the frozen commit`)
      assert.equal(sha256(bytes), entry.sha256, `${id}: ${upstreamPath} does not match its recorded sha256`)
      checked += 1
    }
  }
  assert.ok(checked >= 30, `expected the vendored set to be checked, only saw ${checked} files`)
})

test('each task re-derives its own digests from the fixture files on disk', async () => {
  for (const task of REGISTERED) {
    const spec = await readSpec(task)
    const fixture = join(root, task.fixture)
    for (const [upstreamPath, entry] of Object.entries(spec.provenance.upstreamDigests ?? {})) {
      const file = assertRepoRelative(entry.localPath, `${task.taskId} upstreamDigests[${upstreamPath}]`)
      const bytes = await readFile(file)
      assert.equal(gitBlobSha1(bytes), entry.gitBlobSha1, `${task.taskId}: ${upstreamPath} git blob mismatch`)
      assert.equal(sha256(bytes), entry.sha256, `${task.taskId}: ${upstreamPath} sha256 mismatch`)
    }
    for (const key of ['fixtureDigests', 'localDigests']) {
      for (const [relPath, digest] of Object.entries(spec.provenance[key] ?? {})) {
        assertFixtureRelative(relPath, `${task.taskId} ${key}`)
        const file = join(fixture, ...relPath.split('/'))
        assert.ok(existsSync(file), `${task.taskId}: ${key} names a missing file: ${relPath}`)
        assert.equal(await sha256File(file), digest, `${task.taskId}: ${key}[${relPath}] mismatch`)
      }
    }
  }
})

test('the frozen grading program is the upstream artifact the spec claims', async () => {
  for (const task of REGISTERED) {
    const spec = await readSpec(task)
    const fixture = join(root, task.fixture)
    const grading = spec.provenance.grading
    assertFixtureRelative(grading.frozenFile, `${task.taskId} grading.frozenFile`)
    const frozen = join(fixture, ...grading.frozenFile.split('/'))
    assert.ok(existsSync(frozen), `${task.taskId}: the frozen grading program is missing`)
    assert.equal(await sha256File(frozen), grading.sha256, `${task.taskId}: the pinned grading sha256 is wrong`)

    if (spec.provenance.dataset === DATASET_C) {
      // OMC-authored: the grader is ours, so pin it and make sure no upstream
      // digest is invented for it.
      assert.equal(spec.provenance.authoredBy, 'OMC')
      assert.deepEqual(spec.provenance.upstreamDigests, {})
      assert.equal(spec.provenance.localDigests[grading.frozenFile], grading.sha256)
      continue
    }

    assert.ok(spec.provenance.upstreamDigests, `${task.taskId}: imported tasks must pin upstream digests`)
    assert.ok(Object.keys(spec.provenance.upstreamDigests).length > 0)

    if (spec.provenance.dataset === DATASET_A) {
      // A ships the pristine test file; the frozen copy must equal the upstream
      // blob recorded for that exact path.
      const workdirFile = grading.workdirFile
      assertFixtureRelative(workdirFile, `${task.taskId} grading.workdirFile`)
      assert.ok(spec.acceptanceFiles.includes(workdirFile), `${task.taskId}: the frozen test must be graded in the workdir`)
      const upstreamTest = spec.provenance.upstreamDigests[`tasks/${spec.provenance.taskId}/workspace/${workdirFile}`]
      assert.ok(upstreamTest, `${task.taskId}: no upstream digest for the frozen test file`)
      assert.equal(upstreamTest.sha256, grading.sha256, `${task.taskId}: the frozen test is not the upstream test`)
      assert.equal(spec.provenance.reference.sha256, (await sha256File(join(fixture, 'reference', 'src', basename(spec.reference)))), `${task.taskId}: reference overlay does not match its pinned digest`)
      continue
    }

    // B hides its test program inside a Python module; re-extract it from the
    // vendored module and compare byte for byte with acceptance/hidden-test.py.
    const modulePath = assertRepoRelative(
      spec.provenance.upstreamDigests[grading.upstreamModule].localPath,
      `${task.taskId} upstream module`,
    )
    const source = await readFile(modulePath, 'utf8')
    assert.equal(sha256(Buffer.from(source, 'utf8')), grading.upstreamModuleSha256, `${task.taskId}: upstream module changed`)
    const extracted = extractTestCode(source, grading.testCodeMarker)
    assert.ok(extracted !== null, `${task.taskId}: could not re-extract the hidden test from ${grading.upstreamModule}`)
    assert.equal(sha256(Buffer.from(extracted, 'utf8')), grading.sha256, `${task.taskId}: extracted hidden test != frozen grading copy`)
    assert.equal(sha256(Buffer.from(await readFile(frozen, 'utf8'), 'utf8')), grading.sha256)

    // The wrapper only grades the functional groups the upstream hidden test
    // actually prints, and it is pinned too.
    const groups = [...extracted.matchAll(/ok\("([^"]+)"\)/g)].map((match) => match[1])
    assert.deepEqual([...grading.groups].sort(), [...new Set(groups)].sort(), `${task.taskId}: graded groups drifted from the hidden test`)
    assert.equal(grading.groups.length, groups.length, `${task.taskId}: an ok(...) group is not graded`)
    assert.equal(await sha256File(join(fixture, 'acceptance', 'check.py')), grading.wrapperSha256, `${task.taskId}: the wrapper changed`)
    assert.equal(grading.officialScore, 'unknown')
    assert.equal(grading.codeQuality, 'unknown')
    assert.equal(grading.partialCredit, 'not-reproduced')
    assert.equal(spec.provenance.startState.origin, 'omc-authored-stub', `${task.taskId}: B has no upstream start workspace; the stub must say so`)
  }
})

test('every declared path stays inside its fixture and the checkout', async () => {
  for (const task of REGISTERED) {
    const spec = await readSpec(task)
    assertFixtureRelative(spec.reference, `${task.taskId} reference`)
    assertFixtureRelative(spec.startState.from, `${task.taskId} startState.from`)
    for (const field of ['acceptanceFiles', 'forbidChanges']) {
      assert.ok(Array.isArray(spec[field]) && spec[field].length > 0, `${task.taskId}: ${field} must be a non-empty array`)
      for (const value of spec[field]) assertFixtureRelative(value, `${task.taskId} ${field}`)
    }
    for (const value of spec.commands.flatMap((command) => command.run)) {
      assertFixtureRelative(value, `${task.taskId} command argument`)
    }
    assert.ok(coversAll(spec.forbidChanges, spec.acceptanceFiles), `${task.taskId}: the frozen grading files are not protected by forbidChanges`)

    for (const field of ['path', 'upstreamPath']) {
      const value = spec.provenance.startState[field]
      if (typeof value === 'string') assertFixtureRelative(value, `${task.taskId} startState.${field}`)
    }
    const referencePath = spec.provenance.reference.upstreamPath
    if (typeof referencePath === 'string') {
      assert.ok(/^tasks\//.test(referencePath), `${task.taskId}: reference.upstreamPath must be an upstream path`)
      assert.ok(!referencePath.includes('..'))
    }
    for (const value of [spec.provenance.license.path]) assertRepoRelative(value, `${task.taskId} license.path`)
  }
})

test('grading commands are literal argv arrays and never a shell string', async () => {
  const shellMeta = /[;&|<>`$()\r\n]/
  for (const task of REGISTERED) {
    const spec = await readSpec(task)
    const frozen = spec.provenance.grading
    assert.ok(Array.isArray(frozen.argv), `${task.taskId}: grading.argv must be an array`)
    assert.deepEqual(frozen.argv, spec.commands[0].run, `${task.taskId}: grading.argv must be the real command`)
    for (const command of spec.commands) {
      assert.ok(Array.isArray(command.run), `${task.taskId}: a string command would need a shell`)
      assert.ok(command.run.length >= 1)
      for (const part of command.run) {
        assert.equal(typeof part, 'string', `${task.taskId}: argv parts must be strings`)
        assert.doesNotMatch(part, shellMeta, `${task.taskId}: argv part ${JSON.stringify(part)} contains a shell metacharacter`)
      }
      assert.ok(['node', 'python'].includes(command.run[0]), `${task.taskId}: unexpected executable ${command.run[0]}`)
      assert.ok(Number.isSafeInteger(command.expect?.exitCode ?? 0), `${task.taskId}: expect.exitCode must be an integer`)
    }
  }
})

test('the required runtime is recorded and met, or the task is not counted as verified', async (t) => {
  let belowNodeFloor = false
  for (const task of REGISTERED) {
    const spec = await readSpec(task)
    const verifiedOn = spec.provenance.verifiedOn
    assert.ok(verifiedOn, `${task.taskId}: the environment that verified this fixture must be recorded`)
    assert.match(verifiedOn.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.match(String(verifiedOn.node), /^\d+\.\d+\.\d+$/, `${task.taskId}: the verifying Node version must be recorded`)
    assert.match(String(verifiedOn.python), /^\d+\.\d+\.\d+$/, `${task.taskId}: the verifying Python version must be recorded`)

    if (spec.provenance.dataset === DATASET_A) {
      const minimum = Number(String(spec.provenance.runtime.node).replace(/[^0-9]/g, ''))
      assert.equal(minimum, NODE_FLOOR, `${task.taskId}: the upstream Node floor is 24 and must be recorded as such`)
      assert.ok(
        Number(String(verifiedOn.node).split('.')[0]) >= NODE_FLOOR,
        `${task.taskId}: it cannot be marked verified by a Node below the recorded floor`,
      )
      if (NODE_MAJOR < NODE_FLOOR) belowNodeFloor = true
    }
    if (spec.provenance.dataset === DATASET_B) {
      const minimum = String(spec.provenance.runtime.python)
      assert.match(minimum, /^>=\d+\.\d+$/, `${task.taskId}: the Python floor must be recorded`)
      if (python) {
        const [wantedMajor, wantedMinor] = minimum.slice(2).split('.').map(Number)
        assert.ok(
          python.major > wantedMajor || (python.major === wantedMajor && python.minor >= wantedMinor),
          `${task.taskId}: Python ${python.major}.${python.minor} is below the recorded ${minimum}`,
        )
      }
    }
  }
  if (belowNodeFloor) {
    t.skip(`Node ${process.versions.node} is below the recorded E1 floor of ${NODE_FLOOR}; the A group is not re-verified on this runtime and must not count as a Node<24 result`)
  }
})

// -------------------------------------------------------- two-way grading
for (const task of REGISTERED) {
  test(`fixture ${task.taskId}: the start state fails and the reference passes`, async (t) => {
    const spec = await readSpec(task)
    if (spec.provenance.dataset === DATASET_A && NODE_MAJOR < NODE_FLOOR) {
      t.skip(`the A group requires Node >= ${NODE_FLOOR} (recorded); Node ${process.versions.node} does not verify it`)
      return
    }
    if (spec.provenance.dataset === DATASET_B && !python) {
      t.skip('python is not available in this environment; the B tasks are gated on the recorded Python floor')
      return
    }

    const broken = await grade(task, spec, 'start')
    assert.equal(broken.verdict.passed, false, `${task.taskId}: the start state must not pass`)
    assert.ok(broken.verdict.checks.some((check) => check.passed === false), `${task.taskId}: the failing check must be reported`)
    assert.match(broken.verdict.reason, /^OMC\/ACCEPTANCE-CHECK/, `${task.taskId}: expected a check failure, got ${broken.verdict.reason}`)
    assert.doesNotMatch(JSON.stringify(broken.verdict.checks), /ACCEPTANCE-TAMPERED/)

    const fixed = await grade(task, spec, 'reference')
    assert.equal(fixed.verdict.passed, true, `${task.taskId}: the reference must pass (${JSON.stringify(fixed.verdict.checks)})`)
    assert.ok(fixed.verdict.checks.every((check) => check.passed))
    assert.equal(fixed.delivered.passed, true, `${task.taskId}: the reference touched a forbidden path: ${JSON.stringify(fixed.delivered.problems)}`)
    assert.equal(fixed.verdict.acceptanceDigest, fixed.baseline.acceptanceDigest, `${task.taskId}: the grading program must not change during a run`)
    assert.match(fixed.verdict.fingerprint, /^[a-f0-9]{16,}$/)
  })
}

test('the B start states are labelled OMC-authored and pin no upstream byte', async () => {
  for (const task of manifest.tasks.filter((entry) => entry.dataset === DATASET_B)) {
    const spec = await readSpec(task)
    const start = spec.provenance.startState
    assert.equal(start.origin, 'omc-authored-stub')
    assert.equal(start.upstreamPath, null)
    assert.match(start.note, /no start workspace/i)
    const upstreamSolution = Object.keys(spec.provenance.upstreamDigests).filter((path) => path.startsWith('tasks/refs/'))
    assert.equal(upstreamSolution.length, 1, `${task.taskId}: exactly the reference solution should be upstream`)
    assert.equal(spec.provenance.reference.upstreamPath, upstreamSolution[0])
    assert.ok(!('tasks/' in spec.provenance.upstreamDigests))
  }
})
