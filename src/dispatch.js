/**
 * Dispatch: DispatchRequest 閳?real execution 閳?DispatchResult[].
 *
 * Provider first, and the direct surface only when it was asked for: `surface: 'direct'`
 * or a non-read-only mode are explicit requests, and `dispatch.allowDirectFallback`
 * unlocks the implicit one. A missing or rejecting provider never degrades silently 閳?
 * it fails and names both the reason and the switch (V0.2-PLAN 鎼?.2). The difference
 * matters: with a provider the host owns capacity, cancellation and the completion
 * notice, while a direct run is a degraded surface that doctor reports as such
 * (ADAPTER 鎼?.3). Every result therefore names the surface it used 閳?or, for a refusal,
 * the one that was asked for 閳?and, when it had to degrade, why.
 */

import { harnessDef, normalizeId } from './harnesses.js'
import { harnessConfig, isEnabled } from './config.js'
import { adapterFor } from './adapters.js'
import { harnessEnv, planTransport, withTimeout } from './transport.js'
import { blocksToText } from './provider.js'
import { maskSessionId } from './session-adapters.js'
import { classifyCliResult } from '../integration/cli-result.js'
import { resolveBudgetLimits } from '../integration/request-gate.js'
import { applyProjectPolicy, MODE_RANK, readProjectPolicy } from '../integration/project-policy.js'
import { captureTaskWorktree, createTaskWorktree } from '../integration/worktree.js'
import { isAbsolute, resolve } from 'node:path'

function omcError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/** Drop undefined so the value stays valid JSON for the tool output schema. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = clean(item)
    }
    return out
  }
  return value
}

function withNotes(result, notes) {
  const extra = notes.filter(Boolean)
  if (!extra.length) return result
  return { ...result, diagnostics: [...extra, ...(result.diagnostics ?? [])] }
}

/** `ok` beats `unknown`; a field-tested argv beats an untested one. Stable within ties. */
function autoRank(row) {
  return (row.auth === 'ok' ? 0 : 2) + (row.verified === false ? 1 : 0)
}

function unusableReason(row) {
  if (row.auth === 'missing') return `${row.id}: missing (not installed)`
  if (row.auth === 'signed-out') return `${row.id}: signed-out`
  return `${row.id}: not eligible (auth ${row.auth})`
}

/** Why a harness may not use the provider surface. Empty `reason` means it may. */
function providerEligibility(rt, def, shared, exec) {
  const cfg = rt.cfg
  if (cfg.surface === 'direct') return { ok: false, reason: 'surface is configured as direct' }
  if (!rt.ctx.get('subagents')) return { ok: false, reason: 'the subagents service is unavailable' }
  if (!rt.registered.has(def.id)) return { ok: false, reason: `omc:${def.id} is not registered as a provider` }
  if (!exec.agent) return { ok: false, reason: 'this call has no parent agent to attach a child session to' }
  // Every `omc:<id>` provider is a fixed read-only surface: roles depend on
  // that promise and may not gain write access by changing a global default.
  // A per-call write mode therefore takes the direct path; silently ignoring it
  // would be worse than a documented degraded surface.
  if (shared.mode !== 'read-only') {
    return { ok: false, reason: `mode ${shared.mode} needs the direct surface: omc providers are fixed read-only` }
  }
  return { ok: true, reason: '' }
}

/**
 * Direct is reached by asking for it. `surface: 'direct'` is the explicit request, and
 * so is any non-read-only mode: a write mode cannot travel through the fixed read-only
 * provider surface, so it was a request for the direct one. Neither depends on
 * `dispatch.allowDirectFallback`; only the implicit fallback does.
 */
function explicitDirect(cfg, shared) {
  return cfg.surface === 'direct' || shared.mode !== 'read-only'
}

/**
 * A task that reached no surface at all. `surface` names the provider that was asked
 * for, because that is the truthful intent and the only alternative the consumer knows:
 * `renderDispatch` (src/index.js) maps every other value to `-`, so a new value would
 * render as "no surface" next to work that did run. The reason and the disabled switch
 * travel in the diagnostic, where the caller can act on them.
 */
function providerUnavailable(def, started, reason, notes = []) {
  return withNotes(
    { status: 'failed', harnessId: def.id, surface: 'provider', output: '', elapsedMs: Date.now() - started },
    [
      `OMC/PROVIDER-UNAVAILABLE: ${reason}; direct fallback is disabled by dispatch.allowDirectFallback=false; set it to true to opt in, or ask for the direct surface explicitly (surface: direct, or a non-read-only mode)`,
      ...notes,
    ],
  )
}

/**
 * @returns {Promise<{ def: import('./harnesses.js').HarnessDef, warning?: string }>}
 */
async function resolveTarget(rt, raw) {
  const id = normalizeId(raw)

  if (id && id !== 'auto') {
    const def = harnessDef(id)
    if (!def) throw omcError('OMC/UNKNOWN-HARNESS', `unknown harness "${raw}"`)
    if (!isEnabled(rt.cfg, def.id)) throw omcError('OMC/NO-PROVIDER', `${def.id} is disabled in config`)
    // Best effort only: we warn from an already-cached report and never add a slow
    // probe to every explicit dispatch. No report means no claim either way.
    const row = rt.peekReport?.()?.rows?.find?.((entry) => entry.id === def.id)
    const warning =
      row?.auth === 'signed-out'
        ? `OMC/AUTH-SIGNED-OUT: ${def.id} reports signed-out; the run is attempted anyway`
        : undefined
    return { def, warning }
  }

  const report = await rt.detect()
  const rows = report.rows ?? []
  const eligible = rows.filter((row) => row.auth !== 'missing' && row.auth !== 'signed-out')
  if (!eligible.length) {
    const detail = rows.length ? rows.map(unusableReason).join('; ') : 'no harness is enabled in config'
    throw omcError('OMC/CLI-MISSING', `no usable harness for auto 閳?${detail}; run /coharness doctor`)
  }
  const [best] = [...eligible].sort((a, b) => autoRank(a) - autoRank(b))
  return { def: harnessDef(best.id) }
}

async function directRun(rt, def, prompt, cwd, shared, exec, started, reason, notes = []) {
  const { ctx, cfg } = rt
  const baseHcfg = harnessConfig(cfg, def.id)
  const hcfg = typeof shared.model === 'string' && shared.model.trim() !== ''
    ? { ...baseHcfg, model: shared.model.trim() }
    : baseHcfg
  const harnessAdapter = adapterFor(def, cfg)
  if (harnessAdapter.supported !== true) {
    return {
      status: 'failed',
      harnessId: def.id,
      surface: 'direct',
      downgradeReason: reason || 'direct runs have no child session or host capacity',
      output: '',
      elapsedMs: Date.now() - started,
      diagnostics: [...notes, `OMC/ADAPTER-UNSUPPORTED: ${harnessAdapter.reason ?? 'transport unavailable'}`],
    }
  }
  // The direct surface has no child session and no host capacity slot; saying so on
  // every result is what keeps a degraded run from being read as full support.
  const surface = { surface: 'direct', downgradeReason: reason || 'direct runs have no child session or host capacity' }
  let deadline
  try {
    const plan = await planTransport(ctx, def, cfg, exec.signal)
    const launched = await harnessAdapter.start(ctx, {
      task: prompt,
      cwd,
      model: hcfg.model || undefined,
      mode: shared.mode,
      env: harnessEnv(def, hcfg),
      plan,
      // The project ceiling bounds harness-level timeouts too: a per-harness
      // override must not outlive a project policy that tightened the deadline.
      timeoutMs: Math.min(
        hcfg.timeoutMs || shared.timeoutMs,
        shared.projectTimeoutMs ?? Number.MAX_SAFE_INTEGER,
      ),
      maxOutputBytes: cfg.dispatch.maxOutputBytes,
      signal: exec.signal,
    })
    deadline = launched.deadline
    const outcome = await launched.handle.done
    const captured = harnessAdapter.collect(launched.handle, cfg.dispatch.maxOutputBytes)
    const transportStatus = harnessAdapter.status(outcome, deadline, exec.signal)
    // Direct runs do not resume (no lane identity), but reporting the session id
    // and usage the CLI already returned makes the cost observable.
    const parsed = harnessAdapter.parse(captured.stdout)
    // Direct runs never pass `json: true`, so the CLI answers in human text:
    // expectJson stays false (the raw stream IS the answer), and the session
    // adapter merely opportunistically picks up any ids/usage it can find.
    const classification = classifyCliResult({
      status: transportStatus,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      captured,
      parsed,
      expectJson: false,
      requireContent: true,
    })
    const status = classification.status

    return withNotes(
      {
        status,
        harnessId: def.id,
        ...surface,
        output: parsed?.text || captured.stdout || captured.stderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        truncated: classification.truncated,
        code: classification.code,
        retryable: classification.retryable,
        spillPath: captured.spillPath,
        elapsedMs: Date.now() - started,
        ...(parsed?.sessionId
          ? { nativeSession: { id: maskSessionId(parsed.sessionId), format: harnessAdapter.session?.format } }
          : {}),
        ...(parsed?.usage ? { usage: parsed.usage } : {}),
      },
      [
        ...notes,
        classification.code
          ? `${classification.code}: ${classification.message}`
          : status === 'failed' ? `OMC/CLI-EXIT: ${def.id} exited ${outcome.exitCode ?? outcome.signal}` : '',
      ],
    )
  } catch (error) {
    return {
      status: 'failed',
      harnessId: def.id,
      ...surface,
      output: '',
      elapsedMs: Date.now() - started,
      diagnostics: [...notes, String(error?.code ?? error?.message ?? 'launch failed')],
    }
  } finally {
    deadline?.dispose()
  }
}

async function runOne(rt, def, task, shared, exec, warning) {
  const { ctx } = rt
  const started = Date.now()
  const cwd = shared.cwd
  const notes = warning ? [warning] : []
  const directShared = typeof task.model === 'string' && task.model.trim() !== ''
    ? { ...shared, model: task.model.trim() }
    : shared
  const eligibility = providerEligibility(rt, def, shared, exec)

  if (!eligibility.ok && shared.delivery === 'background') {
    // The host completion notice is the whole point of `background`; a direct run
    // has none, so pretending would hide a blocking call behind a fake child id.
    return {
      status: 'failed',
      harnessId: def.id,
      surface: 'direct',
      downgradeReason: eligibility.reason,
      output: '',
      elapsedMs: Date.now() - started,
      diagnostics: [
        'OMC/BACKGROUND-UNSUPPORTED: the direct surface has no completion notice; use delivery "await"',
        ...notes,
      ],
    }
  }

  if (!eligibility.ok && !explicitDirect(rt.cfg, shared) && rt.cfg.dispatch.allowDirectFallback !== true) {
    // A missing or rejecting provider used to become a direct run without a word. That
    // hid a degraded surface (no child session, no host capacity slot) behind a
    // normal-looking result, so the implicit fallback is opt-in now and a refusal is
    // loud: the caller asked for a provider and must not be handed something else.
    return providerUnavailable(def, started, eligibility.reason, notes)
  }

  if (eligibility.ok) {
    // The provider cannot see per-call options, so a per-call deadline has to travel
    // as the activation signal. Without this the call would silently use the harness
    // default and a short timeout would look ignored.
    const deadline = shared.delivery === 'await' && shared.timeoutMs > 0
      ? withTimeout(exec.signal, shared.timeoutMs)
      : null

    try {
      const activation = await ctx.get('subagents').startActivation({
        provider: `omc:${def.id}`,
        label: `${def.label}: ${task.prompt.slice(0, 80)}`,
        request: {
          prompt: [{ type: 'text', text: task.prompt }],
          parent: exec.agent,
          ...(cwd ? { cwd } : {}),
        },
        signal: deadline?.signal ?? exec.signal,
        delivery: shared.delivery === 'background' ? 'parent' : 'caller',
      })

      if (shared.delivery === 'background') {
        // Do NOT dispose: the activation owns the work and the host emits the
        // settlement notice when it is really finished.
        return withNotes(
          {
            status: 'started',
            harnessId: def.id,
            surface: 'provider',
            childId: activation.childId,
            output: `started subagent ${activation.childId}`,
            elapsedMs: Date.now() - started,
          },
          notes,
        )
      }

      const settled = await activation.result // settles after teardown
      try {
        await activation.dispose()
      } catch {
        // Settlement already released the slot; a dispose failure must not rewrite the result.
      }

      const timedOut = Boolean(deadline?.timedOut())
      const diagnostic = timedOut
        ? `OMC/CLI-TIMEOUT: stopped after ${shared.timeoutMs}ms`
        : settled.diagnostic || ''
      const code = /OMC\/CLI-[A-Z-]+/.exec(diagnostic)?.[0] ?? null
      const retryable = /OMC\/CLI-(RATE-LIMIT|NETWORK|TIMEOUT)/.test(diagnostic)
      return withNotes(
        {
          status: timedOut
            ? 'timeout'
            : settled.stopReason === 'completed'
              ? 'completed'
              : settled.stopReason === 'aborted'
                ? 'cancelled'
                : 'failed',
          harnessId: def.id,
          surface: 'provider',
          childId: activation.childId,
          output: blocksToText(settled.output),
          stopReason: settled.stopReason,
          sessionOutcome: /resume unconfirmed/.test(diagnostic)
            ? 'unconfirmed'
            : /session resumed/.test(diagnostic)
              ? 'resumed'
              : /session new/.test(diagnostic)
                ? 'new'
                : null,
          code,
          retryable,
          elapsedMs: Date.now() - started,
        },
        [...notes, diagnostic,
        ],
      )
    } catch (error) {
      if (deadline?.timedOut()) {
        return withNotes(
          {
            status: 'timeout',
            harnessId: def.id,
            surface: 'provider',
            output: '',
            elapsedMs: Date.now() - started,
          },
          [...notes, `OMC/CLI-TIMEOUT: stopped after ${shared.timeoutMs}ms`],
        )
      }
      const code = String(error?.code ?? '')
      const fallbackable =
        code === 'UNSUPPORTED_CAPABILITY' || code === 'UNKNOWN_PROVIDER' || code === 'CONTINUATION_UNAVAILABLE'
      if (!fallbackable) {
        return withNotes(
          {
            status: 'failed',
            harnessId: def.id,
            surface: 'provider',
            output: '',
            elapsedMs: Date.now() - started,
          },
          [...notes, code || String(error?.message ?? 'activation failed')],
        )
      }
      // Explicit direct intent never reaches this branch 閳?providerEligibility rejects it
      // first 閳?so only the flag can unlock the fallback here.
      if (rt.cfg.dispatch.allowDirectFallback !== true) {
        return providerUnavailable(def, started, `provider activation rejected the call (${code})`, notes)
      }
      // Opted into the fallback: a direct run for capability/registration gaps, and the
      // downgradeReason says exactly why the surface changed.
      return directRun(
        rt,
        def,
        task.prompt,
        cwd,
        directShared,
        exec,
        started,
        `provider activation rejected the call (${code}); direct runs have no child session or host capacity`,
        notes,
      )
    } finally {
      deadline?.dispose()
    }
  }

  return directRun(rt, def, task.prompt, cwd, directShared, exec, started, eligibility.reason, notes)
}

/**
 * The real working directory of one dispatch, resolved before any policy or
 * spawn decision (V0.5-ALPHA2 §9: a per-call mode/timeout/fallback or an
 * omitted cwd must not slip past the project policy of the actual project).
 * Mirrors the host's own rule: an absolute request cwd wins; anything else
 * resolves against the calling agent's working directory, never the Host
 * process directory.
 */
async function resolveDispatchCwd(rt, request, exec) {
  const raw = typeof request.cwd === 'string' && request.cwd.trim() !== '' ? request.cwd.trim() : null
  if (raw && isAbsolute(raw)) return raw
  let base = null
  try {
    base = (await rt.ctx.get?.('workingDirectory')?.ensure?.(exec?.agent)) ?? null
  } catch {
    base = null
  }
  if (!base && typeof exec?.agent?.session?.header?.cwd === 'string') base = exec.agent.session.header.cwd
  if (!base) base = process.cwd()
  return raw ? resolve(base, raw) : base
}

/**
 * @param {{ ctx: any, cfg: any, registered: Set<string>, detect: Function, peekReport?: Function }} rt
 * @param {{
 *   harness?: string, prompt?: string,
 *   tasks?: Array<{ harness?: string, prompt: string }>,
 *   cwd?: string, mode?: string, delivery?: 'await' | 'background', timeoutMs?: number,
 * }} request
 * @param {{ agent?: any, signal: AbortSignal }} exec
 */
export async function dispatchTasks(rt, request, exec) {
  const cfg = rt.cfg
  // A project may only tighten the operator's policy. The constrained copy is
  // used for this dispatch call; it never mutates the live configuration.
  const cwd = await resolveDispatchCwd(rt, request, exec)
  const project = readProjectPolicy(cwd)
  const effectiveCfg = project.exists && project.usable !== false ? applyProjectPolicy(cfg, project.policy) : cfg
  const callRt = effectiveCfg === cfg ? rt : { ...rt, cfg: effectiveCfg }
  const tasks = Array.isArray(request.tasks) && request.tasks.length
    ? request.tasks
    : [{ harness: request.harness ?? 'auto', model: request.model, prompt: request.prompt ?? '' }]

  if (tasks.some((task) => !String(task.prompt ?? '').trim())) {
    throw omcError('OMC/EMPTY-TASK', 'every task needs a non-empty prompt')
  }

  // Over-limit used to drop tasks silently. Losing work is never the safer option:
  // fail loudly and tell the caller how to split the batch.
  if (tasks.length > effectiveCfg.dispatch.maxParallel) {
    const calls = Math.ceil(tasks.length / effectiveCfg.dispatch.maxParallel)
    throw omcError(
      'OMC/TOO-MANY-TASKS',
      `${tasks.length} tasks exceed maxParallel=${effectiveCfg.dispatch.maxParallel}; split them into ${calls} calls of at most ${effectiveCfg.dispatch.maxParallel}`,
    )
  }
  // A policy limit is only real when the dispatch path enforces it. This is the
  // external fan-out bound; the graph tool owns the per-task oracle/review caps.
  const externalLimit = effectiveCfg.routing?.enabled === true ? effectiveCfg.routing.limits?.maxParallelExternal : undefined
  if (Number.isSafeInteger(externalLimit) && tasks.length > externalLimit) {
    throw omcError(
      'OMC/ROUTING-LIMIT',
      `${tasks.length} external tasks exceed routing.limits.maxParallelExternal=${externalLimit}; split the batch`,
    )
  }

  // R02 (external boundary): a dispatch costs money, so an exhausted parent
  // refuses the next batch HERE, before any CLI is started. This is a boundary
  // check between dispatches only — OMC cannot meter a CLI's internal rounds, so
  // it is never presented as a hard per-call cap.
  if (rt.requestGate && typeof rt.requestGate.budgetView === 'function' && typeof exec?.agent?.id === 'string') {
    const limits = resolveBudgetLimits(effectiveCfg)
    if (limits.enforce) {
      const view = rt.requestGate.budgetView({ parentId: exec.agent.id, limits })
      if (view.exhausted) {
        throw omcError(
          'OMC/BUDGET-EXHAUSTED',
          `${rt.requestGate.describe(view)}; the next external dispatch is refused (boundary control between dispatches, not a per-call cap inside the CLI)`,
        )
      }
      if (limits.maxCalls !== null && view.consumed + tasks.length > limits.maxCalls) {
        throw omcError(
          'OMC/BUDGET-EXHAUSTED',
          `a batch of ${tasks.length} would exceed maxCalls=${limits.maxCalls} (${rt.requestGate.describe(view)})`,
        )
      }
    }
  }

  // An existing project policy that cannot be understood is not an empty
  // policy: side-effect dispatch is refused with the reason, while read-only
  // work may continue (it cannot violate an unknown restriction it can see).
  const requestedMode = ['read-only', 'in-place', 'worktree'].includes(request.mode) ? request.mode : effectiveCfg.dispatch.defaultMode
  if (project.exists && project.usable === false && requestedMode !== 'read-only') {
    throw omcError(
      'OMC/PROJECT-POLICY-UNREADABLE',
      `${project.path}: ${project.warnings[0] ?? 'the project policy exists but cannot be read'}; ` +
      `mode "${requestedMode}" could bypass unknown project limits — fix or remove the file, or dispatch read-only`,
    )
  }
  // A project ceiling is only real when it also bounds the per-call request
  // (A01): a single long timeout or a write mode must not slip past a project
  // that tightened the operator's defaults.
  const projectTimeoutMs = project.usable !== false ? project.policy?.dispatch?.timeoutMs : undefined
  const projectMode = project.usable !== false ? project.policy?.dispatch?.defaultMode : undefined
  if (projectMode && MODE_RANK[requestedMode] > MODE_RANK[projectMode]) {
    throw omcError(
      'OMC/PROJECT-POLICY-MODE',
      `mode "${requestedMode}" exceeds the project policy ceiling "${projectMode}" (${project.path}); ` +
      'the project may only tighten the operator policy and a single call cannot widen it',
    )
  }
  const perCallTimeoutMs = Number.isSafeInteger(request.timeoutMs) ? request.timeoutMs : effectiveCfg.dispatch.timeoutMs

  const shared = {
    cwd,
    delivery: request.delivery === 'background' ? 'background' : 'await',
    timeoutMs: Number.isSafeInteger(projectTimeoutMs) ? Math.min(perCallTimeoutMs, projectTimeoutMs) : perCallTimeoutMs,
    mode: requestedMode,
    // The project timeout also bounds harness-level timeouts on the direct
    // surface, where hcfg.timeoutMs would otherwise override the ceiling.
    projectTimeoutMs: Number.isSafeInteger(projectTimeoutMs) ? projectTimeoutMs : null,
  }

  // 0.2.0 never runs parallel writes: a single writer per stage is the whole reason
  // the write path has no isolation yet (V0.2-PLAN 鎼?, R3). Sequential calls still work.
  if (shared.mode === 'in-place' && tasks.length > 1) {
    throw omcError(
      'OMC/PARALLEL-WRITE',
      `${tasks.length} in-place tasks would write concurrently; 0.2.0 is single-writer 閳?run them one call at a time`,
    )
  }

  // Each task is isolated: one bad harness id, disabled harness or unresolvable
  // target must not reject the whole batch and discard the other results.
  const results = await Promise.all(
    tasks.map(async (task) => {
      let taskShared = shared
      let taskWorktree = null
      if (shared.mode === 'worktree') {
        const created = await createTaskWorktree(callRt.ctx, {
          repo: request.cwd,
          name: 'task-' + String(task.harness ?? 'auto'),
          signal: exec.signal,
        })
        if (!created.ok) {
          return {
            status: 'failed',
            harnessId: normalizeId(task.harness) || 'auto',
            output: '',
            elapsedMs: 0,
            diagnostics: [created.code + ': ' + created.output],
            code: created.code,
            retryable: false,
          }
        }
        taskWorktree = created
        // Record the latest dispatch worktree so `worktree merge:true` can
        // accept it explicitly. A multi-task batch keeps each branch in its
        // result; the record is only the most recent one.
        callRt.worktrees?.record?.(exec?.agent?.id, created)
        // The disposable checkout is the write target. The CLI still sees the
        // same in-place argv; the isolation comes from the checkout, not a
        // different permission mode.
        taskShared = { ...shared, cwd: created.path, mode: 'in-place' }
      }
      const fallbacks = [
        ...(Array.isArray(request.fallbacks) ? request.fallbacks : []),
        ...(Array.isArray(task.fallbacks) ? task.fallbacks : []),
      ]
      const candidates = []
      for (const candidate of [task.harness, ...fallbacks]) {
        const id = normalizeId(candidate) || 'auto'
        if (!candidates.includes(id)) candidates.push(id)
      }
      const attempts = []
      let last = null
      for (const candidate of candidates) {
        try {
          const target = await resolveTarget(callRt, candidate)
          last = await runOne(callRt, target.def, task, taskShared, exec, target.warning)
          attempts.push({
            harness: target.def.id,
            status: last.status,
            ...(last.code ? { code: last.code } : {}),
            retryable: last.retryable === true,
          })
          // A running background task has no result to classify yet; a
          // completed/cancelled result is final. Only a failed retryable result
          // advances to the next fallback.
          if (last.status === 'completed' || last.status === 'cancelled' || last.status === 'started') break
          if (last.retryable !== true) break
        } catch (error) {
          attempts.push({ harness: candidate, status: 'failed', code: error?.code ?? null, retryable: false })
          last = {
            status: 'failed',
            harnessId: candidate,
            output: '',
            elapsedMs: 0,
            diagnostics: [String(error?.message ?? error?.code ?? 'dispatch failed')],
            retryable: false,
          }
          // An unknown/disabled primary should still let an explicitly listed
          // fallback run; a bad fallback is just the next failed attempt.
        }
      }
      if (last && taskWorktree) {
        const captured = await captureTaskWorktree(callRt.ctx, taskWorktree.path, { signal: exec.signal })
        last = {
          ...last,
          code: last.code ?? (captured.ok ? null : 'OMC/WORKTREE-CAPTURE'),
          worktree: {
            path: taskWorktree.path,
            branch: taskWorktree.branch,
            baseCommit: taskWorktree.baseCommit,
            repositoryRoot: taskWorktree.repositoryRoot,
          },
          files: captured.files,
          diff: captured.diff,
          statusText: captured.status,
        }
      }
      return last
        ? { ...last, ...(attempts.length > 1 ? { attempts } : {}) }
        : {
            status: 'failed',
            harnessId: 'auto',
            output: '',
            elapsedMs: 0,
            diagnostics: ['no harness candidate was provided'],
            retryable: false,
          }
    }),
  )

  return {
    results: results.map(clean),
    maxParallel: effectiveCfg.dispatch.maxParallel,
    delivery: shared.delivery,
    ...(project.exists ? {
      project: { path: project.path, warnings: project.warnings ?? [] },
    } : {}),
  }
}


