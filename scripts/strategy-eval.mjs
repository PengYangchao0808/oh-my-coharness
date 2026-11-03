#!/usr/bin/env node
// Reads records only. Never runs an agent, grader, or policy update.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStrategyExperiment, evaluateStrategyExperiment } from '../integration/strategy-eval.js'

const help = `OMC offline session-strategy evaluation (no model calls)
  node scripts/strategy-eval.mjs plan SPEC.json MANIFEST.json
  node scripts/strategy-eval.mjs report MANIFEST.json RUNS.json REPORT.json
SPEC and RUNS formats: docs/FEEDBACK-EVOLUTION.zh-CN.md
Output files are created exclusively; an existing output is never overwritten.`
const [action, ...args] = process.argv.slice(2)
if (!action || action === '--help') console.log(help)
else {
  try {
    const expected = action === 'plan' ? 2 : action === 'report' ? 3 : 0
    if (!expected || args.length !== expected) throw new Error(help)
    const load = file => JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, ''))
    const value = action === 'plan' ? createStrategyExperiment(load(args[0])) : evaluateStrategyExperiment(load(args[0]), load(args[1]))
    const output = resolve(args.at(-1))
    writeFileSync(output, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    console.log(JSON.stringify({ output, kind: action, ...(action === 'plan'
      ? { assignedTrials: value.assignments.length, dataKind: value.dataKind }
      : { review: value.review.status, automaticActivation: false }) }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
