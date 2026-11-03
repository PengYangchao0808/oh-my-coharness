/**
 * R02 regressions (0.5.0-alpha.2 practice.2): the per-request budget gate.
 *
 * The point of this file is the case the WP06 tracker could not prove: two
 * INDEPENDENT PROCESSES racing for the last call slot. Everything else here
 * guards the bookkeeping around it — retries, unknown outcomes, restart
 * reconciliation, audited release, and the honesty rules (unknown cost never
 * blocks by itself; a duplicate id never counts twice).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createRequestGate, REQUEST_GATE_VERSION } from '../../integration/request-gate.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const CONTENDER = join(root, 'test', 'fixtures', 'budget-contender.mjs')

function ledgerEntry(ledger, { parentId = 'parent-1', taskId = 'task-1', seq = 1, usd = null, usage = true }) {
  return ledger.append({
    parentId,
    taskId,
    attemptId: `${taskId}#a1`,
    backend: 'native',
    source: { kind: 'dsh-session', sessionId: 'session-1', seq },
    route: { provider: 'deepseek', model: 'deepseek-v4', effort: 'high', observed: true },
    usage: usage ? { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } : null,
    ...(usd === null ? {} : { cost: { usd, source: 'test-price@v1' } }),
  })
}

function runContender(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONTENDER, ...args], { cwd: root, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

test('R02: two independent processes racing for the last slot — exactly one wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-gate-race-'))
  try {
    const startAt = Date.now() + 800
    const outA = join(dir, 'a.json')
    const outB = join(dir, 'b.json')
    const common = ['--dir', join(dir, 'budget'), '--parent', 'raced-parent', '--task', 'raced-task', '--max-calls', '1', '--start-at', String(startAt)]
    const [codeA, codeB] = await Promise.all([
      runContender([...common, '--request', 'req-a', '--out', outA]),
      runContender([...common, '--request', 'req-b', '--out', outB]),
    ])
    assert.equal(codeA, 0)
    assert.equal(codeB, 0)
    assert.ok(existsSync(outA) && existsSync(outB), 'both contenders wrote a result')

    const a = JSON.parse(await readFile(outA, 'utf8'))
    const b = JSON.parse(await readFile(outB, 'utf8'))
    const winners = [a, b].filter((row) => row.allowed === true)
    const losers = [a, b].filter((row) => row.allowed === false)
    assert.equal(winners.length, 1, 'exactly one process may hold the last slot')
    assert.equal(losers.length, 1)
    assert.equal(losers[0].code, 'OMC/BUDGET-EXHAUSTED')
    assert.match(losers[0].reason, /would exceed maxCalls=1/)

    // The authority is the file, not a process-local Map.
    const file = join(dir, 'budget', 'raced-parent.json')
    const body = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(body.schemaVersion, REQUEST_GATE_VERSION)
    const held = Object.values(body.reservations).filter((row) => row.state === 'inflight')
    assert.equal(held.length, 1)
    assert.equal(held[0].modelRequestId, winners[0].modelRequestId)
    assert.equal(body.checkpoint.action, 'stop-partial', 'the losing attempt leaves a persisted stop marker')
    assert.equal(body.checkpoint.budget.maxCalls, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R02: a reservation is one send; duplicates never double count, settlement frees the slot', () => {
  const ledger = createUsageLedger()
  const gate = createRequestGate({ usageLedger: ledger, ownerPid: 1 })
  const limits = { maxCalls: 2 }

  const first = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits })
  assert.equal(first.allowed, true)
  assert.equal(first.duplicate, false)

  const again = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits })
  assert.equal(again.allowed, true)
  assert.equal(again.duplicate, true, 'a re-entrant listener must not consume a second slot')
  assert.equal(gate.budgetView({ parentId: 'p', limits }).inFlight, 1)

  const second = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r2', limits })
  assert.equal(second.allowed, true, 'second slot still fits maxCalls=2')
  const third = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r3', limits })
  assert.equal(third.allowed, false)
  assert.equal(third.code, 'OMC/BUDGET-EXHAUSTED')
  assert.equal(third.budget.exhausted, true)
  assert.equal(third.budget.callsLeft, 0)

  // r2's send was real and its entry landed: settled 'booked' is final.
  ledgerEntry(ledger, { parentId: 'p', taskId: 't', seq: 1 })
  const settled = gate.settle({ parentId: 'p', modelRequestId: 'r2', outcome: 'booked', sourceEventId: 'seq:1' })
  assert.equal(settled.settled, true)
  assert.equal(settled.reservation.state, 'booked')

  // r1 was never sent (cancelled before the wire): the slot comes back.
  const released = gate.settle({ parentId: 'p', modelRequestId: 'r1', outcome: 'refused', note: 'turn cancelled before send' })
  assert.equal(released.settled, true)
  const view = gate.budgetView({ parentId: 'p', limits })
  assert.equal(view.bookedCalls, 1)
  assert.equal(view.inFlight, 0, 'booked reservations are already in the ledger, refused ones hold nothing')
  assert.equal(view.consumed, 1)
  assert.equal(view.exhausted, false)
})

test('R02: retries are separate model requests under one execution attempt', () => {
  const ledger = createUsageLedger()
  const gate = createRequestGate({ usageLedger: ledger })
  const limits = { maxCalls: 3 }
  const attemptId = 'task#a1'

  const ids = new Set()
  for (let step = 0; step < 2; step += 1) {
    const id = gate.nextRequestId({ taskId: 'task', sessionId: 'session-abcdef123', turn: 1, step })
    ids.add(id)
    assert.equal(gate.reserve({ parentId: 'p', taskId: 'task', attemptId, modelRequestId: id, limits }).allowed, true)
  }
  assert.equal(ids.size, 2, 'the same step reserved twice gets two ids, so a retry is a second request')
  assert.equal(gate.budgetView({ parentId: 'p', limits }).inFlight, 2)
})

test('R02: an unknown outcome keeps its slot; only an audited release frees it', () => {
  const gate = createRequestGate({ ownerPid: 7 })
  const limits = { maxCalls: 1 }
  gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits })

  const unknown = gate.settle({ parentId: 'p', modelRequestId: 'r1', outcome: 'unknown', note: 'adapter threw after send' })
  assert.equal(unknown.settled, true)
  assert.equal(gate.budgetView({ parentId: 'p', limits }).inFlight, 1, 'a send that may have happened is not refunded on a guess')
  assert.equal(gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r2', limits }).allowed, false)

  const reconciled = gate.reconcile({ parentId: 'p' })
  assert.equal(reconciled.reconciled.length, 0, 'a settled unknown is not a running reservation')

  assert.throws(() => gate.releaseUnknown({ parentId: 'p', modelRequestId: 'r1' }), /releaseUnknown needs a reason/)
  const released = gate.releaseUnknown({ parentId: 'p', modelRequestId: 'r1', reason: 'operator confirmed no charge', evidence: 'receipt-1' })
  assert.equal(released.released, true)
  assert.equal(gate.budgetView({ parentId: 'p', limits }).inFlight, 0)
  assert.equal(gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r3', limits }).allowed, true)
})

test('R02: restart reconciliation turns a dead process reservation into unknown, not zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-gate-restart-'))
  try {
    const before = createRequestGate({ dir, ownerPid: 111 })
    before.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits: { maxCalls: 1 } })

    // A fresh process (this one, pid differs) re-reads the durable file.
    const after = createRequestGate({ dir, ownerPid: 222 })
    assert.equal(after.budgetView({ parentId: 'p', limits: { maxCalls: 1 } }).inFlight, 1)
    const reconciled = after.reconcile({ parentId: 'p', isAlive: () => false })
    assert.equal(reconciled.reconciled.length, 1)
    const view = after.budgetView({ parentId: 'p', limits: { maxCalls: 1 } })
    assert.equal(view.inFlight, 1, 'still counted')
    assert.equal(view.unknownReservations, 1)
    assert.equal(view.exhausted, true)

    const body = JSON.parse(await readFile(join(dir, 'p.json'), 'utf8'))
    assert.equal(body.reservations.r1.state, 'unknown')
    assert.match(body.reservations.r1.note, /reconciled after restart/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R02: unknown cost never blocks by itself, and the verdict says so', () => {
  const ledger = createUsageLedger()
  ledgerEntry(ledger, { parentId: 'p', taskId: 't', seq: 1, usage: false }) // no usage, no price
  const gate = createRequestGate({ usageLedger: ledger })

  const reserved = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits: { maxUsd: 0.01 } })
  assert.equal(reserved.allowed, true)
  assert.match(reserved.reason, /lower bound/)
  assert.equal(reserved.budget.costKnown, false)
  assert.equal(reserved.budget.exhausted, false)

  // A known cost above the cap does block.
  const priced = createUsageLedger()
  ledgerEntry(priced, { parentId: 'p2', taskId: 't', seq: 1, usd: 0.5 })
  const pricedGate = createRequestGate({ usageLedger: priced })
  const refused = pricedGate.reserve({ parentId: 'p2', taskId: 't', modelRequestId: 'r1', limits: { maxUsd: 0.25 } })
  assert.equal(refused.allowed, false)
  assert.match(refused.reason, /cost budget/)
})

test('R02: per-task caps are scoped, and a task cap does not block another task', () => {
  const gate = createRequestGate()
  const limits = { perTaskCalls: 1 }
  assert.equal(gate.reserve({ parentId: 'p', taskId: 't1', modelRequestId: 'a', limits }).allowed, true)
  assert.equal(gate.reserve({ parentId: 'p', taskId: 't1', modelRequestId: 'b', limits }).allowed, false, 't1 hit its per-task cap')
  assert.equal(gate.reserve({ parentId: 'p', taskId: 't2', modelRequestId: 'c', limits }).allowed, true, 't2 has its own budget')
})

test('R02: a contradictory settlement is recorded, never rewritten', () => {
  const ledger = createUsageLedger()
  const gate = createRequestGate({ usageLedger: ledger })
  gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits: { maxCalls: 3 } })
  ledgerEntry(ledger, { parentId: 'p', taskId: 't', seq: 1 })
  gate.settle({ parentId: 'p', modelRequestId: 'r1', outcome: 'booked' })
  const conflict = gate.settle({ parentId: 'p', modelRequestId: 'r1', outcome: 'unknown' })
  assert.equal(conflict.settled, false)
  assert.equal(conflict.conflict, true)
  assert.equal(gate.budgetView({ parentId: 'p', limits: { maxCalls: 3 } }).inFlight, 0)
})

test('R02: the checkpoint survives a refused second process and is cleared only when room returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-gate-checkpoint-'))
  try {
    const gate = createRequestGate({ dir })
    const limits = { maxCalls: 1 }
    gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r1', limits })
    gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r2', limits })
    const checkpoint = gate.checkpoint('p')
    assert.equal(checkpoint.action, 'stop-partial')
    assert.match(checkpoint.reasons[0], /maxCalls=1/)

    // Room returns (the send was refused before the wire): the next allowed
    // reservation clears the stale stop marker.
    gate.settle({ parentId: 'p', modelRequestId: 'r1', outcome: 'refused', note: 'never sent' })
    const allowed = gate.reserve({ parentId: 'p', taskId: 't', modelRequestId: 'r3', limits })
    assert.equal(allowed.allowed, true)
    assert.equal(gate.checkpoint('p'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
