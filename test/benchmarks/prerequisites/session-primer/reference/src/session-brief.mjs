/**
 * Reference fix for the E2 shared prerequisite (session primer).
 *
 * Contract (the same one acceptance/check.mjs asserts):
 *   - every task needs a non-empty id, otherwise TypeError
 *   - a non-array argument is a TypeError
 *   - ids and statuses are trimmed, statuses lower-cased
 *   - a missing status becomes an empty status
 *   - rows are sorted by id and joined with one newline (empty list -> "")
 */
export function summariseTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array')
  const rows = tasks.map((task) => {
    if (!task || typeof task.id !== 'string' || !task.id.trim()) throw new TypeError('each task needs a non-empty id')
    return `${task.id.trim()}: ${String(task.status ?? '').trim().toLowerCase()}`
  })
  rows.sort()
  return rows.join('\n')
}
