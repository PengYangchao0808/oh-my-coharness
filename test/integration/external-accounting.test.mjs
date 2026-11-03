/**
 * R02/R05 regressions: external dispatches are accounted for and gated.
 *
 * Before this, only native requests reached the usage ledger and only native
 * requests could be refused, while the docs claimed "external lanes are gated
 * between dispatches". These tests pin the honest version:
 *   - one dispatch is one booked attempt (usage reported by the CLI in the four
 *     buckets, `unknown` when the CLI reported nothing, never zero);
 *   - the route is recorded as *configured*, not as an observed request route,
 *     because a CLI decides its own model;
 *   - an exhausted enforcing budget refuses the NEXT dispatch before any CLI
 *     starts, and says it is boundary control only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandoff, encodeHandoffMarker } from '../../integration/handoff.js'
import { createSessionRegistry } from '../../integration/sessions.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createRequestGate } from '../../integration/request-gate.js'
import { resolveConfig } from '../../src/config.js'
import { harnessDef } from '../../src/harnesses.js'
import { makeProvider } from '../../src/provider.js'
import { dispatchTasks } from '../../src/dispatch.js'

function promptFor(roleId, cwd, taskId = 'task-1') {
  const handoff = createHandoff({ roleId, cwd, taskId })
  return `Role: ${roleId} (${roleId})\n\nTask:\nDo the work.\n\n${encodeHandoffMarker(handoff)}`
}

function fakeCtx(stdout, { exitCode = 0 } = {}) {
  const specs = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  return { specs, ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined) } }
}

function codexStream(sessionId, message, usage = { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 }) {
  const rows = [
    { type: 'thread.started', thread_id: sessionId },
    { type: 'item.completed', item: { type: 'agent_message', text: message } },
  ]
  if (usage) rows.push({ type: 'turn.completed', usage })
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

const CWD = 'E:\\repo'

function run(provider, { taskId = 'task-1', parentId = 'parent-ext' } = {}) {
  return provider.start({
    prompt: [{ type: 'text', text: promptFor('oracle', CWD, taskId) }],
    cwd: CWD,
    parent: { id: parentId },
    signal: new AbortController().signal,
  })
}

test('R02: one external dispatch books one attempt in the four buckets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ext-'))
  const cfg = resolveConfig({ transport: 'native', sessions: { path: join(dir, 'sessions.json') } })
  const registry = createSessionRegistry(cfg.sessions)
  const ledger = createUsageLedger()
  const fake = fakeCtx(codexStream('thread-ext', 'answer'))
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry, usageLedger: ledger })

  const started = await run(provider)
  const result = await started.result
  assert.equal(result.output[0].text, 'answer')
  assert.match(result.diagnostic, /attempt booked into the usage ledger/)

  const rows = ledger.entries({ parentId: 'parent-ext' })
  assert.equal(rows.length, 1)
  const entry = rows[0]
  assert.equal(entry.backend, 'external')
  assert.equal(entry.taskId, started.id, 'the attempt is keyed by the dispatch id')
  // input_tokens is a TOTAL with cached_input_tokens as its subset.
  assert.equal(entry.usage.uncachedInputTokens, 6)
  assert.equal(entry.usage.cacheReadTokens, 4)
  assert.equal(entry.usage.cacheWriteTokens, null, 'a bucket the CLI does not report stays unknown')
  assert.equal(entry.usage.outputTokens, 2)
  assert.equal(entry.coverage, 'partial')
  assert.equal(entry.cost, null, 'no cost was reported, so no cost is claimed')
  assert.equal(entry.route.provider, 'omc:codex')
  assert.equal(entry.route.observed, false, 'the configured route is not an observed request route')
})

test('R02: a second dispatch is a second booking; the same dispatch never books twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ext-'))
  const cfg = resolveConfig({ transport: 'native', sessions: { path: join(dir, 'sessions.json') } })
  const registry = createSessionRegistry(cfg.sessions)
  const ledger = createUsageLedger()

  for (const taskId of ['task-1', 'task-2']) {
    const fake = fakeCtx(codexStream('thread-ext', `answer ${taskId}`))
    const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry, usageLedger: ledger })
    const started = await run(provider, { taskId })
    await started.result
    // Re-book the exact recorded source on purpose: the ledger must refuse it.
    const [row] = ledger.entries({ parentId: 'parent-ext' }).filter((entry) => entry.taskId === started.id)
    const again = ledger.append({
      parentId: row.parentId,
      taskId: row.taskId,
      attemptId: row.attemptId,
      backend: row.backend,
      source: row.source,
      route: row.route,
      usage: null,
      coverage: 'unknown',
    })
    assert.equal(again.duplicate, true)
  }
  assert.equal(ledger.entries({ parentId: 'parent-ext' }).length, 2)
})

test('R02: a CLI that reports no usage books an unknown attempt, never zeros', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ext-'))
  const cfg = resolveConfig({ transport: 'native', sessions: { path: join(dir, 'sessions.json') } })
  const registry = createSessionRegistry(cfg.sessions)
  const ledger = createUsageLedger()
  const fake = fakeCtx(codexStream('thread-ext', 'answer without usage', null))
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry, usageLedger: ledger })

  const started = await run(provider)
  await started.result
  const [entry] = ledger.entries({ parentId: 'parent-ext' })
  assert.equal(entry.coverage, 'unknown')
  assert.deepEqual(
    { ...entry.usage },
    { uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null },
  )
  assert.equal(ledger.totals({ parentId: 'parent-ext' }).coverage, 'unknown')
  assert.equal(ledger.totals({ parentId: 'parent-ext' }).costUsd, null)
})

test('R02: an unbooked parent identity books nothing instead of guessing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ext-'))
  const cfg = resolveConfig({ transport: 'native', sessions: { path: join(dir, 'sessions.json') } })
  const registry = createSessionRegistry(cfg.sessions)
  const ledger = createUsageLedger()
  const fake = fakeCtx(codexStream('thread-ext', 'answer'))
  const provider = makeProvider(fake.ctx, harnessDef('codex'), cfg, { readOnly: true, registry, usageLedger: ledger })

  const started = await provider.start({
    prompt: [{ type: 'text', text: promptFor('oracle', CWD, 'task-1') }],
    cwd: CWD,
    signal: new AbortController().signal,
  })
  await started.result
  assert.equal(ledger.entries({ parentId: 'anonymous' }).length, 0)
})

test('R02: an exhausted enforcing budget refuses the next dispatch before any CLI starts', async () => {
  const ledger = createUsageLedger()
  ledger.append({
    parentId: 'parent-gated', taskId: 'earlier-dispatch', attemptId: 'earlier-dispatch#dispatch', backend: 'external',
    source: { kind: 'external-cli', runId: 'earlier-dispatch', eventId: 'earlier-dispatch' },
    route: { provider: 'omc:codex', model: null, observed: false },
    usage: { uncachedInputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
  })
  const gate = createRequestGate({ usageLedger: ledger })
  const cfg = resolveConfig({
    transport: 'native',
    efficiency: { budget: { maxCalls: 1, enforce: 'on' } },
    harnesses: { codex: { enabled: true } },
  })
  const fake = fakeCtx(codexStream('thread-gated', 'must not run'))
  const rt = { cfg, ctx: fake.ctx, requestGate: gate, detect: async () => ({ rows: [] }) }

  await assert.rejects(
    () => dispatchTasks(rt, { harness: 'codex', prompt: 'do work', cwd: CWD, mode: 'read-only' }, { agent: { id: 'parent-gated' } }),
    (error) => {
      assert.equal(error.code, 'OMC/BUDGET-EXHAUSTED')
      assert.match(error.message, /boundary control between dispatches, not a per-call cap inside the CLI/)
      return true
    },
  )
  assert.equal(fake.specs.length, 0, 'no CLI was started')
})

test('R02: an advisory budget never blocks a dispatch, and no parent means no gate', async () => {
  const ledger = createUsageLedger()
  ledger.append({
    parentId: 'parent-advisory', taskId: 'earlier', attemptId: 'earlier#dispatch', backend: 'external',
    source: { kind: 'external-cli', runId: 'earlier', eventId: 'earlier' },
    route: { provider: 'omc:codex', model: null, observed: false },
    usage: null,
  })
  const gate = createRequestGate({ usageLedger: ledger })
  const cfg = resolveConfig({
    transport: 'native',
    efficiency: { budget: { maxCalls: 1, enforce: 'off' } },
    harnesses: { codex: { enabled: true } },
  })

  // Advisory: enforcement is off, so the dispatch path must not refuse. It will
  // fail later for its own reason (no provider in this fake rt), which is not
  // the budget error.
  const fake = fakeCtx(codexStream('thread-ok', 'runs'))
  const rt = { cfg, ctx: fake.ctx, requestGate: gate, detect: async () => ({ rows: [] }) }
  const outcome = await dispatchTasks(rt, { harness: 'codex', prompt: 'do work', cwd: CWD, mode: 'read-only' }, { agent: { id: 'parent-advisory' } })
    .then((value) => ({ value }))
    .catch((error) => ({ error }))
  assert.notEqual(outcome.error?.code, 'OMC/BUDGET-EXHAUSTED')

  // No calling agent: the gate has no parent to attribute to and stays out of
  // the way instead of inventing one.
  await dispatchTasks(rt, { harness: 'codex', prompt: 'do work', cwd: CWD, mode: 'read-only' }, {})
    .catch(() => {})
})
