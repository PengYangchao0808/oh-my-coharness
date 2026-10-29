/**
 * External task brief.
 *
 * Native role children receive their persona through DSH's `agent/created`
 * hook (role-composition.js). An external CLI is not a DSH child at all: it
 * gets one self-contained prompt, so the role must travel inside that prompt —
 * otherwise `subagent_oracle` would launch Codex with no Oracle instructions and
 * that false success is exactly the compatibility failure this module prevents.
 *
 * The persona is the SAME text the native child receives. Only DSH-tool-specific
 * paragraphs are replaced: an external CLI has its own file/search tools, so
 * telling it to call `read`/`grep` would be false, while its engineering
 * responsibilities and read-only boundary must survive.
 */

import { executionProviderName } from './execution.js'

/** Persona sections that describe DSH tools rather than the role itself. */
const DSH_TOOL_SECTIONS = [
  /^\*\*File Operations Rules\*\*:/,
  /^\*\*Tools to Use\*\*:/,
]

/**
 * Replace DSH-tool instructions with an explicit external-environment section.
 * All other persona paragraphs are preserved verbatim.
 *
 * @param persona - composeRolePersona() output (role body + user append).
 * @param context - { harness, readOnly }
 * @returns the adapted persona text.
 */
export function adaptPersonaForExternal(persona, { harness, readOnly } = {}) {
  const paragraphs = String(persona ?? '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !DSH_TOOL_SECTIONS.some((pattern) => pattern.test(part)))
    // Council personas spell out the DSH tools by name. External seats use
    // their CLI's own tools; keep the capability, replace the tool list.
    .map((part) => part.replace(
      /You have read-only access to the codebase: read, glob, grep\./g,
      'You have read-only access to the workspace through your own CLI tools.',
    ))

  const readOnlyLine = readOnly === 'enforced'
    ? 'Read-only is enforced by this CLI\'s own sandbox/approval flag. Do not modify files, create commits, or run mutating commands.'
    : 'Read-only is a policy, not a sandbox: this CLI may still be able to write. Do not modify files, create commits, or run mutating commands; report if the task cannot be completed read-only.'
  const environment = [
    `**Execution environment**: You are running as an external CLI (${harness ?? 'unknown harness'}) launched by Oh My CoHarness. You cannot see the DSH conversation and cannot call DSH tools (\`read\`, \`glob\`, \`grep\`, \`edit\`, \`write\`, \`bash\`, \`pwsh\`, \`subagent_*\`). Use this CLI's own file and search tools instead. ${readOnlyLine}`,
    'Do not delegate to other agents, do not ask the orchestrator a follow-up question, and do not claim work you did not do. Return one final report; the orchestrator cannot resume this run.',
  ].join(' ')

  return [...paragraphs, environment].join('\n\n')
}

/**
 * Build the complete task text for one external role run.
 *
 * @param {{
 *   roleId: string, roleTitle?: string, persona: string, task: string,
 *   harness: string, readOnly?: 'enforced'|'advisory', cwd?: string,
 *   constraints?: string[],
 * }} input
 * @returns the external brief.
 */
export function buildExternalBrief({
  roleId,
  roleTitle,
  persona,
  task,
  harness,
  readOnly = 'advisory',
  cwd,
  constraints = [],
}) {
  const adapted = adaptPersonaForExternal(persona, { harness, readOnly })
  const blocks = [
    `Role: ${roleTitle ?? roleId} (${roleId})`,
    '',
    'You are a specialist subagent. The orchestration layer delegated this task to you; it will read only your final report.',
    '',
    'Role instructions:',
    adapted,
    '',
    'Task:',
    String(task ?? '').trim() || '(no task text was supplied — report that the delegation was empty instead of inventing work)',
    '',
    'Constraints:',
    ...(constraints.length > 0 ? constraints.map((line) => `- ${line}`) : ['- Stay inside the delegated task and its workspace.']),
    `- Execution backend: ${executionProviderName(harness)} (external CLI).`,
    `- Read-only level: ${readOnly}.`,
    '',
    `Workspace: ${cwd ?? 'the working directory the orchestrator launched this CLI in'}`,
    '',
    'Return:',
    '- Summary',
    '- Evidence (files, commands, outputs)',
    '- Files inspected or changed',
    '- Verification performed and its result',
    '- Remaining uncertainty',
  ]
  return blocks.join('\n')
}

/**
 * Default constraints appended to every external role brief. Callers may add
 * role-specific entries, but cannot remove these.
 */
export function defaultExternalConstraints(roleId) {
  const shared = [
    'Do not modify files, configuration, or git state.',
    'Do not spawn or delegate to other agents.',
    'If the task needs information you cannot access, say so; do not invent it.',
  ]
  if (roleId.startsWith('councillor-')) {
    shared.push('You are one independent council seat: do not try to infer or imitate the other seats.')
  }
  if (roleId === 'oracle') {
    shared.push('Act as a reviewer/advisor: produce analysis and recommendations, not an implementation.')
  }
  if (roleId === 'explorer') {
    shared.push('Act as a codebase reconnaissance specialist: return paths, symbols, and concise evidence.')
  }
  return shared
}
