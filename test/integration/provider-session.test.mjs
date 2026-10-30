import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandoff, encodeHandoffMarker } from '../../integration/handoff.js'
import { createSessionRegistry } from '../../integration/sessions.js'
import { resolveConfig } from '../../src/config.js'
import { harnessDef } from '../../src/harnesses.js'
import { makeProvider } from '../../src/provider.js'

function promptFor(roleId, cwd, taskId = 'task-1') {
  const handoff = createHandoff({ roleId, cwd, taskId })
  return `Role: ${roleId} (${roleId})\n\nTask:\nDo the work.\n\n${encodeHandoffMarker(handoff)}`
}

function fakeCtx(stdout, { exitCode = 0 } = {}) {
  const specs = []
  const read = (text) => ({
    readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }),
  })
  const subprocess = {
    async resolveExecutable(bin) {
      return `C:\\fake\\${bin}.exe`
    },
    spawn(spec) {
      specs.push(spec)
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        async waitForExit() {
          return true
        },
      }
    },
  }
  return {
    specs,
    ctx: {
      subprocess,
      get(name) {
        return name === 'subprocess' ? subprocess : undefined
      },
    },
  }
}

function codexStream(sessionId, message) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } }),
  ].join('\n')
}

function registryFor(cfg) {
  return createSessionRegistry(cfg.sessions)
}

function start(provider, cwd, taskId = 'task-1') {
  return provider.start({
    prompt: [{ type: 'text', text: promptFor('oracle', cwd, taskId) }],
    cwd,
    signal: new AbortController().signal,
  })
}

test('Codex: first run stores a session, second run resumes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-'))
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'sessions.json'), maxTurns: 5 },
  })
  const registry = registryFor(cfg)
  const cwd = 'E:\\repo'

  const first = fakeCtx(codexStream('thread-first', 'first answer'))
  const provider = makeProvider(first.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
  const run1 = await start(provider, cwd, 'task-1')
  const result1 = await run1.result
  assert.equal(result1.output[0].text, 'first answer')
  assert.match(result1.diagnostic, /session new/)
  assert.ok(first.specs[0].argv.includes('--json'), 'the first run asks for JSON')
  assert.doesNotMatch(first.specs[0].argv.at(-1), /omc-handoff/)
  assert.match(first.specs[0].argv.at(-1), /Do the work\./)
  assert.equal(registry.stats().resumable, 1)

  const second = fakeCtx(codexStream('thread-first', 'second answer'))
  const provider2 = makeProvider(second.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
  const run2 = await start(provider2, cwd, 'task-2')
  const result2 = await run2.result
  assert.equal(result2.output[0].text, 'second answer')
  assert.match(result2.diagnostic, /session resumed/)
  const argv = second.specs[0].argv
  assert.equal(argv[1], 'exec')
  assert.equal(argv[2], 'resume')
  assert.equal(argv[3], 'thread-first')
  assert.ok(argv.includes('read-only'))
  assert.equal(registry.stats().resumable, 1)
  assert.equal(registry.list()[0].turns, 2)
})

test('session reuse off keeps the v0.4 argv and stores nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-off-'))
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { enabled: false, path: join(dir, 'sessions.json') },
  })
  const registry = registryFor(cfg)
  const fake = fakeCtx('plain answer')
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
  const run = await start(provider, 'E:\\repo')
  const result = await run.result

  assert.equal(result.output[0].text, 'plain answer')
  assert.match(result.diagnostic, /session reuse off/)
  assert.equal(fake.specs[0].argv.includes('--json'), false)
  assert.equal(registry.stats().entries, 0)
})

test('an unverified adapter is gated unless allowUnverified is explicit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-kimi-'))
  const cwd = 'E:\\repo'
  const generic = JSON.stringify({ session_id: 'kimi-session-1', response: 'kimi answer' })
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'safe.json'), allowUnverified: false },
  })
  const registry = registryFor(cfg)
  const fake = fakeCtx(generic)
  const provider = makeProvider(fake.ctx, harnessDef('kimi'), cfg, { readOnly: true, registry })
  const run = await start(provider, cwd)
  const result = await run.result

  assert.match(result.diagnostic, /session reuse off/)
  assert.equal(fake.specs[0].argv.includes('--output-format'), false)
  assert.equal(registry.stats().entries, 0)
})

test('an unverified adapter runs with JSON and resumes only after consent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-kimi-on-'))
  const cwd = 'E:\\repo'
  const generic = (message) => JSON.stringify({ session_id: 'kimi-session-1', response: message })
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'sessions.json'), allowUnverified: true, maxTurns: 5 },
  })
  const registry = registryFor(cfg)

  const first = fakeCtx(generic('kimi first'))
  const provider = makeProvider(first.ctx, harnessDef('kimi'), cfg, { readOnly: true, registry })
  const run1 = await start(provider, cwd, 'task-1')
  const result1 = await run1.result
  assert.equal(result1.output[0].text, 'kimi first')
  assert.ok(first.specs[0].argv.includes('--output-format'))

  const second = fakeCtx(generic('kimi second'))
  const provider2 = makeProvider(second.ctx, harnessDef('kimi'), cfg, { readOnly: true, registry })
  const run2 = await start(provider2, cwd, 'task-2')
  const result2 = await run2.result
  assert.equal(result2.output[0].text, 'kimi second')
  assert.ok(second.specs[0].argv.includes('--session'))
  assert.equal(second.specs[0].argv[second.specs[0].argv.indexOf('--session') + 1], 'kimi-session-1')
})

test('without an explicit cwd, session reuse stays off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-nocwd-'))
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'sessions.json') },
  })
  const registry = registryFor(cfg)
  const fake = fakeCtx(codexStream('thread-nocwd', 'no cwd answer'))
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
  const run = await provider.start({
    prompt: [{ type: 'text', text: promptFor('oracle', 'E:\\repo', 'task-nocwd') }],
    signal: new AbortController().signal,
  })
  const result = await run.result

  assert.match(result.output[0].text, /no cwd answer/)
  assert.match(result.diagnostic, /session reuse off/)
  assert.equal(fake.specs[0].argv.includes('--json'), false)
  assert.equal(registry.stats().entries, 0)
})

test('require-resume fails before spawning when no session exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-required-'))
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'sessions.json'), resumePolicy: 'require-resume' },
  })
  const registry = registryFor(cfg)
  const fake = fakeCtx('never')
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })

  await assert.rejects(start(provider, 'E:\\repo'), (error) => {
    assert.equal(error.code, 'OMC/SESSION-REQUIRED')
    return true
  })
  assert.equal(fake.specs.length, 0)
})

test('a failed run is recorded as failed and is not resumed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-provider-fail-'))
  const cfg = resolveConfig({
    transport: 'native',
    sessions: { path: join(dir, 'sessions.json') },
  })
  const registry = registryFor(cfg)
  const fake = fakeCtx('boom', { exitCode: 1 })
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
  const run = await start(provider, 'E:\\repo')
  const result = await run.result

  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /OMC\/RUN-FAILED|session/)
  assert.equal(registry.stats().states.failed, 1)
})
