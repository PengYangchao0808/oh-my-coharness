import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionRegistry, sessionKeyFor } from '../../integration/sessions.js'
import { createTaskRegistry } from '../../integration/tasks.js'

test('two registry instances do not lose each other\'s session records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-durable-sessions-'))
  const path = join(dir, 'sessions.json')
  try {
    const first = createSessionRegistry({ path, maxTurns: 5 })
    const second = createSessionRegistry({ path, maxTurns: 5 })
    const keyOne = sessionKeyFor({ laneId: 'lane-one', role: 'oracle', harness: 'codex', model: 'm' })
    const keyTwo = sessionKeyFor({ laneId: 'lane-two', role: 'oracle', harness: 'codex', model: 'm' })

    const leaseOne = await first.acquire(keyOne)
    first.complete(leaseOne, { sessionId: 'thread-one' })
    leaseOne.release()

    const leaseTwo = await second.acquire(keyTwo)
    second.complete(leaseTwo, { sessionId: 'thread-two' })
    leaseTwo.release()

    // A fresh instance sees both; the already-loaded first instance also
    // refreshes and must not overwrite the second writer on its next save.
    const fresh = createSessionRegistry({ path, maxTurns: 5 })
    assert.equal(fresh.stats().entries, 2)
    assert.equal(first.stats().entries, 2)
    assert.equal(first.find(keyOne).native.sessionId, 'thread-one')
    assert.equal(first.find(keyTwo).native.sessionId, 'thread-two')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('session usage is aggregated and a single lane can be forgotten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-lane-forget-'))
  const path = join(dir, 'sessions.json')
  try {
    const registry = createSessionRegistry({ path, maxTurns: 5 })
    for (const [laneId, tokens] of [['lane-a', 10], ['lane-b', 7]]) {
      const key = sessionKeyFor({ laneId, role: 'oracle', harness: 'codex', model: 'm' })
      const lease = await registry.acquire(key)
      registry.complete(lease, {
        sessionId: 'thread-' + laneId,
        usage: { inputTokens: tokens, outputTokens: 2, cachedInputTokens: 0, costUsd: null },
      })
      lease.release()
    }
    const stats = registry.stats()
    assert.equal(stats.lanes, 2)
    assert.equal(stats.usage.inputTokens, 17)
    assert.equal(stats.usage.outputTokens, 4)
    assert.equal(registry.forgetLane('lane-a'), 1)
    assert.equal(registry.stats().entries, 1)
    assert.equal(registry.forgetLane('missing'), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stale running row is recovered as failed instead of silently resumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-durable-stale-'))
  const path = join(dir, 'sessions.json')
  try {
    const key = sessionKeyFor({ laneId: 'lane-stale', role: 'oracle', harness: 'codex', model: 'm' })
    const first = createSessionRegistry({ path, maxTurns: 5 })
    const lease = await first.acquire(key)
    first.complete(lease, { sessionId: 'thread-stale' })
    lease.release()

    // Simulate a crash: a running row whose lane lock no longer exists.
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    for (const record of Object.values(raw.sessions)) record.state = 'running'
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify(raw), 'utf8')

    const recovered = createSessionRegistry({ path, maxTurns: 5 })
    const next = await recovered.acquire(key)
    assert.equal(next.record, null, 'a stale running row is not resumed as if it were idle')
    recovered.complete(next, { sessionId: 'thread-new' })
    next.release()
    assert.equal(recovered.find(key).native.sessionId, 'thread-new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('durable task results survive a new registry instance and become unknown when the body is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-durable-tasks-'))
  try {
    const first = createTaskRegistry({ dir, maxRetained: 10 })
    const started = first.start({
      id: 'task-a', parentId: 'parent-1', harness: 'codex', label: 'review',
      handoff: { laneId: 'lane-a', role: 'oracle', taskId: 'handoff-a' },
    })
    assert.equal(started.status, 'running')
    first.settle('task-a', { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })

    const second = createTaskRegistry({ dir, maxRetained: 10 })
    const listed = second.list('parent-1')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].status, 'completed')
    const read = second.read('parent-1', 'task-a')
    assert.equal(read.result.stopReason, 'completed')

    await unlink(join(dir, 'parent-1', 'task-a.json'))
    const unknown = second.read('parent-1', 'task-a')
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.unknown, true)
    assert.equal(unknown.result, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancel after a restart is recorded but never reported as cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-durable-cancel-'))
  try {
    const first = createTaskRegistry({ dir })
    first.start({ id: 'task-b', parentId: 'parent-2', harness: 'codex', label: 'long' })
    const restarted = createTaskRegistry({ dir })
    const view = await restarted.cancel('parent-2', 'task-b')
    assert.equal(view.status, 'running')
    assert.equal(view.cancelRequested, true)
    assert.match(view.cancelNote, /restarted/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('task retention is bounded per parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-durable-retain-'))
  try {
    const registry = createTaskRegistry({ dir, maxRetained: 2 })
    for (let index = 0; index < 4; index += 1) {
      const id = 'task-' + index
      registry.start({ id, parentId: 'parent-3', harness: 'codex', label: id })
      registry.settle(id, { stopReason: 'completed', output: [] })
    }
    const listed = registry.list('parent-3')
    assert.equal(listed.length, 2)
    assert.deepEqual(listed.map((row) => row.id).sort(), ['task-2', 'task-3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
