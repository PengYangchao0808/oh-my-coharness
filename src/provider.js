/**
 * Subagent provider factory.
 *
 * One provider per harness, named `omc:<id>`. Registering these is what turns
 * "run a CLI" into a first-class DSH child session: capacity, cancellation,
 * catalogue, completion notice and interrupt all come from `ctx.subagents`
 * (PLAN §3.2, ADAPTER §5).
 *
 * v0.5 adds a second, independent identity. The DSH child id belongs to this
 * run; a native CLI session id belongs to the CLI's own conversation. They are
 * never interchangeable. The provider may resume the latter through the
 * registry, but every DSH run still gets a fresh child id.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

import { handoffFromPrompt, normalizeWorkspace } from '../integration/handoff.js'
import { sessionKeyFor } from '../integration/sessions.js'
import { adapterFor } from './adapters.js'
import { harnessConfig } from './config.js'
import { mintRunId } from './ids.js'
import { maskSessionId } from './session-adapters.js'
import { clip, harnessEnv, planTransport } from './transport.js'
import { classifyCliResult } from '../integration/cli-result.js'
import { normalizeUsageBuckets } from '../integration/usage-ledger.js'

/** Prompt content blocks → plain task text. Never invents capabilities. */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(String(block.text ?? ''))
    else if (block.type === 'image') parts.push('[omc: image attachment omitted — this harness cannot receive images from DSH]')
    else if (block.type === 'file') parts.push(`[omc: file attachment omitted: ${block.attachment?.name ?? 'file'}]`)
  }
  return parts.join('\n').trim()
}

function failureText(def, status, outcome, captured, parsedText) {
  const exit = outcome.exitCode === null ? outcome.signal : outcome.exitCode
  const tail = parsedText || captured.stderr || captured.stdout || '(no output)'
  return `${def.label} did not complete (${status}, exit ${exit}).\n\n${tail}`
}

function providerError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * Endpoint identity without the secret. The env-file mtime is included so a
 * rotated token in the same file starts a new native session instead of
 * silently continuing under a different account.
 */
function endpointFingerprint(def, hcfg, env) {
  const baseUrl = env.ANTHROPIC_BASE_URL
    ?? env.OPENAI_BASE_URL
    ?? env.OPENAI_API_BASE
    ?? env.GEMINI_API_BASE_URL
    ?? env.MOONSHOT_BASE_URL
    ?? ''
  let envFileEpoch = ''
  if (hcfg.envFile) {
    try {
      envFileEpoch = String(statSync(hcfg.envFile).mtimeMs)
    } catch {
      envFileEpoch = 'missing'
    }
  }
  return createHash('sha256')
    .update(`${def.id}|${baseUrl}|${hcfg.envFile ?? ''}|${envFileEpoch}`)
    .digest('hex')
    .slice(0, 12)
}

function usageText(usage) {
  if (!usage) return ''
  const parts = []
  if (usage.inputTokens !== null) parts.push(`in ${usage.inputTokens}`)
  if (usage.outputTokens !== null) parts.push(`out ${usage.outputTokens}`)
  if (usage.cachedInputTokens !== null) parts.push(`cached ${usage.cachedInputTokens}`)
  if (usage.costUsd !== null) parts.push(`cost $${usage.costUsd}`)
  return parts.join(' / ')
}

/**
 * @param {{ subprocess: any }} ctx
 * @param {import('./harnesses.js').HarnessDef} def
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} cfg
 * @param {{ readOnly?: boolean, registry?: object }} [options] - the provider
 *   surface is read-only by design; `registry` is the shared session registry.
 */
export function makeProvider(ctx, def, cfg, options = {}) {
  const registry = options.registry ?? null
  const usageLedger = options.usageLedger ?? null

  /**
   * Book one external dispatch into the usage ledger (R02/R05).
   *
   * One dispatch is one booked attempt: the CLI's own internal rounds are
   * invisible to OMC, so this is an attempt record, not a per-request one.
   * Without a reported usage the entry stays `unknown`; it is never zero.
   * A missing parent identity means the cost cannot be attributed, so nothing
   * is booked and the caller sees no fabricated figure.
   */
  function bookExternalUsage({ runId, parentId, model, usage, sessionId }) {
    if (!usageLedger || typeof usageLedger.append !== 'function') return null
    if (typeof parentId !== 'string' || parentId === '' || typeof runId !== 'string' || runId === '') return null
    const normalized = usage ? normalizeUsageBuckets(usage) : null
    try {
      return usageLedger.append({
        parentId,
        taskId: runId,
        attemptId: `${runId}#dispatch`,
        backend: 'external',
        source: { kind: 'external-cli', runId, eventId: runId, sessionId: sessionId ?? null },
        // The CLI decides its own model; the configured route is what was asked
        // for, so it is recorded but never marked as an observed request route.
        route: { provider: `omc:${def.id}`, model: model ?? null, effort: null, observed: false },
        usage: normalized ? normalized.buckets : null,
        coverage: normalized ? normalized.coverage : 'unknown',
        cost: usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0
          ? { usd: usage.costUsd, source: 'cli-reported' }
          : null,
      })
    } catch {
      // Accounting must never turn a completed dispatch into a failure.
      return null
    }
  }

  return {
    name: `omc:${def.id}`,
    // An external CLI cannot see this conversation; the host turns that flag into
    // the correct model-facing wording for free.
    inheritsParentContext: false,
    capabilities: {
      agentOptions: false, // do not impose DSH model routing on a CLI
      agentPreset: false,
      outputSchema: false,
      depthLimit: false, // recursion budget belongs to the CLI
    },

    async start(request) {
      const sessionCfg = cfg.sessions ?? {}
      const rawPrompt = blocksToText(request.prompt)
      const identity = handoffFromPrompt(rawPrompt, { cwd: request.cwd })
      const task = identity.text
      const handoff = identity.handoff
      const hcfg = harnessConfig(cfg, def.id)
      const plan = await planTransport(ctx, def, cfg, request.signal)
      const env = harnessEnv(def, hcfg)
      const harnessAdapter = adapterFor(def, cfg)
      if (harnessAdapter.supported !== true) {
        throw providerError(
          'OMC/ADAPTER-UNSUPPORTED',
          `${def.id}: ${harnessAdapter.reason ?? 'this transport is not available'}`,
        )
      }

      const sessionAdapter = def.session
      const confidence = sessionAdapter?.confidence ?? 'unverified'
      const adapterAllowed = confidence === 'verified'
        || confidence === 'documented'
        || sessionCfg.allowUnverified === true
      const sessionsOn = sessionCfg.enabled !== false
      // A session key needs a real workspace. Without an explicit cwd the CLI
      // inherits the Host process directory, which is not the user's project;
      // reusing across that boundary would mix unrelated projects.
      const hasWorkspace = typeof request.cwd === 'string' && request.cwd.trim() !== ''
      // Only a signed marker built by this Host process may name a lane. A
      // legacy v0.4 brief or a direct dispatch prompt never resumes a session.
      const workspace = normalizeWorkspace(request.cwd ?? process.cwd())
      const capture = Boolean(
        sessionsOn && sessionAdapter && adapterAllowed && handoff && identity.source === 'marker' && hasWorkspace && registry
        && handoff.workspace.path === workspace,
      )
      if (sessionCfg.resumePolicy === 'require-resume' && !capture) {
        throw providerError('OMC/SESSION-REQUIRED', 'require-resume needs a trusted role handoff, an explicit workspace, an enabled registry and an allowed session adapter')
      }
      const key = capture
        ? sessionKeyFor({
            projectId: handoff.projectId,
            laneId: handoff.laneId,
            role: handoff.role,
            harness: def.id,
            model: hcfg.model || '',
            environment: plan.transport === 'wsl' ? `wsl:${plan.distro ?? ''}` : 'native',
            workspace,
            endpoint: endpointFingerprint(def, hcfg, env),
          })
        : null

      let lease = null
      let resumeId = null
      let sessionNote = ''

      if (capture) {
        try {
          lease = await registry.acquire(key, { signal: request.signal, requireResume: sessionCfg.resumePolicy === 'require-resume' })
          resumeId = lease.record?.native?.sessionId ?? null
        } catch (error) {
          if (request.signal?.aborted) throw error
          if (sessionCfg.resumePolicy === 'require-resume') {
            lease = null
            throw error
          }
          // A busy or unwritable registry must not turn a read-only delegation
          // into a failure; it only loses the efficiency optimisation.
          sessionNote = `${error.code ?? 'OMC/SESSION'}: ${error.message}; running without session reuse`
          lease = null
        }
      }

      if (capture && sessionCfg.resumePolicy === 'require-resume' && lease && !resumeId) {
        lease.release()
        throw providerError(
          'OMC/SESSION-REQUIRED',
          `resumePolicy is require-resume but the lane "${handoff.laneId}" has no usable native session`,
        )
      }

      const collectBytes = capture
        ? Math.max(cfg.dispatch.maxOutputBytes, 256 * 1024)
        : cfg.dispatch.maxOutputBytes
      let launched
      try {
        const optionsForRun = {
          task,
          cwd: request.cwd,
          model: hcfg.model || undefined,
          // A role provider is a read-only surface. `dispatch.defaultMode` governs
          // the direct `coharness` tool only; letting a global default widen a
          // role would silently turn Oracle/Explorer/Council seats into writers.
          mode: 'read-only',
          sessionId: resumeId ?? undefined,
          json: capture,
          env,
          plan,
          // JSON event streams are much larger than the human answer. Collect
          // enough to find the final message; clip what the model sees below.
          timeoutMs: hcfg.timeoutMs || cfg.dispatch.timeoutMs,
          maxOutputBytes: collectBytes,
          signal: request.signal,
        }
        launched = resumeId
          ? await harnessAdapter.resume(ctx, optionsForRun)
          : await harnessAdapter.start(ctx, optionsForRun)
      } catch (error) {
        if (lease) {
          try {
            registry.fail(lease, { code: error?.code, message: error?.message, taskId: handoff?.taskId })
          } catch {
            // The original launch error is the useful one.
          }
          lease.release()
        }
        throw error
      }

      const runId = mintRunId()
      const taskRecord = options.tasks?.start({
        id: runId, parentId: request.parent?.id, harness: def.id,
        label: request.label, handoff,
        cancel: () => {
          const subagents = ctx.get?.('subagents')
          if (!subagents?.interrupt) throw providerError('OMC/CANCEL-UNAVAILABLE', 'the host subagent interruption service is unavailable; use the host interrupt_agent tool')
          return subagents.interrupt(runId, { kind: 'ancestor', agent: request.parent })
        },
      })
      const result = (async () => {
        try {
          const outcome = await launched.handle.done
          const captured = harnessAdapter.collect(launched.handle, collectBytes)
          const transportStatus = harnessAdapter.status(outcome, launched.deadline, request.signal)
          const parsed = capture ? harnessAdapter.parse(captured.stdout) : null
          const classification = classifyCliResult({
            status: transportStatus,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            captured,
            parsed,
            expectJson: Boolean(capture),
            resumeId,
            requireContent: true,
          })
          const status = classification.status
          const ok = status === 'completed'
          const answer = clip(parsed?.text ?? captured.stdout ?? '', cfg.dispatch.maxOutputBytes).text
          const meta = [`omc:${def.id}`]

          if (capture) {
            if (resumeId) meta.push(`session resumed ${maskSessionId(resumeId)} (turn ${(lease?.record?.turns ?? 0) + 1})`)
            else meta.push('session new')
          } else if (sessionAdapter) {
            meta.push('session reuse off')
          }
          if (handoff?.taskId) meta.push(`task ${handoff.taskId}`)
          if (classification.idChanged) {
            meta.push('session id changed: the CLI started a different native conversation')
          }
          if (classification.code) meta.push(`${classification.code}: ${classification.message}`)
          const usage = sessionCfg.captureUsage !== false ? parsed?.usage : null
          if (usage) meta.push(`usage ${usageText(usage)}`)
          const booking = bookExternalUsage({
            runId,
            parentId: request.parent?.id,
            model: hcfg.model ?? null,
            usage,
            sessionId: parsed?.sessionId ?? null,
          })
          if (booking) meta.push(booking.stored ? 'attempt booked into the usage ledger' : 'attempt was already booked')
          if (sessionNote) meta.push(sessionNote)

          if (lease) {
            try {
              if (ok) {
                if (parsed?.sessionId) {
                  registry.complete(lease, {
                    sessionId: parsed.sessionId,
                    format: sessionAdapter.format,
                    usage,
                    taskId: handoff.taskId,
                    sessionOutcome: resumeId ? 'resumed' : 'new',
                  })
                } else if (resumeId) {
                  registry.unconfirmed(lease, {
                    reason: 'the resumed CLI did not echo its native session id',
                    taskId: handoff.taskId,
                  })
                  meta.push('resume unconfirmed: the CLI did not echo its session id')
                } else {
                  registry.complete(lease, { sessionId: null, usage, taskId: handoff.taskId })
                }
              } else {
                registry.fail(lease, {
                  code: `OMC/RUN-${status.toUpperCase()}`,
                  message: captured.stderr || captured.stdout,
                  taskId: handoff.taskId,
                })
              }
            } catch (error) {
              meta.push(`${error.code ?? 'OMC/SESSION-STORE'}: ${error.message}`)
            }
          }

          const value = {
            output: [
              {
                type: 'text',
                text: ok
                  ? answer || '(completed with no output)'
                  : failureText(def, status, outcome, captured, parsed?.text),
              },
            ],
            stopReason: ok ? 'completed' : status === 'cancelled' ? 'aborted' : 'error',
            diagnostic: meta.join(' · '),
          }
          if (taskRecord) options.tasks.settle(runId, value)
          return value
        } catch (error) {
          if (lease) {
            try { registry.fail(lease, { code: error?.code, taskId: handoff?.taskId }) } catch { /* preserve original failure */ }
          }
          // A dispatch that threw still consumed a slot somewhere: book it as
          // `unknown` rather than pretending nothing was spent.
          bookExternalUsage({ runId, parentId: request.parent?.id, model: hcfg?.model ?? null, usage: null, sessionId: null })
          if (taskRecord) options.tasks.settle(runId, {
            output: [{ type: 'text', text: `OMC/RUN-FAILED: ${error?.message ?? error}` }], stopReason: 'error',
          })
          throw error
        } finally {
          lease?.release()
          launched.deadline.dispose()
        }
      })()

      return {
        id: runId,
        result,
        dispose: async () => {
          await harnessAdapter.cancel(launched.handle)
        },
      }
    },
  }
}
