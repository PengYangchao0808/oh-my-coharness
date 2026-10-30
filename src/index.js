/**
 * Oh My CoHarness — Host entry.
 *
 * Surfaces, in order of importance (PLAN §3.1):
 *   provider  omc:<id>   → external CLI as a real DSH child session
 *   tool      coharness  → one tool, stable actions/schema
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
import { applyMigrationCommand } from './migrate.js'
import { buildExecutionStatus, detectLegacyCompanion, renderExecutionStatus } from '../integration/status.js'
import { createSessionRegistry } from '../integration/sessions.js'

export const inject = ['tools', 'subprocess']

const DESCRIPTION = [
  'Hand a task to an AI coding CLI that is installed on this machine (Codex, Claude Code, Gemini CLI, Kimi, opencode …)',
  'and get its real result back. Use it when the user names a specific CLI, asks for a second opinion from another agent,',
  'or when another toolchain/model should do the work.',
  '',
  "Actions: `list` shows what is installed (free, no model calls); `status` shows role → execution backend and which",
  '`omc:<id>` providers are registered (free); `doctor` returns a copyable diagnostic report (free); `sessions` lists the',
  'native CLI session references OMC may reuse (free; pass `clear: true` to forget them, which never deletes CLI history);',
  '`migrate` previews the pre-0.4 configuration migration (pass `apply: true` to write it); `dispatch` runs real work and',
  'costs that CLI’s own quota.',
  '',
  'The specialist roles (`subagent_oracle`, `subagent_explorer`, council seats) may be configured to run on one of these',
  'providers. That provider surface is fixed read-only; `dispatch` with `mode: "in-place"` uses the direct surface.',
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
  lines.push('note: `omc:<id>` providers used by roles are fixed read-only; a write mode takes the `direct` surface.')
  lines.push('note: `surface: direct` has no childId, no host capacity slot and no sub-session; only `provider` gets those.')
  if (payload.delivery === 'background') {
    lines.push('Background runs report through the completion notice. Do not claim them as finished before it arrives.')
  }
  return lines.join('\n').trim()
}

/** Session references are metadata, never a conversation or a credential. */
function renderSessions(registry) {
  const stats = registry.stats()
  const lines = [
    `session registry: ${stats.entries} entries · ${stats.resumable} resumable · reuse ${stats.enabled ? 'on' : 'off'} · policy ${stats.resumePolicy}`,
  ]
  if (stats.loadError) lines.push(`  unreadable registry: ${stats.loadError}`)
  const rows = registry.list({ limit: 20 })
  if (!rows.length) {
    lines.push('  no native session references stored')
  } else {
    lines.push('  lane / role / harness / state / turns / last used / session')
    for (const row of rows) {
      lines.push(
        `  ${String(row.laneId).padEnd(28)}${String(row.role).padEnd(18)}${String(row.harness).padEnd(12)}` +
        `${String(row.state).padEnd(13)}${String(row.turns ?? 0).padEnd(6)}${String(row.lastUsedAt ?? '-').padEnd(22)}${row.sessionId || '-'}`,
      )
    }
  }
  lines.push('note: clearing references never deletes the CLI provider\'s own history.')
  return lines.join('\n')
}

/** Role execution + provider state, without probing any CLI. */
async function executionStatusText(ctx, cfg, registry) {
  const [status, legacy] = await Promise.all([
    buildExecutionStatus(ctx, cfg, { registry }),
    detectLegacyCompanion(ctx),
  ])
  return renderExecutionStatus(status, { legacy }).join('\n')
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
          enum: ['dispatch', 'list', 'status', 'doctor', 'migrate', 'sessions'],
          description: 'dispatch = run work; list = who is available (free); status = role execution backends, provider state and session reuse (free); doctor = full diagnostic report (free); sessions = OMC native-session references (free; clear:true forgets them); migrate = preview the pre-0.4 configuration migration (pass apply:true to write).',
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
          description: 'read-only (default) forbids edits; in-place lets the CLI write here (direct surface only); worktree is not implemented in 0.5.0-alpha.1.',
        },
        delivery: {
          type: 'string',
          enum: ['await', 'background'],
          description: 'await returns the result in this call; background returns a child id and reports later.',
        },
        timeoutMs: { type: 'number', description: 'Deadline for this run in milliseconds.' },
        apply: { type: 'boolean', description: 'For action migrate: write the migrated configuration. Omit/false = preview only.' },
        force: { type: 'boolean', description: 'For action migrate: overwrite conflicting current values (a backup is always written first).' },
        rollback: { type: 'boolean', description: 'For action migrate: restore the latest migration backup.' },
        clear: { type: 'boolean', description: 'For action sessions: forget every OMC session reference. CLI-native histories are not deleted.' },
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

      if (action === 'status') {
        return { text: await executionStatusText(rt.ctx, rt.cfg, rt.sessions) }
      }

      if (action === 'sessions') {
        if (args.clear === true) {
          rt.sessions.clear()
          return { text: 'cleared OMC session references; CLI-native histories were not touched' }
        }
        return { text: renderSessions(rt.sessions) }
      }

      if (action === 'migrate') {
        const result = await applyMigrationCommand(rt.ctx, args.rollback === true
          ? { rollback: true }
          : { apply: args.apply === true, force: args.force === true })
        return { text: result.text }
      }

      if (action !== 'dispatch') {
        return { text: `unknown action "${action}"; use dispatch, list, status, doctor, sessions, or migrate` }
      }

      if (args.mode === 'worktree') {
        return { text: 'worktree mode is not implemented in 0.5.0-alpha.1; use read-only or in-place' }
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
    description: 'Diagnose external CLIs, inspect role execution backends and native-session reuse, and migrate the pre-0.4 configuration.',
    input: { hint: 'doctor | status | sessions [--clear] | migrate [--apply] [--force] | migrate --rollback' },
    handler: async (invocation) => {
      rt.ensureProviders?.()
      const raw = String(invocation?.rawInput ?? '').trim()
      const tokens = raw.replace(/^\/?coharness\b/i, '').trim().split(/\s+/).filter(Boolean)
      const topic = tokens[0] ?? 'doctor'
      const flags = new Set(tokens.slice(1).map((token) => token.toLowerCase()))

      if (topic === 'doctor' || topic === 'help' || topic === '') {
        if (topic === 'help') {
          return {
            kind: 'success',
            text: [
              '/coharness doctor            full diagnostic report (CLIs, providers, role backends)',
              '/coharness status            role → backend table, provider registration and session reuse',
              '/coharness sessions          OMC native-session references (clear with --clear)',
              '/coharness migrate           preview the OMD → OMC configuration migration',
              '/coharness migrate --apply   back up, then write the migrated configuration',
              '/coharness migrate --force   overwrite conflicting values (backup is still written)',
              '/coharness migrate --rollback restore the pre-migration configuration',
            ].join('\n'),
          }
        }
        const report = await rt.detect(true)
        return { kind: 'success', text: renderReport(report, rt.cfg, rt.providerState?.()) }
      }

      if (topic === 'status') {
        return { kind: 'success', text: await executionStatusText(rt.ctx, rt.cfg, rt.sessions) }
      }

      if (topic === 'sessions') {
        if (flags.has('--clear')) {
          rt.sessions.clear()
          return { kind: 'success', text: 'cleared OMC session references; CLI-native histories were not touched' }
        }
        return { kind: 'success', text: renderSessions(rt.sessions) }
      }

      if (topic === 'migrate') {
        try {
          const result = flags.has('--rollback')
            ? await applyMigrationCommand(rt.ctx, { rollback: true })
            : await applyMigrationCommand(rt.ctx, {
              apply: flags.has('--apply'),
              force: flags.has('--force'),
            })
          return { kind: 'success', text: result.text }
        } catch (error) {
          return { kind: 'error', text: `coharness migrate failed: ${String(error?.message ?? error)}` }
        }
      }

      return {
        kind: 'error',
        text: `unknown /coharness topic "${topic}"; use doctor, status, sessions, or migrate`,
      }
    },
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const sessions = createSessionRegistry(cfg.sessions)

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
    sessions,
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
        const provider = makeProvider(ctx, def, cfg, { readOnly: true, registry: sessions })
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
