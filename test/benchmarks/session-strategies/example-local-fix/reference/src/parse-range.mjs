/**
 * Reference fix for example-local-fix.
 *
 * Contract (the same one acceptance/check.mjs asserts):
 *   - "1-3"      -> [1, 2, 3]     inclusive ascending range
 *   - "4"        -> [4]           a single value is a one-element range
 *   - ""         -> []            blank input means "no values"
 *   - "3-1"      -> throws RangeError (descending is not silently reversed)
 *   - "a"        -> throws TypeError  (non-numeric)
 */
export function parseRange(text) {
  const source = String(text).trim()
  if (source === '') return []
  const parts = source.split('-').map((part) => Number(part.trim()))
  if (parts.some((part) => !Number.isInteger(part))) {
    throw new TypeError(`not a numeric range: ${JSON.stringify(source)}`)
  }
  if (parts.length === 1) return [parts[0]]
  const [start, end] = parts
  if (start > end) throw new RangeError(`descending range: ${JSON.stringify(source)}`)
  const out = []
  for (let value = start; value <= end; value += 1) out.push(value)
  return out
}
