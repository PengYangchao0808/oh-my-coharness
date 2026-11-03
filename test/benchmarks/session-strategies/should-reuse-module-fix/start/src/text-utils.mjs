/**
 * Task kind: should-reuse.
 *
 * The start state already contains a working `slugify` (the "prior work" the
 * worker would have in context) and a broken `truncate` added afterwards. A
 * worker that resumes with the module's context should keep slugify intact and
 * fix truncate; a fresh worker pays to rediscover the whole module.
 *
 * The bug is behavioural, not stylistic: the start version counts the ellipsis
 * outside `max`, so the result is one character too long.
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
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}
