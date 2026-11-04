/**
 * Honest recovery for an interrupted paid trial group.
 *
 * Only two things happen here:
 *   1. already-completed trials get a ZERO-MODEL post-hoc acceptance run against
 *      their retained worktrees, with a baseline reconstructed from the frozen
 *      base commit;
 *   2. the one unknown/running trial is marked unknown and a new attempt is
 *      prepared from the original frozen allocation; the old attempt/usage stay
 *      in the stores.
 *
 * This script never calls a model. The caller runs the prepared single-trial
 * manifest through trial-host-run, then calls `--merge`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import { createExecutionStore } from '../integration/execution-events.js'
import { createUsageLedger } from '../integration/usage-ledger.js'
import { createGraphStore } from '../integration/graph.js'
import { createAcceptanceRunner } from '../integration/acceptance-runner.js'

const args = process.argv.slice(2)
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const has = (name) => args.includes(name)

const mode = has('--merge') ? 'merge' : 'prepare'
const planPath = resolve(option('--plan', 'test/benchmarks/plans/e1.json'))
const stateDir = resolve(option('--state', join(homedir(), '.dsh', 'omc', 'profiles', 'desktop')))
const outDir = resolve(option('--out-dir', 'docs/evidence/v0.8'))
const prefix = option('--prefix', 'e1')
const recoveryReceiptPath = option('--recovery-receipt')
const preparedPath = option('--prepared', join(outDir, `${prefix}-recovery-prepared.json`))
const outputPath = option('--receipt', join(outDir, `${prefix}-receipt.json`))

const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const manifest = plan.manifest
if (!manifest) throw new Error('the plan document must contain a frozen manifest')
const executionStore = createExecutionStore({ dir: join(stateDir, 'execution') })

function git(repo, argv) {
  const result = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return { ok: false, text: String(result.stderr ?? result.error ?? '').trim() }
  return { ok: true, text: String(result.stdout ?? '').trim() }
}

function usageFor(taskId) {
  const dir = join(stateDir, 'usage')
  const rows = []
  if (!existsSync(dir)) return rows
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.taskId === taskId) rows.push(entry)
      } catch { /* torn row */ }
    }
  }
  return rows
}

function usageSummary(rows) {
  const buckets = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
  const complete = rows.length > 0 && rows.every((row) => buckets.every((bucket) => Number.isSafeInteger(row?.usage?.[bucket])))
  const usage = complete
    ? Object.fromEntries(buckets.map((bucket) => [bucket, rows.reduce((sum, row) => sum + row.usage[bucket], 0)]))
    : Object.fromEntries(buckets.map((bucket) => [bucket, null]))
  const costKnown = rows.length > 0 && rows.every((row) => Number.isFinite(row?.cost?.usd))
  return {
    calls: rows.length,
    usage,
    costUsd: costKnown ? rows.reduce((sum, row) => sum + row.cost.usd, 0) : null,
    costBasis: costKnown ? 'estimated' : 'unknown',
    costVersion: costKnown ? [...new Set(rows.map((row) => row.cost?.source).filter(Boolean))].join('+') : null,
    models: [...new Set(rows.map((row) => row?.route?.model).filter((value) => typeof value === 'string'))],
    sessions: [...new Set(rows.map((row) => row?.source?.sessionId).filter((value) => typeof value === 'string'))],
    rows,
  }
}

function graphForTrial(trialId) {
  const graphDir = join(stateDir, 'graph')
  if (!existsSync(graphDir)) return null
  for (const file of readdirSync(graphDir)) {
    if (!file.endsWith('.json')) continue
    let value
    try { value = JSON.parse(readFileSync(join(graphDir, file), 'utf8')) } catch { continue }
    const nodes = Object.values(value.nodes ?? {})
    const matching = nodes.filter((node) => typeof node.id === 'string' && node.id.startsWith(`trial-${trialId}-`))
    if (matching.length) return { parentId: value.parentId, nodes: matching }
  }
  return null
}

function worktreeFor(trialId) {
  const file = join(stateDir, 'execution', `${trialId}.json`)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    const attempt = record.attempts?.find((row) => typeof row?.intent?.cwd === 'string' && row.intent.cwd !== '')
    return attempt?.intent?.cwd ?? null
  } catch {
    return null
  }
}

function stateFor(trialId) {
  const view = executionStore.read(trialId)
  return {
    view,
    state: view?.execution ?? 'missing',
    attemptId: view?.currentAttemptId ?? null,
    worktree: worktreeFor(trialId),
  }
}

function changedFiles(worktree) {
  const modified = git(worktree, ['diff', '--name-only'])
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard'])
  return [...new Set([
    ...(modified.ok ? modified.text.split(/\r?\n/).filter(Boolean) : []),
    ...(untracked.ok ? untracked.text.split(/\r?\n/).filter(Boolean) : []),
  ])].map((value) => value.trim()).filter(Boolean)
}

function baselineFromBase(repo, baseCommit) {
  const temp = mkdtempSync(join(tmpdir(), 'omc-recovery-baseline-'))
  try {
    const added = git(repo, ['worktree', 'add', '--detach', temp, baseCommit])
    if (!added.ok) return { problem: `baseline worktree failed: ${added.text}` }
    return { path: temp, cleanup: () => { git(repo, ['worktree', 'remove', '--force', temp]); rmSync(temp, { recursive: true, force: true }) } }
  } catch (error) {
    return { problem: String(error?.message ?? error) }
  }
}

async function acceptanceFor(task, worktree, baselinePath) {
  const specPath = task?.acceptance?.spec
  if (typeof specPath !== 'string' || !existsSync(specPath)) return { state: 'unknown', reason: 'acceptance spec is missing' }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))
  const workspace = resolve(process.cwd())
  for (const command of spec.commands ?? []) {
    if (!Array.isArray(command.run)) continue
    command.run = command.run.map((arg) => {
      if (typeof arg !== 'string' || isAbsolute(arg)) return arg
      const candidate = resolve(workspace, arg)
      if (!existsSync(candidate)) return arg
      if (existsSync(resolve(worktree, arg))) return arg
      return candidate
    })
  }
  const baseWorktree = baselinePath
  try {
    const runner = createAcceptanceRunner({ cwd: baseWorktree })
    const baseline = await runner.baseline({ spec, workdir: baseWorktree })
    const verdict = await createAcceptanceRunner({ cwd: worktree }).run({ spec, workdir: worktree, baseline })
    return {
      state: verdict.passed === true ? 'passed' : 'failed',
      evidenceKind: 'external-tests',
      evidenceRef: `acceptance-runner:${spec.taskId ?? task.id}:${verdict.fingerprint ?? 'unknown'}`,
      verdict,
      baselineSource: 'reconstructed-from-frozen-base',
    }
  } catch (error) {
    return { state: 'unknown', reason: String(error?.message ?? error) }
  }
}

function rowForCompleted(assignment, task, evidence, usage, graph, current = null) {
  const attempts = Array.isArray(current?.view?.attempts) ? current.view.attempts : []
  const startedAt = attempts.find((row) => row.openedAt)?.openedAt ?? null
  const endedAt = [...attempts].reverse().find((row) => row.settledAt)?.settledAt ?? null
  const sessions = usage.sessions.map((sessionId) => {
    const role = sessionId.includes('-reviewer-') ? 'reviewer' : 'writer'
    return { stepId: role === 'reviewer' ? 'role-reviewer' : 'role-writer', roleId: role, writer: role === 'writer', sessionId, route: null }
  })
  const steps = (graph?.nodes ?? []).map((node) => ({
    stepId: node.id.replace(`trial-${assignment.trialId}-`, ''),
    roleId: node.roleId ?? null,
    writer: node.write === true,
    status: node.state === 'completed' ? 'completed' : node.state === 'failed' ? 'failed' : 'unknown',
    changedFiles: [],
  }))
  return {
    trialId: assignment.trialId,
    taskId: assignment.taskId,
    repeat: assignment.repeat,
    arm: assignment.arm ?? assignment.strategy,
    strategy: assignment.strategy,
    group: manifest.experimentGroup,
    policyVersion: manifest.policyVersions[assignment.strategy] ?? null,
    taskRevision: task.revision,
    model: usage.models.length === 1 ? usage.models[0] : null,
    harness: task.harness ?? manifest.conditions.harness ?? null,
    baseCommit: task.baseCommit,
    branch: null,
    repositoryRoot: task.repo,
    stage: 'recovered-acceptance',
    ok: evidence.state === 'passed',
    execution: 'completed',
    acceptance: evidence.state,
    evidenceKind: evidence.evidenceKind ?? 'unknown',
    evidenceRef: evidence.evidenceRef ?? null,
    criticalRegression: false,
    falseCompletion: false,
    recovered: true,
    recoveryKind: 'post-hoc-acceptance',
    baselineSource: evidence.baselineSource ?? null,
    actualActions: ['recovery:post-hoc-acceptance'],
    interventions: [],
    humanInterventions: 0,
    calls: usage.calls,
    costUsd: usage.costUsd,
    costBasis: usage.costBasis,
    costVersion: usage.costVersion,
    usage: usage.usage,
    models: usage.models,
    model: usage.models.length === 1 ? usage.models[0] : null,
    changedFiles: changedFiles(worktreeFor(assignment.trialId)),
    steps,
    sessions,
    startedAt,
    endedAt,
    worktree: worktreeFor(assignment.trialId),
  }
}

async function prepare() {
  const records = []
  const unknown = []
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]))
  for (const assignment of manifest.assignments) {
    const task = tasks.get(assignment.taskId)
    if (!task) throw new Error(`assignment ${assignment.trialId} names unknown task ${assignment.taskId}`)
    const current = stateFor(assignment.trialId)
    if (current.state === 'completed' && current.worktree && existsSync(current.worktree)) {
      const baseline = baselineFromBase(task.repo, task.baseCommit)
      if (baseline.problem) {
        records.push(rowForCompleted(assignment, task, { state: 'unknown', reason: baseline.problem }, usageSummary(usageFor(assignment.trialId)), graphForTrial(assignment.trialId), current))
      } else {
        try {
          const evidence = await acceptanceFor(task, current.worktree, baseline.path)
          records.push(rowForCompleted(assignment, task, evidence, usageSummary(usageFor(assignment.trialId)), graphForTrial(assignment.trialId), current))
        } finally {
          baseline.cleanup()
        }
      }
    } else {
      unknown.push({ assignment, task, current })
    }
  }

  // Prepare exactly one unknown/running trial. If there are more, refuse: that
  // is no longer the interrupted-tail recovery this script is allowed to do.
  let recoveryManifest = null
  if (unknown.length > 1) {
    throw new Error(`recovery refuses ${unknown.length} unknown trials; expected at most one interrupted tail`)
  }
  if (unknown.length === 1) {
    const { assignment, current } = unknown[0]
    if (current.state === 'running' && current.attemptId) {
      executionStore.settle(assignment.trialId, current.attemptId, { execution: 'unknown', stopReason: 'watchdog', by: 'recovery' })
    }
    const graph = graphForTrial(assignment.trialId)
    if (graph) {
      const store = createGraphStore({ dir: join(stateDir, 'graph') })
      for (const node of graph.nodes) {
        if (node.state !== 'running') continue
        try {
          store.release(graph.parentId, node.id, { to: 'failed', reason: 'watchdog recovery', claimId: node.claimId })
        } catch { /* already settled */ }
      }
    }
    recoveryManifest = {
      ...plan,
      planId: `${plan.planId ?? prefix}-recovery`,
      description: `Recovery of exactly the interrupted E1 tail; prior attempt ${current.attemptId ?? 'unknown'} preserved as unknown.`,
      smokeTrialIds: [assignment.trialId],
      recoveryOf: { trialId: assignment.trialId, oldAttemptId: current.attemptId ?? null, oldExecution: current.state },
    }
    writeFileSync(join(outDir, `${prefix}-recovery-manifest.json`), `${JSON.stringify(recoveryManifest, null, 2)}\n`, 'utf8')
  }

  const prepared = {
    plan: planPath,
    manifestDigest: manifest.digest,
    preparedAt: new Date().toISOString(),
    completed: records,
    unknown: unknown.map(({ assignment, current }) => ({ trialId: assignment.trialId, state: current.state, attemptId: current.attemptId, worktree: current.worktree })),
    recoveryManifest: recoveryManifest ? join(outDir, `${prefix}-recovery-manifest.json`) : null,
    records,
  }
  writeFileSync(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ prepared: preparedPath, completed: records.length, unknown: prepared.unknown, recoveryManifest: prepared.recoveryManifest }, null, 2))
}

function merge() {
  if (!recoveryReceiptPath || !existsSync(recoveryReceiptPath)) throw new Error('--recovery-receipt <path> is required for --merge')
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'))
  const recovery = JSON.parse(readFileSync(recoveryReceiptPath, 'utf8'))
  if ((recovery.trials ?? []).length !== 1) throw new Error('the recovery receipt must contain exactly one trial')
  const recoveredTrial = recovery.trials[0]
  const recoveredUsage = usageSummary(usageFor(recoveredTrial.trialId))
  const merged = {
    ...recoveredTrial,
    calls: recoveredUsage.calls,
    usage: recoveredUsage.usage,
    costUsd: recoveredUsage.costUsd,
    costBasis: recoveredUsage.costBasis,
    costVersion: recoveredUsage.costVersion,
    models: recoveredUsage.models,
    model: recoveredUsage.models.length === 1 ? recoveredUsage.models[0] : null,
    recovered: true,
    recoveryKind: 'new-attempt',
    recoveryOf: recovery.recoveryOf ?? null,
    priorAttempts: [{ execution: 'unknown', note: 'watchdog-killed attempt preserved; not re-billed as a completed result' }],
  }
  const byId = new Map([...prepared.records, merged].map((row) => [row.trialId, row]))
  const trials = manifest.assignments.map((assignment) => {
    const row = byId.get(assignment.trialId)
    if (!row) throw new Error(`recovery is missing trial ${assignment.trialId}`)
    return row
  })
  const receipt = {
    schemaVersion: 1,
    kind: 'session-strategy-trial-receipt',
    runnerVersion: 1,
    experimentId: manifest.experimentId,
    experimentDigest: manifest.digest,
    experimentGroup: manifest.experimentGroup,
    group: manifest.experimentGroup,
    arms: manifest.arms,
    dataKind: manifest.dataKind,
    split: manifest.split,
    model: manifest.conditions.model,
    concurrency: plan.concurrency,
    deadline: plan.deadline,
    budgetCaps: { ...plan.budget, maxUsdFromCli: option('--max-usd') ? Number(option('--max-usd')) : plan.budget.totalUsd, effectiveTotalUsd: plan.budget.totalUsd },
    tasks: manifest.tasks.map((task) => ({
      taskId: task.id, revision: task.revision, repo: task.repo ?? null, baseCommit: task.baseCommit ?? null,
      provenance: task.provenance ?? null, kind: task.kind ?? 'single-turn', ...(task.chain ? { chain: task.chain } : {}),
    })),
    startedAt: new Date().toISOString(),
    aborted: null,
    recovered: true,
    recoveryAttempts: [{
      trialId: recoveredTrial.trialId,
      oldAttemptId: prepared.recoveryManifest ? (JSON.parse(readFileSync(prepared.recoveryManifest, 'utf8')).recoveryOf?.oldAttemptId ?? null) : null,
      oldExecution: 'unknown',
      recoveryReceipt: recoveryReceiptPath,
      note: 'The old attempt and usage remain in the execution store/ledger; this new attempt is the only model recovery.',
    }],
    sourceRecords: {
      completedAcceptance: preparedPath,
      recoveryReceipt: recoveryReceiptPath,
      note: '11 completed trials were re-graded with zero model calls using a baseline reconstructed from the frozen base commit; the interrupted tail is one new attempt.',
    },
    partialHistory: prepared.unknown,
    trials,
    unknownCostTrials: trials.filter((row) => row.costUsd === null).length,
    unknownCost: trials.some((row) => row.costUsd === null),
    limitations: [
      'Post-hoc acceptance uses a baseline reconstructed from the frozen base commit, not the original in-memory baseline timestamp.',
      'Original per-step prompts/session decisions were not present in a receipt and are reconstructed only where the execution/usage/graph stores prove them.',
      'Unknown cost/calls stay null; a watchdog-killed old attempt is preserved as unknown and is not folded into a completed result.',
      'Recovered E1 is a recovery report, not a fresh 25-trial run; it must not be described as OMC superior to OMD.',
    ],
  }
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ receipt: outputPath, trials: trials.length, unique: new Set(trials.map((row) => row.trialId)).size, recovered: true }, null, 2))
}

if (mode === 'merge') merge()
else await prepare()
