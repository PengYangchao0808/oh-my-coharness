/**
 * Dispatch: DispatchRequest → real execution → DispatchResult[].
 *
 * Provider first, direct only as a fallback. The difference matters: with a provider
 * the host owns capacity, cancellation and the completion notice; a direct run is a
 * degraded surface that doctor reports as such (ADAPTER §6.3).
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

async function resolveTarget(rt, raw) {
  const id = normalizeId(raw)

  if (id && id !== 'auto') {
    const def = harnessDef(id)
    if (!def) throw omcError('OMC/UNKNOWN-HARNESS', `unknown harness "${raw}"`)
    if (!isEnabled(rt.cfg, def.id)) throw omcError('OMC/NO-PROVIDER', `${def.id} is disabled in config`)
    return def
  }

  const report = await rt.detect()
  const usable = report.rows.filter((row) => row.auth !== 'missing')
  if (!usable.length) throw omcError('OMC/CLI-MISSING', 'no harness is installed; run /coharness doctor')
  return harnessDef(usable[0].id)
}

async function directRun(rt, def, prompt, cwd, shared, exec, started) {
  const { ctx, cfg } = rt
  const hcfg = harnessConfig(cfg, def.id)
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

    return {
      status,
      harnessId: def.id,
      output: captured.stdout || captured.stderr,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      truncated: captured.truncated,
      spillPath: captured.spillPath,
      elapsedMs: Date.now() - started,
      diagnostics:
        status === 'failed'
          ? [`OMC/CLI-EXIT: ${def.id} exited ${outcome.exitCode ?? outcome.signal}`]
          : undefined,
    }
  } catch (error) {
    return {
      status: 'failed',
      harnessId: def.id,
      output: '',
      elapsedMs: Date.now() - started,
      diagnostics: [String(error?.code ?? error?.message ?? 'launch failed')],
    }
  } finally {
    deadline?.dispose()
  }
}

async function runOne(rt, def, task, shared, exec) {
  const { ctx, cfg } = rt
  const started = Date.now()
  const cwd = shared.cwd
  const subagents = ctx.get('subagents')
  const useProvider =
    cfg.surface !== 'direct' &&
    Boolean(subagents) &&
    rt.registered.has(def.id) &&
    Boolean(exec.agent) &&
    // A per-call mode cannot travel through the provider surface, so honouring it
    // means taking the direct path. Silently ignoring it would be worse.
    shared.mode === cfg.dispatch.defaultMode

  if (useProvider) {
    // The provider cannot see per-call options, so a per-call deadline has to travel
    // as the activation signal. Without this the call would silently use the harness
    // default and a short timeout would look ignored.
    const deadline = shared.delivery === 'await' && shared.timeoutMs > 0
      ? withTimeout(exec.signal, shared.timeoutMs)
      : null

    try {
      const activation = await subagents.startActivation({
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
        return {
          status: 'started',
          harnessId: def.id,
          childId: activation.childId,
          output: `started subagent ${activation.childId}`,
          elapsedMs: Date.now() - started,
        }
      }

      const settled = await activation.result // settles after teardown
      try {
        await activation.dispose()
      } catch {
        // Settlement already released the slot; a dispose failure must not rewrite the result.
      }

      const timedOut = Boolean(deadline?.timedOut())
      return {
        status: timedOut
          ? 'timeout'
          : settled.stopReason === 'completed'
            ? 'completed'
            : settled.stopReason === 'aborted'
              ? 'cancelled'
              : 'failed',
        harnessId: def.id,
        childId: activation.childId,
        output: blocksToText(settled.output),
        stopReason: settled.stopReason,
        elapsedMs: Date.now() - started,
        diagnostics: timedOut
          ? [`OMC/CLI-TIMEOUT: stopped after ${shared.timeoutMs}ms`]
          : settled.diagnostic
            ? [settled.diagnostic]
            : undefined,
      }
    } catch (error) {
      if (deadline?.timedOut()) {
        return {
          status: 'timeout',
          harnessId: def.id,
          output: '',
          elapsedMs: Date.now() - started,
          diagnostics: [`OMC/CLI-TIMEOUT: stopped after ${shared.timeoutMs}ms`],
        }
      }
      const code = String(error?.code ?? '')
      const fallbackable =
        code === 'UNSUPPORTED_CAPABILITY' || code === 'UNKNOWN_PROVIDER' || code === 'CONTINUATION_UNAVAILABLE'
      if (!fallbackable) {
        return {
          status: 'failed',
          harnessId: def.id,
          output: '',
          elapsedMs: Date.now() - started,
          diagnostics: [code || String(error?.message ?? 'activation failed')],
        }
      }
      // Fall through to a direct run only for capability/registration gaps.
    } finally {
      deadline?.dispose()
    }
  }

  return directRun(rt, def, task.prompt, cwd, shared, exec, started)
}

/**
 * @param {{ ctx: any, cfg: any, registered: Set<string>, detect: Function }} rt
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

  const shared = {
    cwd: request.cwd,
    delivery: request.delivery === 'background' ? 'background' : 'await',
    timeoutMs: Number.isSafeInteger(request.timeoutMs) ? request.timeoutMs : cfg.dispatch.timeoutMs,
    mode: ['read-only', 'in-place', 'worktree'].includes(request.mode) ? request.mode : cfg.dispatch.defaultMode,
  }

  const admitted = tasks.slice(0, cfg.dispatch.maxParallel)
  const results = await Promise.all(
    admitted.map(async (task) => {
      const target = await resolveTarget(rt, task.harness)
      return runOne(rt, target, task, shared, exec)
    }),
  )

  return {
    results: results.map(clean),
    omitted: tasks.length - admitted.length,
    maxParallel: cfg.dispatch.maxParallel,
    delivery: shared.delivery,
  }
}
