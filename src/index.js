/**
 * Oh My CoHarness — Host entry.
 *
 * Surfaces, in order of importance (PLAN §3.1):
 *   provider  omc:<id>   → external CLI as a real DSH child session
 *   tool      coharness  → one tool, three actions, stable schema
 *   command   /coharness → free, model-free diagnostics
 *   skills    coharness* → routing discipline the model can load on demand
 *
 * No client half, no dependencies, no build step.
 */

import { resolveConfig, isEnabled } from './config.js'
import { HARNESSES } from './harnesses.js'
import { makeProvider } from './provider.js'
import { dispatchTasks } from './dispatch.js'
import { detect, renderReport } from './doctor.js'
import { registerSkills } from './skills.js'

export const inject = ['tools', 'subprocess']

const DESCRIPTION = [
  'Hand a task to an AI coding CLI that is installed on this machine (Codex, Claude Code, Gemini CLI, Kimi, opencode …)',
  'and get its real result back. Use it when the user names a specific CLI, asks for a second opinion from another agent,',
  'or when another toolchain/model should do the work.',
  '',
  "Actions: `list` shows what is installed (free, no model calls); `doctor` returns a copyable diagnostic report (free);",
  '`dispatch` runs real work and costs that CLI’s own quota.',
  '',
  'For an independent review, dispatch two read-only tasks to two different harnesses in one call; for multi-stage work',
  'load the `coharness-ulw` skill.',
  'Rules the tool enforces: dispatch defaults to read-only; an over-limit batch is refused instead of dropping tasks;',
  "and `delivery:'background'` returns a child id immediately — that is NOT completion, wait for the completion notice.",
  'Use the ordinary `subagent` tool for in-process DSH children; this one is for external harnesses.',
].join(' ')

function text(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

function compactRows(rows) {
  const lines = [`${'harness'.padEnd(12)}${'transport'.padEnd(10)}${'auth'.padEnd(12)}version`]
  for (const row of rows) {
    lines.push(`${row.id.padEnd(12)}${String(row.transport ?? '-').padEnd(10)}${String(row.auth).padEnd(12)}${row.version ?? '-'}`)
  }
  return lines.join('\n')
}

function renderDispatch(payload) {
  const lines = []
  for (const [index, result] of payload.results.entries()) {
    const surface = result.surface === 'provider' ? 'provider' : result.surface === 'direct' ? 'direct' : '-'
    const child = result.childId ? ` · child ${result.childId}` : ''
    lines.push(
      `#${index + 1} ${result.harnessId} · ${result.status} · ${((result.elapsedMs ?? 0) / 1000).toFixed(1)}s · surface: ${surface}${child}`,
    )
    if (result.downgradeReason) lines.push(`   degraded: ${result.downgradeReason}`)
    // Never let a degraded surface go unexplained: silence reads as full support.
    else if (result.surface === 'direct') lines.push('   degraded: direct surface (no reason reported)')
    if (result.diagnostics?.length) lines.push(`   note: ${result.diagnostics.join(' · ')}`)
    if (result.truncated) lines.push('   note: output clipped; full stream in the spill file')
    if (result.output) lines.push(result.output)
    lines.push('')
  }
  lines.push(
    'note: `mode` maps onto the CLIs that expose a sandbox flag (codex `-s`, gemini `--approval-mode`, antigravity `--sandbox`); the others keep their own default permission model.',
  )
  lines.push('note: `surface: direct` has no childId, no host capacity slot and no sub-session; only `provider` gets those.')
  if (payload.delivery === 'background') {
    lines.push('Background runs report through the completion notice. Do not claim them as finished before it arrives.')
  }
  return lines.join('\n').trim()
}

/**
 * @param {{ ctx: any, cfg: any, registered: Set<string>, detect(force?: boolean): Promise<any> }} rt
 */
function coharnessTool(rt) {
  return {
    name: 'coharness',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['dispatch', 'list', 'doctor'],
          description: 'dispatch = run work; list = who is available (free); doctor = diagnostic report (free).',
        },
        harness: {
          type: 'string',
          description: "Harness id such as 'codex', 'claude', 'gemini', 'kimi', or 'auto' to pick the first usable one.",
        },
        prompt: {
          type: 'string',
          description: 'Self-contained task for the external CLI. It cannot see this conversation, so include every needed fact.',
        },
        tasks: {
          type: 'array',
          description: 'Several independent tasks to run concurrently. Prefer this over separate calls when the work is parallel.',
          items: {
            type: 'object',
            properties: {
              harness: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
        cwd: { type: 'string', description: 'Working directory for the run. Defaults to the session directory.' },
        mode: {
          type: 'string',
          enum: ['read-only', 'in-place', 'worktree'],
          description: 'read-only (default) forbids edits; in-place lets the CLI write here; worktree is not implemented in 0.2.0.',
        },
        delivery: {
          type: 'string',
          enum: ['await', 'background'],
          description: 'await returns the result in this call; background returns a child id and reports later.',
        },
        timeoutMs: { type: 'number', description: 'Deadline for this run in milliseconds.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return text(value?.text)
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      // A Loader may have loaded this plugin before the subagents service existed.
      // Retrying here is what turns the provider surface on without a restart.
      rt.ensureProviders?.()
      const action = String(args?.action ?? '')

      if (action === 'list') {
        const report = await rt.detect()
        return { text: compactRows(report.rows) }
      }

      if (action === 'doctor') {
        const report = await rt.detect(true)
        return { text: renderReport(report, rt.cfg, rt.providerState?.()) }
      }

      if (action !== 'dispatch') {
        return { text: `unknown action "${action}"; use dispatch, list, or doctor` }
      }

      if (args.mode === 'worktree') {
        return { text: 'worktree mode is not implemented in 0.2.0; use read-only or in-place' }
      }

      const payload = await dispatchTasks(rt, args, {
        agent: exec?.agent,
        signal: exec?.signal ?? new AbortController().signal,
      })
      return { text: renderDispatch(payload) }
    },
  }
}

function coharnessCommand(rt) {
  return {
    name: 'coharness',
    description: 'Diagnose the external coding CLIs this machine can dispatch to.',
    handler: async () => {
      rt.ensureProviders?.()
      const report = await rt.detect(true)
      return { kind: 'success', text: renderReport(report, rt.cfg, rt.providerState?.()) }
    },
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  /** @type {Set<string>} */
  const registered = new Set()
  /** @type {string[]} */
  const providerIssues = []
  let attempted = false
  let cachedReport = null

  const rt = {
    ctx,
    cfg,
    registered,
    /**
     * Registration is retried on every entry point. A Loader may apply this plugin
     * before the `subagents` row exists (row order is not ours to control), and a
     * one-shot attempt at apply time then silently loses the whole provider surface.
     * Registering again later is safe: the Set makes it idempotent.
     */
    ensureProviders,
    providerState() {
      return { registered: [...registered], issues: [...providerIssues], attempted }
    },
    async detect(force = false) {
      if (!cachedReport || force) cachedReport = await detect(ctx, cfg)
      return cachedReport
    },
    /**
     * The cached report, never a fresh probe: dispatch uses it only to add a
     * best-effort `signed-out` warning and must not pay for a full discovery pass.
     */
    peekReport() {
      return cachedReport
    },
  }

  // ── providers ───────────────────────────────────────────────────────────────
  function ensureProviders() {
    const subagents = ctx.get('subagents')
    if (!subagents || cfg.surface === 'direct') return registered
    attempted = true

    const existing = new Set(subagents.list?.() ?? [])
    for (const def of HARNESSES) {
      if (!isEnabled(cfg, def.id) || registered.has(def.id)) continue
      const name = `omc:${def.id}`
      if (existing.has(name)) continue // another plugin already owns this name; never shadow it
      try {
        const provider = makeProvider(ctx, def, cfg)
        ctx.effect(() => subagents.registerProvider(provider))
        registered.add(def.id)
      } catch (error) {
        // Keep the other harnesses usable; doctor prints the exact reason.
        const detail = `${def.id}: ${String(error?.message ?? error).slice(0, 200)}`
        if (!providerIssues.includes(detail)) providerIssues.push(detail)
      }
    }
    return registered
  }

  // `ctx.inject` runs the callback now if the service exists and again when it
  // appears, which is the load-order-safe path. Wrapped: an older Cordis without
  // this signature must not take the whole plugin down.
  try {
    ctx.inject?.(['subagents'], () => ensureProviders())
  } catch {
    // Fall back to the entry-point retries below.
  }
  ensureProviders()

  // ── tool ────────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(coharnessTool(rt)))

  // ── command ─────────────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands?.register) {
    ctx.effect(() => commands.register(coharnessCommand(rt)))
  }

  // ── skills ──────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposers = registerSkills(ctx)
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
