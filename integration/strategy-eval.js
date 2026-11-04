/**
 * Offline, dependency-free evaluation of session strategies. No model calls,
 * process launches, runtime policy writes, or automatic activation.
 * A trial is a whole parent task, including all children/retries/graders.
 *
 * 0.8 experiment groups
 * ---------------------
 * The original three-strategy manifest is still the default and its digest is
 * unchanged. A frozen plan may now additionally declare:
 *
 *   experimentGroup  the 0.8 group label (E1 / E2 / E3)
 *   arms             the comparison arms for this group (default: the three
 *                    session strategies); an arm is what `strategy` used to be
 *   prerequisite     one shared task that is NOT an independent trial, but
 *                    whose cost/calls are attributed to every arm
 *   task.kind/chain  `chain` makes a task a multi-turn ordered chain; an E2
 *                    session-reuse experiment cannot silently use a plain
 *                    single-turn task
 *   task.repo/baseCommit/provenance
 *                    frozen execution provenance that the runner must verify
 *                    instead of substituting this repository's HEAD
 *
 * New keys are only emitted when explicitly supplied, so old manifests keep
 * their exact digest.
 */
import { createHash } from 'node:crypto'

export const STRATEGY_EVAL_VERSION = 1
export const SESSION_STRATEGIES = Object.freeze(['reuse_compact', 'fresh_handoff', 'adaptive'])
export const EXPERIMENT_GROUPS = Object.freeze(['E1', 'E2', 'E3'])
export const TASK_KINDS = Object.freeze(['single-turn', 'chain'])
const BUCKETS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const CONDITIONS = ['provider', 'model', 'toolsetDigest', 'budgetDigest', 'evaluatorVersion', 'environmentDigest', 'promptDigest', 'cacheRegime']
const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled']
const DATA_KINDS = ['live', 'replay', 'synthetic']

function fail(message) { throw Object.assign(new Error(`OMC/EVAL-INVALID: ${message}`), { code: 'OMC/EVAL-INVALID' }) }
function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`)
  return value
}
function number(value, label, { integer = false, min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(`${label} is invalid`)
  return value
}
function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}
function cloneJson(value, label) {
  if (value === undefined) fail(`${label} must not be undefined`)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    fail(`${label} must be JSON-serialisable: ${error?.message ?? error}`)
  }
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

/** The arms of a frozen manifest; legacy manifests have no `arms` key. */
export function experimentArms(manifest) {
  return Array.isArray(manifest?.arms) && manifest.arms.length ? manifest.arms : SESSION_STRATEGIES
}

function normalizeRole(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label} must be an object`)
  const out = {
    id: string(raw.id, `${label}.id`),
    writer: raw.writer === true,
    surface: string(raw.surface, `${label}.surface`),
    provider: string(raw.provider, `${label}.provider`),
    model: string(raw.model, `${label}.model`),
  }
  if (raw.prompt !== undefined) out.prompt = string(raw.prompt, `${label}.prompt`)
  if (raw.readOnly !== undefined && raw.readOnly !== (out.writer !== true)) {
    fail(`${label}.readOnly must equal !writer`)
  }
  return out
}

function normalizeExecution(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label} must be an object`)
  if (!Array.isArray(raw.roles) || raw.roles.length === 0) fail(`${label}.roles must be a non-empty array`)
  const roles = raw.roles.map((role, index) => normalizeRole(role, `${label}.roles[${index}]`))
  if (new Set(roles.map((role) => role.id)).size !== roles.length) fail(`${label}.roles ids must be unique`)
  const writers = roles.filter((role) => role.writer === true)
  if (writers.length !== 1) fail(`${label}.roles must contain exactly one writer`)
  return { roles }
}

function normalizeArms(arms) {
  if (arms === undefined || arms === null) return null
  if (!Array.isArray(arms) || !arms.length) fail('arms must be a non-empty array')
  const out = arms.map((arm, index) => {
    if (typeof arm === 'string') return { id: string(arm, `arms[${index}]`), execution: null }
    if (!arm || typeof arm !== 'object' || Array.isArray(arm)) fail(`arms[${index}] must be a string or an arm object`)
    const id = string(arm.id, `arms[${index}].id`)
    const execution = arm.execution ?? (arm.roles ? { roles: arm.roles } : null)
    return { id, execution: execution === null ? null : normalizeExecution(execution, `arms[${index}].execution`) }
  })
  if (new Set(out.map((arm) => arm.id)).size !== out.length) fail('duplicate arm')
  return out
}

/** Resolve explicit per-arm execution roles, or derive a conservative default. */
export function resolveArmRoles({ manifest, arm, task } = {}) {
  const id = string(arm, 'arm')
  const explicit = manifest?.armExecution?.[id]
  if (explicit !== undefined) return normalizeExecution(explicit, `armExecution.${id}`).roles
  const conditions = manifest?.conditions ?? {}
  const writer = {
    id: 'writer',
    writer: true,
    surface: conditions.harness ?? 'native',
    provider: conditions.provider,
    model: conditions.model,
  }
  if (task?.chain) return [writer]
  const textArm = String(id)
  if (textArm === 'single') return [writer]
  if (/multi-role|same-model/.test(textArm)) {
    return [writer, {
      id: 'reviewer',
      writer: false,
      surface: conditions.harness ?? 'native',
      provider: conditions.reviewerProvider ?? conditions.provider,
      model: conditions.reviewerModel ?? conditions.model,
    }]
  }
  if (/different-model/.test(textArm)) {
    if (!conditions.reviewerProvider || !conditions.reviewerModel) {
      fail(`arm ${id} needs an explicit reviewerProvider/reviewerModel or armExecution roles`)
    }
    return [writer, {
      id: 'reviewer',
      writer: false,
      surface: conditions.harness ?? 'native',
      provider: conditions.reviewerProvider,
      model: conditions.reviewerModel,
    }]
  }
  return [writer]
}

/** One ordered execution step list shared by graph planning and the executor. */
export function resolveTrialSteps({ manifest, trial, task } = {}) {
  const roles = resolveArmRoles({ manifest, arm: trial?.arm ?? trial?.strategy, task })
  const writer = roles.find((role) => role.writer === true)
  const chain = Array.isArray(task?.chain) && task.chain.length > 1 ? task.chain : null
  if (chain) {
    return chain.map((step, index) => {
      const stepId = typeof step === 'string' ? step : (step?.id ?? step?.name)
      return {
        index,
        id: String(stepId),
        step,
        role: writer,
        roleId: writer.id,
        writer: true,
      }
    })
  }
  if (trial?.role === 'prerequisite') {
    return [{ index: 0, id: `role-${writer.id}`, step: null, role: writer, roleId: writer.id, writer: true }]
  }
  return roles.map((role, index) => ({
    index,
    id: `role-${role.id}`,
    step: null,
    role,
    roleId: role.id,
    writer: role.writer === true,
  }))
}

function normalizeChain(chain, label) {
  if (!Array.isArray(chain) || !chain.length) fail(`${label} must be a non-empty ordered array`)
  const ids = chain.map((step, index) => {
    if (typeof step === 'string') return string(step, `${label}[${index}]`)
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`${label}[${index}] must be a step id or an object`)
    return string(step.id ?? step.name, `${label}[${index}].id`)
  })
  if (new Set(ids).size !== ids.length) fail(`${label} step ids must be unique`)
  if (ids.length < 2) fail(`${label} needs at least two ordered steps; a one-step chain is a single-turn task`)
  return cloneJson(chain, label)
}

function normalizeTask(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label} must be an object`)
  const task = {
    id: string(raw.id, `${label}.id`),
    revision: string(raw.revision, `${label}.revision`),
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'id' || key === 'revision' || value === undefined) continue
    task[key] = cloneJson(value, `${label}.${key}`)
  }
  if (task.repo !== undefined) string(task.repo, `${label}.repo`)
  if (task.baseCommit !== undefined) string(task.baseCommit, `${label}.baseCommit`)
  if (task.kind !== undefined && !TASK_KINDS.includes(task.kind)) {
    fail(`${label}.kind must be one of ${TASK_KINDS.join(', ')}`)
  }
  if (task.chain !== undefined) {
    task.chain = normalizeChain(task.chain, `${label}.chain`)
    if (task.kind !== undefined && task.kind !== 'chain') fail(`${label} declares a chain but kind is "${task.kind}"`)
    task.kind = 'chain'
  }
  if (task.kind === 'chain' && task.chain === undefined) fail(`${label}.chain is required when kind is "chain"`)
  return task
}

function normalizePrerequisite(raw) {
  if (raw === undefined || raw === null) return null
  const task = normalizeTask(raw, 'prerequisite')
  return task
}

function promotionConfig(input = {}, arms = SESSION_STRATEGIES) {
  const candidate = arms.includes('adaptive') ? 'adaptive' : arms[arms.length - 1]
  const reference = arms.includes('reuse_compact') ? 'reuse_compact' : arms[0]
  const out = { candidate, reference, minTasks: 30, minRepeats: 2,
    minCostReduction: 0.1, maxQualityLoss: 0, maxLatencyIncrease: 0.05, ...input }
  if (!arms.includes(out.candidate) || !arms.includes(out.reference) || out.candidate === out.reference) fail('invalid primary comparison')
  number(out.minTasks, 'minTasks', { integer: true, min: 2 })
  number(out.minRepeats, 'minRepeats', { integer: true, min: 2 })
  for (const k of ['minCostReduction', 'maxQualityLoss', 'maxLatencyIncrease']) number(out[k], k, { max: 1 })
  return out
}

/**
 * Freeze a balanced, seeded task × repeat × arm allocation before running.
 *
 * Backward compatible: callers that pass no `arms`/`experimentGroup`/
 * `prerequisite` get exactly the manifest the previous version produced.
 */
export function createStrategyExperiment({ experimentId, tasks, repeats = 2, seed = 'omc-session-v1',
  conditions, policyVersions, dataKind = 'synthetic', split = 'development', optimizerCostUsd,
  promotion, arms, armExecution, experimentGroup, prerequisite } = {}) {
  string(experimentId, 'experimentId')
  number(repeats, 'repeats', { integer: true, min: 1, max: 100 })
  if (!DATA_KINDS.includes(dataKind) || !['development', 'validation', 'holdout'].includes(split)) fail('invalid dataKind/split')
  plainObject(conditions, 'conditions')
  for (const key of CONDITIONS) string(conditions?.[key], `conditions.${key}`)
  if (!['cold', 'warm', 'mixed'].includes(conditions.cacheRegime)) fail('invalid cacheRegime')
  if (conditions.harness !== undefined) string(conditions.harness, 'conditions.harness')

  const group = experimentGroup === undefined || experimentGroup === null ? null : string(experimentGroup, 'experimentGroup')
  const explicitArmRows = normalizeArms(arms)
  const explicitArms = explicitArmRows ? explicitArmRows.map((arm) => arm.id) : null
  const armList = explicitArms ?? [...SESSION_STRATEGIES]
  const fusedExecution = {}
  if (explicitArmRows) {
    for (const arm of explicitArmRows) if (arm.execution) fusedExecution[arm.id] = arm.execution
  }
  if (armExecution !== undefined) {
    plainObject(armExecution, 'armExecution')
    for (const [id, execution] of Object.entries(armExecution)) {
      if (!armList.includes(id)) fail(`armExecution.${id} names an arm outside the frozen allocation`)
      fusedExecution[id] = normalizeExecution(execution, `armExecution.${id}`)
    }
  }
  for (const id of Object.keys(fusedExecution)) {
    const execution = fusedExecution[id]
    if (execution && !armList.includes(id)) fail(`arm execution ${id} names an arm outside the frozen allocation`)
  }

  plainObject(policyVersions, 'policyVersions')
  for (const id of armList) {
    string(policyVersions?.[id], `policyVersions.${id}`)
    if (optimizerCostUsd?.[id] !== null) number(optimizerCostUsd?.[id], `optimizerCostUsd.${id}`)
  }

  if (!Array.isArray(tasks) || !tasks.length) fail('tasks must be non-empty')
  const normalizedTasks = tasks.map((task, index) => normalizeTask(task, `tasks[${index}]`))
  if (new Set(normalizedTasks.map(t => t.id)).size !== tasks.length) fail('duplicate task id')
  const sharedPrerequisite = normalizePrerequisite(prerequisite)
  if (sharedPrerequisite && normalizedTasks.some(task => task.id === sharedPrerequisite.id)) {
    fail('the prerequisite task id must not also be a trial task')
  }

  // E2 is a session-reuse experiment. A plain single-turn task cannot tell us
  // whether reusing a session helps, so its manifest is refused instead of
  // being retro-labelled as a session-reuse result.
  if (String(group).toUpperCase() === 'E2') {
    for (const task of normalizedTasks) {
      if (task.kind !== 'chain') {
        fail(`experimentGroup E2 task "${task.id}" must be a chain (kind "chain" + ordered "chain"); a single-turn task is not a session-reuse experiment`)
      }
    }
  }

  const rng = random(seed)
  const blocks = shuffle(normalizedTasks.flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ task, repeat }))), rng)
  const assignments = blocks.flatMap(({ task, repeat }) => shuffle(armList, rng).map(arm => ({
    trialId: digest([experimentId, task.id, task.revision, repeat, arm]).slice(0, 24),
    taskId: task.id,
    repeat,
    strategy: arm,
    ...(explicitArms ? { arm } : {}),
  })))
  const prerequisiteTrials = sharedPrerequisite
    ? armList.map(arm => ({
      trialId: digest([experimentId, sharedPrerequisite.id, sharedPrerequisite.revision, 'prerequisite', arm]).slice(0, 24),
      taskId: sharedPrerequisite.id,
      repeat: null,
      strategy: arm,
      ...(explicitArms ? { arm } : {}),
      role: 'prerequisite',
      countedAsTrial: false,
    }))
    : undefined

  const manifest = {
    schemaVersion: STRATEGY_EVAL_VERSION,
    experimentId,
    ...(group ? { experimentGroup: group } : {}),
    dataKind,
    split,
    allocation: 'blocked-task-repeat/fisher-yates-xorshift32@1',
    seed: String(seed),
    repeats,
    ...(explicitArms ? { arms: armList } : {}),
    ...(Object.keys(fusedExecution).length ? { armExecution: fusedExecution } : {}),
    tasks: normalizedTasks,
    ...(sharedPrerequisite ? { prerequisite: sharedPrerequisite } : {}),
    conditions: cloneJson(conditions, 'conditions'),
    conditionsDigest: digest(conditions),
    policyVersions: cloneJson(policyVersions, 'policyVersions'),
    optimizerCostUsd: cloneJson(optimizerCostUsd, 'optimizerCostUsd'),
    promotion: promotionConfig(promotion, armList),
    assignments,
    ...(prerequisiteTrials ? { prerequisiteTrials } : {}),
  }
  return { ...manifest, digest: manifestDigest(manifest) }
}

function validateManifest(m) {
  if (m?.schemaVersion !== STRATEGY_EVAL_VERSION || m.digest !== manifestDigest(m)) fail('manifest version/digest mismatch')
  const regenerated = createStrategyExperiment(m)
  if (regenerated.digest !== m.digest) fail('manifest is not a balanced, reproducible allocation')
}

function validateRunUsage(usage, label) {
  if (!usage || typeof usage !== 'object') fail(`${label} usage is required; use explicit null for unknown buckets`)
  for (const key of BUCKETS) if (usage[key] !== null) number(usage[key], `${label} usage.${key}`, { integer: true })
}

function validatePrerequisiteRecord(record, label) {
  if (!record || typeof record !== 'object') fail(`${label} prerequisite must be an object`)
  if (!TERMINAL.includes(record.execution)) fail(`${label} prerequisite execution is invalid`)
  if (record.calls !== null && record.calls !== undefined) number(record.calls, `${label} prerequisite calls`, { integer: true })
  if (record.costUsd !== null && record.costUsd !== undefined) {
    number(record.costUsd, `${label} prerequisite costUsd`)
    if (!['billed', 'estimated'].includes(record.costBasis)) fail(`${label} prerequisite known cost requires billed/estimated basis`)
  }
  if (record.usage !== undefined && record.usage !== null) validateRunUsage(record.usage, `${label} prerequisite`)
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
  // `calls` is nullable on purpose: an unobserved request count is unknown, not 0.
  if (run.calls === undefined) fail('calls is required; use explicit null when unknown')
  if (run.calls !== null) number(run.calls, 'calls', { integer: true })
  for (const key of ['attempts', 'humanInterventions']) number(run[key], key, { integer: true })
  if (run.elapsedMs !== null || run.execution !== 'pending') number(run.elapsedMs, 'elapsedMs')
  validateRunUsage(run.usage, 'run')
  if (run.costUsd !== null) {
    number(run.costUsd, 'costUsd')
    if (!['billed', 'estimated'].includes(run.costBasis)) fail('known cost requires billed/estimated basis')
    string(run.costVersion, 'costVersion')
  } else if (run.costBasis !== 'unknown') fail('unknown cost requires unknown basis')
  if (!['complete', 'partial', 'unknown'].includes(run.collectionCoverage)) fail('invalid collectionCoverage')
  if (run.prerequisite !== undefined && run.prerequisite !== null) validatePrerequisiteRecord(run.prerequisite, `run ${run.trialId}`)
}

export function empiricalQuantile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q, index = Math.floor(position)
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (position - index)
}
const passed = r => r?.execution === 'completed' && r.acceptance === 'passed'

function noUsage() {
  return Object.fromEntries(BUCKETS.map((key) => [key, null]))
}

function firstAssignmentFor(manifest, arm) {
  return (manifest.assignments ?? []).find((assignment) => assignment?.strategy === arm) ?? null
}

/**
 * Resolve the arm-level shared prerequisite.
 *
 * The collector attaches one shared execution to the arm's FIRST frozen
 * assignment (the carrier) and leaves every other run `prerequisite: null`.
 * The evaluator therefore reads the record once per arm, not once per run:
 * requiring every run to carry it would either lose the arm total or charge the
 * shared run again for each task. A missing carrier, a record on a non-carrier,
 * a duplicate, a wrong arm/task or a non-terminal run makes the arm's
 * prerequisite unknown (and the review blocked); it is never filled with 0.
 */
function prerequisiteForArm({ manifest, arm, rows }) {
  const declared = Boolean(manifest?.prerequisite)
  const carrier = firstAssignmentFor(manifest, arm)
  const carrierTrialId = typeof carrier?.trialId === 'string' ? carrier.trialId : null
  const base = {
    declared,
    carrierTrialId,
    carrierPresent: false,
    recorded: 0,
    duplicateRecords: 0,
    unexpected: false,
    wrongArm: false,
    wrongTask: false,
    countedAsTrial: false,
    terminal: false,
    valid: false,
    calls: null,
    costUsd: null,
    usage: noUsage(),
  }
  if (!declared) {
    const unexpected = rows.filter((row) => row?.prerequisite !== undefined && row?.prerequisite !== null).length
    return { ...base, recorded: unexpected, duplicateRecords: unexpected, unexpected: unexpected > 0 }
  }

  const carrierRow = carrierTrialId === null ? null : rows.find((row) => row.trialId === carrierTrialId) ?? null
  const record = carrierRow?.prerequisite ?? null
  const duplicateRecords = rows.filter((row) => row.trialId !== carrierTrialId
    && row?.prerequisite !== undefined && row?.prerequisite !== null).length
  if (!record) {
    return { ...base, carrierPresent: carrierRow !== null, duplicateRecords,
      unexpected: duplicateRecords > 0 }
  }

  const wrongArm = typeof record.arm === 'string' && record.arm !== arm
  const wrongTask = typeof record.taskId === 'string' && record.taskId !== manifest.prerequisite.id
  const countedAsTrial = record.countedAsTrial === true
  const terminal = TERMINAL.includes(record.execution)
  const costKnown = Number.isFinite(record.costUsd) && record.costUsd >= 0
  const callsKnown = Number.isSafeInteger(record.calls) && record.calls >= 0
  const usage = noUsage()
  for (const key of BUCKETS) {
    if (Number.isSafeInteger(record?.usage?.[key]) && record.usage[key] >= 0) usage[key] = record.usage[key]
  }
  const valid = !wrongArm && !wrongTask && !countedAsTrial && terminal
    && duplicateRecords === 0 && costKnown && callsKnown
  return {
    ...base,
    carrierPresent: true,
    recorded: valid ? 1 : 0,
    duplicateRecords,
    unexpected: duplicateRecords > 0,
    wrongArm,
    wrongTask,
    countedAsTrial,
    terminal,
    valid,
    calls: valid ? record.calls : null,
    costUsd: valid ? record.costUsd : null,
    usage: valid ? usage : noUsage(),
  }
}

function prerequisiteRollup(prerequisiteByArm, arms) {
  const entries = arms.map((arm) => ({ arm, ...prerequisiteByArm[arm] }))
  const validEntries = entries.filter((entry) => entry.valid)
  const complete = entries.length > 0 && validEntries.length === entries.length
  const usage = Object.fromEntries(BUCKETS.map((key) => [key,
    complete && validEntries.every((entry) => Number.isSafeInteger(entry.usage[key]))
      ? validEntries.reduce((sum, entry) => sum + entry.usage[key], 0)
      : null,
  ]))
  return {
    expected: entries.length,
    recorded: validEntries.length,
    missing: entries.length - validEntries.length,
    duplicateRecords: entries.reduce((sum, entry) => sum + (entry.duplicateRecords ?? 0), 0),
    wrongArm: entries.filter((entry) => entry.wrongArm).map((entry) => entry.arm),
    wrongTask: entries.filter((entry) => entry.wrongTask).map((entry) => entry.arm),
    calls: complete ? validEntries.reduce((sum, entry) => sum + entry.calls, 0) : null,
    costUsd: complete ? validEntries.reduce((sum, entry) => sum + entry.costUsd, 0) : null,
    usage,
    arms: entries,
  }
}

function summarize(assignments, runs, m, arm) {
  const expected = assignments.filter(a => a.strategy === arm)
  const rows = expected.map(a => runs.get(a.trialId)).filter(Boolean)
  const successes = rows.filter(passed).length
  const costComplete = rows.length === expected.length && rows.every(r => r.costUsd !== null && TERMINAL.includes(r.execution))
  const knownOperatingCostUsd = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const overhead = m.optimizerCostUsd[arm]
  const prerequisite = prerequisiteForArm({ manifest: m, arm, rows })
  const prerequisiteCostKnown = !prerequisite.declared
    || (prerequisite.valid && Number.isFinite(prerequisite.costUsd))
  const totalCostUsd = costComplete && overhead !== null && prerequisiteCostKnown
    ? knownOperatingCostUsd + (prerequisite.declared ? prerequisite.costUsd : 0) + overhead
    : null
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
  const callsComplete = rows.length === expected.length && rows.every(r => Number.isSafeInteger(r.calls))
  const trialCalls = callsComplete ? rows.reduce((n, r) => n + r.calls, 0) : null
  const prerequisiteCallsKnown = !prerequisite.declared || (prerequisite.valid && Number.isSafeInteger(prerequisite.calls))
  const calls = prerequisite.declared
    ? (trialCalls === null || !prerequisiteCallsKnown ? null : trialCalls + prerequisite.calls)
    : trialCalls
  return { arm, assignedTrials: expected.length, recordedTrials: rows.length, missingTrials: expected.length - rows.length,
    pendingTrials: rows.filter(r => r.execution === 'pending').length,
    passedTrials: successes, successRate: successes / expected.length,
    taskReliablePasses: reliableTasks, taskCount: m.tasks.length,
    outcomeCounts: Object.fromEntries([...TERMINAL, 'pending'].map(k => [k, rows.filter(r => r.execution === k).length])),
    calls, trialCalls, callsKnown: callsComplete,
    attempts: rows.reduce((n, r) => n + r.attempts, 0),
    humanInterventions: rows.reduce((n, r) => n + (Number.isSafeInteger(r.humanInterventions) ? r.humanInterventions : 0), 0),
    criticalRegressions: rows.filter(r => r.criticalRegression).length,
    falseCompletions: rows.filter(r => r.falseCompletion).length,
    knownOperatingCostUsd, costComplete, optimizerCostUsd: overhead, totalCostUsd,
    costPerAcceptedTaskUsd: totalCostUsd !== null && successes > 0 ? totalCostUsd / successes : null,
    costReportingTrials: rows.filter(r => r.costUsd !== null).length,
    unknownCostTrials: rows.filter(r => r.costUsd === null).length,
    unknownCost: !costComplete || overhead === null || !prerequisiteCostKnown || prerequisite.unexpected,
    prerequisite,
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
  // The shared prerequisite is an ARM-level execution: it is priced once for
  // the arm, never once per selected task. The per-arm summary already carries
  // it once (or null when the carrier is missing/unknown).
  const prerequisiteCostFor = (strategy) => {
    if (!m.prerequisite) return 0
    const row = summaries[strategy].prerequisite
    return row.valid && Number.isFinite(row.costUsd) ? row.costUsd : null
  }
  const prerequisiteCostsKnown = !m.prerequisite
    || (prerequisiteCostFor(candidate) !== null && prerequisiteCostFor(reference) !== null)
  const costsKnown = complete && relevant.every(a => runs.get(a.trialId).costUsd !== null)
    && prerequisiteCostsKnown
    && m.optimizerCostUsd[candidate] !== null && m.optimizerCostUsd[reference] !== null
  const costSamples = [], timeSamples = [], rng = random(`${m.seed}/${candidate}/${reference}`)
  if (complete) {
    for (let i = 0; i < iterations; i++) {
      const selected = Array.from({ length: taskRows.length }, () => taskRows[Math.floor(rng() * taskRows.length)])
      const metrics = Object.fromEntries([candidate, reference].map(strategy => {
        const rs = selected.flatMap(task => task[strategy]), count = rs.filter(passed).length
        return [strategy, { cost: costsKnown && count
          ? (rs.reduce((n, r) => n + r.costUsd, 0) + prerequisiteCostFor(strategy) + m.optimizerCostUsd[strategy]) / count
          : null,
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
  const arms = experimentArms(manifest)
  const assignments = new Map(manifest.assignments.map(a => [a.trialId, a]))
  const runs = new Map()
  for (const run of records) {
    const assignment = assignments.get(run?.trialId)
    if (!assignment) fail('unassigned trial; freeze all trials before evaluation')
    if (runs.has(run.trialId)) fail('duplicate trial; aggregate attempts once before evaluation')
    validateRun(run, assignment, manifest)
    runs.set(run.trialId, run)
  }
  const summaries = Object.fromEntries(arms.map(s => [s, summarize(manifest.assignments, runs, manifest, s)]))
  const comparisons = arms.filter(s => s !== manifest.promotion.reference)
    .map(s => compare(manifest, runs, summaries, s, manifest.promotion.reference, bootstrapIterations))
  const p = manifest.promotion, primary = comparisons.find(c => c.candidate === p.candidate)
  const allRuns = [...runs.values()]
  const primaryRuns = manifest.assignments.filter(a => [p.candidate, p.reference].includes(a.strategy)).map(a => runs.get(a.trialId)).filter(Boolean)
  const optimizerUnknownArms = arms.filter(arm => manifest.optimizerCostUsd[arm] === null || manifest.optimizerCostUsd[arm] === undefined)
  const prerequisite = manifest.prerequisite
    ? {
      taskId: manifest.prerequisite.id,
      revision: manifest.prerequisite.revision,
      ...prerequisiteRollup(Object.fromEntries(arms.map((arm) => [arm, summaries[arm].prerequisite])), arms),
    }
    : null
  const prerequisiteInvalid = Boolean(prerequisite && (prerequisite.costUsd === null
    || prerequisite.calls === null
    || prerequisite.missing > 0
    || prerequisite.duplicateRecords > 0
    || prerequisite.wrongArm.length > 0
    || prerequisite.wrongTask.length > 0))
  const unexpectedPrerequisite = !manifest.prerequisite
    && allRuns.some((run) => run.prerequisite !== undefined && run.prerequisite !== null)
  const unknownCost = {
    trials: allRuns.filter(r => r.costUsd === null).length,
    optimizerArms: optimizerUnknownArms,
    prerequisiteRuns: prerequisite ? prerequisite.recorded : 0,
    prerequisite: Boolean(manifest.prerequisite && prerequisiteInvalid),
    prerequisiteUnattributed: unexpectedPrerequisite,
    any: allRuns.some(r => r.costUsd === null) || optimizerUnknownArms.length > 0
      || prerequisiteInvalid || unexpectedPrerequisite,
  }
  const blockers = []
  const addBlocker = (reason) => { if (!blockers.includes(reason)) blockers.push(reason) }
  if (manifest.dataKind !== 'live') addBlocker('non-live data cannot support promotion')
  if (manifest.split !== 'holdout') addBlocker('promotion requires an untouched holdout experiment')
  if (manifest.assignments.some(a => {
    const r = runs.get(a.trialId)
    return !r || !TERMINAL.includes(r.execution) || !['passed', 'failed'].includes(r.acceptance)
  })) addBlocker('missing/pending/ungraded assigned trials')
  if (manifest.tasks.length < p.minTasks || manifest.repeats < p.minRepeats) addBlocker('insufficient predeclared tasks/repeats')
  if (allRuns.some(r => !r.strategyApplied)) addBlocker('assigned strategy not applied (kept in intention-to-treat summaries)')
  if (allRuns.some(r => r.collectionCoverage !== 'complete')) addBlocker('incomplete collection coverage')
  if (allRuns.some(r => ['passed', 'failed'].includes(r.acceptance) && !['external-tests', 'human', 'runtime-terminal'].includes(r.evidenceKind))) addBlocker('acceptance relies on model-only/unknown evidence')
  if (unknownCost.any) addBlocker('unknown trial/optimizer/prerequisite cost; no settled total may be reported')
  if (prerequisiteInvalid) addBlocker('shared prerequisite is missing, duplicated, non-terminal, or attributed to the wrong arm/task')
  if (unexpectedPrerequisite) addBlocker('prerequisite run(s) were supplied but the frozen manifest declares no shared prerequisite')
  if (new Set(primaryRuns.filter(r => r.costUsd !== null).map(r => `${r.costBasis}/${r.costVersion}`)).size > 1) addBlocker('incomparable cost bases/versions')
  if (summaries[p.candidate].humanInterventions > summaries[p.reference].humanInterventions) addBlocker('candidate received more human assistance')
  const candidateRows = manifest.assignments.filter(a => a.strategy === p.candidate).map(a => runs.get(a.trialId)).filter(Boolean)
  const regression = candidateRows.some(r => r.criticalRegression || r.falseCompletion)
  const evidenceReasons = []
  if (primary.costPerAcceptedReduction.low === null || primary.costPerAcceptedReduction.low < p.minCostReduction) evidenceReasons.push('cost reduction lower bound has not reached target')
  if (primary.taskReliabilityDifference.low < -p.maxQualityLoss) evidenceReasons.push('quality non-inferiority not established')
  if (primary.p50ElapsedReduction.low === null || primary.p50ElapsedReduction.low < -p.maxLatencyIncrease) evidenceReasons.push('latency constraint not established')
  const status = regression ? 'rejected' : blockers.length ? 'blocked' : evidenceReasons.length ? 'insufficient-evidence' : 'candidate-for-review'
  return { schemaVersion: STRATEGY_EVAL_VERSION, experimentId: manifest.experimentId, experimentDigest: manifest.digest,
    experimentGroup: manifest.experimentGroup ?? null,
    group: manifest.experimentGroup ?? null,
    arms,
    dataKind: manifest.dataKind, split: manifest.split,
    conditions: manifest.conditions, policyVersions: manifest.policyVersions, seed: manifest.seed,
    provenance: manifest.tasks.map(task => ({ taskId: task.id, revision: task.revision, kind: task.kind ?? 'single-turn',
      ...(task.chain ? { chain: task.chain } : {}),
      ...(task.repo ? { repo: task.repo } : {}),
      ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
      ...(task.provenance !== undefined ? { provenance: task.provenance } : {}) })),
    prerequisite,
    unknownCost,
    summaries, comparisons,
    review: { status, candidate: p.candidate, reference: p.reference, automaticActivation: false,
      experimentGroup: manifest.experimentGroup ?? null,
      reasons: [...(regression ? ['candidate introduced critical regression/false completion'] : []), ...blockers, ...evidenceReasons] },
    limitations: ['Offline evaluator only; runtime collection, dispatch, grading, candidate generation and canary/rollback are not installed by this module.',
      'Digests check declared record consistency; they do not attest that the runtime or grader reported truthfully.',
      'All costs include parent/children/retries/compaction/grading; optimizer and prerequisite costs are added separately and must not be omitted. Unknown cost is never rendered as $0.',
      'Do not repeatedly inspect or optimize against holdout results and then reuse the same holdout as fresh evidence.'] }
}
