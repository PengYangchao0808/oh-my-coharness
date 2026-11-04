/**
 * 0.8 Host Executor regressions.
 *
 * Everything here is synthetic: a fake dispatcher, a fake acceptance runner, a
 * fake git subprocess service and temporary directories. No model call, no
 * network, no paid CLI and no fixture files are touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SESSION_STRATEGIES,
  createStrategyExperiment,
} from '../../integration/strategy-eval.js'
import {
  HOST_EXECUTOR_UNAVAILABLE,
  createHostExecutor,
  createHostRunTrial,
} from '../../integration/host-executor.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { executePlan } from '../../scripts/strategy-runner.mjs'

const CONDITIONS = () => ({
  provider: 'fixture', model: 'fixture-v1', toolsetDigest: 'tools-v1', budgetDigest: 'budget-v1',
  evaluatorVersion: 'external-v1', environmentDigest: 'env-v1', promptDigest: 'prompt-v1', cacheRegime: 'cold',
})

function spec({ arms = ['arm_a', 'arm_b'], tasks = [{ id: 't1', revision: 'tree@1' }], over = {} } = {}) {
  return {
    experimentId: 'host-executor-fixture',
    experimentGroup: 'E1',
    arms,
    tasks,
    repeats: 1,
    seed: 'host-seed',
    dataKind: 'synthetic',
    split: 'development',
    conditions: CONDITIONS(),
    policyVersions: Object.fromEntries(arms.map((arm) => [arm, `${arm}@1`])),
    optimizerCostUsd: Object.fromEntries(arms.map((arm) => [arm, 0])),
    promotion: { candidate: arms[arms.length - 1], reference: arms[0], minTasks: 2 },
    ...over,
  }
}

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `omc-host-${name}-`))
}

function fakeRunner({ passed = true, events = [] } = {}) {
  return {
    events,
    async baseline({ workdir }) {
      events.push(['baseline', workdir])
      return { version: 1, taskId: 't1', fingerprint: 'baseline-fingerprint', acceptanceDigest: 'acceptance-digest', at: '2026-11-03T10:00:00.000Z' }
    },
    async run({ workdir, baseline }) {
      events.push(['run', workdir, baseline?.fingerprint ?? null])
      return {
        version: 1,
        passed,
        fingerprint: 'verdict-fingerprint',
        checks: [{ name: 'fake', passed }],
        reason: passed ? null : 'OMC/ACCEPTANCE-CHECK: fake check failed',
        at: '2026-11-03T10:01:00.000Z',
      }
    },
  }
}

function fakeDispatch({ status = 'completed', actualActions = ['new_child', 'handoff_brief'], interventions = [], model = 'fixture-model', events = [] } = {}) {
  return async (request, _exec, context) => {
    events.push(['dispatch', request.prompt, context?.step?.id ?? null])
    return {
      results: [{
        status,
        harnessId: 'fake-harness',
        actualActions,
        interventions,
        model,
        attempts: [{ harness: 'fake-harness', status }],
      }],
    }
  }
}

function trialInput(manifest, index = 0, { worktreeBase = 'HEAD' } = {}) {
  const dir = tempDir('worktree')
  const assignment = manifest.assignments[index]
  return {
    dir,
    input: {
      trial: {
        ...assignment,
        arm: assignment.strategy,
        taskRevision: manifest.tasks.find((task) => task.id === assignment.taskId)?.revision ?? null,
        policyVersion: manifest.policyVersions[assignment.strategy],
      },
      worktree: { path: dir, branch: 'omc/fake', baseCommit: worktreeBase, repositoryRoot: resolve(dir) },
      budget: { totalUsd: 2, perTrialUsd: 1, remainingUsd: 2, spentUsd: 0, enforcedBy: 'test' },
      manifest,
      plan: { concurrency: 1, deadline: '2026-12-01T00:00:00.000Z' },
    },
  }
}

const resolveAcceptance = ({ task }) => ({
  taskId: task.id,
  split: 'development',
  commands: [{ name: 'fake', run: ['true'], expect: { exitCode: 0 } }],
  acceptanceFiles: [],
  forbidChanges: [],
})

const clock = () => {
  let tick = 0
  return () => new Date(Date.UTC(2026, 10, 3, 10, 0, tick++)).toISOString()
}

test('the acceptance baseline is frozen before dispatch; ledger-unknown calls/cost stay null', async () => {
  const manifest = createStrategyExperiment(spec())
  const { dir, input } = trialInput(manifest)
  try {
    const events = []
    const runner = fakeRunner({ events })
    const host = createHostExecutor({
      dispatch: fakeDispatch({ events }),
      acceptanceRunner: runner,
      usageLedger: createUsageLedger(),
      parentId: 'parent-host',
      buildPrompt: ({ task }) => `Trial ${task.id}`,
      resolveAcceptance,
      now: clock(),
    })
    const outcome = await host.runTrial(null, input)
    // The dispatch happens only after the baseline freeze, and grading only
    // after the dispatch.
    assert.deepEqual(events.map((event) => event[0]), ['baseline', 'dispatch', 'run'])
    assert.equal(events[0][1], dir)
    assert.equal(events[1][1], 'Trial t1')
    assert.equal(outcome.execution, 'completed')
    assert.equal(outcome.acceptance.state, 'passed')
    assert.equal(outcome.acceptance.evidenceKind, 'external-tests')
    assert.match(outcome.acceptance.evidenceRef, /^acceptance-runner:/)
    assert.equal(outcome.calls, null)
    assert.equal(outcome.costUsd, null)
    assert.equal(outcome.costBasis, 'unknown')
    assert.equal(outcome.costVersion, null)
    assert.equal(outcome.unknownCost, true)
    assert.equal(outcome.unknownCalls, true)
    assert.equal(outcome.collectionCoverage, 'unknown')
    for (const bucket of ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
      assert.equal(outcome.usage[bucket], null)
    }
    assert.deepEqual(outcome.actualActions, ['new_child', 'handoff_brief'])
    assert.deepEqual(outcome.interventions, [])
    assert.equal(outcome.group, 'E1')
    assert.equal(outcome.arm, 'arm_a')
    assert.equal(outcome.baseCommit, 'HEAD')
    assert.equal(outcome.model, 'fixture-model')
    assert.equal(outcome.harness, 'fake-harness')
    assert.equal(outcome.surface, 'injected-dispatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the acceptance state comes from the runner verdict, never from dispatch self-report', async () => {
  const manifest = createStrategyExperiment(spec())
  const { dir, input } = trialInput(manifest)
  try {
    const host = createHostExecutor({
      dispatch: fakeDispatch({ status: 'completed', actualActions: ['reuse_session'] }),
      acceptanceRunner: fakeRunner({ passed: false }),
      usageLedger: createUsageLedger(),
      parentId: 'parent-host',
      buildPrompt: ({ task }) => `Trial ${task.id}`,
      resolveAcceptance,
      now: clock(),
    })
    const outcome = await host.runTrial(null, input)
    assert.equal(outcome.execution, 'completed', 'the dispatch really finished')
    assert.equal(outcome.acceptance.state, 'failed', 'but the independent runner said no')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.acceptanceVerdict.passed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed and cancelled executions are never recorded as success and skip grading', async () => {
  const manifest = createStrategyExperiment(spec())
  for (const status of ['failed', 'cancelled', 'timeout']) {
    const { dir, input } = trialInput(manifest)
    try {
      const runner = fakeRunner()
      const host = createHostExecutor({
        dispatch: fakeDispatch({ status }),
        acceptanceRunner: runner,
        usageLedger: createUsageLedger(),
        parentId: 'parent-host',
        buildPrompt: ({ task }) => `Trial ${task.id}`,
        resolveAcceptance,
        now: clock(),
      })
      const outcome = await host.runTrial(null, input)
      assert.equal(outcome.execution, status)
      assert.equal(outcome.acceptance.state, 'failed')
      assert.equal(outcome.acceptance.evidenceKind, 'runtime-terminal')
      assert.equal(outcome.ok, false)
      assert.equal(runner.events.filter((event) => event[0] === 'run').length, 0, 'a non-completed run is not graded as delivered')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a missing host context fails explicitly instead of fabricating a trial', async () => {
  const host = createHostExecutor({ usageLedger: createUsageLedger() })
  await assert.rejects(
    host.runTrial(null, {}),
    (error) => error.code === HOST_EXECUTOR_UNAVAILABLE && /fabricat/i.test(error.message),
  )
  assert.equal(typeof createHostRunTrial({ dispatch: fakeDispatch() }), 'function')
})

test('a frozen baseCommit that the worktree does not sit on is refused', async () => {
  const base = 'a'.repeat(40)
  const manifest = createStrategyExperiment(spec({
    tasks: [{ id: 't1', revision: 'tree@1', repo: 'C:/external/repo', baseCommit: base }],
  }))
  const { dir, input } = trialInput(manifest)
  try {
    const host = createHostExecutor({
      dispatch: fakeDispatch(),
      acceptanceRunner: fakeRunner(),
      usageLedger: createUsageLedger(),
      parentId: 'parent-host',
      resolveAcceptance,
      now: clock(),
    })
    await assert.rejects(host.runTrial(null, input), (error) => error.code === 'OMC/HOST-EXECUTOR-BASE')
    const missing = trialInput(manifest)
    try {
      await assert.rejects(host.runTrial(null, { ...missing.input, worktree: { ...missing.input.worktree, baseCommit: null } }),
        (error) => error.code === 'OMC/HOST-EXECUTOR-BASE')
    } finally {
      rmSync(missing.dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an E2 chain runs its steps strictly in the frozen order before one verdict', async () => {
  const manifest = createStrategyExperiment({
    ...spec({
      arms: [...SESSION_STRATEGIES],
      tasks: [{ id: 'chain-task', revision: 'tree@1', kind: 'chain', chain: ['step-1', 'step-2', 'step-3'] }],
      over: { experimentGroup: 'E2' },
    }),
  })
  const { dir, input } = trialInput(manifest)
  try {
    const order = []
    const runner = fakeRunner()
    const host = createHostExecutor({
      dispatch: async (_request, _exec, context) => {
        order.push(context.step.id)
        return { results: [{ status: 'completed', harnessId: 'fake-harness', actualActions: [context.step.id], attempts: [{}] }] }
      },
      acceptanceRunner: runner,
      usageLedger: createUsageLedger(),
      parentId: 'parent-host',
      buildPrompt: ({ task, stepId }) => `${task.id}/${stepId}`,
      resolveAcceptance,
      now: clock(),
    })
    const outcome = await host.runTrial(null, input)
    assert.deepEqual(order, ['step-1', 'step-2', 'step-3'])
    assert.deepEqual(outcome.chainSteps.map((row) => row.stepId), ['step-1', 'step-2', 'step-3'])
    assert.equal(outcome.execution, 'completed')
    assert.equal(outcome.acceptance.state, 'passed')
    assert.equal(runner.events.filter((event) => event[0] === 'baseline').length, 1, 'one baseline for the whole chain')
    assert.equal(runner.events.filter((event) => event[0] === 'run').length, 1, 'one verdict for the whole chain')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── runner integration: frozen per-task refs and receipt provenance ───────────

function fakeGitCtx({ revParse = null } = {}) {
  const specs = []
  return {
    specs,
    subprocess: {
      async resolveExecutable() { return 'git' },
      spawn(spec) {
        specs.push(spec)
        const argv = spec.argv.map(String)
        let stdout = ''
        if (argv.includes('--show-toplevel')) stdout = `${process.cwd()}\n`
        else if (argv.includes('--verify') && revParse !== null) stdout = `${revParse}\n`
        const read = (value) => ({ readFrom: () => ({ text: value, lossy: false }) })
        return {
          collected: { stdout: read(stdout), stderr: read('') },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
        }
      },
    },
  }
}

function runnerSpec({ baseCommit } = {}) {
  const arms = [...SESSION_STRATEGIES]
  return {
    ...spec({ arms, tasks: [{ id: 't1', revision: 'tree@1', ...(baseCommit ? { baseCommit } : {}) }] }),
    experimentGroup: undefined,
    arms: undefined,
  }
}

const bundleFor = (manifestSpec) => ({
  spec: manifestSpec,
  budget: { totalUsd: 4, perTrialUsd: 1 },
  concurrency: 1,
  deadline: '2026-12-01T00:00:00.000Z',
})

test('the runner refuses a per-task baseCommit that resolves to another commit (no HEAD fallback)', async () => {
  const base = 'c'.repeat(40)
  const dir = tempDir('runner-base')
  try {
    let called = 0
    const result = await executePlan({
      ctx: fakeGitCtx({ revParse: 'd'.repeat(40) }),
      document: bundleFor(runnerSpec({ baseCommit: base })),
      maxUsd: 4,
      receiptDir: join(dir, 'receipts'),
      now: () => '2026-11-03T10:00:00.000Z',
      runTrial: async () => {
        called += 1
        return { execution: 'completed', acceptance: { state: 'passed' }, costUsd: 1 }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'OMC/WORKTREE-BASECOMMIT')
    assert.equal(called, 0, 'no trial runs after a frozen ref fails validation')
    assert.match(result.problems.join('\n'), /refusing to substitute/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the runner passes the frozen baseCommit through and records the required receipt fields', async () => {
  const base = 'c'.repeat(40)
  const dir = tempDir('runner-receipt')
  try {
    const calls = []
    const result = await executePlan({
      ctx: fakeGitCtx({ revParse: base }),
      document: bundleFor(runnerSpec({ baseCommit: base })),
      maxUsd: 4,
      receiptDir: join(dir, 'receipts'),
      now: () => '2026-11-03T10:00:00.000Z',
      runTrial: async (_ctx, call) => {
        calls.push(call)
        return {
          execution: 'completed',
          acceptance: { state: 'passed', evidenceKind: 'external-tests', evidenceRef: 'evidence/t1' },
          costUsd: null,
          calls: null,
          costBasis: 'unknown',
          costVersion: null,
          collectionCoverage: 'unknown',
          model: 'fixture-v1',
          harness: 'fake-harness',
          actualActions: ['reuse_session'],
        }
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result.problems ?? result.aborted))
    assert.equal(calls.length, 3)
    for (const call of calls) {
      assert.equal(call.worktree.baseCommit, base)
      assert.equal(call.trial.arm, call.trial.strategy)
      assert.equal(call.trial.policyVersion, result.plan.manifest.policyVersions[call.trial.strategy])
    }
    const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'))
    assert.equal(receipt.experimentGroup, null)
    assert.deepEqual(receipt.arms, [...SESSION_STRATEGIES])
    assert.equal(receipt.unknownCost, true)
    const row = receipt.trials[0]
    for (const key of ['group', 'arm', 'taskId', 'baseCommit', 'branch', 'policyVersion', 'model', 'harness',
      'calls', 'costBasis', 'costVersion', 'collectionCoverage', 'unknownCost']) {
      assert.equal(key in row, true, `receipt trial carries ${key}`)
    }
    assert.equal(row.baseCommit, base)
    assert.equal(row.calls, null)
    assert.equal(row.costBasis, 'unknown')
    assert.equal(row.unknownCost, true)
    assert.deepEqual(row.actualActions, ['reuse_session'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the runner executes each E2 prerequisite once per arm without counting it as a trial', async () => {
  const dir = tempDir('runner-prereq')
  try {
    const calls = []
    const manifestSpec = {
      ...spec({
        arms: [...SESSION_STRATEGIES],
        tasks: [
          { id: 'chain-a', revision: 'tree@a', kind: 'chain', chain: ['a1', 'a2'] },
          { id: 'chain-b', revision: 'tree@b', kind: 'chain', chain: ['b1', 'b2'] },
        ],
        over: { experimentGroup: 'E2' },
      }),
      prerequisite: { id: 'shared-prerequisite', revision: 'prereq@1', provenance: 'fixture' },
    }
    const result = await executePlan({
      ctx: fakeGitCtx(),
      document: bundleFor(manifestSpec),
      maxUsd: 8,
      receiptDir: join(dir, 'receipts'),
      now: () => '2026-11-03T10:00:00.000Z',
      runTrial: async (_ctx, call) => {
        calls.push(call)
        return {
          execution: 'completed',
          acceptance: { state: 'passed', evidenceKind: 'external-tests', evidenceRef: 'evidence/x' },
          costUsd: 0.25,
          calls: 2,
          costBasis: 'estimated',
          costVersion: 'prices-v1',
          collectionCoverage: 'complete',
        }
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result.problems ?? result.aborted))
    const prerequisiteCalls = calls.filter((call) => call.trial.prerequisite === true)
    const trialCalls = calls.filter((call) => call.trial.prerequisite !== true)
    assert.equal(trialCalls.length, 6)
    assert.equal(prerequisiteCalls.length, 3)
    assert.deepEqual(prerequisiteCalls.map((call) => call.trial.arm).sort(), [...SESSION_STRATEGIES].sort())
    assert.equal(result.results.length, 6)
    assert.equal(result.prerequisites.length, 3)
    assert.equal(result.spentUsd, 9 * 0.25)
    const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'))
    assert.equal(receipt.trials.length, 6)
    assert.equal(receipt.prerequisites.length, 3)
    assert.equal(receipt.prerequisite.id, 'shared-prerequisite')
    assert.equal(receipt.trials.every((row) => row.countedAsTrial !== false), true)
    assert.equal(receipt.prerequisites.every((row) => row.countedAsTrial === false), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
