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

// ── 0.8 experiment groups: explicit arms, prerequisite, provenance ──────────

const baseConditions = () => ({ provider: 'fixture', model: 'fixture-v1', toolsetDigest: 'tools-v1', budgetDigest: 'budget-v1',
  evaluatorVersion: 'external-v1', environmentDigest: 'env-v1', promptDigest: 'prompt-v1', cacheRegime: 'cold' })

function groupSpec({ experimentGroup, arms, tasks, prerequisite, over = {} }) {
  const armList = arms ?? SESSION_STRATEGIES
  return {
    experimentId: `pilot-${experimentGroup}`,
    experimentGroup,
    ...(arms ? { arms } : {}),
    tasks,
    ...(prerequisite ? { prerequisite } : {}),
    repeats: 1,
    seed: 'pilot-2026-11-03',
    dataKind: 'synthetic',
    split: 'development',
    conditions: baseConditions(),
    policyVersions: Object.fromEntries(armList.map((arm) => [arm, `${arm}@1`])),
    optimizerCostUsd: Object.fromEntries(armList.map((arm) => [arm, 0])),
    promotion: { candidate: armList[armList.length - 1], reference: armList[0], minTasks: 2 },
    ...over,
  }
}

function chainTasks(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-task-${index}`,
    revision: `${prefix}-tree-${index}`,
    kind: 'chain',
    chain: [`${prefix}-${index}-step-1`, `${prefix}-${index}-step-2`, `${prefix}-${index}-step-3`],
  }))
}

/** The arm's first frozen assignment is the collector's prerequisite carrier. */
function carrierTrialId(manifest, arm) {
  return manifest.assignments.find((assignment) => assignment.strategy === arm)?.trialId ?? null
}

const PREREQUISITE_BLOCK = Object.freeze({
  execution: 'completed',
  calls: 2,
  costUsd: 0.5,
  costBasis: 'estimated',
  costVersion: 'prices-v1',
  usage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
})

/**
 * Mimic the collector's new output: the shared prerequisite is attached once,
 * to the arm's carrier trial, and every other run carries `prerequisite: null`.
 */
function attachCarrierPrerequisite(manifest, records, byArm = {}) {
  return records.map((record) => {
    const assignment = manifest.assignments.find((row) => row.trialId === record.trialId)
    const carrier = carrierTrialId(manifest, assignment.strategy)
    if (record.trialId !== carrier) return { ...record, prerequisite: null }
    const block = Object.prototype.hasOwnProperty.call(byArm, assignment.strategy)
      ? byArm[assignment.strategy]
      : PREREQUISITE_BLOCK
    return block === null ? { ...record, prerequisite: null } : { ...record, prerequisite: { ...block } }
  })
}

test('legacy three-strategy manifests keep exactly their old shape and digest rules', () => {
  const m = createStrategyExperiment(spec())
  assert.deepEqual(Object.keys(m).sort(), [
    'allocation', 'assignments', 'conditions', 'conditionsDigest', 'dataKind', 'digest', 'experimentId',
    'optimizerCostUsd', 'policyVersions', 'promotion', 'repeats', 'schemaVersion', 'seed', 'split', 'tasks',
  ].sort())
  assert.equal('arms' in m, false)
  assert.equal('experimentGroup' in m, false)
  assert.equal('prerequisite' in m, false)
  assert.deepEqual(m.tasks, [{ id: 'one', revision: 'tree@1' }, { id: 'two', revision: 'tree@2' }])
  assert.deepEqual(m, createStrategyExperiment(spec()))
})

test('E1/E2/E3 freeze deterministic 12 + 9 + 4 = 25 assignments at repeats=1', () => {
  const e1 = createStrategyExperiment(groupSpec({
    experimentGroup: 'E1',
    arms: ['single_agent', 'multi_agent_same_model', 'multi_agent_cross_model'],
    tasks: Array.from({ length: 4 }, (_, i) => ({ id: `e1-task-${i}`, revision: `e1-tree-${i}` })),
  }))
  const e2 = createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: chainTasks('e2', 3),
    prerequisite: { id: 'e2-shared-prerequisite', revision: 'e2-prereq-tree', provenance: { source: 'fixture', license: 'MIT' } },
  }))
  const e3 = createStrategyExperiment(groupSpec({
    experimentGroup: 'E3',
    arms: ['single_agent', 'multi_agent'],
    tasks: Array.from({ length: 2 }, (_, i) => ({ id: `e3-task-${i}`, revision: `e3-tree-${i}` })),
  }))

  assert.equal(e1.assignments.length, 12)
  assert.equal(e2.assignments.length, 9)
  assert.equal(e3.assignments.length, 4)
  assert.equal(e1.assignments.length + e2.assignments.length + e3.assignments.length, 25)
  assert.deepEqual(e1, createStrategyExperiment(groupSpec({
    experimentGroup: 'E1',
    arms: ['single_agent', 'multi_agent_same_model', 'multi_agent_cross_model'],
    tasks: Array.from({ length: 4 }, (_, i) => ({ id: `e1-task-${i}`, revision: `e1-tree-${i}` })),
  })))
  assert.equal(new Set([...e1.assignments, ...e2.assignments, ...e3.assignments].map((a) => a.trialId)).size, 25)

  for (const m of [e1, e2, e3]) {
    assert.equal(typeof m.digest, 'string')
    const arms = m.arms ?? SESSION_STRATEGIES
    for (const task of m.tasks) {
      assert.deepEqual(
        m.assignments.filter((a) => a.taskId === task.id).map((a) => a.strategy).sort(),
        [...arms].sort(),
        `${m.experimentGroup}/${task.id} is balanced`,
      )
    }
  }
  assert.deepEqual(e3.arms, ['single_agent', 'multi_agent'])
  assert.equal(e3.promotion.candidate, 'multi_agent')
  assert.equal(e3.promotion.reference, 'single_agent')
})

test('E2 keeps the shared prerequisite out of the trial count and preserves chain order', () => {
  const inputChains = chainTasks('e2', 3)
  const m = createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: inputChains,
    prerequisite: { id: 'e2-shared-prerequisite', revision: 'e2-prereq-tree' },
  }))
  assert.equal(m.prerequisite.id, 'e2-shared-prerequisite')
  assert.equal(m.assignments.some((a) => a.taskId === 'e2-shared-prerequisite'), false)
  assert.equal(m.prerequisiteTrials.length, 3)
  assert.equal(m.prerequisiteTrials.every((row) => row.countedAsTrial === false), true)
  assert.deepEqual(m.tasks.map((task) => task.chain), inputChains.map((task) => task.chain))
  for (const task of m.tasks) assert.equal(task.kind, 'chain')

  // A plain single-turn task is not a session-reuse experiment.
  assert.throws(() => createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: [{ id: 'single', revision: 'tree@1' }],
  })), /single-turn/)

  // But a chain without a declared kind is inferred, and an explicit
  // single-turn kind with a chain is refused instead of guessed.
  const inferred = createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    tasks: [{ id: 'inferred', revision: 'tree@1', chain: ['step-1', 'step-2'] }],
  }))
  assert.equal(inferred.tasks[0].kind, 'chain')
  assert.throws(() => createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    tasks: [{ id: 'bad', revision: 'tree@1', kind: 'single-turn', chain: ['step-1', 'step-2'] }],
  })), /chain/)
})

test('tampered arms, chains and per-task baseCommit fail the digest and block evaluation', () => {
  const m = createStrategyExperiment(groupSpec({
    experimentGroup: 'E1',
    arms: ['single_agent', 'multi_agent'],
    tasks: [
      { id: 't1', revision: 'tree@1', repo: 'C:/external/repo', baseCommit: 'a'.repeat(40), provenance: { source: 'bench' } },
      { id: 't2', revision: 'tree@2' },
    ],
  }))
  const changedArms = structuredClone(m)
  changedArms.arms = ['single_agent', 'different']
  assert.throws(() => evaluate(changedArms, records(m)), /digest/)

  const changedBase = structuredClone(m)
  changedBase.tasks[0].baseCommit = 'b'.repeat(40)
  assert.throws(() => evaluate(changedBase, records(m)), /digest/)

  const chain = createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    tasks: [{ id: 'chain-task', revision: 'tree@1', kind: 'chain', chain: ['one', 'two'] }],
  }))
  const reordered = structuredClone(chain)
  reordered.tasks[0].chain = ['two', 'one']
  assert.throws(() => evaluate(reordered, records(chain)), /digest/)

  const tampered = structuredClone(m)
  tampered.experimentId = 'edited-after-freeze'
  assert.throws(() => evaluate(m, [{ ...records(m)[0], conditionsDigest: 'drift' }]), /mismatched/)
  assert.throws(() => evaluate(tampered, records(m)), /digest/)
  assert.doesNotThrow(() => evaluate(m, records(m)))
})

test('unknown cost in any arm stays null, is never summed as $0, and blocks review', () => {
  const m = createStrategyExperiment(groupSpec({
    experimentGroup: 'E1',
    arms: ['single_agent', 'multi_agent'],
    tasks: [{ id: 't1', revision: 'tree@1' }, { id: 't2', revision: 'tree@2' }],
    over: { dataKind: 'live', split: 'holdout' },
  }))
  const result = evaluate(m, records(m, (r, a) => a.strategy === 'multi_agent'
    ? { ...r, costUsd: null, costBasis: 'unknown' }
    : r))
  const summary = result.summaries.multi_agent
  assert.equal(summary.unknownCost, true)
  assert.equal(summary.totalCostUsd, null)
  assert.equal(summary.costPerAcceptedTaskUsd, null)
  assert.equal(summary.knownOperatingCostUsd, 0, 'known subtotal is labeled, not a total')
  assert.equal(result.unknownCost.any, true)
  assert.equal(result.review.status, 'blocked')
  assert(result.review.reasons.some((reason) => reason.includes('unknown trial')))
})

test('reports carry group, arms, provenance and carrier-only prerequisite attribution', () => {
  const m = createStrategyExperiment(groupSpec({
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: chainTasks('e2', 3),
    prerequisite: { id: 'shared', revision: 'prereq@1', provenance: 'fixture' },
  }))
  const result = evaluate(m, attachCarrierPrerequisite(m, records(m)))
  assert.equal(result.experimentGroup, 'E2')
  assert.equal(result.group, 'E2')
  assert.deepEqual(result.arms, [...SESSION_STRATEGIES])
  assert.equal(result.provenance.length, 3)
  assert.deepEqual(result.provenance[0].chain, m.tasks[0].chain)
  assert.equal(result.prerequisite.taskId, 'shared')
  assert.equal(result.prerequisite.recorded, 3)
  assert.equal(result.prerequisite.missing, 0)
  assert.equal(result.prerequisite.costUsd, 3 * 0.5)
  for (const arm of SESSION_STRATEGIES) {
    assert.equal(result.summaries[arm].prerequisite.recorded, 1)
    assert.equal(result.summaries[arm].prerequisite.costUsd, 0.5)
    assert.equal(result.summaries[arm].prerequisite.calls, 2)
    assert.equal(result.summaries[arm].prerequisite.valid, true)
  }
  // The prerequisite is not an independent trial: trial counts are unchanged.
  assert.equal(result.summaries.reuse_compact.assignedTrials, 3)
  assert.equal(result.summaries.reuse_compact.missingTrials, 0)
})

test('carrier-only prerequisite cost is priced once per arm and the cost comparison is computable', () => {
  const m = createStrategyExperiment({
    experimentId: 'carrier-priced',
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: chainTasks('carrier', 2),
    prerequisite: { id: 'carrier-shared', revision: 'prereq@1' },
    repeats: 2,
    seed: 'carrier-seed',
    dataKind: 'live',
    split: 'holdout',
    conditions: baseConditions(),
    policyVersions: { reuse_compact: 'reuse@1', fresh_handoff: 'fresh@1', adaptive: 'adaptive@1' },
    optimizerCostUsd: { reuse_compact: 0, fresh_handoff: 0, adaptive: 0 },
    promotion: { candidate: 'adaptive', reference: 'reuse_compact', minTasks: 2, minRepeats: 2 },
  })
  const recordsWithCost = records(m, (record, assignment) => ({
    ...record,
    costUsd: assignment.strategy === 'adaptive' ? 1 : 2,
  }))
  const result = evaluate(m, attachCarrierPrerequisite(m, recordsWithCost))
  assert.equal(result.unknownCost.any, false)
  assert.equal(result.unknownCost.prerequisite, false)
  assert.equal(result.prerequisite.recorded, 3)
  assert.equal(result.prerequisite.costUsd, 1.5)
  for (const arm of SESSION_STRATEGIES) {
    const summary = result.summaries[arm]
    assert.equal(summary.prerequisite.recorded, 1, `${arm} prices the shared run once`)
    assert.equal(summary.prerequisite.costUsd, 0.5)
    assert.equal(summary.prerequisite.calls, 2)
    assert.equal(summary.missingTrials, 0, 'a non-carrier null is not a missing prerequisite')
    // 4 trials (2 tasks x 2 repeats) x per-trial cost + one 0.5 prerequisite.
    assert.equal(summary.totalCostUsd, (arm === 'adaptive' ? 4 : 8) + 0.5)
  }
  const comparison = result.comparisons.find((row) => row.candidate === 'adaptive')
  assert.equal(typeof comparison.costPerAcceptedReduction.estimate, 'number')
  assert.notEqual(comparison.costPerAcceptedReduction.low, null,
    'carrier-only prerequisite must not make the bootstrap interval unavailable')
  assert(comparison.costPerAcceptedReduction.low > 0)
  assert.equal(result.review.status, 'insufficient-evidence', 'the prerequisite no longer blocks; the small sample still does')
})

test('unknown, duplicated, wrong-arm and missing carrier prerequisites block without becoming $0', () => {
  const build = () => createStrategyExperiment({
    experimentId: 'carrier-audit',
    experimentGroup: 'E2',
    arms: [...SESSION_STRATEGIES],
    tasks: chainTasks('audit', 2),
    prerequisite: { id: 'audit-shared', revision: 'prereq@1' },
    repeats: 1,
    seed: 'audit-seed',
    dataKind: 'live',
    split: 'holdout',
    conditions: baseConditions(),
    policyVersions: { reuse_compact: 'reuse@1', fresh_handoff: 'fresh@1', adaptive: 'adaptive@1' },
    optimizerCostUsd: { reuse_compact: 0, fresh_handoff: 0, adaptive: 0 },
    promotion: { candidate: 'adaptive', reference: 'reuse_compact', minTasks: 2, minRepeats: 2 },
  })

  // Unknown prerequisite cost on one arm: null, not 0, and no settled total.
  const unknown = build()
  const unknownResult = evaluate(unknown, attachCarrierPrerequisite(unknown, records(unknown), {
    fresh_handoff: { ...PREREQUISITE_BLOCK, costUsd: null, costBasis: 'unknown', calls: null },
  }))
  assert.equal(unknownResult.unknownCost.prerequisite, true)
  assert.equal(unknownResult.summaries.fresh_handoff.prerequisite.costUsd, null)
  assert.notEqual(unknownResult.summaries.fresh_handoff.prerequisite.costUsd, 0)
  assert.equal(unknownResult.summaries.fresh_handoff.totalCostUsd, null)
  assert.equal(unknownResult.review.status, 'blocked')
  assert(unknownResult.review.reasons.some((reason) => reason.includes('unknown trial/optimizer/prerequisite cost')))

  // Missing carrier: no run carries the declared shared prerequisite.
  const missing = build()
  const missingRows = attachCarrierPrerequisite(missing, records(missing), { adaptive: null })
  const missingResult = evaluate(missing, missingRows)
  assert.equal(missingResult.summaries.adaptive.prerequisite.recorded, 0)
  assert.equal(missingResult.prerequisite.missing, 1)
  assert.equal(missingResult.unknownCost.prerequisite, true)
  assert.equal(missingResult.summaries.adaptive.totalCostUsd, null)
  assert.equal(missingResult.review.status, 'blocked')

  // Wrong arm: the adaptive carrier carries a fresh_handoff prerequisite.
  const wrongArm = build()
  const wrongArmResult = evaluate(wrongArm, attachCarrierPrerequisite(wrongArm, records(wrongArm), {
    adaptive: { ...PREREQUISITE_BLOCK, arm: 'fresh_handoff' },
  }))
  assert.equal(wrongArmResult.summaries.adaptive.prerequisite.wrongArm, true)
  assert.equal(wrongArmResult.summaries.adaptive.prerequisite.costUsd, null)
  assert.equal(wrongArmResult.review.status, 'blocked')

  // Duplicate: a non-carrier repeats the arm-level run; it must not be charged twice.
  const duplicated = build()
  const duplicateRows = attachCarrierPrerequisite(duplicated, records(duplicated))
  const carrier = carrierTrialId(duplicated, 'adaptive')
  const nonCarrier = duplicated.assignments.find((row) => row.strategy === 'adaptive' && row.trialId !== carrier).trialId
  const withDuplicate = duplicateRows.map((row) => row.trialId === nonCarrier
    ? { ...row, prerequisite: { ...PREREQUISITE_BLOCK, arm: 'adaptive' } }
    : row)
  const duplicateResult = evaluate(duplicated, withDuplicate)
  assert.equal(duplicateResult.summaries.adaptive.prerequisite.duplicateRecords, 1)
  assert.equal(duplicateResult.summaries.adaptive.prerequisite.valid, false)
  assert.equal(duplicateResult.summaries.adaptive.totalCostUsd, null, 'the arm total is unknown, never doubled')
  assert.equal(duplicateResult.review.status, 'blocked')
})
