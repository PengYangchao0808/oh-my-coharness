import assert from 'node:assert/strict'
import test from 'node:test'

import { externalRoleResult, renderRoleResult, roleStateFromTask } from '../../integration/role-result.js'

test('external task statuses map onto the common RoleResult states', () => {
  assert.equal(roleStateFromTask('running'), 'running')
  assert.equal(roleStateFromTask('completed'), 'completed')
  assert.equal(roleStateFromTask('cancelled'), 'cancelled')
  assert.equal(roleStateFromTask('failed'), 'failed')
  assert.equal(roleStateFromTask('unknown'), 'unknown')
})

test('a completed external receipt becomes a completed RoleResult', () => {
  const value = externalRoleResult({
    id: 'child-1', taskId: 'handoff-1', role: 'oracle', lane: 'lane-1',
    harness: 'codex', status: 'completed', startedAt: 'a', settledAt: 'b',
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] },
  }, { readAt: 'c' })
  assert.equal(value.state, 'completed')
  assert.equal(value.complete, true)
  assert.equal(value.surface, 'provider:codex')
  assert.equal(value.roleId, 'oracle')
  assert.equal(value.error, null)
  assert.equal(value.readAt, 'c')
})

test('a failed receipt carries its CLI code, while unknown stays incomplete', () => {
  const failed = externalRoleResult({
    id: 'child-2', harness: 'codex', status: 'failed', result: { diagnostic: 'OMC/CLI-RATE-LIMIT: 429' },
  })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.complete, false)
  assert.equal(failed.error.code, 'OMC/CLI-RATE-LIMIT')

  const unknown = externalRoleResult({ id: 'child-3', harness: 'codex', status: 'unknown', unknown: true })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.complete, false)
  assert.equal(unknown.unknown, true)
  assert.match(renderRoleResult(unknown), /unknown/)
})
