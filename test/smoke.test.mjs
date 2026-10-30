import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
import { parseFrontmatter, SKILLS } from '../src/skills.js'
import { dispatchTasks } from '../src/dispatch.js'
import { probePlugins, renderReport } from '../src/doctor.js'
import { apply } from '../src/index.js'
import { createSessionRegistry, sessionKeyFor } from '../integration/sessions.js'

/** A ctx shim: only the seams OMC actually touches. */
function fakeCtx({
  stdout = 'ok\n',
  stderr = '',
  exitCode = 0,
  missing = [],
  toolNames = [],
  delayMs = 0,
  subagents = null,
} = {}) {
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
      const outcome = { exitCode, signal: null }
      return {
        collected: { stdout: read(stdout), stderr: read(stderr) },
        done: delayMs ? new Promise((resolve) => setTimeout(() => resolve(outcome), delayMs)) : Promise.resolve(outcome),
        terminate() {},
        async waitForExit() {
          return true
        },
      }
    },
  }
  const registeredTools = []
  const injections = []
  const subagentsRef = { current: subagents }
  const tools = {
    get: (name) => (toolNames.includes(name) ? { name } : undefined),
    register: (tool) => {
      registeredTools.push(tool)
      return () => {}
    },
  }
  return {
    specs,
    registeredTools,
    injections,
    setSubagents(value) {
      subagentsRef.current = value
    },
    ctx: {
      // A real Cordis context exposes both shapes once `inject` is declared:
      // `ctx.subprocess` for the hard dependency and `ctx.get()` for optional planes.
      subprocess,
      tools,
      get: (name) =>
        name === 'subprocess'
          ? subprocess
          : name === 'tools'
            ? tools
            : name === 'subagents'
              ? subagentsRef.current
              : undefined,
      // Optional-service injection: Cordis runs the callback now and when the
      // service appears. The shim records it so a test can fire it later.
      inject: (deps, callback) => {
        injections.push({ deps, callback })
        if (subagentsRef.current) callback()
      },
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

  const sessions = resolveConfig({
    sessions: { resumePolicy: 'sometimes', maxTurns: 999, allowUnverified: 'yes' },
    routing: { preset: 'turbo', limits: { maxReviewRounds: 99 } },
  })
  assert.equal(sessions.sessions.resumePolicy, 'auto')
  assert.equal(sessions.sessions.maxTurns, 200)
  assert.equal(sessions.sessions.allowUnverified, false)
  assert.equal(sessions.routing.preset, 'balanced')
  assert.equal(sessions.routing.limits.maxReviewRounds, 5)
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
  assert.equal(payload.results[0].surface, 'direct')
  assert.match(payload.results[0].downgradeReason, /surface is configured as direct/)
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

test('an over-limit batch fails loudly instead of dropping tasks', async () => {
  const { ctx } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', dispatch: { maxParallel: 4 } }),
    registered: new Set(),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }
  const tasks = Array.from({ length: 5 }, (_, index) => ({ harness: 'codex', prompt: `task ${index}` }))

  await assert.rejects(
    dispatchTasks(rt, { tasks }, { agent: { id: 's' }, signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, 'OMC/TOO-MANY-TASKS')
      assert.match(error.message, /maxParallel=4/)
      assert.match(error.message, /split them into 2 calls/)
      return true
    },
  )
})

test('auto prefers an authenticated harness and never auto-selects a signed-out one', async () => {
  const { ctx } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return {
        rows: [
          { id: 'gemini', auth: 'unknown', verified: true },
          { id: 'codex', auth: 'signed-out', verified: true },
          { id: 'opencode', auth: 'ok', verified: true },
          { id: 'kimi', auth: 'missing' },
        ],
      }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { prompt: 'read README' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].harnessId, 'opencode')
  assert.equal(payload.results[0].status, 'completed')
})

test('auto falls back to verified before unverified when auth is equal', async () => {
  const { ctx } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return {
        rows: [
          { id: 'qwen', auth: 'unknown', verified: false },
          { id: 'gemini', auth: 'unknown', verified: true },
        ],
      }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'auto', prompt: 'go' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  assert.equal(payload.results[0].harnessId, 'gemini')
})

test('auto with nothing usable explains every row', async () => {
  const { ctx } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return {
        rows: [
          { id: 'codex', auth: 'missing' },
          { id: 'kimi', auth: 'signed-out' },
        ],
      }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'auto', prompt: 'go' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'failed')
  const diagnostic = payload.results[0].diagnostics.join(' ')
  assert.match(diagnostic, /OMC\/CLI-MISSING/)
  assert.match(diagnostic, /codex: missing \(not installed\)/)
  assert.match(diagnostic, /kimi: signed-out/)
})

test('one bad task does not reject the whole batch', async () => {
  const { ctx } = fakeCtx({ stdout: 'second result' })
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { tasks: [{ harness: 'nope', prompt: 'a' }, { harness: 'codex', prompt: 'b' }] },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results.length, 2)
  assert.equal(payload.results[0].status, 'failed')
  assert.match(payload.results[0].diagnostics[0], /OMC\/UNKNOWN-HARNESS/)
  assert.equal(payload.results[1].status, 'completed')
  assert.equal(payload.results[1].output, 'second result')
})

test('a write mode leaves the provider surface and says why', async () => {
  const { ctx } = fakeCtx({
    stdout: 'file written',
    subagents: {
      list: () => ['omc:codex'],
      async startActivation() {
        throw new Error('a per-call mode must not travel through the provider')
      },
    },
  })
  const rt = {
    ctx,
    cfg: resolveConfig({ transport: 'native' }),
    registered: new Set(['codex']),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }
  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'change it', mode: 'in-place' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'completed')
  assert.equal(payload.results[0].surface, 'direct')
  assert.match(payload.results[0].downgradeReason, /omc providers are fixed read-only/)
})

test('an explicit signed-out harness still runs, but only when a report was seen', async () => {
  const { ctx } = fakeCtx({ stdout: 'ran anyway' })
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    peekReport: () => ({ rows: [{ id: 'codex', auth: 'signed-out' }] }),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'signed-out' }] }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'go' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  assert.equal(payload.results[0].status, 'completed')
  assert.match(payload.results[0].diagnostics.join(' '), /OMC\/AUTH-SIGNED-OUT/)
})

test('in-place is single-writer: two write tasks in one call are refused', async () => {
  const { ctx, specs } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  await assert.rejects(
    dispatchTasks(
      rt,
      { mode: 'in-place', tasks: [{ harness: 'codex', prompt: 'a' }, { harness: 'codex', prompt: 'b' }] },
      { agent: { id: 's' }, signal: new AbortController().signal },
    ),
    (error) => {
      assert.equal(error.code, 'OMC/PARALLEL-WRITE')
      assert.match(error.message, /single-writer/)
      return true
    },
  )
  assert.equal(specs.length, 0, 'nothing may be spawned for a refused write batch')
})

test('background on the direct surface is refused instead of silently awaited', async () => {  const { ctx, specs } = fakeCtx()
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'go', delivery: 'background' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'failed')
  assert.match(payload.results[0].diagnostics[0], /OMC\/BACKGROUND-UNSUPPORTED/)
  assert.match(payload.results[0].diagnostics[0], /delivery "await"/)
  assert.equal(specs.length, 0, 'nothing may be spawned for an unsupported delivery')
})

test('a provider result carries its surface and child id', async () => {
  const { ctx } = fakeCtx()
  const subagents = {
    list: () => ['omc:codex'],
    async startActivation() {
      return {
        childId: 'child-7',
        result: Promise.resolve({ output: [{ type: 'text', text: 'from codex' }], stopReason: 'completed' }),
        async dispose() {},
      }
    },
  }
  const scoped = { ...ctx, get: (name) => (name === 'subagents' ? subagents : ctx.get(name)) }
  const rt = {
    ctx: scoped,
    cfg: resolveConfig({}),
    registered: new Set(['codex']),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'go' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.equal(payload.results[0].status, 'completed')
  assert.equal(payload.results[0].surface, 'provider')
  assert.equal(payload.results[0].childId, 'child-7')
  assert.equal(payload.results[0].output, 'from codex')
  assert.equal(payload.results[0].downgradeReason, undefined)
})

test('two read-only tasks really overlap', async () => {
  const { ctx } = fakeCtx({ stdout: 'ok', delayMs: 120 })
  const rt = {
    ctx,
    cfg: resolveConfig({ surface: 'direct', transport: 'native' }),
    registered: new Set(),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }

  const startedAt = Date.now()
  const payload = await dispatchTasks(
    rt,
    { tasks: [{ harness: 'codex', prompt: 'a' }, { harness: 'codex', prompt: 'b' }] },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  const elapsed = Date.now() - startedAt

  assert.equal(payload.results.length, 2)
  assert.ok(payload.results.every((result) => result.status === 'completed'))
  assert.ok(elapsed < 220, `expected ~max(120,120), got ${elapsed}ms`)
})

test('a successful transport plan is cached for the next turn', async () => {
  let resolutions = 0
  const ctx = {
    subprocess: {
      async resolveExecutable() {
        resolutions += 1
        return 'C:\\fake\\codex.exe'
      },
    },
  }
  const def = harnessDef('codex')
  const cfg = resolveConfig({ transport: 'native' })
  const first = await planTransport(ctx, def, cfg)
  const second = await planTransport(ctx, def, cfg)
  assert.equal(first.exe, 'C:\\fake\\codex.exe')
  assert.deepEqual(second, first)
  assert.equal(resolutions, 1, 'the second turn must not re-run discovery')

  // A changed command is a different plan and must invalidate the cache key.
  const changed = resolveConfig({ transport: 'native', harnesses: { codex: { command: 'other-codex' } } })
  await planTransport(ctx, def, changed)
  assert.equal(resolutions, 2)
})

test('the bundle ships one preset and one Host row', async () => {
  const raw = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  assert.match(raw, /^\s+- id: oh-my-coharness$/m)
  assert.match(raw, /preset-oh-my-coharness/)
  assert.match(raw, /name: 'oh-my-coharness\/preset'/)
  assert.match(raw, /oh-my-coharness\/profile-registry/)
  assert.match(raw, /^\s+default: oh-my-coharness$/m)
  // The merged product must not mount the two old, mutually exclusive rosters.
  assert.doesNotMatch(raw, /preset-omc-harness/)
  assert.doesNotMatch(raw, /preset-oh-my-dsh-slim/)
  // External execution is role configuration now, not a separate tool row per CLI.
  assert.doesNotMatch(raw, /provider: 'omc:/)
})

test('the bundle ships five parseable skills', async () => {
  assert.equal(SKILLS.length, 5)
  for (const { dir } of SKILLS) {
    const raw = await readFile(new URL(`../skills/${dir}/SKILL.md`, import.meta.url), 'utf8')
    const { data, body } = parseFrontmatter(raw)
    assert.equal(data.name, dir, `${dir} frontmatter name must match its directory`)
    assert.ok(data.description, `${dir} needs a description`)
    assert.ok(data.whenToUse, `${dir} needs whenToUse`)
    assert.ok(body.length > 200, `${dir} body looks too short`)
  }
})

test('doctor reports the merged preset without claiming compatibility', () => {
  const { ctx } = fakeCtx({ toolNames: ['subagent_oracle', 'subagent_designer', 'subagent_fixer', 'coharness'] })
  const plugins = probePlugins(ctx)
  assert.deepEqual(plugins.companionRoles, ['subagent_oracle', 'subagent_designer', 'subagent_fixer'])
  assert.equal(plugins.coharnessRegistered, true)

  const report = {
    at: '2026-10-29T00:00:00.000Z',
    host: { dsh: '0.2.1-rc.3', node: 'v24.21.0', platform: 'win32 x64', profile: 'desktop' },
    rows: [{ id: 'codex', label: 'Codex', transport: 'native', via: 'path', auth: 'ok', verified: true, readOnly: 'enforced' }],
    wsl: { ok: true, distros: ['Ubuntu'], detail: '' },
    subagents: ['omc:codex'],
    plugins,
    execution: {
      presetId: 'oh-my-coharness',
      providers: ['omc:codex'],
      roles: [{ roleId: 'oracle', enabled: true, backend: 'omc', execution: 'omc:codex', readOnly: 'enforced', providerAvailable: true }],
      harnesses: [{ id: 'codex', enabled: true, readOnly: 'enforced', providerAvailable: true }],
    },
    legacy: { legacyPreset: false, ourPreset: true, legacyRoleTools: [] },
  }
  const text = renderReport(report, resolveConfig({}))
  assert.match(text, /role tools: visible \(oracle, designer, fixer\)/)
  assert.match(text, /coharness tool: registered/)
  assert.match(text, /preset: oh-my-coharness registered/)
  assert.match(text, /oracle\s+on\s+omc\s+omc:codex/)
  assert.match(text, /codex\s+on\s+enforced/)
  assert.doesNotMatch(text, /compatible/i)
})

test('doctor reports a missing role surface instead of pretending it is mounted', () => {
  const { ctx } = fakeCtx()
  const report = {
    at: '2026-10-29T00:00:00.000Z',
    host: { dsh: '0.2.1-rc.3', node: 'v24.21.0', platform: 'win32 x64', profile: 'desktop' },
    rows: [{ id: 'codex', label: 'Codex', transport: 'native', via: 'path', auth: 'ok', verified: true, readOnly: 'enforced' }],
    wsl: { ok: true, distros: ['Ubuntu'], detail: '' },
    subagents: ['omc:codex'],
    plugins: probePlugins(ctx),
  }
  const text = renderReport(report, resolveConfig({}))
  assert.match(text, /role tools: not visible from this scope/)
  assert.match(text, /coharness tool: not visible from here/)
  assert.match(text, /execution: role → backend/)
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

test('the rendered tool text names the surface and the degradation', async () => {
  const { ctx, registeredTools } = fakeCtx({ stdout: 'done' })
  apply(ctx, { surface: 'direct', transport: 'native' })
  const tool = registeredTools.find((entry) => entry.name === 'coharness')
  assert.ok(tool, 'apply() must register the coharness tool')

  const value = await tool.execute(
    { action: 'dispatch', harness: 'codex', prompt: 'go' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )

  assert.match(value.text, /surface: direct/)
  assert.match(value.text, /degraded: surface is configured as direct/)
  assert.match(value.text, /surface: direct` has no childId/)
})

test('worktree mode is refused by the tool in this release', async () => {
  const { ctx, registeredTools } = fakeCtx()
  apply(ctx, { surface: 'direct' })
  const tool = registeredTools.find((entry) => entry.name === 'coharness')
  const value = await tool.execute(
    { action: 'dispatch', mode: 'worktree', prompt: 'go', harness: 'codex' },
    { agent: { id: 's' }, signal: new AbortController().signal },
  )
  assert.match(value.text, /not implemented in \d+\.\d+\.\d+/)
})

test('the tool lists and clears session references without exposing full ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-sessions-tool-'))
  const path = join(dir, 'sessions.json')
  const registry = createSessionRegistry({ path })
  const lease = await registry.acquire(sessionKeyFor({
    projectId: 'proj-1',
    laneId: 'lane-oracle-proj-1',
    role: 'oracle',
    harness: 'codex',
    workspace: 'e:/repo',
  }))
  registry.complete(lease, { sessionId: 'thread-very-secret-id', format: 'codex-jsonl' })
  lease.release()

  const { ctx, registeredTools } = fakeCtx()
  apply(ctx, { surface: 'direct', sessions: { path } })
  const tool = registeredTools.find((entry) => entry.name === 'coharness')
  const exec = { agent: { id: 's' }, signal: new AbortController().signal }

  const listed = await tool.execute({ action: 'sessions' }, exec)
  assert.match(listed.text, /thread…id/)
  assert.doesNotMatch(listed.text, /thread-very-secret-id/)
  assert.match(listed.text, /1 resumable/)

  const cleared = await tool.execute({ action: 'sessions', clear: true }, exec)
  assert.match(cleared.text, /cleared OMC session references/)
  assert.equal(createSessionRegistry({ path }).stats().entries, 0)
})

test('provider registration survives being loaded before the subagents service', async () => {
  const { ctx, registeredTools, setSubagents } = fakeCtx()
  const names = []
  apply(ctx, { surface: 'auto', transport: 'native' })
  assert.equal(names.length, 0, 'nothing can be registered before the service exists')

  setSubagents({
    list: () => [...names],
    registerProvider(provider) {
      names.push(provider.name)
      return () => {}
    },
  })

  const tool = registeredTools.find((entry) => entry.name === 'coharness')
  await tool.execute({ action: 'list' }, { agent: { id: 's' }, signal: new AbortController().signal })

  assert.ok(names.includes('omc:codex'), 'the first tool call must register the providers')
  assert.ok(names.includes('omc:opencode'))
})

test('the inject hook registers providers when the service appears', () => {
  const { ctx, injections, setSubagents } = fakeCtx()
  const names = []
  apply(ctx, { surface: 'auto' })
  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].deps, ['subagents'])

  setSubagents({ list: () => names, registerProvider: (provider) => (names.push(provider.name), () => {}) })
  injections[0].callback()

  assert.ok(names.includes('omc:codex'), 'the injection callback must register without a tool call')
})

test('doctor surfaces a provider registration failure instead of hiding it', async () => {
  const { ctx, registeredTools } = fakeCtx({
    subagents: {
      list: () => [],
      registerProvider() {
        throw new Error('UNSUPPORTED_CAPABILITY')
      },
    },
  })
  apply(ctx, { surface: 'auto', transport: 'native' })
  const tool = registeredTools.find((entry) => entry.name === 'coharness')

  const value = await tool.execute({ action: 'doctor' }, { agent: { id: 's' }, signal: new AbortController().signal })

  assert.match(value.text, /providers: none registered/)
  assert.match(value.text, /provider issues: .*codex: UNSUPPORTED_CAPABILITY/)
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
