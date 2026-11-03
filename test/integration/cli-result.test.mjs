import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyCliResult } from '../../integration/cli-result.js'

test('plain text with exit zero is a completion', () => {
  const result = classifyCliResult({
    status: 'completed',
    exitCode: 0,
    captured: { stdout: 'review complete', stderr: '' },
    parsed: null,
    expectJson: false,
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.code, null)
})

test('exit zero cannot hide an invalid JSON contract', () => {
  const result = classifyCliResult({
    status: 'completed',
    exitCode: 0,
    captured: { stdout: 'not json', stderr: '' },
    parsed: null,
    expectJson: true,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'OMC/CLI-SEMANTIC-FAILURE')
  assert.equal(result.semantic, true)
})

test('truncation and an empty final message are not completions', () => {
  const truncated = classifyCliResult({
    status: 'completed', exitCode: 0,
    captured: { stdout: 'partial', truncated: true },
    parsed: { text: 'partial' },
  })
  assert.equal(truncated.status, 'failed')
  assert.equal(truncated.code, 'OMC/CLI-TRUNCATED')

  const empty = classifyCliResult({
    status: 'completed', exitCode: 0,
    captured: { stdout: '{"type":"done"}', stderr: '' },
    parsed: { text: '' },
  })
  assert.equal(empty.status, 'failed')
  assert.equal(empty.code, 'OMC/CLI-EMPTY-OUTPUT')
})

test('exit failures are classified by cause', () => {
  const auth = classifyCliResult({
    status: 'failed', exitCode: 1,
    captured: { stderr: '401 Unauthorized: please sign in', stdout: '' },
  })
  assert.equal(auth.code, 'OMC/CLI-AUTH')
  assert.equal(auth.retryable, false)

  const rate = classifyCliResult({
    status: 'failed', exitCode: 1,
    captured: { stderr: '429 rate limit exceeded', stdout: '' },
  })
  assert.equal(rate.code, 'OMC/CLI-RATE-LIMIT')
  assert.equal(rate.retryable, true)

  const quota = classifyCliResult({
    status: 'failed', exitCode: 1,
    captured: { stderr: 'credit balance is too low', stdout: '' },
  })
  assert.equal(quota.code, 'OMC/CLI-QUOTA')
  assert.equal(quota.retryable, false)

  const context = classifyCliResult({
    status: 'failed', exitCode: 1,
    captured: { stderr: 'maximum context length exceeded', stdout: '' },
  })
  assert.equal(context.code, 'OMC/CLI-CONTEXT')
})

test('timeout and cancellation win over output parsing', () => {
  assert.equal(classifyCliResult({ status: 'timeout', captured: {} }).status, 'timeout')
  assert.equal(classifyCliResult({ status: 'cancelled', captured: {} }).status, 'cancelled')
  assert.equal(classifyCliResult({ status: 'completed', timedOut: true }).code, 'OMC/CLI-TIMEOUT')
})

test('resume identity is reported without pretending the run failed', () => {
  const changed = classifyCliResult({
    status: 'completed', exitCode: 0,
    captured: { stdout: 'answer' },
    parsed: { text: 'answer', sessionId: 'thread-new' },
    resumeId: 'thread-old',
  })
  assert.equal(changed.status, 'completed')
  assert.equal(changed.idChanged, true)
  assert.equal(changed.code, 'OMC/CLI-ID-CHANGED')

  const unconfirmed = classifyCliResult({
    status: 'completed', exitCode: 0,
    captured: { stdout: 'answer' },
    parsed: { text: 'answer' },
    resumeId: 'thread-old',
  })
  assert.equal(unconfirmed.status, 'completed')
  assert.equal(unconfirmed.unconfirmed, true)
  assert.equal(unconfirmed.code, 'OMC/CLI-SESSION-UNCONFIRMED')
})
