/**
 * Start state for example-local-fix: a plausible but WRONG range parser.
 *
 * Bug: the loop uses `< end`, so an inclusive range loses its last value.
 * Single values and error cases are not handled at all. The reference fix in
 * ../../reference/src/parse-range.mjs is what acceptance must reward.
 */
export function parseRange(text) {
  const [start, end] = String(text).split('-').map(Number)
  const out = []
  for (let value = start; value < end; value += 1) out.push(value)
  return out
}
