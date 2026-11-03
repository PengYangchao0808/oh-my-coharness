import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  captureTaskWorktree,
  createTaskWorktree,
  createWorktreeStore,
  mergeWorktree,
  runGit,
} from '../../integration/worktree.js'

function fakeGit(responder) {
  const calls = []
  return {
    calls,
    ctx: {
      subprocess: {
        async resolveExecutable() { return 'C:/git/git.exe' },
        spawn(spec) {
          const args = spec.argv.slice(1)
          calls.push(args)
          const result = responder(args, spec)
          const read = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
          return {
            collected: { stdout: read(result.stdout ?? ''), stderr: read(result.stderr ?? '') },
            done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
            terminate() {},
          }
        },
      },
    },
  }
}

test('worktree records are durable and per parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-worktree-'))
  try {
    const first = createWorktreeStore({ dir })
    first.record('parent', {
      path: 'C:/repo/.agents/worktrees/w1', branch: 'omc/w1', baseCommit: 'abc', repositoryRoot: 'C:/repo',
    })
    const second = createWorktreeStore({ dir })
    const record = second.read('parent')
    assert.equal(record.branch, 'omc/w1')
    assert.equal(record.repositoryRoot, 'C:/repo')
    assert.equal(second.read('other'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a task worktree is a branch checkout under the repository root', async () => {
  const git = fakeGit((args) => {
    if (args[0] === 'rev-parse') return { stdout: 'C:/repo\n' }
    if (args[0] === 'worktree' && args[1] === 'add') return { stdout: 'Preparing worktree\n' }
    return { stdout: '' }
  })
  const created = await createTaskWorktree(git.ctx, { repo: 'C:/repo', name: 'task-codex' })
  assert.equal(created.ok, true)
  assert.equal(created.repositoryRoot, 'C:/repo')
  assert.match(created.branch, /^omc\/task-codex-/)
  assert.match(created.path.replace(/\\/g, '/'), /^C:\/repo\/\.agents\/worktrees\/task-codex-/)
  assert.deepEqual(git.calls[0], ['rev-parse', '--show-toplevel'])
  assert.equal(git.calls[1][0], 'worktree')
  assert.equal(git.calls[1][1], 'add')
})

test('task worktree capture returns status, tracked diff and files', async () => {
  const git = fakeGit((args) => {
    if (args[0] === 'status') return { stdout: ' M src/a.js\n?? docs/new.md\n' }
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n' }
    return { stdout: '' }
  })
  const captured = await captureTaskWorktree(git.ctx, 'C:/repo/.agents/worktrees/w')
  assert.equal(captured.ok, true)
  assert.deepEqual(captured.files, ['src/a.js', 'docs/new.md'])
  assert.match(captured.diff, /diff --git/)
})

test('merge preflight refuses a dirty source tree', async () => {
  const git = fakeGit((args) => args[0] === 'status'
    ? { stdout: ' M src/a.js\n' }
    : { stdout: '' })
  const result = await mergeWorktree(git.ctx, { branch: 'omc/w1', repositoryRoot: 'C:/repo' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OMC/WORKTREE-DIRTY')
  assert.equal(git.calls.some((args) => args[0] === 'merge'), false)
})

test('merge success runs --no-ff and a diff check', async () => {
  const git = fakeGit(() => ({ stdout: '' }))
  const result = await mergeWorktree(git.ctx, { branch: 'omc/w1', repositoryRoot: 'C:/repo' })
  assert.equal(result.ok, true)
  assert.deepEqual(git.calls[0], ['status', '--porcelain'])
  assert.deepEqual(git.calls[1], ['merge', '--no-ff', 'omc/w1'])
  assert.deepEqual(git.calls[2], ['diff', '--check', 'HEAD^', 'HEAD'])
})

test('a failed merge is aborted and never left half-applied', async () => {
  const git = fakeGit((args) => args[0] === 'merge' && args[1] === '--no-ff'
    ? { exitCode: 1, stdout: 'CONFLICT' }
    : { stdout: '' })
  const result = await mergeWorktree(git.ctx, { branch: 'omc/w1', repositoryRoot: 'C:/repo' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OMC/WORKTREE-MERGE-CONFLICT')
  assert.deepEqual(git.calls.at(-1), ['merge', '--abort'])
})

test('runGit reports an unavailable subprocess service instead of throwing', async () => {
  const result = await runGit({}, { cwd: 'C:/repo', args: ['status'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OMC/WORKTREE-SUBPROCESS')
})
