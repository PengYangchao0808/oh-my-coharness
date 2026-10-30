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
 *
 * Two external modes exist and both forbid writes. `read-only` reports;
 * `patch` designs the change and returns it as a unified diff, which a native
 * role applies. That is how a strong frontend CLI contributes implementation
 * without ever touching the tree.
 */

import { executionProviderName } from './execution.js'

/** Persona sections that describe DSH tools rather than the role itself. */
const DSH_TOOL_SECTIONS = [
  /^\*\*File Operations Rules\*\*:/,
  /^\*\*Tools to Use\*\*:/,
]

/** Anything that is not the explicit patch contract keeps today's read-only brief. */
function normalizeMode(mode) {
  return mode === 'patch' ? 'patch' : 'read-only'
}

/**
 * The workspace boundary sentence of the external environment paragraph.
 *
 * A patch run replaces the "do not modify files" instruction with the patch
 * contract: forbidding writes without offering an output channel would leave
 * the CLI with no way to deliver a design.
 *
 * @param readOnly - `enforced` or `advisory` read-only class of the CLI.
 * @param mode - normalized external mode.
 * @returns the boundary sentence.
 */
function workspaceBoundary(readOnly, mode) {
  if (mode === 'patch') {
    return readOnly === 'enforced'
      ? 'Read-only is enforced by this CLI\'s own sandbox/approval flag: do not create, edit, delete, or move files, do not touch git state, and do not run mutating commands. Design the change and return it as a patch instead.'
      : 'Read-only is a policy, not a sandbox: this CLI may still be able to write. Do not create, edit, delete, or move files, do not touch git state, and do not run mutating commands; design the change and return it as a patch instead.'
  }
  return readOnly === 'enforced'
    ? 'Read-only is enforced by this CLI\'s own sandbox/approval flag. Do not modify files, create commits, or run mutating commands.'
    : 'Read-only is a policy, not a sandbox: this CLI may still be able to write. Do not modify files, create commits, or run mutating commands; report if the task cannot be completed read-only.'
}

/** The patch-output contract appended to a `mode: 'patch'` brief. */
const PATCH_OUTPUT_CONTRACT = [
  'Patch output contract (this run cannot write):',
  '- Do not create, edit, delete, or move any file; do not touch git state (no add, stash, checkout, reset, commit); do not run mutating commands. Design the change and emit it as a patch instead.',
  '- Return exactly ONE fenced ```diff block containing a unified diff. If several files change, concatenate their hunks inside that single block; never emit a second diff block and never put a diff outside it.',
  '- Every path in the patch must be relative to the repository root, and the patch must apply with `git apply -p1` from that root.',
  '- Only use context you actually read; when the surrounding code is unknown, prefer a smaller hunk and state the assumption in the report instead of guessing lines.',
]

/** The `Return:` section of a read-only brief. */
const READ_ONLY_RETURN_LINES = [
  'Return:',
  '- Summary',
  '- Evidence (files, commands, outputs)',
  '- Files inspected or changed',
  '- Verification performed and its result',
  '- Remaining uncertainty',
]

/** The `Return:` section of a patch brief. */
const PATCH_RETURN_LINES = [
  'Return:',
  '- Summary: what the patch changes and why, in one short paragraph.',
  '- Files read: every path you inspected, and the lines or symbols that drove the design.',
  '- The single ```diff block described above.',
  '- Apply and verify: the exact commands the implementer must run, starting with `git apply -p1 <patch-file>`, then this repository\'s own check command and its test command.',
  '- Assumptions: every fact the patch depends on that you could not verify (versions, surrounding code, call sites).',
  '- Remaining uncertainty.',
  '',
  'Report the change as a proposal only. Do not claim it was applied, committed, merged, or verified: a native role applies the patch and owns the result.',
]

/**
 * Replace DSH-tool instructions with an explicit external-environment section.
 * All other persona paragraphs are preserved verbatim.
 *
 * @param persona - composeRolePersona() output (role body + user append).
 * @param context - { harness, readOnly, mode }
 * @returns the adapted persona text.
 */
export function adaptPersonaForExternal(persona, { harness, readOnly, mode = 'read-only' } = {}) {
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

  const environment = [
    `**Execution environment**: You are running as an external CLI (${harness ?? 'unknown harness'}) launched by Oh My CoHarness. You cannot see the DSH conversation and cannot call DSH tools (\`read\`, \`glob\`, \`grep\`, \`edit\`, \`write\`, \`bash\`, \`pwsh\`, \`subagent_*\`). Use this CLI's own file and search tools instead. ${workspaceBoundary(readOnly, normalizeMode(mode))}`,
    'Do not delegate to other agents, do not ask the orchestrator a follow-up question, and do not claim work you did not do. Return one final report; the orchestrator cannot resume this run.',
  ].join(' ')

  return [...paragraphs, environment].join('\n\n')
}

/**
 * Build the complete task text for one external role run.
 *
 * Omitting `mode` reproduces the read-only brief exactly, so callers that do not
 * know about patch mode keep their current output.
 *
 * @param {{
 *   roleId: string, roleTitle?: string, persona: string, task: string,
 *   harness: string, readOnly?: 'enforced'|'advisory', cwd?: string,
 *   mode?: 'read-only'|'patch', constraints?: string[],
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
  mode = 'read-only',
  cwd,
  constraints = [],
}) {
  const externalMode = normalizeMode(mode)
  const adapted = adaptPersonaForExternal(persona, { harness, readOnly, mode: externalMode })
  const patch = externalMode === 'patch'
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
    ...(patch ? ['- External mode: patch — design the change and return a diff; a native role applies it.'] : []),
    '',
    `Workspace: ${cwd ?? 'the working directory the orchestrator launched this CLI in'}`,
    '',
    ...(patch ? PATCH_OUTPUT_CONTRACT : []),
    ...(patch ? ['', ...PATCH_RETURN_LINES] : READ_ONLY_RETURN_LINES),
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
  if (roleId === 'designer') {
    shared.push('You are a read-only design consultant: design the change and return it as a patch, never as an implementation. Do not write files, do not touch git state, and do not run mutating commands; a native implementer applies your patch.')
  }
  return shared
}
