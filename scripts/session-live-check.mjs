/** Bounded real Codex acceptance, using OMC's provider and a throwaway workspace.
 * Two model calls consume the CLI's own quota. No keys or auth files are read.
 * Usage: node scripts/session-live-check.mjs [--command /path/to/codex] [--timeout 60000]
 * This is developer tooling, excluded from the published runtime package.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandoff } from '../integration/handoff.js'
import { buildExternalBrief } from '../integration/external-brief.js'
import { createSessionRegistry } from '../integration/sessions.js'
import { resolveConfig } from '../src/config.js'
import { harnessDef } from '../src/harnesses.js'
import { makeProvider } from '../src/provider.js'

const argv = process.argv.slice(2)
const option = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback
const command = option('--command', process.platform === 'win32' ? 'codex.exe' : 'codex')
const timeoutMs = Number(option('--timeout', 60000))
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 5000 && timeoutMs <= 300000)
const workspace = mkdtempSync(join(tmpdir(), 'omc-session-live-work-'))
const evidence = mkdtempSync(join(tmpdir(), 'omc-session-live-evidence-'))
const nonce = randomBytes(12).toString('hex')
const cfg = resolveConfig({ transport: 'native', harnesses: { codex: { command } },
  dispatch: { timeoutMs }, sessions: { path: join(evidence, 'sessions.json') } })

const subprocess = {
  async resolveExecutable() { return command },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, env: spec.env ?? process.env, windowsHide: true,
    })
    let stdout = '', stderr = '', spawnError
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.stdin.on('error', () => {})
    child.stdin.end(spec.stdio?.stdin?.data ?? '')
    const abort = () => child.kill()
    spec.signal?.addEventListener('abort', abort, { once: true })
    if (spec.signal?.aborted) abort()
    const done = new Promise(resolve => {
      child.on('error', error => { spawnError = error })
      child.on('close', (exitCode, signal) => {
        spec.signal?.removeEventListener('abort', abort)
        resolve({ exitCode: spawnError ? 1 : exitCode, signal })
      })
    })
    return { collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: spawnError?.code ?? stderr, lossy: false }) },
    }, done, terminate: abort, waitForExit: () => done.then(() => true) }
  },
}
const ctx = { subprocess, get: name => name === 'subprocess' ? subprocess : undefined }
const summary = { at: new Date().toISOString(), harness: 'codex', rounds: [], passed: false }
try {
  for (let round = 1; round <= 2; round++) {
    // New registry instance proves the native reference really reached disk.
    const registry = createSessionRegistry(cfg.sessions)
    const task = round === 1
      ? `Remember this nonce for this conversation: ${nonce}. Reply with only OMC-READY. Do not call tools, read files, run commands, or write anything.`
      : 'Reply with only the exact nonce I asked you to remember in the previous turn. Do not call tools, read files, run commands, or write anything.'
    const handoff = createHandoff({ roleId: 'oracle', cwd: workspace, laneId: 'live-two-round-recall' })
    const prompt = buildExternalBrief({ roleId: 'oracle', persona: 'You are a read-only verification agent. For this probe return only the requested token.',
      task, harness: 'codex', readOnly: 'enforced', cwd: workspace, handoff })
    const provider = makeProvider(ctx, harnessDef('codex'), cfg, { readOnly: true, registry })
    const result = await (await provider.start({ cwd: workspace, prompt: [{ type: 'text', text: prompt }], signal: new AbortController().signal })).result
    const answer = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    summary.rounds.push({ round, stopReason: result.stopReason, diagnostic: result.diagnostic,
      expectedAnswer: round === 1 ? answer === 'OMC-READY' : answer === nonce,
      turns: registry.list()[0]?.turns ?? 0 })
    assert.equal(result.stopReason, 'completed', result.diagnostic)
    assert.equal(summary.rounds.at(-1).expectedAnswer, true, `round ${round} did not return the expected token`)
    assert.match(result.diagnostic, round === 1 ? /session new/ : /session resumed/)
    assert.equal(registry.list()[0].turns, round)
    console.log(`round ${round}: passed (${round === 1 ? 'new' : 'resumed'} native session)`)
  }
  assert.deepEqual(readdirSync(workspace), [], 'the read-only workspace changed')
  summary.passed = true
} catch (error) {
  summary.error = String(error?.message ?? error).slice(0, 500)
  process.exitCode = 1
} finally {
  const path = join(evidence, 'acceptance.json')
  writeFileSync(path, JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`evidence: ${path}`)
}
