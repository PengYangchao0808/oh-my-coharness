/**
 * Benchmark task-set regressions (R07 task set, R08 prerequisite).
 *
 * Every task must fail on its broken start state and pass on its reference fix,
 * graded by the fixed external checker through the real acceptance runner. The
 * set must also contain both kinds the plan requires: a task where resuming is
 * the right call and a task where the stale context makes resuming wrong.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcceptanceRunner, validateAcceptanceSpec } from '../../integration/acceptance-runner.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BENCH = join(root, 'test', 'benchmarks', 'session-strategies')

const TASKS = [
  { dir: 'should-reuse-module-fix', kind: 'should-reuse' },
  { dir: 'should-restart-stale-api', kind: 'should-restart' },
]

async function materialize(taskDir, fix) {
  const source = join(BENCH, taskDir)
  const raw = JSON.parse(await readFile(join(source, 'spec.json'), 'utf8'))
  // The runner validates what it is given; passing an already-normalised spec
  // would validate the normalised shape, which is not a spec document.
  validateAcceptanceSpec(raw)
  const spec = raw
  const dir = await mkdtemp(join(tmpdir(), 'omc-bench-'))
  await cp(join(source, 'acceptance'), join(dir, 'acceptance'), { recursive: true })
  await cp(join(source, 'spec.json'), join(dir, 'spec.json'))
  // "start" is the whole tree; "reference" overlays the files the fix changes.
  await cp(join(source, 'start', 'src'), join(dir, 'src'), { recursive: true })
  if (fix === 'reference') await cp(join(source, 'reference', 'src'), join(dir, 'src'), { recursive: true })
  return { dir, spec, source }
}

for (const task of TASKS) {
  test(`benchmark ${task.dir}: the start state fails and the reference fix passes`, async () => {
    const raw = JSON.parse(await readFile(join(BENCH, task.dir, 'spec.json'), 'utf8'))
    assert.equal(raw.kind, task.kind, `${task.dir} must declare kind=${task.kind}`)

    const broken = await materialize(task.dir, 'start')
    try {
      const runner = createAcceptanceRunner({ cwd: broken.dir })
      const baseline = await runner.baseline({ spec: broken.spec, workdir: broken.dir })
      const verdict = await runner.run({ spec: broken.spec, workdir: broken.dir, baseline })
      assert.equal(verdict.passed, false, 'the start state must not pass')
      assert.ok(
        verdict.checks.some((check) => check.passed === false),
        'the failing check is reported, not just a summary',
      )
      assert.match(verdict.reason, /^OMC\/ACCEPTANCE-CHECK/)
      assert.doesNotMatch(JSON.stringify(verdict.checks), /ACCEPTANCE-TAMPERED/, 'a failing task is not a tampered one')
    } finally {
      await rm(broken.dir, { recursive: true, force: true })
    }

    const fixed = await materialize(task.dir, 'reference')
    try {
      const runner = createAcceptanceRunner({ cwd: fixed.dir })
      const baseline = await runner.baseline({ spec: fixed.spec, workdir: fixed.dir })
      const verdict = await runner.run({ spec: fixed.spec, workdir: fixed.dir, baseline })
      assert.equal(verdict.passed, true, `reference fix must pass (${JSON.stringify(verdict.checks)})`)
      assert.ok(verdict.checks.every((check) => check.passed))
      assert.match(verdict.fingerprint, /^[a-f0-9]{16,}$/)
      const delivered = runner.verifyDelivered({ spec: fixed.spec, workdir: fixed.dir, baseline })
      assert.equal(delivered.passed, true, 'the reference fix does not touch the frozen acceptance files')
    } finally {
      await rm(fixed.dir, { recursive: true, force: true })
    }
  })
}

test('the benchmark set covers both required kinds and keeps families from leaking', async () => {
  const kinds = new Set()
  const families = new Set()
  for (const task of TASKS) {
    const raw = JSON.parse(await readFile(join(BENCH, task.dir, 'spec.json'), 'utf8'))
    kinds.add(raw.kind)
    families.add(raw.family)
    assert.equal(raw.split, 'development', 'a new task starts in development, never in holdout')
    assert.ok(Array.isArray(raw.rubric) && raw.rubric.length >= 3, `${task.dir} needs an explicit rubric`)
    assert.ok(raw.forbidChanges.includes('acceptance/'), `${task.dir} must protect its grader`)
  }
  assert.deepEqual([...kinds].sort(), ['should-restart', 'should-reuse'])
  assert.equal(families.size, TASKS.length, 'each task is its own family, so a split can keep them whole')
})
