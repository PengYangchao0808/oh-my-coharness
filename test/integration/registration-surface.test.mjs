/**
 * Registration-surface contract: what the plugin actually mounts at apply time.
 *
 * Cordis plugins are registered dynamically — the host loader resolves rows,
 * file URLs and services at runtime, so a static import graph cannot prove that
 * a module is reachable. Deleting a dynamically registered file because "no
 * static import reaches it" would silently remove a whole surface. This test
 * pins the surfaces themselves instead:
 *
 *   - the Host row: `coharness` tool, `/coharness` command, bundled skills,
 *     `omc:<id>` providers, the native-runtime bridge and the budget gate;
 *   - the companion half: the settings schema binding;
 *   - the preset row: the declarative preset registration, every role tool row
 *     and every dynamic `file:` module row (each file must exist on disk).
 *
 * It asserts behaviour and identity, not a full-text snapshot: IDs, counts and
 * apply-time side effects are stable; persona prose is not.
 *
 * What a host-free test cannot cover is called out with a skip instead of being
 * quietly treated as a pass.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as bundleApply } from '../../src/entry.js'
import { apply as hostApply } from '../../src/index.js'
import { HARNESSES } from '../../src/harnesses.js'
import { SKILLS } from '../../src/skills.js'
import {
  apply as presetApply,
  definition,
  PRESET_ID,
  ROLE_TOOLS,
} from '../../vendor/omd/npm-package/preset/preset.js'

/** A fake host context that records every dynamic registration. */
function createHost() {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-surface-'))
  const record = {
    tools: new Map(),
    commands: new Map(),
    skills: new Map(),
    providers: new Map(),
    listeners: [],
    injections: [],
    settings: [],
  }
  const subprocess = {
    async resolveExecutable(bin) {
      return bin
    },
    spawn() {
      throw new Error('the registration surface test must not launch a CLI')
    },
  }
  const services = {
    tools: {
      register(tool) {
        record.tools.set(tool.name, tool)
        return () => record.tools.delete(tool.name)
      },
    },
    commands: {
      register(command) {
        record.commands.set(command.name, command)
        return () => record.commands.delete(command.name)
      },
    },
    skills: {
      register(skill) {
        record.skills.set(skill.name, skill)
        return () => record.skills.delete(skill.name)
      },
    },
    subagents: {
      list: () => [...record.providers.keys()],
      registerProvider(provider) {
        record.providers.set(provider.name, provider)
        return () => record.providers.delete(provider.name)
      },
    },
    subprocess,
    workingDirectory: { ensure: async () => cwd },
    settings: {
      configure(...args) {
        record.settings.push(args)
      },
    },
  }
  const logger = { info() {}, warn() {} }

  const ctx = {
    tools: services.tools,
    subprocess,
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // Cordis defers a callback until every named service exists. Only invoke it
    // when this fake host really provides them; the "not yet present" state is
    // what the companion's loader/connection callback sees here.
    inject(deps, fn) {
      record.injections.push([...deps])
      if (!deps.every((dep) => services[dep] !== undefined)) return
      const child = {
        ...ctx,
        settings: services.settings,
        effect: ctx.effect,
        get: ctx.get,
        logger,
      }
      const result = fn(child)
      if (result && typeof result.then === 'function') result.catch(() => {})
    },
    on(event, handler, options) {
      record.listeners.push({ event, global: options?.global === true })
      return () => {}
    },
    logger,
  }

  return { cwd, ctx, record }
}

const flattenRows = (rows, collected = []) => {
  for (const row of rows) {
    collected.push(row)
    if (Array.isArray(row.config)) flattenRows(row.config, collected)
  }
  return collected
}

test('the Host row still mounts tools, commands, skills, providers and both event surfaces', () => {
  const { cwd, ctx, record } = createHost()
  bundleApply(ctx, {
    transport: 'native',
    stateDir: join(cwd, 'state'),
    sessions: { path: join(cwd, 'sessions.json') },
    harnesses: Object.fromEntries(HARNESSES.map((definition) => [definition.id, { enabled: true }])),
  })

  // Tool + command: the model-facing control surface.
  assert.deepEqual([...record.tools.keys()], ['coharness'], 'exactly one coharness tool must be registered')
  assert.equal(typeof record.tools.get('coharness').execute, 'function', 'the tool must keep its execute()')
  assert.deepEqual([...record.commands.keys()], ['coharness'], 'the /coharness command must stay registered')
  assert.equal(typeof record.commands.get('coharness').handler, 'function', 'the command must keep its handler')

  // Skills: one registration per bundled skill, with the frontmatter identity.
  assert.deepEqual(
    [...record.skills.keys()].sort(),
    SKILLS.map(({ dir }) => dir).sort(),
    'every bundled skill must still register by its directory name',
  )
  for (const skill of record.skills.values()) {
    assert.equal(typeof skill.description, 'string')
    assert.ok(skill.description.length > 0, 'a registered skill needs a description')
    assert.ok(skill.content.length > 200, 'a registered skill needs its body')
  }

  // Providers: every enabled harness becomes an omc:<id> provider.
  const expectedProviders = HARNESSES.map(({ id }) => `omc:${id}`).sort()
  assert.deepEqual([...record.providers.keys()].sort(), expectedProviders, 'the full omc:<id> provider set must register')
  for (const [name, provider] of record.providers) {
    assert.equal(provider.name, name)
    assert.equal(provider.capabilities?.agentOptions, false, 'providers stay fixed read-only (no host model routing)')
    assert.equal(provider.inheritsParentContext, false, 'an external run never inherits parent context')
    assert.equal(typeof provider.start, 'function', 'a provider needs start()')
  }

  // Native runtime bridge (agent/created + session/event) and the budget gate
  // (agent/pre-step + agent/request + its own session/event settlement).
  const events = record.listeners.map(({ event }) => event)
  assert.ok(events.includes('agent/created'), 'the native runtime bridge must subscribe to agent/created')
  assert.ok(
    events.filter((event) => event === 'session/event').length >= 2,
    'both the native bridge and the budget gate must observe session/event',
  )
  assert.ok(events.includes('agent/pre-step'), 'the budget gate must subscribe to agent/pre-step')
  assert.ok(events.includes('agent/request'), 'the budget gate must subscribe to agent/request')

  // Companion settings binding: the volatile profile form stays wired.
  assert.equal(record.settings.length, 1, 'the companion must configure the settings namespace exactly once')
  assert.deepEqual(record.settings[0][0], { auto: false }, 'settings.configure must keep its explicit non-auto mode')

  // The companion's profile RPC lives behind an injection of host services; a
  // bare Node process cannot satisfy it, but the declaration must still exist.
  assert.ok(
    record.injections.some(
      (deps) => deps.includes('agentPresets') && deps.includes('connection') && deps.includes('webServer'),
    ),
    'the companion must still declare the profile RPC injection surface',
  )
  assert.ok(
    record.injections.some((deps) => deps.includes('loader') && deps.includes('settings')),
    'the companion must still inject the loader and settings services',
  )
})

test('the preset row still registers every role row and every dynamic file row', async () => {
  const registrations = []
  let effects = 0
  const logger = { info() {}, warn() {} }
  const ctx = {
    logger,
    agentPresets: {
      register(document) {
        registrations.push(document)
        return Promise.resolve(async () => {})
      },
    },
    effect(fn) {
      effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject() {},
    get() {
      return undefined
    },
  }

  presetApply(ctx)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(effects, 1, 'the preset row must own exactly one effect')
  assert.equal(registrations.length, 1, 'the preset must register itself exactly once')
  const registered = registrations[0]
  assert.equal(registered.id, PRESET_ID, 'the registered preset keeps its stable id')
  assert.equal(registered.name, definition.name, 'the registered preset keeps its display name')
  assert.equal(registered.plugins.length, definition.plugins.length, 'the plugin composition must not shrink')

  const rows = flattenRows(registered.plugins)
  const ids = rows.map(({ id }) => id)
  for (const [, toolId] of ROLE_TOOLS) {
    assert.ok(ids.includes(toolId), `the preset must still mount ${toolId}`)
  }
  for (const id of [
    'role-composition',
    'subagent-result',
    'subagent-roles',
    'early-close-context',
    'sandbox-strip',
    'role-mcp',
    'council-mode',
  ]) {
    assert.ok(ids.includes(id), `the preset must still mount the dynamic row ${id}`)
  }

  // The role tools are file-URL rows; deleting roles.js or changing the row
  // shape would break every role, and neither change is visible to a static
  // import graph.
  const roleRows = rows.filter((row) => ROLE_TOOLS.some(([, toolId]) => toolId === row.id))
  assert.equal(roleRows.length, ROLE_TOOLS.length, 'one row per advertised role')
  for (const row of roleRows) {
    assert.ok(row.name.endsWith('/roles.js'), `${row.id} must load roles.js dynamically`)
    assert.equal(row.config?.definition?.roleId, row.id.replace(/^tool-subagent-/, ''), `${row.id} must carry its role id`)
  }

  // Every file: URL row must point at a module that exists in this checkout.
  const fileRows = rows.filter((row) => typeof row.name === 'string' && row.name.startsWith('file:'))
  assert.ok(fileRows.length >= 10, `expected at least 10 dynamic file rows, found ${fileRows.length}`)
  for (const row of fileRows) {
    const file = fileURLToPath(row.name)
    assert.ok(existsSync(file), `${row.id} points at a missing module: ${file}`)
  }
})

test(
  'real profile RPC transport registration and the host settings card are not exercisable here',
  {
    skip:
      'companion.apply registers /coharness through ctx.inject([loader, connection, webServer, agentPresets, configEditor, settings]) '
      + 'and the host connection service; a bare Node test has none of those, so invoking that async callback would test a stub, not the host. '
      + 'The injection declaration is asserted above; test/integration/client.test.mjs loads the settings card bundle without a host.',
  },
  () => {},
)

// Keep the direct Host half covered even if entry.js someday composes differently.
test('the Host half alone keeps the same tool/command/skill/provider set', () => {
  const { cwd, ctx, record } = createHost()
  hostApply(ctx, {
    transport: 'native',
    stateDir: join(cwd, 'state'),
    sessions: { path: join(cwd, 'sessions.json') },
    harnesses: Object.fromEntries(HARNESSES.map((definition) => [definition.id, { enabled: true }])),
  })
  assert.deepEqual([...record.tools.keys()], ['coharness'])
  assert.deepEqual([...record.commands.keys()], ['coharness'])
  assert.equal(record.skills.size, SKILLS.length)
  assert.equal(record.providers.size, HARNESSES.length)
  assert.ok(record.listeners.some(({ event }) => event === 'agent/created'))
})
