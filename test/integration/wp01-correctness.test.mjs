/**
 * WP01 regressions (0.5.0-alpha.2): the final-request policy gate, real-cwd
 * resolution, parser/classifier false-success fixes and the startup-baseline
 * distinction. These are the A01–A04 acceptance combinations.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { dispatchTasks } from '../../src/dispatch.js'
import { resolveConfig } from '../../src/config.js'
import { classifyCliResult } from '../../integration/cli-result.js'
import { readProjectPolicy } from '../../integration/project-policy.js'
import { parseSessionOutput } from '../../src/session-adapters.js'
import { buildExecutionStatus } from '../../integration/status.js'

// ── the ctx shim, mirroring test/smoke.test.mjs's seam set ───────────────────

function fakeCtx({ stdout = 'ok\n', stderr = '', exitCode = 0, hang = false } = {}) {
  const specs = []
  let release
  const hung = new Promise((resolve) => { release = resolve })
  const subprocess = {
    async resolveExecutable(bin) { return bin.includes('\\') ? bin : `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      spec.signal?.addEventListener('abort', () => release({ exitCode: null, signal: 'SIGTERM' }), { once: true })
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
        done: hang ? hung : Promise.resolve({ exitCode, signal: null }),
        terminate() { release({ exitCode: null, signal: 'SIGKILL' }) },
        async waitForExit() { return true },
      }
    },
  }
  return {
    specs,
    ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined), effect: (cb) => cb() },
  }
}

function rtWith(ctx, cfg) {
  return { ctx, cfg, registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
}

async function projectWith(document) {
  const dir = await mkdtemp(join(tmpdir(), 'omc-wp01-'))
  await mkdir(join(dir, '.omc'), { recursive: true })
  await writeFile(join(dir, '.omc', 'project.json'), typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return dir
}

function agentIn(cwd) {
  return { id: 'session-wp01', session: { header: { cwd } } }
}

const EXEC = { agent: undefined, signal: new AbortController().signal }

// ── A01: a project ceiling bounds the per-call request ──────────────────────

test('A01: a read-only project refuses a per-call in-place mode on every surface', async () => {
  const dir = await projectWith({ dispatch: { defaultMode: 'read-only' } })
  try {
    const shim = fakeCtx()
    const rt = rtWith(shim.ctx, resolveConfig({ surface: 'direct' }))
    await assert.rejects(
      dispatchTasks(rt, { harness: 'codex', prompt: 'write it', mode: 'in-place', cwd: dir }, EXEC),
      (error) => error.code === 'OMC/PROJECT-POLICY-MODE' && /read-only/.test(error.message),
    )
    // The provider surface is gated by the same final check.
    const rtProvider = rtWith(shim.ctx, resolveConfig({}))
    await assert.rejects(
      dispatchTasks(rtProvider, { harness: 'codex', prompt: 'write it', mode: 'worktree', cwd: dir }, { agent: { id: 'p' }, signal: EXEC.signal }),
      (error) => error.code === 'OMC/PROJECT-POLICY-MODE',
    )
    assert.equal(shim.specs.length, 0, 'no process may start past the gate')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A01: a per-call long timeout and a harness timeout cannot outlive the project ceiling', async () => {
  const dir = await projectWith({ dispatch: { timeoutMs: 40, defaultMode: 'in-place' } })
  try {
    const shim = fakeCtx({ hang: true })
    const cfg = resolveConfig({ surface: 'direct', dispatch: { timeoutMs: 300000 }, harnesses: { codex: { timeoutMs: 240000 } } })
    const rt = rtWith(shim.ctx, cfg)
    const started = Date.now()
    const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'stuck', mode: 'in-place', timeoutMs: 600000, cwd: dir }, EXEC)
    const elapsed = Date.now() - started
    assert.equal(payload.results[0].status, 'timeout')
    assert.match(payload.results[0].diagnostics.join(' '), /OMC\/CLI-TIMEOUT/)
    assert.ok(elapsed < 5000, `the project ceiling (40ms) must beat the 600s call and 240s harness timeouts (took ${elapsed}ms)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A01: a project-disabled harness is unreachable through the fallback chain', async () => {
  const dir = await projectWith({ harnesses: { codex: { enabled: false } } })
  try {
    const shim = fakeCtx()
    const rt = rtWith(shim.ctx, resolveConfig({ surface: 'direct' }))
    const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go', fallbacks: ['gemini'], cwd: dir }, EXEC)
    // codex is refused; the explicit gemini fallback may still run.
    assert.ok(payload.results[0].attempts.some((row) => row.harness === 'codex' && row.code === 'OMC/NO-PROVIDER'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── A02: the real session cwd decides the policy, and a broken file is not empty ──

test('A02: an omitted or relative cwd resolves against the session cwd before the policy is read', async () => {
  const dir = await projectWith({ dispatch: { defaultMode: 'read-only' } })
  try {
    const shim = fakeCtx()
    const rt = rtWith(shim.ctx, resolveConfig({ surface: 'direct' }))
    // Omitted cwd: the session's own directory is the project.
    await assert.rejects(
      dispatchTasks(rt, { harness: 'codex', prompt: 'x', mode: 'in-place' }, { agent: agentIn(dir), signal: EXEC.signal }),
      (error) => error.code === 'OMC/PROJECT-POLICY-MODE',
    )
    // Relative cwd: resolved against the session cwd, not the Host process dir.
    await assert.rejects(
      dispatchTasks(rt, { harness: 'codex', prompt: 'x', mode: 'in-place', cwd: './' }, { agent: agentIn(dir), signal: EXEC.signal }),
      (error) => error.code === 'OMC/PROJECT-POLICY-MODE',
    )
    // A session outside the project keeps its own (missing) policy: read-only default runs.
    const elsewhere = await mkdtemp(join(tmpdir(), 'omc-wp01-free-'))
    try {
      const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go' }, { agent: agentIn(elsewhere), signal: EXEC.signal })
      assert.equal(payload.results[0].status, 'completed')
      assert.equal(payload.results[0].surface, 'direct')
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A02: an unreadable project policy blocks side effects instead of becoming empty', async () => {
  const dir = await projectWith('{ not json')
  try {
    const policy = readProjectPolicy(dir)
    assert.equal(policy.exists, true)
    assert.equal(policy.usable, false)

    const shim = fakeCtx()
    const rt = rtWith(shim.ctx, resolveConfig({ surface: 'direct' }))
    await assert.rejects(
      dispatchTasks(rt, { harness: 'codex', prompt: 'x', mode: 'in-place', cwd: dir }, EXEC),
      (error) => error.code === 'OMC/PROJECT-POLICY-UNREADABLE' && /not valid JSON/.test(error.message),
    )
    // Read-only dispatch still runs: it cannot violate an unseen restriction.
    const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go', cwd: dir }, EXEC)
    assert.equal(payload.results[0].status, 'completed')
    assert.equal(shim.specs.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── A03: parser → classifier never report a false success ───────────────────

const CODEX_TERMINAL = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread_wp01' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 9 } }),
].join('\n')

const CODEX_NO_TERMINAL = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread_wp01' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } }),
].join('\n')

test('A03: a structurally valid JSONL stream without a terminal message is a semantic failure', () => {
  const parsed = parseSessionOutput('codex-jsonl', CODEX_NO_TERMINAL)
  assert.equal(parsed.envelope, true)
  assert.equal(parsed.text, null)
  const verdict = classifyCliResult({ exitCode: 0, captured: { stdout: CODEX_NO_TERMINAL }, parsed, expectJson: true })
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.code, 'OMC/CLI-SEMANTIC-FAILURE')
  assert.equal(verdict.semantic, true)
  assert.match(verdict.message, /without a terminal message/)
})

test('A03: requested-JSON output that never arrives as JSON is a semantic failure, not a stdout fallback', () => {
  const parsed = parseSessionOutput('codex-jsonl', 'looks like a human answer')
  assert.equal(parsed.envelope, false)
  const verdict = classifyCliResult({ exitCode: 0, captured: { stdout: 'looks like a human answer' }, parsed, expectJson: true })
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.code, 'OMC/CLI-SEMANTIC-FAILURE')
  assert.match(verdict.message, /no recognizable JSON session stream/)
})

test('A03: a normal codex JSONL run still completes and keeps its usage', () => {
  const parsed = parseSessionOutput('codex-jsonl', CODEX_TERMINAL)
  assert.equal(parsed.envelope, true)
  assert.equal(parsed.text, 'final answer')
  assert.equal(parsed.sessionId, 'thread_wp01')
  const verdict = classifyCliResult({ exitCode: 0, captured: { stdout: CODEX_TERMINAL }, parsed, expectJson: true, resumeId: 'thread_wp01' })
  assert.equal(verdict.status, 'completed')
  assert.equal(verdict.code, null)
  assert.equal(parsed.usage.inputTokens, 120)
  assert.equal(parsed.usage.cachedInputTokens, 30)
})

test('A03: the direct surface never requested JSON, so its human text stays a completed answer', () => {
  const parsed = parseSessionOutput('codex-jsonl', 'plain human answer')
  const verdict = classifyCliResult({ exitCode: 0, captured: { stdout: 'plain human answer' }, parsed, expectJson: false })
  assert.equal(verdict.status, 'completed')
  // But an empty human answer with exit zero is still refused.
  const empty = classifyCliResult({ exitCode: 0, captured: { stdout: '   ' }, parsed: parseSessionOutput('codex-jsonl', '   '), expectJson: false })
  assert.equal(empty.status, 'failed')
  assert.equal(empty.code, 'OMC/CLI-EMPTY-OUTPUT')
})

// ── A04: observed request routes are distinguishable from configured routes ──

test('A04: the observed request route is recorded beside the configured one', async () => {
  const { recordActualRoute, readActualRoutes } = await import('../../vendor/omd/npm-package/preset/subagent-roles.js')
  recordActualRoute('oracle', { provider: 'deepseek', model: 'old-model' }, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' })
  try {
    const status = await buildExecutionStatus({}, {})
    const oracle = status.roles.find((row) => row.roleId === 'oracle')
    assert.ok(oracle, 'the oracle role row exists')
    assert.equal(oracle.actualRoute.provider, 'zai')
    assert.equal(oracle.actualRoute.model, 'glm-5.3')
    assert.equal(oracle.actualRoute.rerouted, true)
    assert.equal(oracle.actualRoute.resolvedModel, 'old-model')
    assert.equal(status.actualRoutes.oracle.model, 'glm-5.3')
  } finally {
    // readActualRoutes is process-global; leave no residue for other tests.
    recordActualRoute('oracle', { provider: 'x', model: 'y' }, undefined)
  }
})

