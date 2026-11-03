/**
 * Reference fix for `should-reuse-module-fix`.
 *
 * `truncate(text, max)` must never return more than `max` characters, must keep
 * short text untouched, and must degrade sanely for tiny budgets.
 */

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function truncate(text, max) {
  const value = String(text)
  const limit = Number.isSafeInteger(max) && max >= 0 ? max : 0
  if (value.length <= limit) return value
  if (limit < 2) return value.slice(0, limit)
  return value.slice(0, limit - 1) + '…'
}
