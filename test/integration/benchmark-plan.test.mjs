/**
 * Real-fixture executable experiment manifests (0.8 / PR-07 + PR-08 inputs).
 *
 * test/benchmarks/MANIFEST.json registers 9 real graded fixtures (4 Latitude
 * JS, 2 sipratt Python, 3 OMC continuous) and test/benchmarks/plans/*
 * binds them to frozen checkouts, real native models and real acceptance
 * specs. This file proves:
 *
 *   E1 = 4 Latitude tasks x 3 native role arms   = 12 trials
 *   E2 = 3 OMC continuous tasks x 3 strategies   =  9 trials
 *        + 1 shared prerequisite per arm (NOT a trial)
 *   E3 = 2 sipratt tasks x 2 native role arms    =  4 trials
 *                                                = 25 trials
 *
 * It runs `scripts/strategy-runner.mjs --plan` and the exported
 * planExperiment() (deterministic, writes nothing, executes nothing), and
 * checks the executable inputs instead of trusting them:
 *   - frozen upstream/OMC repositories exist and contain the base commit;
 *   - the worktree check in each plan re-verifies every start/reference/
 *     acceptance/spec path at that commit (and frozen spec/grading sha256);
 *   - every prompt is a real string with a source file and a pinned digest
 *     (upstream prompt.md / upstream module literal / OMC turn prompt);
 *   - armExecution freezes real native roles: writer k3.1-pro, read-only
 *     reviewer (k3.1-pro for same-model, kimi-for-coding for different-model),
 *     and the E2 session arms run one writer per chain turn;
 *   - each acceptance spec resolves to a real JSON document whose command,
 *     acceptanceFiles and forbidChanges are the ones the plan froze.
 *
 * It also proves the paid-execute double gate still refuses and no receipt is
 * written. Nothing here executes a model.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSION_STRATEGIES, createStrategyExperiment } from '../../integration/strategy-eval.js'
import { validateAcceptanceSpec } from '../../integration/acceptance-runner.js'
import { planExperiment } from '../../scripts/strategy-runner.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BENCH = join(root, 'test', 'benchmarks')
const PLANS = join(BENCH, 'plans')
const RUNNER = join(root, 'scripts', 'strategy-runner.mjs')
const RECEIPT_DIR = join(root, 'docs', 'evidence', 'alpha.2', 'session-strategies')

const MANIFEST = JSON.parse(readFileSync(join(BENCH, 'MANIFEST.json'), 'utf8'))
const REGISTERED = [...MANIFEST.tasks, ...(MANIFEST.prerequisites ?? [])]
const REGISTERED_BY_ID = new Map(REGISTERED.map((row) => [row.taskId, row]))
const REVISION = (row) => `fixture@${row.specSha256.slice(0, 16)}`

const GROUPS = ['E1', 'E2', 'E3']
const PLAN_FILES = { E1: join(PLANS, 'e1.json'), E2: join(PLANS, 'e2.json'), E3: join(PLANS, 'e3.json') }
const EXPECTED = {
  E1: { trials: 12, tasks: 4, arms: ['single', 'same-model-multi-role', 'different-model-multi-role'], repo: 'E1', base: 'cd28f3965d4d9d2fc9a49faca573f16b5102b488' },
  E2: { trials: 9, tasks: 3, arms: [...SESSION_STRATEGIES], repo: 'E2', base: '66de9dfa466d2a4f33d80fdc7051d87e6ded4ab9' },
  E3: { trials: 4, tasks: 2, arms: ['single', 'multi-role'], repo: 'E3', base: '3e9bca9b78790c0d537a505a4f5850e4c7cb35d8' },
}
const PREREQUISITE_ID = 'omc-session-primer'
const rootReal = realpathSync(root)
// Plans must be portable: repositories are workspace-relative and resolved by
// the trial service against the workspace, never absolute machine paths.
const REPOS = {
  E1: '.ops/benchmark-repos/latitude-dev--coding-agent-benchmark',
  E2: '.',
  E3: '.ops/benchmark-repos/sipratt-p--coding-agent-bench',
}
const repoAbs = (rel) => (rel === '.' ? root : join(root, ...rel.split('/')))
const WRITER = { provider: 'kimi-coding', model: 'k3.1-pro' }
const REVIEWER = { provider: 'kimi-coding', model: 'kimi-for-coding' }
const EXPECTED_ROLES = {
  E1: {
    single: [['writer', true, WRITER.model]],
    'same-model-multi-role': [['writer', true, WRITER.model], ['reviewer', false, WRITER.model]],
    'different-model-multi-role': [['writer', true, WRITER.model], ['reviewer', false, REVIEWER.model]],
  },
  E2: {
    reuse_compact: [['writer', true, WRITER.model]],
    fresh_handoff: [['writer', true, WRITER.model]],
    adaptive: [['writer', true, WRITER.model]],
  },
  E3: {
    single: [['writer', true, WRITER.model]],
    'multi-role': [['writer', true, WRITER.model], ['reviewer', false, REVIEWER.model]],
  },
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readText = (path) => readFileSync(path, 'utf8')
const planFile = (group) => readJson(PLAN_FILES[group])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}
const stableDigest = (value) => sha256(JSON.stringify(stable(value)))
const posix = (value) => value.split('\\').join('/')

function git(cwd, args, encoding = 'utf8') {
  return spawnSync('git', ['-C', cwd, ...args], { encoding, maxBuffer: 16 * 1024 * 1024 })
}
const commitHas = (repo, commit, path) => git(repo, ['cat-file', '-e', `${commit}:${path}`]).status === 0
const commitSha256 = (repo, commit, path) => {
  const result = git(repo, ['show', `${commit}:${path}`], null)
  return result.status === 0 ? sha256(result.stdout) : null
}
/**
 * A frozen base commit is an immutable object that must still exist in the
 * repository and contain the frozen files. The checkout's current HEAD is
 * allowed to advance past it: later commits must not invalidate a plan.
 */
function assertFrozenCommit(repo, commit) {
  assert.equal(
    String(git(repo, ['cat-file', '-t', commit]).stdout).trim(),
    'commit',
    `${repo}: ${commit} is not a commit object (CI needs a full-history clone / fetch-depth: 0, and E1/E3 need prepareFrozenCheckout)`,
  )
  assert.equal(String(git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).stdout).trim(), commit.toLowerCase(), `${repo}: ${commit} does not resolve to itself`)
}

/** A plan path must be workspace-relative: no drive, no leading slash, no `..`. */
function assertPortablePath(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.length > 0, `${label} must not be empty`)
  assert.ok(!isAbsolute(value), `${label} must be workspace-relative, not absolute: ${value}`)
  assert.ok(!/^[A-Za-z]:/.test(value), `${label} must not carry a Windows drive: ${value}`)
  assert.ok(!value.includes('\\'), `${label} must use forward slashes: ${value}`)
  assert.ok(!value.split('/').includes('..'), `${label} must not climb out with ..: ${value}`)
  return value
}
function workspacePath(value, label) {
  assertPortablePath(value, label)
  return resolve(root, value)
}
/** The resolved path (realpath) must stay inside the workspace. */
function assertInsideWorkspace(value, label) {
  const abs = workspacePath(value, label)
  if (!existsSync(abs)) return abs
  const real = realpathSync(abs)
  assert.ok(real === rootReal || real.startsWith(`${rootReal}${sep}`), `${label} escapes the workspace: ${value} -> ${real}`)
  return real
}
/** True when the frozen upstream checkout needed for git-object checks exists. */
function checkoutAvailable(group) {
  if (group === 'E2') return true
  const abs = repoAbs(REPOS[group])
  return existsSync(abs) && git(abs, ['rev-parse', '--git-dir']).status === 0
}

function extractLiteral(source, marker, token) {
  const from = source.indexOf(marker)
  if (from < 0) return null
  const start = source.indexOf(token, from)
  if (start < 0) return null
  const bodyStart = start + token.length
  const end = source.indexOf('"""', bodyStart)
  return end < 0 ? null : source.slice(bodyStart, end)
}

function cli(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, encoding: 'utf8' })
}
function receiptFiles() {
  if (!existsSync(RECEIPT_DIR)) return []
  return readdirSync(RECEIPT_DIR).sort()
}

/** Every plan document, re-run through the CLI once and cached. */
const CLI = new Map()
for (const group of GROUPS) {
  const run = cli(['--manifest', PLAN_FILES[group], '--plan'])
  assert.equal(run.status, 0, `${group}: --plan must exit 0 (stderr: ${run.stderr})`)
  assert.equal(run.stderr.trim(), '', `${group}: --plan must not print warnings/errors`)
  CLI.set(group, JSON.parse(run.stdout))
}

test('the three plans freeze 12 + 9 + 4 = 25 real trials in ready, not-executed state', () => {
  let total = 0
  const trialIds = new Set()
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    const document = planFile(group)
    const expected = EXPECTED[group]
    assert.equal(plan.mode, 'plan')
    assert.equal(plan.executesAnything, false, `${group}: a plan must never execute anything`)
    assert.equal(plan.experimentGroup, group)
    assert.equal(plan.manifest.experimentGroup, group)
    assert.equal(plan.assignmentCount, expected.trials, `${group}: expected ${expected.trials} trials`)
    assert.equal(plan.taskCount, expected.tasks, `${group}: expected ${expected.tasks} real tasks`)
    assert.equal(plan.manifest.repeats, 1, `${group}: the pilot freezes repeats=1`)
    assert.equal(plan.trials.length, expected.trials)
    assert.deepEqual(plan.arms, expected.arms, `${group}: unexpected arms`)
    assert.deepEqual(plan.problems, [], `${group}: the frozen allocation must verify`)
    assert.deepEqual(plan.warnings, [], `${group}: budget/concurrency/deadline must be frozen`)
    assert.equal(document.status, 'ready', `${group}: inputs are complete`)
    assert.equal(document.executionStatus, 'not-executed', `${group}: nothing has run`)
    assert.equal(document.inputs.status, 'ready')
    assert.equal(document.inputs.executionStatus, 'not-executed')
    assert.equal(document.inputs.modelSelection, 'selected')
    assert.equal(document.inputs.harnessSelection, 'selected')
    assert.equal(document.inputs.hostExecutor, 'host-tool')
    assert.deepEqual(document.inputs.blockers, [], `${group}: no blocker remains`)
    assert.equal('smokeTrialIds' in document, false, `${group}: a full plan must not carry a smoke subset`)
    assert.deepEqual(document.budget, { totalUsd: group === 'E3' ? 8 : 12, perTrialUsd: 2 })
    assert.equal(document.concurrency, 1)
    assert.ok(Number.isFinite(Date.parse(document.deadline)))

    for (const trial of plan.trials) {
      assert.ok(!trialIds.has(trial.trialId), `duplicate trialId ${trial.trialId} across plans`)
      trialIds.add(trial.trialId)
      assert.equal(trial.group, group)
      assert.ok(expected.arms.includes(trial.arm))
      assert.equal(trial.strategy, trial.arm)
      assert.equal(trial.repeat, 0)
    }
    total += plan.assignmentCount
  }
  assert.equal(total, 25)
  assert.equal(trialIds.size, 25)
  assert.equal(MANIFEST.tasks.length, 9, 'the plans must be built on the 9 registered real fixtures')
})

test('each plan is deterministic, matches the exported API and freezes conditions', () => {
  for (const group of GROUPS) {
    const document = planFile(group)
    const first = CLI.get(group)
    const second = cli(['--manifest', PLAN_FILES[group], '--plan'])
    assert.equal(second.status, 0)
    assert.equal(second.stdout, cli(['--manifest', PLAN_FILES[group], '--plan']).stdout, `${group}: two --plan runs must print identical bytes`)

    const regenerated = createStrategyExperiment(document.manifest)
    assert.equal(regenerated.digest, document.manifest.digest, `${group}: the frozen manifest digest does not reproduce`)
    assert.deepEqual(regenerated.assignments, document.manifest.assignments, `${group}: assignments are not reproducible`)
    assert.deepEqual(first, planExperiment({ document }), `${group}: CLI plan diverged from planExperiment()`)

    const conditions = first.manifest.conditions
    assert.equal(conditions.provider, WRITER.provider)
    assert.equal(conditions.model, WRITER.model)
    assert.equal(conditions.reviewerProvider, REVIEWER.provider)
    assert.equal(conditions.reviewerModel, REVIEWER.model)
    assert.equal(conditions.harness, 'native')
    assert.equal(conditions.modelSelected, true)
    assert.equal(conditions.harnessSelected, true)
    assert.equal(conditions.executionStatus, 'not-executed')
    for (const key of ['provider', 'model', 'harness']) assert.doesNotMatch(conditions[key], /^placeholder-/, `${group}: ${key} is still a placeholder`)
  }
})

test('repositories, base commits and worktree checks are real and portable', (t) => {
  for (const group of GROUPS) {
    const expected = EXPECTED[group]
    const plan = CLI.get(group)
    const check = planFile(group).inputs.worktreeCheck
    assertPortablePath(check.repo, `${group}.worktreeCheck.repo`)
    assert.equal(check.repo, REPOS[group], `${group}: repo must be the workspace-relative checkout`)
    assertPortablePath(planFile(group).inputs.upstreamCheckouts[Object.keys(planFile(group).inputs.upstreamCheckouts)[0]].localPath, `${group}.upstreamCheckouts.localPath`)
    assert.equal(check.checked, true, `${group}: the worktree base must be verified, not assumed`)
    assert.equal(check.baseCommit, expected.base, `${group}: the plan must not chase a newer commit`)
    assert.deepEqual(check.missing, [], `${group}: every required path must exist at the base commit`)
    assert.ok(check.verifiedPaths.length > 0)

    const repo = repoAbs(REPOS[group])
    const available = checkoutAvailable(group)
    if (!available) {
      // CI has no `.ops` upstream checkout. Only machine-specific git-object
      // verification is skipped; the portable plan checks below still run.
      t.diagnostic(`${group}: frozen checkout ${REPOS[group]} is not available; git-object path/digest checks skipped (prepareFrozenCheckout is required before --execute)`)
    } else {
      assert.ok(String(git(repo, ['rev-parse', 'HEAD']).stdout).trim(), `${group}: checkout has no HEAD`)
      // The base commit is immutable evidence, not "whatever HEAD is today".
      assertFrozenCommit(repo, expected.base)
      for (const row of check.verifiedPaths) {
        assert.ok(commitHas(repo, expected.base, row.path), `${group}: ${row.path} is not in the frozen commit`)
      }
      if (group === 'E2') {
        assert.ok(check.digestChecks.length >= 8, 'E2 must also check the frozen spec/grading digests')
        for (const row of check.digestChecks) {
          assert.equal(row.expected, row.actual, `${group}/${row.taskId}: committed ${row.kind} differs from the frozen digest`)
          assert.equal(commitSha256(repo, expected.base, row.path), row.expected, `${group}/${row.taskId}: committed ${row.path} drifted`)
        }
      }
    }

    for (const task of plan.tasks) {
      assert.equal(task.repo, REPOS[group], `${group}/${task.id}: wrong repo`)
      assert.equal(task.baseCommit, expected.base, `${group}/${task.id}: wrong baseCommit`)
      assert.equal(task.harness, 'native')
      assertPortablePath(task.repo, `${group}/${task.id}.repo`)
      const trial = plan.trials.find((row) => row.taskId === task.id)
      assert.ok(trial, `${group}/${task.id}: no assignment`)
      assert.equal(trial.baseCommit, expected.base)
      assert.equal(trial.repo, REPOS[group])
      assert.equal(trial.provenance.executionBaseCommit, expected.base)
      assert.equal(trial.provenance.repo, REPOS[group])
      const spec = readJson(join(root, REGISTERED_BY_ID.get(task.id).specPath))
      assert.equal(trial.provenance.baseCommit, spec.provenance.baseCommit)

      if (!available) continue
      // The committed bytes, not just object existence, must match the frozen
      // digest of the grading artifact.
      if (group === 'E1') {
        assert.equal(
          commitSha256(repo, expected.base, task.acceptance.acceptanceFiles[0]),
          spec.provenance.grading.sha256,
          `${task.id}: committed upstream test differs from the frozen grading digest`,
        )
      }
      if (group === 'E3') {
        assert.equal(
          commitSha256(repo, expected.base, task.promptMeta.source.upstreamModule),
          task.promptMeta.source.moduleSha256,
          `${task.id}: committed upstream module differs from the frozen prompt module`,
        )
      }
    }
  }
})

test('every acceptance spec is a portable frozen document and its files resolve', (t) => {
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    const repoRel = REPOS[group]
    const repo = repoAbs(repoRel)
    const base = EXPECTED[group].base
    const available = checkoutAvailable(group)
    const datasetDigests = MANIFEST.datasets[group === 'E1' ? 'latitude-dev/coding-agent-benchmark' : group === 'E3' ? 'sipratt-p/coding-agent-bench' : 'omc-authored'].upstreamDigests ?? {}
    if (!available) t.diagnostic(`${group}: acceptance files are checked against the frozen commit only when ${repoRel} exists; vendored bytes are checked unconditionally`)

    for (const task of plan.tasks) {
      const specRel = task.acceptance.spec
      assertPortablePath(specRel, `${group}/${task.id}: acceptance.spec`)
      assert.ok(!isAbsolute(specRel), `${group}/${task.id}: acceptance.spec must not be absolute`)
      const specPath = assertInsideWorkspace(specRel, `${group}/${task.id}: acceptance.spec`)
      assert.ok(existsSync(specPath), `${group}/${task.id}: acceptance spec is missing: ${specRel}`)
      assert.equal(sha256(readText(specPath)), task.acceptance.specSha256, `${group}/${task.id}: acceptance spec digest drifted`)

      const spec = readJson(specPath)
      validateAcceptanceSpec(spec)
      assert.equal(spec.taskId, task.id)
      assert.equal(spec.split, 'development')
      assert.deepEqual(spec.commands[0].run, task.acceptance.command, `${group}/${task.id}: command drifted`)
      assert.deepEqual(spec.acceptanceFiles, task.acceptance.acceptanceFiles, `${group}/${task.id}: acceptanceFiles drifted`)
      assert.deepEqual(spec.forbidChanges, task.acceptance.forbidChanges, `${group}/${task.id}: forbidChanges drifted`)
      assert.ok(spec.acceptanceFiles.length > 0, `${group}/${task.id}: nothing protects the grading files`)

      // Command arguments are either workspace-relative (wrappers resolved by
      // the trial service) or worktree-relative upstream paths. No absolute
      // machine path may sneak back into a plan or its acceptance document.
      for (const arg of task.acceptance.command) {
        assert.ok(!isAbsolute(arg), `${group}/${task.id}: command argument must not be absolute: ${arg}`)
        assert.ok(!/^[A-Za-z]:/.test(arg), `${group}/${task.id}: command argument must not carry a drive: ${arg}`)
      }
      for (const arg of task.acceptance.command.filter((value) => /[\\/]|\.(mjs|js|py|json)$/.test(value))) {
        const isExecutable = arg === spec.commands[0].run[0]
        if (isExecutable) continue
        const fromWorkspace = resolve(root, arg)
        if (existsSync(fromWorkspace)) {
          assertInsideWorkspace(arg, `${group}/${task.id}: command argument`)
          continue
        }
        if (!available) continue // worktree path verification needs the checkout
        assert.ok(commitHas(repo, base, arg), `${group}/${task.id}: command argument not found in workspace or at ${base}: ${arg}`)
      }

      for (const file of [...spec.acceptanceFiles, task.workspace.referencePath].filter((path) => path !== '.')) {
        assertPortablePath(file, `${group}/${task.id}: acceptance file`)
        // Always verify vendored bytes where a vendored counterpart exists.
        const vendored = datasetDigests[file]
        if (vendored) {
          const local = join(root, vendored.localPath)
          assert.ok(existsSync(local), `${group}/${task.id}: vendored copy of ${file} is missing`)
          assert.equal(sha256(readText(local)), vendored.sha256, `${group}/${task.id}: vendored bytes of ${file} drifted`)
        }
        if (available) assert.ok(commitHas(repo, base, file), `${group}/${task.id}: ${file} is missing at ${base}`)
      }
      if (task.workspace.startPath !== '.') {
        assertPortablePath(task.workspace.startPath, `${group}/${task.id}: startPath`)
        if (available) assert.ok(commitHas(repo, base, task.workspace.startPath), `${group}/${task.id}: start workspace is missing at ${base}`)
      }
      assert.ok(task.workspace.writeScope.length > 0)
      assert.ok(task.acceptance.gradingSha256, `${group}/${task.id}: the fixture grading digest must stay pinned`)
    }
  }
})

test('every prompt is a real, sourced, digested instruction', () => {
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    for (const task of plan.tasks) {
      assert.equal(typeof task.prompt, 'string', `${group}/${task.id}: prompt must be a string`)
      assert.ok(task.prompt.trim().length > 0)
      assert.equal(task.promptMeta.sha256, sha256(task.prompt), `${group}/${task.id}: prompt digest does not match its text`)
      const sourcePath = assertInsideWorkspace(task.promptMeta.source.path, `${group}/${task.id}: prompt source`)
      assert.ok(existsSync(sourcePath), `${group}/${task.id}: prompt source is missing`)

      if (group === 'E1') {
        assert.equal(task.promptMeta.source.kind, 'upstream-prompt-md')
        const upstream = readText(sourcePath)
        assert.equal(task.promptMeta.source.upstreamSha256, sha256(upstream), `${task.id}: upstream prompt digest drifted`)
        assert.ok(task.prompt.startsWith(upstream.replace(/\s+$/, '')), `${task.id}: the task statement must be the upstream prompt`)
        assert.match(task.prompt, new RegExp(`tasks/${REGISTERED_BY_ID.get(task.id).taskId.replace('upstream-latitude-', '')}/workspace`))
      } else if (group === 'E3') {
        assert.equal(task.promptMeta.source.kind, 'upstream-module-literal')
        const literalPath = assertInsideWorkspace(task.promptMeta.source.path, `${task.id}: prompt source`)
        const literal = readText(literalPath)
        assert.equal(task.promptMeta.source.upstreamSha256, sha256(literal))
        const dataset = MANIFEST.datasets[task.provenance.dataset]
        const module = readText(join(root, dataset.vendoredAt, task.promptMeta.source.upstreamModule))
        assert.equal(sha256(module), task.promptMeta.source.moduleSha256, `${task.id}: upstream module changed`)
        const constName = String(task.promptMeta.source.anchor).replace(/\[.*$/, '')
        assert.equal(extractLiteral(module, `${constName} = {`, '"prompt": """'), literal, `${task.id}: prompt.md is not the upstream literal`)
        assert.ok(task.prompt.startsWith(literal.replace(/\s+$/, '')), `${task.id}: the task statement must be the upstream prompt`)
        assert.match(task.prompt, /solution\.py/)
      } else {
        assert.equal(task.promptMeta.source.kind, 'omc-authored')
        assert.equal(task.prompt, readText(sourcePath), `${task.id}: E2 prompt must equal its frozen file`)
        assert.equal(task.kind, 'chain')
        assert.ok(Array.isArray(task.chain) && task.chain.length >= 2)
        const spec = readJson(join(root, REGISTERED_BY_ID.get(task.id).specPath))
        assert.deepEqual(task.chain.map((step) => step.id), spec.chain.map((step) => step.id), `${task.id}: chain order drifted`)
        for (const step of task.chain) {
          assert.equal(step.goal, step.prompt, `${task.id}/${step.id}: the executed goal must be the full turn prompt`)
          assert.equal(step.promptMeta.sha256, sha256(step.prompt))
          const stepSource = assertInsideWorkspace(step.promptMeta.source.path, `${task.id}/${step.id}: turn prompt source`)
          assert.equal(step.prompt, readText(stepSource), `${task.id}/${step.id}: turn prompt drifted`)
          assert.match(step.prompt, /acceptance\/check\.mjs/)
        }
        assert.deepEqual(task.chain[0].promptMeta, task.promptMeta)
      }
    }

    const facts = [...plan.tasks, ...(plan.prerequisite ? [plan.prerequisite] : [])].map((task) => ({
      taskId: task.id,
      prompt: task.promptMeta.sha256,
      chain: (task.chain ?? []).map((step) => step.promptMeta.sha256),
    }))
    assert.equal(plan.manifest.conditions.promptDigest, stableDigest(facts), `${group}: promptDigest drifted`)
  }
  const e2 = CLI.get('E2')
  assert.equal(typeof e2.prerequisite.prompt, 'string')
  assert.equal(e2.prerequisite.promptMeta.sha256, sha256(e2.prerequisite.prompt))
  const primerSource = assertInsideWorkspace(e2.prerequisite.promptMeta.source.path, 'E2 prerequisite prompt source')
  assert.equal(e2.prerequisite.prompt, readText(primerSource))
})

test('armExecution freezes the real native single / multi-role semantics', () => {
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    // --plan prints the allocation, not armExecution; the frozen document is
    // the source of truth for the role surfaces.
    const document = planFile(group)
    const execution = document.execution?.armExecution
    assert.ok(execution, `${group}: execution.armExecution must be explicit`)
    const frozenExecution = document.manifest.armExecution
    assert.ok(frozenExecution, `${group}: manifest.armExecution must be frozen`)
    assert.deepEqual(Object.keys(execution).sort(), [...EXPECTED[group].arms].sort())
    for (const arm of EXPECTED[group].arms) {
      assert.deepEqual(
        frozenExecution[arm].roles.map((role) => [role.id, role.writer, role.model]),
        EXPECTED_ROLES[group][arm],
        `${group}/${arm}: wrong frozen roles`,
      )
      const roles = execution[arm].roles
      assert.equal(roles.length, EXPECTED_ROLES[group][arm].length, `${group}/${arm}: wrong role count`)
      assert.deepEqual(
        roles.map((role) => [role.id, role.writer, role.model]),
        EXPECTED_ROLES[group][arm],
        `${group}/${arm}: wrong roles`,
      )
      for (const role of roles) {
        assert.equal(role.surface, 'native', `${group}/${arm}/${role.id}: surface must be native`)
        assert.equal(role.provider, WRITER.provider)
        if (role.writer === true) {
          assert.equal(role.id, 'writer')
          assert.equal(role.readOnly, undefined, 'a writer must not be marked read-only')
        } else {
          assert.equal(role.id, 'reviewer')
          assert.equal(role.readOnly, true, 'the reviewer must be explicitly read-only')
          assert.equal(role.writer, false)
        }
      }
      const writers = roles.filter((role) => role.writer === true)
      assert.equal(writers.length, 1, `${group}/${arm}: exactly one writer`)
      if (arm !== 'single' && group !== 'E2') {
        assert.equal(roles[1].model, arm === 'different-model-multi-role' || group === 'E3' ? REVIEWER.model : WRITER.model)
      }
    }
  }
  // E2 chain trials always run the writer per turn, never a reviewer step.
  const e2 = CLI.get('E2')
  for (const task of e2.tasks) assert.equal(task.chain.length, 2)
})

test('E2 freezes the shared prerequisite and ordered chains without counting them as trials', () => {
  const plan = CLI.get('E2')
  assert.ok(plan.prerequisite, 'E2 must declare its shared prerequisite')
  assert.equal(plan.prerequisite.id, PREREQUISITE_ID)
  assert.equal(plan.prerequisite.countedAsTrial, false)
  assert.equal(plan.prerequisite.repo, REPOS.E2)
  assert.equal(plan.prerequisite.baseCommit, EXPECTED.E2.base)
  assert.equal(plan.prerequisite.revision, REVISION(REGISTERED_BY_ID.get(PREREQUISITE_ID)))

  assert.equal(plan.prerequisites.length, plan.arms.length, 'one prerequisite run per arm')
  assert.deepEqual(plan.prerequisites.map((row) => row.arm).sort(), [...plan.arms].sort())
  for (const row of plan.prerequisites) {
    assert.equal(row.taskId, PREREQUISITE_ID)
    assert.equal(row.countedAsTrial, false)
    assert.equal(row.baseCommit, EXPECTED.E2.base)
  }
  assert.equal(plan.trials.some((trial) => trial.taskId === PREREQUISITE_ID), false, 'the prerequisite must not be a trial')
  assert.equal(plan.assignmentCount, 9)
  assert.equal(plan.assignmentCount + plan.prerequisites.length, 12, '9 trials + 3 arm-level prerequisite runs')
})

test('plans carry no machine-specific absolute paths (CI-portable)', () => {
  const driveAbsolute = /(?:^|["'\s])[A-Za-z]:[\\/]/m
  for (const group of GROUPS) {
    const raw = readText(PLAN_FILES[group])
    assert.doesNotMatch(raw, driveAbsolute, `${group}: a Windows drive path leaked into the plan`)
    assert.doesNotMatch(raw, /Calculations/, `${group}: a machine-specific workspace path leaked into the plan`)

    for (const task of CLI.get(group).tasks) {
      assertPortablePath(task.repo, `${group}/${task.id}.repo`)
      assertPortablePath(task.acceptance.spec, `${group}/${task.id}.acceptance.spec`)
      assertPortablePath(task.workspace.startPath, `${group}/${task.id}.workspace.startPath`)
      assertPortablePath(task.workspace.referencePath, `${group}/${task.id}.workspace.referencePath`)
      assertPortablePath(task.promptMeta.source.path, `${group}/${task.id}.promptMeta.source.path`)
      for (const arg of task.acceptance.command) {
        assert.ok(!isAbsolute(arg), `${group}/${task.id}: command argument must not be absolute: ${arg}`)
        assert.ok(!/^[A-Za-z]:/.test(arg), `${group}/${task.id}: command argument must not carry a drive: ${arg}`)
      }

      // Paths that live in this checkout must resolve inside it after realpath.
      assertInsideWorkspace(task.acceptance.spec, `${group}/${task.id}.acceptance.spec`)
      assertInsideWorkspace(task.promptMeta.source.path, `${group}/${task.id}.promptMeta.source.path`)
      if (existsSync(repoAbs(task.repo))) assertInsideWorkspace(task.repo, `${group}/${task.id}.repo`)
      if (group === 'E2') {
        assertInsideWorkspace(task.workspace.startPath, `${group}/${task.id}.workspace.startPath`)
        assertInsideWorkspace(task.workspace.referencePath, `${group}/${task.id}.workspace.referencePath`)
      }
    }
    const document = planFile(group)
    assertPortablePath(document.inputs.worktreeCheck.repo, `${group}.inputs.worktreeCheck.repo`)
    for (const [id, entry] of Object.entries(document.inputs.upstreamCheckouts)) {
      assertPortablePath(entry.localPath, `${group}.inputs.upstreamCheckouts.${id}.localPath`)
    }
  }
})

test('the plans stay not-executed and execute remains gated behind both paid flags plus a host', () => {
  const before = receiptFiles()
  for (const group of GROUPS) {
    const plan = CLI.get(group)
    assert.equal(plan.executesAnything, false)
    for (const key of ['provider', 'model', 'harness']) assert.doesNotMatch(plan.manifest.conditions[key], /placeholder/)

    const noGate = cli(['--manifest', PLAN_FILES[group], '--execute'])
    assert.equal(noGate.status, 2, `${group}: --execute without its gates must be refused`)
    assert.match(noGate.stderr, /OMC\/TRIAL-NOT-CONFIRMED/)
    assert.match(noGate.stderr, /--max-usd/)

    const confirmed = cli(['--manifest', PLAN_FILES[group], '--execute', '--max-usd', '1', '--confirm-paid-experiment'])
    assert.equal(confirmed.status, 2, `${group}: --execute must refuse without a host executor`)
    assert.match(confirmed.stderr, /OMC\/TRIAL-NO-EXECUTOR/)

    const both = cli(['--manifest', PLAN_FILES[group], '--plan', '--execute'])
    assert.equal(both.status, 2)
    assert.match(both.stderr, /mutually exclusive/)
  }
  assert.deepEqual(receiptFiles(), before, 'a plan/refused execute must not write a receipt')
  assert.equal(existsSync(RECEIPT_DIR), false, 'a plan/refused execute must not create the receipt directory')
})

test('every planned task maps back to exactly one registered fixture', () => {
  const planned = GROUPS.flatMap((group) => CLI.get(group).tasks.map((task) => task.id)).sort()
  assert.deepEqual(planned, MANIFEST.tasks.map((task) => task.taskId).sort(), 'the plans must cover exactly the 9 registered tasks once')
  for (const group of GROUPS) {
    for (const task of CLI.get(group).tasks) {
      const registered = REGISTERED_BY_ID.get(task.id)
      assert.ok(registered, `${group}/${task.id}: not registered`)
      assert.equal(task.revision, REVISION(registered))
      assert.equal(task.provenance.spec, registered.specPath)
      assert.equal(task.provenance.specSha256, registered.specSha256)
      assert.equal(task.provenance.license.spdx, 'MIT')
      assert.ok(existsSync(join(root, task.provenance.license.path)))
      assert.deepEqual(task.provenance.quarantined, registered.quarantined)
    }
  }
})
