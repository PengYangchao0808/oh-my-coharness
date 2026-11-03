/**
 * Fixed grader for `should-reuse-module-fix`.
 *
 * It runs against the delivered `src/` in the current working directory. It
 * checks behaviour only, so a worker cannot satisfy it by rewriting this file
 * (the runner digests the acceptance files before and after the run).
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const target = pathToFileURL(join(process.cwd(), 'src', 'text-utils.mjs')).href
const { slugify, truncate } = await import(target)

const cases = []
const check = (name, actual, expected) => {
  cases.push({ name, ok: Object.is(actual, expected), actual, expected })
}

check('truncate keeps room for the ellipsis', truncate('abcdef', 4), 'abc…')
check('truncate leaves short text alone', truncate('abc', 5), 'abc')
check('truncate degrades to a single character', truncate('abcdef', 1), 'a')
check('truncate with a zero budget is empty', truncate('abcdef', 0), '')
check('slugify collapses separators', slugify(' Hello  World '), 'hello-world')
check('slugify handles mixed punctuation', slugify('A--B__C'), 'a-b-c')

const failed = cases.filter((row) => !row.ok)
for (const row of failed) {
  console.log(`fail ${row.name}: got ${JSON.stringify(row.actual)}, expected ${JSON.stringify(row.expected)}`)
}
if (failed.length) {
  console.log(`fail ${cases.length - failed.length}/${cases.length}`)
  process.exit(1)
}
console.log(`ok ${cases.length}/${cases.length}`)
