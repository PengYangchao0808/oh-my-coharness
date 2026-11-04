/**
 * Start state for the E2 shared prerequisite (session primer).
 *
 * Bug: the brief keeps the caller's ordering and status spelling, so two
 * sessions that received the same tasks can still describe them differently.
 * The reference fix (../reference) is what acceptance/check.mjs rewards.
 */
export function summariseTasks(tasks) {
  return tasks.map((task) => `${task.id}: ${task.status ?? ''}`).join('\n')
}
