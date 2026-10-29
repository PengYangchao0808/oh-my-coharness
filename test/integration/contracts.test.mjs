import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXTERNAL_ROLE_IDS,
  NATIVE_ONLY_ROLE_IDS,
  canUseExternal,
  normalizeExecution,
  validateExecution,
} from '../../integration/compatibility.js'
import { harnessReadOnlyClass, resolveExecution } from '../../integration/execution.js'
import { adaptPersonaForExternal, buildExternalBrief } from '../../integration/external-brief.js'
import { buildExecutionStatus, detectLegacyCompanion } from '../../integration/status.js'
import { HARNESSES, harnessDef } from '../../src/harnesses.js'
import { resolveConfig } from '../../src/config.js'
import { makeProvider } from '../../src/provider.js'

test('every role defaults to the native backend', () => {
  const resolved = resolveExecution('oracle', {}, ['omc:codex'])
  assert.equal(resolved.backend, 'native')
  assert.equal(resolved.provider, 'spawn')
  assert.equal(resolved.backgroundMode, 'continuable')
  assert.equal(resolved.external, false)
  assert.equal(resolved.blocked, false)
  assert.equal(normalizeExecution(undefined).backend, 'native')
})

test('an external role resolves only from the live provider list', () => {
  const ready = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'codex' } }, ['omc:codex'])
  assert.equal(ready.backend, 'omc')
  assert.equal(ready.provider, 'omc:codex')
  assert.equal(ready.backgroundMode, 'one-shot')
  assert.equal(ready.external, true)
  assert.equal(ready.readOnly, 'enforced')
  assert.equal(ready.blocked, false)

  const missing = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'codex' } }, ['spawn'])
  assert.equal(missing.blocked, true)
  assert.equal(missing.code, 'OMC/EXECUTION-UNAVAILABLE')
  assert.match(missing.reason, /not registered/)
})

test('fallback native is explicit and carries the reason', () => {
  const resolved = resolveExecution(
    'oracle',
    { execution: { backend: 'omc', harness: 'codex', fallback: 'native' } },
    [],
  )
  assert.equal(resolved.backend, 'native')
  assert.match(resolved.fallbackReason, /OMC\/EXECUTION-UNAVAILABLE/)
  assert.equal(resolved.external, false)
})

test('advisory-only CLIs are refused unless the risk is explicit', () => {
  const blocked = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'opencode' } }, ['omc:opencode'])
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.code, 'OMC/EXECUTION-READONLY-ADVISORY')

  const accepted = resolveExecution(
    'oracle',
    { execution: { backend: 'omc', harness: 'opencode', allowAdvisory: true } },
    ['omc:opencode'],
  )
  assert.equal(accepted.blocked, false)
  assert.equal(accepted.readOnly, 'advisory')
})

test('unverified CLIs cannot back a read-only role at all', () => {
  const resolved = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'qwen' } }, ['omc:qwen'])
  assert.equal(resolved.blocked, true)
  assert.equal(resolved.code, 'OMC/EXECUTION-READONLY-UNSUPPORTED')
})

test('an unknown harness fails with a structured reason', () => {
  const resolved = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'not-a-cli' } }, [])
  assert.equal(resolved.blocked, true)
  assert.equal(resolved.code, 'OMC/EXECUTION-UNKNOWN-HARNESS')
  assert.match(resolved.reason, /known harnesses:.*codex/)
})

test('structural execution errors throw and name the role', () => {
  assert.throws(() => validateExecution('fixer', { execution: { backend: 'omc', harness: 'codex' } }), /cannot use an external backend/)
  assert.throws(() => validateExecution('designer', { execution: { backend: 'omc', harness: 'codex' } }), /native path/)
  assert.throws(() => validateExecution('council', { execution: { backend: 'omc', harness: 'codex' } }), /synthesizer must stay native/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'nope' } }), /unknown execution backend/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'omc' } }), /without a harness/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'omc', harness: 'codex', fallback: 'nope' } }), /unknown fallback/)
})

test('the role capability table is the single source of which roles may go external', () => {
  for (const roleId of EXTERNAL_ROLE_IDS) assert.equal(canUseExternal(roleId), true, roleId)
  for (const roleId of NATIVE_ONLY_ROLE_IDS) assert.equal(canUseExternal(roleId), false, roleId)
  assert.deepEqual(new Set([...EXTERNAL_ROLE_IDS, ...NATIVE_ONLY_ROLE_IDS]).size, 10)
})

test('read-only classes match the recorded argv guarantees', () => {
  assert.equal(harnessReadOnlyClass('codex'), 'enforced')
  assert.equal(harnessReadOnlyClass('gemini'), 'enforced')
  assert.equal(harnessReadOnlyClass('antigravity'), 'enforced')
  assert.equal(harnessReadOnlyClass('opencode'), 'advisory')
  assert.equal(harnessReadOnlyClass('kimi'), 'advisory')
  assert.equal(harnessReadOnlyClass('qwen'), 'unsupported')
  assert.equal(harnessReadOnlyClass('not-a-cli'), 'unsupported')
  for (const def of HARNESSES) {
    assert.ok(['enforced', 'advisory', 'unsupported'].includes(def.readOnly), `${def.id} must declare a read-only class`)
  }
})

test('the external persona keeps role responsibilities and drops DSH tool instructions', () => {
  const persona = [
    'You are Oracle - a strategic technical advisor.',
    '**Behavior**: Be direct and concise.',
    '**File Operations Rules**:\n- READ-ONLY: inspect and report.\n- Prefer read/grep/glob.',
    '**Constraints**: READ-ONLY. Point to files and lines.',
  ].join('\n\n')
  const adapted = adaptPersonaForExternal(persona, { harness: 'codex', readOnly: 'enforced' })
  assert.match(adapted, /strategic technical advisor/)
  assert.match(adapted, /Be direct and concise/)
  assert.match(adapted, /Execution environment/)
  assert.match(adapted, /enforced by this CLI/)
  assert.doesNotMatch(adapted, /File Operations Rules/)
  assert.doesNotMatch(adapted, /Prefer read\/grep\/glob/)

  const brief = buildExternalBrief({
    roleId: 'oracle',
    roleTitle: 'oracle',
    persona,
    task: 'Review PR #12',
    harness: 'codex',
    readOnly: 'enforced',
    cwd: 'E:\\repo',
    constraints: ['Focus on the API boundary.'],
  })
  assert.match(brief, /^Role: oracle \(oracle\)/m)
  assert.match(brief, /Task:\nReview PR #12/)
  assert.match(brief, /Focus on the API boundary\./)
  assert.match(brief, /Workspace: E:\\repo/)
  assert.match(brief, /Return:\n- Summary/)
  assert.match(brief, /Read-only level: enforced/)
})

test('the provider surface is fixed read-only even when the global default is in-place', async () => {
  const specs = []
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      const read = (value) => ({ readFrom: () => ({ text: value, nextOffset: value.length, lossy: false }) })
      return {
        collected: { stdout: read('answer\n'), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = { subprocess, logger: { info() {}, warn() {} } }
  const cfg = resolveConfig({ transport: 'native', dispatch: { defaultMode: 'in-place' } })
  const provider = makeProvider(ctx, harnessDef('codex'), cfg, { readOnly: true })
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'review this' }],
    cwd: 'C:\\repo',
    signal: new AbortController().signal,
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.equal(specs.length, 1)
  assert.ok(specs[0].argv.includes('-s'))
  assert.equal(specs[0].argv[specs[0].argv.indexOf('-s') + 1], 'read-only')
  await run.dispose()
})

test('execution status reports roles, providers and read-only classes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-status-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({
    preset: 'my-dsh-normal',
    roles: {
      oracle: { execution: { backend: 'omc', harness: 'codex' } },
      explorer: { execution: { backend: 'omc', harness: 'opencode' } },
    },
  }), 'utf8')
  const previous = process.env.OH_MY_COHARNESS_CONFIG
  process.env.OH_MY_COHARNESS_CONFIG = file
  try {
    const ctx = {
      get(name) {
        if (name === 'subagents') return { list: () => ['spawn', 'omc:codex', 'omc:opencode'] }
        if (name === 'agentPresets') return { list: async () => [{ id: 'oh-my-coharness' }] }
        return undefined
      },
    }
    const status = await buildExecutionStatus(ctx)
    const oracle = status.roles.find((row) => row.roleId === 'oracle')
    const explorer = status.roles.find((row) => row.roleId === 'explorer')
    assert.equal(status.presetId, 'oh-my-coharness')
    assert.equal(oracle.backend, 'omc')
    assert.equal(oracle.providerAvailable, true)
    assert.equal(oracle.readOnly, 'enforced')
    assert.equal(explorer.blocked, true)
    assert.equal(explorer.code, 'OMC/EXECUTION-READONLY-ADVISORY')
    assert.equal(status.harnesses.find((row) => row.id === 'codex').readOnly, 'enforced')
  } finally {
    if (previous === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
    else process.env.OH_MY_COHARNESS_CONFIG = previous
  }
})

test('legacy companion detection is a read-only claim', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { list: async () => [{ id: 'oh-my-dsh-slim' }] }
      if (name === 'tools') return { get: (tool) => (tool === 'subagent_oracle' ? {} : undefined) }
      return undefined
    },
  }
  const legacy = await detectLegacyCompanion(ctx)
  assert.equal(legacy.legacyPreset, true)
  assert.equal(legacy.ourPreset, false)
  assert.deepEqual(legacy.legacyRoleTools, ['subagent_oracle'])
})

test('the resolver never invents a provider from the static table', () => {
  const resolved = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'codex' } }, [])
  assert.equal(resolved.blocked, true)
  assert.equal(resolved.available, false)
  assert.equal(resolved.provider, 'omc:codex')
})
