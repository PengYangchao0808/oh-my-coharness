#!/usr/bin/env node
/**
 * FIXED acceptance definition for the E2 shared prerequisite (session primer).
 *
 * It runs against the delivered src/ in the current working directory and is
 * digested before/after the run by the acceptance runner. Behaviour only.
 */
import { summariseTasks } from '../src/session-brief.mjs'

const cases = []
const check = (label, run, expected) => {
  try {
    const actual = run()
    cases.push({ label, ok: Object.is(actual, expected), actual, expected })
  } catch (error) {
    cases.push({ label, ok: false, actual: `threw ${error?.constructor?.name}`, expected })
  }
}
const throwsType = (label, run) => {
  try {
    run()
    cases.push({ label, ok: false, actual: 'returned', expected: 'TypeError' })
  } catch (error) {
    cases.push({ label, ok: error instanceof TypeError, actual: error?.constructor?.name, expected: 'TypeError' })
  }
}

check('rows are sorted by id', () => summariseTasks([{ id: 'b', status: 'start' }, { id: 'a', status: 'pass' }]), 'a: pass\nb: start')
check('ids and statuses are trimmed and lower-cased', () => summariseTasks([{ id: ' A ', status: ' START ' }]), 'A: start')
check('a missing status becomes empty', () => summariseTasks([{ id: 'a' }]), 'a: ')
check('an empty list is an empty string', () => summariseTasks([]), '')
throwsType('a non-array argument is a TypeError', () => summariseTasks(null))
throwsType('a task without an id is a TypeError', () => summariseTasks([{ status: 'pass' }]))

const failed = cases.filter((row) => !row.ok)
for (const row of failed) console.log(`fail ${row.label}: got ${JSON.stringify(row.actual)}, expected ${JSON.stringify(row.expected)}`)
if (failed.length) {
  console.log(`fail ${cases.length - failed.length}/${cases.length}`)
  process.exit(1)
}
console.log(`ok ${cases.length}/${cases.length}`)
