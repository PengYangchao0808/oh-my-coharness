import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { applyProjectPolicy, readProjectPolicy } from '../../integration/project-policy.js'
import { resolveConfig } from '../../src/config.js'

async function projectWith(document) {
  const dir = await mkdtemp(join(tmpdir(), 'omc-project-'))
  await mkdir(join(dir, '.omc'), { recursive: true })
  await writeFile(join(dir, '.omc', 'project.json'), typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return dir
}

test('project policy can only tighten dispatch, harnesses and routing', async () => {
  const dir = await projectWith({
    dispatch: { maxParallel: 2, timeoutMs: 30_000, defaultMode: 'read-only', allowDirectFallback: false },
    harnesses: { codex: { enabled: false }, opencode: { enabled: true } },
    routing: { enabled: false, allowPaidApi: false, allowUnknownBilling: false },
  })
  try {
    const result = readProjectPolicy(dir)
    assert.equal(result.exists, true)
    assert.equal(result.policy.dispatch.maxParallel, 2)
    const cfg = resolveConfig({
      dispatch: { maxParallel: 8, timeoutMs: 600_000, defaultMode: 'in-place', allowDirectFallback: true },
      harnesses: { codex: { enabled: true }, opencode: { enabled: false } },
      routing: { enabled: true, allowPaidApi: true, allowUnknownBilling: true },
    })
    const constrained = applyProjectPolicy(cfg, result.policy)
    assert.equal(constrained.dispatch.maxParallel, 2)
    assert.equal(constrained.dispatch.timeoutMs, 30_000)
    assert.equal(constrained.dispatch.defaultMode, 'read-only')
    assert.equal(constrained.dispatch.allowDirectFallback, false)
    assert.equal(constrained.harnesses.codex.enabled, false)
    assert.equal(constrained.harnesses.opencode.enabled, false, 'a project cannot enable a harness')
    assert.equal(constrained.routing.enabled, false)
    assert.equal(constrained.routing.allowPaidApi, false)
    assert.equal(constrained.routing.allowUnknownBilling, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a project cannot widen a limit or enable an unsafe feature', async () => {
  const dir = await projectWith({
    dispatch: { maxParallel: 99, timeoutMs: 86_400_000, allowDirectFallback: true },
    harnesses: { codex: { enabled: true } },
    routing: { enabled: true, allowPaidApi: true, allowUnknownBilling: true },
  })
  try {
    const result = readProjectPolicy(dir)
    assert.ok(result.warnings.some((warning) => warning.includes('cannot enable')))
    const cfg = resolveConfig({ dispatch: { maxParallel: 2, timeoutMs: 30_000, allowDirectFallback: false } })
    const constrained = applyProjectPolicy(cfg, result.policy)
    assert.equal(constrained.dispatch.maxParallel, 2, 'a larger project cap is ignored')
    assert.equal(constrained.dispatch.timeoutMs, 30_000)
    assert.equal(constrained.dispatch.allowDirectFallback, false)
    assert.equal(constrained.harnesses.codex.enabled, true, 'operator remains enabled')
    assert.equal(constrained.routing.enabled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed project file is reported, never treated as permissive', async () => {
  const dir = await projectWith('{ not json')
  try {
    const result = readProjectPolicy(dir)
    assert.equal(result.exists, true)
    assert.equal(result.policy.dispatch, undefined)
    assert.match(result.warnings[0], /not valid JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing project file adds no policy', () => {
  const result = readProjectPolicy(join(tmpdir(), 'omc-no-such-project-' + Date.now()))
  assert.equal(result.exists, false)
  assert.deepEqual(result.policy, {})
})
