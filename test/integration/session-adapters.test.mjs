import assert from 'node:assert/strict'
import test from 'node:test'

import { harnessDef } from '../../src/harnesses.js'
import {
  maskSessionId,
  normalizeUsage,
  parseSessionOutput,
} from '../../src/session-adapters.js'

const codexStream = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-123' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first answer' } }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 12 },
  }),
].join('\n')

test('Codex JSONL yields the final message, the thread id and usage', () => {
  const parsed = parseSessionOutput('codex-jsonl', codexStream)
  assert.equal(parsed.text, 'first answer')
  assert.equal(parsed.sessionId, 'thread-abc-123')
  assert.deepEqual(parsed.usage, { inputTokens: 120, outputTokens: 12, cachedInputTokens: 80, costUsd: null })
})

test('Codex keeps the last agent message when several are emitted', () => {
  const stream = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'draft' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
  ].join('\n')
  assert.equal(parseSessionOutput('codex-jsonl', stream).text, 'final')
})

test('Claude JSON yields result, session id, cache and cost', () => {
  const parsed = parseSessionOutput('claude-json', JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'claude answer',
    session_id: '11111111-2222-3333-4444-555555555555',
    usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 150 },
    total_cost_usd: 0.002,
  }))
  assert.equal(parsed.text, 'claude answer')
  assert.equal(parsed.sessionId, '11111111-2222-3333-4444-555555555555')
  assert.deepEqual(parsed.usage, { inputTokens: 200, outputTokens: 20, cachedInputTokens: 150, costUsd: 0.002 })
})

test('the generic adapter accepts the shapes other CLIs use', () => {
  const text = parseSessionOutput('generic-json', JSON.stringify({
    session_id: 'session-xyz-789',
    response: 'generic answer',
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }))
  assert.equal(text.text, 'generic answer')
  assert.equal(text.sessionId, 'session-xyz-789')
  assert.deepEqual(text.usage, { inputTokens: 5, outputTokens: 2, cachedInputTokens: null, costUsd: null })
})

test('missing usage stays null, never zero', () => {
  const parsed = parseSessionOutput('claude-json', JSON.stringify({
    type: 'result',
    result: 'no usage',
    session_id: '11111111-2222-3333-4444-555555555555',
  }))
  assert.equal(parsed.usage, null)
  assert.equal(normalizeUsage({}), null)
  assert.deepEqual(normalizeUsage({ input_tokens: 0, output_tokens: 0 }), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: null,
    costUsd: null,
  })
})

test('plain text is not mistaken for a session document', () => {
  const parsed = parseSessionOutput('generic-json', 'a normal answer')
  assert.equal(parsed.text, null)
  assert.equal(parsed.sessionId, null)
  assert.equal(parsed.usage, null)
})

test('session ids are masked in every user-facing report', () => {
  assert.equal(maskSessionId('11111111-2222-3333-4444-555555555555'), '111111…55')
  assert.equal(maskSessionId('short'), '***')
  assert.equal(maskSessionId(''), '')
})

test('harness adapters declare a resume argv per CLI', () => {
  const codex = harnessDef('codex')
  assert.deepEqual(codex.argv('task', { json: true }), [
    'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', 'task',
  ])
  const codexResume = codex.session.resumeArgs('thread-1', 'task', { mode: 'read-only', json: true })
  assert.deepEqual(codexResume.slice(0, 5), ['exec', 'resume', 'thread-1', '--json', '--skip-git-repo-check'])
  // `codex exec resume` has no -s flag; the sandbox is inherited from the session.
  assert.equal(codexResume.includes('-s'), false)
  assert.equal(codex.session.confidence, 'verified')

  const claude = harnessDef('claude')
  assert.deepEqual(claude.argv('task', { json: true }), [
    '-p', 'task', '--output-format', 'json',
  ])
  assert.deepEqual(claude.session.resumeArgs('session-1', 'task', { json: true }), [
    '-p', 'task', '--resume', 'session-1', '--output-format', 'json',
  ])

  for (const id of ['kimi', 'opencode', 'gemini']) {
    const def = harnessDef(id)
    assert.ok(def.session, `${id} needs a session adapter`)
    const argv = def.session.resumeArgs('session-1', 'task', { json: true })
    assert.ok(argv.some((part) => part === 'task'), `${id} keeps the task`)
    assert.ok(argv.some((part) => part === 'session-1'), `${id} passes the native id`)
  }
})
