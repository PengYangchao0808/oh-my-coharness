/**
 * R04 regressions (0.5.0-alpha.2): the rule-based session selector and the
 * rotatable worker registry — "why resume/queue/compact/restart/new-packet" is
 * explainable, and the resume rate is never an optimization target.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  SESSION_STRATEGY_VERSION,
  STRATEGY_ACTIONS,
  STRATEGY_RULES_VERSION,
  createDecisionLog,
  decideSessionAction,
} from '../../integration/session-strategy.js'
import {
  WORKER_REGISTRY_VERSION,
  createWorkerRegistry,
  workerKeyFor,
} from '../../integration/worker-registry.js'

const MATCHING = Object.freeze({
  hasPriorWorker: true,
  sameModule: true,
  constraintsMatch: true,
  routeMatch: true,
  permissionMatch: true,
  workspaceMatch: true,
  factsStale: false,
  failureUnclear: false,
  childBusy: false,
  contextOverLimit: false,
  independentReview: false,
})

function decide(features = {}, capabilities = {}) {
  return decideSessionAction({ features: { ...MATCHING, ...features }, capabilities })
}

// ── The rule table ───────────────────────────────────────────────────────────

test('R04: same module with matching constraints resumes', () => {
  const result = decide()
  assert.equal(result.action, 'resume')
  assert.equal(result.ruleId, 'S07-same-module')
  assert.ok(result.reasons.length > 0)
  assert.ok(result.options.includes('resume'))
  assert.ok(result.options.includes('new-packet'))
})

test('R04: an independent review always opens a new packet', () => {
  const result = decide({ independentReview: true })
  assert.equal(result.action, 'new-packet')
  assert.equal(result.ruleId, 'S01-independent-review')
  assert.match(result.reasons.join(' '), /independent review/)
})

test('R04: a changed route/model restarts instead of continuing', () => {
  const result = decide({ routeMatch: false })
  assert.equal(result.action, 'restart')
  assert.equal(result.ruleId, 'S03-reuse-refused')
  assert.match(result.reasons.join(' '), /route/)
  assert.ok(!result.options.includes('resume') || result.options.includes('restart'))
})

test('R04: stale facts, unclear failure and permission drift all refuse reuse', () => {
  for (const [flag, expected] of [
    ['factsStale', /stale/],
    ['failureUnclear', /failure/],
    ['permissionMatch', /permission/],
    ['workspaceMatch', /workspace/],
    ['constraintsMatch', /constraints/],
  ]) {
    const features = flag === 'factsStale' || flag === 'failureUnclear' ? { [flag]: true } : { [flag]: false }
    const result = decide(features)
    assert.equal(result.action, 'restart', `${flag} must refuse reuse`)
    assert.match(result.reasons.join(' '), expected)
  }
})

test('R04: an unknown match flag is never treated as a match', () => {
  // No constraints facts at all: reuse is not proven, so it is not assumed.
  const result = decideSessionAction({
    features: { hasPriorWorker: true, sameModule: true },
  })
  assert.equal(result.action, 'restart')
  assert.match(result.reasons.join(' '), /constraints/)
})

test('R04: a busy child queues, because two tasks never share one session', () => {
  const result = decide({ childBusy: true })
  assert.equal(result.action, 'queue')
  assert.equal(result.ruleId, 'S04-child-busy')
  assert.ok(result.options.includes('queue'))
})

test('R04: over the context limit with a legal compaction interface compacts', () => {
  const result = decide({ contextOverLimit: true }, { compactAvailable: true })
  assert.equal(result.action, 'compact')
  assert.equal(result.ruleId, 'S05-context-compact')
})

test('R04: over the context limit without compaction restarts, never faking a compact', () => {
  const result = decide({ contextOverLimit: true }, { compactAvailable: false })
  assert.equal(result.action, 'restart')
  assert.equal(result.ruleId, 'S06-context-no-compaction')
  assert.match(result.reasons.join('\n'), /no legal compaction interface/i)
  assert.match(result.reasons.join('\n'), /never a fake compact/i)
  assert.ok(!result.options.includes('compact'), 'compact is not a legal option without an interface')
  // An absent capability is the same as no capability.
  assert.equal(decideSessionAction({ features: { hasPriorWorker: true, contextOverLimit: true } }).action, 'restart')
})

test('R04: no prior worker opens a new packet', () => {
  const result = decideSessionAction({ features: { hasPriorWorker: false, sameModule: true } })
  assert.equal(result.action, 'new-packet')
  assert.equal(result.ruleId, 'S02-no-prior-worker')
  assert.deepEqual(result.options, ['new-packet'])
})

test('R04: rule constants and versions are frozen at the documented values', () => {
  assert.equal(SESSION_STRATEGY_VERSION, 1)
  assert.equal(STRATEGY_RULES_VERSION, 1)
  assert.deepEqual([...STRATEGY_ACTIONS], ['resume', 'queue', 'compact', 'restart', 'new-packet'])
})

// ── Decision log: replayable, append-only ────────────────────────────────────

test('R04: decision log round-trips and records outcomes as revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-log-'))
  try {
    const log = createDecisionLog({ dir })
    const features = { ...MATCHING, childBusy: true }
    const decision = decideSessionAction({ features, capabilities: {} })
    const entry = log.record({
      parentId: 'parent-1',
      features,
      capabilities: {},
      decision,
      actualAction: 'queue',
      outcome: 'waiting',
    })
    assert.equal(entry.rulesVersion, STRATEGY_RULES_VERSION)
    assert.ok(entry.id.startsWith('sd-'))
    assert.ok(entry.at)

    log.record({
      parentId: 'parent-1',
      features: MATCHING,
      capabilities: {},
      decision: decideSessionAction({ features: MATCHING }),
      actualAction: 'resume',
    })

    const before = log.list('parent-1')
    assert.equal(before.length, 2)
    assert.equal(before[0].decision.action, 'queue')
    assert.equal(before[0].outcome, 'waiting')
    assert.equal(before[1].outcome, null)

    log.recordOutcome('parent-1', entry.id, 'resumed-after-idle')
    const after = log.list('parent-1')
    assert.equal(after.length, 2, 'a revision never adds or removes a decision')
    assert.equal(after[0].outcome, 'resumed-after-idle', 'the latest revision wins on read')
    assert.equal(after[0].revisionCount, 1)

    // The original decision line is still on disk untouched: history is append-only.
    const lines = (await readFile(join(dir, 'parent-1.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0]).kind, 'decision')
    assert.equal(JSON.parse(lines[0]).outcome, 'waiting')
    assert.equal(JSON.parse(lines[2]).kind, 'revision')

    // A second log instance replays the same answer from disk.
    const reopened = createDecisionLog({ dir })
    assert.equal(reopened.list('parent-1')[0].outcome, 'resumed-after-idle')
    assert.equal(reopened.list('parent-2').length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: the decision log refuses an unknown decision and an invalid action', () => {
  const log = createDecisionLog()
  assert.throws(() => log.record({ parentId: 'p', decision: { action: 'teleport' } }), /OMC\/STRATEGY-DECISION-INVALID/)
  assert.throws(() => log.recordOutcome('p', 'sd-missing', 'done'), /OMC\/STRATEGY-DECISION-UNKNOWN/)
  const ok = createDecisionLog()
  const entry = ok.record({ parentId: 'p', decision: { action: 'resume', ruleId: 'S07' } })
  ok.recordOutcome('p', entry.id, 'worked')
  assert.equal(ok.list('p')[0].outcome, 'worked')
})

// ── Worker key: identity, not source state ───────────────────────────────────

test('R04: the worker key survives unrelated changes and moves with identity', () => {
  const base = {
    projectId: 'proj',
    moduleId: 'integration/worker-registry.js',
    roleId: 'fixer',
    route: { provider: 'deepseek', model: 'deepseek-v4', effort: 'high', observed: true },
    permission: 'workspace-write',
    workspace: 'E:/Calculations/Plugins/Oh-My-CoHarness',
  }
  const key = workerKeyFor(base)
  assert.match(key, /^wk_[0-9a-f]{16}$/)

  // Unrelated facts (observed flag, extra fields, file mtimes/hashes) do not
  // change the identity.
  assert.equal(workerKeyFor({ ...base }), key)
  assert.equal(workerKeyFor({ ...base, route: { ...base.route, observed: false, label: 'route-2' } }), key)
  assert.equal(workerKeyFor({ ...base, sourceHash: 'deadbeef', mtime: 42 }), key)
  // Separator spelling and a trailing slash are the same workspace.
  assert.equal(workerKeyFor({ ...base, workspace: 'E:\\Calculations\\Plugins\\Oh-My-CoHarness\\' }), key)

  assert.notEqual(workerKeyFor({ ...base, route: { ...base.route, model: 'deepseek-v3' } }), key)
  assert.notEqual(workerKeyFor({ ...base, route: { ...base.route, effort: 'low' } }), key)
  assert.notEqual(workerKeyFor({ ...base, permission: 'read-only' }), key)
  assert.notEqual(workerKeyFor({ ...base, workspace: 'E:/other/tree' }), key)
  assert.notEqual(workerKeyFor({ ...base, moduleId: 'integration/session-strategy.js' }), key)
  assert.notEqual(workerKeyFor({ ...base, roleId: 'explorer' }), key)
  assert.notEqual(workerKeyFor({ ...base, projectId: 'other' }), key)
})

test('R04: a missing or partial identity normalises deterministically instead of throwing', () => {
  assert.doesNotThrow(() => workerKeyFor())
  assert.equal(workerKeyFor(), workerKeyFor({}))
  assert.equal(workerKeyFor(undefined), workerKeyFor(null))
  assert.equal(workerKeyFor({ moduleId: '  m  ' }), workerKeyFor({ moduleId: 'm' }))
  assert.equal(workerKeyFor({ permission: ['write', 'read'] }), workerKeyFor({ permission: ['read', 'write'] }))
  assert.notEqual(workerKeyFor({}), workerKeyFor({ moduleId: 'm' }))
})

// ── Worker registry: durable, rotatable, single owner ───────────────────────

function workerParams(overrides = {}) {
  return {
    parentId: 'parent-1',
    workerKey: 'wk_0000000000000001',
    moduleId: 'integration/session-strategy.js',
    roleId: 'fixer',
    route: { provider: 'deepseek', model: 'deepseek-v4', effort: 'high' },
    permission: 'workspace-write',
    workspace: 'E:/Calculations/Plugins/Oh-My-CoHarness',
    childId: 'child-a',
    generation: 1,
    baseline: { sourceHash: 'aaa' },
    ...overrides,
  }
}

test('R04: a registered worker reloads from disk in a new registry instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    const registered = registry.register(workerParams())
    assert.equal(registered.conflict, false)
    assert.equal(registered.created, true)
    assert.equal(registered.worker.generation, 1)
    assert.equal(registered.worker.health, 'unknown', 'an unobserved worker is unknown, not healthy')
    assert.equal(registered.worker.busy, false)
    assert.equal(registered.worker.status, 'active')

    const reopened = createWorkerRegistry({ dir })
    const loaded = reopened.get('wk_0000000000000001')
    assert.equal(loaded.childId, 'child-a')
    assert.equal(loaded.roleId, 'fixer')
    assert.deepEqual(loaded.route, { provider: 'deepseek', model: 'deepseek-v4', effort: 'high', endpoint: null })
    assert.deepEqual(loaded.baseline, { sourceHash: 'aaa' })
    assert.equal(reopened.list('parent-1').length, 1)
    assert.equal(reopened.list('parent-2').length, 0)

    const raw = JSON.parse(await readFile(join(dir, 'parent-1.json'), 'utf8'))
    assert.equal(raw.schemaVersion, WORKER_REGISTRY_VERSION)
    assert.ok(raw.workers.wk_0000000000000001)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: register is idempotent for the same workerKey and generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams())
    const again = registry.register(workerParams({ childId: 'child-a', baseline: { sourceHash: 'bbb' } }))
    assert.equal(again.created, false)
    assert.equal(again.rotated, false)
    assert.equal(again.worker.generation, 1)
    assert.equal(again.worker.childId, 'child-a', 'an idempotent register never moves the child')
    assert.equal(again.worker.history.length, 0)
    assert.deepEqual(again.worker.baseline, { sourceHash: 'bbb' }, 'facts may be refreshed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: rotation bumps the generation and keeps the previous child in history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams())
    const rotated = registry.rotate('wk_0000000000000001', { childId: 'child-b', reason: 'restart: route kept' })
    assert.equal(rotated.generation, 2)
    assert.equal(rotated.childId, 'child-b')
    assert.equal(rotated.history.length, 1)
    assert.equal(rotated.history[0].childId, 'child-a')
    assert.equal(rotated.history[0].generation, 1)
    assert.equal(rotated.history[0].reason, 'restart: route kept')
    assert.equal(rotated.workerKey, 'wk_0000000000000001', 'the logical worker keeps its identity')

    const rotatedAgain = registry.rotate('wk_0000000000000001', { childId: 'child-c' })
    assert.equal(rotatedAgain.generation, 3)
    assert.deepEqual(rotatedAgain.history.map((row) => row.childId), ['child-a', 'child-b'])

    assert.equal(createWorkerRegistry({ dir }).get('wk_0000000000000001').generation, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: a register with a new generation is a recorded rotation, not a silent overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams())
    const bumped = registry.register(workerParams({ childId: 'child-z', generation: 2 }))
    assert.equal(bumped.rotated, true)
    assert.equal(bumped.worker.generation, 2)
    assert.equal(bumped.worker.childId, 'child-z')
    assert.equal(bumped.worker.history.length, 1)
    assert.equal(bumped.worker.history[0].childId, 'child-a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: health updates are observed facts on the current child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams())
    const busy = registry.setHealth('wk_0000000000000001', { busy: true, health: 'ready', childId: 'child-a' })
    assert.equal(busy.busy, true)
    assert.equal(busy.health, 'ready')
    const idle = registry.setHealth('wk_0000000000000001', { busy: false, health: 'degraded' })
    assert.equal(idle.busy, false)
    assert.equal(idle.health, 'degraded')
    assert.equal(createWorkerRegistry({ dir }).get('wk_0000000000000001').health, 'degraded')

    assert.throws(
      () => registry.setHealth('wk_0000000000000001', { busy: false, childId: 'child-other' }),
      /OMC\/WORKER-CHILD-MISMATCH/,
    )
    assert.equal(registry.get('wk_0000000000000001').childId, 'child-a', 'the slot did not move')
    assert.throws(() => registry.setHealth('wk_missing', { busy: true }), /OMC\/WORKER-UNKNOWN/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: a worker key owned by another parent returns conflict and never moves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams({ parentId: 'parent-1', childId: 'child-a' }))
    const conflict = registry.register(workerParams({ parentId: 'parent-2', childId: 'child-b' }))
    assert.equal(conflict.conflict, true)
    assert.equal(conflict.moved, false)
    assert.equal(conflict.worker.parentId, 'parent-1')
    assert.equal(conflict.worker.childId, 'child-a')

    assert.equal(registry.list('parent-2').length, 0)
    assert.equal(createWorkerRegistry({ dir }).get('wk_0000000000000001').parentId, 'parent-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: retirement keeps the slot readable but inactive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-r04-workers-'))
  try {
    const registry = createWorkerRegistry({ dir })
    registry.register(workerParams())
    const retired = registry.retire('wk_0000000000000001', { reason: 'module finished' })
    assert.equal(retired.status, 'retired')
    assert.equal(retired.busy, false)
    assert.equal(retired.retireReason, 'module finished')
    assert.equal(registry.get('wk_0000000000000001').childId, 'child-a')
    assert.throws(() => registry.rotate('wk_nope', {}), /OMC\/WORKER-UNKNOWN/)
    assert.throws(() => registry.register({ workerKey: 'wk_x' }), /OMC\/WORKER-PARENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('R04: the in-memory registry behaves the same without a directory', () => {
  const registry = createWorkerRegistry()
  const registered = registry.register(workerParams())
  assert.equal(registered.created, true)
  assert.equal(registry.list('parent-1').length, 1)
  const rotated = registry.rotate('wk_0000000000000001', { childId: 'child-b' })
  assert.equal(rotated.generation, 2)
  assert.equal(registry.get('wk_0000000000000001').childId, 'child-b')
})
