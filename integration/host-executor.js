/**
 * Real Host Executor factory for the session-strategy experiment runner (0.8).
 *
 * This module is the missing half of `scripts/strategy-runner.mjs`'s
 * `EXECUTOR_CONTRACT`: it turns one frozen trial into a real host run.
 *
 *   baseline frozen → (optional) session decision → managed dispatch →
 *   independent acceptance verdict → usage-ledger rollup → TrialOutcome
 *
 * It deliberately does NOT implement a new agent runtime. Everything real is
 * reused from the existing host integration:
 *
 *   - `createManagedExecution(...).dispatch` for the dispatch envelope
 *     (claim → attempt → events → settle; this module never invents one);
 *   - `decideSessionAction` for the explainable resume/compact/restart choice;
 *   - `createAcceptanceRunner().baseline()/run()` for the verdict, with the
 *     baseline taken BEFORE dispatch (a worker cannot see or edit it first);
 *   - `usageLedger.totals()/entries()` for calls, cost and token buckets;
 *   - `createBudgetTracker()` for the pre-dispatch reservation/checkpoint.
 *
 * Dependencies are injectable so the whole flow can be tested offline with a
 * fake dispatcher and a fake acceptance runner. When no host context and no
 * injected dispatch surface exist, `runTrial` fails with
 * `OMC/HOST-EXECUTOR-UNAVAILABLE`; it never fabricates a trial result.
 *
 * Honest limits:
 *   - this adapter reports what the dispatch and the ledger observed. A
 *     dispatch that lies about its status is not detectable here;
 *   - unknown calls/cost stay `null` (never 0), and `collectionCoverage` says
 *     whether the rollup is complete;
 *   - the real host wiring must still supply `managed`+`rt` (or `stores`+`rt`)
 *     and a per-task acceptance spec; `buildRequest` is where a caller attaches
 *     the managed `nodeId` / graph node.
 */

import { existsSync } from 'node:fs'

import { createManagedExecution } from './managed-execution.js'
import { decideSessionAction, STRATEGY_RULES_VERSION } from './session-strategy.js'
import { resolveTrialSteps } from './strategy-eval.js'
import { createAcceptanceRunner } from './acceptance-runner.js'
import { createBudgetTracker } from './budget.js'
import { USAGE_BUCKETS } from './usage-ledger.js'

export const HOST_EXECUTOR_VERSION = 1
export const HOST_EXECUTOR_UNAVAILABLE = 'OMC/HOST-EXECUTOR-UNAVAILABLE'
export const HOST_EXECUTOR_INPUT = 'OMC/HOST-EXECUTOR-INPUT'
export const HOST_EXECUTOR_BASE = 'OMC/HOST-EXECUTOR-BASE'
export const HOST_EXECUTOR_POLICY = 'OMC/HOST-EXECUTOR-POLICY'
export const HOST_EXECUTOR_ACCEPTANCE = 'OMC/HOST-EXECUTOR-ACCEPTANCE'
export const HOST_EXECUTOR_BUDGET = 'OMC/TRIAL-BUDGET-EXHAUSTED'

/** Mirrors `EXECUTOR_CONTRACT` in scripts/strategy-runner.mjs. */
export const HOST_EXECUTOR_CONTRACT = Object.freeze({
  name: 'runTrial',
  signature: 'async runTrial(ctx, { trial, worktree, budget, manifest, plan }) => TrialOutcome',
  must: [
    'freeze the acceptance baseline before dispatch',
    'report the real terminal state; an unknown outcome stays unknown, never completed',
    'settle usage/cost from the usage ledger under the same parent/task identity the collector reads',
    'never claim an acceptance state the runner did not produce',
    'leave unknown calls/cost as null, never 0',
  ],
  forbidden: [
    'creating a second agent runtime inside the trial',
    'silently replacing a frozen baseCommit with this repository HEAD',
    'fabricating a successful trial when no host context exists',
  ],
})

function hostError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function nonEmpty(value, label) {
  if (!text(value)) throw hostError(HOST_EXECUTOR_INPUT, `${label} is required`)
  return value
}

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function allNullUsage() {
  return Object.fromEntries(USAGE_BUCKETS.map((bucket) => [bucket, null]))
}

function ledgerRollup({ usageLedger, parentId, taskId }) {
  const empty = {
    entries: 0, calls: null, costUsd: null, costBasis: 'unknown', costVersion: null,
    usage: allNullUsage(), model: null, models: [],
  }
  if (!usageLedger || !parentId || typeof usageLedger.entries !== 'function') return empty
  let entries
  try {
    entries = usageLedger.entries({ parentId, taskId })
  } catch {
    return empty
  }
  if (!Array.isArray(entries) || entries.length === 0) return empty
  let totals = null
  try {
    totals = typeof usageLedger.totals === 'function' ? usageLedger.totals({ parentId, taskId }) : null
  } catch {
    totals = null
  }
  const usage = {}
  for (const bucket of USAGE_BUCKETS) {
    const complete = entries.every((row) => Number.isSafeInteger(row?.usage?.[bucket]) && row.usage[bucket] >= 0)
    usage[bucket] = complete
      ? (Number.isSafeInteger(totals?.sums?.[bucket])
        ? totals.sums[bucket]
        : entries.reduce((sum, row) => sum + row.usage[bucket], 0))
      : null
  }
  const sources = [...new Set(entries
    .map((row) => row?.cost?.source)
    .filter((value) => text(value)))]
  const costKnown = totals?.costKnown === true && Number.isFinite(totals?.costUsd) && sources.length > 0
  const models = [...new Set(entries
    .map((row) => row?.route?.model)
    .filter((value) => text(value)))]
  return {
    entries: entries.length,
    calls: entries.length,
    costUsd: costKnown ? totals.costUsd : null,
    costBasis: costKnown ? 'estimated' : 'unknown',
    costVersion: sources.length ? sources.join('+') : null,
    usage,
    model: models.length === 1 ? models[0] : null,
    models,
  }
}

function coverageFor({ rollup, execution }) {
  const usageComplete = USAGE_BUCKETS.every((bucket) => Number.isSafeInteger(rollup.usage[bucket]))
  if (usageComplete && rollup.costUsd !== null && rollup.calls !== null && execution === 'completed' && rollup.model) {
    return 'complete'
  }
  if (rollup.calls !== null || rollup.costUsd !== null || USAGE_BUCKETS.some((bucket) => Number.isSafeInteger(rollup.usage[bucket]))) {
    return 'partial'
  }
  return 'unknown'
}

function executionFromStatus(status) {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'timeout') return 'timeout'
  if (status === 'failed') return 'failed'
  // `started` (background) and anything unrecognised are not terminal.
  return 'unknown'
}

function firstResult(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (Array.isArray(payload.results)) return payload.results[0] ?? null
  return payload
}

function stepId(step) {
  if (typeof step === 'string') return step
  if (step && typeof step === 'object' && !Array.isArray(step)) return step.id ?? step.name ?? null
  return null
}

function stepPrompt(step) {
  if (typeof step === 'string') return step
  if (step && typeof step === 'object' && !Array.isArray(step)) return step.prompt ?? step.goal ?? step.id ?? null
  return null
}

/**
 * @param {object} [deps]
 * @param {object|null} [deps.ctx] static host context (per-call ctx wins)
 * @param {object|null} [deps.managed] `createManagedExecution()` result
 * @param {object|null} [deps.rt] OMC runtime object for `managed.dispatch`
 * @param {object|null} [deps.stores] `{graph,mailbox,tasks,executionStore}` to build managed
 * @param {function|null} [deps.dispatch] explicit dispatcher `(request, exec, context) => result`
 * @param {object|null} [deps.usageLedger]
 * @param {object|null} [deps.executionStore]
 * @param {object|null} [deps.budgetTracker]
 * @param {object|null|function} [deps.acceptanceRunner] runner instance or factory
 * @param {string|null} [deps.parentId] OMC parent session id for ledger attribution
 * @param {function|null} [deps.parentIdForTrial] `(input) => parentId` override
 * @param {function|null} [deps.taskIdForTrial] `(input) => ledgerTaskId`; the runtime task id the host books under
 * @param {function|null} [deps.resolveAcceptance] `({trial,task,manifest,plan}) => acceptance spec`
 * @param {function|null} [deps.resolveFeatures] `(input) => features` for decideSessionAction
 * @param {function|null} [deps.resolveCapabilities] `(input) => capabilities`
 * @param {function|null} [deps.buildPrompt] `({trial,task,manifest,plan,step,stepIndex}) => string`
 * @param {function|null} [deps.buildRequest] `(input) => request overrides`
 * @param {function} [deps.now] injectable clock (timestamps only)
 */
export function createHostExecutor(deps = {}) {
  const {
    ctx: configuredCtx = null,
    managed = null,
    rt = null,
    stores = null,
    dispatch = null,
    usageLedger = null,
    executionStore = null,
    budgetTracker = null,
    acceptanceRunner = null,
    parentId = null,
    parentIdForTrial = null,
    taskIdForTrial = null,
    resolveAcceptance = null,
    resolveFeatures = null,
    resolveCapabilities = null,
    resolveSteps = null,
    buildPrompt = null,
    buildRequest = null,
    features = null,
    capabilities = null,
    harness: configuredHarness = null,
    model: configuredModel = null,
    timeoutMs = 120000,
    mode = 'in-place',
    signal = null,
    // The real host passes the VERIFIED calling agent object here. `parentId` is
    // only a string; managed dispatch/lineage needs the full host agent object.
    callerAgent = null,
    now = () => new Date().toISOString(),
    surface = null,
  } = deps

  const managedExecution = managed ?? (stores && rt ? createManagedExecution(stores) : null)
  const defaultDispatch = dispatch ?? (managedExecution && rt
    ? (request, exec) => managedExecution.dispatch(rt, request, exec)
    : null)

  function resolveDispatcher(host) {
    if (defaultDispatch) return defaultDispatch
    if (host && typeof host.dispatch === 'function') return host.dispatch
    return null
  }

  function resolveAcceptanceSpec({ trial, task, manifest, plan }) {
    if (typeof resolveAcceptance === 'function') {
      return resolveAcceptance({ trial, task, manifest, plan })
    }
    return task?.acceptance ?? plan?.acceptance ?? null
  }

  function defaultPromptFor({ trial, task, plan, step }) {
    const explicit = stepPrompt(step)
    if (text(explicit)) return explicit
    if (text(task?.prompt)) return task.prompt
    if (text(task?.goal)) return task.goal
    if (text(plan?.prompt)) return plan.prompt
    throw hostError(HOST_EXECUTOR_INPUT, `no prompt source for ${task?.id ?? trial?.taskId}; pass buildPrompt or a task prompt`)
  }

  function defaultStepFeatures({ prior, role } = {}) {
    const hasPrior = Boolean(prior?.sessionId)
    return {
      hasPriorWorker: hasPrior,
      childBusy: false,
      sameModule: hasPrior,
      constraintsMatch: prior?.constraintsMatch !== false,
      routeMatch: !hasPrior || (
        prior?.route?.provider === role?.provider && prior?.route?.model === role?.model
      ),
      permissionMatch: !hasPrior || prior?.permission === (role?.writer === true ? 'workspace-write' : 'read-only'),
      workspaceMatch: prior?.workspaceMatch !== false,
      factsStale: false,
      failureUnclear: hasPrior && prior?.status !== 'completed',
      independentReview: role?.writer === false,
      contextOverLimit: prior?.contextOverLimit === true,
    }
  }

  function stepRoute(result, role) {
    const provider = text(result?.provider) ? result.provider : (role?.provider ?? null)
    let model = text(result?.model) ? result.model : (role?.model ?? null)
    if (typeof model === 'string' && typeof provider === 'string' && model === `${provider}/${role?.model}`) {
      model = role.model
    }
    return { provider, model }
  }

  async function runTrial(ctxArg, input = {}) {
    const host = ctxArg ?? configuredCtx
    const dispatchFn = resolveDispatcher(host)
    if (typeof dispatchFn !== 'function') {
      throw hostError(HOST_EXECUTOR_UNAVAILABLE,
        'no DSH host context and no injected dispatch surface; refusing to fabricate a trial result')
    }

    const { trial, worktree, budget = {}, manifest, plan = {} } = input ?? {}
    if (!trial || typeof trial !== 'object') throw hostError(HOST_EXECUTOR_INPUT, 'trial is required')
    if (!manifest || typeof manifest !== 'object') throw hostError(HOST_EXECUTOR_INPUT, 'manifest is required')
    if (!worktree || typeof worktree !== 'object') throw hostError(HOST_EXECUTOR_INPUT, 'worktree is required')
    nonEmpty(trial.trialId, 'trial.trialId')
    nonEmpty(trial.taskId, 'trial.taskId')
    const arm = trial.arm ?? trial.strategy
    nonEmpty(arm, 'trial.arm')
    nonEmpty(worktree.path, 'worktree.path')
    if (!existsSync(worktree.path)) {
      throw hostError(HOST_EXECUTOR_INPUT, `worktree.path does not exist: ${worktree.path}`)
    }

    const prerequisite = trial.prerequisite === true || trial.role === 'prerequisite'
    const assignment = Array.isArray(manifest.assignments)
      ? manifest.assignments.find((row) => row?.trialId === trial.trialId)
      : null
    if (!prerequisite) {
      if (!assignment) throw hostError(HOST_EXECUTOR_INPUT, `trial ${trial.trialId} is not in the frozen allocation`)
      if (assignment.strategy !== arm) throw hostError(HOST_EXECUTOR_INPUT, `trial ${trial.trialId} arm ${arm} does not match the frozen arm ${assignment.strategy}`)
      if (assignment.taskId !== trial.taskId) throw hostError(HOST_EXECUTOR_INPUT, `trial ${trial.trialId} task ${trial.taskId} does not match the frozen task ${assignment.taskId}`)
    }
    const task = prerequisite
      ? manifest.prerequisite
      : (manifest.tasks ?? []).find((row) => row?.id === trial.taskId)
    if (!task) {
      throw hostError(HOST_EXECUTOR_INPUT, prerequisite
        ? 'this trial is a prerequisite run but the manifest declares no prerequisite task'
        : `the frozen manifest has no task ${trial.taskId}`)
    }
    if (!prerequisite && manifest.policyVersions?.[arm] !== trial.policyVersion) {
      throw hostError(HOST_EXECUTOR_POLICY,
        `trial ${trial.trialId} policyVersion ${trial.policyVersion} does not match the frozen ${manifest.policyVersions?.[arm]}`)
    }

    // A frozen baseCommit is a contract: the worktree must already sit on it.
    // The runner verifies it too; this second check catches a worktree object
    // that was silently created from HEAD instead.
    const expectedBase = text(task.baseCommit) ? task.baseCommit : null
    const actualBase = text(worktree.baseCommit) ? worktree.baseCommit : null
    if (expectedBase && !actualBase) {
      throw hostError(HOST_EXECUTOR_BASE, `task ${task.id} freezes baseCommit ${expectedBase}, but the worktree reports none`)
    }
    if (expectedBase && actualBase !== expectedBase
      && !(expectedBase.length >= 7 && actualBase.startsWith(expectedBase))) {
      throw hostError(HOST_EXECUTOR_BASE, `task ${task.id} freezes baseCommit ${expectedBase}, but the worktree is on ${actualBase}; refusing to substitute another commit`)
    }

    const remainingUsd = Number.isFinite(budget.remainingUsd) ? budget.remainingUsd : null
    const perTrialUsd = Number.isFinite(budget.perTrialUsd) ? budget.perTrialUsd : null
    if (remainingUsd !== null && remainingUsd <= 0) {
      throw hostError(HOST_EXECUTOR_BUDGET, `no budget remains before trial ${trial.trialId} (remainingUsd=${remainingUsd})`)
    }
    if (perTrialUsd !== null && perTrialUsd <= 0) {
      throw hostError(HOST_EXECUTOR_BUDGET, `per-trial budget is exhausted before trial ${trial.trialId}`)
    }

    const parent = (typeof parentIdForTrial === 'function' ? parentIdForTrial(input) : null)
      ?? parentId ?? host?.agent?.id ?? null
    // The collector reads a trial from the ledger by (parentId, taskId). The
    // host may map the frozen trial to its runtime task id; the default is the
    // unique trial id, which the caller must book under as well.
    const ledgerTaskId = (typeof taskIdForTrial === 'function' ? taskIdForTrial(input) : null) ?? trial.trialId
    const tracker = budgetTracker ?? (usageLedger
      ? createBudgetTracker({ usageLedger, executionStore, maxCalls: null, maxUsd: perTrialUsd })
      : null)

    const acceptanceSpec = resolveAcceptanceSpec({ trial, task, manifest, plan })
    if (!prerequisite && (!acceptanceSpec || typeof acceptanceSpec !== 'object')) {
      throw hostError(HOST_EXECUTOR_ACCEPTANCE,
        `trial ${trial.trialId} has no acceptance spec; acceptance cannot be fabricated from a model or dispatch self-report`)
    }
    const graded = Boolean(acceptanceSpec && typeof acceptanceSpec === 'object')

    const runner = typeof acceptanceRunner === 'function'
      ? acceptanceRunner({ cwd: worktree.path, subprocess: host?.subprocess ?? null, now })
      : acceptanceRunner ?? createAcceptanceRunner({ cwd: worktree.path, subprocess: host?.subprocess ?? null, now })

    const execute = harnessSignal()
    const startedAt = iso(now()) ?? now()

    let reservation = null
    if (tracker && parent) {
      reservation = tracker.reserveAttempt({ parentId: parent, taskId: ledgerTaskId, attemptId: `${trial.trialId}#host` })
      if (reservation?.reserved === false) {
        throw hostError(HOST_EXECUTOR_BUDGET, reservation.reason ?? `budget reservation refused for ${trial.trialId}`)
      }
    }

    try {
      // 1. Freeze the acceptance baseline BEFORE any dispatch can touch the tree.
      let baseline = null
      if (graded) {
        try {
          baseline = await runner.baseline({ spec: acceptanceSpec, workdir: worktree.path })
        } catch (error) {
          throw hostError(HOST_EXECUTOR_ACCEPTANCE,
            `the acceptance baseline could not be frozen for ${trial.trialId}: ${error?.message ?? error}`)
        }
      }

      // 2. Explainable session choice per step. The rule table is driven by the
      //    REAL prior step/session, never by the arm name alone.
      const chain = Array.isArray(task.chain) && task.chain.length > 1 ? task.chain : null
      const steps = typeof resolveSteps === 'function'
        ? resolveSteps({ trial, task, manifest, plan, worktree })
        : resolveTrialSteps({ manifest, trial, task })
      const stepResults = []
      const sessions = []
      let prior = null
      let error = null
      let featureSet = {}
      let capabilitySet = {}
      let sessionDecision = null
      for (const step of steps) {
        const decisionInput = {
          trial, task, manifest, plan, worktree,
          step: step.step, stepId: step.id, stepIndex: step.index, role: step.role,
          prior, ctx: host,
        }
        featureSet = typeof resolveFeatures === 'function'
          ? resolveFeatures(decisionInput)
          : defaultStepFeatures(decisionInput)
        capabilitySet = typeof resolveCapabilities === 'function' ? resolveCapabilities(decisionInput) : (capabilities ?? {})
        let decision = decideSessionAction({ features: featureSet, capabilities: capabilitySet })
        if (trial.arm === 'fresh_handoff' && prior) {
          decision = {
            action: 'new-packet',
            ruleId: 'ARM-FRESH-HANDOFF',
            reasons: ['fresh_handoff always starts a new session and passes an explicit handoff packet'],
            options: ['new-packet'],
          }
        }
        sessionDecision = {
          ...decision,
          roleId: step.roleId ?? null,
          stepId: step.id,
          stepIndex: step.index,
        }
        const prompt = typeof buildPrompt === 'function'
          ? buildPrompt({
            trial, task, manifest, plan, step: step.step, stepId: step.id, stepIndex: step.index,
            role: step.role, roleId: step.roleId, prior, sessionDecision,
          })
          : defaultPromptFor({ trial, task, plan, step: step.step })
        nonEmpty(prompt, `prompt for ${trial.trialId}${step.id ? `/${step.id}` : ''}`)
        const handoff = prior ? {
          sessionId: prior.sessionId,
          stepId: prior.stepId,
          status: prior.status,
          output: prior.output ?? null,
          route: prior.route ?? null,
        } : null
        let request = {
          harness: step.role?.surface ?? configuredHarness ?? task.harness ?? manifest.conditions?.harness ?? undefined,
          model: step.role?.model ?? configuredModel ?? manifest.conditions?.model ?? undefined,
          provider: step.role?.provider ?? manifest.conditions?.provider ?? undefined,
          role: step.role?.id ?? null,
          writer: step.writer === true,
          readOnly: step.writer !== true,
          prompt,
          cwd: worktree.path,
          mode: step.writer === true ? mode : 'read-only',
          delivery: 'await',
          timeoutMs,
          sessionAction: sessionDecision.action,
          sessionStrategy: trial.arm ?? trial.strategy ?? null,
          ...(handoff ? { handoff } : {}),
        }
        if (typeof buildRequest === 'function') {
          const overrides = await buildRequest({
            trial, task, manifest, plan, worktree, step: step.step, stepId: step.id, stepIndex: step.index,
            role: step.role, roleId: step.roleId, prior, handoff, sessionDecision, request, ctx: host,
          })
          if (overrides && typeof overrides === 'object') request = { ...request, ...overrides }
        }
        try {
          const payload = await dispatchFn(request, execute, {
            ctx: host, trial, task, worktree, manifest, plan, step, role: step.role, roleId: step.roleId,
            sessionDecision, prior, handoff,
          })
          const result = firstResult(payload)
          if (!result) {
            stepResults.push({ stepId: step.id, roleId: step.roleId ?? null, writer: step.writer === true, status: 'failed', error: 'the dispatcher returned no result' })
            error = 'the dispatcher returned no result'
            break
          }
          const status = executionFromStatus(result.status)
          stepResults.push({
            stepId: step.id,
            roleId: step.roleId ?? null,
            writer: step.writer === true,
            sessionId: result.sessionId ?? null,
            sessionAction: sessionDecision.action,
            actualAction: result.actualAction ?? null,
            output: text(result.output) ? result.output : null,
            status,
            dispatchStatus: result.status ?? null,
            harnessId: result.harnessId ?? null,
            managed: result.managed ?? null,
            code: result.code ?? null,
            error: text(result.error) ? result.error : null,
            actualActions: Array.isArray(result.actualActions) ? result.actualActions : [],
            interventions: Array.isArray(result.interventions) ? result.interventions : [],
            attempts: Array.isArray(result.attempts) ? result.attempts.length : 1,
            model: text(result.model) ? result.model : null,
            provider: text(result.provider) ? result.provider : null,
            changedFiles: step.writer === true && Array.isArray(result.changedFiles) ? result.changedFiles : [],
          })
          sessions.push({
            stepId: step.id,
            roleId: step.roleId ?? null,
            writer: step.writer === true,
            sessionId: result.sessionId ?? null,
            decision: sessionDecision.action,
            actualAction: result.actualAction ?? null,
            route: stepRoute(result, step.role),
          })
          prior = {
            sessionId: result.sessionId ?? null,
            stepId: step.id,
            status,
            output: text(result.output) ? result.output : null,
            route: stepRoute(result, step.role),
            permission: step.writer === true ? 'workspace-write' : 'read-only',
            workspace: worktree.path,
          }
          if (status !== 'completed') {
            error = text(result.error)
              ? `dispatch step ${step.id ?? step.index} ended ${status}: ${result.error}`
              : `dispatch step ${step.id ?? step.index} ended ${status}`
            break
          }
        } catch (caught) {
          const status = caught?.code === 'OMC/CLI-CANCELLED' ? 'cancelled' : 'failed'
          stepResults.push({ stepId: step.id, roleId: step.roleId ?? null, writer: step.writer === true, status, dispatchStatus: status, error: caught?.message ?? String(caught), attempts: 1 })
          error = caught?.message ?? String(caught)
          break
        }
      }

      const statuses = stepResults.map((row) => row.status)
      const execution = statuses.length !== steps.length
        ? (statuses.length ? statuses.at(-1) : 'unknown')
        : (statuses.every((status) => status === 'completed') ? 'completed' : statuses.find((status) => status !== 'completed') ?? 'unknown')

      // 4. Independent acceptance verdict. It is only produced when the run
      //    actually completed; a failed/cancelled run can never pass.
      let verdict = null
      let acceptance
      if (execution === 'completed' && graded) {
        try {
          verdict = await runner.run({ spec: acceptanceSpec, workdir: worktree.path, baseline, timeoutMs })
        } catch (caught) {
          throw hostError(HOST_EXECUTOR_ACCEPTANCE,
            `the acceptance verdict could not be produced for ${trial.trialId}: ${caught?.message ?? caught}`)
        }
        const passed = verdict?.passed === true
        acceptance = {
          state: passed ? 'passed' : 'failed',
          evidenceKind: 'external-tests',
          evidenceRef: `acceptance-runner:${acceptanceSpec.taskId ?? trial.taskId}:${verdict?.fingerprint ?? trial.trialId}`,
          criticalRegression: false,
          falseCompletion: false,
        }
      } else if (!graded) {
        acceptance = { state: 'unknown', evidenceKind: 'unknown', evidenceRef: null, criticalRegression: false, falseCompletion: false }
      } else if (execution === 'unknown') {
        acceptance = { state: 'unknown', evidenceKind: 'unknown', evidenceRef: null, criticalRegression: false, falseCompletion: false }
      } else {
        // A real terminal failure is itself evidence that the trial did not
        // deliver; it is never evidence that a completed run passed grading.
        acceptance = {
          state: 'failed',
          evidenceKind: 'runtime-terminal',
          evidenceRef: `execution:${trial.trialId}:${execution}`,
          criticalRegression: false,
          falseCompletion: false,
        }
      }

      const rollup = ledgerRollup({ usageLedger, parentId: parent, taskId: ledgerTaskId })
      const endedAt = iso(now()) ?? now()
      const startMs = Date.parse(startedAt)
      const endMs = Date.parse(endedAt)
      const elapsedMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null
      const actualActions = stepResults.flatMap((row) => row.actualActions ?? [])
      const interventions = stepResults.flatMap((row) => row.interventions ?? [])
      const attempts = stepResults.reduce((sum, row) => sum + (Number.isSafeInteger(row.attempts) ? row.attempts : 1), 0) || null
      const observedModels = [...new Set(stepResults.map((row) => row.model).filter((value) => text(value)))]
      const harnesses = [...new Set(stepResults.map((row) => row.harnessId).filter((value) => text(value)))]
      const checkpoint = tracker && parent ? tracker.checkpoint({ parentId: parent, taskId: ledgerTaskId }) : null
      const collectionCoverage = coverageFor({ rollup, execution })

      return {
        version: HOST_EXECUTOR_VERSION,
        ok: execution === 'completed' && acceptance.state !== 'failed',
        execution,
        acceptance,
        ...(verdict ? { acceptanceVerdict: { passed: verdict.passed === true, fingerprint: verdict.fingerprint ?? null, reason: verdict.reason ?? null } } : {}),
        // Unknown stays null, never 0.
        calls: rollup.calls,
        costUsd: rollup.costUsd,
        costBasis: rollup.costBasis,
        costVersion: rollup.costVersion,
        usage: rollup.usage,
        collectionCoverage,
        unknownCost: rollup.costUsd === null,
        unknownCalls: rollup.calls === null,
        model: observedModels.length === 1 ? observedModels[0] : null,
        configuredModel: configuredModel ?? manifest.conditions?.model ?? null,
        models: observedModels,
        harness: harnesses.length === 1 ? harnesses[0] : (configuredHarness ?? task.harness ?? manifest.conditions?.harness ?? null),
        harnesses,
        startedAt,
        endedAt,
        elapsedMs,
        baseCommit: actualBase ?? expectedBase,
        branch: worktree.branch ?? null,
        repositoryRoot: worktree.repositoryRoot ?? null,
        group: manifest.experimentGroup ?? null,
        arm,
        taskId: trial.taskId,
        trialId: trial.trialId,
        policyVersion: trial.policyVersion ?? manifest.policyVersions?.[arm] ?? null,
        actualActions,
        changedFiles: [...new Set(stepResults.flatMap((row) => row.writer === true ? (row.changedFiles ?? []) : []))].sort(),
        interventions,
        humanInterventions: interventions.length,
        attempts,
        chainSteps: chain ? stepResults.map((row) => ({ stepId: row.stepId, status: row.status })) : [],
        steps: stepResults.map((row) => ({
          stepId: row.stepId,
          roleId: row.roleId ?? null,
          writer: row.writer === true,
          status: row.status,
          sessionId: row.sessionId ?? null,
          sessionAction: row.sessionAction ?? null,
          actualAction: row.actualAction ?? null,
          provider: row.provider ?? null,
          model: row.model ?? null,
          changedFiles: row.writer === true ? (row.changedFiles ?? []) : [],
        })),
        sessions,
        sessionDecisions: sessions.map((row) => ({
          stepId: row.stepId,
          roleId: row.roleId,
          decision: row.decision,
          actualAction: row.actualAction,
          sessionId: row.sessionId,
        })),
        sessionDecision: {
          ...sessionDecision,
          actualAction: sessions.at(-1)?.actualAction ?? sessionDecision?.action ?? null,
          sessionId: sessions.at(-1)?.sessionId ?? null,
          rulesVersion: STRATEGY_RULES_VERSION,
          features: featureSet,
          capabilities: capabilitySet,
        },
        baseline: { fingerprint: baseline?.fingerprint ?? null, acceptanceDigest: baseline?.acceptanceDigest ?? null, at: baseline?.at ?? null },
        budget: {
          totalUsd: Number.isFinite(budget.totalUsd) ? budget.totalUsd : null,
          perTrialUsd,
          remainingUsd,
          spentUsd: Number.isFinite(budget.spentUsd) ? budget.spentUsd : null,
          checkpoint,
        },
        ...(prerequisite ? { prerequisite: true, countedAsTrial: false, role: 'prerequisite' } : {}),
        ...(error ? { error } : {}),
        surface: surface ?? (dispatch ? 'injected-dispatch' : 'managed-dispatch'),
      }
    } finally {
      if (tracker && parent && reservation) {
        try {
          tracker.releaseAttempt(ledgerTaskId, `${trial.trialId}#host`)
        } catch {
          // A failed release must not rewrite an already produced outcome.
        }
      }
    }

    function harnessSignal() {
      const agent = callerAgent && typeof callerAgent === 'object'
        ? callerAgent
        : parent && typeof parent === 'object' ? parent : null
      if (signal && typeof signal === 'object') return { agent, signal }
      const controller = new AbortController()
      return { agent, signal: controller.signal }
    }
  }

  return {
    version: HOST_EXECUTOR_VERSION,
    contract: HOST_EXECUTOR_CONTRACT,
    runTrial,
  }
}

/** Convenience: the `runTrial` callback alone, ready for `executePlan({runTrial})`. */
export function createHostRunTrial(deps = {}) {
  return createHostExecutor(deps).runTrial
}
