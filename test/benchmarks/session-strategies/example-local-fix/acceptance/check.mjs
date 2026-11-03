#!/usr/bin/env node
/**
 * FIXED acceptance definition for example-local-fix.
 *
 * This file is not part of the worker's write scope. The acceptance runner
 * digests it before and after the run (OMC/ACCEPTANCE-TAMPERED) and
 * `forbidChanges` refuses a delivery that touched it. The worker may add its
 * own tests; it may not move this finish line.
 *
 * It is deliberately tiny and dependency-free: one import, seven cases, an
 * `ok N/N` / `fail N/N` line and an exit code. Behaviour only — no rubric.
 */
import { parseRange } from '../src/parse-range.mjs'

const cases = [
  { label: '1-3', run: () => parseRange('1-3'), expected: [1, 2, 3] },
  { label: '4', run: () => parseRange('4'), expected: [4] },
  { label: '0-0', run: () => parseRange('0-0'), expected: [0] },
  { label: '  2-4 ', run: () => parseRange('  2-4 '), expected: [2, 3, 4] },
  { label: '3-1', run: () => parseRange('3-1'), throws: RangeError },
  { label: 'a', run: () => parseRange('a'), throws: TypeError },
  { label: '', run: () => parseRange(''), expected: [] },
]

let failed = 0
for (const row of cases) {
  let observed
  try {
    observed = row.run()
  } catch (error) {
    if (row.throws && error instanceof row.throws) continue
    failed += 1
    console.log(`FAIL ${JSON.stringify(row.label)} threw ${error?.constructor?.name ?? 'Error'}: ${error?.message}`)
    continue
  }
  if (row.throws) {
    failed += 1
    console.log(`FAIL ${JSON.stringify(row.label)} returned ${JSON.stringify(observed)} but must throw ${row.throws.name}`)
    continue
  }
  if (JSON.stringify(observed) !== JSON.stringify(row.expected)) {
    failed += 1
    console.log(`FAIL ${JSON.stringify(row.label)} returned ${JSON.stringify(observed)}, expected ${JSON.stringify(row.expected)}`)
  }
}

if (failed > 0) {
  console.log(`fail ${failed}/${cases.length}`)
  process.exit(1)
}
console.log(`ok ${cases.length}/${cases.length}`)
