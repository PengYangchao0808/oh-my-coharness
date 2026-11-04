/**
 * PR-07: the real Host Executor entry.
 *
 * The synthetic fixture proves WIRING, not a paid model run:
 *   - the coharness `trial` action plans a frozen document and writes nothing;
 *   - execute is fail-closed on confirmation, USD caps, blockers, placeholder
 *     selections, missing checkouts/receipts and incomplete prompts — with zero
 *     dispatch;
 *   - a legitimate call enters the real executePlan()/createHostExecutor()
 *     path with parent/task/node identity, an acceptance spec, prompt/chain,
 *     a receipt at the caller's explicit path, and no overwrite;
 *   - E2 prerequisite/chain keep their existing semantics;
 *   - no host context and the plain CLI still refuse with OMC/TRIAL-NO-EXECUTOR.
 *
 * A real 25-trial run additionally needs real model/provider/harness
 * selections, machine-specific upstream checkouts at the frozen commits,
 * complete prompts for every task/prerequisite, and a paid-run confirmation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGraphStore } from '../../integration/graph.js'
import { createExecutionStore } from '../../integration/execution-events.js'
import { createUsageLedger } from '../../integration/usage-ledger.js'
import { createManagedExecution } from '../../integration/managed-execution.js'
import { createMailbox } from '../../integration/mailbox.js'
import { createTaskRegistry } from '../../integration/tasks.js'
import { createHostExecutor } from '../../integration/host-executor.js'
import { createStrategyExperiment } from '../../integration/strategy-eval.js'
import { apply, createTrialService } from '../../src/index.js'
import { resolveConfig } from '../../src/config.js'
import { makeProvider } from '../../src/provider.js'
import { harnessDef } from '../../src/harnesses.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function acceptanceSpec(taskId = 'trial-task') {
  return {
    taskId,
    split: 'development',
    commands: [{ name: 'ok', run: ['node', '-e', '0'], expect: { exitCode: 0 } }],
    acceptanceFiles: [],
    forbidChanges: [],
    rubric: ['the fixed check passes'],
  }
}

function fixtureRepo(workspace) {
  const repo = join(workspace, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'spec.json'), JSON.stringify(acceptanceSpec(), null, 2), 'utf8')
  return repo
}

function experimentSpec(repo, { group = 'E1', prompt = 'Implement the task.', chains = false, prerequisite = false } = {}) {
  const task = {
    id: 'task-a',
    revision: 'rev-a',
    repo,
    baseCommit: 'abc1234567',
    harness: 'codex',
    acceptance: { spec: 'spec.json' },
    ...(chains
      ? { kind: 'chain', chain: [{ id: 'step-1', goal: 'Inspect the failing case.' }, { id: 'step-2', goal: 'Apply the minimal fix.' }] }
      : { prompt }),
  }
  return {
    experimentId: group === 'E2' ? 'synthetic-e2' : 'synthetic-e1',
    experimentGroup: group,
    repeats: 1,
    seed: 'pr07',
    dataKind: 'synthetic',
    split: 'development',
    arms: ['single', 'multi-role'],
    tasks: [task],
    ...(prerequisite ? {
      prerequisite: {
        id: 'primer',
        revision: 'rev-primer',
        repo,
        baseCommit: 'abc1234567',
        harness: 'codex',
        prompt: 'Warm up on the fixture.',
        acceptance: { spec: 'spec.json' },
      },
    } : {}),
    conditions: {
      provider: 'deepseek',
      model: 'deepseek-v4',
      harness: 'codex',
      toolsetDigest: 'toolset-digest',
      budgetDigest: 'budget-digest',
      evaluatorVersion: 'omc-acceptance-runner@1',
      environmentDigest: 'environment-digest',
      promptDigest: 'prompt-digest',
      cacheRegime: 'cold',
      executionStatus: 'ready',
      modelSelected: true,
      harnessSelected: true,
    },
    policyVersions: { single: 'policy-v1', 'multi-role': 'policy-v1' },
    optimizerCostUsd: { single: 0, 'multi-role': 0 },
  }
}

function documentFor(workspace, { group = 'E1', chains = false, prerequisite = false, receipt = 'receipts/run.json', prompt = 'Implement the task.' } = {}) {
  const repo = fixtureRepo(workspace)
  const document = {
    spec: experimentSpec(repo, { group, prompt, chains, prerequisite }),
    budget: { totalUsd: 4, perTrialUsd: 1 },
    concurrency: 1,
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'ready',
    inputs: {
      status: 'ready',
      modelSelection: 'selected',
      harnessSelection: 'selected',
      hostExecutor: 'host-tool',
      upstreamCheckouts: {},
      blockers: [],
    },
  }
  const manifestPath = join(workspace, `manifest-${String(receipt ?? 'run').replace(/[^A-Za-z0-9]+/g, '-')}.json`)
  writeFileSync(manifestPath, JSON.stringify(document, null, 2), 'utf8')
  return { document, manifestPath, repo, receiptPath: receipt ? join(workspace, receipt) : null }
}

function fakeGitCtx(repo, resolvedBase = 'abc1234567') {
  const calls = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const subprocess = {
    async resolveExecutable() { return 'C:/git/git.exe' },
    spawn(spec) {
      const args = spec.argv.slice(1)
      calls.push(args)
      let stdout = ''
      let exitCode = 0
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stdout = `${repo}\n`
      else if (args[0] === 'rev-parse') stdout = `${resolvedBase}\n`
      else if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[args.length - 2], { recursive: true })
        stdout = 'Preparing worktree\n'
      } else if (args[0] === 'status') stdout = ''
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
      }
    },
  }
  return { calls, ctx: { subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined) } }
}

function fakeJudge(order = []) {
  const seen = []
  return {
    seen,
    order,
    async baseline({ spec, workdir }) {
      order.push('baseline')
      seen.push({ phase: 'baseline', spec, workdir })
      return { fingerprint: 'synthetic-tree', acceptanceDigest: 'synthetic-acceptance', files: {}, acceptanceFiles: {}, at: new Date().toISOString() }
    },
    async run({ spec }) {
      order.push('verdict')
      seen.push({ phase: 'run', spec })
      return {
        passed: true,
        fingerprint: 'synthetic-tree',
        acceptanceDigest: 'synthetic-acceptance',
        checks: [{ name: 'ok', passed: true }],
        problems: [],
        at: new Date().toISOString(),
      }
    },
    verifyDelivered() { return { passed: true, problems: [] } },
  }
}

function serviceFixture(workspace, repo, { gitBase = 'abc1234567' } = {}) {
  const graph = createGraphStore()
  const executionStore = createExecutionStore({})
  const usageLedger = createUsageLedger({})
  const tasks = createTaskRegistry({})
  const managed = createManagedExecution({
    graph, mailbox: createMailbox({}), tasks, executionStore, usageLedger,
  })
  const git = fakeGitCtx(repo, gitBase)
  const dispatches = []
  const order = []
  const judge = fakeJudge(order)
  const seenExecutorDeps = []
  let executorFactoryCalls = 0
  let executePlanCalls = 0
  const rt = {
    ctx: git.ctx,
    cfg: resolveConfig({ transport: 'native' }),
    graph,
    managed,
    tasks,
    executionStore,
    usageLedger,
    requestGate: null,
  }
  const service = createTrialService(rt, {
    createHostExecutor: (deps) => {
      executorFactoryCalls += 1
      seenExecutorDeps.push(deps)
      return createHostExecutor(deps)
    },
    executePlan: async (options) => {
      executePlanCalls += 1
      const runnerModule = await import('../../scripts/strategy-runner.mjs')
      return runnerModule.executePlan(options)
    },
    executorDeps: {
      dispatch: (request, exec) => {
        order.push('dispatch')
        dispatches.push({ request, exec })
        return { results: [{ status: 'completed', harnessId: 'codex', output: 'synthetic ok', changedFiles: [] }] }
      },
      acceptanceRunner: judge,
    },
  })
  return {
    rt, service, git, dispatches, judge, seenExecutorDeps, order,
    counts: () => ({ executorFactoryCalls, executePlanCalls }),
  }
}

function execFor(workspace, id = 'parent-1') {
  return { agent: { id, session: { id: `s-${id}`, header: { cwd: workspace } } }, signal: new AbortController().signal }
}

/* ── real coharness tool: plan + refusal surface ─────────────────────────── */

function applyFixture(workspace) {
  const stateDir = mkdtempSync(join(tmpdir(), 'omc-pr07-state-'))
  const tools = new Map()
  const spawns = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      spawns.push(spec)
      return {
        collected: { stdout: read('ok\n'), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subprocess,
    on() { return () => {} },
    effect(fn) { return fn() },
    inject(_deps, fn) { fn(ctx) },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      if (name === 'subagents') return { list: () => [], registerProvider() { return () => {} } }
      return undefined
    },
  }
  apply(ctx, {
    transport: 'native',
    stateDir,
    sessions: { path: join(stateDir, 'sessions.json') },
    harnesses: Object.fromEntries(['codex', 'claude', 'glm', 'gemini', 'antigravity', 'kimi', 'opencode', 'qwen'].map((id) => [id, { enabled: false }])),
  })
  return { tools, spawns, stateDir }
}

test('PR-07: the real coharness trial action plans and refuses without writing', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-tool-'))
  const doc = documentFor(workspace)
  const fixture = applyFixture(workspace)
  const control = fixture.tools.get('coharness')
  const exec = execFor(workspace)

  const planned = JSON.parse((await control.execute({
    action: 'trial', trial_action: 'plan', trial_manifest: doc.manifestPath, max_usd: 1,
  }, exec)).text)
  assert.equal(planned.ok, true)
  assert.equal(planned.mode, 'plan')
  assert.equal(planned.executesAnything, false)
  assert.equal(planned.plan.assignmentCount, 2)
  assert.equal(existsSync(doc.receiptPath), false)

  const noConfirm = JSON.parse((await control.execute({
    action: 'trial', trial_action: 'execute', trial_manifest: doc.manifestPath, max_usd: 1,
    trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)).text)
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.code, 'OMC/TRIAL-NOT-CONFIRMED')

  mkdirSync(dirname(doc.receiptPath), { recursive: true })
  writeFileSync(doc.receiptPath, '{"keep":true}', 'utf8')
  const exists = JSON.parse((await control.execute({
    action: 'trial', trial_action: 'execute', trial_manifest: doc.manifestPath,
    confirm_paid_experiment: true, max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)).text)
  assert.equal(exists.ok, false)
  assert.equal(exists.code, 'OMC/TRIAL-RECEIPT-EXISTS')
  assert.equal(readFileSync(doc.receiptPath, 'utf8'), '{"keep":true}')
  assert.equal(fixture.spawns.length, 0, 'no refusal may spawn a CLI')
})

/* ── direct service: real executePlan + createHostExecutor wiring ────────── */

test('PR-07: a legitimate synthetic execute enters executePlan/createHostExecutor with identity and receipt', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-run-'))
  const doc = documentFor(workspace)
  const fixture = serviceFixture(workspace, doc.repo)
  const manifest = JSON.parse(readFileSync(doc.manifestPath, 'utf8'))
  const trialIds = createStrategyExperiment(manifest.spec).assignments.map((row) => row.trialId)
  const exec = execFor(workspace)
  const result = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)

  assert.equal(result.ok, true, JSON.stringify(result.problems ?? []))
  assert.equal(result.synthetic, true, 'a synthetic fixture is never presented as a real paid acceptance')
  assert.equal(result.receiptPath, doc.receiptPath)
  assert.ok(existsSync(doc.receiptPath))
  const receipt = JSON.parse(readFileSync(doc.receiptPath, 'utf8'))
  assert.equal(receipt.experimentId, 'synthetic-e1')
  assert.equal(receipt.trials.length, trialIds.length)
  assert.equal(receipt.unknownCostTrials, trialIds.length, 'no usage was reported: cost stays unknown, never 0')
  assert.equal(receipt.unknownCost, true)
  assert.equal(fixture.counts().executePlanCalls, 1, 'the real executePlan was entered')
  assert.equal(fixture.counts().executorFactoryCalls, 1, 'the real createHostExecutor was entered')
  // single = one writer step; multi-role = writer + read-only reviewer.
  assert.equal(fixture.dispatches.length, 3)
  assert.equal(fixture.dispatches.length, result.trials.length + 1)
  assert.equal(fixture.dispatches.filter((call) => call.request.writer === true).length, 2)
  assert.equal(fixture.dispatches.filter((call) => call.request.writer === false).length, 1)

  const first = fixture.dispatches[0]
  assert.equal(first.exec.agent.id, 'parent-1', 'the verified calling agent reaches the executor')
  assert.ok(trialIds.includes(first.request.taskId))
  assert.equal(first.request.ledgerTaskId, first.request.taskId, 'collector and ledger share the runtime task id')
  assert.match(first.request.nodeId, /^trial-/)
  assert.ok(first.request.cwd, 'the dispatch runs in the trial worktree')
  const baseline = fixture.judge.seen.find((row) => row.phase === 'baseline')
  assert.ok(baseline, 'the acceptance baseline was frozen before dispatch')
  assert.equal(baseline.spec.taskId, 'trial-task')
  assert.equal(fixture.judge.seen.filter((row) => row.phase === 'run').length, trialIds.length)
  assert.equal(fixture.order[0], 'baseline', 'the baseline is frozen before the first dispatch')
  assert.ok(fixture.order.indexOf('baseline') < fixture.order.indexOf('dispatch'))
  assert.equal(receipt.trials[0].sessionDecision?.rulesVersion, 1, Object.keys(receipt.trials[0]).join(','))
  assert.ok(['new-packet', 'restart', 'resume'].includes(receipt.trials[0].sessionDecision?.action))

  const plannedNode = fixture.rt.graph.status('parent-1').nodes.find((row) => row.id === first.request.nodeId)
  assert.ok(plannedNode, 'the planned trial node exists under the calling parent')
  const plannedNodes = fixture.rt.graph.status('parent-1').nodes
  const nodeIds = fixture.dispatches.map((call) => call.request.nodeId)
  assert.equal(new Set(nodeIds).size, nodeIds.length, 'every execution step has a unique graph node')
  assert.equal(nodeIds.length, 3)
  const writerNodes = fixture.dispatches.filter((call) => call.request.writer === true)
    .map((call) => plannedNodes.find((node) => node.id === call.request.nodeId))
  const reviewerNode = plannedNodes.find((node) => node.id === fixture.dispatches.find((call) => call.request.writer === false).request.nodeId)
  assert.ok(writerNodes.every((node) => node.write === true), 'writer nodes own the write scope')
  assert.equal(reviewerNode.write, false, 'reviewer nodes are read-only graph nodes')
  assert.equal(fixture.seenExecutorDeps[0].parentId, 'parent-1')
  assert.equal(fixture.seenExecutorDeps[0].callerAgent.id, 'parent-1')

  const before = fixture.dispatches.length
  const again = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'OMC/TRIAL-RECEIPT-EXISTS')
  assert.equal(fixture.dispatches.length, before)
})

test('PR-07: E2 prerequisite and ordered chain keep their existing semantics', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-e2-'))
  const doc = documentFor(workspace, { group: 'E2', chains: true, prerequisite: true, receipt: 'receipts/e2.json' })
  const fixture = serviceFixture(workspace, doc.repo)
  const exec = execFor(workspace)
  const result = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 2, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? []))
  assert.equal(result.trials.length, 2, 'one chain task x two arms')
  const receipt = JSON.parse(readFileSync(doc.receiptPath, 'utf8'))
  assert.equal(receipt.prerequisites.length, 2, 'one prerequisite run per arm, never counted as a trial')
  assert.equal(receipt.trials.length, 2)
  // Two prerequisite dispatches + two chain trials x two steps = six dispatches.
  assert.equal(fixture.dispatches.length, 6)
  assert.equal(fixture.judge.seen.filter((row) => row.phase === 'run').length, 4)
  const chainNodeIds = fixture.dispatches.map((call) => call.request.nodeId)
  assert.equal(new Set(chainNodeIds).size, chainNodeIds.length, 'chain steps own distinct graph nodes')
  const chainNodes = fixture.rt.graph.status('parent-1').nodes
  assert.equal(chainNodes.length, 6)
  assert.ok(chainNodes.filter((node) => node.write === true).every((node) => Array.isArray(node.deps) && node.deps.length <= 1))
  for (const call of fixture.dispatches) {
    assert.match(String(call.request.prompt ?? ''), /Inspect the failing case|Apply the minimal fix|Warm up/,
      'chain steps and the prerequisite keep their frozen prompt source')
  }
})

test('PR-07: execute refuses on confirmation/budget/receipt/blockers/selection/checkout/prompt', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-refusals-'))
  const fixture = serviceFixture(workspace, fixtureRepo(workspace))
  const exec = execFor(workspace)

  const cases = []
  const baseDoc = documentFor(workspace, { receipt: 'receipts/a.json' })
  cases.push({ code: 'OMC/TRIAL-NOT-CONFIRMED', args: {
    trial_action: 'execute', trial_manifest: baseDoc.manifestPath, max_usd: 1,
    trial_receipt: baseDoc.receiptPath, trial_repo: baseDoc.repo,
  } })
  cases.push({ code: 'OMC/TRIAL-BUDGET-CAPS', args: {
    trial_action: 'execute', trial_manifest: baseDoc.manifestPath, confirm_paid_experiment: true,
    trial_receipt: baseDoc.receiptPath, trial_repo: baseDoc.repo,
  } })
  cases.push({ code: 'OMC/TRIAL-RECEIPT', args: {
    trial_action: 'execute', trial_manifest: baseDoc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_repo: baseDoc.repo,
  } })

  const blocked = documentFor(workspace, { receipt: 'receipts/blocked.json' })
  const blockedDoc = JSON.parse(readFileSync(blocked.manifestPath, 'utf8'))
  blockedDoc.inputs.blockers = ['blocker']
  writeFileSync(blocked.manifestPath, JSON.stringify(blockedDoc), 'utf8')
  cases.push({ code: 'OMC/TRIAL-BLOCKED', args: {
    trial_action: 'execute', trial_manifest: blocked.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: blocked.receiptPath, trial_repo: blocked.repo,
  } })

  const selection = documentFor(workspace, { receipt: 'receipts/selection.json' })
  const selectionDoc = JSON.parse(readFileSync(selection.manifestPath, 'utf8'))
  selectionDoc.spec.conditions.model = 'placeholder-model-not-selected'
  selectionDoc.spec.conditions.modelSelected = false
  writeFileSync(selection.manifestPath, JSON.stringify(selectionDoc), 'utf8')
  cases.push({ code: 'OMC/TRIAL-SELECTION', args: {
    trial_action: 'execute', trial_manifest: selection.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: selection.receiptPath, trial_repo: selection.repo,
  } })

  const checkout = documentFor(workspace, { receipt: 'receipts/checkout.json' })
  const checkoutDoc = JSON.parse(readFileSync(checkout.manifestPath, 'utf8'))
  delete checkoutDoc.spec.tasks[0].repo
  writeFileSync(checkout.manifestPath, JSON.stringify(checkoutDoc), 'utf8')
  cases.push({ code: 'OMC/TRIAL-CHECKOUT', args: {
    trial_action: 'execute', trial_manifest: checkout.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: checkout.receiptPath, trial_repo: join(workspace, 'missing-checkout'),
  } })

  const prompt = documentFor(workspace, { receipt: 'receipts/prompt.json', prompt: '' })
  const promptDoc = JSON.parse(readFileSync(prompt.manifestPath, 'utf8'))
  delete promptDoc.spec.tasks[0].prompt
  writeFileSync(prompt.manifestPath, JSON.stringify(promptDoc), 'utf8')
  cases.push({ code: 'OMC/TRIAL-PROMPT', args: {
    trial_action: 'execute', trial_manifest: prompt.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: prompt.receiptPath, trial_repo: prompt.repo,
  } })

  for (const row of cases) {
    const result = await fixture.service(row.args, exec)
    assert.equal(result.ok, false, `${row.code} should be refused`)
    const codes = [result.code, ...(result.problems ?? [])].join(' ')
    assert.ok(codes.includes(row.code), `${row.code}: ${codes}`)
  }
  assert.equal(fixture.dispatches.length, 0, 'no refusal may dispatch a trial')
  assert.equal(fixture.counts().executePlanCalls, 0)
  assert.equal(fixture.counts().executorFactoryCalls, 0)
})

test('PR-07: no host context refuses, and the plain CLI still has no executor', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-nohost-'))
  const doc = documentFor(workspace)
  const service = createTrialService({
    ctx: null,
    cfg: resolveConfig({ transport: 'native' }),
    graph: createGraphStore(),
    managed: null,
    executionStore: createExecutionStore({}),
    usageLedger: createUsageLedger({}),
  })
  const refused = await service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, execFor(workspace))
  assert.equal(refused.ok, false)
  assert.ok((refused.problems ?? []).some((line) => /OMC\/TRIAL-NO-EXECUTOR/.test(line)))
  assert.equal(existsSync(doc.receiptPath), false)

  const cli = spawnSync(process.execPath, [join(root, 'scripts', 'strategy-runner.mjs'), '--manifest', doc.manifestPath, '--execute', '--max-usd', '1', '--confirm-paid-experiment'], {
    cwd: root, encoding: 'utf8',
  })
  assert.equal(cli.status, 2)
  assert.match(cli.stderr, /OMC\/TRIAL-NO-EXECUTOR/)
  assert.equal(existsSync(doc.receiptPath), false, 'a CLI refusal writes no receipt')
})

test('PR-07: a frozen baseCommit that does not resolve is refused before dispatch', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-base-'))
  const doc = documentFor(workspace)
  const fixture = serviceFixture(workspace, doc.repo, { gitBase: 'def7654321' })
  const exec = execFor(workspace)
  const result = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, exec)
  assert.equal(result.ok, false)
  assert.ok(String(result.code).includes('OMC/WORKTREE-BASECOMMIT'))
  assert.equal(fixture.dispatches.length, 0)
  assert.equal(existsSync(doc.receiptPath), false)
})

test('PR-07: provider ledger identity can be pinned to the collector task id', async () => {
  const tasks = createTaskRegistry({})
  const executionStore = createExecutionStore({})
  const ledger = createUsageLedger({})
  const specs = []
  const read = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const subprocess = {
    async resolveExecutable(bin) { return `C:\\fake\\${bin}.exe` },
    spawn(spec) {
      specs.push(spec)
      const stdout = [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-trial' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }),
      ].join('\n')
      return {
        collected: { stdout: read(stdout), stderr: read('') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    },
  }
  const provider = makeProvider({ subprocess, get: (name) => (name === 'subprocess' ? subprocess : undefined) }, harnessDef('codex'), resolveConfig({ transport: 'native' }), {
    readOnly: true, tasks, usageLedger: ledger, executionStore,
  })
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'Do the trial.' }],
    cwd: mkdtempSync(join(tmpdir(), 'omc-pr07-ledger-')),
    parent: { id: 'parent-1', session: { id: 's-1', header: {} } },
    ledgerTaskId: 'trial-42',
    signal: new AbortController().signal,
  })
  await run.result
  const pinned = ledger.entries({ parentId: 'parent-1', taskId: 'trial-42' })
  assert.equal(pinned.length, 1, 'the usage entry is booked under the collector task id')
  assert.equal(ledger.entries({ parentId: 'parent-1', taskId: run.id }).length, 0, 'the child run id is not the ledger task id')
  assert.equal(specs.length, 1)
})

test('PR-07: receipt and repo symlink/junction escapes are rejected by realpath', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-realpath-'))
  const outside = mkdtempSync(join(tmpdir(), 'omc-pr07-outside-'))
  mkdirSync(join(outside, 'repo'), { recursive: true })
  writeFileSync(join(outside, 'repo', 'spec.json'), JSON.stringify(acceptanceSpec(), null, 2), 'utf8')
  writeFileSync(join(outside, 'secret.json'), '{"outside":true}', 'utf8')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(outside, join(workspace, 'escape-dir'), linkType)
  symlinkSync(join(outside, 'repo'), join(workspace, 'escape-repo'), linkType)

  const doc = documentFor(workspace)
  const fixture = serviceFixture(workspace, doc.repo)
  const exec = execFor(workspace)

  // A NEW receipt whose nearest existing ancestor is a junction outside.
  const newEscape = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: join(workspace, 'escape-dir', 'new-receipt.json'), trial_repo: doc.repo,
  }, exec)
  assert.equal(newEscape.ok, false)
  assert.equal(newEscape.code, 'OMC/TRIAL-RECEIPT')
  assert.match((newEscape.problems ?? []).join(' '), /outside the workspace|symlink/i)
  assert.equal(existsSync(join(outside, 'new-receipt.json')), false)

  // An EXISTING file reached through the same escape is refused as an escape,
  // not silently accepted as an overwrite target.
  const existingEscape = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: join(workspace, 'escape-dir', 'secret.json'), trial_repo: doc.repo,
  }, exec)
  assert.equal(existingEscape.ok, false)
  assert.equal(existingEscape.code, 'OMC/TRIAL-RECEIPT')
  assert.match((existingEscape.problems ?? []).join(' '), /outside the workspace|symlink/i)
  assert.equal(readFileSync(join(outside, 'secret.json'), 'utf8'), '{"outside":true}')

  // A lexical-inside trial_repo that resolves outside is refused, so a symlink
  // cannot bypass the frozen baseCommit/checkout validation.
  const manifest = JSON.parse(readFileSync(doc.manifestPath, 'utf8'))
  delete manifest.spec.tasks[0].repo
  writeFileSync(doc.manifestPath, JSON.stringify(manifest), 'utf8')
  const repoEscape = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: join(workspace, 'escape-repo'),
  }, exec)
  assert.equal(repoEscape.ok, false)
  assert.equal(repoEscape.code, 'OMC/TRIAL-CHECKOUT')
  assert.match((repoEscape.problems ?? []).join(' '), /symlink|outside/i)
  assert.equal(fixture.dispatches.length, 0)
  assert.equal(existsSync(doc.receiptPath), false)
})

test('PR-07: smokeTrialIds executes exactly one frozen assignment, never the whole allocation', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omc-pr07-subset-'))
  const doc = documentFor(workspace, { receipt: 'receipts/subset.json' })
  const spec = JSON.parse(readFileSync(doc.manifestPath, 'utf8')).spec
  const single = createStrategyExperiment(spec).assignments.find((row) => row.strategy === 'single')
  assert.ok(single, 'the fixture freezes a single arm assignment')
  const parsed = JSON.parse(readFileSync(doc.manifestPath, 'utf8'))
  parsed.smokeTrialIds = [single.trialId]
  writeFileSync(doc.manifestPath, JSON.stringify(parsed), 'utf8')
  const fixture = serviceFixture(workspace, doc.repo)
  const result = await fixture.service({
    trial_action: 'execute', trial_manifest: doc.manifestPath, confirm_paid_experiment: true,
    max_usd: 1, trial_receipt: doc.receiptPath, trial_repo: doc.repo,
  }, execFor(workspace))
  assert.equal(result.ok, true, JSON.stringify(result.problems ?? []))
  assert.equal(result.partial, true)
  assert.deepEqual(result.onlyTrialIds, [single.trialId])
  assert.equal(result.trials.length, 1)
  assert.equal(fixture.dispatches.length, 1, 'the second arm is not dispatched')
  const receipt = JSON.parse(readFileSync(doc.receiptPath, 'utf8'))
  assert.equal(receipt.trials.length, 1)
  assert.equal(receipt.trials[0].trialId, single.trialId)
})
