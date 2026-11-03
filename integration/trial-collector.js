/**
 * Trial collection for frozen session-strategy experiments (R06).
 *
 * One *trial* is one whole parent task — every child, retry, compaction,
 * review, verification and recovery attempt — from requirement to final
 * acceptance or deadline. This module turns the records OMC already keeps
 * (execution store, usage ledger, task receipts) into one record per trial in
 * the shape `evaluateStrategyExperiment` consumes, and refuses to fill gaps.
 *
 * What this module deliberately does NOT do:
 *   - no model calls, no dispatch, no network, no writes, no system clock;
 *   - no invented values: a number nobody observed is exported as null and
 *     named in `incomplete`, never as 0 or as an estimate;
 *   - no retro-labelling: a manifest that lacks randomisation/freeze metadata
 *     is reported as observational, and observational data is never tagged as
 *     a randomised experiment;
 *   - no truth attestation: this collector proves *consistency* with the
 *     frozen allocation, not that a runtime, ledger or grader told the truth.
 *
 * Field mapping to `integration/strategy-eval.js` (schema version 1):
 *
 *   evaluator field       source in this module
 *   --------------------  ------------------------------------------------
 *   schemaVersion         STRATEGY_EVAL_VERSION (both are 1; `collectorVersion`
 *                         records which exporter wrote the record)
 *   experimentDigest      manifest.digest
 *   conditionsDigest      manifest.conditionsDigest
 *   dataKind              manifest.dataKind
 *   trialId               the frozen assignment row (`assignment`), never derived
 *   policyVersion         manifest.policyVersions[assignment.strategy]
 *   strategyApplied       true only when actualActions were recorded AND none
 *                         of them contradict the assigned strategy
 *   execution             the execution store's terminal state; `unknown`
 *                         (no terminal event) is exported as `pending`, the
 *                         evaluator's only non-terminal state, so an unobserved
 *                         outcome stays in the denominator and cannot pass
 *   status                the same state in collector vocabulary
 *                         (completed|failed|cancelled|unknown) — extra field
 *   acceptance            the caller's/grader's verdict, but only when it has
 *                         external evidence; otherwise `unknown`
 *   evidenceKind          caller-supplied, or `runtime-terminal` for a real
 *                         non-completed terminal event (never for success)
 *   evidenceRef           caller-supplied pointer to the acceptance artefact
 *   criticalRegression    explicit detector/grader result; defaults false
 *   falseCompletion       explicit detector/grader result; defaults false
 *   collectionCoverage    'complete' only if every usage bucket, the cost, the
 *                         call/attempt counts, the status and the model were
 *                         observed; 'partial' when something was
 *   calls                 booked usage-ledger entries for this task (one per
 *                         model response attempt that produced a booking)
 *   attempts              execution-store attempt count (retries are real cost)
 *   humanInterventions    interventions.length (manual help)
 *   elapsedMs             endedAt - startedAt from the caller, never a guess
 *   usage                 4 buckets summed over the task; null unless EVERY
 *                         booking reported that bucket (a partial sum would be
 *                         an undercount presented as a total)
 *   costUsd / costBasis   ledger cost total, basis `estimated` because the
 *   / costVersion         ledger stores a computed amount plus its price source,
 *                         not a provider invoice; a missing price source makes
 *                         the amount unknown rather than assumed
 *
 * Known limits, stated rather than hidden:
 *   - `calls` counts bookings, so a request that failed before producing a
 *     usage event is not in the count (attempts cover the retry side);
 *   - the execution store has no `timeout` state, so a deadline that killed a
 *     run can only be recorded as what the store reported (usually `failed` or
 *     `cancelled` with a stopReason this module copies into `notes` via the
 *     caller's interventions/actualActions; it is not inferred);
 *   - a mixed-model or mixed-price trial is exported but flagged, because the
 *     evaluator's comparison would otherwise silently mix conditions;
 *   - this module cannot observe a human edit to the working tree; manual help
 *     is only what the caller passes in `interventions`.
 */

import {
  SESSION_STRATEGIES,
  STRATEGY_EVAL_VERSION,
  createStrategyExperiment,
} from './strategy-eval.js'

export const TRIAL_COLLECTOR_VERSION = 1

const BUCKETS = Object.freeze([
  'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
])
const TERMINAL = Object.freeze(['completed', 'failed', 'timeout', 'cancelled'])
const ACCEPTANCE_STATES = Object.freeze(['pending', 'passed', 'failed', 'unknown'])
const EVIDENCE_KINDS = Object.freeze([
  'external-tests', 'human', 'runtime-terminal', 'llm-only', 'unknown',
])
const COVERAGE = Object.freeze(['complete', 'partial', 'unknown'])

/**
 * Recorded action vocabulary. It exists so a contradiction can be *shown*
 * instead of judged by opinion: a `reuse_compact` trial that opened a fresh
 * child really did not do what was assigned. Actions outside this list are
 * recorded verbatim and never used to claim a mismatch, because an unknown
 * spelling is not evidence of a violation.
 */
export const STRATEGY_ACTIONS = Object.freeze({
  reuse: Object.freeze(['reuse_parent', 'reuse_session', 'continue_same_session', 'compact_context', 'shrink_context', 'resume_child']),
  fresh: Object.freeze(['new_child', 'fresh_handoff', 'new_session', 'handoff_brief', 'restart_session']),
  neutral: Object.freeze(['rule_decision', 'no_action']),
})
const KNOWN_ACTIONS = Object.freeze([
  ...STRATEGY_ACTIONS.reuse, ...STRATEGY_ACTIONS.fresh, ...STRATEGY_ACTIONS.neutral,
])

function parseInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function unique(values) {
  return [...new Set(values)]
}

/**
 * Resolve the frozen assignment row. Guessing is not allowed: an ambiguous
 * (task, strategy) pair with several repeats has to be resolved by the caller
 * passing the explicit assignment row.
 */
function resolveAssignment({ assignment, manifest, taskId, strategy }) {
  if (assignment && typeof assignment === 'object') {
    if (typeof assignment.trialId !== 'string' || assignment.trialId.trim() === '') {
      return { assignment: null, problem: 'the supplied assignment row has no trialId, so the trial cannot be matched to the frozen plan' }
    }
    // The runtime parent task id and the frozen benchmark task id are two
    // different identifiers: the allocation names a benchmark task, while
    // `taskId` names the concrete parent task that ran it. Both are exported;
    // neither is rewritten into the other.
    const note = taskId && assignment.taskId !== taskId
      ? `runtime task ${taskId} ran frozen benchmark task ${assignment.taskId}; both ids are recorded`
      : null
    return { assignment, note }
  }
  const rows = Array.isArray(manifest?.assignments) ? manifest.assignments : []
  if (!rows.length) return { assignment: null, problem: 'no assignment was supplied and the manifest carries no frozen allocation' }
  const matches = rows.filter((row) => row?.trialId
    && (!taskId || row.taskId === taskId)
    && (!strategy || row.strategy === strategy))
  if (matches.length === 1) return { assignment: matches[0] }
  if (matches.length === 0) return { assignment: null, problem: 'no frozen assignment matches this task/strategy' }
  return {
    assignment: null,
    problem: `the frozen allocation holds ${matches.length} assignments for this task/strategy; pass the explicit assignment row so the repeat is not guessed`,
  }
}

function contradictionsFor(strategy, actions) {
  if (strategy === 'reuse_compact') return actions.filter((action) => STRATEGY_ACTIONS.fresh.includes(action))
  if (strategy === 'fresh_handoff') return actions.filter((action) => STRATEGY_ACTIONS.reuse.includes(action))
  // `adaptive` is allowed to choose any documented action, so a single action
  // can never contradict it; only a missing decision record can.
  return []
}

/**
 * Collect one finished parent task into a trial record.
 *
 * @returns {{trial: object, incomplete: string[], notes: string[]}}
 *   `incomplete` lists every field the frozen manifest requires that could not
 *   be observed. It is not an error list: it is the honest reason a trial
 *   cannot support promotion.
 */
export function collectTrial({
  parentId = null,
  taskId = null,
  assignment = null,
  strategy = null,
  usageLedger = null,
  executionStore = null,
  tasks = null,
  startedAt = null,
  endedAt = null,
  interventions = [],
  acceptance = null,
  actualActions = [],
  manifest = null,
} = {}) {
  const incomplete = []
  const notes = []

  const parent = typeof parentId === 'string' && parentId.trim() !== '' ? parentId : null
  const task = typeof taskId === 'string' && taskId.trim() !== '' ? taskId : null
  if (!parent) {
    incomplete.push('parentId')
    notes.push('parentId is missing, so no usage entry can be attributed to this trial and every usage/cost field stays unknown')
  }
  if (!task) {
    incomplete.push('taskId')
    notes.push('taskId is missing, so the execution store and the ledger cannot be read for this trial')
  }

  const resolved = resolveAssignment({ assignment, manifest, taskId: task, strategy })
  if (resolved.problem) {
    incomplete.push('assignment')
    notes.push(resolved.problem)
  }
  if (resolved.note) notes.push(resolved.note)
  const frozen = resolved.assignment
  const assignedStrategy = frozen?.strategy && SESSION_STRATEGIES.includes(frozen.strategy)
    ? frozen.strategy
    : (SESSION_STRATEGIES.includes(strategy) ? strategy : null)
  if (!assignedStrategy) {
    incomplete.push('strategy')
    notes.push('no assigned strategy is known; the trial cannot be attributed to one of the three frozen arms')
  } else if (strategy && frozen?.strategy && strategy !== frozen.strategy) {
    notes.push(`the caller passed strategy "${strategy}" but the frozen assignment is "${frozen.strategy}"; the frozen assignment wins`)
  }

  const trialId = typeof frozen?.trialId === 'string' ? frozen.trialId : null
  const repeat = Number.isSafeInteger(frozen?.repeat) ? frozen.repeat : null
  const benchmarkTaskId = typeof frozen?.taskId === 'string' ? frozen.taskId : null
  const policyVersion = assignedStrategy ? (manifest?.policyVersions?.[assignedStrategy] ?? null) : null
  const experimentDigest = typeof manifest?.digest === 'string' ? manifest.digest : null
  const conditionsDigest = typeof manifest?.conditionsDigest === 'string' ? manifest.conditionsDigest : null
  const dataKind = typeof manifest?.dataKind === 'string' ? manifest.dataKind : null
  if (!trialId) {
    incomplete.push('trialId')
    notes.push('no frozen trialId is known; the trial cannot be matched back to the allocation')
  }
  if (!policyVersion) {
    incomplete.push('policyVersion')
    notes.push('the manifest freezes no policy version for this strategy; an unfrozen policy cannot be compared')
  }
  if (!experimentDigest) {
    incomplete.push('experimentDigest')
    notes.push('no frozen manifest digest was supplied; the trial cannot be tied to one experiment')
  }
  if (!conditionsDigest) {
    incomplete.push('conditionsDigest')
    notes.push('no conditions digest was supplied; model/toolset/budget conditions are unverified')
  }
  if (!dataKind) {
    incomplete.push('dataKind')
    notes.push('no dataKind was supplied; live/synthetic/replay provenance is unknown')
  }
  if (repeat === null) {
    incomplete.push('repeat')
    notes.push('the frozen assignment carries no repeat index; blocking is impossible to verify')
  }
  if (!benchmarkTaskId) {
    incomplete.push('assignment.taskId')
    notes.push('the frozen assignment carries no benchmark task id, so this trial cannot be grouped back to a benchmark task')
  }

  // --- execution: the store is the only source of truth for the terminal state.
  let executionView = null
  if (!executionStore) {
    notes.push('no execution store was supplied, so the terminal execution state cannot be observed')
  } else if (typeof executionStore.read !== 'function') {
    notes.push('the supplied execution store has no read(); the terminal execution state cannot be observed')
  } else if (task) {
    try {
      executionView = executionStore.read(task)
    } catch (error) {
      notes.push(`the execution store could not be read (${error?.code ?? 'error'}): ${error?.message ?? error}; the trial stays unknown`)
    }
  }
  if (task && !executionView && executionStore && typeof executionStore.read === 'function') {
    notes.push('the execution store holds no record for this task; a missing record is not a completed run')
  }
  const rawExecution = typeof executionView?.execution === 'string' ? executionView.execution : 'unknown'
  const status = ['completed', 'failed', 'cancelled'].includes(rawExecution) ? rawExecution : 'unknown'
  if (status === 'unknown') {
    incomplete.push('status')
    notes.push(`the execution store reports no terminal event (raw state "${rawExecution}"); the trial is exported as unknown, never as completed`)
  }
  // The evaluator only accepts completed|failed|timeout|cancelled|pending. An
  // unobserved outcome is exported as `pending` (its only non-terminal state)
  // and stays in every denominator, so it can never be counted as success.
  const execution = status === 'unknown' ? 'pending' : status

  const attempts = Array.isArray(executionView?.attempts) ? executionView.attempts.length : 0
  if (!attempts) {
    incomplete.push('attempts')
    notes.push('no attempt is recorded; 0 here means "no observed attempt", not a verified count of zero retries')
  }

  // --- task receipts are provenance only, never an execution verdict.
  let taskReceipt = null
  if (tasks && typeof tasks.read === 'function' && parent && task) {
    try {
      taskReceipt = tasks.read(parent, task)
    } catch (error) {
      notes.push(`the task registry could not be read (${error?.code ?? 'error'}): ${error?.message ?? error}; the execution store stays authoritative`)
    }
  }
  if (taskReceipt) {
    if (taskReceipt.parentId && taskReceipt.parentId !== parent) {
      notes.push(`the task receipt belongs to ${taskReceipt.parentId}, not ${parent}`)
    }
    if (taskReceipt.status === 'completed' && status !== 'completed') {
      notes.push('the task receipt says completed but the execution store has no terminal event; the trial stays unknown because a result body is not an execution verdict')
    }
  }

  // --- usage: four buckets, summed only when every booking reported the bucket.
  const usage = Object.fromEntries(BUCKETS.map((key) => [key, null]))
  let knownBuckets = 0
  let ledgerTotals = null
  let entries = []
  if (usageLedger && parent && task) {
    if (typeof usageLedger.totals === 'function') {
      try {
        ledgerTotals = usageLedger.totals({ parentId: parent, taskId: task })
      } catch (error) {
        notes.push(`the usage rollup failed (${error?.code ?? 'error'}): ${error?.message ?? error}; usage stays unknown`)
      }
    } else {
      notes.push('the supplied usage ledger has no totals(); usage stays unknown')
    }
    if (typeof usageLedger.entries === 'function') {
      try {
        const rows = usageLedger.entries({ parentId: parent, taskId: task })
        entries = Array.isArray(rows) ? rows : []
      } catch (error) {
        notes.push(`the usage entries could not be read (${error?.code ?? 'error'}): ${error?.message ?? error}`)
      }
    }
  }
  for (const key of BUCKETS) {
    const reported = entries.length > 0
      && entries.every((row) => Number.isSafeInteger(row?.usage?.[key]) && row.usage[key] >= 0)
    if (!reported) {
      incomplete.push(`usage.${key}`)
      continue
    }
    const rolledUp = ledgerTotals?.sums?.[key]
    usage[key] = Number.isSafeInteger(rolledUp)
      ? rolledUp
      : entries.reduce((sum, row) => sum + row.usage[key], 0)
    knownBuckets += 1
  }
  if (!entries.length) {
    notes.push('the usage ledger holds no booking for this trial; token buckets stay null (unknown), never 0 — a request that produced no booking is not a zero-token request')
  }

  // --- cost with its own source and version, or unknown (never estimated here).
  let costUsd = null
  let costBasis = 'unknown'
  let costVersion = null
  const costKnown = ledgerTotals?.costKnown === true
    && typeof ledgerTotals?.costUsd === 'number'
    && Number.isFinite(ledgerTotals.costUsd)
    && ledgerTotals.costUsd >= 0
  if (costKnown) {
    const sources = unique(entries
      .map((row) => row?.cost?.source)
      .filter((value) => typeof value === 'string' && value.trim() !== ''))
    if (!sources.length) {
      incomplete.push('costVersion')
      notes.push('the ledger books a cost without a price source/version; the amount is not exported because its basis cannot be identified')
    } else {
      costUsd = ledgerTotals.costUsd
      // The ledger records a computed amount plus the price source it used. It
      // is not a provider invoice, so the honest basis is `estimated`.
      costBasis = 'estimated'
      costVersion = sources.join('+')
      if (sources.length > 1) {
        notes.push(`this trial spans ${sources.length} price sources (${sources.join(', ')}); the evaluator treats mixed cost versions as incomparable`)
      }
    }
  } else {
    incomplete.push('costUsd')
    notes.push(ledgerTotals
      ? 'cost is unknown: at least one booking has no settled price, so no total is invented and no amount is assumed'
      : 'no usage rollup was available, so cost is unknown')
  }

  const calls = entries.length
  if (!calls) incomplete.push('calls')

  const models = unique(entries
    .map((row) => row?.route?.model)
    .filter((value) => typeof value === 'string' && value.trim() !== ''))
  const model = models.length === 1 ? models[0] : null
  if (models.length === 0) {
    incomplete.push('model')
    notes.push('no observed route model was booked for this trial; which model produced it cannot be verified')
  } else if (models.length > 1) {
    incomplete.push('model')
    notes.push(`the trial observed ${models.length} models (${models.join(', ')}); a mixed-model trial is not comparable under one frozen condition`)
  }

  // --- acceptance: separate from execution, and only believed with evidence.
  const requested = acceptance && typeof acceptance === 'object' ? acceptance : null
  const observedAcceptance = requested?.state ?? executionView?.acceptance?.state ?? 'unknown'
  let acceptanceState = ACCEPTANCE_STATES.includes(observedAcceptance) ? observedAcceptance : 'unknown'
  if (acceptanceState !== observedAcceptance) {
    notes.push(`acceptance state "${observedAcceptance}" is not one of ${ACCEPTANCE_STATES.join('/')}; recorded as unknown`)
  }
  if (!requested && (status === 'failed' || status === 'cancelled')
    && (acceptanceState === 'unknown' || acceptanceState === 'pending')) {
    // A real terminal failure is itself evidence that the work was not
    // delivered; the evaluator models exactly that as a failed acceptance with
    // runtime-terminal evidence. No grader claim is invented — the caller can
    // still supply its own verdict and evidence instead.
    acceptanceState = 'failed'
    notes.push(`no grader verdict was supplied, so the ${status} execution is recorded as a failed acceptance with runtime-terminal evidence (it does not prove any behaviour verdict)`)
  }
  let evidenceKind = typeof requested?.evidenceKind === 'string' ? requested.evidenceKind : null
  let evidenceRef = typeof requested?.evidenceRef === 'string' && requested.evidenceRef.trim() !== ''
    ? requested.evidenceRef
    : null
  const attemptRef = typeof executionView?.currentAttemptId === 'string' ? executionView.currentAttemptId : 'unknown-attempt'
  if (!evidenceKind) {
    if (acceptanceState === 'failed' && status !== 'completed') {
      // A real non-completed terminal event is itself evidence that execution
      // failed; it is never evidence that a completed task passed or failed.
      evidenceKind = 'runtime-terminal'
      evidenceRef = evidenceRef ?? `execution:${task ?? 'task'}/${attemptRef}:${status}`
    } else {
      evidenceKind = 'unknown'
    }
  }
  if (!EVIDENCE_KINDS.includes(evidenceKind)) {
    notes.push(`evidenceKind "${evidenceKind}" is not a known kind; exported as unknown`)
    evidenceKind = 'unknown'
  }
  if (evidenceKind === 'runtime-terminal' && !(status !== 'completed' && acceptanceState === 'failed')) {
    notes.push('runtime-terminal evidence can only establish that execution did not finish; it cannot prove a completed task passed or failed acceptance')
    evidenceKind = 'unknown'
  }
  if ((acceptanceState === 'passed' || acceptanceState === 'failed') && !evidenceRef) {
    notes.push(`the ${acceptanceState} verdict has no evidence reference; it is not exported because a model-only or unreferenced claim cannot enter the comparison (the observed verdict stays in observedAcceptance)`)
    incomplete.push('acceptance.evidence')
    acceptanceState = 'unknown'
  }
  if (acceptanceState === 'passed' && status !== 'completed') {
    notes.push('a non-completed execution cannot have passed acceptance; the verdict is exported as unknown')
    incomplete.push('acceptance')
    acceptanceState = 'unknown'
  }
  const criticalRegression = requested?.criticalRegression === true
  const falseCompletion = requested?.falseCompletion === true
  if (!requested) {
    notes.push('no grader verdict was supplied; acceptance stays unknown and the regression/false-completion flags stay false because nothing observed them')
  }

  const interventionList = Array.isArray(interventions) ? interventions : []
  if (!Array.isArray(interventions)) {
    notes.push('interventions was not an array; counted as no recorded manual help, which is not a claim that help was unnecessary')
  }
  const humanInterventions = interventionList.length

  // --- wall time strictly from the caller; no clock, no guessing.
  const startMs = parseInstant(startedAt)
  const endMs = parseInstant(endedAt)
  let elapsedMs = null
  if (startMs !== null && endMs !== null && endMs >= startMs) {
    elapsedMs = endMs - startMs
  } else {
    incomplete.push('elapsedMs')
    notes.push('wall time was not supplied as ordered startedAt/endedAt timestamps; the system clock is never used to guess a duration')
  }
  if (status === 'unknown' && elapsedMs !== null) {
    notes.push('the caller-supplied wall time is kept in startedAt/endedAt, but a non-terminal record exports elapsedMs null as the evaluator requires')
    elapsedMs = null
  }

  // --- what the strategy actually did, versus what was assigned.
  const actionList = (Array.isArray(actualActions) ? actualActions : [])
    .filter((action) => typeof action === 'string' && action.trim() !== '')
  if (!Array.isArray(actualActions)) notes.push('actualActions was not an array; nothing is claimed about what the strategy did')
  const contradictions = assignedStrategy ? contradictionsFor(assignedStrategy, actionList) : []
  const strategyMismatch = contradictions.length > 0
  const strategyApplied = actionList.length > 0 && !strategyMismatch
  if (!actionList.length) {
    notes.push('no actualActions were recorded; strategyApplied is false because application was not observed, not because it was contradicted')
  }
  if (strategyMismatch) {
    notes.push(`assigned ${assignedStrategy} but the recorded actions include ${contradictions.join(', ')}, which contradict it; strategyApplied stays false and the trial remains in the intention-to-treat denominator`)
  }
  const unknownActions = actionList.filter((action) => !KNOWN_ACTIONS.includes(action))
  if (unknownActions.length) {
    notes.push(`actions ${unknownActions.join(', ')} are outside the known action vocabulary; they are recorded verbatim and not judged`)
  }

  // --- coverage: 'complete' is an assertion, so it needs every input observed.
  const collectionGaps = ['status', 'calls', 'attempts', 'costUsd', 'costVersion', 'model',
    ...BUCKETS.map((key) => `usage.${key}`)]
  const missingCollection = incomplete.filter((field) => collectionGaps.includes(field))
  let collectionCoverage = 'unknown'
  if (missingCollection.length === 0 && knownBuckets === BUCKETS.length && costUsd !== null && status !== 'unknown') {
    collectionCoverage = 'complete'
  } else if (knownBuckets > 0 || costUsd !== null || entries.length > 0) {
    collectionCoverage = 'partial'
  }

  const dedupedIncomplete = unique(incomplete)
  const trial = {
    // Evaluator record schema (deliberately the same version number).
    schemaVersion: STRATEGY_EVAL_VERSION,
    collectorVersion: TRIAL_COLLECTOR_VERSION,
    experimentDigest,
    conditionsDigest,
    dataKind,
    trialId,
    policyVersion,
    strategyApplied,
    execution,
    acceptance: acceptanceState,
    evidenceKind,
    evidenceRef,
    criticalRegression,
    falseCompletion,
    collectionCoverage,
    calls,
    attempts,
    humanInterventions,
    elapsedMs,
    usage,
    costUsd,
    costBasis,
    costVersion,
    // Collector provenance (ignored by the evaluator, kept for audit).
    status,
    observedAcceptance: String(observedAcceptance),
    taskId: task,
    benchmarkTaskId,
    repeat,
    strategy: assignedStrategy,
    parentId: parent,
    startedAt: typeof startedAt === 'string' ? startedAt : null,
    endedAt: typeof endedAt === 'string' ? endedAt : null,
    interventions: interventionList,
    actualActions: actionList,
    strategyMismatch,
    model,
    models,
    taskReceipt: taskReceipt
      ? { id: taskReceipt.id ?? null, status: taskReceipt.status ?? null, harness: taskReceipt.harness ?? null, role: taskReceipt.role ?? null }
      : null,
    incomplete: dedupedIncomplete,
    notes,
  }

  return { trial, incomplete: dedupedIncomplete, notes }
}

/**
 * Is this manifest a frozen, randomised experiment — or an observational data
 * set someone would like to call one?
 *
 * A randomised label needs frozen, reproducible randomisation metadata: a
 * seed, a recorded allocation rule, a balanced task x repeat block covering all
 * three strategies once, a manifest digest, conditions and policy versions.
 * Anything less is reported as observational. This never throws: the caller
 * gets a verdict it can print.
 */
export function assertNotObservational({ manifest = null } = {}) {
  const reasons = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      verdict: 'observational',
      randomised: false,
      observational: true,
      taggedAs: 'observational',
      reasons: ['no manifest object was supplied, so no randomised allocation exists to verify'],
    }
  }
  const freezeKeys = ['schemaVersion', 'experimentId', 'dataKind', 'split', 'allocation', 'seed',
    'repeats', 'tasks', 'conditions', 'conditionsDigest', 'policyVersions', 'optimizerCostUsd',
    'promotion', 'assignments', 'digest']
  for (const key of freezeKeys) {
    if (manifest[key] === undefined || manifest[key] === null) reasons.push(`missing freeze metadata: ${key}`)
  }
  if (typeof manifest.seed !== 'string' || manifest.seed.trim() === '') {
    reasons.push('no seeded randomisation: the run order was not assigned at random and cannot be shown to be')
  }
  if (typeof manifest.allocation !== 'string' || !/random|shuffle|fisher|balanced|blocked/i.test(manifest.allocation)) {
    reasons.push('the allocation rule is missing or is not a seeded/balanced rule')
  }
  if (!Array.isArray(manifest.assignments) || !manifest.assignments.length) {
    reasons.push('no frozen assignment rows exist, so no trial was allocated before running')
  } else if (Array.isArray(manifest.tasks) && Number.isSafeInteger(manifest.repeats) && manifest.repeats >= 1) {
    let balanced = true
    for (const task of manifest.tasks) {
      for (let repeat = 0; repeat < manifest.repeats; repeat += 1) {
        const strategies = manifest.assignments
          .filter((row) => row?.taskId === task?.id && row?.repeat === repeat)
          .map((row) => row?.strategy)
        const complete = strategies.length === SESSION_STRATEGIES.length
          && SESSION_STRATEGIES.every((strategy) => strategies.includes(strategy))
        if (!complete) balanced = false
      }
    }
    if (!balanced) reasons.push('the allocation is not a balanced task x repeat block: at least one block lacks exactly one trial per strategy')
  }
  try {
    const regenerated = createStrategyExperiment(manifest)
    if (typeof manifest.digest !== 'string' || regenerated.digest !== manifest.digest) {
      reasons.push('the manifest digest does not reproduce the frozen allocation; the plan was edited after freezing or was never frozen')
    }
  } catch (error) {
    reasons.push(`the manifest cannot be re-derived by the allocation function: ${error?.message ?? error}`)
  }
  const randomised = reasons.length === 0
  return {
    verdict: randomised ? 'randomised' : 'observational',
    randomised,
    observational: !randomised,
    taggedAs: randomised ? 'randomised-controlled' : 'observational',
    reasons,
  }
}

/** Structural checks mirroring the evaluator's record validation, as problems. */
function shapeProblems(trial, trialId) {
  const problems = []
  const bad = (message) => problems.push(`trial ${trialId}: ${message}`)
  if (trial.schemaVersion !== STRATEGY_EVAL_VERSION) bad(`schemaVersion is ${trial.schemaVersion}, expected ${STRATEGY_EVAL_VERSION}`)
  if (!TERMINAL.includes(trial.execution) && trial.execution !== 'pending') bad(`execution "${trial.execution}" is not one of ${[...TERMINAL, 'pending'].join('/')}`)
  if (!ACCEPTANCE_STATES.includes(trial.acceptance)) bad(`acceptance "${trial.acceptance}" is not a valid verdict`)
  if (!EVIDENCE_KINDS.includes(trial.evidenceKind)) bad(`evidenceKind "${trial.evidenceKind}" is not valid`)
  for (const key of ['strategyApplied', 'criticalRegression', 'falseCompletion']) {
    if (typeof trial[key] !== 'boolean') bad(`${key} must be a boolean`)
  }
  if (!COVERAGE.includes(trial.collectionCoverage)) bad(`collectionCoverage "${trial.collectionCoverage}" is not valid`)
  for (const key of ['calls', 'attempts', 'humanInterventions']) {
    if (!Number.isSafeInteger(trial[key]) || trial[key] < 0) bad(`${key} must be a non-negative integer`)
  }
  if (trial.execution !== 'pending' && !Number.isFinite(trial.elapsedMs)) {
    bad('a terminal trial needs a finite elapsedMs from the caller-supplied wall time')
  } else if (trial.elapsedMs !== null && !Number.isFinite(trial.elapsedMs)) {
    bad('elapsedMs must be a finite number or null')
  }
  if (trial.acceptance === 'passed' && trial.execution !== 'completed') bad('a non-completed execution cannot pass acceptance')
  if ((trial.acceptance === 'passed' || trial.acceptance === 'failed')
    && !(typeof trial.evidenceRef === 'string' && trial.evidenceRef.trim() !== '')) {
    bad('a graded acceptance needs an evidenceRef')
  }
  if (trial.evidenceKind === 'runtime-terminal' && !(trial.execution !== 'completed' && trial.acceptance === 'failed')) {
    bad('runtime-terminal evidence can only establish execution failure')
  }
  if (!trial.usage || typeof trial.usage !== 'object') {
    bad('usage must be an object with explicit nulls for unknown buckets')
  } else {
    for (const key of BUCKETS) {
      const value = trial.usage[key]
      if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) {
        bad(`usage.${key} must be a non-negative integer or null`)
      }
    }
  }
  if (trial.costUsd === null) {
    if (trial.costBasis !== 'unknown') bad('unknown cost requires costBasis "unknown"')
  } else {
    if (!Number.isFinite(trial.costUsd) || trial.costUsd < 0) bad('costUsd must be a non-negative number or null')
    if (!['billed', 'estimated'].includes(trial.costBasis)) bad('a known cost needs costBasis "billed" or "estimated"')
    if (typeof trial.costVersion !== 'string' || trial.costVersion.trim() === '') bad('a known cost needs a costVersion (price source)')
  }
  if (trial.status === 'unknown' && trial.collectionCoverage === 'complete') {
    bad('collectionCoverage cannot be complete for a trial with no terminal execution event')
  }
  return problems
}

/**
 * Verify a collected set against the frozen manifest and order it for the
 * evaluator. Never throws on bad input: every mismatch becomes a problem, so
 * the caller can print exactly why a promotion run is refused.
 *
 * @returns {{complete: boolean, trials: object[], problems: string[], manifest: object|null, observational: boolean}}
 */
export function exportTrials({ manifest = null, collected = [] } = {}) {
  const problems = []

  const guard = assertNotObservational({ manifest })
  if (!guard.randomised) {
    problems.push(`manifest is observational, not a frozen randomised experiment: ${guard.reasons.join('; ')}`)
  }

  let frozen = null
  try {
    frozen = createStrategyExperiment(manifest)
  } catch (error) {
    problems.push(`manifest is invalid and cannot be re-derived: ${error?.message ?? error}`)
    return { complete: false, trials: [], problems: unique(problems), manifest: null, observational: guard.observational }
  }
  if (typeof manifest?.digest !== 'string' || manifest.digest !== frozen.digest) {
    problems.push('the manifest digest does not match the reproduced allocation; the frozen plan was edited after freezing')
  }

  const list = Array.isArray(collected) ? collected : []
  if (!Array.isArray(collected)) problems.push('collected trials were not an array; nothing was exported')

  const assignments = new Map(frozen.assignments.map((assignment) => [assignment.trialId, assignment]))
  const byTrial = new Map()
  const seenKeys = new Map()

  for (const [index, trial] of list.entries()) {
    const label = `trial #${index}`
    if (!trial || typeof trial !== 'object' || Array.isArray(trial)) {
      problems.push(`${label} is not a trial object`)
      continue
    }
    const trialId = typeof trial.trialId === 'string' && trial.trialId.trim() !== '' ? trial.trialId : null
    if (!trialId) {
      problems.push(`${label} has no trialId, so it cannot be matched to the frozen allocation`)
      continue
    }
    if (byTrial.has(trialId)) {
      problems.push(`duplicated trial ${trialId} (taskId ${trial.taskId ?? '?'}, repeat ${trial.repeat ?? '?'}); aggregate attempts once before evaluation instead of exporting two rows`)
      continue
    }
    const blockKey = `${trial.benchmarkTaskId ?? trial.taskId ?? '?'}|${trial.repeat ?? '?'}|${trial.strategy ?? '?'}`
    if (seenKeys.has(blockKey)) {
      problems.push(`duplicated (taskId, repeat, strategy) block ${blockKey} (trial ${trialId} and ${seenKeys.get(blockKey)}); one record per frozen assignment`)
    }
    seenKeys.set(blockKey, trialId)

    const assignment = assignments.get(trialId)
    if (!assignment) {
      problems.push(`unassigned trial ${trialId}; freeze all trials before evaluation`)
      continue
    }
    byTrial.set(trialId, trial)

    // `taskId` is the concrete runtime parent task; the frozen allocation names
    // the benchmark task, which the collector exports as `benchmarkTaskId`.
    const benchmarkTaskId = typeof trial.benchmarkTaskId === 'string' ? trial.benchmarkTaskId : null
    if (benchmarkTaskId !== null && benchmarkTaskId !== assignment.taskId) {
      problems.push(`trial ${trialId} ran frozen benchmark task ${benchmarkTaskId}, the allocation assigns ${assignment.taskId}`)
    }
    if (trial.repeat !== assignment.repeat) {
      problems.push(`trial ${trialId} reports repeat ${trial.repeat}, the frozen allocation assigns ${assignment.repeat}`)
    }
    if (trial.strategy !== assignment.strategy) {
      problems.push(`trial ${trialId} reports strategy ${trial.strategy}, the frozen allocation assigns ${assignment.strategy}; a record may not switch arms after the fact`)
    }
    if (trial.policyVersion !== frozen.policyVersions[assignment.strategy]) {
      problems.push(`trial ${trialId} reports policyVersion ${trial.policyVersion}, the frozen version is ${frozen.policyVersions[assignment.strategy]}`)
    }
    if (trial.experimentDigest !== frozen.digest) {
      problems.push(`trial ${trialId} was collected for experiment ${trial.experimentDigest ?? 'unknown'}, not ${frozen.digest}`)
    }
    if (trial.conditionsDigest !== frozen.conditionsDigest) {
      problems.push(`trial ${trialId} was collected under different conditions (${trial.conditionsDigest ?? 'unknown'} != ${frozen.conditionsDigest})`)
    }
    if (trial.dataKind !== frozen.dataKind) {
      problems.push(`trial ${trialId} reports dataKind ${trial.dataKind}, the frozen experiment is ${frozen.dataKind}`)
    }

    const models = Array.isArray(trial.models) && trial.models.length
      ? trial.models.filter((value) => typeof value === 'string' && value.trim() !== '')
      : (typeof trial.model === 'string' && trial.model.trim() !== '' ? [trial.model] : [])
    if (!models.length) {
      problems.push(`trial ${trialId} has no observed model; the frozen model condition cannot be confirmed`)
    }
    const offModel = models.filter((value) => value !== frozen.conditions.model)
    if (offModel.length) {
      problems.push(`trial ${trialId} ran on model ${offModel.join(', ')}, the frozen condition is ${frozen.conditions.model}; the trial is not comparable`)
    }
    if (models.length > 1) {
      problems.push(`trial ${trialId} mixed ${models.length} models (${models.join(', ')}); one trial must run under one frozen model`)
    }

    problems.push(...shapeProblems(trial, trialId))
  }

  for (const assignment of frozen.assignments) {
    if (!byTrial.has(assignment.trialId)) {
      problems.push(`missing trial for the frozen assignment ${assignment.trialId} (taskId ${assignment.taskId}, repeat ${assignment.repeat}, strategy ${assignment.strategy}); absent trials stay in the denominator and block promotion`)
    }
  }

  const trials = frozen.assignments
    .map((assignment) => byTrial.get(assignment.trialId))
    .filter(Boolean)

  return {
    complete: problems.length === 0 && trials.length === frozen.assignments.length,
    trials,
    problems: unique(problems),
    manifest: frozen,
    observational: guard.observational,
  }
}
