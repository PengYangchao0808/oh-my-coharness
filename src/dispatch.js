/**
 * Dispatch: DispatchRequest → real execution → DispatchResult[].
 *
 * Provider first, direct only as a fallback. The difference matters: with a provider
 * the host owns capacity, cancellation and the completion notice; a direct run is a
 * degraded surface that doctor reports as such (ADAPTER §6.3). Every result therefore
 * says which surface produced it and, when it had to degrade, why (V0.2-PLAN §6.2).
 */

import { harnessDef, normalizeId } from './harnesses.js'
import { harnessConfig, isEnabled } from './config.js'
import { harnessEnv, launch, planTransport, readCollected, statusOf, withTimeout } from './transport.js'
import { blocksToText } from './provider.js'

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
    throw omcError('OMC/CLI-MISSING', `no usable harness for auto — ${detail}; run /coharness doctor`)
  }
  const [best] = [...eligible].sort((a, b) => autoRank(a) - autoRank(b))
  return { def: harnessDef(best.id) }
}

async function directRun(rt, def, prompt, cwd, shared, exec, started, reason, notes = []) {
  const { ctx, cfg } = rt
  const hcfg = harnessConfig(cfg, def.id)
  // The direct surface has no child session and no host capacity slot; saying so on
  // every result is what keeps a degraded run from being read as full support.
  const surface = { surface: 'direct', downgradeReason: reason || 'direct runs have no child session or host capacity' }
  let deadline
  try {
    const plan = await planTransport(ctx, def, cfg, exec.signal)
    const launched = await launch(ctx, def, {
      task: prompt,
      cwd,
      model: hcfg.model || undefined,
      mode: shared.mode,
      env: harnessEnv(def, hcfg),
      plan,
      timeoutMs: hcfg.timeoutMs || shared.timeoutMs,
      maxOutputBytes: cfg.dispatch.maxOutputBytes,
      signal: exec.signal,
    })
    deadline = launched.deadline
    const outcome = await launched.handle.done
    const captured = readCollected(launched.handle, cfg.dispatch.maxOutputBytes)
    const status = statusOf(outcome, deadline, exec.signal)

    return withNotes(
      {
        status,
        harnessId: def.id,
        ...surface,
        output: captured.stdout || captured.stderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        truncated: captured.truncated,
        spillPath: captured.spillPath,
        elapsedMs: Date.now() - started,
      },
      [...notes, status === 'failed' ? `OMC/CLI-EXIT: ${def.id} exited ${outcome.exitCode ?? outcome.signal}` : ''],
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
          elapsedMs: Date.now() - started,
        },
        [
          ...notes,
          timedOut
            ? `OMC/CLI-TIMEOUT: stopped after ${shared.timeoutMs}ms`
            : settled.diagnostic || '',
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
      // Fall through to a direct run only for capability/registration gaps, and say
      // exactly why the surface changed.
      return directRun(
        rt,
        def,
        task.prompt,
        cwd,
        shared,
        exec,
        started,
        `provider activation rejected the call (${code}); direct runs have no child session or host capacity`,
        notes,
      )
    } finally {
      deadline?.dispose()
    }
  }

  return directRun(rt, def, task.prompt, cwd, shared, exec, started, eligibility.reason, notes)
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
  const tasks = Array.isArray(request.tasks) && request.tasks.length
    ? request.tasks
    : [{ harness: request.harness ?? 'auto', prompt: request.prompt ?? '' }]

  if (tasks.some((task) => !String(task.prompt ?? '').trim())) {
    throw omcError('OMC/EMPTY-TASK', 'every task needs a non-empty prompt')
  }

  // Over-limit used to drop tasks silently. Losing work is never the safer option:
  // fail loudly and tell the caller how to split the batch.
  if (tasks.length > cfg.dispatch.maxParallel) {
    const calls = Math.ceil(tasks.length / cfg.dispatch.maxParallel)
    throw omcError(
      'OMC/TOO-MANY-TASKS',
      `${tasks.length} tasks exceed maxParallel=${cfg.dispatch.maxParallel}; split them into ${calls} calls of at most ${cfg.dispatch.maxParallel}`,
    )
  }

  const shared = {
    cwd: request.cwd,
    delivery: request.delivery === 'background' ? 'background' : 'await',
    timeoutMs: Number.isSafeInteger(request.timeoutMs) ? request.timeoutMs : cfg.dispatch.timeoutMs,
    mode: ['read-only', 'in-place', 'worktree'].includes(request.mode) ? request.mode : cfg.dispatch.defaultMode,
  }

  // 0.2.0 never runs parallel writes: a single writer per stage is the whole reason
  // the write path has no isolation yet (V0.2-PLAN §7, R3). Sequential calls still work.
  if (shared.mode === 'in-place' && tasks.length > 1) {
    throw omcError(
      'OMC/PARALLEL-WRITE',
      `${tasks.length} in-place tasks would write concurrently; 0.2.0 is single-writer — run them one call at a time`,
    )
  }

  // Each task is isolated: one bad harness id, disabled harness or unresolvable
  // target must not reject the whole batch and discard the other results.
  const results = await Promise.all(
    tasks.map(async (task) => {
      try {
        const target = await resolveTarget(rt, task.harness)
        return await runOne(rt, target.def, task, shared, exec, target.warning)
      } catch (error) {
        return {
          status: 'failed',
          harnessId: normalizeId(task.harness) || 'auto',
          output: '',
          elapsedMs: 0,
          diagnostics: [String(error?.message ?? error?.code ?? 'dispatch failed')],
        }
      }
    }),
  )

  return {
    results: results.map(clean),
    maxParallel: cfg.dispatch.maxParallel,
    delivery: shared.delivery,
  }
}
