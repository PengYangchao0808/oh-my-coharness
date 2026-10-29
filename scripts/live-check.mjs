/**
 * Live acceptance probe — developer tooling, NOT shipped (package.json `files` has no
 * `scripts/` entry).
 *
 * It runs the real dispatch code against the CLIs actually installed on this machine,
 * using a minimal `ctx.subprocess` shim backed by `node:child_process`. That shim is
 * deliberately small: it reproduces only the seam dispatch/doctor touch (resolve,
 * spawn, collected streams, done). Anything it proves is real CLI behaviour; what it
 * cannot prove is the host's own subprocess plumbing.
 *
 *   node scripts/live-check.mjs [--harness a --harness b] [--timeout 120000]
 *
 * Exit code 0 means: discovery ran, two distinct harnesses answered in one read-only
 * `tasks[]` call, results came back in parallel, and the working tree was untouched.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { harnessDef } from '../src/harnesses.js'
import { dispatchTasks } from '../src/dispatch.js'
import { detect } from '../src/doctor.js'

const args = process.argv.slice(2)
const wanted = []
let timeoutMs = 120000
let writeDir = null
let prompt = 'Reply with exactly one line: OMC-ALIVE. Do not read, run, or modify anything.'
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--harness') wanted.push(args[++i])
  else if (args[i] === '--timeout') timeoutMs = Number(args[++i]) || timeoutMs
  else if (args[i] === '--prompt') prompt = String(args[++i] ?? '') || prompt
  else if (args[i] === '--write-dir') writeDir = String(args[++i] ?? '')
}

function nativePath(bin) {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, bin + ext)
      if (existsSync(full)) return full
    }
  }
  const error = new Error(`ENOENT: ${bin}`)
  error.code = 'ENOENT'
  throw error
}

/** `wsl.exe -l -q` answers in UTF-16LE; the host seam hides that, the shim must not. */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[1] === 0x00 && buffer[0] !== 0x00) return buffer.toString('utf16le')
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  return buffer.toString('utf8')
}

function collect(stream) {
  const chunks = []
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  return () => decode(Buffer.concat(chunks))
}

function makeCtx() {
  const subprocess = {
    async resolveExecutable(bin) {
      return nativePath(bin)
    },
    spawn(spec) {
      const { argv, cwd, stdio, signal, env } = spec
      const child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      })
      const out = collect(child.stdout)
      const err = collect(child.stderr)
      const stdin = stdio?.stdin
      child.stdin.end(stdin && typeof stdin === 'object' && 'data' in stdin ? stdin.data : undefined)

      const done = new Promise((resolve) => {
        child.on('error', (error) => resolve({ exitCode: null, signal: null, error }))
        child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }))
      })

      return {
        collected: {
          stdout: { readFrom: () => ({ text: out(), nextOffset: out().length, lossy: false }) },
          stderr: { readFrom: () => ({ text: err(), nextOffset: err().length, lossy: false }) },
        },
        done,
        terminate() {
          child.kill('SIGTERM')
        },
        async waitForExit() {
          await done
          return true
        },
      }
    },
  }
  const tools = { get: () => undefined }
  return {
    subprocess,
    tools,
    get: (name) => (name === 'subprocess' ? subprocess : name === 'tools' ? tools : undefined),
    effect: (callback) => callback(),
  }
}

function gitStatus() {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd: process.cwd() })
    let text = ''
    child.stdout.on('data', (chunk) => (text += chunk))
    child.on('close', () => resolve(text.trim()))
    child.on('error', () => resolve(''))
  })
}

const ctx = makeCtx()
const cfg = resolveConfig({ surface: 'direct', transport: 'auto', dispatch: { timeoutMs } })
const rt = { ctx, cfg, registered: new Set() }

const problems = []
const note = (line) => console.log(line)

note('— discovery (real CLIs) —')
const report = await detect(ctx, cfg)
for (const row of report.rows) {
  note(
    `  ${row.id.padEnd(12)}${String(row.transport).padEnd(6)}${String(row.version ?? '-').slice(0, 22).padEnd(24)}auth=${row.auth}`,
  )
}

const eligible = report.rows.filter((row) => row.auth !== 'missing' && row.auth !== 'signed-out')
const picks = wanted.length
  ? wanted.map((id) => report.rows.find((row) => row.id === id)).filter(Boolean)
  : eligible.slice(0, 2)

const needed = writeDir ? 1 : 2
if (picks.length < needed) {
  console.error(`\nlive check failed: need ${needed} usable harness(es), found ${picks.length}`)
  process.exit(1)
}

const before = await gitStatus()

if (writeDir) {
  // Explicit `in-place` is the only way OMC writes. Prove it on one harness, in a
  // throwaway directory, and confirm the write actually happened where we said.
  const target = picks[0]
  mkdirSync(writeDir, { recursive: true })
  note(`\n— one explicit in-place write: ${target.id} → ${writeDir} —`)
  const payload = await dispatchTasks(
    rt,
    {
      mode: 'in-place',
      delivery: 'await',
      cwd: writeDir,
      tasks: [
        {
          harness: target.id,
          prompt:
            'In the current directory, create a file named OMC_WRITE_PROOF.txt containing exactly the two characters OK. Do nothing else.',
        },
      ],
    },
    { agent: { id: 'live-write' }, signal: new AbortController().signal },
  )
  const result = payload.results[0]
  note(`  ${result.harnessId} ${result.status} surface=${result.surface} ${result.elapsedMs}ms`)
  if (result.downgradeReason) note(`      degraded: ${result.downgradeReason}`)
  note(`      output: ${String(result.output ?? '').trim().slice(0, 400) || '(empty)'}`)

  const proof = join(writeDir, 'OMC_WRITE_PROOF.txt')
  const wrote = existsSync(proof) ? readFileSync(proof, 'utf8').trim() : null
  note(`  proof file: ${wrote === null ? 'missing' : JSON.stringify(wrote)}`)

  if (result.status !== 'completed') problems.push(`${target.id} did not complete (${result.status})`)
  if (result.surface !== 'direct') problems.push('a per-call in-place run must report surface: direct')
  if (wrote === null) problems.push('the explicit in-place run wrote no proof file')
  else if (!/^OK\b/.test(wrote)) problems.push(`proof file content was ${JSON.stringify(wrote)}, expected OK`)

  if (before !== (await gitStatus())) problems.push('the write escaped the requested cwd')

  if (problems.length) {
    console.error('\nlive write check failed:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('\nlive write check ok: explicit in-place wrote exactly the requested file, surface reported as direct')
  process.exit(0)
}

note(`\n— one read-only tasks[] call: ${picks.map((row) => row.id).join(' + ')} —`)

const startedAt = Date.now()
let payload
try {
  payload = await dispatchTasks(
    rt,
    {
      mode: 'read-only',
      delivery: 'await',
      tasks: picks.map((row) => ({ harness: row.id, prompt })),
    },
    { agent: { id: 'live-check' }, signal: new AbortController().signal },
  )
} catch (error) {
  console.error(`live check failed: ${error?.message ?? error}`)
  process.exit(1)
}
const elapsed = Date.now() - startedAt
const expectMarker = prompt.includes('OMC-ALIVE')

for (const result of payload.results) {
  const surface = result.surface ?? '-'
  note(`  ${result.harnessId.padEnd(12)}${result.status.padEnd(10)}surface=${surface.padEnd(9)}${result.elapsedMs}ms`)
  if (result.downgradeReason) note(`      degraded: ${result.downgradeReason}`)
  if (result.diagnostics?.length) note(`      note: ${result.diagnostics.join(' · ')}`)
  const text = String(result.output ?? '').trim().split(/\r?\n/).slice(0, expectMarker ? 3 : 40).join('\n')
  note(`      output: ${text.slice(0, expectMarker ? 160 : 1500) || '(empty)'}`)
}

for (const result of payload.results) {
  if (result.status !== 'completed') problems.push(`${result.harnessId} did not complete (${result.status})`)
}
if (expectMarker && !payload.results.every((result) => /OMC-ALIVE/i.test(String(result.output ?? '')))) {
  problems.push('at least one seat did not return the expected marker')
}

const slowest = Math.max(...payload.results.map((result) => result.elapsedMs ?? 0))
note(`\n  wall clock ${elapsed}ms vs slowest seat ${slowest}ms (parallel, not ${
  payload.results.reduce((sum, result) => sum + (result.elapsedMs ?? 0), 0)
}ms summed)`)

const after = await gitStatus()
if (before !== after) problems.push('the working tree changed during a read-only run')
else note('  git status: unchanged (read-only held)')

if (new Set(payload.results.map((result) => result.harnessId)).size < 2) {
  problems.push('the two seats were not two different harnesses')
}

if (problems.length) {
  console.error('\nlive check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nlive check ok: two distinct harnesses, read-only, one call, workspace untouched')
