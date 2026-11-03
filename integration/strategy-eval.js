/**
 * Offline, dependency-free evaluation of session strategies. No model calls,
 * process launches, runtime policy writes, or automatic activation.
 * A trial is a whole parent task, including all children/retries/graders.
 */
import { createHash } from 'node:crypto'

export const STRATEGY_EVAL_VERSION = 1
export const SESSION_STRATEGIES = Object.freeze(['reuse_compact', 'fresh_handoff', 'adaptive'])
const BUCKETS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const CONDITIONS = ['provider', 'model', 'toolsetDigest', 'budgetDigest', 'evaluatorVersion', 'environmentDigest', 'promptDigest', 'cacheRegime']
const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled']
const DATA_KINDS = ['live', 'replay', 'synthetic']

function fail(message) { throw Object.assign(new Error(`OMC/EVAL-INVALID: ${message}`), { code: 'OMC/EVAL-INVALID' }) }
function string(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`); return value }
function number(value, label, { integer = false, min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(`${label} is invalid`)
  return value
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]))
  return value
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function manifestDigest(manifest) { const { digest: ignored, ...body } = manifest; return digest(body) }
function random(seed) {
  let state = Number.parseInt(digest(String(seed)).slice(0, 8), 16) || 1
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
}
function shuffle(values, rng) {
  const out = [...values]
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] }
  return out
}
function promotionConfig(input = {}) {
  const out = { candidate: 'adaptive', reference: 'reuse_compact', minTasks: 30, minRepeats: 2,
    minCostReduction: 0.1, maxQualityLoss: 0, maxLatencyIncrease: 0.05, ...input }
  if (!SESSION_STRATEGIES.includes(out.candidate) || !SESSION_STRATEGIES.includes(out.reference) || out.candidate === out.reference) fail('invalid primary comparison')
  number(out.minTasks, 'minTasks', { integer: true, min: 2 })
  number(out.minRepeats, 'minRepeats', { integer: true, min: 2 })
  for (const k of ['minCostReduction', 'maxQualityLoss', 'maxLatencyIncrease']) number(out[k], k, { max: 1 })
  return out
}

/** Freeze a balanced, seeded task × repeat × strategy allocation before running. */
export function createStrategyExperiment({ experimentId, tasks, repeats = 2, seed = 'omc-session-v1',
  conditions, policyVersions, dataKind = 'synthetic', split = 'development', optimizerCostUsd,
  promotion } = {}) {
  string(experimentId, 'experimentId')
  number(repeats, 'repeats', { integer: true, min: 1, max: 100 })
  if (!DATA_KINDS.includes(dataKind) || !['development', 'validation', 'holdout'].includes(split)) fail('invalid dataKind/split')
  for (const key of CONDITIONS) string(conditions?.[key], `conditions.${key}`)
  if (!['cold', 'warm', 'mixed'].includes(conditions.cacheRegime)) fail('invalid cacheRegime')
  for (const id of SESSION_STRATEGIES) {
    string(policyVersions?.[id], `policyVersions.${id}`)
    if (optimizerCostUsd?.[id] !== null) number(optimizerCostUsd?.[id], `optimizerCostUsd.${id}`)
  }
  if (!Array.isArray(tasks) || !tasks.length) fail('tasks must be non-empty')
  const normalizedTasks = tasks.map(t => ({ id: string(t.id, 'task.id'), revision: string(t.revision, 'task.revision') }))
  if (new Set(normalizedTasks.map(t => t.id)).size !== tasks.length) fail('duplicate task id')
  const rng = random(seed)
  const blocks = shuffle(normalizedTasks.flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ task, repeat }))), rng)
  const assignments = blocks.flatMap(({ task, repeat }) => shuffle(SESSION_STRATEGIES, rng).map(strategy => ({
    trialId: digest([experimentId, task.id, task.revision, repeat, strategy]).slice(0, 24),
    taskId: task.id, repeat, strategy,
  })))
  const manifest = { schemaVersion: STRATEGY_EVAL_VERSION, experimentId, dataKind, split,
    allocation: 'blocked-task-repeat/fisher-yates-xorshift32@1', seed: String(seed), repeats,
    tasks: normalizedTasks, conditions: { ...conditions }, conditionsDigest: digest(conditions),
    policyVersions: { ...policyVersions }, optimizerCostUsd: { ...optimizerCostUsd },
    promotion: promotionConfig(promotion), assignments }
  return { ...manifest, digest: manifestDigest(manifest) }
}

function validateManifest(m) {
  if (m?.schemaVersion !== STRATEGY_EVAL_VERSION || m.digest !== manifestDigest(m)) fail('manifest version/digest mismatch')
  const regenerated = createStrategyExperiment(m)
  if (regenerated.digest !== m.digest) fail('manifest is not a balanced, reproducible allocation')
}

function validateRun(run, assignment, m) {
  if (run?.schemaVersion !== STRATEGY_EVAL_VERSION) fail('run schemaVersion mismatch')
  if (run.experimentDigest !== m.digest || run.conditionsDigest !== m.conditionsDigest || run.dataKind !== m.dataKind) fail(`run ${run.trialId} has mismatched experiment/conditions/dataKind`)
  if (run.policyVersion !== m.policyVersions[assignment.strategy]) fail(`run ${run.trialId} policy mismatch`)
  if (![...TERMINAL, 'pending'].includes(run.execution)) fail('invalid execution')
  if (!['passed', 'failed', 'unknown', 'pending'].includes(run.acceptance)) fail('invalid acceptance')
  if (run.acceptance === 'passed' && run.execution !== 'completed') fail('non-completed run cannot pass acceptance')
  if (typeof run.strategyApplied !== 'boolean' || typeof run.criticalRegression !== 'boolean' || typeof run.falseCompletion !== 'boolean') fail('run flags must be booleans')
  if (!['external-tests', 'human', 'runtime-terminal', 'llm-only', 'unknown'].includes(run.evidenceKind)) fail('invalid evidenceKind')
  if (['passed', 'failed'].includes(run.acceptance)) string(run.evidenceRef, 'graded run evidenceRef')
  if (run.evidenceKind === 'runtime-terminal' && !(run.execution !== 'completed' && run.acceptance === 'failed')) fail('runtime-terminal evidence can only establish execution failure')
  for (const key of ['calls', 'attempts', 'humanInterventions']) number(run[key], key, { integer: true })
  if (run.elapsedMs !== null || run.execution !== 'pending') number(run.elapsedMs, 'elapsedMs')
  if (!run.usage || typeof run.usage !== 'object') fail('usage is required; use explicit null for unknown buckets')
  for (const key of BUCKETS) if (run.usage[key] !== null) number(run.usage[key], `usage.${key}`, { integer: true })
  if (run.costUsd !== null) {
    number(run.costUsd, 'costUsd')
    if (!['billed', 'estimated'].includes(run.costBasis)) fail('known cost requires billed/estimated basis')
    string(run.costVersion, 'costVersion')
  } else if (run.costBasis !== 'unknown') fail('unknown cost requires unknown basis')
  if (!['complete', 'partial', 'unknown'].includes(run.collectionCoverage)) fail('invalid collectionCoverage')
}

export function empiricalQuantile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q, index = Math.floor(position)
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (position - index)
}
const passed = r => r?.execution === 'completed' && r.acceptance === 'passed'
function summarize(assignments, runs, m, strategy) {
  const expected = assignments.filter(a => a.strategy === strategy)
  const rows = expected.map(a => runs.get(a.trialId)).filter(Boolean)
  const successes = rows.filter(passed).length
  const costComplete = rows.length === expected.length && rows.every(r => r.costUsd !== null && TERMINAL.includes(r.execution))
  const knownOperatingCostUsd = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const overhead = m.optimizerCostUsd[strategy]
  const totalCostUsd = costComplete && overhead !== null ? knownOperatingCostUsd + overhead : null
  const elapsed = rows.map(r => r.elapsedMs).filter(v => v !== null)
  const usage = Object.fromEntries(BUCKETS.map(key => [key, {
    knownSum: rows.reduce((sum, r) => sum + (r.usage[key] ?? 0), 0),
    reportedTrials: rows.filter(r => r.usage[key] !== null).length,
    total: rows.length === expected.length && rows.every(r => r.usage[key] !== null) ? rows.reduce((sum, r) => sum + r.usage[key], 0) : null,
  }]))
  const reliableTasks = m.tasks.filter(task => {
    const trials = expected.filter(a => a.taskId === task.id)
    return trials.every(a => passed(runs.get(a.trialId)))
  }).length
  return { assignedTrials: expected.length, recordedTrials: rows.length, missingTrials: expected.length - rows.length,
    pendingTrials: rows.filter(r => r.execution === 'pending').length,
    passedTrials: successes, successRate: successes / expected.length,
    taskReliablePasses: reliableTasks, taskCount: m.tasks.length,
    outcomeCounts: Object.fromEntries([...TERMINAL, 'pending'].map(k => [k, rows.filter(r => r.execution === k).length])),
    calls: rows.reduce((n, r) => n + r.calls, 0), attempts: rows.reduce((n, r) => n + r.attempts, 0),
    humanInterventions: rows.reduce((n, r) => n + r.humanInterventions, 0),
    criticalRegressions: rows.filter(r => r.criticalRegression).length,
    falseCompletions: rows.filter(r => r.falseCompletion).length,
    knownOperatingCostUsd, optimizerCostUsd: overhead, totalCostUsd,
    costPerAcceptedTaskUsd: totalCostUsd !== null && successes > 0 ? totalCostUsd / successes : null,
    costReportingTrials: rows.filter(r => r.costUsd !== null).length,
    elapsedMs: { p50Observed: empiricalQuantile(elapsed, 0.5), p95Observed: empiricalQuantile(elapsed, 0.95), reportedTrials: elapsed.length },
    usage }
}

function wilson(successes, n) {
  // 97.5% marginal Wilson intervals; their difference is conservative for
  // the one predeclared comparison. Normal-score approximation, not exact CI.
  const z = 2.241402727604947, p = successes / n, d = 1 + z * z / n
  const center = (p + z * z / (2 * n)) / d
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}
function reduction(base, candidate) { return base !== null && base > 0 && candidate !== null ? 1 - candidate / base : null }
function interval(samples, estimate, iterations) {
  const finite = samples.filter(Number.isFinite)
  // Never discard undefined zero-success bootstrap samples and quietly claim
  // certainty: any such sample makes this interval unavailable for the gate.
  return { estimate, low: finite.length === iterations ? empiricalQuantile(finite, 0.025) : null,
    high: finite.length === iterations ? empiricalQuantile(finite, 0.975) : null,
    finiteReplicates: finite.length, iterations }
}

function compare(m, runs, summaries, candidate, reference, iterations) {
  const c = summaries[candidate], b = summaries[reference]
  const relevant = m.assignments.filter(a => [candidate, reference].includes(a.strategy))
  const complete = relevant.every(a => { const r = runs.get(a.trialId); return r && TERMINAL.includes(r.execution) && ['passed', 'failed'].includes(r.acceptance) })
  const taskRows = m.tasks.map(task => Object.fromEntries([candidate, reference].map(strategy => [strategy,
    relevant.filter(a => a.taskId === task.id && a.strategy === strategy).map(a => runs.get(a.trialId)),
  ])))
  const costsKnown = complete && relevant.every(a => runs.get(a.trialId).costUsd !== null)
    && m.optimizerCostUsd[candidate] !== null && m.optimizerCostUsd[reference] !== null
  const costSamples = [], timeSamples = [], rng = random(`${m.seed}/${candidate}/${reference}`)
  if (complete) {
    for (let i = 0; i < iterations; i++) {
      const selected = Array.from({ length: taskRows.length }, () => taskRows[Math.floor(rng() * taskRows.length)])
      const metrics = Object.fromEntries([candidate, reference].map(strategy => {
        const rs = selected.flatMap(task => task[strategy]), count = rs.filter(passed).length
        return [strategy, { cost: costsKnown && count ? (rs.reduce((n, r) => n + r.costUsd, 0) + m.optimizerCostUsd[strategy]) / count : null,
          time: empiricalQuantile(rs.map(r => r.elapsedMs), 0.5) }]
      }))
      costSamples.push(reduction(metrics[reference].cost, metrics[candidate].cost))
      timeSamples.push(reduction(metrics[reference].time, metrics[candidate].time))
    }
  }
  const cw = wilson(c.taskReliablePasses, c.taskCount), bw = wilson(b.taskReliablePasses, b.taskCount)
  return { candidate, reference, complete,
    costPerAcceptedReduction: interval(costSamples, reduction(b.costPerAcceptedTaskUsd, c.costPerAcceptedTaskUsd), iterations),
    p50ElapsedReduction: interval(timeSamples, reduction(b.elapsedMs.p50Observed, c.elapsedMs.p50Observed), iterations),
    taskReliabilityDifference: { estimate: (c.taskReliablePasses - b.taskReliablePasses) / c.taskCount,
      low: cw.low - bw.high, high: cw.high - bw.low,
      method: 'difference of 97.5% marginal Wilson intervals; task is the unit; all repeats must pass' },
    bootstrapUnit: 'task (all paired repeats and strategies kept together)',
    warning: 'Intervals describe this frozen task sample; not proof of production generalization or continuous-peeking validity.' }
}

/** Analyze assigned trials, including failures and absent records. */
export function evaluateStrategyExperiment(manifest, records, { bootstrapIterations = 1000 } = {}) {
  validateManifest(manifest)
  number(bootstrapIterations, 'bootstrapIterations', { integer: true, min: 200, max: 10000 })
  if (!Array.isArray(records)) fail('records must be an array')
  const assignments = new Map(manifest.assignments.map(a => [a.trialId, a]))
  const runs = new Map()
  for (const run of records) {
    const assignment = assignments.get(run?.trialId)
    if (!assignment) fail('unassigned trial; freeze all trials before evaluation')
    if (runs.has(run.trialId)) fail('duplicate trial; aggregate attempts once before evaluation')
    validateRun(run, assignment, manifest)
    runs.set(run.trialId, run)
  }
  const summaries = Object.fromEntries(SESSION_STRATEGIES.map(s => [s, summarize(manifest.assignments, runs, manifest, s)]))
  const comparisons = SESSION_STRATEGIES.filter(s => s !== manifest.promotion.reference)
    .map(s => compare(manifest, runs, summaries, s, manifest.promotion.reference, bootstrapIterations))
  const p = manifest.promotion, primary = comparisons.find(c => c.candidate === p.candidate)
  const allRuns = [...runs.values()]
  const primaryRuns = manifest.assignments.filter(a => [p.candidate, p.reference].includes(a.strategy)).map(a => runs.get(a.trialId)).filter(Boolean)
  const blockers = []
  if (manifest.dataKind !== 'live') blockers.push('non-live data cannot support promotion')
  if (manifest.split !== 'holdout') blockers.push('promotion requires an untouched holdout experiment')
  if (manifest.assignments.some(a => {
    const r = runs.get(a.trialId)
    return !r || !TERMINAL.includes(r.execution) || !['passed', 'failed'].includes(r.acceptance)
  })) blockers.push('missing/pending/ungraded assigned trials')
  if (manifest.tasks.length < p.minTasks || manifest.repeats < p.minRepeats) blockers.push('insufficient predeclared tasks/repeats')
  if (allRuns.some(r => !r.strategyApplied)) blockers.push('assigned strategy not applied (kept in intention-to-treat summaries)')
  if (allRuns.some(r => r.collectionCoverage !== 'complete')) blockers.push('incomplete collection coverage')
  if (allRuns.some(r => ['passed', 'failed'].includes(r.acceptance) && !['external-tests', 'human', 'runtime-terminal'].includes(r.evidenceKind))) blockers.push('acceptance relies on model-only/unknown evidence')
  if (primaryRuns.some(r => r.costUsd === null) || [p.candidate, p.reference].some(s => manifest.optimizerCostUsd[s] === null)) blockers.push('unknown trial/optimizer cost')
  if (new Set(primaryRuns.filter(r => r.costUsd !== null).map(r => `${r.costBasis}/${r.costVersion}`)).size > 1) blockers.push('incomparable cost bases/versions')
  if (summaries[p.candidate].humanInterventions > summaries[p.reference].humanInterventions) blockers.push('candidate received more human assistance')
  const candidateRows = manifest.assignments.filter(a => a.strategy === p.candidate).map(a => runs.get(a.trialId)).filter(Boolean)
  const regression = candidateRows.some(r => r.criticalRegression || r.falseCompletion)
  const evidenceReasons = []
  if (primary.costPerAcceptedReduction.low === null || primary.costPerAcceptedReduction.low < p.minCostReduction) evidenceReasons.push('cost reduction lower bound has not reached target')
  if (primary.taskReliabilityDifference.low < -p.maxQualityLoss) evidenceReasons.push('quality non-inferiority not established')
  if (primary.p50ElapsedReduction.low === null || primary.p50ElapsedReduction.low < -p.maxLatencyIncrease) evidenceReasons.push('latency constraint not established')
  const status = regression ? 'rejected' : blockers.length ? 'blocked' : evidenceReasons.length ? 'insufficient-evidence' : 'candidate-for-review'
  return { schemaVersion: STRATEGY_EVAL_VERSION, experimentId: manifest.experimentId, experimentDigest: manifest.digest,
    dataKind: manifest.dataKind, split: manifest.split,
    conditions: manifest.conditions, policyVersions: manifest.policyVersions, seed: manifest.seed,
    summaries, comparisons,
    review: { status, candidate: p.candidate, reference: p.reference, automaticActivation: false,
      reasons: [...(regression ? ['candidate introduced critical regression/false completion'] : []), ...blockers, ...evidenceReasons] },
    limitations: ['Offline evaluator only; runtime collection, dispatch, grading, candidate generation and canary/rollback are not installed by this module.',
      'Digests check declared record consistency; they do not attest that the runtime or grader reported truthfully.',
      'All costs include parent/children/retries/compaction/grading; optimizer costs are added separately and must not be omitted.',
      'Do not repeatedly inspect or optimize against holdout results and then reuse the same holdout as fresh evidence.'] }
}
