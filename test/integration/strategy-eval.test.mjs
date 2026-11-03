import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STRATEGIES, createStrategyExperiment, evaluateStrategyExperiment } from '../../integration/strategy-eval.js'

function spec(over = {}) {
  return { experimentId: 'session-policy-test', tasks: [{ id: 'one', revision: 'tree@1' }, { id: 'two', revision: 'tree@2' }],
    repeats: 2, seed: 'frozen-seed', dataKind: 'synthetic', split: 'holdout',
    conditions: { provider: 'fixture', model: 'fixture-v1', toolsetDigest: 'tools-v1', budgetDigest: 'budget-v1',
      evaluatorVersion: 'external-v1', environmentDigest: 'env-v1', promptDigest: 'prompt-v1', cacheRegime: 'cold' },
    policyVersions: { reuse_compact: 'reuse@1', fresh_handoff: 'fresh@1', adaptive: 'adaptive@1' },
    optimizerCostUsd: { reuse_compact: 0, fresh_handoff: 0, adaptive: 0 }, ...over }
}
function records(m, transform = r => r) {
  return m.assignments.map(a => transform({ schemaVersion: 1, experimentDigest: m.digest, conditionsDigest: m.conditionsDigest,
    dataKind: m.dataKind, trialId: a.trialId, policyVersion: m.policyVersions[a.strategy], strategyApplied: true,
    execution: 'completed', acceptance: 'passed', evidenceKind: 'external-tests', evidenceRef: `evidence/${a.trialId}`,
    criticalRegression: false, falseCompletion: false, collectionCoverage: 'complete',
    calls: 10, attempts: 1, humanInterventions: 0, elapsedMs: 100,
    costUsd: a.strategy === 'adaptive' ? 1 : 2, costBasis: 'estimated', costVersion: 'fixed-prices-v1',
    usage: { uncachedInputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10 },
  }, a))
}
const evaluate = (m, r) => evaluateStrategyExperiment(m, r, { bootstrapIterations: 200 })

test('seeded allocation has exactly one strategy per task/repeat and is reproducible', () => {
  const m = createStrategyExperiment(spec())
  assert.deepEqual(m, createStrategyExperiment(spec()))
  assert.equal(m.assignments.length, 12)
  for (const t of m.tasks) for (let i = 0; i < m.repeats; i++) {
    assert.deepEqual(m.assignments.filter(a => a.taskId === t.id && a.repeat === i).map(a => a.strategy).sort(), [...SESSION_STRATEGIES].sort())
  }
  assert.notEqual(m.digest, createStrategyExperiment(spec({ seed: 'other' })).digest)
})

test('manifest changes, duplicate runs, unmatched runs and condition drift are rejected', () => {
  const m = createStrategyExperiment(spec()), rs = records(m)
  const changed = structuredClone(m); changed.conditions.model = 'other'
  assert.throws(() => evaluate(changed, rs), /digest/)
  assert.throws(() => evaluate(m, [...rs, rs[0]]), /duplicate/)
  assert.throws(() => evaluate(m, [{ ...rs[0], trialId: 'not-assigned' }]), /unassigned/)
  assert.throws(() => evaluate(m, [{ ...rs[0], conditionsDigest: 'drift' }]), /mismatched/)
  assert.throws(() => evaluate(m, [{ ...rs[0], policyVersion: 'mutated' }]), /policy/)
})

test('failures stay in success denominator and all costs; zero accepted cost is undefined', () => {
  const m = createStrategyExperiment(spec())
  const rs = records(m, (r, a) => a.strategy === 'reuse_compact' ? { ...r, execution: 'timeout', acceptance: 'failed' } : r)
  const result = evaluate(m, rs)
  assert.equal(result.summaries.reuse_compact.assignedTrials, 4)
  assert.equal(result.summaries.reuse_compact.successRate, 0)
  assert.equal(result.summaries.reuse_compact.totalCostUsd, 8)
  assert.equal(result.summaries.reuse_compact.costPerAcceptedTaskUsd, null)
  assert.equal(result.comparisons[0].costPerAcceptedReduction.low, null)
})

test('missing assigned trials and pending trials prevent a winner and final cost totals', () => {
  const m = createStrategyExperiment(spec()), rs = records(m)
  const missing = evaluate(m, rs.slice(1))
  assert.equal(Object.values(missing.summaries).reduce((n, s) => n + s.missingTrials, 0), 1)
  assert.equal(missing.review.status, 'blocked')
  const pending = evaluate(m, rs.map((r, i) => i ? r : { ...r, execution: 'pending', acceptance: 'pending', elapsedMs: null }))
  const strategy = m.assignments[0].strategy
  assert.equal(pending.summaries[strategy].totalCostUsd, null)
  assert.equal(pending.review.status, 'blocked')
})

test('unknown buckets/costs remain unknown; recorded lower bounds are labeled', () => {
  const m = createStrategyExperiment(spec())
  const result = evaluate(m, records(m, (r, a) => a.strategy === 'adaptive'
    ? { ...r, usage: { ...r.usage, cacheWriteTokens: null }, costUsd: null, costBasis: 'unknown' } : r))
  assert.equal(result.summaries.adaptive.usage.cacheWriteTokens.total, null)
  assert.equal(result.summaries.adaptive.costPerAcceptedTaskUsd, null)
  assert(result.review.reasons.some(x => x.includes('unknown trial')))
})

test('optimizer overhead can eliminate apparent cost savings', () => {
  const m = createStrategyExperiment(spec({ optimizerCostUsd: { reuse_compact: 0, fresh_handoff: 0, adaptive: 20 } }))
  const result = evaluate(m, records(m))
  assert.equal(result.summaries.adaptive.totalCostUsd, 24)
  assert.equal(result.summaries.adaptive.costPerAcceptedTaskUsd, 6)
  const c = result.comparisons.find(c => c.candidate === 'adaptive')
  assert.equal(c.costPerAcceptedReduction.estimate, -2)
})

test('synthetic, replay and development results never qualify for review promotion', () => {
  for (const dataKind of ['synthetic', 'replay']) {
    const m = createStrategyExperiment(spec({ dataKind }))
    assert(evaluate(m, records(m)).review.reasons.some(x => x.includes('non-live')))
  }
  const m = createStrategyExperiment(spec({ dataKind: 'live', split: 'development' }))
  assert(evaluate(m, records(m)).review.reasons.some(x => x.includes('holdout')))
})

test('a small all-pass sample does not falsely establish quality equivalence', () => {
  const m = createStrategyExperiment(spec({ dataKind: 'live', promotion: { minTasks: 2 } }))
  const result = evaluate(m, records(m)), c = result.comparisons.find(c => c.candidate === 'adaptive')
  assert(c.taskReliabilityDifference.low < 0)
  assert.equal(result.review.status, 'insufficient-evidence')
})

test('critical regression or false completion overrides attractive cost savings', () => {
  const m = createStrategyExperiment(spec())
  for (const flag of ['criticalRegression', 'falseCompletion']) {
    assert.equal(evaluate(m, records(m, (r, a) => a.strategy === 'adaptive' ? { ...r, [flag]: true } : r)).review.status, 'rejected')
  }
})

test('model-only grading, ignored strategy, partial traces and extra human help block review', () => {
  const m = createStrategyExperiment(spec({ dataKind: 'live' }))
  for (const patch of [{ evidenceKind: 'llm-only' }, { strategyApplied: false }, { collectionCoverage: 'partial' }, { humanInterventions: 1 }]) {
    const result = evaluate(m, records(m, (r, a) => a.strategy === 'adaptive' ? { ...r, ...patch } : r))
    assert.equal(result.review.status, 'blocked')
  }
})

test('resampling is deterministic at task level, and only a predeclared primary comparison is reviewed', () => {
  const m = createStrategyExperiment(spec({ dataKind: 'live', tasks: Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, revision: `tree-${i}` })) }))
  const rs = records(m, (r, a) => a.strategy === 'reuse_compact' && Number(a.taskId.slice(5)) % 2 === 0
    ? { ...r, execution: 'failed', acceptance: 'failed' } : r)
  const a = evaluate(m, rs), b = evaluate(m, rs)
  assert.deepEqual(a, b)
  assert.equal(a.review.status, 'candidate-for-review')
  assert.equal(a.review.automaticActivation, false)
  assert.equal(a.review.candidate, 'adaptive')
  assert(a.comparisons.every(c => c.bootstrapUnit.startsWith('task')))
})

test('incompatible price bases and non-finite/negative metrics are never accepted', () => {
  const m = createStrategyExperiment(spec()), rs = records(m)
  assert(evaluate(m, records(m, (r, a) => a.strategy === 'adaptive' ? { ...r, costVersion: 'other-version' } : r)).review.reasons.some(x => x.includes('incomparable')))
  for (const patch of [{ calls: -1 }, { elapsedMs: Infinity }, { costUsd: NaN }, { usage: {} }, { execution: 'failed' }]) {
    assert.throws(() => evaluate(m, [{ ...rs[0], ...patch }]), /OMC\/EVAL-INVALID/)
  }
})

test('an unfinished third strategy blocks a complete experiment, and failures also need external evidence', () => {
  const m = createStrategyExperiment(spec({ dataKind: 'live', tasks: Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, revision: `tree-${i}` })) }))
  const rs = records(m, (r, a) => a.strategy === 'reuse_compact' && Number(a.taskId.slice(5)) % 2 === 0
    ? { ...r, execution: 'failed', acceptance: 'failed' } : r)
  const index = m.assignments.findIndex(a => a.strategy === 'fresh_handoff')
  assert.equal(evaluate(m, rs.map((r, i) => i === index ? { ...r, execution: 'pending', acceptance: 'pending' } : r)).review.status, 'blocked')
  const badEvidence = rs.map(r => r.acceptance === 'failed' ? { ...r, evidenceKind: 'unknown' } : r)
  assert.equal(evaluate(m, badEvidence).review.status, 'blocked')
  assert.throws(() => evaluate(m, rs.map(r => r.acceptance === 'failed' ? { ...r, evidenceRef: '' } : r)), /evidenceRef/)
})

test('runtime terminal receipts prove failure, never success or a completed task acceptance verdict', () => {
  const m = createStrategyExperiment(spec())
  assert.doesNotThrow(() => evaluate(m, records(m, r => ({ ...r, execution: 'timeout', acceptance: 'failed', evidenceKind: 'runtime-terminal' }))))
  assert.throws(() => evaluate(m, records(m, r => ({ ...r, evidenceKind: 'runtime-terminal' }))), /execution failure/)
})
