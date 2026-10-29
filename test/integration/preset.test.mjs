import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadConfig,
  resetConfigForTests,
  validateConfigDocument,
} from '../../vendor/omd/npm-package/preset/config.js'
import {
  ROLE_MARKER_PREFIX,
  LEGACY_ROLE_MARKER_PREFIX,
  blockedRoleTool,
  externalRoleArgs,
  resolveRole,
  roleIdFromEvents,
} from '../../vendor/omd/npm-package/preset/roles.js'
import { patchRoleTool, roleDescription } from '../../vendor/omd/npm-package/preset/role-wording.js'
import { councilModeText } from '../../vendor/omd/npm-package/preset/council-mode.js'

let configDir
let configFile
const previous = process.env.OH_MY_COHARNESS_CONFIG

async function useConfig(document) {
  configDir = await mkdtemp(join(tmpdir(), 'omc-preset-'))
  configFile = join(configDir, 'config.json')
  await writeFile(configFile, JSON.stringify(document), 'utf8')
  process.env.OH_MY_COHARNESS_CONFIG = configFile
  resetConfigForTests()
}

test.beforeEach(async () => {
  await useConfig({
    preset: 'my-dsh-normal',
    roles: {
      oracle: { execution: { backend: 'omc', harness: 'codex' } },
      explorer: { execution: { backend: 'omc', harness: 'opencode', allowAdvisory: true } },
      fixer: { execution: { backend: 'native' } },
    },
    presets: { 'my-dsh-normal': {} },
  })
})

test.after(() => {
  if (previous === undefined) delete process.env.OH_MY_COHARNESS_CONFIG
  else process.env.OH_MY_COHARNESS_CONFIG = previous
  resetConfigForTests()
})

const row = (roleId) => ({
  provider: 'spawn',
  backgroundMode: 'continuable',
  maxDepth: 1,
  definition: { roleId, persona: `You are ${roleId}.` },
})

function ctxWith(providers) {
  return {
    get(name) {
      if (name === 'subagents') return { list: () => providers }
      return undefined
    },
    logger: { warn() {}, info() {} },
  }
}

test('loadConfig exposes the execution block from the configured source', () => {
  const config = loadConfig()
  assert.equal(config.roles.oracle.execution.backend, 'omc')
  assert.equal(config.roles.fixer.execution.backend, 'native')
  assert.equal(config.source, configFile)
})

test('structural execution errors reject the document', () => {
  assert.throws(
    () => validateConfigDocument({ roles: { fixer: { execution: { backend: 'omc', harness: 'codex' } } } }),
    /cannot use an external backend/,
  )
  assert.throws(
    () => validateConfigDocument({ roles: { council: { execution: { backend: 'omc', harness: 'codex' } } } }),
    /synthesizer must stay native/,
  )
  assert.throws(
    () => validateConfigDocument({
      roles: { oracle: { execution: { backend: 'omc', harness: 'codex' }, mcps: ['context7'] } },
    }),
    /MCP tools are mounted only in DSH-native children/,
  )
  assert.throws(
    () => validateConfigDocument({ roles: { oracle: { execution: { backend: 'nope' } } } }),
    /unknown execution backend/,
  )
})

test('an external role resolves to the host stock config without model options', () => {
  const role = resolveRole(row('oracle'), ctxWith(['spawn', 'omc:codex']))
  assert.equal(role.external, true)
  assert.equal(role.blocked, false)
  assert.equal(role.stock.provider, 'omc:codex')
  assert.equal(role.stock.maxDepth, 'provider-managed')
  assert.equal(role.stock.toolName, 'subagent_oracle')
  assert.equal(Object.hasOwn(role.stock, 'agentOptions'), false)
  assert.equal(Object.hasOwn(role.stock, 'agentPreset'), false)
  assert.deepEqual(Object.keys(role.stock).sort(), ['maxDepth', 'provider', 'toolName'])
  assert.deepEqual(role.agentOptions, {})
})

test('a missing provider mounts a blocked role instead of a native fallback', async () => {
  const role = resolveRole(row('oracle'), ctxWith(['spawn']))
  assert.equal(role.blocked, true)
  assert.equal(role.blockCode, 'OMC/EXECUTION-UNAVAILABLE')
  assert.equal(role.stock, undefined)
  const tool = blockedRoleTool(role)
  assert.equal(tool.name, 'subagent_oracle')
  assert.match(tool.description, /UNAVAILABLE/)
  await assert.rejects(tool.execute({ prompt: 'x' }), /OMC\/EXECUTION-UNAVAILABLE/)
})

test('native roles keep the exact pre-merge stock shape', () => {
  const role = resolveRole(row('fixer'), ctxWith(['spawn']))
  assert.equal(role.external, false)
  assert.equal(role.stock.provider, 'spawn')
  assert.equal(role.stock.maxDepth, 1)
  assert.equal(role.stock.backgroundMode, 'continuable')
  assert.equal(role.stock.toolName, 'subagent_fixer')
  assert.equal(Object.hasOwn(role.stock, 'agentOptions'), false)
})

test('advisory read-only is accepted only when explicitly allowed', async () => {
  const accepted = resolveRole(row('explorer'), ctxWith(['spawn', 'omc:opencode']))
  assert.equal(accepted.external, true)
  assert.equal(accepted.blocked, false)
  assert.equal(accepted.execution.readOnly, 'advisory')

  // Same CLI, same role, but without the explicit risk acceptance.
  await useConfig({
    preset: 'my-dsh-normal',
    roles: { oracle: { execution: { backend: 'omc', harness: 'opencode' } } },
    presets: { 'my-dsh-normal': {} },
  })
  const blocked = resolveRole(row('oracle'), ctxWith(['spawn', 'omc:opencode']))
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.blockCode, 'OMC/EXECUTION-READONLY-ADVISORY')
})

test('the external role wording describes a one-shot, persona-wrapped CLI run', () => {
  const description = roleDescription({
    external: true,
    description: 'Strategic technical advisor.',
    execution: { provider: 'omc:codex', readOnly: 'enforced' },
  })
  assert.match(description, /external CLI provider \(omc:codex\)/)
  assert.match(description, /cannot be asked a follow-up/)
  assert.match(description, /wrapped in this role's persona/)
  assert.match(description, /enforced by that CLI's own sandbox/)

  const tool = {
    name: 'subagent_oracle',
    description: 'Delegate a self-contained task. Child LLM selection is optional. provider/model stuff',
    parameters: { prompt: { type: 'string', description: 'old' }, provider: { type: 'string' }, model: { type: 'string' } },
    output: { render: () => [] },
  }
  const patched = patchRoleTool(tool, {
    toolName: 'subagent_oracle',
    external: true,
    description: 'Strategic technical advisor.',
    execution: { provider: 'omc:codex', readOnly: 'enforced' },
    schedulable: false,
  })
  assert.match(patched.parameters.prompt.description, /wrapped automatically/)
  assert.doesNotMatch(patched.description, /Child LLM selection is optional/)
  assert.match(patched.description, /omc:codex/)
})

test('the external role wrapper replaces the task with the full role brief', () => {
  const role = resolveRole(row('oracle'), ctxWith(['spawn', 'omc:codex']))
  const args = { cwd: 'E:\\repo', description: 'review', prompt: 'Review PR #12' }
  const external = externalRoleArgs(role, args)
  assert.equal(external.description, 'review')
  assert.equal(external.cwd, 'E:\\repo')
  assert.match(external.prompt, /^Role: oracle \(oracle\)/m)
  assert.match(external.prompt, /You are oracle\./)
  assert.match(external.prompt, /Task:\nReview PR #12/)
  assert.match(external.prompt, /Read-only level: enforced/)
  assert.match(external.prompt, /Execution backend: omc:codex/)
  assert.doesNotMatch(external.prompt, /\*\*File Operations Rules\*\*/)

  const native = resolveRole(row('oracle'), ctxWith(['spawn']))
  assert.deepEqual(externalRoleArgs(native, args), args)
  assert.deepEqual(externalRoleArgs({ ...role, blocked: true }, args), args)
})

test('council text names mixed backends and does not assume identical tools', () => {
  const text = councilModeText(
    ['councillor-alpha', 'councillor-beta'],
    {
      'councillor-alpha': { backend: 'native' },
      'councillor-beta': { backend: 'omc', harness: 'codex', readOnly: 'enforced' },
    },
  )
  assert.match(text, /alpha \(subagent_councillor_alpha → DSH native\)/)
  assert.match(text, /beta \(subagent_councillor_beta → external omc:codex · read-only enforced\)/)
  assert.match(text, /Do not assume every seat has the same tool set/)
  assert.match(text, /synthesizer is always DSH-native/)
})

test('the role marker accepts the pre-0.4 spelling on cold resume', () => {
  const events = [{
    type: 'subagent/descriptor',
    data: { label: 'unlabelled', persona: `Internal role id: ${LEGACY_ROLE_MARKER_PREFIX}oracle.` },
  }]
  assert.equal(roleIdFromEvents(events), 'oracle')
  const current = [{
    type: 'subagent/descriptor',
    data: { label: 'unlabelled', persona: `Internal role id: ${ROLE_MARKER_PREFIX}fixer.` },
  }]
  assert.equal(roleIdFromEvents(current), 'fixer')
})
