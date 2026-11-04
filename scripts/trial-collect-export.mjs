/**
 * Export one real trial receipt into collector records and (when the whole
 * frozen allocation was executed) an offline strategy-eval report.
 *
 * This is a read-only consumer of the host's evidence:
 *   node scripts/trial-collect-export.mjs --plan <plan.json> --receipt <receipt.json> `
 *     --out-dir docs/evidence/v0.8 --prefix e1 [--state <desktop state dir>]
 *
 * Unknown usage/cost stays null; a subset smoke receipt produces records and
 * explicit export problems, never a fabricated full-experiment report.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { createExecutionStore } from '../integration/execution-events.js'
import { createUsageLedger } from '../integration/usage-ledger.js'
import { collectTrial, exportTrials } from '../integration/trial-collector.js'
import { evaluateStrategyExperiment } from '../integration/strategy-eval.js'

const args = process.argv.slice(2)
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const planPath = option('--plan')
const receiptPath = option('--receipt')
const outDir = resolve(option('--out-dir', 'docs/evidence/v0.8'))
const prefix = option('--prefix', 'trial')
const stateDir = resolve(option('--state', join(homedir(), '.dsh', 'omc', 'profiles', 'desktop')))
assert.ok(planPath && existsSync(planPath), '--plan <path> is required')
assert.ok(receiptPath && existsSync(receiptPath), '--receipt <path> is required')

const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const manifest = plan.manifest ?? plan.spec?.manifest ?? null
assert.ok(manifest && typeof manifest === 'object', 'the plan document must contain a frozen manifest')
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
const executionStore = createExecutionStore({ dir: join(stateDir, 'execution') })
const usageLedger = createUsageLedger({ dir: join(stateDir, 'usage') })

const receipts = [...(receipt.trials ?? []), ...(receipt.prerequisites ?? [])]
const receiptTaskIds = new Set(receipts.map((row) => row?.trialId).filter((value) => typeof value === 'string'))
const parentByTrial = new Map()
const usageDir = join(stateDir, 'usage')
for (const file of existsSync(usageDir) ? readdirSync(usageDir) : []) {
  if (!file.endsWith('.jsonl')) continue
  for (const line of readFileSync(join(usageDir, file), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (receiptTaskIds.has(entry?.taskId) && typeof entry?.parentId === 'string') {
        parentByTrial.set(entry.taskId, entry.parentId)
      }
    } catch { /* torn row */ }
  }
}
const parentId = [...parentByTrial.values()].find((value) => value) ?? null

const collected = []
const collection = []
for (const row of receipt.trials ?? []) {
  const assignment = (manifest.assignments ?? []).find((entry) => entry.trialId === row.trialId) ?? null
  const result = collectTrial({
    parentId: parentByTrial.get(row.trialId) ?? parentId,
    taskId: row.trialId,
    assignment,
    strategy: row.strategy ?? assignment?.strategy ?? null,
    usageLedger,
    executionStore,
    manifest,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    interventions: Array.isArray(row.interventions) ? row.interventions : [],
    acceptance: {
      state: row.acceptance,
      evidenceKind: row.evidenceKind ?? null,
      evidenceRef: row.evidenceRef ?? null,
      criticalRegression: row.criticalRegression === true,
      falseCompletion: row.falseCompletion === true,
    },
    actualActions: Array.isArray(row.actualActions) ? row.actualActions : [],
    ...(receipt.prerequisites ? { prerequisites: receipt.prerequisites } : {}),
  })
  collected.push(result.trial)
  collection.push({ trialId: row.trialId, incomplete: result.incomplete, notes: result.notes })
}

const exported = exportTrials({ manifest, collected })
const base = join(outDir, `${prefix}-records.json`)
writeFileSync(base, `${JSON.stringify({
  plan: resolve(planPath),
  receipt: resolve(receiptPath),
  manifestDigest: manifest.digest,
  parentId,
  collected: collection,
  export: exported,
  records: exported.trials,
}, null, 2)}\n`, 'utf8')

if (exported.complete) {
  const report = evaluateStrategyExperiment(manifest, exported.trials, { bootstrapIterations: 1000 })
  writeFileSync(join(outDir, `${prefix}-report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ records: exported.trials.length, complete: true, problems: exported.problems, report: report.summary ?? null }, null, 2))
} else {
  writeFileSync(join(outDir, `${prefix}-report.json`), `${JSON.stringify({
    complete: false,
    problems: exported.problems,
    note: 'A subset/smoke receipt cannot be evaluated as a full frozen experiment; this report is intentionally not a promotion verdict.',
  }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ records: exported.trials.length, complete: false, problems: exported.problems }, null, 2))
}
