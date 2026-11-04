/**
 * PR-02 (0.6 C02/C03): unified trusted acceptance.
 *
 * Pins the contract that replaced four self-reporting completion paths:
 *   - a baseline is frozen BEFORE dispatch and bound to the attempt;
 *   - the verdict is produced by the acceptance runner/judge and stored in the
 *     OMC execution record;
 *   - graph.complete/native-managed.settle/managed dispatch all resolve through
 *     the same authority, so a caller string or a home-made `{state:'passed'}`
 *     object can never complete an acceptance node;
 *   - a stale attempt, a late baseline, a changed grader or a changed tree can
 *     only fail, never pass;
 *   - verdict recording is idempotent per attempt/spec/baseline and a
 *     contradictory verdict is a conflict, not a rewrite.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createAcceptanceAuthority, digestsForSpec } from '../../integration/acceptance-verdict.js'
import { treeFingerprint } from '../../integration/work-packet.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { resolveConfig } from '../../src/config.js'

const PARENT = 'parent-pr02'
const TASK = 'task-pr02'

function acceptanceSpec(overrides = {}) {
  return {
    taskId: 'trial-acceptance',
    split: 'development',
    commands: [{ name: 'ok', run: ['node', '-e', '0'], expect: { exitCode: 0 } }],
    acceptanceFiles: [],
    forbidChanges: [],
    ...overrides,
  }
}

function fakeRunner({ fingerprint = 'tree-state', passed = true, acceptanceDigest = 'acc-state' } = {}) {
  return {
    async baseline() {
      return { fingerprint, acceptanceDigest, files: {}, acceptanceFiles: {}, at: new Date().toISOString() }
    },
    async run() {
      return {
        passed,
        fingerprint,
        acceptanceDigest,
        checks: [{ name: 'ok', passed }],
        problems: passed ? [] : ['the fixed check failed'],
        reason: passed ? null : 'OMC/ACCEPTANCE-CHECK: the fixed check failed',
        at: new Date().toISOString(),
      }
    },
    verifyDelivered() { return { passed: true, problems: [] } },
  }
}

function stores() {
  const graph = createGraphStore()
  const executionStore = createExecutionStore()
  const authority = createAcceptanceAuthority({ executionStore })
  graph.setAcceptance(authority)
  return { graph, executionStore, authority }
}

async function claimedGraded({ graph, executionStore, authority, runner, spec, workspace = null, nodeId = 'n1' }) {
  graph.plan(PARENT, [{ id: nodeId, acceptance: ['fixed checks pass'], acceptanceSpec: spec }])
  const claim = graph.claim(PARENT, nodeId, { taskId: TASK, lineage: { source: 'host' }, workspace })
  let attempt = executionStore.open({ taskId: TASK, parentId: PARENT, backend: 'external', intent: { nodeId } })
  const baseline = await authority.freeze({
    spec, workdir: workspace, runner, taskId: TASK, nodeId, attemptId: attempt.currentAttemptId,
  })
  graph.setBaseline(PARENT, nodeId, { baseline, spec, claimId: claim.claimId, attemptId: attempt.currentAttemptId })
  executionStore.launching(TASK, attempt.currentAttemptId, { intent: { nodeId } })
  executionStore.running(TASK, attempt.currentAttemptId)
  return { claim, baseline, attemptId: attempt.currentAttemptId }
}

async function completeWithVerdict({ graph, executionStore, authority, runner, spec, workspace = null, nodeId = 'n1' }) {
  const verified = await graph.verify(PARENT, nodeId, {
    spec, workdir: workspace, runner, attemptId: executionStore.read(TASK)?.currentAttemptId,
  })
  assert.equal(verified.state, 'passed')
  return graph.complete(PARENT, nodeId, {
    status: 'completed', evidence: ['worker note, not the verdict'], workdir: workspace, attemptId: verified.verdict.attemptId,
  })
}

test('PR-02: evidence strings and a forged verdict object cannot complete an acceptance node', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  await claimedGraded({ graph, executionStore, authority, runner, spec })
  executionStore.settle(TASK, null, { execution: 'completed' })

  // Caller string evidence.
  assert.throws(
    () => graph.complete(PARENT, 'n1', { status: 'completed', evidence: ['I ran the tests, they pass'] }),
    (error) => error.code === 'OMC/GRAPH-ACCEPTANCE',
  )
  // A forged verdict object that is not in the trusted record.
  assert.throws(
    () => graph.complete(PARENT, 'n1', {
      status: 'completed',
      verdict: { id: 'accverdict:forged', source: 'caller', baselineId: 'x', specDigest: 'x', state: 'passed' },
    }),
    /ACCEPTANCE/,
  )
  // And a forged object claiming to replace the stored state is not found.
  assert.throws(
    () => graph.complete(PARENT, 'n1', {
      status: 'completed',
      verdict: { id: 'accverdict:made-up', state: 'passed' },
      evidence: ['x'],
    }),
    /ACCEPTANCE/,
  )
  assert.equal(graph.status(PARENT).nodes.find((node) => node.id === 'n1').state, 'running')
})

test('PR-02: a trusted runner verdict completes the node and is recorded with attempt/spec/baseline', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  await claimedGraded({ graph, executionStore, authority, runner, spec })
  executionStore.settle(TASK, null, { execution: 'completed' })

  const completed = await completeWithVerdict({ graph, executionStore, authority, runner, spec })
  const node = completed.node
  assert.equal(node.state, 'completed')
  assert.equal(node.acceptanceState, 'passed')
  assert.equal(node.acceptanceAttemptId, `${TASK}#a1`)
  assert.equal(node.acceptanceVerdict.attemptId, `${TASK}#a1`)
  assert.equal(node.acceptanceVerdict.baselineId, node.acceptanceBaseline.id)
  assert.equal(node.acceptanceVerdict.specDigest, digestsForSpec(spec).digest)
  assert.match(node.evidence.join(' '), /acceptance:passed/)
  assert.match(node.evidence.join(' '), /verdict:accverdict:/)

  const record = executionStore.read(TASK)
  assert.equal(record.acceptance.state, 'passed')
  assert.equal(record.acceptance.attemptId, `${TASK}#a1`)
  assert.ok(record.acceptance.history.some((row) => row.id === node.acceptanceVerdict.id))
  assert.equal(record.delivered, true)
})

test('PR-02: a baseline frozen after launch is refused (late baseline)', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  graph.plan(PARENT, [{ id: 'n1', acceptance: ['x'], acceptanceSpec: spec }])
  const claim = graph.claim(PARENT, 'n1', { taskId: TASK, lineage: { source: 'host' } })
  const attempt = executionStore.open({ taskId: TASK, parentId: PARENT, backend: 'external' })
  executionStore.launching(TASK, attempt.currentAttemptId)
  executionStore.running(TASK, attempt.currentAttemptId)
  executionStore.settle(TASK, attempt.currentAttemptId, { execution: 'completed' })
  // Ensure the wall clock has moved past every lifecycle timestamp so "late"
  // is unambiguous.
  await new Promise((resolve) => setTimeout(resolve, 5))

  // Freeze only now: the run already started. The verdict produced from this
  // baseline must not pass.
  const baseline = await authority.freeze({ spec, workdir: null, runner, taskId: TASK, nodeId: 'n1', attemptId: attempt.currentAttemptId })
  graph.setBaseline(PARENT, 'n1', { baseline, spec, claimId: claim.claimId, attemptId: attempt.currentAttemptId })
  const verified = await graph.verify(PARENT, 'n1', {
    spec, workdir: null, runner, attemptId: attempt.currentAttemptId,
  })
  assert.equal(verified.state, 'unknown')
  assert.match(verified.reason, /BASELINE-LATE/)
  assert.throws(
    () => graph.complete(PARENT, 'n1', { status: 'completed' }),
    /ACCEPTANCE/,
  )
})

test('PR-02: no baseline means no verdict, even when the run completed', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  graph.plan(PARENT, [{ id: 'n1', acceptance: ['x'], acceptanceSpec: spec }])
  graph.claim(PARENT, 'n1', { taskId: TASK, lineage: { source: 'host' } })
  executionStore.open({ taskId: TASK, parentId: PARENT, backend: 'external' })
  executionStore.running(TASK, null)
  executionStore.settle(TASK, null, { execution: 'completed' })

  const verified = await graph.verify(PARENT, 'n1', { spec, workdir: null, runner, attemptId: `${TASK}#a1` })
  assert.equal(verified.state, 'unknown')
  assert.match(verified.reason, /BASELINE/)
  assert.throws(
    () => graph.complete(PARENT, 'n1', { status: 'completed', evidence: ['trust me'] }),
    /ACCEPTANCE/,
  )
})

test('PR-02: a changed grader spec or a changed tree cannot reuse a passed verdict', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'omc-pr02-tree-'))
  try {
    await writeFile(join(workspace, 'delivered.txt'), 'v1', 'utf8')
    const fingerprint = treeFingerprint(workspace).digest
    const { graph, executionStore, authority } = stores()
    const spec = acceptanceSpec({ acceptanceFiles: ['delivered.txt'] })
    const runner = fakeRunner({ fingerprint, acceptanceDigest: null })
    await claimedGraded({ graph, executionStore, authority, runner, spec, workspace })
    executionStore.settle(TASK, null, { execution: 'completed' })
    const completed = await completeWithVerdict({ graph, executionStore, authority, runner, spec, workspace })
    assert.equal(completed.node.acceptanceState, 'passed')

    // A different spec for the same baseline is a tampered grader.
    const tamperedSpec = acceptanceSpec({ acceptanceFiles: ['delivered.txt'], forbidChanges: ['docs/'] })
    const changedSpec = await authority.resolve({
      taskId: TASK, node: completed.node, spec: tamperedSpec, workdir: workspace,
      allowGenerate: false, treeCheck: true,
    })
    assert.equal(changedSpec.ok, false)
    assert.match(changedSpec.reason, /ACCEPTANCE-TAMPERED/)

    // The delivered tree moves after the verdict: the stored fingerprint no
    // longer describes it.
    await writeFile(join(workspace, 'delivered.txt'), 'v2', 'utf8')
    const drift = authority.resolveStored({
      taskId: TASK, node: completed.node, spec, workdir: workspace, treeCheck: true,
      verdict: completed.node.acceptanceVerdict,
    })
    assert.equal(drift.ok, false)
    assert.match(drift.reason, /TREE-DRIFT/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('PR-02: verdict recording is idempotent, and a contradictory one is a conflict', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  await claimedGraded({ graph, executionStore, authority, runner, spec })
  executionStore.settle(TASK, null, { execution: 'completed' })
  const attemptId = executionStore.read(TASK).currentAttemptId

  const freeze = graph.status(PARENT).nodes.find((node) => node.id === 'n1').acceptanceBaseline
  const first = await authority.produce({ spec, workdir: null, runner, taskId: TASK, nodeId: 'n1', attemptId, baseline: freeze })
  const again = await authority.produce({ spec, workdir: null, runner, taskId: TASK, nodeId: 'n1', attemptId, baseline: freeze })
  assert.equal(first.verdict.id, again.verdict.id)
  assert.equal(again.duplicate, true)

  // A contradictory state for the same attempt/spec/baseline is recorded as a
  // conflict and the earlier passed verdict is not rewritten.
  const contradictory = {
    ...first.verdict,
    id: 'accverdict:contradicting',
    state: 'failed',
  }
  const recorded = executionStore.acceptance(TASK, { verdict: contradictory, attemptId })
  assert.equal(recorded.conflict, true)
  assert.equal(executionStore.read(TASK).acceptance.state, 'passed')
  assert.equal(executionStore.read(TASK).acceptance.conflicts.length, 1)

  // Re-recording the identical verdict is a duplicate, not a second history row.
  const duplicate = executionStore.acceptance(TASK, { verdict: first.verdict, attemptId })
  assert.equal(duplicate.duplicate, true)
})

test('PR-02: reopen clears the baseline/verdict so the old attempt cannot settle new work', async () => {
  const { graph, executionStore, authority } = stores()
  const spec = acceptanceSpec()
  const runner = fakeRunner()
  await claimedGraded({ graph, executionStore, authority, runner, spec })
  executionStore.settle(TASK, null, { execution: 'completed' })
  await completeWithVerdict({ graph, executionStore, authority, runner, spec })

  const reopened = graph.reopen(PARENT, 'n1', { reason: 'new requirement' })
  assert.equal(reopened.node.state, 'pending')
  assert.equal(reopened.node.acceptanceVerdict, null)
  assert.equal(reopened.node.acceptanceBaseline, null)
  assert.equal(reopened.node.acceptanceState, 'pending')
  assert.ok(reopened.node.acceptanceHistory.some((row) => row.reopenedFrom === 'completed'))

  // New claim + new execution attempt. The old baseline/verdict no longer
  // matches, so verification refuses instead of inheriting the pass.
  graph.claim(PARENT, 'n1', { taskId: TASK, lineage: { source: 'host' } })
  const second = executionStore.retry(TASK, { reason: 'new requirement' })
  assert.notEqual(second.currentAttemptId, `${TASK}#a1`)
  const verified = await graph.verify(PARENT, 'n1', {
    spec, workdir: null, runner, attemptId: second.currentAttemptId,
  })
  assert.equal(verified.state, 'unknown')
  assert.match(verified.reason, /BASELINE/)
})

test('PR-02: managed dispatch freezes the baseline before launch and uses the same verdict path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'omc-pr02-managed-'))
  try {
    const fingerprint = treeFingerprint(workspace).digest
    const spec = acceptanceSpec()
    const runner = fakeRunner({ fingerprint })
    const graph = createGraphStore()
    const executionStore = createExecutionStore()
    const authority = createAcceptanceAuthority({ executionStore })
    graph.setAcceptance(authority)
    const managed = createManagedExecution({
      graph, mailbox: createMailbox({}), tasks: createTaskRegistry({}), executionStore, acceptance: authority,
    })
    graph.plan(PARENT, [{ id: 'n1', acceptance: ['x'], acceptanceSpec: spec }], { rootTaskId: 'root-1', lineage: { source: 'host' } })

    // A fake dispatch surface that records the order: baseline frozen first,
    // then launch.
    const launchOrder = []
    const baseRunner = fakeRunner({ fingerprint })
    const orderedRunner = {
      ...baseRunner,
      async baseline(options) {
        launchOrder.push('baseline-frozen')
        return baseRunner.baseline(options)
      },
    }
    const rt = {
      cfg: resolveConfig({ surface: 'direct' }),
      registered: new Set(),
      async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } },
      ctx: fakeCtx(launchOrder).ctx,
    }
    const result = await managed.dispatch(rt, {
      harness: 'codex', prompt: 'do the graded work', nodeId: 'n1',
      acceptanceSpec: spec, acceptanceRunner: orderedRunner, cwd: workspace,
    }, { agent: { id: PARENT }, signal: new AbortController().signal })

    assert.equal(result.results[0].status, 'completed')
    assert.equal(result.attempt.acceptance.state, 'passed')
    const node = graph.status(PARENT).nodes.find((row) => row.id === 'n1')
    assert.equal(node.state, 'completed')
    assert.equal(node.acceptanceState, 'passed')
    assert.equal(node.acceptanceBaseline.attemptId, node.acceptanceVerdict.attemptId)
    assert.equal(launchOrder[0], 'baseline-frozen')
    assert.ok(launchOrder.includes('spawned'))
    assert.ok(launchOrder.indexOf('baseline-frozen') < launchOrder.indexOf('spawned'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/**
 * A fake direct-dispatch context. `runOrder` records when the runner froze the
 * baseline versus when the CLI "spawned", so the test can prove the ordering.
 */
function fakeCtx(runOrder) {
  const read = (text) => ({ readFrom: () => ({ text, lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn() {
      runOrder.push('spawned')
      return {
        collected: { stdout: read('ok\n'), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    subprocess,
    get(name) { return name === 'subprocess' ? subprocess : undefined },
    effect(fn) { return fn() },
  }
  return { ctx }
}
