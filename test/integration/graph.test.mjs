import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createGraphStore,
  inScope,
  mergeAcceptance,
  normalizeScope,
  scopesOverlap,
  validateNodes,
} from '../../integration/graph.js'

const PLAN = [
  { id: 'explore', role: 'explorer', title: 'find the bug' },
  { id: 'review', role: 'oracle', deps: ['explore'], acceptance: ['names the failing line'] },
  { id: 'fix', role: 'fixer', deps: ['review'], write: true, writeScope: ['src/'] },
  { id: 'verify', role: 'oracle', deps: ['fix'], acceptance: ['tests pass'] },
]

test('graph validation rejects unknown dependencies, cycles and escape scopes', () => {
  assert.throws(() => validateNodes([{ id: 'a', deps: ['missing'] }]), /unknown node/)
  assert.throws(() => validateNodes([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]), /cycle/)
  assert.throws(() => normalizeScope(['/etc/passwd']), /workspace-relative/)
  assert.throws(() => normalizeScope(['../outside']), /workspace-relative/)
})

test('scope matching and overlap are workspace-relative', () => {
  assert.equal(inScope('src/a.js', ['src/']), true)
  assert.equal(inScope('docs/a.md', ['src/']), false)
  assert.equal(inScope('src/a.js', []), true, 'empty scope means the whole workspace')
  assert.equal(scopesOverlap(['src/'], ['src/lib/']), true)
  assert.equal(scopesOverlap(['src/'], ['docs/']), false)
})

test('dependencies, acceptance and write claims are enforced at runtime', async () => {
  const store = createGraphStore()
  store.plan('parent', PLAN)
  assert.deepEqual(store.status('parent').ready, ['explore'])
  assert.throws(() => store.claim('parent', 'review'), /waits for "explore"/)

  store.claim('parent', 'explore')
  store.complete('parent', 'explore', { evidence: ['found inventory.mjs:5'] })
  assert.deepEqual(store.status('parent').ready, ['review'])

  store.claim('parent', 'review')
  assert.throws(() => store.complete('parent', 'review'), /no evidence/)
  store.complete('parent', 'review', { evidence: ['line 5 loop bound'] })
  store.claim('parent', 'fix')
  assert.throws(() => store.complete('parent', 'fix'), /changed-file list/)
  assert.throws(() => store.complete('parent', 'fix', { changedFiles: ['docs/readme.md'] }), /outside its scope/)
  assert.equal(store.status('parent').nodes.find((node) => node.id === 'fix').state, 'failed')
})

test('two running write nodes with overlapping scopes cannot coexist', () => {
  const store = createGraphStore()
  store.plan('parent', [
    { id: 'one', write: true, writeScope: ['src/'] },
    { id: 'two', write: true, writeScope: ['src/lib/'] },
  ])
  store.claim('parent', 'one')
  assert.throws(() => store.claim('parent', 'two'), /WRITE-CONFLICT/)
})

test('a merge acceptance gate refuses pending nodes and nodes without evidence', () => {
  const pending = { nodes: [{ id: 'write', state: 'running', acceptance: ['tests'], evidence: [] }] }
  assert.equal(mergeAcceptance(pending, 'write').ok, false)
  const noEvidence = { nodes: [{ id: 'write', state: 'completed', acceptance: ['tests'], evidence: [] }] }
  assert.equal(mergeAcceptance(noEvidence, 'write').ok, false)
  const accepted = { nodes: [{ id: 'write', state: 'completed', acceptance: ['tests'], evidence: ['npm test'] }] }
  assert.equal(mergeAcceptance(accepted, 'write').ok, true)
  assert.equal(mergeAcceptance(accepted, 'missing').ok, false)
})

test('a durable graph survives a new store instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-graph-'))
  try {
    const first = createGraphStore({ dir })
    first.plan('parent', PLAN)
    first.claim('parent', 'explore')
    first.complete('parent', 'explore', { evidence: ['found'] })
    const second = createGraphStore({ dir })
    const status = second.status('parent')
    assert.equal(status.nodes.find((node) => node.id === 'explore').state, 'completed')
    assert.deepEqual(status.ready, ['review'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
