/**
 * WP03 regressions (0.5.0-alpha.2): the shared WorkPacket contract and the
 * artifact store — A09/A10.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildWorkPacket,
  fitWorkPacket,
  renderWorkPacket,
  treeFingerprint,
  validateWorkPacket,
} from '../../integration/work-packet.js'
import { createArtifactStore } from '../../integration/artifact-store.js'
import { createHandoff } from '../../integration/handoff.js'

const BASE = {
  taskId: 'task-wp03',
  laneId: 'lane-oracle-proj',
  role: 'oracle',
  goal: 'Audit the retry path and report failure classes.',
  acceptance: ['all retry classes listed with evidence', 'no class invented without a log line'],
  reads: [{ ref: 'src/dispatch.js', why: 'retry loop' }],
  writeScope: [],
  commit: '68f9644',
  treeDigest: 'abc123',
  facts: [{
    statement: 'agent/request-error retry re-enters agent/request',
    sourceRef: 'dsh-agent-loop/lib/index.js',
    sourceDigest: 'sha256:deadbeef',
    observedAt: '2026-11-03T13:40:00Z',
  }],
  openQuestions: ['does the direct surface see the same waterfall?'],
}

// ── A09: one contract for native and external ───────────────────────────────

test('A09: the same packet validates and renders for both surfaces', () => {
  const packet = buildWorkPacket(BASE)
  assert.equal(packet.version, 1)
  assert.equal(packet.constraints.readOnly, true)
  const text = renderWorkPacket(packet)
  assert.match(text, /WorkPacket task-wp03/)
  assert.match(text, /Acceptance:/)
  assert.match(text, /Baseline: commit 68f9644/)

  // The handoff (external identity + signature base) round-trips inside it.
  const handoff = createHandoff({ roleId: 'oracle', cwd: 'e:/work/proj', taskId: 'task-wp03' })
  const withHandoff = buildWorkPacket({ ...BASE, handoff })
  assert.equal(withHandoff.handoff.version, 1)
  assert.equal(withHandoff.handoff.taskId, 'task-wp03')
})

test('A09: a fact without provenance is refused — it is an open question, not a fact', () => {
  assert.throws(
    () => buildWorkPacket({ ...BASE, facts: [{ statement: 'no source' }] }),
    (error) => error.code === 'OMC/PACKET-INVALID' && /sourceRef, sourceDigest and observedAt/.test(error.message),
  )
  // With provenance in an open question it is honest and accepted.
  const packet = buildWorkPacket({ ...BASE, facts: [], openQuestions: ['no source (unverified: needs a log line)'] })
  assert.equal(packet.facts.length, 0)
})

test('A09: a packet without acceptance or baseline is refused', () => {
  assert.throws(() => buildWorkPacket({ ...BASE, acceptance: [] }), /acceptance/)
  assert.throws(() => buildWorkPacket({ ...BASE, commit: null, treeDigest: null }), /baseline/)
})

test('A09: over-limit packets externalize material but never the contract', () => {
  const store = createArtifactStore({})
  const fat = {
    ...BASE,
    facts: Array.from({ length: 40 }, (_, i) => ({
      statement: `fact ${i} `.repeat(30).trim(),
      sourceRef: `src/file-${i}.js`,
      sourceDigest: `sha256:${i}`,
      observedAt: '2026-11-03T13:40:00Z',
    })),
  }
  const packet = buildWorkPacket(fat)
  const before = renderWorkPacket(packet).length
  const fitted = fitWorkPacket(packet, { maxChars: Math.max(3000, before - 3000), artifactStore: store })
  assert.ok(fitted.externalized.length >= 1, 'facts were externalized')
  const after = renderWorkPacket(fitted.packet).length
  assert.ok(after <= Math.max(3000, before - 3000), `packet shrank (${before} → ${after})`)
  // The contract survives: acceptance and budget are untouched.
  assert.deepEqual(fitted.packet.acceptance, packet.acceptance)
  assert.equal(fitted.packet.budget.maxCalls, packet.budget.maxCalls)

  // Still too large even after externalizing: refuse, never trim.
  assert.throws(
    () => fitWorkPacket(packet, { maxChars: 500, artifactStore: store }),
    (error) => error.code === 'OMC/PACKET-TOO-LARGE' && /shrink the task/.test(error.message),
  )
})

// ── A10: artifacts are verifiable, bounded and refuse to guess ──────────────

test('A10: artifacts round-trip with provenance, hash and bounded expansion', () => {
  const store = createArtifactStore({})
  const artifact = store.put({ parentId: 'p', taskId: 'task-wp03', attemptId: 'task-wp03#a1', kind: 'tool-output', label: 'log', content: 'x'.repeat(5000) })
  assert.match(artifact.artifactId, /^art-/)
  assert.equal(artifact.chars, 5000)

  const full = store.read(artifact.artifactId)
  assert.equal(full.truncated, false)
  assert.equal(full.text.length, 5000)

  const bounded = store.read(artifact.artifactId, { maxChars: 100 })
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.text.length, 100)

  const ref = store.reference(artifact.artifactId)
  assert.equal(store.resolveReference(ref), artifact.artifactId)
  assert.equal(store.resolveReference('not-a-ref'), null)
})

test('A10: missing, corrupt and stale artifacts are typed errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp03-art-'))
  try {
    const store = createArtifactStore({ dir })
    const artifact = store.put({ parentId: 'p', taskId: 't', content: 'payload' })
    const metaFile = join(dir, `${artifact.artifactId}.json`)
    const blobFile = join(dir, `${artifact.artifactId}.txt`)

    // Missing metadata → OMC/ARTIFACT-MISSING.
    await rm(metaFile, { force: true })
    assert.throws(() => store.read(artifact.artifactId), (e) => e.code === 'OMC/ARTIFACT-MISSING')

    // A fresh store and artifact, then a corrupted blob → OMC/ARTIFACT-CORRUPT.
    const store2 = createArtifactStore({ dir })
    const again = store2.put({ parentId: 'p', taskId: 't', content: 'payload' })
    assert.equal(store2.verify(again.artifactId).ok, true)
    await writeFile(join(dir, `${again.artifactId}.txt`), 'tampered', 'utf8')
    assert.throws(() => store2.read(again.artifactId), (e) => e.code === 'OMC/ARTIFACT-CORRUPT')
    assert.equal(store2.verify(again.artifactId).ok, false)

    // An illegal id never reaches the filesystem layer.
    assert.throws(() => store2.meta('../../etc/passwd'), (e) => e.code === 'OMC/ARTIFACT-INVALID-ID')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A10: the tree fingerprint covers uncommitted work and non-Git trees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp03-tree-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.js'), 'export const a = 1\n', 'utf8')
    const first = treeFingerprint(dir)
    assert.equal(first.truncated, false)
    assert.equal(first.files, 1)

    // An uncommitted change changes the digest: the baseline stays attributable.
    await writeFile(join(dir, 'src', 'a.js'), 'export const a = 2\n', 'utf8')
    const second = treeFingerprint(dir)
    assert.notEqual(second.digest, first.digest)

    // A stale recorded digest is detectable against the current tree.
    const current = treeFingerprint(dir)
    assert.notEqual(first.digest, current.digest)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A09: a stale fact reference is detectable through the store', () => {
  const store = createArtifactStore({})
  const artifact = store.put({ parentId: 'p', taskId: 't', content: 'evidence text' })
  // The packet records the artifact reference AND the digest it was captured
  // against; verification with the wrong expectation reports stale.
  assert.equal(store.verify(artifact.artifactId, { mustMatch: artifact.contentHash }).ok, true)
  const stale = store.verify(artifact.artifactId, { mustMatch: 'sha256:other-tree' })
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, 'OMC/ARTIFACT-STALE')
})
