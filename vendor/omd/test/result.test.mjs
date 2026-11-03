import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleResult, latestOwnAssistant } from '../npm-package/preset/subagent-result.js';
const message = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const descriptor = (seq, roleId) => ({ seq, type: 'subagent/descriptor', data: { label: roleId + ' · task' } });
test('fork result never reports an inherited parent message as a child answer', () => {
  assert.equal(latestOwnAssistant({ events: [message(0, 'parent')], inheritedEventCount: 1 }), undefined);
});
test('latest own nonempty assistant message is returned', () => {
  assert.deepEqual(latestOwnAssistant({ events: [message(0, 'parent'), message(1, 'child'), message(2, '')], inheritedEventCount: 1 }), { kind: 'result', seq: 1, text: 'child' });
});

test('RoleResult names the role, the observed state and that settlement is unproven', () => {
  const snapshot = {
    events: [descriptor(0, 'oracle'), message(1, 'review done')],
    inheritedEventCount: 0,
    capturedThroughSeq: 1,
  };
  const result = buildRoleResult(snapshot, 'child-1', '2026-11-02T00:00:00.000Z');
  assert.equal(result.kind, 'result');
  assert.equal(result.roleId, 'oracle');
  assert.equal(result.state, 'message-observed');
  assert.equal(result.complete, false);
  assert.equal(result.capturedThroughSeq, 1);
  assert.equal(result.readAt, '2026-11-02T00:00:00.000Z');
});

test('a child without an own message is an explicit unknown, not a completion', () => {
  const result = buildRoleResult({ events: [descriptor(0, 'fixer')], capturedThroughSeq: 0 }, 'child-2');
  assert.equal(result.kind, 'no-assistant-message');
  assert.equal(result.roleId, 'fixer');
  assert.equal(result.state, 'unknown');
  assert.equal(result.complete, false);
});
