import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXTERNAL_MODES,
  EXTERNAL_ROLE_IDS,
  NATIVE_ONLY_ROLE_IDS,
  PATCH_ONLY_ROLE_IDS,
  canUseExternal,
  externalModeFor,
  isReadOnlyRole,
  normalizeExecution,
  validateExecution,
} from '../../integration/compatibility.js'
import { harnessReadOnlyClass, resolveExecution } from '../../integration/execution.js'
import { adaptPersonaForExternal, buildExternalBrief, defaultExternalConstraints } from '../../integration/external-brief.js'
import { buildExecutionStatus, detectLegacyCompanion, renderExecutionStatus } from '../../integration/status.js'
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
  assert.throws(() => validateExecution('council', { execution: { backend: 'omc', harness: 'codex' } }), /synthesizer must stay native/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'nope' } }), /unknown execution backend/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'omc' } }), /without a harness/)
  assert.throws(() => validateExecution('oracle', { execution: { backend: 'omc', harness: 'codex', fallback: 'nope' } }), /unknown fallback/)
})

test('designer may run external, but only as a patch producer', () => {
  const validated = validateExecution('designer', { execution: { backend: 'omc', harness: 'codex' } })
  assert.equal(validated.backend, 'omc')
  assert.equal(validated.mode, 'patch')

  const resolved = resolveExecution('designer', { execution: { backend: 'omc', harness: 'codex' } }, ['omc:codex'])
  assert.equal(resolved.backend, 'omc')
  assert.equal(resolved.provider, 'omc:codex')
  assert.equal(resolved.blocked, false)
  assert.equal(resolved.mode, 'patch')
  // Patch mode is still read-only toward the workspace: the CLI never writes.
  assert.equal(resolved.readOnly, 'enforced')
  assert.equal(isReadOnlyRole('designer'), true)
  assert.equal(canUseExternal('designer'), true)

  // A CLI that may still write cannot back a patch producer either.
  const advisory = resolveExecution('designer', { execution: { backend: 'omc', harness: 'opencode' } }, ['omc:opencode'])
  assert.equal(advisory.blocked, true)
  assert.equal(advisory.code, 'OMC/EXECUTION-READONLY-ADVISORY')
})

test('fixer and the council synthesizer still refuse the omc backend', () => {
  const codeFor = (roleId) => {
    try {
      validateExecution(roleId, { execution: { backend: 'omc', harness: 'codex' } })
      return undefined
    } catch (error) {
      return error.code
    }
  }
  assert.equal(codeFor('fixer'), 'OMC/EXECUTION-ROLE-UNSUPPORTED')
  assert.equal(codeFor('council'), 'OMC/EXECUTION-ROLE-UNSUPPORTED')
  assert.equal(codeFor('librarian'), 'OMC/EXECUTION-ROLE-UNSUPPORTED')
  assert.equal(codeFor('observer'), 'OMC/EXECUTION-ROLE-UNSUPPORTED')
})

test('every other external role stays in read-only mode', () => {
  assert.deepEqual([...EXTERNAL_MODES], ['read-only', 'patch'])
  assert.deepEqual([...PATCH_ONLY_ROLE_IDS], ['designer'])
  for (const roleId of EXTERNAL_ROLE_IDS) {
    assert.equal(externalModeFor(roleId), roleId === 'designer' ? 'patch' : 'read-only', roleId)
  }
  for (const roleId of NATIVE_ONLY_ROLE_IDS) assert.equal(externalModeFor(roleId), 'read-only', roleId)

  const oracle = resolveExecution('oracle', { execution: { backend: 'omc', harness: 'codex' } }, ['omc:codex'])
  assert.equal(oracle.mode, 'read-only')
  // A native child has DSH tools; no external mode applies to it.
  assert.equal(resolveExecution('oracle', {}, []).mode, null)
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

test('the default brief keeps the read-only contract word for word', () => {
  const input = {
    roleId: 'oracle',
    roleTitle: 'oracle',
    persona: 'You are Oracle - a strategic technical advisor.',
    task: 'Review PR #12',
    harness: 'codex',
    readOnly: 'enforced',
    cwd: 'E:\\repo',
  }
  const implicit = buildExternalBrief(input)
  // Omitting mode must reproduce today's output exactly, not merely resemble it.
  assert.equal(implicit, buildExternalBrief({ ...input, mode: 'read-only' }))
  assert.match(implicit, /Do not modify files, create commits, or run mutating commands\./)
  assert.match(implicit, /Read-only is enforced by this CLI's own sandbox\/approval flag\./)
  assert.match(implicit, /Return:\n- Summary\n- Evidence/)
  assert.doesNotMatch(implicit, /```diff/)
  assert.doesNotMatch(implicit, /External mode/)
})

test('the patch brief replaces the read-only instruction with a patch contract', () => {
  const brief = buildExternalBrief({
    roleId: 'designer',
    roleTitle: 'designer',
    persona: 'You are Designer - a UI implementation specialist.',
    task: 'Add a focus ring to the settings card.',
    harness: 'codex',
    readOnly: 'enforced',
    cwd: 'E:\\repo',
    mode: 'patch',
    constraints: defaultExternalConstraints('designer'),
  })
  // Boundary: still read-only, but the deliverable is a patch.
  assert.match(brief, /External mode: patch/)
  assert.match(brief, /Design the change and return it as a patch instead\./)
  // Exactly one fenced diff block, repo-relative paths, git apply -p1.
  assert.match(brief, /exactly ONE fenced ```diff block/)
  assert.match(brief, /unified diff/)
  assert.match(brief, /relative to the repository root/)
  assert.match(brief, /git apply -p1/)
  // The report must say what to apply and must not claim the work is done.
  assert.match(brief, /Files read:/)
  assert.match(brief, /Apply and verify:/)
  assert.match(brief, /Assumptions:/)
  assert.match(brief, /Do not claim it was applied, committed, merged, or verified/)
  // The designer constraint travels with the brief; shared constraints survive.
  assert.match(brief, /read-only design consultant/)
  assert.match(brief, /Do not modify files, configuration, or git state\./)
  // Neither the read-only-only instruction nor the old return list survives.
  assert.doesNotMatch(brief, /Do not modify files, create commits, or run mutating commands/)
  assert.doesNotMatch(brief, /Return:\n- Summary\n- Evidence/)
  // The environment paragraph and the one-report rule are common to both modes.
  assert.match(brief, /\*\*Execution environment\*\*/)
  assert.match(brief, /cannot resume this run/)
  // The designer entry is appended to the shared constraints, never instead of them.
  const consultant = defaultExternalConstraints('designer')
  for (const sharedLine of [
    'Do not modify files, configuration, or git state.',
    'Do not spawn or delegate to other agents.',
    'If the task needs information you cannot access, say so; do not invent it.',
  ]) {
    assert.ok(consultant.includes(sharedLine), sharedLine)
  }
  assert.equal(consultant.length, 4)
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

test('status rows carry the external mode and the per-harness model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-status-mode-'))
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({
    preset: 'my-dsh-normal',
    roles: {
      designer: { execution: { backend: 'omc', harness: 'codex' } },
    },
  }), 'utf8')
  const previous = process.env.OH_MY_COHARNESS_CONFIG
  process.env.OH_MY_COHARNESS_CONFIG = file
  try {
    const ctx = {
      get(name) {
        if (name === 'subagents') return { list: () => ['spawn', 'omc:codex'] }
        if (name === 'agentPresets') return { list: async () => [{ id: 'oh-my-coharness' }] }
        return undefined
      },
    }
    const status = await buildExecutionStatus(ctx, { harnesses: { codex: { model: 'gpt-5.4-codex' } } })
    assert.equal(status.configError, undefined)

    const designer = status.roles.find((row) => row.roleId === 'designer')
    assert.equal(designer.backend, 'omc')
    assert.equal(designer.blocked, false)
    assert.equal(designer.mode, 'patch')
    assert.equal(designer.externalCapable, true)
    assert.equal(designer.readOnly, 'enforced')

    // Native rows keep the same fields and have no external mode to report.
    const oracle = status.roles.find((row) => row.roleId === 'oracle')
    assert.equal(oracle.backend, 'native')
    assert.equal(oracle.mode, null)
    const fixer = status.roles.find((row) => row.roleId === 'fixer')
    assert.equal(fixer.backend, 'native')
    assert.equal(fixer.externalCapable, false)

    // Every harness row carries `model` so the card never reads a missing key.
    const codex = status.harnesses.find((row) => row.id === 'codex')
    assert.equal(codex.model, 'gpt-5.4-codex')
    assert.equal(codex.enabled, true)
    assert.equal(codex.provider, 'omc:codex')
    assert.equal(status.harnesses.find((row) => row.id === 'gemini').model, '')
    for (const row of status.harnesses) assert.equal(typeof row.model, 'string', row.id)
  } finally {
    if (previous === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
    else process.env.OH_MY_COHARNESS_CONFIG = previous
  }
})

test('doctor marks a patch producer without touching the read-only role lines', () => {
  const row = {
    enabled: true,
    execution: 'omc:codex',
    backend: 'omc',
    providerAvailable: true,
    readOnly: 'enforced',
  }
  const lines = renderExecutionStatus({
    presetId: 'oh-my-coharness',
    providers: ['omc:codex'],
    roles: [
      { ...row, roleId: 'oracle', mode: 'read-only' },
      { ...row, roleId: 'designer', mode: 'patch' },
      { ...row, roleId: 'fixer', backend: 'native', execution: 'native', readOnly: null, mode: null },
    ],
    harnesses: [],
  })
  const lineFor = (roleId) => lines.find((line) => line.startsWith(`  ${roleId} `))
  // A plain read-only external role keeps exactly the old flags text.
  assert.match(lineFor('oracle'), /omc\s+omc:codex\s+\(read-only enforced\)$/)
  // The patch producer is still read-only, but the deliverable is a diff.
  assert.match(lineFor('designer'), /omc\s+omc:codex\s+\(read-only enforced; patch producer\)$/)
  assert.match(lineFor('fixer'), /native\s+native\s*$/)
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
