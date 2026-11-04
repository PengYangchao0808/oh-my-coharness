/**
 * Merge the three authorized E2 fresh_handoff recovery attempts into the
 * original nine-trial receipt without rerunning the six passed trials or the
 * three prerequisites. Old attempts and usage remain in the stores.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const plan = JSON.parse(readFileSync('test/benchmarks/plans/e2.json', 'utf8'))
const manifest = plan.manifest
const receiptPath = resolve('docs/evidence/v0.8/e2-receipt.json')
const original = JSON.parse(readFileSync(receiptPath, 'utf8'))
const backup = resolve('docs/evidence/v0.8/e2-receipt.pre-recovery.json')
if (!existsSync(backup)) copyFileSync(receiptPath, backup)
const state = resolve(process.env.E2_STATE ?? join(homedir(), '.dsh', 'omc', 'profiles', 'desktop'))
const recoveryFiles = (process.env.E2_RECOVERY_RECEIPTS ?? '').split(';').filter(Boolean).map((file) => resolve(file).replace(/\\\\/g, '/'))
const recoveries = new Map()
for (const file of recoveryFiles) {
  const value = JSON.parse(readFileSync(file, 'utf8'))
  const row = value.trials?.[0]
  if (!row) throw new Error(`recovery receipt has no trial: ${file}`)
  recoveries.set(row.trialId, { row, file })
}

function usage(taskId) {
  const rows = []
  const dir = join(state, 'usage')
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
  const buckets = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
  const every = (fn) => rows.length > 0 && rows.every(fn)
  return {
    calls: rows.length,
    usage: every((row) => buckets.every((bucket) => Number.isSafeInteger(row?.usage?.[bucket])))
      ? Object.fromEntries(buckets.map((bucket) => [bucket, rows.reduce((sum, row) => sum + row.usage[bucket], 0)]))
      : Object.fromEntries(buckets.map((bucket) => [bucket, null])),
    costUsd: every((row) => Number.isFinite(row?.cost?.usd)) ? rows.reduce((sum, row) => sum + row.cost.usd, 0) : null,
    costBasis: every((row) => Number.isFinite(row?.cost?.usd)) ? 'estimated' : 'unknown',
    models: [...new Set(rows.map((row) => row?.route?.model).filter((value) => typeof value === 'string'))],
    rows,
  }
}

const recoveryAttempts = []
const partialHistory = []
const trials = original.trials.map((row) => {
  const recovery = recoveries.get(row.trialId)
  if (!recovery) return row
  const used = usage(row.trialId)
  const mergedSteps = [
    ...(Array.isArray(row.steps) ? row.steps.filter((step) => step.status === 'completed') : []),
    ...(Array.isArray(recovery.row.steps) ? recovery.row.steps : []),
  ]
  const mergedSessions = [
    ...(Array.isArray(row.sessions) ? row.sessions : []),
    ...(Array.isArray(recovery.row.sessions) ? recovery.row.sessions : []),
  ]
  recoveryAttempts.push({
    trialId: row.trialId,
    oldReceipt: receiptPath,
    recoveryReceipt: recovery.file,
    reason: 'fresh_handoff duplicate sessionId infrastructure failure',
    newSessionId: recovery.row.steps?.[0]?.sessionId ?? null,
    oldAttemptPreserved: true,
  })
  partialHistory.push({ trialId: row.trialId, oldExecution: row.execution, oldCalls: row.calls ?? null, recoveryReceipt: recovery.file })
  return {
    ...recovery.row,
    recovered: true,
    recoveryKind: 'step-recovery',
    recoveryOf: { oldExecution: row.execution, oldSteps: row.steps ?? [], oldCalls: row.calls ?? null },
    calls: used.calls,
    usage: used.usage,
    costUsd: used.costUsd,
    costBasis: used.costBasis,
    costVersion: null,
    models: used.models,
    model: used.models.length === 1 ? used.models[0] : null,
    steps: mergedSteps,
    sessions: mergedSessions,
    changedFiles: recovery.row.changedFiles ?? row.changedFiles ?? [],
    actualActions: [...new Set([...(row.actualActions ?? []), ...(recovery.row.actualActions ?? [])])],
  }
})

const merged = {
  ...original,
  tasks: manifest.tasks.map((task) => ({
    taskId: task.id, revision: task.revision, repo: task.repo ?? null, baseCommit: task.baseCommit ?? null,
    provenance: task.provenance ?? null, kind: task.kind ?? 'single-turn', ...(task.chain ? { chain: task.chain } : {}),
  })),
  recovered: true,
  recoveryAttempts,
  sourceRecords: {
    originalReceipt: backup,
    recoveryReceipts: [...recoveries.values()].map((entry) => entry.file),
    note: 'Only the three infrastructure-failed fresh_handoff trials were recovered; six passed trials and three prerequisites were not rerun. Old attempts/usage remain in the stores.',
  },
  partialHistory,
  trials,
  unknownCostTrials: trials.filter((row) => row.costUsd === null).length,
  unknownCost: trials.some((row) => row.costUsd === null),
  limitations: [
    ...(Array.isArray(original.limitations) ? original.limitations : []),
    'Recovered fresh_handoff rows use the existing first-step worktree and rerun only the second step; the original failed attempt remains in the execution store/ledger.',
    'The post-hoc recovery step acceptance baseline is the recovery worktree state (after step 1), not a new model rerun of step 1.',
  ],
}
writeFileSync(receiptPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ receipt: receiptPath, trials: trials.length, unique: new Set(trials.map((row) => row.trialId)).size, recovered: recoveryAttempts.length, passed: trials.filter((row) => row.acceptance === 'passed').length, failed: trials.filter((row) => row.acceptance !== 'passed').length }, null, 2))
