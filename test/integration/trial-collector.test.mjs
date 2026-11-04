/**
 * R06 trial collector + isolated runner tests.
 *
 * Everything here is synthetic and local: no model call, no network, no paid
 * dispatch, no session-file read. Spawned runner processes are arg-parsed only
 * in --plan/refusal paths, and the one executePlan test uses a fake subprocess
 * service that never touches a real repository.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SESSION_STRATEGIES,
  createStrategyExperiment,
  evaluateStrategyExperiment,
} from '../../integration/strategy-eval.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import {
  TRIAL_COLLECTOR_VERSION,
  assertNotObservational,
  collectTrial,
  exportTrials,
} from '../../integration/trial-collector.js'
import {
  RECEIPT_DIR,
  executePlan,
} from '../../scripts/strategy-runner.mjs'

const PARENT = 'parent-r06'
const START = '2026-11-03T10:00:00.000Z'
const END = '2026-11-03T10:03:00.000Z'
const PRICE = 'fixture-prices-v1'
const RUNNER = resolve('scripts/strategy-runner.mjs')
const ACTIONS = {
  reuse_compact: ['reuse_parent', 'compact_context'],
  fresh_handoff: ['new_child', 'handoff_brief'],
  adaptive: ['rule_decision', 'new_child'],
}

function spec(over = {}) {
  return {
    experimentId: 'r06-collector',
    tasks: [{ id: 'alpha', revision: 'tree@a' }, { id: 'beta', revision: 'tree@b' }],
    repeats: 1,
    seed: 'r06-seed',
    dataKind: 'synthetic',
    split: 'holdout',
    conditions: {
      provider: 'fixture', model: 'fixture-v1', toolsetDigest: 'tools-v1', budgetDigest: 'budget-v1',
      evaluatorVersion: 'external-v1', environmentDigest: 'env-v1', promptDigest: 'prompt-v1', cacheRegime: 'cold',
    },
    policyVersions: { reuse_compact: 'reuse@1', fresh_handoff: 'fresh@1', adaptive: 'adaptive@1' },
    optimizerCostUsd: { reuse_compact: 0, fresh_handoff: 0, adaptive: 0 },
    ...over,
  }
}

/** Build one synthetic world: execution store + ledger + caller wall time. */
function fixtureFor(assignment, options = {}) {
  const {
    status = 'completed',
    cacheWriteTokens = 0,
    model = 'fixture-v1',
    costUsd = 0.5,
    usage = 'booked',
    acceptance: acceptanceOverride,
  } = options
  const taskId = `task-${assignment.trialId}`
  const ledger = createUsageLedger()
  const execution = createExecutionStore()
  const view = execution.open({ taskId, parentId: PARENT, backend: 'native', route: { provider: 'fixture', model } })
  if (status !== 'unknown') {
    execution.settle(taskId, view.currentAttemptId, { execution: status, stopReason: status, by: 'fixture' })
  }
  if (usage === 'booked') {
    ledger.append({
      parentId: PARENT,
      taskId,
      attemptId: `${taskId}#a1`,
      backend: 'native',
      source: { kind: 'dsh-session', sessionId: 'sess-r06', seq: 1 },
      route: { provider: 'fixture', model, observed: true },
      usage: { uncachedInputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens, outputTokens: 10 },
      cost: Number.isFinite(costUsd) ? { usd: costUsd, source: PRICE } : null,
      coverage: cacheWriteTokens === null ? 'partial' : 'complete',
    })
  }
  const acceptance = acceptanceOverride !== undefined
    ? acceptanceOverride
    : status === 'completed'
      ? { state: 'passed', evidenceKind: 'external-tests', evidenceRef: `evidence/${assignment.trialId}` }
      : null
  return { taskId, ledger, execution, startedAt: START, endedAt: END, acceptance }
}

function collectOne(manifest, assignment, options = {}) {
  const fixture = fixtureFor(assignment, options)
  return {
    fixture,
    ...collectTrial({
      parentId: PARENT,
      taskId: fixture.taskId,
      assignment,
      strategy: assignment.strategy,
      usageLedger: fixture.ledger,
      executionStore: fixture.execution,
      startedAt: fixture.startedAt,
      endedAt: fixture.endedAt,
      interventions: options.interventions ?? [],
      acceptance: fixture.acceptance,
      actualActions: options.actualActions ?? ACTIONS[assignment.strategy],
      manifest,
    }),
  }
}

function collectAll(manifest, optionsByTrial = {}) {
  return manifest.assignments.map((assignment) => collectOne(manifest, assignment, optionsByTrial[assignment.trialId]).trial)
}

/** An E2 manifest: session-reuse chains plus one shared prerequisite task. */
function e2Spec(over = {}) {
  return spec({
    experimentGroup: 'E2',
    tasks: [
      { id: 'e2-chain-a', revision: 'tree@e2a', kind: 'chain', chain: ['a1', 'a2'] },
      { id: 'e2-chain-b', revision: 'tree@e2b', kind: 'chain', chain: ['b1', 'b2'] },
    ],
    prerequisite: { id: 'e2-shared-prereq', revision: 'prereq@1' },
    ...over,
  })
}

/** What the runner writes under receipt.prerequisites: one run per arm. */
function prerequisiteRows(manifest, overridesByArm = {}) {
  return (manifest.prerequisiteTrials ?? []).map((row) => ({
    trialId: row.trialId,
    taskId: manifest.prerequisite.id,
    repeat: null,
    arm: row.strategy,
    strategy: row.strategy,
    role: 'prerequisite',
    countedAsTrial: false,
    policyVersion: manifest.policyVersions[row.strategy],
    taskRevision: manifest.prerequisite.revision,
    model: 'fixture-v1',
    execution: 'completed',
    acceptance: 'passed',
    evidenceKind: 'external-tests',
    evidenceRef: `evidence/prerequisite-${row.strategy}`,
    calls: 2,
    costUsd: 0.5,
    costBasis: 'estimated',
    costVersion: PRICE,
    usage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
    startedAt: START,
    endedAt: END,
    ...(overridesByArm[row.strategy] ?? {}),
  }))
}

/** Collect every E2 trial with the same receipt-style prerequisite rows. */
function collectE2(manifest, prerequisites, options = {}) {
  return manifest.assignments.map((assignment) => {
    const fixture = fixtureFor(assignment, options)
    return collectTrial({
      parentId: PARENT,
      taskId: fixture.taskId,
      assignment,
      strategy: assignment.strategy,
      usageLedger: fixture.ledger,
      executionStore: fixture.execution,
      startedAt: fixture.startedAt,
      endedAt: fixture.endedAt,
      interventions: options.interventions ?? [],
      acceptance: fixture.acceptance,
      actualActions: options.actualActions ?? ACTIONS[assignment.strategy],
      manifest,
      prerequisites,
    }).trial
  })
}

function fakeCtx() {
  return {
    subprocess: {
      resolveExecutable: async () => 'git',
      spawn: ({ argv }) => {
        const stdout = argv.includes('--show-toplevel') ? '/fake/repository\n' : ''
        return {
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
        }
      },
    },
  }
}

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `omc-r06-${name}-`))
}

function writeBundle(document) {
  const dir = tempDir('bundle')
  const file = join(dir, 'bundle.json')
  writeFileSync(file, JSON.stringify(document), 'utf8')
  return { dir, file }
}

/**
 * Spawn the real CLI with node. Stdio goes to files rather than pipes: this
 * environment cannot open named pipes for child processes, and redirecting to
 * regular files still proves what the CLI printed and exited with.
 */
function runCli(args) {
  const dir = tempDir('cli')
  const stdoutFile = join(dir, 'stdout.txt')
  const stderrFile = join(dir, 'stderr.txt')
  const stdoutFd = openSync(stdoutFile, 'w')
  const stderrFd = openSync(stderrFile, 'w')
  let spawned
  try {
    spawned = spawnSync(process.execPath, [RUNNER, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', stdoutFd, stderrFd],
    })
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  return {
    status: spawned.status,
    signal: spawned.signal,
    error: spawned.error ?? null,
    stdout: readFileSync(stdoutFile, 'utf8'),
    stderr: readFileSync(stderrFile, 'utf8'),
  }
}

const bundle = () => ({
  spec: spec(),
  budget: { totalUsd: 4, perTrialUsd: 1 },
  concurrency: 1,
  deadline: '2026-12-01T00:00:00.000Z',
})

test('six synthetic trials collect into records the existing evaluator accepts', () => {
  assert.equal(TRIAL_COLLECTOR_VERSION, 1)
  const manifest = createStrategyExperiment(spec())
  assert.equal(manifest.assignments.length, 6)
  const trials = collectAll(manifest)
  assert.equal(trials.length, 6)

  for (const trial of trials) {
    assert.deepEqual(trial.incomplete, [], `unexpected gaps: ${trial.incomplete.join(', ')}`)
    assert.equal(trial.status, 'completed')
    assert.equal(trial.execution, 'completed')
    assert.equal(trial.acceptance, 'passed')
    assert.equal(trial.strategyApplied, true)
    assert.equal(trial.strategyMismatch, false)
    assert.equal(trial.collectionCoverage, 'complete')
    assert.equal(trial.elapsedMs, 180_000)
    assert.equal(trial.calls, 1)
    assert.equal(trial.attempts, 1)
    assert.equal(trial.humanInterventions, 0)
    assert.equal(trial.costUsd, 0.5)
    assert.equal(trial.costBasis, 'estimated')
    assert.equal(trial.costVersion, PRICE)
    assert.deepEqual(Object.keys(trial.usage),
      ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])
    assert.equal(trial.model, 'fixture-v1')
    assert.equal(trial.experimentDigest, manifest.digest)
    assert.equal(trial.policyVersion, manifest.policyVersions[trial.strategy])
    // A manifest with no shared prerequisite keeps exactly the old record shape.
    assert.equal('prerequisite' in trial, false)
  }

  const exported = exportTrials({ manifest, collected: trials })
  assert.deepEqual(exported.problems, [])
  assert.equal(exported.complete, true)
  assert.equal(exported.trials.length, 6)

  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  for (const strategy of SESSION_STRATEGIES) {
    assert.equal(report.summaries[strategy].assignedTrials, 2)
    assert.equal(report.summaries[strategy].recordedTrials, 2)
    assert.equal(report.summaries[strategy].missingTrials, 0)
    assert.equal(report.summaries[strategy].successRate, 1)
    assert.equal(report.summaries[strategy].totalCostUsd, 1)
    assert.equal(report.summaries[strategy].usage.outputTokens.total, 20)
  }
  assert.equal(report.review.automaticActivation, false)
  // Synthetic data can never promote; the framework recovered, not a winner.
  assert.equal(report.review.status, 'blocked')
  assert(report.review.reasons.some((reason) => reason.includes('non-live')))
})

test('a deleted trial is a missing-allocation problem and blocks promotion', () => {
  const manifest = createStrategyExperiment(spec())
  const trials = collectAll(manifest)
  const removed = trials[1]
  const exported = exportTrials({ manifest, collected: trials.filter((trial) => trial !== removed) })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('missing trial') && problem.includes(removed.trialId)))
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  assert.equal(report.review.status, 'blocked')
  assert(report.review.reasons.some((reason) => reason.includes('missing')))
})

test('a duplicated trial is refused by the exporter and by the evaluator', () => {
  const manifest = createStrategyExperiment(spec())
  const trials = collectAll(manifest)
  const duplicated = [...trials, trials[2]]
  const exported = exportTrials({ manifest, collected: duplicated })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('duplicated')))
  assert.throws(
    () => evaluateStrategyExperiment(manifest, duplicated, { bootstrapIterations: 200 }),
    /duplicate/,
  )
})

test('a trial that ran on a different model is a problem, not a silent extra arm', () => {
  const manifest = createStrategyExperiment(spec())
  const target = manifest.assignments[0]
  const trials = collectAll(manifest, { [target.trialId]: { model: 'other-model-v2' } })
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('other-model-v2')))
  assert.equal(trials.find((trial) => trial.trialId === target.trialId).model, 'other-model-v2')
})

test('missing usage stays null, is named incomplete, and never becomes 0', () => {
  const manifest = createStrategyExperiment(spec())
  const target = manifest.assignments[0]
  const trials = collectAll(manifest, { [target.trialId]: { cacheWriteTokens: null } })
  const trial = trials.find((row) => row.trialId === target.trialId)
  assert.equal(trial.usage.cacheWriteTokens, null)
  assert.notEqual(trial.usage.cacheWriteTokens, 0)
  assert.equal(trial.usage.cacheReadTokens, 1000)
  assert.equal(trial.incomplete.includes('usage.cacheWriteTokens'), true)
  assert.equal(trial.collectionCoverage, 'partial')
  const report = evaluateStrategyExperiment(manifest, trials, { bootstrapIterations: 200 })
  assert.equal(report.summaries[target.strategy].usage.cacheWriteTokens.total, null)

  // No booking at all: every bucket is unknown, not a zero.
  const blindSet = collectAll(manifest, { [target.trialId]: { usage: 'none' } })
  const blind = blindSet.find((row) => row.trialId === target.trialId)
  for (const key of ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    assert.equal(blind.usage[key], null)
    assert.equal(blind.incomplete.includes(`usage.${key}`), true)
  }
  assert.equal(blind.calls, 0)
  assert.equal(blind.incomplete.includes('calls'), true)
  assert.equal(blind.costUsd, null)
  assert.equal(blind.costBasis, 'unknown')
  assert.equal(blind.collectionCoverage, 'unknown')
})

test('cancelled and unobserved executions are never counted as success', () => {
  const manifest = createStrategyExperiment(spec())
  const [first, second] = manifest.assignments
  const trials = collectAll(manifest, {
    [first.trialId]: { status: 'cancelled' },
    [second.trialId]: { status: 'unknown' },
  })
  const cancelled = trials.find((row) => row.trialId === first.trialId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.execution, 'cancelled')
  assert.equal(cancelled.acceptance, 'failed')
  assert.equal(cancelled.evidenceKind, 'runtime-terminal')

  const unknown = trials.find((row) => row.trialId === second.trialId)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.execution, 'pending')
  assert.equal(unknown.acceptance, 'unknown')
  assert.equal(unknown.elapsedMs, null)
  assert.equal(unknown.collectionCoverage === 'complete', false)
  assert.equal(unknown.incomplete.includes('status'), true)

  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, true, exported.problems.join('\n'))
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  assert.equal(report.summaries[first.strategy].outcomeCounts.cancelled, 1)
  assert.equal(report.summaries[second.strategy].pendingTrials, 1)
  assert.equal(report.summaries[second.strategy].passedTrials, 1) // only the sibling passed
  assert.equal(report.review.status, 'blocked')
})

test('actions that contradict the assigned strategy set strategyMismatch and block promotion', () => {
  const manifest = createStrategyExperiment(spec())
  const target = manifest.assignments.find((assignment) => assignment.strategy === 'reuse_compact')
  const trials = collectAll(manifest, {
    [target.trialId]: { actualActions: ['new_child', 'handoff_brief'] },
  })
  const trial = trials.find((row) => row.trialId === target.trialId)
  assert.equal(trial.strategyMismatch, true)
  assert.equal(trial.strategyApplied, false)
  assert(trial.notes.some((note) => note.includes('contradict')))
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, true, exported.problems.join('\n'))
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  assert.equal(report.review.status, 'blocked')
  assert(report.review.reasons.some((reason) => reason.includes('not applied')))
})

test('an E2 shared prerequisite is attributed to its arm once and is not folded into trial cost', () => {
  const manifest = createStrategyExperiment(e2Spec())
  assert.equal(manifest.assignments.length, 6)
  assert.equal(manifest.prerequisiteTrials.length, 3)
  const rows = prerequisiteRows(manifest)
  const trials = collectE2(manifest, rows)
  assert.equal(trials.length, 6, 'the prerequisite never becomes an extra trial')

  // The prerequisite is its own arm-level execution: it does not change the
  // trial's own cost/calls, and it never becomes a trialId of its own.
  for (const trial of trials) {
    assert.equal(trial.costUsd, 0.5)
    assert.equal(trial.calls, 1)
    assert.equal(trial.incomplete.includes('prerequisite'), false, trial.incomplete.join(', '))
    assert.notEqual(trial.trialId, rows.find((row) => row.arm === trial.strategy).trialId)
  }

  // Exactly one carrier per arm, and it is the arm's first frozen assignment.
  const carriers = trials.filter((trial) => trial.prerequisite)
  assert.equal(carriers.length, 3)
  assert.equal(new Set(carriers.map((trial) => trial.strategy)).size, 3)
  for (const carrier of carriers) {
    const first = manifest.assignments.find((assignment) => assignment.strategy === carrier.strategy)
    assert.equal(carrier.trialId, first.trialId)
    assert.equal(carrier.prerequisite.execution, 'completed')
    assert.equal(carrier.prerequisite.costUsd, 0.5)
    assert.equal(carrier.prerequisite.calls, 2)
    assert.equal(carrier.prerequisite.costBasis, 'estimated')
    assert.equal(carrier.prerequisite.costVersion, PRICE)
    assert.equal(carrier.prerequisite.arm, carrier.strategy)
    assert.equal(carrier.prerequisite.taskId, 'e2-shared-prereq')
    assert.deepEqual(Object.keys(carrier.prerequisite.usage),
      ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])
  }
  const nonCarriers = trials.filter((trial) => !trial.prerequisite)
  for (const trial of nonCarriers) {
    assert.equal(trial.prerequisite, null)
    assert(trial.notes.some((note) => note.includes('single execution')), trial.notes.join('\n'))
  }

  const exported = exportTrials({ manifest, collected: trials })
  assert.deepEqual(exported.problems, [])
  assert.equal(exported.complete, true)

  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  // The blocker was unknown E2 cost: it is now a settled arm total.
  assert.equal(report.unknownCost.any, false)
  assert.equal(report.unknownCost.prerequisite, false)
  assert.equal(report.prerequisite.recorded, 3)
  assert.equal(report.prerequisite.costUsd, 1.5)
  for (const arm of SESSION_STRATEGIES) {
    assert.equal(report.summaries[arm].prerequisite.recorded, 1)
    assert.equal(report.summaries[arm].prerequisite.costUsd, 0.5)
    assert.equal(report.summaries[arm].prerequisite.calls, 2)
    // 2 trials x 0.5 operating + one shared 0.5 prerequisite + 0 optimizer.
    assert.equal(report.summaries[arm].totalCostUsd, 1.5)
    assert.equal(report.summaries[arm].calls, 4)
  }
  assert.equal(report.review.reasons.some((reason) => reason.includes('unknown')), false)
  // The evaluator prices the arm-level carrier once, so both E2 arms have an
  // identical known cost (2 x 0.5 operating + one 0.5 prerequisite + 0
  // optimizer): the cost-reduction interval is computable and exactly 0.
  const primary = report.comparisons.find((row) => row.candidate === 'adaptive')
  assert.equal(primary.costPerAcceptedReduction.estimate, 0)
  assert.equal(primary.costPerAcceptedReduction.low, 0)
  assert.equal(primary.costPerAcceptedReduction.high, 0)
  assert.equal(primary.costPerAcceptedReduction.finiteReplicates, 200)
})

test('a second task in the same arm does not carry or re-price the shared prerequisite', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const rows = prerequisiteRows(manifest)
  // Simulate a caller that passes the same receipt to every trial. A second
  // trial of an arm must not attach the record again.
  const trials = collectE2(manifest, rows)
  for (const arm of SESSION_STRATEGIES) {
    const armTrials = trials.filter((trial) => trial.strategy === arm)
    assert.equal(armTrials.length, 2)
    assert.equal(armTrials.filter((trial) => trial.prerequisite).length, 1)
    const total = armTrials.reduce((sum, trial) => sum + trial.costUsd + (trial.prerequisite?.costUsd ?? 0), 0)
    assert.equal(total, 1.5)
  }
  // Handing the same rows to a second collect pass is still deterministic.
  const again = collectE2(manifest, rows)
  assert.deepEqual(
    again.map((trial) => [trial.trialId, trial.prerequisite?.costUsd ?? null]),
    trials.map((trial) => [trial.trialId, trial.prerequisite?.costUsd ?? null]),
  )
})

test('a single prerequisite block and a whole receipt are both accepted', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const rows = prerequisiteRows(manifest)
  const collectWith = (extra) => manifest.assignments.map((assignment) => {
    const fixture = fixtureFor(assignment)
    return collectTrial({
      parentId: PARENT,
      taskId: fixture.taskId,
      assignment,
      strategy: assignment.strategy,
      usageLedger: fixture.ledger,
      executionStore: fixture.execution,
      startedAt: fixture.startedAt,
      endedAt: fixture.endedAt,
      acceptance: fixture.acceptance,
      actualActions: ACTIONS[assignment.strategy],
      manifest,
      ...extra(assignment),
    }).trial
  })
  const viaBlock = collectWith((assignment) => ({
    prerequisite: rows.find((row) => row.arm === assignment.strategy),
  }))
  const viaReceipt = collectWith(() => ({ receipt: { prerequisites: rows } }))
  // A caller that only hands the run to the arm's carrier trial still works:
  // the other trials neither repeat nor lose the record.
  const viaCarrierOnly = collectWith((assignment) => {
    const first = manifest.assignments.find((row) => row.strategy === assignment.strategy)
    return first.trialId === assignment.trialId
      ? { prerequisite: rows.find((row) => row.arm === assignment.strategy) }
      : {}
  })
  for (const trials of [viaBlock, viaReceipt, viaCarrierOnly]) {
    const carriers = trials.filter((trial) => trial.prerequisite)
    assert.equal(carriers.length, 3)
    assert.equal(carriers.reduce((sum, trial) => sum + trial.prerequisite.costUsd, 0), 1.5)
    assert.deepEqual(exportTrials({ manifest, collected: trials }).problems, [])
  }
})


test('unknown prerequisite cost/calls stay null and make the arm total incomplete, never 0', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const rows = prerequisiteRows(manifest, {
    fresh_handoff: { costUsd: null, costBasis: 'unknown', calls: null },
  })
  const trials = collectE2(manifest, rows)
  const carrier = trials.find((trial) => trial.strategy === 'fresh_handoff' && trial.prerequisite)
  assert(carrier)
  assert.equal(carrier.prerequisite.costUsd, null)
  assert.notEqual(carrier.prerequisite.costUsd, 0)
  assert.equal(carrier.prerequisite.costBasis, 'unknown')
  assert.equal(carrier.prerequisite.calls, null)
  assert.notEqual(carrier.prerequisite.calls, 0)
  assert.equal(carrier.incomplete.includes('prerequisite.costUsd'), true)
  assert.equal(carrier.incomplete.includes('prerequisite.calls'), true)

  const exported = exportTrials({ manifest, collected: trials })
  assert.deepEqual(exported.problems, [])
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  assert.equal(report.unknownCost.prerequisite, true)
  assert.equal(report.unknownCost.any, true)
  assert.equal(report.summaries.fresh_handoff.prerequisite.costUsd, null)
  assert.equal(report.summaries.fresh_handoff.prerequisite.calls, null)
  assert.equal(report.summaries.fresh_handoff.totalCostUsd, null)
  assert.equal(report.summaries.fresh_handoff.costPerAcceptedTaskUsd, null)
  assert(report.review.reasons.some((reason) => reason.includes('unknown trial/optimizer/prerequisite cost')))
})

test('a missing shared prerequisite is an explicit problem, not a silent success', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const trials = collectE2(manifest, [])
  const carriers = trials.filter((trial) => {
    const first = manifest.assignments.find((assignment) => assignment.strategy === trial.strategy)
    return first.trialId === trial.trialId
  })
  assert.equal(carriers.length, 3)
  for (const trial of carriers) {
    assert.equal(trial.prerequisite, null)
    assert(trial.incomplete.includes('prerequisite'), trial.incomplete.join(', '))
  }
  for (const trial of trials.filter((row) => !carriers.includes(row))) {
    // The non-carrier trial neither claims nor repeats the missing record.
    assert.equal(trial.prerequisite, null)
    assert.equal(trial.incomplete.includes('prerequisite'), false)
  }
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('no prerequisite run was collected')))
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  assert.equal(report.unknownCost.prerequisite, true)
  assert.equal(report.review.status, 'blocked')
  assert(report.review.reasons.some((reason) => reason.includes('unknown trial/optimizer/prerequisite cost')))
})

test('a duplicated shared prerequisite run blocks instead of being summed', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const rows = prerequisiteRows(manifest)
  const duplicated = [...rows, rows[0]]
  const trials = collectE2(manifest, duplicated)
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('recorded 2 times')))
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 200 })
  // The duplicated arm has no attributable prerequisite: its total stays null.
  assert.equal(report.summaries.reuse_compact.prerequisite.recorded, 0)
  assert.equal(report.summaries.reuse_compact.totalCostUsd, null)
})

test('a prerequisite recorded for another arm may not be borrowed', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const rows = prerequisiteRows(manifest)
  const onlyFresh = rows.filter((row) => row.arm === 'fresh_handoff')
  const trials = collectE2(manifest, onlyFresh)
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('not for this trial\'s arm')))
  assert(exported.problems.some((problem) => problem.includes('borrowed from another arm')))
})

test('a prerequisite chain executed out of the frozen order blocks attribution', () => {
  const manifest = createStrategyExperiment(e2Spec({
    prerequisite: {
      id: 'e2-shared-prereq',
      revision: 'prereq@1',
      kind: 'chain',
      chain: ['p1', 'p2'],
    },
  }))
  const rows = prerequisiteRows(manifest, {
    reuse_compact: { chainSteps: [{ stepId: 'p2' }, { stepId: 'p1' }] },
  })
  const trials = collectE2(manifest, rows)
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('chain order')))
  // The ordered arm still gets its prerequisite attributed normally.
  const orderedCarrier = trials.find((trial) => trial.strategy === 'adaptive' && trial.prerequisite)
  assert.equal(orderedCarrier.prerequisite.costUsd, 0.5)
})

test('prerequisite policy/revision drift and a non-terminal prerequisite are refused', () => {
  const manifest = createStrategyExperiment(e2Spec())
  const driftedRows = prerequisiteRows(manifest, {
    reuse_compact: { policyVersion: 'reuse@2', taskRevision: 'prereq@2' },
    fresh_handoff: { execution: 'pending', costUsd: 0.5, costBasis: 'estimated' },
    adaptive: { observedModel: 'other-model-v2' },
  })
  const trials = collectE2(manifest, driftedRows)
  const exported = exportTrials({ manifest, collected: trials })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('policyVersion reuse@2')))
  assert(exported.problems.some((problem) => problem.includes('revision prereq@2')))
  assert(exported.problems.some((problem) => problem.includes('not a terminal state')))
  assert(exported.problems.some((problem) => problem.includes('observed model other-model-v2')))
})

test('a manifest without randomisation/freeze metadata is reported observational', () => {
  const frozen = createStrategyExperiment(spec())
  const legacy = {
    schemaVersion: 1,
    experimentId: 'legacy-observations',
    dataKind: 'live',
    split: 'holdout',
    tasks: frozen.tasks,
    repeats: frozen.repeats,
    conditions: frozen.conditions,
    policyVersions: frozen.policyVersions,
    optimizerCostUsd: frozen.optimizerCostUsd,
    assignments: frozen.assignments,
  }
  const guard = assertNotObservational({ manifest: legacy })
  assert.equal(guard.randomised, false)
  assert.equal(guard.observational, true)
  assert.equal(guard.taggedAs, 'observational')
  assert(guard.reasons.some((reason) => reason.includes('seed')))
  assert.equal(assertNotObservational({ manifest: frozen }).randomised, true)

  const exported = exportTrials({ manifest: legacy, collected: [] })
  assert.equal(exported.complete, false)
  assert(exported.problems.some((problem) => problem.includes('observational')))
})

test('--plan prints the frozen allocation and writes nothing', () => {
  const defaultBefore = existsSync(resolve(RECEIPT_DIR)) ? readdirSync(resolve(RECEIPT_DIR)).length : 0
  const { dir, file } = writeBundle(bundle())
  const receiptDir = join(dir, 'receipts')
  const result = runCli(['--manifest', file, '--plan', '--receipt-dir', receiptDir])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.mode, 'plan')
  assert.equal(plan.executesAnything, false)
  assert.equal(plan.trials.length, 6)
  assert.equal(plan.model, 'fixture-v1')
  assert.equal(plan.concurrency, 1)
  assert.equal(plan.deadline, '2026-12-01T00:00:00.000Z')
  assert.equal(plan.budgetCaps.totalUsd, 4)
  assert.equal(plan.budgetCaps.perTrialUsd, 1)
  assert.equal(plan.budgetCaps.effectiveTotalUsd, 4)
  assert.equal(typeof plan.manifest.digest, 'string')
  assert.deepEqual(plan.problems, [])
  for (const trial of plan.trials) {
    assert(SESSION_STRATEGIES.includes(trial.strategy))
    assert.equal(trial.policyVersion, plan.manifest.policyVersions[trial.strategy])
  }
  assert.equal(existsSync(receiptDir), false, '--plan must not create a receipt directory')
  const defaultAfter = existsSync(resolve(RECEIPT_DIR)) ? readdirSync(resolve(RECEIPT_DIR)).length : 0
  assert.equal(defaultAfter, defaultBefore, '--plan must not write receipts')
})

test('--execute without --max-usd and --confirm-paid-experiment refuses with the exact reason', () => {
  const { dir, file } = writeBundle(bundle())
  const receiptDir = join(dir, 'receipts')
  const result = runCli(['--manifest', file, '--execute', '--receipt-dir', receiptDir])
  assert.equal(result.status, 2)
  const output = `${result.stdout}${result.stderr}`
  assert(output.includes('--max-usd'), output)
  assert(output.includes('--confirm-paid-experiment'), output)
  assert.equal(existsSync(receiptDir), false)
})

test('--execute refuses a manifest whose budget caps are missing', () => {
  const { dir, file } = writeBundle({ spec: spec(), concurrency: 1, deadline: '2026-12-01T00:00:00.000Z' })
  const receiptDir = join(dir, 'receipts')
  const result = runCli([
    '--manifest', file, '--execute', '--max-usd', '5',
    '--confirm-paid-experiment', '--receipt-dir', receiptDir,
  ])
  assert.equal(result.status, 2)
  const output = `${result.stdout}${result.stderr}`
  assert(output.includes('budget'), output)
  assert(output.includes('totalUsd'), output)
  assert.equal(existsSync(receiptDir), false)
})

test('executePlan isolates each trial in its own worktree and passes the caps to runTrial', async () => {
  const dir = tempDir('execute')
  const receiptDir = join(dir, 'receipts')
  const calls = []
  const result = await executePlan({
    ctx: fakeCtx(),
    repo: process.cwd(),
    document: bundle(),
    maxUsd: 4,
    receiptDir,
    now: () => '2026-11-03T12:00:00.000Z',
    runTrial: async (_ctx, call) => {
      calls.push(call)
      return {
        execution: 'completed',
        acceptance: { state: 'passed' },
        costUsd: 0.25,
        startedAt: START,
        endedAt: END,
      }
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? result.aborted))
  assert.equal(calls.length, 6)
  assert.equal(new Set(calls.map((call) => call.worktree.path)).size, 6)
  for (const call of calls) {
    assert.equal(call.budget.perTrialUsd, 1)
    assert.equal(call.budget.totalUsd, 4)
    assert(call.budget.remainingUsd >= 1)
    assert(call.worktree.branch.startsWith('omc/'))
    assert.equal(call.trial.policyVersion, result.plan.manifest.policyVersions[call.trial.strategy])
  }
  assert(existsSync(result.receipt))
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'))
  assert.equal(receipt.experimentId, 'r06-collector')
  assert.equal(receipt.budgetCaps.perTrialUsd, 1)
  assert.equal(receipt.trials.length, 6)
  assert(receipt.limitations.some((line) => line.includes('does not prove')))

  // Without a host context the runner reports the missing executor instead of
  // inventing a trial result, and it writes no receipt.
  const bareDir = tempDir('no-ctx')
  const bareReceipts = join(bareDir, 'receipts')
  const bare = await executePlan({ document: bundle(), maxUsd: 4, receiptDir: bareReceipts })
  assert.equal(bare.ok, false)
  assert.equal(bare.code, 'OMC/TRIAL-NO-EXECUTOR')
  assert.equal(existsSync(bareReceipts), false)
})
