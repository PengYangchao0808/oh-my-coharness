/**
 * R07 acceptance-runner tests.
 *
 * The core of this file is REAL: it copies the benchmark task
 * `test/benchmarks/session-strategies/example-local-fix` into a temp directory
 * and runs the fixed acceptance command (`node acceptance/check.mjs`) against
 * (1) the reference fix, (2) the broken start state and (3) a plausible wrong
 * patch. Nothing is mocked for the verdict itself; only the Host subprocess
 * adapter has a fake, because that is an interface contract, not behaviour.
 *
 * Nothing outside the temp directory a test creates is written. `node` must be
 * on PATH for the child process (the test inherits the parent environment).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCEPTANCE_RUNNER_VERSION,
  TASK_SPLITS,
  createAcceptanceRunner,
  deterministicSplit,
} from '../../integration/acceptance-runner.js'

const BENCH_DIR = fileURLToPath(new URL('../benchmarks/session-strategies/example-local-fix/', import.meta.url))
const SPEC = JSON.parse(await readFile(join(BENCH_DIR, 'spec.json'), 'utf8'))
const START_MODULE = join(BENCH_DIR, 'start', 'src', 'parse-range.mjs')
const REFERENCE_MODULE = join(BENCH_DIR, 'reference', 'src', 'parse-range.mjs')
const FIXED_AT = '2026-01-01T00:00:00.000Z'

// A plausible but wrong fix: the range is inclusive now, but a single value
// still returns nothing and invalid input is not rejected. This is the kind of
// patch that passes a worker's own happy-path test and must still fail.
const WRONG_PATCH = `export function parseRange(text) {
  const [start, end] = String(text).split('-').map(Number)
  const out = []
  for (let value = start; value <= end; value += 1) out.push(value)
  return out
}
`

/** Copy the benchmark task into a throwaway tree: <dir>/{spec.json,acceptance,src}. */
async function makeSandbox({ fix = 'start', patch = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omc-acceptance-test-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await cp(join(BENCH_DIR, 'acceptance'), join(dir, 'acceptance'), { recursive: true })
  await cp(join(BENCH_DIR, 'spec.json'), join(dir, 'spec.json'))
  await cp(fix === 'reference' ? REFERENCE_MODULE : START_MODULE, join(dir, 'src', 'parse-range.mjs'))
  if (patch !== null) await writeFile(join(dir, 'src', 'parse-range.mjs'), patch)
  return dir
}

function runnerFor(dir, extra = {}) {
  return createAcceptanceRunner({ cwd: dir, now: () => FIXED_AT, ...extra })
}

function fakeSubprocess(responder) {
  const calls = []
  return {
    calls,
    async resolveExecutable(bin) { return `C:/fake/${bin}.exe` },
    spawn(spec) {
      calls.push(spec)
      const result = responder(spec)
      const read = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return {
        collected: { stdout: read(result.stdout ?? ''), stderr: read(result.stderr ?? '') },
        done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
        terminate() {},
      }
    },
  }
}

test('the reference fix passes the fixed acceptance command', async () => {
  const dir = await makeSandbox({ fix: 'reference' })
  try {
    const verdict = await runnerFor(dir).run({ spec: SPEC, workdir: dir })
    assert.equal(verdict.passed, true, verdict.reason ?? '')
    assert.equal(verdict.reason, null)
    assert.equal(verdict.version, ACCEPTANCE_RUNNER_VERSION)
    assert.equal(verdict.taskId, 'example-local-fix')
    assert.equal(verdict.split, 'development')
    assert.equal(verdict.at, FIXED_AT)
    assert.equal(verdict.checks.length, 1)
    const [check] = verdict.checks
    assert.equal(check.name, 'contract')
    assert.equal(check.command, 'node acceptance/check.mjs')
    assert.equal(check.exitCode, 0)
    assert.equal(check.passed, true)
    assert.match(check.outputTail, /ok 7\/7/)
    assert.deepEqual(verdict.problems, [])
    assert.match(verdict.fingerprint, /^[0-9a-f]{64}$/)
    assert.match(verdict.acceptanceDigest, /^[0-9a-f]{64}$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the broken start state fails without throwing', async () => {
  const dir = await makeSandbox()
  try {
    const verdict = await runnerFor(dir).run({ spec: SPEC, workdir: dir })
    assert.equal(verdict.passed, false)
    assert.match(verdict.reason, /^OMC\/ACCEPTANCE-CHECK: contract/)
    const [check] = verdict.checks
    assert.equal(check.passed, false)
    assert.equal(check.exitCode, 1)
    assert.match(check.outputTail, /fail 1\/7/)
    assert.match(check.outputTail, /1-3/)
    assert.deepEqual(check.problems, ['exit code 1, expected 0'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a plausible wrong patch still fails the fixed acceptance command', async () => {
  const dir = await makeSandbox({ patch: WRONG_PATCH })
  try {
    const verdict = await runnerFor(dir).run({ spec: SPEC, workdir: dir })
    assert.equal(verdict.passed, false)
    assert.match(verdict.reason, /^OMC\/ACCEPTANCE-CHECK/)
    assert.equal(verdict.checks[0].passed, false)
    assert.equal(verdict.checks[0].exitCode, 1)
    // The wrong patch does fix "1-3"; it fails on the single value and the
    // error cases, which is exactly the leak an acceptance command must close.
    assert.doesNotMatch(verdict.checks[0].outputTail, /FAIL "1-3"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editing an acceptanceFiles entry between baseline and run is OMC/ACCEPTANCE-TAMPERED', async () => {
  const dir = await makeSandbox({ fix: 'reference' })
  try {
    const runner = runnerFor(dir)
    const baseline = await runner.baseline({ spec: SPEC, workdir: dir })
    assert.equal(baseline.taskId, 'example-local-fix')
    assert.match(baseline.fingerprint, /^[0-9a-f]{64}$/)
    assert.ok(Object.keys(baseline.files).includes('acceptance/check.mjs'))

    // The worker replaces the grader with one that only prints the magic line.
    await writeFile(join(dir, 'acceptance', 'check.mjs'), "console.log('ok 7/7')\n")

    const verdict = await runner.run({ spec: SPEC, workdir: dir, baseline })
    assert.equal(verdict.passed, false)
    assert.match(verdict.reason, /^OMC\/ACCEPTANCE-TAMPERED/)
    // The compromised command itself passes; only the digest comparison
    // catches the rewrite. That is the whole point of the runner.
    assert.equal(verdict.checks[0].passed, true)
    assert.match(verdict.acceptanceDigestBefore, /^[0-9a-f]{64}$/)
    assert.notEqual(verdict.acceptanceDigestBefore, verdict.acceptanceDigest)
    assert.match(verdict.problems.join('\n'), /acceptance definition changed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyDelivered reports a forbidChanges violation against the frozen baseline', async () => {
  const dir = await makeSandbox({ fix: 'reference' })
  try {
    const runner = runnerFor(dir)
    const baseline = await runner.baseline({ spec: SPEC, workdir: dir })

    // A delivery that only touched src/ is inside its write scope.
    const clean = runner.verifyDelivered({ spec: SPEC, workdir: dir, baseline })
    assert.deepEqual(clean, { passed: true, problems: [] })

    await writeFile(join(dir, 'src', 'parse-range.mjs'), `${await readFile(REFERENCE_MODULE, 'utf8')}\n// worker note\n`)
    assert.equal(runner.verifyDelivered({ spec: SPEC, workdir: dir, baseline }).passed, true)

    // Touching the acceptance definition is not.
    await writeFile(join(dir, 'spec.json'), `${JSON.stringify(SPEC, null, 2)}\n`)
    const violated = runner.verifyDelivered({ spec: SPEC, workdir: dir, baseline })
    assert.equal(violated.passed, false)
    assert.equal(violated.problems.length, 1)
    assert.match(violated.problems[0], /spec\.json changed after the baseline/)

    // No baseline means no claim: never a silent pass.
    const unsupported = runner.verifyDelivered({ spec: SPEC, workdir: dir })
    assert.equal(unsupported.passed, false)
    assert.match(unsupported.problems[0], /no baseline/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('forbidChanges inside run() needs a baseline and is otherwise a warning', async () => {
  const dir = await makeSandbox({ fix: 'reference' })
  try {
    const runner = runnerFor(dir)
    const withoutBaseline = await runner.run({ spec: SPEC, workdir: dir })
    assert.equal(withoutBaseline.passed, true)
    assert.match(withoutBaseline.warnings.join('\n'), /forbidChanges was not evaluated/)

    const baseline = await runner.baseline({ spec: SPEC, workdir: dir })
    await writeFile(join(dir, 'acceptance', 'check.mjs'), "console.log('ok 7/7')\n")
    const verdict = await runner.run({ spec: SPEC, workdir: dir, baseline })
    assert.equal(verdict.passed, false)
    // Tampering wins the reason, but the forbidden change is still reported.
    assert.match(verdict.reason, /^OMC\/ACCEPTANCE-TAMPERED/)
    assert.match(verdict.problems.join('\n'), /acceptance\/check\.mjs changed after the baseline/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the tree fingerprint is stable across two runs and moves after a real edit', async () => {
  const dir = await makeSandbox()
  try {
    const runner = runnerFor(dir)
    const first = await runner.run({ spec: SPEC, workdir: dir })
    const second = await runner.run({ spec: SPEC, workdir: dir })
    assert.equal(first.fingerprint, second.fingerprint)
    assert.equal(first.acceptanceDigest, second.acceptanceDigest)
    assert.equal(first.passed, second.passed)

    await writeFile(join(dir, 'src', 'parse-range.mjs'), await readFile(REFERENCE_MODULE, 'utf8'))
    const edited = await runner.run({ spec: SPEC, workdir: dir })
    assert.notEqual(edited.fingerprint, first.fingerprint)
    assert.equal(edited.passed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the injected subprocess service executes the literal argv, never a shell', async () => {
  const dir = await makeSandbox({ fix: 'reference' })
  try {
    const service = fakeSubprocess(() => ({ exitCode: 0, stdout: 'ok 7/7\n' }))
    const verdict = await runnerFor(dir, { subprocess: service }).run({ spec: SPEC, workdir: dir, env: { OMC_TASK: 'x' } })
    assert.equal(verdict.passed, true, verdict.reason ?? '')
    assert.equal(service.calls.length, 1)
    const [spawn] = service.calls
    assert.deepEqual(spawn.argv, ['C:/fake/node.exe', 'acceptance/check.mjs'])
    assert.equal(spawn.cwd, dir)
    assert.equal(spawn.env.OMC_TASK, 'x')
    assert.equal('shell' in spawn, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed spec throws OMC/ACCEPTANCE-SPEC instead of inventing a verdict', async () => {
  const dir = await makeSandbox()
  try {
    const runner = runnerFor(dir)
    for (const spec of [
      { ...SPEC, split: 'testing' },
      { ...SPEC, commands: [] },
      { ...SPEC, acceptanceFiles: ['../outside.mjs'] },
      { ...SPEC, taskId: 'not valid!' },
    ]) {
      await assert.rejects(runner.run({ spec, workdir: dir }), (error) => error.code === 'OMC/ACCEPTANCE-SPEC')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const SPLIT_TASKS = [
  'local-fix', 'local-fix-b', 'cross-file', 'cross-file-b', 'interface', 'interface-b',
  'long-echo', 'long-echo-b', 'wrong-assumption', 'wrong-assumption-b', 'cancel-recovery', 'cancel-recovery-b',
].map((family, index) => ({ id: `${family}-${index % 2 === 0 ? 'a' : 'b'}`, family }))

function splitMap(result) {
  return Object.fromEntries(TASK_SPLITS.flatMap((split) => result[split].map((id) => [id, split])))
}

test('deterministicSplit is stable for one salt and every task lands in exactly one split', () => {
  assert.deepEqual(TASK_SPLITS, ['development', 'validation', 'holdout'])
  const first = deterministicSplit({ tasks: SPLIT_TASKS, salt: 'omc-v1' })
  const again = deterministicSplit({ tasks: SPLIT_TASKS, salt: 'omc-v1' })
  assert.deepEqual(first, again)

  const assigned = TASK_SPLITS.flatMap((split) => first[split])
  assert.equal(assigned.length, SPLIT_TASKS.length)
  assert.equal(new Set(assigned).size, SPLIT_TASKS.length)
  assert.ok(first.development.length > 0)
  assert.ok(first.validation.length > 0)
  assert.ok(first.holdout.length > 0)
  assert.ok(Array.isArray(first.notes))
})

test('deterministicSplit never splits one family and moves with another salt', () => {
  const build = (salt) => deterministicSplit({ tasks: SPLIT_TASKS, salt })
  const first = build('omc-v1')
  const map = splitMap(first)
  for (const family of new Set(SPLIT_TASKS.map((task) => task.family))) {
    const splits = new Set(
      TASK_SPLITS.flatMap((split) => first[split]).filter((id) => map[id] && SPLIT_TASKS.find((t) => t.id === id).family === family).map((id) => map[id]),
    )
    assert.equal(splits.size, 1, `family ${family} leaked across splits`)
  }
  const other = splitMap(build('omc-v2'))
  const moved = Object.keys(map).filter((id) => map[id] !== other[id])
  assert.ok(moved.length > 0, 'a different salt must produce a different assignment')
})

test('deterministicSplit records a singleton family as development-preferred', () => {
  const tasks = [
    { id: 'solo-a', family: 'solo' },
    { id: 'fix-a', family: 'fix' },
    { id: 'fix-b', family: 'fix' },
  ]
  const result = deterministicSplit({ tasks, salt: 'omc-v1' })
  assert.deepEqual(result.development.filter((id) => id === 'solo-a'), ['solo-a'])
  assert.match(result.notes.join('\n'), /family "solo" has a single task/)
  assert.match(result.notes.join('\n'), /development-preferred/)
  assert.match(result.notes.join('\n'), /approximate the weights/)
})
