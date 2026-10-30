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
import { harnessConfig } from './config.js'
import { mintRunId } from './ids.js'
import { maskSessionId, parseSessionOutput } from './session-adapters.js'
import { clip, harnessEnv, launch, planTransport, readCollected, statusOf } from './transport.js'

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

      const adapter = def.session
      const confidence = adapter?.confidence ?? 'unverified'
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
      const capture = Boolean(
        sessionsOn && adapter && adapterAllowed && handoff && identity.source === 'marker' && hasWorkspace && registry,
      )
      const workspace = normalizeWorkspace(request.cwd ?? process.cwd())
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

      if (capture && sessionCfg.resumePolicy === 'require-resume') {
        const candidate = registry.find(key)
        if (!candidate) {
          throw providerError(
            'OMC/SESSION-REQUIRED',
            `resumePolicy is require-resume but no resumable session exists for lane "${handoff.laneId}"`,
          )
        }
      }

      if (capture) {
        try {
          lease = await registry.acquire(key)
          resumeId = lease.record?.native?.sessionId ?? null
        } catch (error) {
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
        launched = await launch(ctx, def, {
          task,
          cwd: request.cwd,
          model: hcfg.model || undefined,
          // A role provider is a read-only surface. `dispatch.defaultMode` governs
          // the direct `coharness` tool only; letting a global default widen a
          // role would silently turn Oracle/Explorer/Council seats into writers.
          mode: options.readOnly === true ? 'read-only' : cfg.dispatch.defaultMode,
          sessionId: resumeId ?? undefined,
          json: capture,
          env,
          plan,
          // JSON event streams are much larger than the human answer. Collect
          // enough to find the final message; clip what the model sees below.
          timeoutMs: hcfg.timeoutMs || cfg.dispatch.timeoutMs,
          maxOutputBytes: collectBytes,
          signal: request.signal,
        })
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

      const result = (async () => {
        try {
          const outcome = await launched.handle.done
          const captured = readCollected(launched.handle, collectBytes)
          const status = statusOf(outcome, launched.deadline, request.signal)
          const ok = status === 'completed'
          const parsed = capture ? parseSessionOutput(adapter.format, captured.stdout) : null
          const answer = clip(parsed?.text ?? captured.stdout ?? '', cfg.dispatch.maxOutputBytes).text
          const meta = [`omc:${def.id}`]

          if (capture) {
            if (resumeId) meta.push(`session resumed ${maskSessionId(resumeId)} (turn ${(lease?.record?.turns ?? 0) + 1})`)
            else meta.push('session new')
          } else if (adapter) {
            meta.push('session reuse off')
          }
          if (handoff?.taskId) meta.push(`task ${handoff.taskId}`)
          if (parsed?.sessionId && resumeId && parsed.sessionId !== resumeId) {
            meta.push('session id changed: the CLI started a different native conversation')
          }
          const usage = sessionCfg.captureUsage !== false ? parsed?.usage : null
          if (usage) meta.push(`usage ${usageText(usage)}`)
          if (sessionNote) meta.push(sessionNote)

          if (lease) {
            try {
              if (ok) {
                if (parsed?.sessionId) {
                  registry.complete(lease, {
                    sessionId: parsed.sessionId,
                    format: adapter.format,
                    usage,
                    taskId: handoff.taskId,
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

          return {
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
        } finally {
          lease?.release()
          launched.deadline.dispose()
        }
      })()

      return {
        id: mintRunId(),
        result,
        dispose: async () => {
          launched.handle.terminate()
          // Release only after the process is really gone, otherwise the host's
          // capacity slot is returned while the CLI is still running.
          await launched.handle.waitForExit()
        },
      }
    },
  }
}
