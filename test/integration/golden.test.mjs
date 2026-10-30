/**
 * v0.4 golden invariants that v0.5 must not regress.
 *
 * These are deliberately about contracts, not implementation details: the
 * native default, the external read-only boundary, the designer patch mode and
 * the fact that a session marker never changes the task text a CLI receives.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { COMPATIBLE_ROLE_IDS, EXTERNAL_ROLE_IDS, NATIVE_ONLY_ROLE_IDS, validateExecution } from '../../integration/compatibility.js'
import { resolveExecution } from '../../integration/execution.js'
import { buildExternalBrief, defaultExternalConstraints } from '../../integration/external-brief.js'
import { createHandoff, encodeHandoffMarker, handoffFromPrompt } from '../../integration/handoff.js'

const ALL_PROVIDERS = [
  'spawn',
  'fork',
  'omc:codex',
  'omc:claude',
  'omc:gemini',
  'omc:kimi',
  'omc:opencode',
  'omc:antigravity',
  'omc:glm',
]

test('every role still defaults to native', () => {
  for (const roleId of COMPATIBLE_ROLE_IDS) {
    const resolved = resolveExecution(roleId, {}, ALL_PROVIDERS)
    assert.equal(resolved.backend, 'native', roleId)
    assert.equal(resolved.blocked, false, roleId)
    assert.equal(resolved.mode, null, roleId)
  }
})

test('the external role matrix is unchanged by v0.5', () => {
  for (const roleId of EXTERNAL_ROLE_IDS) {
    const validated = validateExecution(roleId, { execution: { backend: 'omc', harness: 'codex' } })
    assert.equal(validated.mode, roleId === 'designer' ? 'patch' : 'read-only', roleId)
    const resolved = resolveExecution(roleId, { execution: { backend: 'omc', harness: 'codex' } }, ALL_PROVIDERS)
    assert.equal(resolved.backend, 'omc', roleId)
    assert.equal(resolved.blocked, false, roleId)
  }
  for (const roleId of NATIVE_ONLY_ROLE_IDS) {
    assert.throws(
      () => validateExecution(roleId, { execution: { backend: 'omc', harness: 'codex' } }),
      /cannot use an external backend/,
      roleId,
    )
  }
})

test('a handoff marker adds identity without changing the task a CLI receives', () => {
  const handoff = createHandoff({
    roleId: 'oracle',
    cwd: 'E:\\repo',
    taskId: 'task-golden',
    context: { changedFiles: ['src/provider.js'] },
    acceptance: ['No writes'],
  })
  const task = 'Review the session router.'
  const brief = buildExternalBrief({
    roleId: 'oracle',
    roleTitle: 'oracle',
    persona: 'You are Oracle - a strategic technical advisor.',
    task,
    harness: 'codex',
    readOnly: 'enforced',
    cwd: 'E:\\repo',
    constraints: defaultExternalConstraints('oracle'),
    handoff,
  })

  assert.match(brief, /^Role: oracle \(oracle\)/m)
  assert.match(brief, /Task:\nReview the session router\./)
  assert.match(brief, /Handoff:/)
  assert.match(brief, /Changed files: src\/provider\.js/)
  assert.match(brief, /<!-- omc-handoff:v1:/)

  const resolved = handoffFromPrompt(brief, { cwd: 'E:\\repo' })
  assert.equal(resolved.source, 'marker')
  assert.equal(resolved.handoff.taskId, 'task-golden')
  assert.doesNotMatch(resolved.text, /omc-handoff/)
  assert.match(resolved.text, /Review the session router\./)
})

test('a marker cannot smuggle a path outside the workspace', () => {
  const handoff = createHandoff({ roleId: 'oracle', cwd: 'E:\\repo' })
  const poisoned = { ...handoff, context: { ...handoff.context, artifactRefs: ['../../etc/passwd'] } }
  // Validation happens before signing, so a poisoned record never becomes a marker.
  assert.throws(() => encodeHandoffMarker(poisoned), /not workspace-relative/)
})
