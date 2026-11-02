/**
 * The implicit direct fallback is opt-in only.
 *
 * A missing, unregistered or rejecting provider used to become a direct run without a
 * word. That surface has no child session and no host capacity slot, so a silent
 * degradation read like full support. These tests pin the three ways to reach direct —
 * two explicit, one gated by `dispatch.allowDirectFallback` — and prove that a refusal
 * never touches the CLI at all.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../../src/config.js'
import { dispatchTasks } from '../../src/dispatch.js'

/**
 * A ctx shim that records every attempt to reach a real CLI. `specs` and `resolutions`
 * are the strong proof a test wants: a refusal that caught a launch error would still
 * look like a failed result, but it cannot leave both counters at zero.
 */
function fakeCtx({ stdout = 'direct surface ran\n', subagents } = {}) {
  const specs = []
  let resolutions = 0
  const subprocess = {
    async resolveExecutable(bin) {
      resolutions += 1
      // An absolute path is verified as-is, exactly like the real seam.
      if (bin.includes('\\') || bin.includes('/')) return bin
      return `C:\\fake\\${bin}.exe`
    },
    spawn(spec) {
      specs.push(spec)
      const read = (text) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() {
          return true
        },
      }
    },
  }
  const service = subagents ?? {
    list: () => [],
    async startActivation() {
      throw new Error('the direct surface must never start an activation')
    },
  }
  return {
    specs,
    resolutions: () => resolutions,
    ctx: {
      subprocess,
      get: (name) => (name === 'subprocess' ? subprocess : name === 'subagents' ? service : undefined),
    },
  }
}

function fakeRuntime({ cfg, registered = [], subagents } = {}) {
  const fake = fakeCtx({ subagents })
  const rt = {
    ctx: fake.ctx,
    cfg: resolveConfig(cfg),
    registered: new Set(registered),
    async detect() {
      return { rows: [{ id: 'codex', auth: 'ok' }] }
    },
  }
  return { rt, specs: fake.specs, resolutions: fake.resolutions }
}

/** A fresh signal per call: a shared one would couple otherwise independent tests. */
function exec() {
  return { agent: { id: 'session-1' }, signal: new AbortController().signal }
}

/** A path that cannot exist, so "did it try to run the CLI" is unambiguous. */
const MISSING_COMMAND = 'C:\\nonexistent\\omc-codex.exe'

function diagnosticsOf(result) {
  return (result?.diagnostics ?? []).join('\n')
}

test('an unregistered provider fails loudly instead of running direct', async () => {
  const { rt, specs, resolutions } = fakeRuntime({
    cfg: { transport: 'native', harnesses: { codex: { command: MISSING_COMMAND } } },
  })
  assert.equal(rt.cfg.dispatch.allowDirectFallback, false, 'the implicit fallback is off by default')

  const startedAt = Date.now()
  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'failed')
  assert.equal(result.harnessId, 'codex')
  assert.equal(result.output, '')
  assert.equal(result.surface, 'provider', 'the refusal names the surface the caller asked for')
  assert.equal(result.downgradeReason, undefined, 'nothing degraded: no surface ran')
  assert.equal(result.nativeSession, undefined, 'a refused task has no CLI session')
  assert.equal(result.exitCode, undefined, 'a refused task never exited')
  assert.ok(result.elapsedMs < 1000, `a refusal is immediate (got ${result.elapsedMs}ms)`)

  const diagnostics = diagnosticsOf(result)
  assert.match(diagnostics, /OMC\/PROVIDER-UNAVAILABLE: /)
  assert.match(diagnostics, /omc:codex is not registered as a provider/, 'the eligibility reason must survive')
  assert.match(diagnostics, /dispatch\.allowDirectFallback=false/)

  // The proof that no direct run happened: the transport was never touched.
  assert.equal(resolutions(), 0, 'direct must not even resolve an executable')
  assert.equal(specs.length, 0, 'direct must not spawn a CLI')
  assert.ok(Date.now() - startedAt < 1000, 'the refusal must not wait on anything')
})

test('allowDirectFallback=true opts the same call back into the direct surface', async () => {
  const { rt, specs, resolutions } = fakeRuntime({
    cfg: {
      transport: 'native',
      dispatch: { allowDirectFallback: true },
      harnesses: { codex: { command: MISSING_COMMAND } },
    },
  })
  assert.equal(rt.cfg.dispatch.allowDirectFallback, true)

  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'completed')
  assert.equal(result.surface, 'direct')
  assert.doesNotMatch(diagnosticsOf(result), /OMC\/PROVIDER-UNAVAILABLE/, 'an opted-in fallback is not a refusal')
  assert.equal(result.downgradeReason, 'omc:codex is not registered as a provider')
  assert.match(result.output, /direct surface ran/)
  assert.equal(resolutions(), 1, 'the opted-in path really plans a transport')
  assert.equal(specs.length, 1, 'the opted-in path really spawns the CLI')
  assert.equal(specs[0].argv[0], MISSING_COMMAND)
})

test('surface: direct still runs direct while the implicit fallback stays off', async () => {
  const { rt, specs } = fakeRuntime({ cfg: { surface: 'direct', transport: 'native' } })
  assert.equal(rt.cfg.dispatch.allowDirectFallback, false)

  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'read README' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'completed')
  assert.equal(result.surface, 'direct')
  assert.equal(result.downgradeReason, 'surface is configured as direct')
  assert.doesNotMatch(diagnosticsOf(result), /OMC\/PROVIDER-UNAVAILABLE/)
  assert.equal(specs.length, 1)
})

test('a write mode still takes the direct surface while the implicit fallback stays off', async () => {
  // The provider is registered, so the mode is the only reason to leave that surface.
  const { rt, specs } = fakeRuntime({ cfg: { transport: 'native' }, registered: ['codex'] })
  assert.equal(rt.cfg.dispatch.allowDirectFallback, false)

  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'change it', mode: 'in-place' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'completed')
  assert.equal(result.surface, 'direct')
  assert.match(result.downgradeReason, /omc providers are fixed read-only/)
  assert.doesNotMatch(diagnosticsOf(result), /OMC\/PROVIDER-UNAVAILABLE/)
  assert.equal(specs.length, 1)
})

test('background on a missing provider is refused before the fallback question', async () => {
  const { rt, specs } = fakeRuntime({ cfg: { transport: 'native' } })

  const payload = await dispatchTasks(
    rt,
    { harness: 'codex', prompt: 'go', delivery: 'background' },
    exec(),
  )
  const [result] = payload.results

  assert.equal(result.status, 'failed')
  assert.match(result.diagnostics[0], /OMC\/BACKGROUND-UNSUPPORTED/)
  assert.doesNotMatch(diagnosticsOf(result), /OMC\/PROVIDER-UNAVAILABLE/)
  assert.equal(specs.length, 0, 'nothing may be spawned for an unsupported delivery')
})

test('a fallbackable activation error is refused while the fallback stays off', async () => {
  const { rt, specs } = fakeRuntime({
    cfg: { transport: 'native' },
    registered: ['codex'],
    subagents: {
      list: () => ['omc:codex'],
      async startActivation() {
        const error = new Error('UNKNOWN_PROVIDER: omc:codex is not available')
        error.code = 'UNKNOWN_PROVIDER'
        throw error
      },
    },
  })

  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'failed')
  assert.equal(result.harnessId, 'codex')
  assert.equal(result.surface, 'provider')
  assert.equal(result.output, '')
  assert.equal(result.childId, undefined)
  assert.equal(result.downgradeReason, undefined)

  const diagnostics = diagnosticsOf(result)
  assert.match(diagnostics, /OMC\/PROVIDER-UNAVAILABLE: /)
  assert.match(diagnostics, /UNKNOWN_PROVIDER/, 'the activation code must survive')
  assert.match(diagnostics, /dispatch\.allowDirectFallback=false/)
  assert.equal(specs.length, 0, 'the refused activation must not become a direct run')
})

test('allowDirectFallback=true also unlocks the activation-error fallback', async () => {
  const { rt, specs } = fakeRuntime({
    cfg: { transport: 'native', dispatch: { allowDirectFallback: true } },
    registered: ['codex'],
    subagents: {
      list: () => ['omc:codex'],
      async startActivation() {
        const error = new Error('UNSUPPORTED_CAPABILITY: no parent lane')
        error.code = 'UNSUPPORTED_CAPABILITY'
        throw error
      },
    },
  })

  const payload = await dispatchTasks(rt, { harness: 'codex', prompt: 'go' }, exec())
  const [result] = payload.results

  assert.equal(result.status, 'completed')
  assert.equal(result.surface, 'direct')
  assert.match(result.downgradeReason, /provider activation rejected the call \(UNSUPPORTED_CAPABILITY\)/)
  assert.doesNotMatch(diagnosticsOf(result), /OMC\/PROVIDER-UNAVAILABLE/)
  assert.equal(specs.length, 1)
})
