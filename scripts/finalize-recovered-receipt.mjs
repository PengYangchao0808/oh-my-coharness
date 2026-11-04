/** Finalize a receipt from zero-model post-hoc acceptance records. */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const planPath = resolve(process.argv[2] ?? '')
const preparedPath = resolve(process.argv[3] ?? '')
const oldReceiptPath = resolve(process.argv[4] ?? '')
const outPath = resolve(process.argv[5] ?? '')
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'))
const manifest = plan.manifest
const records = new Map(prepared.records.map((row) => [row.trialId, row]))
const trials = manifest.assignments.map((assignment) => {
  const row = records.get(assignment.trialId)
  if (!row) throw new Error(`missing recovered record ${assignment.trialId}`)
  return row
})
let backup = null
if (oldReceiptPath && existsSync(oldReceiptPath)) {
  backup = oldReceiptPath.replace(/\.json$/, '.pre-recovery.json')
  if (!existsSync(backup)) copyFileSync(oldReceiptPath, backup)
}
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
  budgetCaps: { ...plan.budget, effectiveTotalUsd: plan.budget.totalUsd },
  tasks: manifest.tasks.map((task) => ({
    taskId: task.id, revision: task.revision, repo: task.repo ?? null, baseCommit: task.baseCommit ?? null,
    provenance: task.provenance ?? null, kind: task.kind ?? 'single-turn', ...(task.chain ? { chain: task.chain } : {}),
  })),
  startedAt: new Date().toISOString(),
  aborted: null,
  recovered: true,
  recoveryAttempts: [],
  sourceRecords: {
    prepared: preparedPath,
    previousReceipt: backup,
    note: 'Acceptance was re-run with zero model calls against the retained completed worktrees; execution/usage/calls/models are unchanged from the original attempts.',
  },
  partialHistory: prepared.records.map((row) => ({ trialId: row.trialId, previousReceipt: backup, acceptanceRecovery: true })),
  trials,
  unknownCostTrials: trials.filter((row) => row.costUsd === null).length,
  unknownCost: trials.some((row) => row.costUsd === null),
  limitations: [
    'Post-hoc acceptance uses a baseline reconstructed from the frozen base commit; execution/usage come from the original completed attempts.',
    'Unknown cost/calls remain null; this receipt does not claim a known monetary total.',
  ],
}
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ receipt: outPath, trials: trials.length, passed: trials.filter((row) => row.acceptance === 'passed').length, failed: trials.filter((row) => row.acceptance !== 'passed').length }, null, 2))
