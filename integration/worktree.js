/**
 * DSH worktree records and explicit merge acceptance.
 *
 * `ctx.worktrees.create()` changes the whole session directory. This module does
 * not pretend that is per-child isolation. It records what was created, and it
 * offers an explicit, no-shell git merge with a clean-tree preflight and a
 * conflict abort so a failed acceptance never leaves a half-merged tree.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(temp, file)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      rmSync(file, { force: true })
      renameSync(temp, file)
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* consumed by rename */ }
  }
}

export function createWorktreeStore({ dir, lockTimeoutMs = 10_000 } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const root = durable ? dir : null
  const cache = new Map()

  function fileFor(parentId) {
    return join(root, safeSegment(parentId, 'parent') + '.json')
  }

  return {
    record(parentId, record) {
      const value = {
        parentId,
        recordedAt: new Date().toISOString(),
        path: record?.path ?? null,
        branch: record?.branch ?? null,
        baseCommit: record?.baseCommit ?? null,
        repositoryRoot: record?.repositoryRoot ?? null,
      }
      if (!durable) {
        cache.set(parentId, value)
        return value
      }
      const lock = acquireFileLockSync(fileFor(parentId), { timeoutMs: lockTimeoutMs, label: 'worktree-record' })
      try {
        atomicWrite(fileFor(parentId), JSON.stringify(value, null, 2) + '\n')
      } finally {
        lock.release()
      }
      return value
    },
    read(parentId) {
      if (!durable) return cache.get(parentId) ?? null
      const file = fileFor(parentId)
      if (!existsSync(file)) return null
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },
  }
}

function readAll(handle) {
  try {
    return handle?.collected?.stdout?.readFrom(0)?.text ?? ''
  } catch {
    return ''
  }
}

function readErr(handle) {
  try {
    return handle?.collected?.stderr?.readFrom(0)?.text ?? ''
  } catch {
    return ''
  }
}

/**
 * Run one literal-argv git command through the Host subprocess service.
 * No shell, no ambient credentials, bounded output.
 */
export async function runGit(ctx, { cwd, args, signal, maxBytes = 64 * 1024 } = {}) {
  if (!ctx?.subprocess?.resolveExecutable || !ctx?.subprocess?.spawn) {
    return { ok: false, code: 'OMC/WORKTREE-SUBPROCESS', output: 'subprocess service is unavailable' }
  }
  let executable
  try {
    executable = await ctx.subprocess.resolveExecutable('git', signal)
  } catch (error) {
    return { ok: false, code: 'OMC/WORKTREE-GIT-MISSING', output: String(error?.message ?? error) }
  }
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: 2_000,
      ...(signal ? { signal } : {}),
    })
    const outcome = await handle.done
    return {
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      output: readAll(handle).trim(),
      error: readErr(handle).trim(),
    }
  } catch (error) {
    return { ok: false, code: 'OMC/WORKTREE-GIT', output: String(error?.message ?? error) }
  } finally {
    try { handle?.terminate?.() } catch { /* already settled */ }
  }
}

/**
 * Merge one retained worktree branch back into the source checkout.
 *
 * Clean-tree preflight, `--no-ff` merge, and `merge --abort` on failure. The
 * caller still owns the acceptance decision: this only guarantees the tree is
 * either merged or untouched.
 */
/** Create a disposable branch checkout for one external dispatch. */
export async function createTaskWorktree(ctx, { repo, name, base = 'HEAD', signal } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '' || !isAbsolute(repo)) {
    return { ok: false, code: 'OMC/WORKTREE-REPO', output: 'worktree mode needs an absolute repository cwd' }
  }
  const rootResult = await runGit(ctx, { cwd: repo, args: ['rev-parse', '--show-toplevel'], signal })
  if (!rootResult.ok) {
    return { ok: false, code: 'OMC/WORKTREE-REPO', output: rootResult.output || rootResult.error || 'not a git repository' }
  }
  const repositoryRoot = rootResult.output.split(/\r?\n/).filter(Boolean).at(-1)
  const safeName = String(name ?? 'task').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  const branch = `omc/${safeName}-${Date.now().toString(36)}`
  const path = join(repositoryRoot, '.agents', 'worktrees', safeName + '-' + Date.now().toString(36))
  const added = await runGit(ctx, { cwd: repositoryRoot, args: ['worktree', 'add', '-b', branch, path, base], signal })
  if (!added.ok) {
    return { ok: false, code: 'OMC/WORKTREE-CREATE', output: added.output || added.error, repositoryRoot, branch }
  }
  return { ok: true, path, branch, baseCommit: base, repositoryRoot }
}

/** Capture status and tracked diff after a disposable dispatch. */
export async function captureTaskWorktree(ctx, path, { signal } = {}) {
  const status = await runGit(ctx, { cwd: path, args: ['status', '--porcelain'], signal })
  const diff = await runGit(ctx, { cwd: path, args: ['diff', '--no-color'], signal })
  return {
    ok: status.ok && diff.ok,
    status: status.output || '',
    diff: diff.output || '',
    files: (status.output || '').split(/\r?\n/)
      .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
      .filter(Boolean),
  }
}

export async function mergeWorktree(ctx, record, { signal } = {}) {
  if (!record?.repositoryRoot || !record?.branch) {
    return { ok: false, code: 'OMC/WORKTREE-RECORD', output: 'no retained worktree record for this session' }
  }
  const root = record.repositoryRoot
  const branch = record.branch
  const status = await runGit(ctx, { cwd: root, args: ['status', '--porcelain'], signal })
  if (!status.ok) return { ok: false, code: 'OMC/WORKTREE-GIT', output: status.output || status.error }
  if (status.output !== '') {
    return {
      ok: false,
      code: 'OMC/WORKTREE-DIRTY',
      output: 'the source checkout has uncommitted changes; commit or stash them before merging',
    }
  }
  const merged = await runGit(ctx, { cwd: root, args: ['merge', '--no-ff', branch], signal })
  if (merged.ok) {
    const check = await runGit(ctx, { cwd: root, args: ['diff', '--check', 'HEAD^', 'HEAD'], signal })
    return {
      ok: check.ok,
      code: check.ok ? null : 'OMC/WORKTREE-DIFF-CHECK',
      output: [merged.output, check.output].filter(Boolean).join('\n'),
      branch,
    }
  }
  // Never leave a conflicted index behind after an unsuccessful acceptance.
  await runGit(ctx, { cwd: root, args: ['merge', '--abort'], signal })
  return {
    ok: false,
    code: 'OMC/WORKTREE-MERGE-CONFLICT',
    output: [merged.output, merged.error].filter(Boolean).join('\n') || 'merge failed; aborted',
    branch,
  }
}
