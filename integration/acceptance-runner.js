/**
 * R07 independent acceptance runner: a verdict the executing agent cannot
 * rewrite.
 *
 * A worker can add tests (that is useful), but it must not be able to move its
 * own finish line. This module therefore:
 *
 *   1. runs FIXED external checks (argv + expected exit code / stdout
 *      assertions) chosen before the work started, without a model in the
 *      loop;
 *   2. digests the acceptance definition (`acceptanceFiles`) BEFORE and AFTER
 *      the checks and fails with OMC/ACCEPTANCE-TAMPERED when a worker edited
 *      its own grading between the two digests;
 *   3. fingerprints the delivered tree with `work-packet.js#treeFingerprint`
 *      (reused, never reimplemented) so two deliveries can be compared, and
 *      checks `forbidChanges` against a baseline the caller froze first;
 *   4. places whole problem families into development / validation / holdout
 *      deterministically, so reworded variants of one problem never leak
 *      across splits.
 *
 * Honest limits:
 *   - this runner proves BEHAVIOUR (exit codes and text we declared in
 *     advance), nothing more. It is not a quality rubric and a model grader is
 *     not the sole truth; subjective quality still needs a human-calibrated
 *     rubric plus blind review;
 *   - it cannot prove the worker did not run something else earlier, and it
 *     cannot detect a worker that only edits files the spec never mentions;
 *   - when `acceptanceFiles` is empty nothing is protected, and the verdict
 *     says so in `warnings` instead of pretending;
 *   - text assertions read STDOUT only (that is the field name); stderr is
 *     kept for diagnosis and never satisfies an assertion;
 *   - a timeout terminates only the child this runner started (needed so CI
 *     cannot hang) and is reported as a failed check, never as a pass;
 *   - `env` is inherited from the parent process plus the caller's overrides;
 *     the runner never fabricates a shell environment.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { treeFingerprint } from './work-packet.js'

export const ACCEPTANCE_RUNNER_VERSION = 1
export const TASK_SPLITS = Object.freeze(['development', 'validation', 'holdout'])

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ops'])
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024
const MAX_TAIL_CHARS = 4000
const DEFAULT_WEIGHTS = Object.freeze({ development: 0.6, validation: 0.2, holdout: 0.2 })

function runnerError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readDigest(file) {
  try {
    return sha256(readFileSync(file))
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function tail(text, limit = MAX_TAIL_CHARS) {
  const value = typeof text === 'string' ? text : ''
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

/** Workspace-relative path, forward slashes, no escaping the workdir. */
function normalizeRef(ref, label) {
  if (typeof ref !== 'string' || !ref.trim()) throw runnerError('OMC/ACCEPTANCE-SPEC', `${label} must be a non-empty string`)
  const posix = ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!posix) throw runnerError('OMC/ACCEPTANCE-SPEC', `${label} is empty after normalisation`)
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || posix.split('/').includes('..')) {
    throw runnerError('OMC/ACCEPTANCE-SPEC', `${label} must stay inside the workdir: ${ref}`)
  }
  return posix
}

function describeRun(command) {
  if (command.shell) return command.argv[0]
  return command.argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function normalizeCommand(raw, index) {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (!name) throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].name is required`)

  const run = raw.run
  let argv
  let shell
  if (Array.isArray(run)) {
    argv = run.map((part) => String(part))
    if (!argv.length || !argv[0].trim()) throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].run needs at least an executable`)
    shell = false
  } else if (typeof run === 'string' && run.trim()) {
    // A string form needs a shell by definition; the argv form never does.
    // Splits are always expected to use the argv form.
    argv = [run.trim()]
    shell = true
  } else {
    throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].run must be an argv array or a command string`)
  }

  const expect = { exitCode: 0, stdoutContains: [], stdoutNotContains: [] }
  if (raw.expect !== undefined) {
    if (!raw.expect || typeof raw.expect !== 'object' || Array.isArray(raw.expect)) {
      throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].expect must be an object`)
    }
    if (raw.expect.exitCode !== undefined) {
      if (!Number.isSafeInteger(raw.expect.exitCode)) {
        throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].expect.exitCode must be an integer`)
      }
      expect.exitCode = raw.expect.exitCode
    }
    for (const key of ['stdoutContains', 'stdoutNotContains']) {
      const value = raw.expect[key]
      if (value === undefined) continue
      if (!Array.isArray(value) || value.some((row) => typeof row !== 'string' || row === '')) {
        throw runnerError('OMC/ACCEPTANCE-SPEC', `commands[${index}].expect.${key} must be an array of non-empty strings`)
      }
      expect[key] = [...value]
    }
  }

  const command = { name, argv, shell, expect }
  return { ...command, label: describeRun(command) }
}

/**
 * Validate one acceptance spec and return a defensive copy.
 *
 * Structural problems throw OMC/ACCEPTANCE-SPEC: a malformed spec is a caller
 * bug, not a verdict about the worker. Once the spec is well formed this
 * runner never throws for a failing check.
 */
export function validateAcceptanceSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw runnerError('OMC/ACCEPTANCE-SPEC', 'an acceptance spec must be an object')
  }
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  if (!ID_PATTERN.test(taskId)) throw runnerError('OMC/ACCEPTANCE-SPEC', `taskId is not a valid id: ${String(raw.taskId)}`)
  const split = typeof raw.split === 'string' ? raw.split.trim() : ''
  if (!TASK_SPLITS.includes(split)) {
    throw runnerError('OMC/ACCEPTANCE-SPEC', `split must be one of ${TASK_SPLITS.join(', ')}`)
  }
  const family = typeof raw.family === 'string' && raw.family.trim() ? raw.family.trim().slice(0, 120) : taskId

  if (!Array.isArray(raw.commands) || !raw.commands.length) {
    throw runnerError('OMC/ACCEPTANCE-SPEC', 'commands must be a non-empty array')
  }
  const commands = raw.commands.map(normalizeCommand)
  const names = new Set()
  for (const command of commands) {
    if (names.has(command.name)) throw runnerError('OMC/ACCEPTANCE-SPEC', `duplicate command name: ${command.name}`)
    names.add(command.name)
  }

  const acceptanceFiles = (Array.isArray(raw.acceptanceFiles) ? raw.acceptanceFiles : [])
    .map((ref, i) => normalizeRef(ref, `acceptanceFiles[${i}]`))
  const forbidChanges = (Array.isArray(raw.forbidChanges) ? raw.forbidChanges : [])
    .map((ref, i) => normalizeRef(ref, `forbidChanges[${i}]`))

  const rubric = (Array.isArray(raw.rubric) ? raw.rubric : [])
    .map((row, i) => {
      const value = typeof row === 'string' ? row.trim() : ''
      if (!value) throw runnerError('OMC/ACCEPTANCE-SPEC', `rubric[${i}] is empty`)
      return value
    })

  return { version: ACCEPTANCE_RUNNER_VERSION, taskId, split, family, commands, acceptanceFiles, forbidChanges, rubric }
}

/**
 * Per-file content digests for one tree. The tree DIGEST used for comparison
 * always comes from `treeFingerprint`; this map exists only so `forbidChanges`
 * can name the file that moved. Same skip rules as the fingerprint, so the two
 * views describe the same set of files.
 */
function fileDigests(root, { maxFiles = MAX_FILES } = {}) {
  const files = {}
  let count = 0
  let truncated = false
  const walk = (dir) => {
    if (count >= maxFiles) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (count >= maxFiles) {
        truncated = true
        return
      }
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
      } else if (entry.isFile()) {
        count += 1
        let digest = 'unreadable'
        try {
          const info = statSync(full)
          if (info.size <= MAX_FILE_BYTES) {
            digest = readDigest(full) ?? 'unreadable'
          } else {
            const head = readFileSync(full).subarray(0, 64 * 1024)
            digest = `${info.size}:${sha256(head)}`
          }
        } catch {
          digest = 'unreadable'
        }
        files[rel] = digest
      }
    }
  }
  walk(root)
  return { files, truncated }
}

function acceptanceSnapshot(root, refs) {
  const files = {}
  for (const ref of [...refs].sort()) files[ref] = readDigest(join(root, ref)) ?? 'missing'
  return { digest: sha256(JSON.stringify(files)), files }
}

/** Which baseline-vs-current differences violate one `forbidChanges` entry. */
function forbiddenProblems(ref, before, after) {
  const problems = []
  const matches = (key) => key === ref || key.startsWith(`${ref}/`)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of [...keys].sort()) {
    if (!matches(key)) continue
    const was = before[key] ?? null
    const is = after[key] ?? null
    if (was === is) continue
    if (was === null) problems.push(`${key} was created after the baseline; ${ref} is outside the delivered work's write scope`)
    else if (is === null) problems.push(`${key} was deleted after the baseline; ${ref} is outside the delivered work's write scope`)
    else problems.push(`${key} changed after the baseline; ${ref} is outside the delivered work's write scope`)
  }
  return problems
}

function probe(handle, name) {
  try {
    return handle?.collected?.[name]?.readFrom(0)?.text ?? ''
  } catch {
    return ''
  }
}

function isNodeName(value) {
  const name = String(value).toLowerCase()
  return name === 'node' || name === 'node.exe'
}

/**
 * Resolve a bare `node` acceptance command without weakening argv/shell rules.
 *
 * The host process may be Electron (process.execPath is not node) and may not
 * carry a node directory on PATH. `OMC_NODE_EXECUTABLE` is the explicit host
 * opt-in; it must be an absolute existing file named node/node.exe. An explicit
 * absolute argv[0], and every non-node command, is left untouched. A set but
 * invalid override fails closed instead of silently falling back to PATH.
 */
function nodeExecutableFor(argv0, { allowProcessExecPath = false } = {}) {
  if (!isNodeName(argv0)) return null
  const configured = process.env.OMC_NODE_EXECUTABLE
  const candidate = configured !== undefined && configured !== ''
    ? configured
    : (allowProcessExecPath && isNodeName(basename(process.execPath)) ? process.execPath : null)
  if (candidate === null) return null
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || !existsSync(candidate)) {
    throw new Error(`OMC/ACCEPTANCE-NODE: OMC_NODE_EXECUTABLE must be an existing absolute node executable; got ${String(candidate)}`)
  }
  try {
    if (!statSync(candidate).isFile() || !isNodeName(basename(candidate))) {
      throw new Error('not a node executable file')
    }
  } catch (error) {
    throw new Error(`OMC/ACCEPTANCE-NODE: OMC_NODE_EXECUTABLE is invalid: ${String(error?.message ?? error)}`)
  }
  return candidate
}

function effectiveArgv(command, { allowProcessExecPath = false } = {}) {
  try {
    const node = nodeExecutableFor(command.argv[0], { allowProcessExecPath })
    return node === null ? { argv: command.argv } : { argv: [node, ...command.argv.slice(1)] }
  } catch (error) {
    return { argv: command.argv, error: String(error?.message ?? error) }
  }
}

/**
 * Run one command through the Host subprocess service (bound read-only
 * execution surface). Falls back to the literal argv[0] when the service
 * cannot resolve it, and reports the failure if the spawn itself never starts.
 */
async function runViaService(subprocess, { command, cwd, timeoutMs, env }) {
  if (command.shell) {
    return {
      started: false,
      exitCode: null,
      stdout: '',
      stderr: 'the injected subprocess service runs literal argv only; a shell command cannot be delegated to it',
      timedOut: false,
    }
  }
  const effective = effectiveArgv(command)
  if (effective.error) {
    return { started: false, exitCode: null, stdout: '', stderr: effective.error, timedOut: false }
  }
  let executable = effective.argv[0]
  try {
    executable = await subprocess.resolveExecutable(effective.argv[0])
  } catch {
    // Keep the literal name: the service may still resolve it, and a missing
    // executable must surface as a failed check rather than an exception.
  }
  // The service owns termination (a whole-process-tree kill on Windows); the
  // AbortSignal is only the deadline, so the runner never kills processes.
  const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : null
  let handle
  try {
    handle = subprocess.spawn({
      argv: [executable, ...effective.argv.slice(1)],
      cwd,
      env: { ...process.env, ...env },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
    const outcome = await handle.done
    return {
      started: true,
      exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
      stdout: probe(handle, 'stdout'),
      stderr: probe(handle, 'stderr'),
      timedOut: signal?.aborted === true,
    }
  } catch (error) {
    return {
      started: false,
      exitCode: null,
      stdout: probe(handle, 'stdout'),
      stderr: String(error?.message ?? error),
      timedOut: signal?.aborted === true,
    }
  } finally {
    try { handle?.terminate?.() } catch { /* already settled */ }
  }
}

/**
 * Run one command as a plain child process, with stdout/stderr redirected to
 * files (pipes are blocked in some sandboxes). No shell for the argv form.
 */
async function runLocal({ command, cwd, timeoutMs, env }) {
  const scratch = mkdtempSync(join(tmpdir(), 'omc-acceptance-'))
  const stdoutFile = join(scratch, 'stdout.txt')
  const stderrFile = join(scratch, 'stderr.txt')
  const effective = effectiveArgv(command, { allowProcessExecPath: true })
  if (effective.error) {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
    return { started: false, exitCode: null, stdout: '', stderr: effective.error, timedOut: false }
  }
  try {
    let child
    const outFd = openSync(stdoutFile, 'w')
    const errFd = openSync(stderrFile, 'w')
    try {
      child = spawn(effective.argv[0], effective.argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        shell: command.shell,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      })
    } catch (error) {
      return { started: false, exitCode: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false }
    } finally {
      // The child holds duplicated descriptors; ours can close immediately.
      closeSync(outFd)
      closeSync(errFd)
    }

    let timedOut = false
    let spawnError = null
    const timer = setTimeout(() => {
      timedOut = true
      // Only the child this runner started is terminated, so CI cannot hang.
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, Math.max(1000, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()

    const outcome = await new Promise((settle) => {
      child.once('error', (error) => settle({ exitCode: null, signal: null, error }))
      child.once('close', (code, signal) => settle({ exitCode: code, signal }))
    })
    clearTimeout(timer)
    spawnError = outcome.error ?? null

    return {
      started: !spawnError,
      exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : null,
      stdout: readText(stdoutFile),
      stderr: spawnError ? String(spawnError.message ?? spawnError) : readText(stderrFile),
      timedOut,
    }
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function evaluateCheck(command, result) {
  const problems = []
  if (result.timedOut) problems.push('timed out')
  if (!result.started) problems.push(`could not be executed: ${result.stderr.trim() || 'unknown error'}`)
  if (!result.timedOut && result.started && result.exitCode !== command.expect.exitCode) {
    problems.push(`exit code ${String(result.exitCode)}, expected ${command.expect.exitCode}`)
  }
  for (const needle of command.expect.stdoutContains) {
    if (!result.stdout.includes(needle)) problems.push(`stdout is missing ${JSON.stringify(needle)}`)
  }
  for (const needle of command.expect.stdoutNotContains) {
    if (result.stdout.includes(needle)) problems.push(`stdout must not contain ${JSON.stringify(needle)}`)
  }
  const passed = problems.length === 0
  const stderr = result.stderr.trim()
  return {
    check: {
      name: command.name,
      command: command.label,
      exitCode: result.exitCode,
      passed,
      outputTail: [tail(result.stdout), stderr ? `--- stderr ---\n${tail(stderr, 2000)}` : '']
        .filter(Boolean).join('\n').trim(),
      ...(passed ? {} : { problems }),
    },
    reason: passed ? null : `OMC/ACCEPTANCE-CHECK: ${command.name} ${problems[0]}`,
  }
}

/**
 * @param {{cwd?: string, subprocess?: object|null, now?: () => string}} [options]
 *   `subprocess` is the Host `ctx.subprocess` surface when the caller has one;
 *   without it the runner uses `node:child_process` directly and redirects
 *   output to files.
 */
export function createAcceptanceRunner({ cwd, subprocess = null, now = () => new Date().toISOString() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw runnerError('OMC/ACCEPTANCE-CWD', 'createAcceptanceRunner needs an absolute cwd')
  }
  const root = resolve(cwd)

  function dirFor(workdir) {
    if (workdir === undefined || workdir === null) return root
    if (typeof workdir !== 'string' || !workdir.trim()) {
      throw runnerError('OMC/ACCEPTANCE-WORKDIR', 'workdir must be a non-empty path string')
    }
    return resolve(workdir)
  }

  async function execute(command, { workdir, timeoutMs, env }) {
    const options = { command, cwd: workdir, timeoutMs, env }
    const result = subprocess ? await runViaService(subprocess, options) : await runLocal(options)
    return evaluateCheck(command, result)
  }

  return {
    version: ACCEPTANCE_RUNNER_VERSION,

    /**
     * Freeze the start state. The caller must call this BEFORE the task runs;
     * `verifyDelivered` later compares `forbidChanges` against this map, and
     * `run` treats a changed acceptance definition as tampering even if the
     * change happened before the checks started.
     */
    async baseline({ spec, workdir } = {}) {
      const validated = validateAcceptanceSpec(spec)
      const workdirPath = dirFor(workdir)
      const fingerprint = treeFingerprint(workdirPath, { maxFiles: MAX_FILES, now })
      const map = fileDigests(workdirPath)
      const acceptance = acceptanceSnapshot(workdirPath, validated.acceptanceFiles)
      return {
        version: ACCEPTANCE_RUNNER_VERSION,
        taskId: validated.taskId,
        split: validated.split,
        fingerprint: fingerprint.digest,
        files: map.files,
        acceptanceDigest: acceptance.digest,
        acceptanceFiles: acceptance.files,
        truncated: fingerprint.truncated || map.truncated,
        at: now(),
      }
    },

    /**
     * Run the fixed checks and return a verdict.
     *
     * `baseline` is optional: without it `forbidChanges` cannot be evaluated
     * and the verdict says so. A failed check, a timeout, an unstartable
     * command, a tampered acceptance definition or a forbidden change all come
     * back as `passed: false` with a reason — never as a thrown error.
     */
    async run({ spec, workdir, timeoutMs = 120000, env = {}, baseline = null } = {}) {
      const validated = validateAcceptanceSpec(spec)
      const workdirPath = dirFor(workdir)
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw runnerError('OMC/ACCEPTANCE-SPEC', 'timeoutMs must be a positive integer')
      }
      if (!env || typeof env !== 'object' || Array.isArray(env)) {
        throw runnerError('OMC/ACCEPTANCE-SPEC', 'env must be a plain object of overrides')
      }

      const before = acceptanceSnapshot(workdirPath, validated.acceptanceFiles)
      const checks = []
      let checkReason = null
      for (const command of validated.commands) {
        const outcome = await execute(command, { workdir: workdirPath, timeoutMs, env })
        checks.push(outcome.check)
        if (outcome.reason && !checkReason) checkReason = outcome.reason
      }
      const after = acceptanceSnapshot(workdirPath, validated.acceptanceFiles)
      const fingerprint = treeFingerprint(workdirPath, { maxFiles: MAX_FILES, now })

      const problems = []
      const warnings = []
      const frozenDigest = typeof baseline?.acceptanceDigest === 'string' ? baseline.acceptanceDigest : null
      const changedSinceBaseline = frozenDigest !== null && frozenDigest !== before.digest
      const changedDuringRun = before.digest !== after.digest
      const tampered = changedSinceBaseline || changedDuringRun
      if (tampered) {
        problems.push(
          `${changedSinceBaseline ? 'the acceptance definition changed after it was frozen' : 'the acceptance definition changed while it was being checked'} ` +
          `(${validated.acceptanceFiles.join(', ')}); a worker must not edit the grading it is measured against`,
        )
      }
      if (baseline && baseline.files) {
        const current = fileDigests(workdirPath).files
        for (const ref of validated.forbidChanges) {
          problems.push(...forbiddenProblems(ref, baseline.files, current))
        }
      } else if (validated.forbidChanges.length) {
        warnings.push('no baseline was supplied, so forbidChanges was not evaluated')
      }
      if (!validated.acceptanceFiles.length) {
        warnings.push('no acceptanceFiles are declared, so nothing protects the grading from being edited by the worker')
      }

      let reason = null
      if (tampered) reason = 'OMC/ACCEPTANCE-TAMPERED: the acceptance definition is not the one that was frozen for this task'
      else if (problems.length) reason = `OMC/ACCEPTANCE-FORBIDDEN-CHANGE: ${problems[0]}`
      else if (checkReason) reason = checkReason

      return {
        version: ACCEPTANCE_RUNNER_VERSION,
        passed: reason === null,
        taskId: validated.taskId,
        split: validated.split,
        checks,
        fingerprint: fingerprint.digest,
        acceptanceDigest: after.digest,
        at: now(),
        reason,
        problems,
        warnings,
        ...(tampered ? { acceptanceDigestBefore: changedSinceBaseline ? frozenDigest : before.digest } : {}),
        ...(fingerprint.truncated ? { fingerprintNote: `fingerprint covers the first ${MAX_FILES} files only` } : {}),
      }
    },

    /**
     * Compare the delivered tree against the frozen baseline for the paths the
     * work was not allowed to touch. Acceptance of the CHECKS is `run`'s job;
     * this only answers "did the delivery stay inside its write scope".
     */
    verifyDelivered({ spec, workdir, baseline: frozen = null } = {}) {
      const validated = validateAcceptanceSpec(spec)
      const workdirPath = dirFor(workdir)
      if (!frozen || typeof frozen !== 'object' || !frozen.files) {
        return { passed: false, problems: ['no baseline was supplied; forbidChanges cannot be checked against anything'] }
      }
      const current = fileDigests(workdirPath).files
      const problems = []
      for (const ref of validated.forbidChanges) {
        problems.push(...forbiddenProblems(ref, frozen.files, current))
      }
      return { passed: problems.length === 0, problems }
    },
  }
}

/**
 * Split a task set into development / validation / holdout, grouped by
 * `family` so variants of one problem never land in different splits.
 *
 * Deterministic for the same tasks + salt: families are ordered by
 * `sha256(salt + family)` and then assigned to the split that is furthest
 * below its weighted quota (ties break in TASK_SPLITS order). Families are
 * always assigned whole, so split sizes approximate the weights rather than
 * hitting them exactly; the returned `notes` states that and any singleton
 * family. A one-task family cannot demonstrate leakage and is therefore
 * development-preferred — it is never used as holdout evidence.
 */
export function deterministicSplit({ tasks, salt = 'omc-v1', weights = DEFAULT_WEIGHTS } = {}) {
  if (!Array.isArray(tasks) || !tasks.length) {
    throw runnerError('OMC/SPLIT-INVALID', 'tasks must be a non-empty array of ids or {id, family} rows')
  }
  const normalized = tasks.map((row, index) => {
    const id = typeof row === 'string' ? row.trim() : String(row?.id ?? '').trim()
    if (!id) throw runnerError('OMC/SPLIT-INVALID', `tasks[${index}].id is required`)
    const family = typeof row === 'string' ? '' : String(row?.family ?? '').trim()
    return { id, family: family || id }
  })
  if (new Set(normalized.map((task) => task.id)).size !== normalized.length) {
    throw runnerError('OMC/SPLIT-INVALID', 'task ids must be unique')
  }

  const quota = {}
  let weightSum = 0
  for (const split of TASK_SPLITS) {
    const value = Number(weights?.[split] ?? 0)
    if (!Number.isFinite(value) || value < 0) throw runnerError('OMC/SPLIT-INVALID', `weights.${split} must be a non-negative number`)
    quota[split] = value
    weightSum += value
  }
  if (!(weightSum > 0)) throw runnerError('OMC/SPLIT-INVALID', 'at least one split weight must be positive')

  const families = new Map()
  for (const task of normalized) {
    if (!families.has(task.family)) families.set(task.family, [])
    families.get(task.family).push(task)
  }
  const orderKey = (family) => sha256(`${salt}\u0000${family}`)
  const ordered = [...families.keys()].sort((a, b) => {
    const left = orderKey(a)
    const right = orderKey(b)
    if (left === right) return a.localeCompare(b)
    return left < right ? -1 : 1
  })

  const notes = []
  const counts = Object.fromEntries(TASK_SPLITS.map((split) => [split, 0]))
  const target = Object.fromEntries(TASK_SPLITS.map((split) => [split, (quota[split] / weightSum) * normalized.length]))
  const splitOf = new Map()

  const multi = ordered.filter((family) => families.get(family).length > 1)
  const singles = ordered.filter((family) => families.get(family).length === 1)

  for (const family of multi) {
    let chosen = TASK_SPLITS[0]
    let best = -Infinity
    for (const split of TASK_SPLITS) {
      // Relative distance to the quota: proportional, so a small holdout is not
      // permanently starved or permanently over-fed.
      const scale = target[split] > 0 ? target[split] : 0.5
      const score = (target[split] - counts[split]) / scale
      if (score > best) {
        best = score
        chosen = split
      }
    }
    splitOf.set(family, chosen)
    counts[chosen] += families.get(family).length
  }

  for (const family of singles) {
    splitOf.set(family, 'development')
    counts.development += 1
    notes.push(`family "${family}" has a single task; it is development-preferred because a one-task family cannot provide leakage evidence and must not count as holdout evidence`)
  }
  notes.push('families are assigned whole, so split sizes approximate the weights instead of matching them exactly')

  const out = Object.fromEntries(TASK_SPLITS.map((split) => [split, []]))
  for (const family of ordered) {
    const split = splitOf.get(family)
    for (const task of families.get(family)) out[split].push(task.id)
  }
  return { ...out, notes }
}
