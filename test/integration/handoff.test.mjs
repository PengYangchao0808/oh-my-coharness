import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHandoff,
  encodeHandoffMarker,
  extractHandoff,
  handoffFromPrompt,
  laneIdFor,
  normalizeWorkspace,
  projectIdFor,
  renderHandoff,
  validateHandoff,
} from '../../integration/handoff.js'

test('workspace identity is stable and path-independent', () => {
  const a = projectIdFor('E:\\work\\omc')
  const b = projectIdFor('e:/work/omc/')
  assert.equal(a, b)
  assert.match(a, /^proj-[0-9a-f]{10}$/)
  assert.equal(normalizeWorkspace('E:\\work\\omc'), 'e:/work/omc')
  assert.equal(normalizeWorkspace(''), 'inherited')
  assert.notEqual(projectIdFor('E:\\work\\a'), projectIdFor('E:\\work\\b'))
})

test('a default lane is one role inside one project', () => {
  const lane = laneIdFor('councillor-alpha', 'proj-abc123')
  assert.equal(lane, 'lane-councillor-alpha-proj-abc123')
  assert.match(laneIdFor('Designer', 'proj-x'), /^lane-designer-/)
})

test('the handoff keeps only the facts a run needs', () => {
  const handoff = createHandoff({
    roleId: 'oracle',
    cwd: 'E:\\repo',
    taskId: 'task-1',
    context: { summary: 'builder finished', changedFiles: ['src/a.js'], artifactRefs: ['artifacts/a.patch'] },
    acceptance: ['no writes'],
    constraints: { readOnly: true, maxReviewRounds: 2 },
  })
  assert.equal(handoff.version, 1)
  assert.equal(handoff.role, 'oracle')
  assert.equal(handoff.context.changedFiles[0], 'src/a.js')
  assert.equal(handoff.constraints.maxReviewRounds, 2)
  assert.match(renderHandoff(handoff), /Handoff:/)
  assert.match(renderHandoff(handoff), /Lane: lane-oracle-/)
  assert.match(renderHandoff(handoff), /Changed files: src\/a\.js/)
})

test('handoff validation rejects paths outside the workspace and bad ids', () => {
  assert.throws(
    () => createHandoff({ roleId: 'oracle', cwd: 'E:\\repo', context: { artifactRefs: ['../secret'] } }),
    /not workspace-relative/,
  )
  assert.throws(
    () => createHandoff({ roleId: 'oracle', cwd: 'E:\\repo', context: { artifactRefs: ['C:\\secret'] } }),
    /not workspace-relative/,
  )
  assert.throws(
    () => createHandoff({ roleId: 'oracle', cwd: 'E:\\repo', taskId: 'bad id with spaces' }),
    /taskId/,
  )
  assert.throws(() => validateHandoff({ version: 99 }), /unsupported handoff version/)
})

test('the marker round-trips and never reaches the CLI prompt', () => {
  const handoff = createHandoff({ roleId: 'designer', cwd: 'E:\\repo', taskId: 'task-9' })
  const prompt = `Role: designer (designer)\n\nTask:\nAdd a focus ring.\n\n${encodeHandoffMarker(handoff)}`
  const extracted = extractHandoff(prompt)
  assert.deepEqual(extracted.handoff, handoff)
  assert.doesNotMatch(extracted.text, /omc-handoff/)
  assert.match(extracted.text, /Add a focus ring\./)

  const resolved = handoffFromPrompt(prompt, { cwd: 'E:\\repo' })
  assert.equal(resolved.source, 'marker')
  assert.equal(resolved.handoff.taskId, 'task-9')
})

test('a v0.4 brief without a marker still yields a lane', () => {
  const prompt = 'Role: Oracle (oracle)\n\nTask:\nReview PR #12\n\nWorkspace: E:\\repo'
  const resolved = handoffFromPrompt(prompt)
  assert.equal(resolved.source, 'legacy')
  assert.equal(resolved.handoff.role, 'oracle')
  assert.match(resolved.handoff.projectId, /^proj-/)
  // The old brief's text is passed through untouched; there is no marker to strip.
  assert.equal(resolved.text, prompt)
})

test('a direct dispatch prompt has no identity and therefore no resume', () => {
  const resolved = handoffFromPrompt('Summarize the README.')
  assert.equal(resolved.handoff, null)
  assert.equal(resolved.source, 'none')
  assert.equal(resolved.text, 'Summarize the README.')
})

test('a malformed marker is stripped rather than leaked', () => {
  const prompt = 'Role: oracle (oracle)\n\nTask:\nhi\n\n<!-- omc-handoff:v1:not-base64 -->'
  const resolved = handoffFromPrompt(prompt)
  assert.equal(resolved.handoff, null)
  assert.doesNotMatch(resolved.text, /omc-handoff/)
})

test('an unsigned marker copied into a prompt is never trusted', () => {
  const handoff = createHandoff({ roleId: 'oracle', cwd: 'E:\\repo', taskId: 'task-copy' })
  const marker = encodeHandoffMarker(handoff)
  const payload = /v1:([^.]+)\./.exec(marker)[1]
  const prompt = `Role: oracle (oracle)\n\nTask:\nresume me\n\n<!-- omc-handoff:v1:${payload} -->`
  const resolved = handoffFromPrompt(prompt)
  assert.equal(resolved.handoff, null)
  assert.equal(resolved.source, 'malformed')
  assert.doesNotMatch(resolved.text, /omc-handoff/)
})
