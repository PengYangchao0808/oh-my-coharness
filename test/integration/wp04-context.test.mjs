/**
 * WP04 regressions (0.5.0-alpha.2): context view and retrieval cache —
 * A11/A12.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createContextView, HISTORY_VIEW_CAPABILITY } from '../../integration/context-view.js'
import { createRetrievalCache, retrievalKey } from '../../integration/retrieval-cache.js'
import { createArtifactStore } from '../../integration/artifact-store.js'

// ── A11: long tool echo becomes a short view + restorable evidence ──────────

test('A11: short outputs pass through unchanged; long outputs become head/tail + artifact', () => {
  const artifacts = createArtifactStore({})
  const view = createContextView({ artifacts, maxToolTextChars: 200 })
  const short = view.view({ tool: 'read', text: 'tiny output', exitCode: 0 })
  assert.equal(short.stored, false)
  assert.match(short.view, /\[omc read exit 0\]\ntiny output/)

  const long = view.view({
    tool: 'pwsh', text: 'line\n'.repeat(500), exitCode: 0,
    parentId: 'p', taskId: 't', attemptId: 't#a1',
  })
  assert.equal(long.stored, true)
  assert.ok(long.chars > 2000)
  assert.match(long.view, /characters omitted/)
  assert.match(long.view, /full output stored as omc-artifact:/)

  // The original evidence is restorable and complete.
  const expanded = view.expand(long.artifactId)
  assert.equal(expanded.truncated, false)
  assert.equal(expanded.text.length, long.chars)
  assert.equal(expanded.meta.source.taskId, 't')

  // A bounded expansion reports truncation.
  const bounded = view.expand(long.artifactId, { maxChars: 50 })
  assert.equal(bounded.truncated, true)

  // The capability marker keeps the host-level history transform honestly
  // unenabled (WP00 found the seam; pairing/replay validation is outstanding).
  assert.equal(HISTORY_VIEW_CAPABILITY.status, 'not-enabled')
  assert.equal(view.capability.historyViewTransform.status, 'not-enabled')
})

test('A11: errored and empty echoes stay visible as facts', () => {
  const view = createContextView({ maxToolTextChars: 100 })
  const errored = view.view({ tool: 'pwsh', text: 'boom', exitCode: 1, error: true })
  assert.match(errored.view, /ERRORED/)
  const empty = view.view({ tool: 'read', text: '', exitCode: 0 })
  assert.match(empty.view, /no output/)
})

// ── A12: the retrieval cache hits only on proven identity ───────────────────

test('A12: same inputs hit; changed source, changed tool version, side effects miss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp04-'))
  try {
    const file = join(dir, 'source.js')
    await writeFile(file, 'export const a = 1\n', 'utf8')
    const cache = createRetrievalCache({})

    const inputsOf = async () => [{ path: 'source.js', digest: cache.fingerprint(file) }]
    const base = { workspace: 'e:/proj', tool: 'read', toolVersion: '1', args: { path: 'source.js' }, inputs: await inputsOf() }

    const stored = cache.store({ ...base, value: 'export const a = 1' })
    assert.equal(stored.stored, true)

    const hit = cache.lookup(base)
    assert.equal(hit.hit, true)
    assert.equal(hit.value, 'export const a = 1')
    assert.equal(hit.evidenceOnly, false)

    // Source file changed → different digest → different key → miss.
    await writeFile(file, 'export const a = 2\n', 'utf8')
    const stale = cache.lookup({ ...base, inputs: await inputsOf() })
    assert.equal(stale.hit, false)
    assert.equal(stale.reason, 'not-cached')

    // Restore, then change the tool version → miss.
    await writeFile(file, 'export const a = 1\n', 'utf8')
    assert.equal(cache.lookup({ ...base, toolVersion: '2', inputs: await inputsOf() }).hit, false)

    // A side-effect command is not on the allowlist: no key, never cached.
    assert.equal(retrievalKey({ ...base, tool: 'pwsh', inputs: await inputsOf() }), null)
    const sideEffect = cache.store({ ...base, tool: 'pwsh', value: 'done' })
    assert.equal(sideEffect.stored, false)
    assert.equal(sideEffect.reason, 'unprovable-inputs')

    // A failed read is never cached.
    const failed = cache.store({ ...base, value: '', exitCode: 1, inputs: await inputsOf() })
    assert.equal(failed.stored, false)
    assert.equal(failed.reason, 'read-failed')

    // Unreadable input digests are unprovable → miss by construction.
    const unreadable = cache.lookup({ ...base, inputs: [{ path: 'gone.js', digest: null }] })
    assert.equal(unreadable.hit, false)
    assert.equal(unreadable.reason, 'unprovable-inputs')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A12: test evidence is reusable but never replaces final acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp04-ev-'))
  try {
    const file = join(dir, 'test.js')
    await writeFile(file, 'test("a", () => {})\n', 'utf8')
    const cache = createRetrievalCache({})
    const inputs = [{ path: 'test.js', digest: cache.fingerprint(file) }]
    cache.store({ workspace: 'e:/proj', tool: 'read', toolVersion: '1', args: {}, inputs, value: '1 passing', kind: 'test-evidence' })
    const hit = cache.lookup({ workspace: 'e:/proj', tool: 'read', toolVersion: '1', args: {}, inputs })
    assert.equal(hit.hit, true)
    assert.equal(hit.evidenceOnly, true)
    assert.match(hit.note, /final acceptance/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A12: invalidation drops matching entries only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp04-inv-'))
  try {
    const fileA = join(dir, 'a.js')
    const fileB = join(dir, 'b.js')
    await writeFile(fileA, 'a\n', 'utf8')
    await writeFile(fileB, 'b\n', 'utf8')
    const cache = createRetrievalCache({})
    cache.store({ workspace: 'w', tool: 'read', toolVersion: '1', args: { path: 'a.js' }, inputs: [{ path: 'a.js', digest: cache.fingerprint(fileA) }], value: 'a' })
    cache.store({ workspace: 'w', tool: 'read', toolVersion: '1', args: { path: 'b.js' }, inputs: [{ path: 'b.js', digest: cache.fingerprint(fileB) }], value: 'b' })
    const dropped = cache.invalidate((entry) => entry.inputs.some((input) => input.path === 'a.js'))
    assert.equal(dropped.length, 1)
    assert.equal(cache.lookup({ workspace: 'w', tool: 'read', toolVersion: '1', args: { path: 'a.js' }, inputs: [{ path: 'a.js', digest: cache.fingerprint(fileA) }] }).hit, false)
    assert.equal(cache.lookup({ workspace: 'w', tool: 'read', toolVersion: '1', args: { path: 'b.js' }, inputs: [{ path: 'b.js', digest: cache.fingerprint(fileB) }] }).hit, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
