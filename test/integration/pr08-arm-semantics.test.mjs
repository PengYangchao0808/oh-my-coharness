/**
 * Core-lane arm execution semantics audit (t1-t10), offline.
 *
 * These tests use the REAL arm resolver, graph planner hooks and Host Executor
 * step loop. Only the provider process and acceptance process are injected:
 * the fake dispatch keeps a real per-role session Map so decision, actual
 * action and session id are observable, and the fake runner is the independent
 * grader that reviewer text must never replace.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStrategyExperiment } from '../../integration/strategy-eval.js'
import { createHostExecutor } from '../../integration/host-executor.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { nativeTrialSessionId } from '../../src/index.js'

const ROLE = (id, writer, provider, model, prompt = null) => ({
  id,
  writer,
  surface: 'native',
  provider,
  model,
  ...(prompt ? { prompt } : {}),
})

function conditions(over = {}) {
  return {
    provider: 'provider-a', model: 'model-a',
    reviewerProvider: 'provider-b', reviewerModel: 'model-b',
    toolsetDigest: 'tools', budgetDigest: 'budget', evaluatorVersion: 'runner@1',
    environmentDigest: 'env', promptDigest: 'prompt', cacheRegime: 'cold',
    harness: 'native',
    ...over,
  }
}

function manifestFor({ group = 'E1', arms, armExecution, task, over = {} } = {}) {
  const tasks = [task ?? { id: 'task-a', revision: 'tree@a', prompt: 'Implement the task.' }]
  return createStrategyExperiment({
    experimentId: `arm-audit-${group.toLowerCase()}`,
    experimentGroup: group,
    repeats: 1,
    seed: 'arm-audit',
    dataKind: 'synthetic',
    split: 'development',
    arms,
    ...(armExecution ? { armExecution } : {}),
    tasks,
    conditions: conditions(),
    policyVersions: Object.fromEntries(arms.map((arm) => [arm, 'policy@1'])),
    optimizerCostUsd: Object.fromEntries(arms.map((arm) => [arm, 0])),
    promotion: { candidate: arms.at(-1), reference: arms[0], minTasks: 2 },
    ...over,
  })
}

function trialFor(manifest, arm) {
  const trial = manifest.assignments.find((row) => row.arm === arm)
  assert.ok(trial, `assignment for arm ${arm}`)
  return trial
}

function fakeRunner({ passed = true, events = [] } = {}) {
  return {
    events,
    async baseline({ workdir }) {
      events.push(['baseline', workdir])
      return { fingerprint: 'baseline', acceptanceDigest: 'acceptance', at: '2026-01-01T00:00:00.000Z' }
    },
    async run({ workdir }) {
      events.push(['run', workdir])
      return { passed, fingerprint: 'verdict', checks: [{ name: 'contract', passed }], problems: passed ? [] : ['contract failed'] }
    },
  }
}

function sessionDispatch({ ledger = null, parentId = 'parent-arm', driftFirst = false, reviewerOutput = 'review complete' } = {}) {
  const handles = new Map()
  const calls = []
  let counter = 0
  return {
    calls,
    async dispatch(request) {
      const index = calls.length
      calls.push(request)
      const key = request.role ?? 'writer'
      const prior = handles.get(key)
      let sessionId
      let actualAction
      if (request.sessionAction === 'resume' && prior) {
        sessionId = prior
        actualAction = 'resume'
      } else {
        counter += 1
        sessionId = `sess-${key}-${counter}`
        handles.set(key, sessionId)
        actualAction = request.sessionAction === 'restart' ? 'restart' : 'new-packet'
      }
      if (ledger) {
        const ledgerTaskId = request.ledgerTaskId ?? request.taskId
        assert.ok(ledgerTaskId, 'the dispatch envelope carries the trial ledger identity')
        ledger.append({
          parentId,
          taskId: ledgerTaskId,
          attemptId: `${ledgerTaskId}#${key}-${index}`,
          backend: 'native',
          source: { kind: 'dsh-session', sessionId, seq: index + 1 },
          route: { provider: request.provider, model: request.model, observed: true },
          usage: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        })
      }
      const observed = `${request.provider}/${request.model}${driftFirst && index === 0 ? '-drifted' : ''}`
      return {
        results: [{
          status: 'completed',
          harnessId: 'native',
          provider: request.provider,
          model: observed,
          sessionId,
          actualAction,
          output: request.writer ? `writer output ${key}` : reviewerOutput,
          changedFiles: request.writer ? ['src/impl.js'] : ['src/reviewer-should-not-write.js'],
          actualActions: [`session:${actualAction}`],
          attempts: [{}],
        }],
      }
    },
  }
}

function trialInput(manifest, trial, dir) {
  return {
    trial,
    worktree: { path: dir, branch: 'arm-branch', baseCommit: 'a'.repeat(40), repositoryRoot: dir },
    budget: { totalUsd: 1, perTrialUsd: 1, spentUsd: 0 },
    manifest,
    plan: { manifest: manifest.digest, assignmentCount: manifest.assignments.length },
  }
}

async function run(manifest, arm, dispatch, runner, { ledger = null, parentId = 'parent-arm' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omc-arm-audit-'))
  try {
    const host = createHostExecutor({
      dispatch: dispatch.dispatch ?? dispatch,
      acceptanceRunner: runner,
      usageLedger: ledger ?? createUsageLedger(),
      parentId,
      resolveAcceptance: () => ({ taskId: 'arm-audit', split: 'development', commands: [], acceptanceFiles: [], forbidChanges: [], rubric: [] }),
      buildPrompt: ({ task, role, prior }) => [
        `role=${role.id}`,
        `writer=${role.writer === true}`,
        `task=${task.prompt ?? task.id}`,
        prior?.output ? `prior=${prior.output}` : '',
      ].filter(Boolean).join('\n'),
      buildRequest: ({ trial, role, stepId }) => ({ ledgerTaskId: trial.trialId, armNode: `${trial.trialId}:${role.id}:${stepId}` }),
    })
    const outcome = await host.runTrial(null, trialInput(manifest, {
      ...trialFor(manifest, arm),
      policyVersion: manifest.policyVersions[arm],
    }, dir))
    return { outcome, dir, dispatch, runner }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
  }
}

test('t1/t2/t3: single, multi-role and different-model arms dispatch real, distinct role envelopes', async () => {
  const arms = ['single', 'multi-role', 'same-model-multi-role', 'different-model-multi-role']
  const armExecution = {
    single: { roles: [ROLE('writer', true, 'provider-a', 'model-a')] },
    'multi-role': { roles: [ROLE('writer', true, 'provider-a', 'model-a'), ROLE('reviewer', false, 'provider-a', 'model-a')] },
    'same-model-multi-role': { roles: [ROLE('writer', true, 'provider-a', 'model-a'), ROLE('reviewer', false, 'provider-a', 'model-a')] },
    'different-model-multi-role': { roles: [ROLE('writer', true, 'provider-a', 'model-a'), ROLE('reviewer', false, 'provider-b', 'model-b')] },
  }
  const manifest = manifestFor({ arms, armExecution })
  const runner = fakeRunner({ passed: true })

  const single = await run(manifest, 'single', sessionDispatch(), runner)
  assert.equal(single.dispatch.calls.length, 1)
  assert.equal(single.dispatch.calls[0].role, 'writer')
  assert.equal(single.dispatch.calls[0].readOnly, false)

  const multi = await run(manifest, 'multi-role', sessionDispatch(), runner)
  assert.equal(multi.dispatch.calls.length, 2)
  assert.deepEqual(multi.dispatch.calls.map((call) => call.role), ['writer', 'reviewer'])
  assert.equal(multi.dispatch.calls[1].readOnly, true)
  assert.equal(multi.dispatch.calls[1].mode, 'read-only')
  assert.notEqual(multi.dispatch.calls[0].prompt, multi.dispatch.calls[1].prompt)
  assert.match(multi.dispatch.calls[1].prompt, /role=reviewer/)
  assert.deepEqual(multi.dispatch.calls.map((call) => `${call.provider}/${call.model}`), ['provider-a/model-a', 'provider-a/model-a'])
  assert.deepEqual(multi.outcome.changedFiles, ['src/impl.js'], 'reviewer changedFiles are never attributed')

  const different = await run(manifest, 'different-model-multi-role', sessionDispatch(), runner)
  assert.deepEqual(different.dispatch.calls.map((call) => `${call.provider}/${call.model}`), ['provider-a/model-a', 'provider-b/model-b'])
  assert.deepEqual(different.outcome.models, ['provider-a/model-a', 'provider-b/model-b'])
})

test('t4/t5/t6/t7: reuse resumes the real session, fresh handoff starts a new one, adaptive follows the real prior', async () => {
  const chainTask = {
    id: 'chain-task', revision: 'tree@chain', kind: 'chain',
    chain: [{ id: 'design', goal: 'Design the change.' }, { id: 'implement', goal: 'Implement it.' }],
  }
  const arms = ['reuse_compact', 'fresh_handoff', 'adaptive']
  const manifest = manifestFor({ group: 'E2', arms, task: chainTask })
  const runner = fakeRunner({ passed: true })

  const reuseDispatch = sessionDispatch()
  const reuse = await run(manifest, 'reuse_compact', reuseDispatch, runner)
  assert.equal(reuse.dispatch.calls.length, 2)
  assert.equal(reuse.dispatch.calls[0].sessionAction, 'new-packet')
  assert.equal(reuse.dispatch.calls[1].sessionAction, 'resume')
  assert.equal(reuse.outcome.sessions[0].sessionId, reuse.outcome.sessions[1].sessionId)
  assert.equal(reuse.outcome.sessions[1].actualAction, 'resume')
  assert.equal(reuse.outcome.sessionDecisions[1].decision, 'resume')

  const freshDispatch = sessionDispatch()
  const fresh = await run(manifest, 'fresh_handoff', freshDispatch, runner)
  assert.equal(fresh.dispatch.calls[1].sessionAction, 'new-packet')
  assert.notEqual(fresh.outcome.sessions[0].sessionId, fresh.outcome.sessions[1].sessionId)
  assert.equal(fresh.outcome.sessions[1].actualAction, 'new-packet')
  assert.ok(fresh.dispatch.calls[1].handoff, 'fresh_handoff passes a real handoff packet')

  const adaptiveDispatch = sessionDispatch()
  const adaptive = await run(manifest, 'adaptive', adaptiveDispatch, runner)
  assert.equal(adaptive.dispatch.calls[1].sessionAction, 'resume', 'adaptive resumes a matching prior')
  assert.equal(adaptive.outcome.sessions[1].actualAction, 'resume')

  const driftDispatch = sessionDispatch({ driftFirst: true })
  const drift = await run(manifest, 'adaptive', driftDispatch, runner)
  assert.equal(drift.dispatch.calls[1].sessionAction, 'restart', 'route drift forces restart, not a fake resume')
  assert.notEqual(drift.outcome.sessions[0].sessionId, drift.outcome.sessions[1].sessionId)
  assert.equal(drift.outcome.sessions[1].actualAction, 'restart')
})

test('t8/t9: reviewer cannot complete acceptance, and two models stay attributed in outcome and ledger', async () => {
  const arms = ['single', 'different-model-multi-role']
  const manifest = manifestFor({
    arms,
    armExecution: {
      single: { roles: [ROLE('writer', true, 'provider-a', 'model-a')] },
      'different-model-multi-role': { roles: [ROLE('writer', true, 'provider-a', 'model-a'), ROLE('reviewer', false, 'provider-b', 'model-b')] },
    },
  })
  const ledger = createUsageLedger()
  const dispatch = sessionDispatch({ ledger, reviewerOutput: 'APPROVED: everything is perfect' })
  const failedRunner = fakeRunner({ passed: false })
  const { outcome } = await run(manifest, 'different-model-multi-role', dispatch, failedRunner, { ledger })
  assert.equal(outcome.execution, 'completed', JSON.stringify({ error: outcome.error, steps: outcome.steps }))
  assert.equal(outcome.acceptance.state, 'failed', 'reviewer text cannot override the independent runner')
  assert.equal(failedRunner.events.filter((event) => event[0] === 'run').length, 1)
  assert.deepEqual(outcome.models, ['provider-a/model-a', 'provider-b/model-b'])
  const routes = [...new Set(ledger.entries({ parentId: 'parent-arm', taskId: outcome.trialId }).map((row) => `${row.route.provider}/${row.route.model}`))]
  assert.deepEqual(routes.sort(), ['provider-a/model-a', 'provider-b/model-b'])
})

test('t10: a reviewer step is read-only and a writer-only graph node gets the write scope', async () => {
  const arms = ['single', 'multi-role']
  const manifest = manifestFor({
    arms,
    armExecution: {
      single: { roles: [ROLE('writer', true, 'provider-a', 'model-a')] },
      'multi-role': { roles: [ROLE('writer', true, 'provider-a', 'model-a'), ROLE('reviewer', false, 'provider-b', 'model-b')] },
    },
  })
  const dispatch = sessionDispatch()
  const { outcome } = await run(manifest, 'multi-role', dispatch, fakeRunner({ passed: true }))
  assert.deepEqual(outcome.steps.map((row) => ({ roleId: row.roleId, writer: row.writer })), [
    { roleId: 'writer', writer: true },
    { roleId: 'reviewer', writer: false },
  ])
  assert.equal(dispatch.calls[1].readOnly, true)
  assert.equal(dispatch.calls[1].mode, 'read-only')
  assert.equal(outcome.changedFiles.length, 1)
  assert.deepEqual(outcome.changedFiles, ['src/impl.js'])
})

test('t11: a non-resume native step never reuses the prior session id', () => {
  const prior = nativeTrialSessionId({ taskId: 'trial-a', roleId: 'writer' })
  assert.notEqual(nativeTrialSessionId({ taskId: 'trial-a', roleId: 'writer', reuse: false, priorSessionId: prior }), prior)
  assert.notEqual(nativeTrialSessionId({ taskId: 'trial-a', roleId: 'writer', reuse: false, priorSessionId: prior }), nativeTrialSessionId({ taskId: 'trial-a', roleId: 'writer' }))
  assert.equal(nativeTrialSessionId({ taskId: 'trial-a', roleId: 'writer', reuse: true, priorSessionId: prior }), prior)
})
