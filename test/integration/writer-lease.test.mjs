/**
 * Project-level Writer Lease (0.6) regressions.
 *
 * The important non-obvious cases:
 * - two owners in one process and two owners in two independent Node processes;
 * - idempotent retry by the same owner+token;
 * - a live owner is never preempted because its record merely looks old;
 * - a dead pid is recoverable, and an expired foreign-host heartbeat is too;
 * - a corrupt record is never silently treated as "free";
 * - the key is sha256(realpath(workspaceRoot)) and different projects isolate.
 *
 * The file doubles as the contender script for the cross-process test: when it
 * is spawned with `--writer-lease-contender` it behaves as a worker instead of
 * registering tests. No extra repository fixture file is needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWriterLease,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_TTL_MS,
  WRITER_LEASE_SCHEMA_VERSION,
  writerLeaseKey,
} from '../../integration/writer-lease.js'

const SELF = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(dirname(SELF)))
const CONTENDER_FLAG = '--writer-lease-contender'
const BUNDLED_NODE = 'C:\\Users\\彭扬超\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe'
const NODE = process.env.OMC_TEST_NODE || (existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath)
const NODE_DIR = dirname(NODE)

/* ------------------------------------------------------------------ *
 * Contender mode (must run before any test is registered)
 * ------------------------------------------------------------------ */

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, Math.max(1, ms))
}

function sleepUntil(target) {
  for (;;) {
    const remaining = target - Date.now()
    if (remaining <= 0) return
    sleepSync(Math.min(10, remaining))
  }
}

function argValue(args, name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function contenderMain() {
  const args = process.argv.slice(2)
  const stateRoot = argValue(args, 'state-root')
  const workspaceRoot = argValue(args, 'workspace-root')
  const owner = argValue(args, 'owner', `contender#${process.pid}`)
  const token = argValue(args, 'token')
  const out = argValue(args, 'out')
  const holdMs = Number(argValue(args, 'hold-ms', '2000'))
  const startAt = Number(argValue(args, 'start-at', '0'))

  sleepUntil(startAt)

  let payload
  try {
    const lease = createWriterLease({ stateRoot, workspaceRoot, owner })
    const acquired = lease.acquire(token ? { token } : {})
    payload = {
      ok: true,
      pid: process.pid,
      owner: acquired.owner,
      token: acquired.token,
      key: acquired.key,
      path: acquired.path,
      idempotent: acquired.idempotent,
      code: null,
      error: null,
    }
    // Publish the win, then keep the lease alive (and the pid alive) while the
    // other contender tries.
    if (out) writeJson(out, payload)
    sleepSync(Math.max(0, holdMs))
  } catch (error) {
    payload = {
      ok: false,
      pid: process.pid,
      owner,
      token: null,
      key: null,
      path: null,
      idempotent: false,
      code: error?.code ?? null,
      error: String(error?.message ?? error),
    }
    if (out) writeJson(out, payload)
  }
  process.exit(0)
}

if (process.argv.includes(CONTENDER_FLAG)) {
  await contenderMain()
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function childEnv() {
  return {
    ...process.env,
    PATH: `${NODE_DIR}${delimiter}${process.env.PATH ?? ''}`,
  }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { cwd: ROOT, stdio: 'ignore', env: childEnv() })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      reject(new Error(`child ${child.pid} timed out`))
    }, 30_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, pid: child.pid })
    })
  })
}

async function withProject(fn) {
  const base = await mkdtemp(join(tmpdir(), 'omc-writer-lease-'))
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  try {
    return await fn({ base, workspace, stateRoot: join(base, 'state') })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Write a syntactically valid lease record directly, as another process would. */
function writeRawRecord(lease, overrides = {}) {
  const heartbeatAt = overrides.heartbeatAt ?? Date.now()
  const ttlMs = overrides.ttlMs ?? lease.ttlMs ?? DEFAULT_TTL_MS
  const record = {
    schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
    key: lease.key,
    token: 'raw-token',
    pid: process.pid,
    owner: 'raw-parent#raw-node',
    workspaceRoot: lease.workspaceRoot,
    host: hostname(),
    createdAt: new Date(heartbeatAt).toISOString(),
    updatedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt,
    expiresAt: heartbeatAt + ttlMs,
    heartbeatMs: lease.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    ttlMs,
    ...overrides,
  }
  if (overrides.expiresAt === undefined) record.expiresAt = record.heartbeatAt + ttlMs
  writeFileSync(lease.path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

async function deadPid() {
  const child = spawn(NODE, ['-e', ''], { stdio: 'ignore', env: childEnv() })
  const pid = child.pid
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`pid ${pid} is still signalable after it exited`)
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('the public API fails closed on invalid input', async () => {
  await withProject(async ({ base, workspace, stateRoot }) => {
    assert.throws(
      () => createWriterLease({ stateRoot, workspaceRoot: join(base, 'missing') }),
      (error) => error.code === 'OMC/WRITER-INVALID',
    )
    assert.throws(
      () => createWriterLease({ stateRoot: '', workspaceRoot: workspace }),
      (error) => error.code === 'OMC/WRITER-INVALID',
    )
    assert.throws(
      () => createWriterLease({ stateRoot, workspaceRoot: workspace, heartbeatMs: 50, ttlMs: 10 }),
      (error) => error.code === 'OMC/WRITER-INVALID',
    )
    assert.throws(
      () => createWriterLease({ stateRoot, workspaceRoot: workspace, ttlMs: -1 }),
      (error) => error.code === 'OMC/WRITER-INVALID',
    )

    const lease = createWriterLease({ stateRoot, workspaceRoot: workspace })
    assert.equal(lease.status().state, 'vacant')
    assert.throws(() => lease.acquire(), (error) => error.code === 'OMC/WRITER-INVALID')
    assert.throws(() => lease.acquire({ owner: '' }), (error) => error.code === 'OMC/WRITER-INVALID')
    assert.throws(() => lease.heartbeat({}), (error) => error.code === 'OMC/WRITER-INVALID')
    assert.throws(() => lease.release({}), (error) => error.code === 'OMC/WRITER-INVALID')
    assert.throws(() => writerLeaseKey(join(base, 'missing')), (error) => error.code === 'OMC/WRITER-INVALID')
  })
})

test('1. the same owner and token re-acquire idempotently', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const lease = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#node', ttlMs: 60_000 })
    const first = lease.acquire()
    assert.equal(first.ok, true)
    assert.equal(first.idempotent, false)
    assert.equal(first.owner, 'parent#node')
    assert.equal(typeof first.token, 'string')
    assert.ok(first.token.length > 0)

    const second = lease.acquire({ token: first.token })
    assert.equal(second.idempotent, true)
    assert.equal(second.renewed, false)
    assert.equal(second.token, first.token)
    assert.equal(second.owner, first.owner)
    assert.equal(lease.status().state, 'held')

    const heartbeat = lease.heartbeat({ token: first.token })
    assert.equal(heartbeat.token, first.token)
    assert.equal(heartbeat.owner, 'parent#node')

    const released = lease.release({ token: first.token })
    assert.equal(released.released, true)
    assert.equal(lease.status().state, 'vacant')
    // Releasing an already-released lease is idempotent, not a crash.
    assert.equal(lease.release({ token: first.token }).released, false)
  })
})

test('2. two owners are mutually exclusive in one project', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const first = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#one' })
    const second = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#two' })
    const held = first.acquire()

    assert.throws(
      () => second.acquire(),
      (error) => error.code === 'OMC/WRITER-BUSY' && /parent#one/.test(error.message),
    )
    assert.equal(first.status().owner, 'parent#one')

    // The same owner retrying with a different token is also not a free pass:
    // a lease token identifies one holding attempt.
    assert.throws(
      () => first.acquire({ token: 'a-different-token' }),
      (error) => error.code === 'OMC/WRITER-BUSY',
    )

    first.release({ token: held.token })
  })
})

test('3. only the holder may heartbeat or release', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const holder = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#holder' })
    const other = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#other' })
    const held = holder.acquire()

    assert.throws(
      () => other.heartbeat({ token: 'not-the-holder-token' }),
      (error) => error.code === 'OMC/WRITER-NOT-OWNER',
    )
    assert.throws(
      () => other.release({ token: 'not-the-holder-token' }),
      (error) => error.code === 'OMC/WRITER-NOT-OWNER',
    )
    assert.equal(holder.status().state, 'held')
    assert.equal(holder.status().owner, 'parent#holder')
    // The real holder is unaffected.
    assert.equal(holder.heartbeat({ token: held.token }).token, held.token)

    holder.release({ token: held.token })
    assert.throws(
      () => other.heartbeat({ token: 'not-the-holder-token' }),
      (error) => error.code === 'OMC/WRITER-LOST',
    )
  })
})

test('4. after release another owner can acquire', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const first = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#one' })
    const second = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'parent#two' })
    const held = first.acquire()
    assert.equal(first.release({ token: held.token }).released, true)
    assert.equal(first.status().state, 'vacant')

    const taken = second.acquire()
    assert.equal(taken.owner, 'parent#two')
    assert.equal(second.status().state, 'held')
    assert.throws(
      () => first.heartbeat({ token: held.token }),
      (error) => error.code === 'OMC/WRITER-NOT-OWNER',
    )
    second.release({ token: taken.token })
  })
})

test('5. a fresh record owned by a live process is refused', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const lease = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'intruder#1' })
    writeRawRecord(lease, { pid: process.pid, owner: 'live-owner#1', heartbeatAt: Date.now() })

    const status = lease.status()
    assert.equal(status.alive, true)
    assert.equal(status.expired, false)
    assert.equal(status.state, 'held')
    assert.equal(status.owner, 'live-owner#1')

    assert.throws(
      () => lease.acquire(),
      (error) => error.code === 'OMC/WRITER-BUSY' && /still alive/.test(error.message),
    )
  })
})

test('6. a dead owner pid can be taken over', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const dead = await deadPid()
    const lease = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'recovery#1' })
    writeRawRecord(lease, { pid: dead, owner: 'crashed#1', heartbeatAt: Date.now() })

    const before = lease.status()
    assert.equal(before.alive, false)
    assert.equal(before.state, 'stale')
    assert.equal(before.expired, false, 'a dead pid is recoverable before the TTL expires')

    const taken = lease.acquire()
    assert.equal(taken.owner, 'recovery#1')
    assert.equal(taken.record.pid, process.pid)
    assert.equal(lease.status().state, 'held')
  })
})

test('7. TTL expiry is reported, renews in place, and only recovers dead owners', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    let nowMs = 1_000_000
    const lease = createWriterLease({
      stateRoot,
      workspaceRoot: workspace,
      owner: 'ttl#1',
      heartbeatMs: 20,
      ttlMs: 100,
      now: () => nowMs,
    })
    const held = lease.acquire()
    nowMs += 150

    const expired = lease.status()
    assert.equal(expired.expired, true)
    assert.equal(expired.alive, true)
    assert.equal(expired.state, 'expired')

    // An expired record whose owner process is still alive must NOT be stolen,
    // even though it is past the TTL ("looks old" is not proof of death).
    assert.throws(
      () => lease.acquire({ owner: 'thief#1' }),
      (error) => error.code === 'OMC/WRITER-BUSY',
    )

    const renewed = lease.heartbeat({ token: held.token })
    assert.equal(renewed.expiresAt, nowMs + 100)
    assert.equal(lease.status().expired, false)
    lease.release({ token: held.token })

    // A dead owner whose heartbeat is also expired is recoverable.
    const dead = await deadPid()
    writeRawRecord(lease, {
      pid: dead,
      owner: 'crashed-expired#1',
      heartbeatAt: nowMs - 10_000,
      expiresAt: nowMs - 9_000,
    })
    const stale = lease.status()
    assert.equal(stale.expired, true)
    assert.equal(stale.alive, false)
    assert.equal(stale.state, 'stale')
    assert.equal(lease.acquire({ owner: 'after-crash#1' }).owner, 'after-crash#1')
  })
})

test('8. a corrupt record is never silently treated as idle', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    const lease = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'reader#1' })
    const cases = [
      '{ not json',
      '',
      JSON.stringify({ schemaVersion: 1, key: 'another-project', workspaceRoot: lease.workspaceRoot }),
      JSON.stringify({
        schemaVersion: WRITER_LEASE_SCHEMA_VERSION,
        key: lease.key,
        workspaceRoot: lease.workspaceRoot,
        token: 'raw-token',
        pid: 0,
        owner: 'raw-parent#raw-node',
        heartbeatAt: Date.now(),
      }),
    ]

    for (const body of cases) {
      writeFileSync(lease.path, body, 'utf8')
      assert.throws(
        () => lease.acquire(),
        (error) => error.code === 'OMC/WRITER-CORRUPT' && /refusing to treat the project as free/.test(error.message),
      )
      const status = lease.status()
      assert.equal(status.state, 'corrupt')
      assert.equal(status.corrupt, true)
      assert.notEqual(status.state, 'vacant')
      // The damaged file is preserved for inspection; it is not deleted.
      assert.equal(existsSync(lease.path), true)
    }
  })
})

test('9. the key is sha256(realpath) and different projects stay isolated', async () => {
  await withProject(async ({ base, workspace, stateRoot }) => {
    const one = createWriterLease({ stateRoot, workspaceRoot: workspace })
    const two = createWriterLease({ stateRoot, workspaceRoot: workspace + sep })
    const expected = createHash('sha256').update(realpathSync.native(workspace), 'utf8').digest('hex')

    assert.equal(one.key, expected)
    assert.equal(two.key, expected)
    assert.equal(one.path, two.path)
    assert.equal(one.path, join(one.stateRoot, 'writer', `${expected}.json`))
    assert.equal(writerLeaseKey(workspace), expected)

    const otherWorkspace = join(base, 'other-workspace')
    mkdirSync(otherWorkspace, { recursive: true })
    const other = createWriterLease({ stateRoot, workspaceRoot: otherWorkspace, owner: 'parent#two' })
    assert.notEqual(other.key, one.key)
    assert.notEqual(other.path, one.path)

    const first = one.acquire({ owner: 'parent#one' })
    const second = other.acquire()
    assert.equal(first.owner, 'parent#one')
    assert.equal(second.owner, 'parent#two')
    assert.equal(one.status().owner, 'parent#one')
    assert.equal(other.status().owner, 'parent#two')

    one.release({ token: first.token })
    other.release({ token: second.token })
  })
})

test('10. two independent Node processes race, and exactly one wins', async () => {
  await withProject(async ({ base, workspace, stateRoot }) => {
    const startAt = Date.now() + 1000
    const common = [
      SELF,
      CONTENDER_FLAG,
      '--state-root', stateRoot,
      '--workspace-root', workspace,
      '--hold-ms', '3000',
      '--start-at', String(startAt),
    ]
    const outA = join(base, 'race-a.json')
    const outB = join(base, 'race-b.json')

    const [a, b] = await Promise.all([
      runNode([...common, '--owner', 'race#a', '--out', outA]),
      runNode([...common, '--owner', 'race#b', '--out', outB]),
    ])
    assert.equal(a.code, 0)
    assert.equal(b.code, 0)
    assert.ok(existsSync(outA) && existsSync(outB), 'both contenders wrote a result')

    const resultA = JSON.parse(readFileSync(outA, 'utf8'))
    const resultB = JSON.parse(readFileSync(outB, 'utf8'))
    const winners = [resultA, resultB].filter((row) => row.ok === true)
    const losers = [resultA, resultB].filter((row) => row.ok === false)
    assert.equal(winners.length, 1, 'exactly one process may hold the project writer lease')
    assert.equal(losers.length, 1)
    assert.equal(losers[0].code, 'OMC/WRITER-BUSY')
    assert.equal(winners[0].path, join(stateRoot, 'writer', `${winners[0].key}.json`))

    // The winner exited while still holding the record, so its pid is gone:
    // the next owner must be able to recover it.
    const observer = createWriterLease({ stateRoot, workspaceRoot: workspace, owner: 'observer#1' })
    const after = observer.status()
    assert.equal(after.owner, winners[0].owner)
    assert.equal(after.record.pid, winners[0].pid)
    assert.equal(after.alive, false)
    assert.equal(after.state, 'stale')
    assert.equal(observer.acquire().owner, 'observer#1')
  })
})

test('the record carries ownership fields and lives under <stateRoot>/writer/<key>.json', async () => {
  await withProject(async ({ workspace, stateRoot }) => {
    let nowMs = 2_000_000
    const lease = createWriterLease({
      stateRoot,
      workspaceRoot: workspace,
      owner: 'parent#record',
      heartbeatMs: 100,
      ttlMs: 300,
      now: () => nowMs,
    })
    const acquired = lease.acquire({ token: 'known-token' })
    assert.equal(acquired.path, join(lease.stateRoot, 'writer', `${lease.key}.json`))

    const record = JSON.parse(readFileSync(lease.path, 'utf8'))
    assert.equal(record.schemaVersion, WRITER_LEASE_SCHEMA_VERSION)
    assert.equal(record.key, lease.key)
    assert.equal(record.token, 'known-token')
    assert.equal(record.pid, process.pid)
    assert.equal(record.owner, 'parent#record')
    assert.equal(record.workspaceRoot, realpathSync.native(workspace))
    assert.equal(record.heartbeatAt, nowMs)
    assert.equal(record.expiresAt, nowMs + 300)
    assert.equal(typeof record.updatedAt, 'string')
    assert.equal(record.heartbeatMs, 100)
    assert.equal(record.ttlMs, 300)
    assert.equal(JSON.stringify(record).includes('prompt'), false)
    assert.equal(JSON.stringify(record).includes('credential'), false)

    nowMs += 120
    const heartbeat = lease.heartbeat({ token: 'known-token' })
    assert.equal(heartbeat.heartbeatAt, nowMs)
    assert.equal(heartbeat.expiresAt, nowMs + 300)
    const refreshed = JSON.parse(readFileSync(lease.path, 'utf8'))
    assert.equal(refreshed.heartbeatAt, nowMs)
    assert.equal(refreshed.token, 'known-token')
    assert.equal(refreshed.createdAt, record.createdAt, 'createdAt is preserved across heartbeats')

    lease.release({ token: 'known-token' })
    assert.equal(existsSync(lease.path), false)
  })
})
