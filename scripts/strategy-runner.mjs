#!/usr/bin/env node
/**
 * Session-strategy trial runner (R06) — developer tooling, not runtime code.
 *
 * What it does without being asked to spend anything:
 *   --plan                 freeze/verify the allocation and print the exact
 *                          trial list (task x strategy x repeat, budget caps,
 *                          model, concurrency, deadline) as JSON; exits 0 and
 *                          writes nothing anywhere.
 *   --print-executor-contract
 *                          print the callback a host integration must supply.
 *
 * What it refuses to do:
 *   - `--execute` without BOTH `--max-usd <n>` and `--confirm-paid-experiment`,
 *     or with a manifest whose budget caps are missing → exact reason on stderr,
 *     exit 2, nothing created;
 *   - dispatch paid models itself. The default execution adapter throws
 *     OMC/TRIAL-NO-EXECUTOR, because this work package does not implement paid
 *     execution. A real host calls `executePlan()` and passes its own
 *     `runTrial`.
 *
 * Isolation and caps:
 *   - one fresh worktree per trial via `createTaskWorktree` (integration/
 *     worktree.js), so one trial cannot see another trial's edits;
 *   - a task may freeze `repo` / `baseCommit` / `provenance`; the runner
 *     resolves that commit in that repository before spending anything and
 *     refuses (OMC/WORKTREE-BASECOMMIT) when it cannot. It never falls back to
 *     this repository's HEAD;
 *   - shared prerequisites (E2) run once per arm before that arm's first trial.
 *     They are recorded under `receipt.prerequisites`, never counted as an
 *     independent trial, and their cost/calls are attributed to the arm;
 *   - the budget caps (total, per trial, remaining) are passed into every
 *     `runTrial` call. The runner passes caps; it does not meter model spend —
 *     the executor must enforce them and settle real costs, which the trial
 *     collector then reads from the usage ledger;
 *   - receipts are written to docs/evidence/alpha.2/session-strategies/ only on
 *     an actual execute run (never for --plan, never for a preflight refusal).
 *
 * Manifest document format (JSON, UTF-8):
 *   {
 *     "manifest": { ...frozen createStrategyExperiment() output... },  // OR
 *     "spec":     { ...createStrategyExperiment() input... },
 *     "budget":   { "totalUsd": 12, "perTrialUsd": 1.5 },
 *     "concurrency": 1,
 *     "deadline": "2026-12-01T00:00:00.000Z"
 *   }
 * Budget, concurrency and deadline are required for --execute and reported as
 * null in --plan when absent. A bare createStrategyExperiment() manifest is NOT
 * enough for --execute: freezing the budget numbers is part of the experiment
 * protocol, and they cannot be recovered from a manifest that never recorded
 * them.
 *
 * Honest limits: `budgetDigest` in conditions is only a fingerprint; the real
 * spend limit is the gate above plus the executor's own enforcement. This
 * runner cannot prove an executor stayed inside the cap, only what it passed in
 * and what the ledger later reports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStrategyExperiment, experimentArms } from '../integration/strategy-eval.js'
import { createTaskWorktree, runGit } from '../integration/worktree.js'

export const RUNNER_VERSION = 1
export const RECEIPT_DIR = 'docs/evidence/alpha.2/session-strategies'
export const NO_EXECUTOR = 'OMC/TRIAL-NO-EXECUTOR'
export const BUDGET_CAPS_MISSING = 'OMC/TRIAL-BUDGET-CAPS'
export const MANIFEST_INVALID = 'OMC/TRIAL-MANIFEST'
export const EXECUTOR_FAILED = 'OMC/TRIAL-EXECUTOR-FAILED'
export const BUDGET_EXHAUSTED = 'OMC/TRIAL-BUDGET-EXHAUSTED'
export const DEADLINE_REACHED = 'OMC/TRIAL-DEADLINE'
export const WORKTREE_BASECOMMIT = 'OMC/WORKTREE-BASECOMMIT'
export const RECEIPT_EXISTS = 'OMC/TRIAL-RECEIPT-EXISTS'

/** The callback signature a future (paid) integration must provide. */
export const EXECUTOR_CONTRACT = Object.freeze({
  name: 'runTrial',
  signature: 'async runTrial(ctx, { trial, worktree, budget, manifest, plan }) => TrialOutcome',
  callShape: {
    trial: '{ trialId, taskId, repeat, arm, strategy, policyVersion, taskRevision, role?, prerequisite? }',
    worktree: '{ path, branch, baseCommit, repositoryRoot }',
    budget: '{ totalUsd, perTrialUsd, remainingUsd, spentUsd, enforcedBy }',
    manifest: 'the frozen createStrategyExperiment() manifest (digest, experimentGroup, arms, conditions, policyVersions, prerequisite)',
    plan: 'the JSON printed by --plan (runnerVersion, concurrency, deadline, effective caps)',
  },
  outcome: {
    execution: "'completed' | 'failed' | 'cancelled' | 'timeout' — the real terminal state, never inferred",
    acceptance: "{ state: 'passed' | 'failed' | 'unknown' | 'pending', evidenceKind, evidenceRef, criticalRegression, falseCompletion }",
    startedAt: 'ISO timestamp of the trial start (caller-supplied wall clock)',
    endedAt: 'ISO timestamp of the trial end',
    costUsd: 'the executor-settled cost, or null when unknown — never 0 as a placeholder',
    calls: 'model request count, or null when unknown',
    actualActions: 'the documented actions the strategy really performed',
    interventions: 'manual help, one entry per episode',
    provenance: '{ model, harness, baseCommit, branch, policyVersion, group, arm, costBasis, costVersion, collectionCoverage, unknownCost } as observed by the executor',
  },
  must: [
    'refuse to start a trial when cost would exceed budget.perTrialUsd or budget.remainingUsd',
    'report the real terminal state; a missing terminal event is not completed',
    'settle usage/cost into the usage ledger under the same parentId/taskId the collector will read',
    'never write acceptance evidence it did not produce (model self-report is not acceptance)',
  ],
  forbidden: [
    'paid dispatch implemented inside this work package',
    'reusing one worktree or one live session across trials',
    'copying a previous trial answer or reflection into the next trial',
  ],
})

function iso(value) {
  return typeof value === 'string' ? value : null
}

/** Parse the JSON manifest document. Errors are returned, never thrown upward. */
export function parseManifestDocument(text) {
  try {
    const document = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    return { document, problems: [] }
  } catch (error) {
    return { document: null, problems: [`the manifest document is not valid JSON: ${error?.message ?? error}`] }
  }
}

/**
 * Resolve the document into a frozen manifest plus the frozen runner settings.
 * A `manifest` is validated by re-deriving it with createStrategyExperiment();
 * a `spec` is frozen now (and its digest is printed by --plan).
 */
export function resolveBundle(document) {
  const problems = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { manifest: null, budget: null, concurrency: null, deadline: null, problems: ['the manifest document must be a JSON object'] }
  }
  const budget = document.budget && typeof document.budget === 'object' && !Array.isArray(document.budget) ? document.budget : null
  const concurrency = Number.isSafeInteger(document.concurrency) ? document.concurrency : null
  const deadline = iso(document.deadline)
  let manifest = null

  if (document.manifest && typeof document.manifest === 'object') {
    try {
      const regenerated = createStrategyExperiment(document.manifest)
      if (typeof document.manifest.digest !== 'string' || regenerated.digest !== document.manifest.digest) {
        problems.push('the frozen manifest digest does not reproduce the allocation; the plan was edited after freezing')
      }
      manifest = regenerated
    } catch (error) {
      problems.push(`the frozen manifest is invalid: ${error?.message ?? error}`)
    }
  } else if (document.spec && typeof document.spec === 'object') {
    try {
      manifest = createStrategyExperiment(document.spec)
    } catch (error) {
      problems.push(`the experiment spec is invalid: ${error?.message ?? error}`)
    }
  } else {
    problems.push('the document must contain "manifest" (already frozen) or "spec" (to be frozen now)')
  }

  return { manifest, budget, concurrency, deadline, problems }
}

/** Budget caps are required for execution; in --plan they are reported as null. */
export function budgetCapProblems({ budget, maxUsd } = {}) {
  const problems = []
  if (!budget) return ['budget caps are missing: the document has no "budget" object with totalUsd/perTrialUsd']
  if (!Number.isFinite(budget.totalUsd) || budget.totalUsd <= 0) {
    problems.push('budget.totalUsd is missing or not a positive number; a paid experiment cannot start without a frozen total cap')
  }
  if (!Number.isFinite(budget.perTrialUsd) || budget.perTrialUsd <= 0) {
    problems.push('budget.perTrialUsd is missing or not a positive number; a paid experiment cannot start without a frozen per-trial cap')
  }
  if (budget.totalUsd > 0 && budget.perTrialUsd > 0 && budget.perTrialUsd > budget.totalUsd) {
    problems.push('budget.perTrialUsd exceeds budget.totalUsd; the two caps contradict each other')
  }
  if (maxUsd !== null && maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd <= 0)) {
    problems.push('--max-usd must be a positive number')
  }
  return problems
}

function runnerSettingsProblems({ concurrency, deadline }) {
  const problems = []
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    problems.push('concurrency is missing or not a positive integer; parallel trials change contention and cannot be left implicit')
  }
  if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline))) {
    problems.push('deadline is missing or not a parseable ISO timestamp; an unbounded paid run is not allowed')
  }
  return problems
}

/** Build the JSON printed by --plan. Pure: no writes, no execution. */
export function planExperiment({ document = null, maxUsd = null } = {}) {
  const resolved = resolveBundle(document)
  const { manifest, budget, concurrency, deadline } = resolved
  const problems = [...resolved.problems]
  const warnings = budgetCapProblems({ budget, maxUsd })
  warnings.push(...runnerSettingsProblems({ concurrency, deadline }))

  const caps = {
    totalUsd: Number.isFinite(budget?.totalUsd) ? budget.totalUsd : null,
    perTrialUsd: Number.isFinite(budget?.perTrialUsd) ? budget.perTrialUsd : null,
    maxUsdFromCli: Number.isFinite(maxUsd) ? maxUsd : null,
  }
  const effectiveTotalUsd = caps.totalUsd !== null && caps.maxUsdFromCli !== null
    ? Math.min(caps.totalUsd, caps.maxUsdFromCli)
    : caps.totalUsd

  if (problems.length || !manifest) {
    return {
      mode: 'plan',
      runnerVersion: RUNNER_VERSION,
      executesAnything: false,
      manifest: null,
      problems,
      warnings,
      budgetCaps: caps,
      concurrency,
      deadline,
    }
  }

  const arms = experimentArms(manifest)
  const taskFor = (taskId) => manifest.tasks.find((task) => task.id === taskId) ?? null
  return {
    mode: 'plan',
    runnerVersion: RUNNER_VERSION,
    executesAnything: false,
    manifest: {
      experimentId: manifest.experimentId,
      digest: manifest.digest,
      experimentGroup: manifest.experimentGroup ?? null,
      arms,
      dataKind: manifest.dataKind,
      split: manifest.split,
      seed: manifest.seed,
      repeats: manifest.repeats,
      conditions: manifest.conditions,
      policyVersions: manifest.policyVersions,
      ...(manifest.prerequisite ? { prerequisite: manifest.prerequisite } : {}),
    },
    model: manifest.conditions.model,
    provider: manifest.conditions.provider,
    experimentGroup: manifest.experimentGroup ?? null,
    arms,
    prerequisite: manifest.prerequisite
      ? { ...manifest.prerequisite, countedAsTrial: false, note: 'shared prerequisite; its cost/calls belong to each arm and it is not an independent trial' }
      : null,
    concurrency,
    deadline,
    budgetCaps: { ...caps, effectiveTotalUsd },
    assignmentCount: manifest.assignments.length,
    taskCount: manifest.tasks.length,
    tasks: manifest.tasks,
    trials: manifest.assignments.map((assignment) => {
      const task = taskFor(assignment.taskId)
      return {
        trialId: assignment.trialId,
        taskId: assignment.taskId,
        repeat: assignment.repeat,
        arm: assignment.strategy,
        // `strategy` is kept as the legacy alias: the frozen arm id is what it
        // always meant.
        strategy: assignment.strategy,
        group: manifest.experimentGroup ?? null,
        policyVersion: manifest.policyVersions[assignment.strategy],
        taskRevision: task?.revision ?? null,
        repo: task?.repo ?? null,
        baseCommit: task?.baseCommit ?? null,
        provenance: task?.provenance ?? null,
        harness: task?.harness ?? manifest.conditions.harness ?? null,
        model: manifest.conditions.model,
        budgetCaps: {
          perTrialUsd: caps.perTrialUsd,
          remainingUsdIfFirst: effectiveTotalUsd,
        },
      }
    }),
    ...(manifest.prerequisite ? {
      prerequisites: arms.map((arm) => {
        const frozen = (manifest.prerequisiteTrials ?? []).find((row) => row.trialId && row.strategy === arm)
        return {
          trialId: frozen?.trialId ?? null,
          taskId: manifest.prerequisite.id,
          arm,
          group: manifest.experimentGroup ?? null,
          policyVersion: manifest.policyVersions[arm],
          taskRevision: manifest.prerequisite.revision,
          repo: manifest.prerequisite.repo ?? null,
          baseCommit: manifest.prerequisite.baseCommit ?? null,
          countedAsTrial: false,
          note: 'runs once per arm before that arm’s first trial; its cost/calls are attributed to the arm',
        }
      }),
    } : {}),
    problems,
    warnings,
  }
}

/**
 * The default adapter. It exists to make the missing implementation explicit:
 * this work package does not dispatch paid models.
 */
export function defaultRunTrial() {
  const error = new Error(`${NO_EXECUTOR}: trial execution is not implemented in this work package; a host integration must supply runTrial (see --print-executor-contract)`)
  error.code = NO_EXECUTOR
  throw error
}

function receiptStamp(now) {
  return String(now()).replace(/[^0-9A-Za-z]+/g, '').slice(0, 20) || 'run'
}

function writeReceipt({ receiptDir, receiptPath = null, manifest, plan, results, prerequisites = [], budget, aborted, now, onlyTrialIds = null }) {
  const explicit = typeof receiptPath === 'string' && receiptPath.trim() !== '' ? resolve(receiptPath) : null
  const dir = explicit ? dirname(explicit) : resolve(receiptDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = explicit ?? join(dir, `run-${String(manifest.experimentId).replace(/[^A-Za-z0-9._-]+/g, '-')}-${receiptStamp(now)}.json`)
  const allRows = [...results, ...prerequisites]
  const unknownCost = allRows.filter((row) => row.unknownCost === true).length
  const receipt = {
    schemaVersion: RUNNER_VERSION,
    kind: 'session-strategy-trial-receipt',
    runnerVersion: RUNNER_VERSION,
    experimentId: manifest.experimentId,
    experimentDigest: manifest.digest,
    experimentGroup: manifest.experimentGroup ?? null,
    group: manifest.experimentGroup ?? null,
    arms: experimentArms(manifest),
    dataKind: manifest.dataKind,
    split: manifest.split,
    model: manifest.conditions.model,
    concurrency: plan.concurrency,
    deadline: plan.deadline,
    budgetCaps: plan.budgetCaps,
    ...(manifest.prerequisite ? { prerequisite: manifest.prerequisite } : {}),
    tasks: manifest.tasks.map((task) => ({
      taskId: task.id,
      revision: task.revision,
      repo: task.repo ?? null,
      baseCommit: task.baseCommit ?? null,
      provenance: task.provenance ?? null,
      kind: task.kind ?? 'single-turn',
      ...(task.chain ? { chain: task.chain } : {}),
    })),
    startedAt: iso(now()),
    ...(onlyTrialIds ? {
      executionScope: {
        mode: 'subset',
        onlyTrialIds,
        totalAssignments: manifest.assignments.length,
        partial: onlyTrialIds.length < manifest.assignments.length,
        note: 'A smoke/subset run: the frozen allocation was not executed in full, so this receipt must not be promoted as a complete experiment.',
      },
    } : {}),
    aborted,
    trials: results,
    ...(manifest.prerequisite ? { prerequisites } : {}),
    unknownCostTrials: unknownCost,
    unknownCost: unknownCost > 0,
    limitations: [
      'This receipt records what the runner passed to the executor; it does not prove the executor stayed inside the cap.',
      'Trial outcomes here are the executor-reported ones; integration/trial-collector.js is what turns them into evaluator records from the execution store and usage ledger.',
      'Unknown cost/calls are recorded as null, never as 0, and an unknown cost never supports a promotion conclusion.',
      'No trial result implies strategy promotion; that decision belongs to the offline evaluator.',
    ],
  }
  try {
    writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const exists = new Error(`${RECEIPT_EXISTS}: receipt ${file} already exists; refusing to overwrite evidence`)
      exists.code = RECEIPT_EXISTS
      throw exists
    }
    throw error
  }
  return file
}

function trialTask(manifest, taskId) {
  const task = manifest.tasks.find((row) => row.id === taskId)
  return task ?? null
}

function receiptBaseRow({ manifest, assignment, task, worktree, resolvedBase }) {
  const arm = assignment.strategy
  return {
    trialId: assignment.trialId,
    taskId: assignment.taskId,
    repeat: assignment.repeat,
    arm,
    strategy: arm,
    group: manifest.experimentGroup ?? null,
    policyVersion: manifest.policyVersions[arm],
    taskRevision: task?.revision ?? null,
    model: manifest.conditions.model,
    harness: task?.harness ?? manifest.conditions.harness ?? null,
    baseCommit: worktree?.baseCommit ?? resolvedBase ?? task?.baseCommit ?? null,
    branch: worktree?.branch ?? null,
    repositoryRoot: worktree?.repositoryRoot ?? null,
  }
}

function outcomePatch(outcome, { manifest, task }) {
  const costUsd = Number.isFinite(outcome?.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : null
  const acceptance = outcome?.acceptance
  const calls = Number.isSafeInteger(outcome?.calls) && outcome.calls >= 0 ? outcome.calls : null
  return {
    execution: outcome?.execution ?? 'unknown',
    acceptance: typeof acceptance === 'string' ? acceptance : acceptance?.state ?? 'unknown',
    evidenceKind: acceptance && typeof acceptance === 'object' ? acceptance.evidenceKind ?? null : null,
    evidenceRef: acceptance && typeof acceptance === 'object' ? acceptance.evidenceRef ?? null : null,
    criticalRegression: acceptance && typeof acceptance === 'object' ? acceptance.criticalRegression === true : false,
    falseCompletion: acceptance && typeof acceptance === 'object' ? acceptance.falseCompletion === true : false,
    actualActions: Array.isArray(outcome?.actualActions) ? outcome.actualActions : [],
    interventions: Array.isArray(outcome?.interventions) ? outcome.interventions : [],
    humanInterventions: Array.isArray(outcome?.interventions) ? outcome.interventions.length : null,
    costUsd,
    costBasis: outcome?.costBasis ?? 'unknown',
    costVersion: outcome?.costVersion ?? null,
    calls,
    observedModel: outcome?.model ?? null,
    harness: outcome?.harness ?? task?.harness ?? manifest.conditions.harness ?? null,
    collectionCoverage: ['complete', 'partial', 'unknown'].includes(outcome?.collectionCoverage)
      ? outcome.collectionCoverage
      : 'unknown',
    unknownCost: costUsd === null,
    unknownCalls: calls === null,
    ...(outcome?.sessionDecision ? { sessionDecision: outcome.sessionDecision } : {}),
    ...(Array.isArray(outcome?.models) ? { models: outcome.models } : {}),
    ...(Array.isArray(outcome?.changedFiles) ? { changedFiles: outcome.changedFiles } : {}),
    ...(Array.isArray(outcome?.steps) ? { steps: outcome.steps } : {}),
    ...(Array.isArray(outcome?.sessions) ? { sessions: outcome.sessions } : {}),
    ...(Array.isArray(outcome?.sessionDecisions) ? { sessionDecisions: outcome.sessionDecisions } : {}),
    ...(outcome?.chainSteps ? { chainSteps: outcome.chainSteps } : {}),
    ...(outcome?.error ? { error: outcome.error } : {}),
  }
}

/**
 * Freeze-check every task that declares its own repository/base commit before
 * any trial runs. A commit that cannot be resolved here is a plan-level error:
 * the runner must never fall back to this repository's HEAD when the frozen
 * plan names another commit.
 */
async function verifyFrozenRefs(ctx, { manifest, repo, workspaceRoot = null }) {
  const problems = []
  const resolvedBases = new Map()
  const tasks = [...manifest.tasks, ...(manifest.prerequisite ? [manifest.prerequisite] : [])]
  for (const task of tasks) {
    if (!task.repo && !task.baseCommit) continue
    const targetRaw = task.repo ?? repo
    const target = isAbsolute(targetRaw) ? targetRaw : resolve(workspaceRoot ?? repo, targetRaw)
    if (!isAbsolute(target)) {
      problems.push({ code: 'OMC/WORKTREE-REPO', detail: `task ${task.id}: repo is not resolvable: ${targetRaw}` })
      continue
    }
    if (task.baseCommit) {
      const result = await runGit(ctx, {
        cwd: target,
        args: ['rev-parse', '--verify', `${task.baseCommit}^{commit}`],
      })
      const hash = result.ok
        ? (result.output.split(/\r?\n/).filter(Boolean).at(-1) ?? '')
        : ''
      if (!result.ok || !/^[0-9a-f]{7,64}$/i.test(hash)) {
        problems.push({
          code: WORKTREE_BASECOMMIT,
          detail: `task ${task.id}: baseCommit ${task.baseCommit} does not resolve in ${target}${result.output ? ` (${result.output})` : ''}${result.error ? ` (${result.error})` : ''}`,
        })
        continue
      }
      const requested = task.baseCommit.toLowerCase()
      const matches = hash.toLowerCase() === requested
        || (requested.length >= 7 && hash.toLowerCase().startsWith(requested))
      if (!matches) {
        problems.push({
          code: WORKTREE_BASECOMMIT,
          detail: `task ${task.id}: baseCommit ${task.baseCommit} resolved to ${hash}; refusing to substitute another commit`,
        })
        continue
      }
      resolvedBases.set(task.id, hash)
    } else {
      const result = await runGit(ctx, { cwd: target, args: ['rev-parse', '--show-toplevel'] })
      if (!result.ok || !result.output.trim()) {
        problems.push({ code: 'OMC/WORKTREE-REPO', detail: `task ${task.id}: repo ${target} is not a readable git worktree` })
      }
    }
  }
  return { problems, resolvedBases }
}

/**
 * Execute the frozen plan: one isolated worktree and one `runTrial` call per
 * assignment, with caps passed in. Aborts on the first infrastructure failure
 * instead of half-running a paid experiment.
 *
 * @param {object} options
 * @param {object|null} options.ctx        DSH host context (subprocess service) for worktrees
 * @param {object} options.document        the parsed manifest document
 * @param {number} options.maxUsd          operator ceiling from --max-usd
 * @param {string} [options.receiptDir]
 * @param {function} [options.runTrial]    the integration callback
 * @param {string} [options.repo]          absolute repository path for worktrees
 * @param {function} [options.now]         injectable clock for timestamps (never for trial durations)
 */
export async function executePlan({
  ctx = null,
  document = null,
  maxUsd = null,
  receiptDir = RECEIPT_DIR,
  receiptPath = null,
  runTrial = defaultRunTrial,
  repo = process.cwd(),
  onlyTrialIds = null,
  worktreeOverride = null,
  onlyStepIds = null,
  handoff = null,
  skipPrerequisites = false,
  workspaceRoot = null,
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planExperiment({ document, maxUsd })
  if (plan.problems.length || !plan.manifest) {
    return { ok: false, code: MANIFEST_INVALID, problems: plan.problems, plan, receipt: null }
  }
  const resolved = resolveBundle(document)
  const { manifest, budget, concurrency, deadline } = resolved
  const capsProblems = budgetCapProblems({ budget, maxUsd })
  capsProblems.push(...runnerSettingsProblems({ concurrency, deadline }))
  if (capsProblems.length) {
    return { ok: false, code: BUDGET_CAPS_MISSING, problems: capsProblems, plan, receipt: null }
  }
  let selectedAssignments = manifest.assignments
  if (onlyTrialIds !== null && onlyTrialIds !== undefined) {
    if (!Array.isArray(onlyTrialIds) || onlyTrialIds.length === 0) {
      return { ok: false, code: MANIFEST_INVALID, problems: ['onlyTrialIds must be a non-empty array when supplied'], plan, receipt: null }
    }
    const wanted = new Set(onlyTrialIds.filter((id) => typeof id === 'string' && id !== ''))
    const known = new Set([
      ...manifest.assignments.map((row) => row.trialId),
      ...(manifest.prerequisiteTrials ?? []).map((row) => row.trialId),
    ])
    const unknown = [...wanted].filter((id) => !known.has(id))
    if (unknown.length) {
      return { ok: false, code: MANIFEST_INVALID, problems: [`onlyTrialIds names unknown trial(s): ${unknown.join(', ')}`], plan, receipt: null }
    }
    selectedAssignments = manifest.assignments.filter((row) => wanted.has(row.trialId))
    if (!selectedAssignments.length) {
      return { ok: false, code: MANIFEST_INVALID, problems: ['onlyTrialIds selected no frozen assignment'], plan, receipt: null }
    }
  }
  if (!ctx || typeof ctx?.subprocess?.spawn !== 'function') {
    // Without a worktree-capable host nothing can be isolated, so no trial can
    // start and no receipt may claim one did.
    return {
      ok: false,
      code: NO_EXECUTOR,
      problems: ['no DSH host context (subprocess service) was supplied, so an isolated worktree per trial cannot be created; a host integration must call executePlan()'],
      plan,
      receipt: null,
    }
  }

  const frozen = await verifyFrozenRefs(ctx, { manifest, repo, workspaceRoot })
  if (frozen.problems.length) {
    return {
      ok: false,
      code: frozen.problems[0].code,
      problems: frozen.problems.map((problem) => problem.detail),
      aborted: frozen.problems[0],
      plan,
      receipt: null,
    }
  }
  const { resolvedBases } = frozen

  const effectiveTotalUsd = Math.min(Number(maxUsd), Number(budget.totalUsd))
  const deadlineMs = Date.parse(deadline)
  const results = []
  const prerequisites = []
  const completedPrerequisites = new Set()
  let spentUsd = 0
  let aborted = null

  const stopReason = (label) => {
    if (spentUsd >= effectiveTotalUsd) {
      return { code: BUDGET_EXHAUSTED, detail: `spent ${spentUsd} of ${effectiveTotalUsd} USD before ${label}` }
    }
    if (Number.isFinite(deadlineMs) && Date.parse(now()) >= deadlineMs) {
      return { code: DEADLINE_REACHED, detail: `deadline ${deadline} reached before ${label}` }
    }
    return null
  }

  const runPrerequisite = async (arm) => {
    const task = manifest.prerequisite
    const frozenTrial = (manifest.prerequisiteTrials ?? []).find((row) => row.strategy === arm) ?? null
    const effectiveRepo = task.repo
      ? (isAbsolute(task.repo) ? task.repo : resolve(workspaceRoot ?? repo, task.repo))
      : repo
    const base = resolvedBases.get(task.id) ?? task.baseCommit ?? 'HEAD'
    const remainingUsd = Math.max(0, effectiveTotalUsd - spentUsd)
    const perTrialUsd = Math.min(Number(budget.perTrialUsd), remainingUsd)
    const worktree = await createTaskWorktree(ctx, {
      repo: effectiveRepo,
      name: `${manifest.experimentId}-prerequisite-${arm}`,
      base,
    })
    const baseRow = {
      trialId: frozenTrial?.trialId ?? null,
      taskId: task.id,
      repeat: null,
      arm,
      strategy: arm,
      group: manifest.experimentGroup ?? null,
      policyVersion: manifest.policyVersions[arm],
      taskRevision: task.revision,
      role: 'prerequisite',
      countedAsTrial: false,
      model: manifest.conditions.model,
      harness: task.harness ?? manifest.conditions.harness ?? null,
      baseCommit: worktree.baseCommit ?? base,
      branch: worktree.branch ?? null,
    }
    if (!worktree.ok) {
      prerequisites.push({ ...baseRow, stage: 'worktree', ok: false, code: worktree.code ?? 'OMC/WORKTREE', detail: worktree.output ?? null })
      aborted = { code: worktree.code ?? 'OMC/WORKTREE', detail: worktree.output ?? null }
      return false
    }
    if (task.baseCommit && worktree.baseCommit !== base) {
      prerequisites.push({ ...baseRow, stage: 'worktree', ok: false, code: WORKTREE_BASECOMMIT,
        detail: `worktree was created at ${worktree.baseCommit}, the frozen baseCommit is ${base}` })
      aborted = { code: WORKTREE_BASECOMMIT, detail: `worktree was created at ${worktree.baseCommit}, the frozen baseCommit is ${base}` }
      return false
    }
    let outcome
    try {
      outcome = await runTrial(ctx, {
        trial: {
          trialId: frozenTrial?.trialId ?? null,
          taskId: task.id,
          repeat: null,
          arm,
          strategy: arm,
          policyVersion: manifest.policyVersions[arm],
          taskRevision: task.revision,
          role: 'prerequisite',
          prerequisite: true,
        },
        worktree: {
          path: worktree.path ?? null,
          branch: worktree.branch ?? null,
          baseCommit: worktree.baseCommit ?? null,
          repositoryRoot: worktree.repositoryRoot ?? null,
        },
        budget: {
          totalUsd: effectiveTotalUsd,
          perTrialUsd,
          remainingUsd,
          spentUsd,
          enforcedBy: 'executor (the runner passes caps, it does not meter model spend)',
        },
        manifest,
        plan,
        ...(onlyStepIds ? { onlyStepIds } : {}),
        ...(handoff ? { handoff } : {}),
      })
    } catch (error) {
      prerequisites.push({ ...baseRow, stage: 'executor', ok: false, code: error?.code ?? EXECUTOR_FAILED, detail: error?.message ?? String(error) })
      aborted = { code: error?.code ?? EXECUTOR_FAILED, detail: error?.message ?? String(error) }
      return false
    }
    const costUsd = Number.isFinite(outcome?.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : null
    if (costUsd !== null) spentUsd += costUsd
    prerequisites.push({ ...baseRow, ...outcomePatch(outcome, { manifest, task }),
      worktree: { path: worktree.path ?? null, branch: worktree.branch ?? null, baseCommit: worktree.baseCommit ?? null },
      startedAt: outcome?.startedAt ?? null, endedAt: outcome?.endedAt ?? null })
    return true
  }

  for (const assignment of selectedAssignments) {
    const stop = stopReason(assignment.trialId)
    if (stop) {
      aborted = stop
      break
    }
    if (!skipPrerequisites && manifest.prerequisite && !completedPrerequisites.has(assignment.strategy)) {
      completedPrerequisites.add(assignment.strategy)
      if (!(await runPrerequisite(assignment.strategy))) break
      const afterPrerequisite = stopReason(assignment.trialId)
      if (afterPrerequisite) {
        aborted = afterPrerequisite
        break
      }
    }
    const task = trialTask(manifest, assignment.taskId)
    if (!task) {
      results.push({
        trialId: assignment.trialId,
        taskId: assignment.taskId,
        repeat: assignment.repeat,
        arm: assignment.strategy,
        strategy: assignment.strategy,
        stage: 'plan',
        ok: false,
        code: MANIFEST_INVALID,
        detail: `the frozen allocation names task ${assignment.taskId}, but the manifest has no such task`,
      })
      aborted = { code: MANIFEST_INVALID, detail: `frozen allocation names an unknown task: ${assignment.taskId}` }
      break
    }
    const effectiveRepo = task.repo
      ? (isAbsolute(task.repo) ? task.repo : resolve(workspaceRoot ?? repo, task.repo))
      : repo
    const base = resolvedBases.get(task.id) ?? task.baseCommit ?? 'HEAD'
    const remainingUsd = Math.max(0, effectiveTotalUsd - spentUsd)
    const perTrialUsd = Math.min(Number(budget.perTrialUsd), remainingUsd)
    let worktree
    if (worktreeOverride) {
      const path = typeof worktreeOverride?.path === 'string' ? resolve(worktreeOverride.path) : null
      if (!path || !existsSync(path)) {
        results.push({
          ...receiptBaseRow({ manifest, assignment, task, resolvedBase: base }),
          stage: 'worktree',
          ok: false,
          code: 'OMC/WORKTREE-RECOVERY',
          detail: `the recovery worktree does not exist: ${String(path)}`,
        })
        aborted = { code: 'OMC/WORKTREE-RECOVERY', detail: `the recovery worktree does not exist: ${String(path)}` }
        break
      }
      worktree = {
        ok: true,
        path,
        branch: worktreeOverride.branch ?? null,
        baseCommit: worktreeOverride.baseCommit ?? task.baseCommit ?? base,
        repositoryRoot: worktreeOverride.repositoryRoot ?? effectiveRepo,
      }
    } else {
      worktree = await createTaskWorktree(ctx, {
        repo: effectiveRepo,
        name: `${manifest.experimentId}-${assignment.strategy}-${assignment.taskId}-${assignment.repeat}`,
        base,
      })
    }
    if (!worktree.ok) {
      results.push({
        ...receiptBaseRow({ manifest, assignment, task, resolvedBase: base }),
        stage: 'worktree',
        ok: false,
        code: worktree.code ?? 'OMC/WORKTREE',
        detail: worktree.output ?? null,
      })
      // No trial ran, so nothing may be reported as a trial outcome.
      aborted = { code: worktree.code ?? 'OMC/WORKTREE', detail: worktree.output ?? null }
      break
    }
    if (task.baseCommit && worktree.baseCommit !== base) {
      const detail = `worktree was created at ${worktree.baseCommit}, the frozen baseCommit is ${base}; refusing to substitute another commit`
      results.push({
        ...receiptBaseRow({ manifest, assignment, task, worktree, resolvedBase: base }),
        stage: 'worktree',
        ok: false,
        code: WORKTREE_BASECOMMIT,
        detail,
      })
      aborted = { code: WORKTREE_BASECOMMIT, detail }
      break
    }
    let outcome
    try {
      outcome = await runTrial(ctx, {
        trial: {
          trialId: assignment.trialId,
          taskId: assignment.taskId,
          repeat: assignment.repeat,
          arm: assignment.strategy,
          strategy: assignment.strategy,
          policyVersion: manifest.policyVersions[assignment.strategy],
          taskRevision: task.revision,
          group: manifest.experimentGroup ?? null,
          harness: task.harness ?? manifest.conditions.harness ?? null,
        },
        worktree: {
          path: worktree.path ?? null,
          branch: worktree.branch ?? null,
          baseCommit: worktree.baseCommit ?? null,
          repositoryRoot: worktree.repositoryRoot ?? null,
        },
        budget: {
          totalUsd: effectiveTotalUsd,
          perTrialUsd,
          remainingUsd,
          spentUsd,
          enforcedBy: 'executor (the runner passes caps, it does not meter model spend)',
        },
        manifest,
        plan,
        ...(onlyStepIds ? { onlyStepIds } : {}),
        ...(handoff ? { handoff } : {}),
      })
    } catch (error) {
      results.push({
        ...receiptBaseRow({ manifest, assignment, task, worktree, resolvedBase: base }),
        stage: 'executor',
        ok: false,
        code: error?.code ?? EXECUTOR_FAILED,
        detail: error?.message ?? String(error),
      })
      aborted = { code: error?.code ?? EXECUTOR_FAILED, detail: error?.message ?? String(error) }
      break
    }
    const costUsd = Number.isFinite(outcome?.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : null
    if (costUsd !== null) spentUsd += costUsd
    results.push({
      ...receiptBaseRow({ manifest, assignment, task, worktree, resolvedBase: base }),
      stage: 'executed',
      ok: outcome?.ok !== false,
      ...outcomePatch(outcome, { manifest, task }),
      startedAt: outcome?.startedAt ?? null,
      endedAt: outcome?.endedAt ?? null,
      worktree: { path: worktree.path ?? null, branch: worktree.branch ?? null, baseCommit: worktree.baseCommit ?? null },
    })
  }

  let receipt
  try {
    receipt = writeReceipt({ receiptDir, receiptPath, manifest, plan, results, prerequisites, budget, aborted, now, onlyTrialIds: selectedAssignments.length === manifest.assignments.length ? null : selectedAssignments.map((row) => row.trialId) })
  } catch (error) {
    if (error?.code === RECEIPT_EXISTS) {
      return { ok: false, code: RECEIPT_EXISTS, aborted: { code: RECEIPT_EXISTS, detail: error.message }, plan, results, prerequisites, receipt: null, spentUsd }
    }
    throw error
  }
  return {
    ok: aborted === null && results.length === selectedAssignments.length,
    partial: selectedAssignments.length !== manifest.assignments.length,
    onlyTrialIds: selectedAssignments.map((row) => row.trialId),
    code: aborted?.code ?? null,
    aborted,
    plan,
    results,
    prerequisites,
    receipt,
    spentUsd,
  }
}

const HELP = `OMC session-strategy trial runner (no model calls unless --execute with a host executor)
  node scripts/strategy-runner.mjs --manifest <path> --plan
  node scripts/strategy-runner.mjs --manifest <path> --execute --max-usd <n> --confirm-paid-experiment
  node scripts/strategy-runner.mjs --print-executor-contract
  node scripts/strategy-runner.mjs --manifest <path> --print-executor-contract
Document format: docs/FEEDBACK-EVOLUTION.zh-CN.md and the header of this file.
--plan prints the frozen allocation and writes nothing. --execute refuses without both
--max-usd and --confirm-paid-experiment, and refuses a manifest without budget caps.`

function parseArgs(argv) {
  const options = {
    manifest: null, plan: false, execute: false, maxUsd: null,
    confirmPaidExperiment: false, printExecutorContract: false,
    receiptDir: RECEIPT_DIR, repo: process.cwd(), help: false, unknown: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || String(value).startsWith('--')) return null
      i += 1
      return value
    }
    if (arg === '--manifest') options.manifest = next()
    else if (arg === '--plan') options.plan = true
    else if (arg === '--execute') options.execute = true
    else if (arg === '--max-usd') options.maxUsd = Number(next())
    else if (arg === '--confirm-paid-experiment') options.confirmPaidExperiment = true
    else if (arg === '--print-executor-contract') options.printExecutorContract = true
    else if (arg === '--receipt-dir') options.receiptDir = next() ?? options.receiptDir
    else if (arg === '--repo') options.repo = next() ?? options.repo
    else if (arg === '--help' || arg === '-h') options.help = true
    else options.unknown.push(arg)
  }
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  const fail = (lines, code = 2) => {
    for (const line of lines) console.error(line)
    process.exitCode = code
  }

  if (options.unknown.length) {
    fail([`unknown argument(s): ${options.unknown.join(', ')}`, HELP])
    return
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  if (options.printExecutorContract && !options.manifest) {
    console.log(JSON.stringify({ runnerVersion: RUNNER_VERSION, contract: EXECUTOR_CONTRACT }, null, 2))
    return
  }
  if (!options.manifest) {
    fail(['--manifest <path> is required unless --print-executor-contract is used', HELP])
    return
  }
  if (options.plan && options.execute) {
    fail(['--plan and --execute are mutually exclusive; --plan must never start a run'])
    return
  }
  if (!options.plan && !options.execute && !options.printExecutorContract) {
    fail(['one of --plan, --execute or --print-executor-contract is required', HELP])
    return
  }

  const path = resolve(options.manifest)
  if (!existsSync(path)) {
    fail([`manifest file does not exist: ${path}`])
    return
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail([`manifest file could not be read: ${error?.message ?? error}`])
    return
  }
  const parsed = parseManifestDocument(text)
  if (parsed.problems.length) {
    fail(parsed.problems)
    return
  }
  const document = parsed.document

  if (options.printExecutorContract) {
    const plan = planExperiment({ document, maxUsd: options.maxUsd })
    console.log(JSON.stringify({
      runnerVersion: RUNNER_VERSION,
      manifest: options.manifest,
      contract: EXECUTOR_CONTRACT,
      planProblems: plan.problems,
      planWarnings: plan.warnings,
      trials: plan.trials ?? [],
    }, null, 2))
    return
  }

  if (options.plan) {
    const plan = planExperiment({ document, maxUsd: options.maxUsd })
    if (plan.problems.length) {
      // A plan of an unverifiable allocation is not a plan: print it and fail.
      console.error(plan.problems.join('\n'))
      console.log(JSON.stringify(plan, null, 2))
      process.exitCode = 2
      return
    }
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  // --execute: explicit paid-experiment preconditions first, before any I/O.
  const refusals = []
  if (!options.confirmPaidExperiment) {
    refusals.push('OMC/TRIAL-NOT-CONFIRMED: --execute needs --confirm-paid-experiment; this run would spend real money and must be confirmed explicitly')
  }
  if (options.maxUsd === null || !Number.isFinite(options.maxUsd) || options.maxUsd <= 0) {
    refusals.push('OMC/TRIAL-BUDGET-CAPS: --execute needs --max-usd <n> (a positive USD ceiling); no paid run starts without one')
  }
  if (!refusals.length) {
    const resolvedBundle = resolveBundle(document)
    const caps = budgetCapProblems({ budget: resolvedBundle.budget, maxUsd: options.maxUsd })
    caps.push(...runnerSettingsProblems({ concurrency: resolvedBundle.concurrency, deadline: resolvedBundle.deadline }))
    if (caps.length) refusals.push(...caps.map((problem) => `OMC/TRIAL-BUDGET-CAPS: ${problem}`))
  }
  if (refusals.length) {
    fail(refusals)
    return
  }

  // No host context exists in a plain CLI process, so paid dispatch is not
  // available here by design. Say so instead of pretending to run.
  fail([`${NO_EXECUTOR}: this CLI has no DSH host context, so an isolated worktree per trial and a paid executor cannot be provided here; a host integration must call executePlan() from this module (see --print-executor-contract)`])
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error?.code ?? 'OMC/TRIAL-RUNNER'}: ${error?.message ?? error}`)
    process.exitCode = 2
  })
}
