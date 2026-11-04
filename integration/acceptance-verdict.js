/**
 * Unified, trusted acceptance verdict (0.6 PR-02).
 *
 * Before this module two things were conflated: "the run finished" (execution)
 * and "the delivered work passed its acceptance" (verdict). A caller could hand
 * `graph.complete` a list of strings — or a home-made `{state:'passed'}` object —
 * and the node was done. This module makes the verdict a *record*:
 *
 *   baseline  frozen from the acceptance runner BEFORE dispatch
 *             {id, taskId, attemptId, specDigest, acceptanceDigest, fingerprint, frozenAt}
 *   verdict   produced by the runner (or looked up in the OMC execution record)
 *             {id, taskId, attemptId, specDigest, baselineId, state, fingerprint, at}
 *
 * The three completion entry points (coauthor tool graph.complete,
 * native-managed.settle, managed-execution dispatch) call `resolve()` here, so
 * they accept exactly the same verdicts. A verdict object supplied by a caller
 * is only a *reference*: it must exist in the trusted execution store and match
 * this task/attempt/spec/baseline. Anything else is refused with
 * `OMC/ACCEPTANCE-UNTRUSTED`.
 *
 * Honest limits:
 *   - the runner proves the checks it was given, nothing more; a spec with no
 *     `acceptanceFiles` cannot detect a worker editing the grading, and that is
 *     reported as a warning by the runner, not hidden here;
 *   - `treeCheck` compares the delivered tree to the verdict's fingerprint. It
 *     answers "did someone change the tree after the verdict was produced", not
 *     "is the change good";
 *   - a legacy node whose acceptance is only human strings has no runnable spec:
 *     it must be verified explicitly (a spec is supplied to `graph.verify`) or
 *     it stays pending. Strings are never upgraded into a passed verdict.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { treeFingerprint } from './work-packet.js'
import { validateAcceptanceSpec } from './acceptance-runner.js'

export const ACCEPTANCE_VERDICT_VERSION = 1
export const ACCEPTANCE_VERDICT_STATES = Object.freeze(['passed', 'failed', 'unknown'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function verdictError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function failure(code, message, extra = {}) {
  return { ok: false, state: extra.state ?? 'unknown', code, reason: `${code}: ${message}`, ...extra }
}

/** Deterministic JSON (sorted keys, recursively) for stable spec digests. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate an acceptance spec and return `{spec, digest}`. Throws on bad input. */
export function digestsForSpec(spec) {
  const validated = validateAcceptanceSpec(spec)
  return { spec: validated, digest: sha256(stableStringify(validated)) }
}

export function baselineIdFor({ taskId, attemptId = null, specDigest }) {
  return `accbase:${sha256(`baseline|${taskId}|${attemptId ?? ''}|${specDigest}`).slice(0, 24)}`
}

export function verdictIdFor({ taskId, attemptId, specDigest, baselineId, state, fingerprint = '' }) {
  return `accverdict:${sha256(`verdict|${taskId}|${attemptId}|${specDigest}|${baselineId}|${state}|${fingerprint}`).slice(0, 24)}`
}

/** Same per-file digest map the runner uses for `acceptanceFiles`. */
function acceptanceSnapshot(root, refs) {
  const files = {}
  for (const ref of [...(refs ?? [])].sort()) {
    let digest = null
    try {
      digest = sha256(readFileSync(join(root, ref)))
    } catch {
      digest = null
    }
    files[ref] = digest ?? 'missing'
  }
  return { digest: sha256(JSON.stringify(files)), files }
}

/**
 * @param {{executionStore?: object|null, now?: () => string}} [options]
 */
export function createAcceptanceAuthority({ executionStore = null, now = () => new Date().toISOString() } = {}) {
  function requireStore() {
    if (!executionStore || typeof executionStore.acceptance !== 'function' || typeof executionStore.read !== 'function') {
      throw verdictError('OMC/ACCEPTANCE-STORE', 'a trusted acceptance verdict needs the execution store')
    }
  }

  function requireRunner(runner) {
    if (!runner || typeof runner.baseline !== 'function' || typeof runner.run !== 'function') {
      throw verdictError('OMC/ACCEPTANCE-RUNNER', 'a trusted acceptance verdict needs an acceptance runner (baseline/run)')
    }
  }

  /**
   * Freeze the start state BEFORE dispatch. The returned baseline is bound to
   * the attempt, so a late baseline (frozen after the run started) is refused
   * by `resolve()`.
   */
  async function freeze({ spec, workdir, runner, taskId, nodeId = null, attemptId = null } = {}) {
    requireRunner(runner)
    if (!text(taskId)) throw verdictError('OMC/ACCEPTANCE-TASK', 'freeze needs taskId')
    const { spec: validated, digest } = digestsForSpec(spec)
    // The runner re-validates its input, so it receives the RAW spec (not the
    // normalized {argv} form validated here for the digest).
    const frozen = await runner.baseline({ spec, workdir })
    const frozenAt = now()
    return {
      version: ACCEPTANCE_VERDICT_VERSION,
      id: baselineIdFor({ taskId, attemptId, specDigest: digest }),
      taskId,
      nodeId,
      attemptId,
      specDigest: digest,
      specVersion: validated.version,
      fingerprint: frozen?.fingerprint ?? null,
      acceptanceDigest: frozen?.acceptanceDigest ?? null,
      files: frozen?.files ?? {},
      acceptanceFiles: frozen?.acceptanceFiles ?? {},
      truncated: frozen?.truncated === true,
      at: frozen?.at ?? frozenAt,
      frozenAt,
    }
  }

  /**
   * Run the frozen checks and persist one structured verdict. This is the only
   * path that can create a `passed` verdict.
   */
  async function produce({ spec, workdir, runner, taskId, nodeId = null, attemptId, baseline, timeoutMs = 120000 } = {}) {
    requireStore()
    requireRunner(runner)
    if (!text(taskId)) throw verdictError('OMC/ACCEPTANCE-TASK', 'produce needs taskId')
    if (!text(attemptId)) throw verdictError('OMC/ACCEPTANCE-ATTEMPT', 'produce needs the current attemptId')
    if (!baseline || typeof baseline !== 'object' || !text(baseline.id) || !text(baseline.specDigest)) {
      throw verdictError('OMC/ACCEPTANCE-BASELINE', 'a verdict cannot be produced without a frozen baseline')
    }
    const { spec: validated, digest } = digestsForSpec(spec ?? null)
    if (digest !== baseline.specDigest) {
      throw verdictError('OMC/ACCEPTANCE-TAMPERED', 'the acceptance spec no longer matches the digest frozen in the baseline')
    }
    const result = await runner.run({ spec, workdir, baseline, timeoutMs })
    let state = result?.passed === true ? 'passed' : 'failed'
    let reason = result?.reason ?? null
    let problems = Array.isArray(result?.problems) ? [...result.problems] : []
    // verifyDelivered is part of the same judge path: a forbidden change can
    // only downgrade a verdict, never upgrade one.
    if (state === 'passed' && typeof runner.verifyDelivered === 'function') {
      const delivered = runner.verifyDelivered({ spec, workdir, baseline })
      if (delivered?.passed !== true) {
        state = 'failed'
        reason = reason ?? `OMC/ACCEPTANCE-FORBIDDEN-CHANGE: ${(delivered?.problems ?? ['delivery is outside its scope'])[0]}`
        problems = [...problems, ...(delivered?.problems ?? [])]
      }
    }
    const verdict = {
      version: ACCEPTANCE_VERDICT_VERSION,
      id: verdictIdFor({
        taskId, attemptId, specDigest: digest, baselineId: baseline.id, state, fingerprint: result?.fingerprint ?? '',
      }),
      taskId,
      nodeId,
      attemptId,
      specDigest: digest,
      baselineId: baseline.id,
      state,
      source: 'runner',
      fingerprint: result?.fingerprint ?? null,
      acceptanceDigest: result?.acceptanceDigest ?? null,
      acceptanceDigestBefore: result?.acceptanceDigestBefore ?? null,
      checks: Array.isArray(result?.checks) ? result.checks : [],
      reason,
      problems,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      at: now(),
      evidence: [
        `acceptance-runner:${validated.taskId}`,
        `baseline:${baseline.id}`,
        `spec:${digest}`,
        `tree:${result?.fingerprint ?? 'unknown'}`,
      ],
    }
    const stored = executionStore.acceptance(taskId, { verdict, attemptId, evidence: verdict.evidence })
    return { verdict, duplicate: stored?.duplicate === true, conflict: stored?.conflict === true }
  }

  /** Read the trusted record for one verdict reference. */
  function lookup({ taskId, verdictId = null, attemptId = null, specDigest = null, baselineId = null } = {}) {
    if (!executionStore || typeof executionStore.verdict !== 'function') return null
    return executionStore.verdict(taskId, { verdictId, attemptId, specDigest, baselineId })
  }

  /**
   * Synchronous half of the decision: validate the binding, then look up the
   * trusted record. Returns either a final decision or `needsVerdict` with the
   * context a caller can pass to `produce`.
   */
  function evaluate({
    taskId, nodeId = null, node = null, spec = undefined, workdir = null,
    baseline = undefined, verdict = undefined, attemptId = undefined,
    treeCheck = true, allowGenerate = false,
  } = {}) {
    if (!text(taskId)) return { decision: failure('OMC/ACCEPTANCE-TASK', 'resolve needs the task id') }
    const specInput = spec !== undefined ? spec : node?.acceptanceSpec ?? null
    let validatedSpec = null
    let specDigest = null
    if (specInput) {
      try {
        const row = digestsForSpec(specInput)
        validatedSpec = row.spec
        specDigest = row.digest
      } catch (error) {
        return { decision: failure('OMC/ACCEPTANCE-SPEC', String(error?.message ?? error)) }
      }
    }
    const frozen = baseline !== undefined ? baseline : node?.acceptanceBaseline ?? null
    if (!frozen || typeof frozen !== 'object' || !text(frozen.id)) {
      return { decision: failure('OMC/ACCEPTANCE-BASELINE', 'no baseline was frozen before dispatch; an acceptance verdict cannot be trusted') }
    }
    if (!text(frozen.specDigest)) {
      return { decision: failure('OMC/ACCEPTANCE-BASELINE', 'the frozen baseline has no acceptance spec digest') }
    }
    if (specDigest && frozen.specDigest !== specDigest) {
      return { decision: failure('OMC/ACCEPTANCE-TAMPERED', 'the acceptance spec changed after its baseline was frozen') }
    }
    if (!specDigest) specDigest = frozen.specDigest

    const view = executionStore && typeof executionStore.read === 'function' ? executionStore.read(taskId) : null
    const currentAttemptId = attemptId ?? view?.currentAttemptId ?? frozen.attemptId ?? null
    if (!currentAttemptId) return { decision: failure('OMC/ACCEPTANCE-ATTEMPT', 'no current execution attempt can own this verdict') }
    const attempt = view?.attempts?.find((row) => row.attemptId === currentAttemptId) ?? null
    if (!attempt) return { decision: failure('OMC/ACCEPTANCE-ATTEMPT', `attempt ${currentAttemptId} is not in the execution record`) }
    if (frozen.attemptId && frozen.attemptId !== currentAttemptId) {
      return { decision: failure('OMC/ACCEPTANCE-STALE-BASELINE', `the baseline belongs to attempt ${frozen.attemptId}, not the current ${currentAttemptId}`) }
    }
    const frozenAt = Date.parse(frozen.frozenAt ?? frozen.at)
    // The boundary a baseline must precede: the explicit launching record for
    // external runs, or the first observed running turn for a native child.
    // `openedAt` alone is only the bookkeeping intent and is not a dispatch.
    const launchBoundary = Date.parse(attempt.launchingAt ?? attempt.runningAt ?? attempt.openedAt ?? '')
    if (Number.isFinite(frozenAt) && Number.isFinite(launchBoundary) && frozenAt > launchBoundary) {
      return {
        decision: failure('OMC/ACCEPTANCE-BASELINE-LATE',
          'the baseline was frozen after the run had already started; a late baseline cannot grade this delivery'),
      }
    }

    let record = null
    let source = 'record'
    if (verdict && typeof verdict === 'object') {
      if (!text(verdict.id)) return { decision: failure('OMC/ACCEPTANCE-UNTRUSTED', 'a caller-supplied verdict must name its trusted record') }
      record = lookup({ taskId, verdictId: verdict.id })
      if (!record) {
        return {
          decision: failure('OMC/ACCEPTANCE-UNTRUSTED',
            'the supplied verdict is not present in the OMC trusted verdict record; a self-reported object cannot pass'),
        }
      }
      if (verdict.state && record.state !== verdict.state) {
        return { decision: failure('OMC/ACCEPTANCE-UNTRUSTED', 'the supplied verdict state does not match the trusted record') }
      }
      if (verdict.specDigest && record.specDigest !== verdict.specDigest) {
        return { decision: failure('OMC/ACCEPTANCE-UNTRUSTED', 'the supplied verdict spec digest does not match the trusted record') }
      }
    } else {
      record = lookup({ taskId, attemptId: currentAttemptId, specDigest, baselineId: frozen.id })
    }

    if (!record) {
      return {
        needsVerdict: true,
        context: {
          taskId, nodeId, specInput, validatedSpec, specDigest, frozen, currentAttemptId, workdir, treeCheck, allowGenerate,
        },
      }
    }

    if (record.attemptId !== currentAttemptId) {
      return {
        decision: failure('OMC/ACCEPTANCE-STALE-ATTEMPT',
          `the verdict belongs to attempt ${record.attemptId}, not the current ${currentAttemptId}; an old verdict cannot settle new work`),
      }
    }
    if (record.specDigest && record.specDigest !== specDigest) {
      return { decision: failure('OMC/ACCEPTANCE-TAMPERED', 'the stored verdict grades a different acceptance spec') }
    }
    if (record.baselineId && frozen.id && record.baselineId !== frozen.id) {
      return { decision: failure('OMC/ACCEPTANCE-STALE-BASELINE', 'the stored verdict belongs to a different frozen baseline') }
    }
    if (record.state !== 'passed' && record.state !== 'failed' && record.state !== 'unknown') {
      return { decision: failure('OMC/ACCEPTANCE-VERDICT', `unknown verdict state ${String(record.state)}`) }
    }

    if (treeCheck && text(workdir) && text(record.fingerprint)) {
      const current = treeFingerprint(workdir, { now }).digest
      if (current !== record.fingerprint) {
        return {
          decision: failure('OMC/ACCEPTANCE-TREE-DRIFT',
            'the delivered tree changed after the verdict was produced; the stored verdict no longer describes this delivery'),
        }
      }
      if (validatedSpec?.acceptanceFiles?.length) {
        const snapshot = acceptanceSnapshot(workdir, validatedSpec.acceptanceFiles)
        if (text(record.acceptanceDigest) && snapshot.digest !== record.acceptanceDigest) {
          return {
            decision: failure('OMC/ACCEPTANCE-TAMPERED',
              'the acceptance definition changed after the verdict was produced'),
          }
        }
      }
    }

    return {
      decision: {
        ok: record.state === 'passed',
        state: record.state,
        verdict: record,
        source,
        reason: record.reason ?? null,
        problems: record.problems ?? [],
      },
    }
  }

  /**
   * The single decision used by every completion entry point.
   *
   * A supplied verdict object must identify a stored record; if none is
   * supplied an existing record is looked up, and only then (when an explicit
   * verify is requested) the judge is run in place.
   */
  async function resolve({
    taskId, nodeId = null, node = null, spec = undefined, workdir = null,
    baseline = undefined, verdict = undefined, attemptId = undefined,
    runner = null, timeoutMs = 120000, treeCheck = true, allowGenerate = true,
  } = {}) {
    const first = evaluate({
      taskId, nodeId, node, spec, workdir, baseline, verdict, attemptId, treeCheck, allowGenerate,
    })
    if (first.decision) return first.decision
    const context = first.context
    if (!context.allowGenerate) {
      return failure('OMC/ACCEPTANCE-NO-VERDICT',
        'no trusted verdict exists for this attempt/spec/baseline; run an explicit verify')
    }
    if (!runner) {
      return failure('OMC/ACCEPTANCE-NO-VERDICT',
        'no trusted verdict exists and no runner was supplied; a caller string cannot become a verdict')
    }
    try {
      const produced = await produce({
        spec: context.specInput,
        workdir: context.workdir,
        runner,
        taskId: context.taskId,
        nodeId: context.nodeId,
        attemptId: context.currentAttemptId,
        baseline: context.frozen,
        timeoutMs,
      })
      const second = evaluate({
        taskId: context.taskId,
        nodeId: context.nodeId,
        spec: context.specInput,
        workdir: context.workdir,
        baseline: context.frozen,
        attemptId: context.currentAttemptId,
        treeCheck,
        allowGenerate: false,
      })
      if (second.decision) {
        return { ...second.decision, source: 'generated' }
      }
      return { ok: produced.verdict.state === 'passed', state: produced.verdict.state, verdict: produced.verdict, source: 'generated', reason: produced.verdict.reason ?? null }
    } catch (error) {
      return failure(error?.code ?? 'OMC/ACCEPTANCE-FAILED', String(error?.message ?? error))
    }
  }

  /** Lookup-only decision (no judge run): used by graph.complete. */
  function resolveStored(options = {}) {
    const first = evaluate({ ...options, allowGenerate: false })
    if (first.decision) return first.decision
    return failure('OMC/ACCEPTANCE-NO-VERDICT',
      'no trusted verdict exists for this attempt/spec/baseline; run verify before completing the node')
  }

  /** Structured evidence a graph node/execution record can cite. */
  function evidenceFor(verdict) {
    if (!verdict) return []
    return [
      `acceptance:${verdict.state}`,
      `verdict:${verdict.id}`,
      `baseline:${verdict.baselineId}`,
      `spec:${verdict.specDigest}`,
      `tree:${verdict.fingerprint ?? 'unknown'}`,
    ]
  }

  return {
    version: ACCEPTANCE_VERDICT_VERSION,
    freeze,
    produce,
    lookup,
    resolve,
    resolveStored,
    evidenceFor,
    executionStore,
  }
}
