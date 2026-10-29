/**
 * Subagent provider factory.
 *
 * One provider per harness, named `omc:<id>`. Registering these is what turns
 * "run a CLI" into a first-class DSH child session: capacity, cancellation,
 * catalogue, completion notice and interrupt all come from `ctx.subagents`
 * (PLAN §3.2, ADAPTER §5).
 */

import { harnessEnv, launch, planTransport, readCollected, statusOf } from './transport.js'
import { harnessConfig } from './config.js'
import { mintRunId } from './ids.js'

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

function failureText(def, status, outcome, captured) {
  const exit = outcome.exitCode === null ? outcome.signal : outcome.exitCode
  const tail = captured.stderr || captured.stdout || '(no output)'
  return `${def.label} did not complete (${status}, exit ${exit}).\n\n${tail}`
}

/**
 * @param {{ subprocess: any }} ctx
 * @param {import('./harnesses.js').HarnessDef} def
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} cfg
 */
export function makeProvider(ctx, def, cfg) {
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
      const task = blocksToText(request.prompt)
      const hcfg = harnessConfig(cfg, def.id)
      const plan = await planTransport(ctx, def, cfg, request.signal)
      const { handle, deadline } = await launch(ctx, def, {
        task,
        cwd: request.cwd,
        model: hcfg.model || undefined,
        mode: cfg.dispatch.defaultMode,
        env: harnessEnv(def, hcfg),
        plan,
        // A per-harness deadline wins; the global one is the floor.
        timeoutMs: hcfg.timeoutMs || cfg.dispatch.timeoutMs,
        maxOutputBytes: cfg.dispatch.maxOutputBytes,
        signal: request.signal,
      })

      const result = (async () => {
        try {
          const outcome = await handle.done // real exit, not a scraped line of stdout
          const captured = readCollected(handle, cfg.dispatch.maxOutputBytes)
          const status = statusOf(outcome, deadline, request.signal)
          const ok = status === 'completed'
          return {
            output: [
              {
                type: 'text',
                text: ok ? captured.stdout || '(completed with no output)' : failureText(def, status, outcome, captured),
              },
            ],
            stopReason: ok ? 'completed' : status === 'cancelled' ? 'aborted' : 'error',
            diagnostic: ok
              ? undefined
              : [
                  `${def.id}: ${status} (exit ${outcome.exitCode ?? outcome.signal})`,
                  captured.spillPath ? `full stream: ${captured.spillPath}` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · '),
          }
        } finally {
          deadline.dispose()
        }
      })()

      return {
        id: mintRunId(),
        result,
        dispose: async () => {
          handle.terminate()
          // Release only after the process is really gone, otherwise the host's
          // capacity slot is returned while the CLI is still running.
          await handle.waitForExit()
        },
      }
    },
  }
}
