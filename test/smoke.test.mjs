import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, isEnabled } from '../src/config.js'
import { normalizeId, harnessDef } from '../src/harnesses.js'
import {
  buildArgv,
  clip,
  expandEnv,
  harnessEnv,
  parseEnvFile,
  planTransport,
  shellQuote,
  toWslPath,
  withTimeout,
} from '../src/transport.js'
import { parseFrontmatter } from '../src/skills.js'
import { dispatchTasks } from '../src/dispatch.js'
import { renderReport } from '../src/doctor.js'

/** A ctx shim: only the seams OMC actually touches. */
function fakeCtx({ stdout = 'ok\n', stderr = '', exitCode = 0, missing = [] } = {}) {
  const specs = []
  const subprocess = {
    async resolveExecutable(bin) {
      if (missing.includes(bin)) {
        const error = new Error(`ENOENT: ${bin}`)
        error.code = 'ENOENT'
        throw error
      }
      // An absolute path is verified as-is, exactly like the real seam.
      if (bin.includes('\\') || bin.includes('/')) return bin
      return `C:\\fake\\${bin}.exe`
    },
    spawn(spec) {
      specs.push(spec)
      const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
      return {
        collected: { stdout: read(stdout), stderr: read(stderr) },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        async waitForExit() {
          return true
        },
      }
    },
  }
  const tools = { get: () => undefined }
  return {
    specs,
    ctx: {
      // A real Cordis context exposes both shapes once `inject` is declared:
      // `ctx.subprocess` for the hard dependency and `ctx.get()` for optional planes.
      subprocess,
      tools,
      get: (name) => (name === 'subprocess' ? subprocess : name === 'tools' ? tools : undefined),
      effect: (callback) => callback(),
    },
  }
}

test('config bounds are enforced', () => {
  const cfg = resolveConfig({ dispatch: { maxParallel: 99, timeoutMs: 10, maxOutputBytes: 1 } })
  assert.equal(cfg.dispatch.maxParallel, 8)
  assert.equal(cfg.dispatch.timeoutMs, 5000)
  assert.equal(cfg.dispatch.maxOutputBytes, 1024)
  assert.equal(resolveConfig({ surface: 'nonsense' }).surface, 'auto')
  assert.equal(isEnabled(resolveConfig({}), 'codex'), true)
  assert.equal(isEnabled(resolveConfig({ harnesses: { codex: { enabled: false } } }), 'codex'), false)
})

test('harness ids normalize without guessing', () => {
  assert.equal(normalizeId('Claude-Code'), 'claude')
  assert.equal(normalizeId(' gemini-cli '), 'gemini')
  assert.equal(normalizeId('nope'), 'nope')
  assert.equal(harnessDef('codex')?.bin, 'codex')
})

test('clip keeps head and tail and admits the loss', () => {
  const text = 'a'.repeat(5000) + 'b'.repeat(5000)
  const result = clip(text, 1000)
  assert.equal(result.truncated, true)
  assert.ok(result.text.startsWith('a'))
  assert.ok(result.text.endsWith('b'))
  assert.match(result.text, /clipped/)
  assert.equal(clip('short', 1000).truncated, false)
})

test('wsl paths translate the shapes we actually meet', () => {
  assert.equal(toWslPath('C:\\Users\\me\\a.txt'), '/mnt/c/Users/me/a.txt')
  assert.equal(toWslPath('d:/proj/x'), '/mnt/d/proj/x')
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me')
  assert.equal(toWslPath('/already/linux'), '/already/linux')
})

test('shell quoting survives a quote in the task', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote(''), "''")
})

test('timeout aborts the combined signal', async () => {
  const deadline = withTimeout(undefined, 10)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(deadline.signal.aborted, true)
  assert.equal(deadline.timedOut(), true)
  deadline.dispose()
})

test('frontmatter parsing is minimal and predictable', () => {
  const { data, body } = parseFrontmatter('---\nname: coharness\ndescription: "routing"\n---\nbody text\n')
  assert.equal(data.name, 'coharness')
  assert.equal(data.description, 'routing')
  assert.equal(body, 'body text')
  assert.deepEqual(parseFrontmatter('no frontmatter').data, {})
})

test('dispatch runs direct when no provider surface exists', async () => {
  const { ctx, specs } = fakeCtx({ stdout: 'README summarised' })
  const cfg = resolveConfig({ surface: 'direct', transport: 'native' })
  const rt = { ctx, cfg, registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }

  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'read README' },
    { agent: { id: 'session-1' }, signal: new AbortController().signal },
  )

  assert.equal(payload.delivery, 'await')
  assert.equal(payload.results.length, 1)
  assert.equal(payload.results[0].status, 'completed')
  assert.equal(payload.results[0].output, 'README summarised')
  assert.equal(specs.length, 1)
  assert.deepEqual(specs[0].argv.slice(1), ['exec', '--skip-git-repo-check', '-s', 'read-only', 'read README'])
  assert.equal(specs[0].stdio.stdin.data, '', 'headless runs must get EOF, not a terminal')
})

test('mode maps onto each CLI’s own read-only flag', () => {
  const args = (id, mode) => harnessDef(id).argv('do it', { mode })

  // codex: -s read-only / workspace-write (confirmed by `codex exec --help`)
  assert.deepEqual(args('codex', 'read-only').slice(-3), ['-s', 'read-only', 'do it'])
  assert.deepEqual(args('codex', 'in-place').slice(-3), ['-s', 'workspace-write', 'do it'])
  // headless runs cannot answer the interactive trust prompt
  assert.ok(args('codex', 'read-only').includes('--skip-git-repo-check'))

  // gemini: --approval-mode plan is its documented read-only mode
  assert.ok(args('gemini', 'read-only').includes('plan'))
  assert.ok(args('gemini', 'in-place').includes('auto_edit'))

  // opencode has no read-only switch; the flag must not be invented
  assert.deepEqual(args('opencode', 'read-only'), ['run', 'do it'])
})

test('dispatch reports a missing CLI instead of pretending', async () => {
  const { ctx } = fakeCtx({ missing: ['gemini'] })
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return { rows: [] }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'gemini', prompt: 'review this' },
    { agent: { id: 'session-1' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'failed')
  assert.match(payload.results[0].diagnostics?.[0] ?? '', /OMC\/CLI-MISSING/)
})

test('dispatch refuses to run more tasks than maxParallel', async () => {
  const { ctx } = fakeCtx()
  const rt = { ctx, cfg: resolveConfig({ surface: 'direct', dispatch: { maxParallel: 2 } }), registered: new Set(), async detect() { return { rows: [{ id: 'codex', auth: 'ok' }] } } }
  const payload = await dispatchTasks(
    rt,
    { tasks: [{ harness: 'codex', prompt: 'a' }, { harness: 'codex', prompt: 'b' }, { harness: 'codex', prompt: 'c' }] },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  assert.equal(payload.results.length, 2)
  assert.equal(payload.omitted, 1)
})

test('an explicit per-harness command beats PATH discovery', async () => {
  const { ctx } = fakeCtx()
  const cfg = resolveConfig({ transport: 'native', harnesses: { codex: { command: 'C:\\custom\\codex.exe' } } })
  const plan = await planTransport(ctx, harnessDef('codex'), cfg, new AbortController().signal)
  assert.equal(plan.via, 'config')
  assert.equal(plan.exe, 'C:\\custom\\codex.exe')
  assert.equal(plan.transport, 'native')
})

test('an explicit model reaches the CLI argv', async () => {
  const { ctx, specs } = fakeCtx()
  const cfg = resolveConfig({ surface: 'direct', transport: 'native', harnesses: { opencode: { model: 'zai-coding-plan/glm-5.3' } } })
  const rt = { ctx, cfg, registered: new Set(), async detect() { return { rows: [{ id: 'opencode', auth: 'ok' }] } } }
  const payload = await dispatchTasks(
    rt,
    { harness: 'opencode', prompt: 'read README' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  assert.equal(payload.results[0].status, 'completed')
  assert.deepEqual(specs[0].argv.slice(1, 5), ['run', '--model', 'zai-coding-plan/glm-5.3', 'read README'])
})

test('a per-call timeout reaches the activation and is reported as timeout', async () => {
  const { ctx } = fakeCtx()
  const subagents = {
    list: () => ['omc:codex'],
    async startActivation(spec) {
      const result = new Promise((resolve) => {
        spec.signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }))
      })
      return { childId: 'child-1', result, async dispose() {} }
    },
  }
  const scoped = {
    ...ctx,
    get: (name) => (name === 'subagents' ? subagents : ctx.get(name)),
  }
  const rt = {
    ctx: scoped,
    cfg: resolveConfig({}),
    registered: new Set(['codex']),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  const startedAt = Date.now()
  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'count slowly', timeoutMs: 250 },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'timeout')
  assert.match(payload.results[0].diagnostics?.[0] ?? '', /OMC\/CLI-TIMEOUT/)
  assert.ok(Date.now() - startedAt >= 200, 'must wait for the deadline, not short-circuit')
})

test('a harness is binary × endpoint × model, not a vendor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-env-'))
  const file = join(dir, 'secrets.env')
  await writeFile(file, '# secrets\nANTHROPIC_AUTH_TOKEN="sk-test"\n', 'utf8')

  const def = harnessDef('glm')
  assert.equal(def?.bin, 'claude', 'glm reuses the claude binary')

  // defaultEnv is the floor, a secret file overrides it, config sits in between
  const env = harnessEnv(def, {
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    envFile: file,
  })
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-test')
  assert.equal(parseEnvFile('/definitely/missing.env').ANTHROPIC_AUTH_TOKEN, undefined)

  // WSL receives the variables through `export`, never through WSLENV
  const plan = { transport: 'wsl', distro: 'Ubuntu', exe: '/usr/local/bin/claude' }
  const { argv } = buildArgv(def, plan, ['-p', 'hi'], undefined, { ANTHROPIC_AUTH_TOKEN: "a'b" })
  const script = argv.at(-1)
  assert.match(script, /export ANTHROPIC_AUTH_TOKEN='a'\\''b';/)
  assert.match(script, /'\/usr\/local\/bin\/claude' '-p' 'hi'/)
})

test('env expansion leaves an unknown variable literal instead of blanking it', () => {
  assert.equal(expandEnv('${OMC_SURELY_MISSING_VAR}'), '${OMC_SURELY_MISSING_VAR}')
  assert.equal(expandEnv('plain'), 'plain')
})

test('the report says what is missing and admits its redaction', () => {
  const report = {
    at: '2026-10-29T00:00:00.000Z',
    host: { dsh: '0.2.1-rc.3', node: 'v24.21.0', platform: 'win32 x64', profile: 'desktop' },
    rows: [
      {
        id: 'codex',
        label: 'Codex',
        transport: 'native',
        via: 'path',
        auth: 'missing',
        version: undefined,
        detail: 'ENOENT',
      },
    ],
    wsl: { ok: false, distros: [], detail: 'Wsl/E_ACCESS_DENIED' },
    subagents: ['spawn', 'fork'],
    plugins: { conductor: false, wsl: false, providerNames: ['spawn', 'fork'] },
  }
  const text = renderReport(report, resolveConfig({}))
  assert.match(text, /codex/)
  assert.match(text, /missing/)
  assert.match(text, /Wsl\/E_ACCESS_DENIED/)
  assert.match(text, /redaction:/)
  assert.match(text, /npm i -g @openai\/codex/)
})
