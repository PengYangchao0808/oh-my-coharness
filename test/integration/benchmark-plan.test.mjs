/**
 * Real-fixture experiment plans (0.8 / PR-07 prerequisite).
 *
 * test/benchmarks/MANIFEST.json registers 9 real graded fixtures (4 Latitude
 * JS, 2 sipratt Python, 3 OMC continuous). This file proves that the three plan
 * documents under test/benchmarks/plans/ are bound to those fixtures, not to
 * synthetic placeholders:
 *
 *   E1 = 4 Latitude tasks x 3 role arms        = 12 trials
 *   E2 = 3 OMC continuous tasks x 3 strategies =  9 trials
 *        + 1 shared prerequisite run once per arm (NOT a trial)
 *   E3 = 2 sipratt tasks x 2 role arms         =  4 trials
 *                                              = 25 trials total
 *
 * It actually runs `scripts/strategy-runner.mjs --plan` (and the exported
 * planExperiment() for the same documents), confirms the plan is deterministic,
 * writes nothing, and never executes a model. It also proves the paid-execute
 * double gate still refuses: no `--confirm-paid-experiment`/`--max-usd`, and
 * with both gates the CLI still has no host executor and refuses.
 *
 * Honest scope: this is a plan, not a run. Model/provider/harness are explicit
 * `placeholder-*` values with executionStatus "not-executed"; the frozen
 * manifest digest covers that. A real execute still needs a model/harness
 * selection, a host executor implementing runTrial(), machine-specific upstream
 * checkouts at the frozen commits, and (for E2) the fixtures committed so a
 * worktree can be created.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSION_STRATEGIES, createStrategyExperiment } from '../../integration/strategy-eval.js'
import { planExperiment } from '../../scripts/strategy-runner.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BENCH = join(root, 'test', 'benchmarks')
const PLANS = join(BENCH, 'plans')
const RUNNER = join(root, 'scripts', 'strategy-runner.mjs')
const RECEIPT_DIR = join(root, 'docs', 'evidence', 'alpha.2', 'session-strategies')

const MANIFEST = JSON.parse(readFileSync(join(BENCH, 'MANIFEST.json'), 'utf8'))
const REGISTERED = [...MANIFEST.tasks, ...(MANIFEST.prerequisites ?? [])]
const REGISTERED_BY_ID = new Map(REGISTERED.map((row) => [row.taskId, row]))
const REVISION = (row) => `fixture@${row.specSha256.slice(0, 16)}`

const GROUPS = ['E1', 'E2', 'E3']
const PLAN_FILES = { E1: join(PLANS, 'e1.json'), E2: join(PLANS, 'e2.json'), E3: join(PLANS, 'e3.json') }
const EXPECTED = {
  E1: { trials: 12, tasks: 4, arms: ['single', 'same-model-multi-role', 'different-model-multi-role'] },
  E2: { trials: 9, tasks: 3, arms: [...SESSION_STRATEGIES] },
  E3: { trials: 4, tasks: 2, arms: ['single', 'multi-role'] },
}
const PREREQUISITE_ID = 'omc-session-primer'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const planFile = (group) => readJson(PLAN_FILES[group])

function cli(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, encoding: 'utf8' })
}

function receiptFiles() {
  if (!existsSync(RECEIPT_DIR)) return []
  return readdirSync(RECEIPT_DIR).sort()
}

/** Every plan document, re-run through the CLI once and cached. */
const CLI = new Map()
for (const group of GROUPS) {
  const run = cli(['--manifest', PLAN_FILES[group], '--plan'])
  assert.equal(run.status, 0, `${group}: --plan must exit 0 (stderr: ${run.stderr})`)
  assert.equal(run.stderr.trim(), '', `${group}: --plan must not print warnings/errors`)
  CLI.set(group, JSON.parse(run.stdout))
}

test('the three plan documents freeze 12 + 9 + 4 = 25 real trials', () => {
  let total = 0
  const trialIds = new Set()
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    const expected = EXPECTED[group]
    assert.equal(plan.mode, 'plan')
    assert.equal(plan.executesAnything, false, `${group}: a plan must never execute anything`)
    assert.equal(plan.experimentGroup, group)
    assert.equal(plan.manifest.experimentGroup, group)
    assert.equal(plan.assignmentCount, expected.trials, `${group}: expected ${expected.trials} trials`)
    assert.equal(plan.taskCount, expected.tasks, `${group}: expected ${expected.tasks} real tasks`)
    assert.equal(plan.manifest.repeats, 1, `${group}: the pilot freezes repeats=1`)
    assert.equal(plan.trials.length, expected.trials)
    assert.deepEqual(plan.arms, expected.arms, `${group}: unexpected arms`)
    assert.deepEqual(plan.problems, [], `${group}: the frozen allocation must verify`)
    assert.deepEqual(plan.warnings, [], `${group}: budget/concurrency/deadline must be frozen`)

    for (const trial of plan.trials) {
      assert.ok(!trialIds.has(trial.trialId), `duplicate trialId ${trial.trialId} across plans`)
      trialIds.add(trial.trialId)
      assert.equal(trial.group, group)
      assert.ok(expected.arms.includes(trial.arm))
      assert.equal(trial.strategy, trial.arm)
      assert.equal(trial.repeat, 0)
    }
    total += plan.assignmentCount
  }
  assert.equal(total, 25)
  assert.equal(trialIds.size, 25)
  assert.equal(MANIFEST.tasks.length, 9, 'the plans must be built on the 9 registered real fixtures')
})

test('each plan is deterministic and matches the exported plan API', () => {
  for (const group of GROUPS) {
    const document = planFile(group)
    const first = CLI.get(group)
    const second = cli(['--manifest', PLAN_FILES[group], '--plan'])
    assert.equal(second.status, 0)
    assert.equal(second.stdout, cli(['--manifest', PLAN_FILES[group], '--plan']).stdout, `${group}: two --plan runs must print identical bytes`)

    // The frozen manifest digest must reproduce from the document itself.
    const regenerated = createStrategyExperiment(document.manifest)
    assert.equal(regenerated.digest, document.manifest.digest, `${group}: the frozen manifest digest does not reproduce`)
    assert.deepEqual(regenerated.assignments, document.manifest.assignments, `${group}: assignments are not reproducible`)

    // The CLI is a thin wrapper over the public plan API: same object.
    assert.deepEqual(first, planExperiment({ document }), `${group}: CLI plan diverged from planExperiment()`)
    assert.equal(first.manifest.digest, document.manifest.digest)
  }
})

test('every trial is bound to one real fixture, spec and acceptance digest', () => {
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    for (const trial of plan.trials) {
      const registered = REGISTERED_BY_ID.get(trial.taskId)
      assert.ok(registered, `${group}/${trial.taskId}: no registered fixture for this trial`)
      const planTask = plan.tasks.find((task) => task.id === trial.taskId)
      assert.ok(planTask, `${group}/${trial.taskId}: the plan has no task entry for this trial`)
      assert.equal(trial.taskRevision, REVISION(registered), `${group}/${trial.taskId}: revision is not the frozen fixture digest`)
      assert.equal(trial.baseCommit, readJson(join(root, registered.specPath)).provenance.baseCommit)

      const provenance = trial.provenance
      assert.ok(provenance, `${group}/${trial.taskId}: the trial must carry provenance`)
      assert.equal(provenance.dataset, registered.dataset)
      assert.equal(provenance.spec, registered.specPath)
      assert.equal(provenance.specSha256, registered.specSha256)
      assert.equal(provenance.commitUrl, MANIFEST.datasets[registered.dataset].commitUrl)
      assert.equal(provenance.license.spdx, 'MIT')
      assert.ok(existsSync(join(root, provenance.license.path)), `${group}/${trial.taskId}: license file is missing`)
      assert.ok(existsSync(join(root, provenance.fixture)), `${group}/${trial.taskId}: fixture directory is missing`)
      assert.ok(existsSync(join(root, planTask.acceptance.spec)), `${group}/${trial.taskId}: acceptance spec is missing`)

      const spec = readJson(join(root, registered.specPath))
      assert.equal(planTask.acceptance.specSha256, registered.specSha256)
      assert.equal(planTask.acceptance.gradingSha256, spec.provenance.grading.sha256, `${group}/${trial.taskId}: acceptance digest drifted`)
      assert.deepEqual(planTask.acceptance.command, spec.commands[0].run, `${group}/${trial.taskId}: acceptance argv drifted`)
      assert.equal(planTask.acceptance.frozenFile, spec.provenance.grading.frozenFile)
      assert.deepEqual(provenance.quarantined, registered.quarantined)
      assert.equal(provenance.status, registered.status)
    }
    // Every registered real task appears exactly once as a plan task, and the
    // plan's task list carries the same acceptance pins.
    for (const task of plan.tasks) {
      const registered = REGISTERED_BY_ID.get(task.id)
      assert.ok(registered, `${group}: plan task ${task.id} is not registered`)
      assert.equal(task.acceptance.gradingSha256, readJson(join(root, registered.specPath)).provenance.grading.sha256)
    }
  }

  const planned = GROUPS.flatMap((group) => CLI.get(group).tasks.map((task) => task.id)).sort()
  assert.deepEqual(planned, MANIFEST.tasks.map((task) => task.taskId).sort(), 'the plans must cover exactly the 9 registered tasks once')
})

test('E2 freezes a shared prerequisite and ordered chains, without counting either as extra trials', () => {
  const plan = CLI.get('E2')
  assert.ok(plan.prerequisite, 'E2 must declare its shared prerequisite')
  assert.equal(plan.prerequisite.id, PREREQUISITE_ID)
  assert.equal(plan.prerequisite.countedAsTrial, false)
  assert.equal(plan.prerequisite.revision, REVISION(REGISTERED_BY_ID.get(PREREQUISITE_ID)))
  assert.ok(existsSync(join(root, plan.prerequisite.provenance.spec)), 'the prerequisite spec must exist')

  // One prerequisite run per arm, never an independent trial.
  assert.equal(plan.prerequisites.length, plan.arms.length, 'one prerequisite run per arm')
  assert.deepEqual(plan.prerequisites.map((row) => row.arm).sort(), [...plan.arms].sort())
  for (const row of plan.prerequisites) {
    assert.equal(row.taskId, PREREQUISITE_ID)
    assert.equal(row.countedAsTrial, false)
    assert.equal(row.baseCommit, plan.prerequisite.baseCommit)
  }
  assert.equal(plan.trials.some((trial) => trial.taskId === PREREQUISITE_ID), false, 'the prerequisite must not be a trial')

  // Each E2 task is a real ordered chain (>= 2 steps), and the plan keeps the
  // spec's step order.
  for (const task of plan.tasks) {
    assert.equal(task.kind, 'chain', `${task.id} must be a chain`)
    assert.ok(Array.isArray(task.chain) && task.chain.length >= 2, `${task.id} needs at least two ordered steps`)
    const spec = readJson(join(root, REGISTERED_BY_ID.get(task.id).specPath))
    assert.deepEqual(task.chain.map((step) => step.id), spec.chain.map((step) => step.id), `${task.id}: chain order drifted`)
    for (const step of task.chain) {
      assert.equal(typeof step.id, 'string')
      assert.equal(typeof step.goal, 'string')
    }
  }

  // The trial count stays 3 tasks x 3 strategies; the prerequisite does not add.
  assert.equal(plan.assignmentCount, 9)
  assert.equal(plan.assignmentCount + plan.prerequisites.length, 12, '9 trials + 3 arm-level prerequisite runs')
})

test('the plans freeze budget/concurrency/deadline and mark execution as not executed', () => {
  const before = receiptFiles()
  for (const group of GROUPS) {
    const document = planFile(group)
    const plan = CLI.get(group)
    assert.equal(document.status, 'not-executed', `${group}: the document must say it was not executed`)
    assert.equal(document.inputs.status, 'not-executed')
    assert.equal(document.inputs.modelSelection, 'not-selected')
    assert.equal(document.inputs.harnessSelection, 'not-selected')
    assert.equal(document.inputs.hostExecutor, 'not-installed')
    assert.ok(document.inputs.blockers.length >= 2)

    // Budget caps are frozen and coherent; the CLI reports the same numbers.
    assert.ok(document.budget.totalUsd > 0)
    assert.ok(document.budget.perTrialUsd > 0)
    assert.ok(document.budget.perTrialUsd <= document.budget.totalUsd)
    assert.equal(plan.budgetCaps.totalUsd, document.budget.totalUsd)
    assert.equal(plan.budgetCaps.perTrialUsd, document.budget.perTrialUsd)
    assert.equal(plan.concurrency, 1)
    assert.equal(typeof document.concurrency, 'number')
    assert.ok(Number.isFinite(Date.parse(document.deadline)))
    assert.equal(plan.deadline, document.deadline)

    // No model/harness is claimed: explicit placeholders only.
    const conditions = plan.manifest.conditions
    assert.deepEqual(conditions, document.manifest.conditions, `${group}: conditions are frozen`)
    assert.equal(conditions.executionStatus, 'not-executed')
    assert.equal(conditions.modelSelected, false)
    assert.equal(conditions.harnessSelected, false)
    for (const key of ['provider', 'model', 'harness']) {
      assert.match(conditions[key], /^placeholder-/, `${group}: ${key} must be a declared placeholder, not a real selection`)
    }
    assert.equal(plan.model, conditions.model)
    assert.match(plan.model, /placeholder/)
  }
  // --plan writes no receipt and creates no receipt directory.
  assert.deepEqual(receiptFiles(), before, '--plan must not write a receipt')
  assert.equal(existsSync(RECEIPT_DIR), false, '--plan must not create the receipt directory')
})

test('the paid-execute double gate still refuses, with and without its two flags', () => {
  const before = receiptFiles()
  for (const group of GROUPS) {
    // Gate 1: neither explicit confirmation nor a USD ceiling.
    const noGate = cli(['--manifest', PLAN_FILES[group], '--execute'])
    assert.equal(noGate.status, 2, `${group}: --execute without its gates must be refused`)
    assert.match(noGate.stderr, /OMC\/TRIAL-NOT-CONFIRMED/)
    assert.match(noGate.stderr, /--max-usd/)

    // Gate 2: both flags supplied, but this CLI has no host executor, so it
    // still refuses instead of dispatching a paid model.
    const confirmed = cli(['--manifest', PLAN_FILES[group], '--execute', '--max-usd', '1', '--confirm-paid-experiment'])
    assert.equal(confirmed.status, 2, `${group}: --execute must refuse without a host executor`)
    assert.match(confirmed.stderr, /OMC\/TRIAL-NO-EXECUTOR/)
    assert.doesNotMatch(confirmed.stderr, /receipt/i, `${group}: no receipt may be claimed`)

    // A plan and an execute are mutually exclusive.
    const both = cli(['--manifest', PLAN_FILES[group], '--plan', '--execute'])
    assert.equal(both.status, 2)
    assert.match(both.stderr, /mutually exclusive/)
  }
  assert.deepEqual(receiptFiles(), before, 'a refused execute must not write a receipt')
  assert.equal(existsSync(RECEIPT_DIR), false, 'a refused execute must not create the receipt directory')
})
