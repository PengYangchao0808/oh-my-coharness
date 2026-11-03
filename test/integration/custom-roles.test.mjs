import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { mkdir, writeFile } from 'node:fs/promises'
import { buildRolePrompt, createCustomRoles, readProjectRoles } from '../../integration/custom-roles.js'

test('custom roles are durable, validated and read-only by construction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-roles-'))
  try {
    const first = createCustomRoles({ dir })
    const role = first.add({
      id: 'security-reviewer',
      title: 'Security reviewer',
      persona: 'Review for authz and injection bugs.',
      harness: 'codex',
    })
    assert.equal(role.readOnly, true)
    assert.equal(role.mode, 'read-only')
    assert.equal(role.harness, 'codex')

    const second = createCustomRoles({ dir })
    assert.equal(second.list().length, 1)
    assert.equal(second.get('security-reviewer').persona, 'Review for authz and injection bugs.')
    assert.equal(second.remove('security-reviewer'), true)
    assert.equal(second.get('security-reviewer'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid ids, personas and harnesses are refused', () => {
  const roles = createCustomRoles()
  assert.throws(() => roles.add({ id: 'Bad Id', persona: 'x', harness: 'codex' }), /role id/)
  assert.throws(() => roles.add({ id: 'ok', persona: '', harness: 'codex' }), /persona is required/)
  assert.throws(() => roles.add({ id: 'ok', persona: 'x', harness: 'not a harness' }), /harness/)
  roles.add({ id: 'ok', persona: 'x', harness: 'codex' })
  assert.throws(() => roles.add({ id: 'ok', persona: 'x', harness: 'codex' }), /already exists/)
})

test('custom role fallbacks are deduped, validated and never make the role writable', () => {
  const roles = createCustomRoles()
  const role = roles.add({
    id: 'reviewer', persona: 'Review.', harness: 'codex', model: 'gpt-5',
    fallbacks: ['opencode', 'codex', 'opencode'],
  })
  assert.deepEqual(role.fallbacks, ['opencode'])
  assert.equal(role.model, 'gpt-5')
  assert.equal(role.readOnly, true)
  assert.throws(() => roles.add({
    id: 'bad-fallback', persona: 'Review.', harness: 'codex', fallbacks: ['not a harness'],
  }), /fallback harness/)
})

test('the role prompt keeps the external read-only contract and task separate', () => {
  const prompt = buildRolePrompt({
    title: 'Reviewer',
    persona: 'You review code.',
  }, 'Review the session router.')
  assert.match(prompt, /Role: Reviewer/)
  assert.match(prompt, /You review code\./)
  assert.match(prompt, /Do not modify files/)
  assert.match(prompt, /Task:\nReview the session router\./)
})

test('project roles are read-only and invalid entries are skipped with warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-project-roles-'))
  try {
    await mkdir(join(dir, '.omc'), { recursive: true })
    await writeFile(join(dir, '.omc', 'roles.json'), JSON.stringify([
      { id: 'docs-reviewer', title: 'Docs reviewer', persona: 'Review docs.', harness: 'codex' },
      { id: 'BAD ID', persona: 'x', harness: 'codex' },
      { id: 'writable', persona: 'x', harness: 'codex', readOnly: false },
    ]), 'utf8')
    const result = readProjectRoles(dir)
    assert.equal(result.exists, true)
    assert.equal(result.roles.length, 2)
    assert.ok(result.roles.every((role) => role.readOnly === true))
    assert.ok(result.roles.every((role) => role.source === 'project'))
    assert.ok(result.warnings.some((warning) => warning.includes('role id')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a relative or missing project path has no roles', () => {
  assert.deepEqual(readProjectRoles('relative/path').roles, [])
  assert.deepEqual(readProjectRoles(join(tmpdir(), 'omc-no-project-' + Date.now())).roles, [])
})

test('custom role count is bounded', () => {
  const roles = createCustomRoles({ maxRoles: 2 })
  roles.add({ id: 'one', persona: 'x', harness: 'codex' })
  roles.add({ id: 'two', persona: 'x', harness: 'codex' })
  assert.throws(() => roles.add({ id: 'three', persona: 'x', harness: 'codex' }), /at most 2/)
})
