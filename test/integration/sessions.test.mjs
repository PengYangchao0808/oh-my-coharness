import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canResumeRecord,
  createSessionRegistry,
  sessionKeyFor,
  sessionKeyHash,
} from '../../integration/sessions.js'

function tempRegistry(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omc-sessions-'))
  const path = join(dir, 'sessions.json')
  return { dir, path, registry: createSessionRegistry({ path, maxTurns: 3, idleTtlMs: 60_000, ...options }) }
}

function key(overrides = {}) {
  return sessionKeyFor({
    projectId: 'proj-1',
    laneId: 'lane-oracle-proj-1',
    role: 'oracle',
    harness: 'codex',
    model: 'gpt-5',
    environment: 'native',
    workspace: 'e:/repo',
    endpoint: 'api.openai.com',
    ...overrides,
  })
}

test('a completed run stores exactly one native reference', async () => {
  const { path, registry } = tempRegistry()
  const lane = key()
  const lease = await registry.acquire(lane)
  assert.equal(lease.record, null)
  assert.equal(registry.stats().states.running, 1)

  registry.complete(lease, {
    sessionId: 'thread-abc-123',
    format: 'codex-jsonl',
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5, costUsd: null },
    taskId: 'task-1',
  })
  lease.release()

  const found = registry.find(lane)
  assert.equal(found.native.sessionId, 'thread-abc-123')
  assert.equal(found.turns, 1)
  const stats = registry.stats()
  assert.equal(stats.entries, 1)
  assert.equal(stats.resumable, 1)
  assert.equal(stats.states.idle, 1)

  const body = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(body.schemaVersion, 1)
  const raw = readFileSync(path, 'utf8')
  assert.match(raw, /thread-abc-123/)
  // The file is sensitive metadata, not a conversation: no prompt or secret is stored.
  assert.doesNotMatch(raw, /task text|ANTHROPIC_AUTH_TOKEN/i)
})

test('every identity field isolates a session', async () => {
  const { registry } = tempRegistry()
  const base = key()
  const lease = await registry.acquire(base)
  registry.complete(lease, { sessionId: 'thread-isolated' })
  lease.release()

  assert.ok(registry.find(base))
  for (const overrides of [
    { role: 'designer' },
    { harness: 'claude' },
    { model: 'gpt-6' },
    { environment: 'wsl:Ubuntu' },
    { workspace: 'e:/other' },
    { endpoint: 'api.z.ai' },
    { laneId: 'lane-other' },
    { projectId: 'proj-2' },
  ]) {
    assert.equal(registry.find(key(overrides)), null, JSON.stringify(overrides))
  }
})

test('a second writer waits for the lease instead of resuming concurrently', async () => {
  const { registry } = tempRegistry({ lockTimeoutMs: 1_000 })
  const lane = key()
  const first = await registry.acquire(lane)
  registry.complete(first, { sessionId: 'thread-first' })
  first.release()

  const held = await registry.acquire(lane)
  let secondResolved = false
  const secondPromise = registry.acquire(lane).then((lease) => {
    secondResolved = true
    return lease
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(secondResolved, false, 'the second client must wait')
  registry.complete(held, { sessionId: 'thread-second' })
  held.release()
  const second = await secondPromise
  assert.equal(second.record.native.sessionId, 'thread-second')
  second.release()
})

test('the turn cap and the idle window both stop reuse', async () => {
  let now = Date.UTC(2026, 9, 30, 0, 0, 0)
  const dir = mkdtempSync(join(tmpdir(), 'omc-sessions-'))
  const path = join(dir, 'sessions.json')
  const registry = createSessionRegistry({ path, maxTurns: 2, idleTtlMs: 60_000 }, { now: () => now })
  const lane = key()

  for (let turn = 1; turn <= 2; turn += 1) {
    const lease = await registry.acquire(lane)
    registry.complete(lease, { sessionId: `thread-${turn}` })
    lease.release()
  }
  assert.equal(registry.stats().resumable, 0)
  assert.equal(registry.find(lane), null)

  // A fresh record expires after the idle window even when turns remain.
  const fresh = createSessionRegistry({ path: join(dir, 'fresh.json'), maxTurns: 5, idleTtlMs: 60_000 }, { now: () => now })
  const freshLane = key({ laneId: 'lane-fresh' })
  const lease = await fresh.acquire(freshLane)
  fresh.complete(lease, { sessionId: 'thread-fresh' })
  lease.release()
  assert.ok(fresh.find(freshLane))
  now += 61_000
  assert.equal(fresh.find(freshLane), null)
})

test('failure and unconfirmed identity are not resumable', async () => {
  const { registry } = tempRegistry()
  const lane = key()
  const first = await registry.acquire(lane)
  registry.fail(first, { code: 'OMC/RUN-FAILED', message: 'boom' })
  first.release()
  assert.equal(registry.find(lane), null)
  assert.equal(registry.stats().states.failed, 1)

  const second = await registry.acquire(lane)
  second.record = null
  registry.complete(second, { sessionId: null })
  second.release()
  assert.equal(registry.find(lane), null)
  assert.equal(registry.stats().states.unconfirmed, 1)
})

test('a failed run keeps the reference for audit but never resumes it', async () => {
  const { registry } = tempRegistry()
  const lane = key()
  const first = await registry.acquire(lane)
  registry.complete(first, { sessionId: 'thread-keep' })
  first.release()
  const second = await registry.acquire(lane)
  assert.ok(second.record)
  registry.fail(second, { code: 'OMC/RUN-TIMEOUT', message: 'slow' })
  second.release()
  assert.equal(registry.find(lane), null)
  const listed = registry.list()
  assert.equal(listed[0].sessionId, 'thread…ep')
})

test('a clear forgets references without touching anything else', async () => {
  const { path, registry } = tempRegistry()
  const lease = await registry.acquire(key())
  registry.complete(lease, { sessionId: 'thread-clear' })
  lease.release()
  assert.equal(registry.stats().entries, 1)
  registry.clear()
  assert.equal(registry.stats().entries, 0)
  assert.ok(existsSync(path))
})

test('a corrupt registry is reported and preserved on the next write', async () => {
  const { dir, path, registry } = tempRegistry()
  writeFileSync(path, '{not json', 'utf8')
  assert.match(registry.stats().loadError, /JSON|Unexpected|position/i)

  const lease = await registry.acquire(key({ laneId: 'lane-after-corrupt' }))
  registry.complete(lease, { sessionId: 'thread-after-corrupt' })
  lease.release()
  assert.equal(registry.stats().entries, 1)
  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'the unreadable file must be preserved')
})

test('the key hash is stable and ignores property order', () => {
  const one = sessionKeyFor({ role: 'oracle', harness: 'codex', workspace: 'e:/repo' })
  const two = sessionKeyFor({ workspace: 'e:/repo', harness: 'codex', role: 'oracle' })
  assert.equal(sessionKeyHash(one), sessionKeyHash(two))
  assert.equal(canResumeRecord(null, one), false)
})
