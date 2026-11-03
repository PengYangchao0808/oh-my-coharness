/**
 * Context view: long tool echo → short view + artifact reference
 * (0.5.0-alpha.2 WP04).
 *
 * New-entering long tool text is the cheapest context win (V0.5-ALPHA2-PLAN
 * §4.4): the model sees a bounded head/tail view with the exit code and a
 * stable artifact reference; the original evidence stays durably stored and
 * can be expanded on demand. Raw tool calls are never rewritten — this only
 * shapes OMC's OWN echo.
 *
 * The host-level history view transform (re-projecting what an existing
 * session's model-visible history contains) stays a separate, explicitly
 * unenabled capability this release: the WP00 probe found the projection seam
 * (registerMessageProjection), but pairing/replay validation is not done, so
 * `historyViewTransform` reports 'not-enabled' instead of pretending.
 */

import { createArtifactStore } from './artifact-store.js'

export const CONTEXT_VIEW_VERSION = 1
export const DEFAULT_MAX_TOOL_TEXT_CHARS = 12_000

export const HISTORY_VIEW_CAPABILITY = Object.freeze({
  status: 'not-enabled',
  reason: 'the host projection seam exists (WP00), but tool-call/result pairing and replay validation are not done; only OMC\'s own echo is reduced this release',
})

function viewError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function headTail(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  const omitted = text.length - head - tail
  return {
    text: `${text.slice(0, head)}\n[… ${omitted} characters omitted; full evidence in the artifact below …]\n${text.slice(text.length - tail)}`,
    truncated: true,
  }
}

/**
 * @param {{artifacts?: object, maxToolTextChars?: number}} [options]
 */
export function createContextView({ artifacts = null, maxToolTextChars = DEFAULT_MAX_TOOL_TEXT_CHARS } = {}) {
  const store = artifacts ?? createArtifactStore({})

  return {
    capability: { historyViewTransform: HISTORY_VIEW_CAPABILITY, maxToolTextChars },

    /**
     * Build the model-facing view of one tool result echo.
     * @returns {{view: string, truncated: boolean, stored: boolean, artifactId: string|null, chars: number}}
     */
    view({ tool, text, exitCode = null, error = false, parentId = null, taskId = null, attemptId = null, label = null }) {
      const body = typeof text === 'string' ? text : ''
      const prefix = [
        `[omc ${String(tool ?? 'tool')}${exitCode !== null && exitCode !== undefined ? ` exit ${exitCode}` : ''}${error ? ' ERRORED' : ''}]`,
      ].join(' ')
      if (body.length <= maxToolTextChars) {
        return { view: body === '' ? `${prefix} (no output)` : `${prefix}\n${body}`, truncated: false, stored: false, artifactId: null, chars: body.length }
      }
      const artifact = store.put({
        parentId, taskId, attemptId, kind: 'tool-output',
        label: label ?? `${tool} output (${body.length} chars)`, content: body,
      })
      const clipped = headTail(body, maxToolTextChars)
      const reference = store.reference(artifact.artifactId)
      return {
        view: `${prefix}\n${clipped.text}\n[full output stored as ${reference}; expand on demand]`,
        truncated: true,
        stored: true,
        artifactId: artifact.artifactId,
        chars: body.length,
      }
    },

    /** Bounded expansion of a stored view, with the original evidence intact. */
    expand(artifactId, { maxChars } = {}) {
      return store.read(artifactId, { maxChars })
    },

    /** Verify a view's evidence is still intact (missing/corrupt → typed error). */
    verify(artifactId, options) {
      return store.verify(artifactId, options)
    },

    /** Reject unknown reference forms instead of guessing (A10 tie-in). */
    referenceOf(value) {
      return store.resolveReference(value)
    },
  }
}
