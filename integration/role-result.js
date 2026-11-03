/**
 * One RoleResult shape for external task receipts.
 *
 * Native children get their envelope from `subagent_result`; external tasks
 * keep a receipt object. This module projects the external receipt into the
 * same vocabulary without pretending a running task is complete, and without
 * inventing artifacts or a resolved model the CLI never returned.
 */

export const ROLE_RESULT_STATES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'unknown'])

/** Map a task-registry status onto the common state vocabulary. */
export function roleStateFromTask(status) {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'unknown') return 'unknown'
  return 'failed'
}

/**
 * Project one `integration/tasks.js` view into a RoleResult.
 * @param {object} task - task registry view (`read` with result).
 * @param {{readAt?: string, usage?: object|null, costUsd?: number|null, acceptanceState?: string|null}} [options]
 *   Usage and cost are attached only when the caller holds a real record
 *   (WP02 ledger or registry); they are never inferred from text. The
 *   acceptance verdict stays `unknown` unless an execution-events store
 *   recorded one — execution completion alone never fills it.
 */
export function externalRoleResult(task, { readAt = new Date().toISOString(), usage = null, costUsd = null, acceptanceState = null } = {}) {
  const state = roleStateFromTask(task?.status)
  const result = task?.result ?? null
  const diagnostic = typeof result?.diagnostic === 'string' ? result.diagnostic : ''
  const code = /OMC\/[A-Z0-9-]+/.exec(diagnostic)?.[0] ?? null
  const hasUsage = usage && typeof usage === 'object'
  const acceptance = acceptanceState === 'passed' || acceptanceState === 'failed' ? acceptanceState : 'unknown'
  return {
    taskId: task?.taskId ?? null,
    childId: task?.id ?? null,
    roleId: task?.role ?? null,
    lane: task?.lane ?? null,
    surface: task?.harness ? `provider:${task.harness}` : 'provider',
    harness: task?.harness ?? null,
    // The CLI does not expose a structured model id in every mode; do not
    // fabricate one. A future adapter may fill these fields.
    provider: null,
    model: null,
    resolvedModel: null,
    state,
    // Delivered means execution completed AND acceptance passed (A08);
    // complete below is the execution fact only and stays separately visible.
    complete: state === 'completed',
    acceptanceState: acceptance,
    delivered: state === 'completed' && acceptance === 'passed',
    startedAt: task?.startedAt ?? null,
    endedAt: task?.settledAt ?? null,
    usage: hasUsage ? {
      uncachedInputTokens: usage.uncachedInputTokens ?? null,
      cacheReadTokens: usage.cacheReadTokens ?? null,
      cacheWriteTokens: usage.cacheWriteTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    } : null,
    costUsd: typeof costUsd === 'number' && costUsd >= 0 ? costUsd : null,
    artifacts: [],
    structured: null,
    error: state === 'failed' || state === 'cancelled'
      ? { code, message: diagnostic || null }
      : null,
    readAt,
    ...(task?.unknown ? { unknown: true } : {}),
  }
}

export function renderRoleResult(value) {
  if (!value) return ''
  return [
    `${value.roleId ?? 'role'} ${value.childId ?? ''}`.trim() +
      ` · ${value.surface} · ${value.state}${value.complete ? ' · complete' : ''}`,
    value.error?.code ? `  error: ${value.error.code}${value.error.message ? ' — ' + value.error.message : ''}` : '',
    value.readAt ? `  read at: ${value.readAt}` : '',
  ].filter(Boolean).join('\n')
}
