import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../src/index.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { handoffFromPrompt, normalizeWorkspace } from '../../integration/handoff.js'
import { patchedContext } from '../../vendor/omd/npm-package/preset/roles.js'
import { latestOwnAssistant } from '../../vendor/omd/npm-package/preset/subagent-result.js'
import { loadClientBundle } from '../helpers/client-loader.mjs'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-usable-'))
  const tools = new Map(), providers = new Map(), specs = []
  const subagents = {
    list: () => [...providers.keys()],
    registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name) },
  }
  const read = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subprocess: {
      async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
      spawn(spec) {
        specs.push(spec)
        const stdout = [
          { type: 'thread.started', thread_id: 'thread-usable-oracle' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'Evidence: src/provider.js; verification passed.' } },
          { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } },
        ].map(row => JSON.stringify(row)).join('\n')
        return { collected: { stdout: read(stdout), stderr: read('') },
          done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true } }
      },
    },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'subagents') return subagents
      if (name === 'subprocess') return ctx.subprocess
      if (name === 'workingDirectory') return { ensure: async () => cwd }
    },
    effect(fn) { return fn() },
    inject(_deps, fn) { fn(ctx) },
  }
  apply(ctx, { transport: 'native', stateDir: join(cwd, 'state'), sessions: { path: join(cwd, 'sessions.json') },
    harnesses: Object.fromEntries(['codex', 'claude', 'glm', 'gemini', 'antigravity', 'kimi', 'opencode', 'qwen'].map(id => [id, { enabled: id === 'codex' }])) })
  const role = { external: true, roleId: 'oracle', toolName: 'subagent_oracle', row: { title: 'oracle' }, persona: 'You are Oracle.',
    execution: { provider: 'omc:codex', harness: 'codex', readOnly: 'enforced' }, stock: { provider: 'omc:codex' } }
  const runs = new Map()
  patchedContext(ctx, {}, role).tools.register({
    name: 'subagent_oracle', parameters: { cwd: { type: 'string' }, prompt: { type: 'string' } },
    async execute(args, exec) {
      const run = await providers.get('omc:codex').start({ prompt: [{ type: 'text', text: args.prompt }],
        cwd: args.cwd, parent: exec.agent, label: args.description, signal: exec.signal })
      runs.set(run.id, run)
      return { kind: 'activation', subagentId: run.id }
    },
  })
  return { ctx, cwd, specs, tools, runs }
}

test('role → provider → retained result → same-lane follow-up reuses the native CLI session', async () => {
  const { cwd, specs, tools, runs } = fixture()
  const role = tools.get('subagent_oracle'), control = tools.get('coharness')
  const exec = { agent: { id: 'parent-one' }, signal: new AbortController().signal }
  assert.ok(role.parameters.lane, 'the model can actually supply a lane')
  const args = { description: 'Review session router', prompt: 'Review the router.', lane: 'review-router',
    context_summary: 'Fixer changed the session router.', changed_files: ['src/provider.js'],
    artifact_refs: ['docs/V0.5.md'], acceptance: ['Confirm session isolation.'] }
  const receipt = await role.execute(args, exec) // cwd deliberately inherited
  await runs.get(receipt.subagentId).result
  const tasks = JSON.parse((await control.execute({ action: 'tasks' }, exec)).text)
  assert.equal(tasks[0].id, receipt.subagentId)
  assert.equal(tasks[0].lane, 'review-router')
  assert.equal(tasks[0].status, 'completed')
  const reread = JSON.parse((await control.execute({ action: 'result', task_id: receipt.subagentId }, exec)).text)
  assert.match(reread.task.result.output[0].text, /verification passed/)
  assert.equal(reread.roleResult.state, 'completed')
  assert.equal(reread.roleResult.complete, true)
  assert.equal(specs.length, 1, 'rereading a result must not call a model')
  assert.equal(normalizeWorkspace(specs[0].cwd), normalizeWorkspace(cwd))
  assert.match(specs[0].argv.at(-1), /Changed files: src\/provider.js/)
  assert.match(specs[0].argv.at(-1), /Confirm session isolation/)
  assert.doesNotMatch(specs[0].argv.at(-1), /omc-handoff:v1/)
  const followup = await role.execute({ ...args, prompt: 'Check the regression after the fix.' }, exec)
  await runs.get(followup.subagentId).result
  assert.notEqual(followup.subagentId, receipt.subagentId)
  assert.ok(specs[1].argv.includes('resume'))
  assert.ok(specs[1].argv.includes('thread-usable-oracle'))
  assert.equal(specs.length, 2)
  const intruder = { ...exec, agent: { id: 'other-parent' } }
  await assert.rejects(control.execute({ action: 'result', task_id: receipt.subagentId }, intruder), { code: 'OMC/TASK-NOT-FOUND' })
  await assert.rejects(control.execute({ action: 'cancel', task_id: receipt.subagentId }, intruder), { code: 'OMC/TASK-NOT-FOUND' })
  assert.deepEqual(JSON.parse((await control.execute({ action: 'tasks' }, intruder)).text), [])
})

test('role handoff parameters are consumed by OMC and relative cwd resolves against the parent workspace', async () => {
  const { tools, cwd } = fixture()
  const { prepareExternalRoleArgs } = await import('../../vendor/omd/npm-package/preset/roles.js')
  const role = { external: true, roleId: 'oracle', row: { title: 'oracle' }, persona: 'Oracle', execution: { harness: 'codex', readOnly: 'enforced' } }
  const args = await prepareExternalRoleArgs({ get: () => ({ ensure: async () => cwd }) }, role,
    { cwd: 'subdir', prompt: 'Review', lane: 'explicit-lane', context_summary: 'facts' },
    { agent: { id: 'parent' }, signal: new AbortController().signal })
  assert.equal(args.cwd, join(cwd, 'subdir'))
  assert.equal(Object.hasOwn(args, 'lane'), false)
  assert.equal(Object.hasOwn(args, 'context_summary'), false)
  const { handoff } = handoffFromPrompt(args.prompt)
  assert.equal(handoff.workspace.path, normalizeWorkspace(join(cwd, 'subdir')))
  assert.equal(handoff.context.summary, 'facts')
  await assert.rejects(tools.get('subagent_oracle').execute({ prompt: 'Review', changed_files: ['../escape'] },
    { agent: { id: 'parent' }, signal: new AbortController().signal }), /workspace-relative/)
})

test('cancel acknowledgement stays running until the real result settles; completed receipts are bounded', async () => {
  const tasks = createTaskRegistry({ maxRetained: 1 })
  let cancelled = 0
  tasks.start({ id: 'first', parentId: 'parent', harness: 'codex', cancel: () => { cancelled++ } })
  const ack = await tasks.cancel('parent', 'first')
  assert.equal(cancelled, 1)
  assert.equal(ack.status, 'running')
  assert.equal(ack.cancelRequested, true)
  tasks.settle('first', { stopReason: 'aborted', output: [] })
  assert.equal(tasks.read('parent', 'first').status, 'cancelled')
  tasks.start({ id: 'second', parentId: 'parent', harness: 'claude' })
  tasks.settle('second', { stopReason: 'completed', output: [] })
  assert.deepEqual(tasks.list('parent').map(row => row.id), ['second'])
  assert.throws(() => tasks.read('parent', 'first'), { code: 'OMC/TASK-NOT-FOUND' })
  await tasks.cancel('parent', 'second')
  assert.equal(cancelled, 1, 'a terminal task is never cancelled again')
  const outOfOrder = createTaskRegistry({ maxRetained: 1 })
  outOfOrder.start({ id: 'slow', parentId: 'parent' })
  outOfOrder.start({ id: 'fast', parentId: 'parent' })
  outOfOrder.settle('fast', { stopReason: 'completed', output: [] })
  outOfOrder.settle('slow', { stopReason: 'completed', output: [] })
  assert.deepEqual(outOfOrder.list('parent').map(row => row.id), ['slow'], 'retention follows completion order, so a long task remains readable when it finishes')
})

test('a fork parent answer is never mistaken for its child result', () => {
  const message = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  assert.equal(latestOwnAssistant({ events: [message(0, 'parent answer')], inheritedEventCount: 1 }), undefined)
  assert.equal(latestOwnAssistant({ events: [message(0, 'parent answer'), message(1, 'child answer')], inheritedEventCount: 1 }).text, 'child answer')
})

test('native popup controls have an opaque background on Windows/Linux', () => {
  const { source } = loadClientBundle()
  const style = source.slice(source.indexOf('const controlStyle ='), source.indexOf('const controlStyle =') + 250)
  assert.match(style, /background: 'var\(--dsw-alias-bg-layer-3\)'/)
  assert.doesNotMatch(style, /background: 'transparent'/)
})
