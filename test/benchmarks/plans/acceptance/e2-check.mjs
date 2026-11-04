#!/usr/bin/env node
/**
 * E2 acceptance wrapper (real OMC checkout worktree).
 *
 * Runs the fixture's own fixed acceptance script against the worker's `src/`
 * directory. The worker creates `src/` from `start/src` and edits it; if it is
 * missing, the wrapper copies `start/src` once so an untouched delivery is
 * graded as the start state (which fails), never silently skipped.
 *
 * It never edits `start/`, `acceptance/`, `reference/` or `spec.json`; the
 * acceptance runner digests those before/after the run.
 *
 * Usage: node e2-check.mjs <fixture-repo-relative-path>
 * The process cwd is the isolated worktree root.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fixture = process.argv[2]
if (!fixture) {
  console.error('usage: e2-check.mjs <fixture-repo-relative-path>')
  process.exit(2)
}

const dir = resolve(process.cwd(), fixture)
if (!existsSync(join(dir, 'start', 'src'))) {
  console.error(`fail: no fixture start tree at ${join(dir, 'start', 'src')}`)
  process.exit(2)
}
if (!existsSync(join(dir, 'src'))) {
  cpSync(join(dir, 'start', 'src'), join(dir, 'src'), { recursive: true })
}

const check = join(dir, 'acceptance', 'check.mjs')
if (!existsSync(check)) {
  console.error(`fail: no acceptance script at ${check}`)
  process.exit(2)
}

const run = spawnSync(process.execPath, [check], { cwd: dir, encoding: 'utf8' })
process.stdout.write(run.stdout ?? '')
if (run.stderr) process.stderr.write(run.stderr)
process.exit(typeof run.status === 'number' ? run.status : 1)
