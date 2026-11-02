/**
 * Harness adapter contract.
 *
 * A harness is not "a CLI" or "an MCP server": it is one execution backend with
 * a common lifecycle. The provider and the direct dispatcher both talk to this
 * interface, so a new transport cannot grow a second task state machine.
 *
 * The contract is intentionally small:
 *   probe/capabilities → start | resume → status → collect → cancel
 *
 * CLI is the only transport implemented today. MCP and app-server are declared
 * here so adding one is a local adapter change, not a new orchestrator.
 */

import { parseSessionOutput } from './session-adapters.js'
import { launch, readCollected, statusOf } from './transport.js'

export const ADAPTER_TRANSPORTS = Object.freeze(['cli', 'mcp', 'app-server'])

function adapterError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function unsupportedAdapter(def, transport, reason) {
  const fail = () => {
    throw adapterError('OMC/ADAPTER-UNSUPPORTED', `${def.id}: ${reason}`)
  }
  return {
    id: def.id,
    transport,
    supported: false,
    reason,
    session: def.session ?? null,
    capabilities: () => ({ ...(def.capabilities ?? {}) }),
    start: fail,
    resume: fail,
    status: () => 'failed',
    collect: () => ({ stdout: '', stderr: reason, truncated: false, spillPath: undefined }),
    cancel: async () => {},
    parse: () => null,
  }
}

/**
 * Wrap one CLI definition in the common lifecycle. `start` and `resume` differ
 * only in whether `sessionId` is passed to the transport; the result parser is
 * the same.
 */
export function createCliAdapter(def) {
  return {
    id: def.id,
    transport: 'cli',
    supported: true,
    session: def.session ?? null,
    capabilities: () => ({ ...(def.capabilities ?? {}) }),
    start(ctx, options) {
      return launch(ctx, def, options)
    },
    resume(ctx, options) {
      return launch(ctx, def, { ...options, sessionId: options.sessionId })
    },
    status(outcome, deadline, signal) {
      return statusOf(outcome, deadline, signal)
    },
    collect(handle, maxBytes) {
      return readCollected(handle, maxBytes)
    },
    cancel(handle) {
      handle.terminate()
      return handle.waitForExit()
    },
    parse(stdout) {
      return def.session ? parseSessionOutput(def.session.format, stdout) : null
    },
  }
}

/**
 * Resolve the adapter for one harness.
 *
 * `harnesses.<id>.adapter` is a protocol choice (`cli` | `mcp` | `app-server`),
 * separate from `harnesses.<id>.transport` which selects native vs WSL for the
 * CLI process. The two must not be conflated.
 */
export function adapterFor(def, cfg = {}) {
  const configured = cfg?.harnesses?.[def.id]?.adapter
  const transport = ADAPTER_TRANSPORTS.includes(configured) ? configured : 'cli'
  if (transport === 'cli') return createCliAdapter(def)
  if (transport === 'mcp') {
    return unsupportedAdapter(
      def,
      'mcp',
      'the MCP transport is not configured; MCP is an optional adapter, not a second orchestrator',
    )
  }
  return unsupportedAdapter(
    def,
    'app-server',
    'the app-server transport is not implemented; use the CLI adapter until an app-server endpoint is configured',
  )
}
