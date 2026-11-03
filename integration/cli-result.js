/**
 * Classify one external CLI outcome.
 *
 * Exit code zero is not a completion proof. A CLI can exit zero after printing
 * invalid JSON, an empty final message, or a truncated stream. This module turns
 * the raw capture into one stable code and a status the rest of OMC can trust:
 *
 *   completed | failed | cancelled | timeout
 *
 * It never rewrites the captured text and never invents a session id.
 */

export const CLI_CODES = Object.freeze({
  completed: null,
  cancelled: 'OMC/CLI-CANCELLED',
  timeout: 'OMC/CLI-TIMEOUT',
  signal: 'OMC/CLI-SIGNAL',
  truncated: 'OMC/CLI-TRUNCATED',
  semantic: 'OMC/CLI-SEMANTIC-FAILURE',
  empty: 'OMC/CLI-EMPTY-OUTPUT',
  idChanged: 'OMC/CLI-ID-CHANGED',
  unconfirmed: 'OMC/CLI-SESSION-UNCONFIRMED',
  auth: 'OMC/CLI-AUTH',
  quota: 'OMC/CLI-QUOTA',
  rate: 'OMC/CLI-RATE-LIMIT',
  context: 'OMC/CLI-CONTEXT',
  network: 'OMC/CLI-NETWORK',
  exit: 'OMC/CLI-EXIT',
})

const PATTERNS = [
  ['auth', /\b(401|403|unauthorized|unauthenticated|authentication|not logged in|sign in|login required|invalid api key)\b/i, false],
  ['quota', /\b(402|quota|credit balance|insufficient (credit|balance)|billing|usage limit|payment required)\b/i, false],
  ['rate', /\b(429|rate limit|too many requests|overloaded|temporarily unavailable)\b/i, true],
  ['context', /\b(context (window|length)|too many tokens|maximum context|token limit|prompt is too long)\b/i, false],
  ['network', /\b(econn(reset|refused)|enotfound|etimedout|socket hang up|network error|connection reset)\b/i, true],
]

function clamp(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

function classifiableText(captured = {}) {
  return [captured.stderr, captured.stdout].filter(Boolean).join('\n')
}

/**
 * @param {{
 *   status?: string,
 *   exitCode?: number|null,
 *   signal?: string|null,
 *   cancelled?: boolean,
 *   timedOut?: boolean,
 *   captured?: {stdout?: string, stderr?: string, truncated?: boolean},
 *   parsed?: object|null,
 *   expectJson?: boolean,
 *   resumeId?: string|null,
 *   requireContent?: boolean,
 * }} input
 * `expectJson` must be true only when the caller actually requested
 * machine-readable output (the provider surface with capture on). It is a
 * claim about what was asked, not about what the adapter could parse.
 * @returns {{
 *   status: 'completed'|'failed'|'cancelled'|'timeout',
 *   code: string|null,
 *   message: string,
 *   retryable: boolean,
 *   truncated: boolean,
 *   idChanged: boolean,
 *   unconfirmed: boolean,
 *   semantic: boolean,
 * }}
 */
export function classifyCliResult({
  status,
  exitCode,
  signal,
  cancelled = false,
  timedOut = false,
  captured = {},
  parsed = null,
  expectJson = false,
  resumeId = null,
  requireContent = true,
} = {}) {
  const base = {
    status: 'completed',
    code: null,
    message: '',
    retryable: false,
    truncated: captured.truncated === true,
    idChanged: false,
    unconfirmed: false,
    semantic: false,
  }

  // A deadline kill arrives as a signal, but the transport already decided it
  // was a timeout: that verdict must not be downgraded to "cancelled" by the
  // kill signal itself (the deadline owns the interpretation).
  if (timedOut || status === 'timeout') {
    return { ...base, status: 'timeout', code: CLI_CODES.timeout, message: 'the run exceeded its deadline', retryable: true }
  }
  if (cancelled || status === 'cancelled' || signal === 'SIGINT' || signal === 'SIGTERM') {
    return { ...base, status: 'cancelled', code: CLI_CODES.cancelled, message: 'the run was cancelled' }
  }

  const outputText = parsed && typeof parsed.text === 'string'
    ? parsed.text
    : typeof captured.stdout === 'string' ? captured.stdout : ''
  const diagnostic = classifiableText(captured)

  if (Number.isInteger(exitCode) && exitCode !== 0) {
    for (const [kind, pattern, retryable] of PATTERNS) {
      if (!pattern.test(diagnostic)) continue
      return {
        ...base,
        status: 'failed',
        code: CLI_CODES[kind],
        message: clamp(diagnostic) || `exit ${exitCode}`,
        retryable,
      }
    }
    return {
      ...base,
      status: 'failed',
      code: CLI_CODES.exit,
      message: clamp(diagnostic) || `exit ${exitCode}`,
      retryable: false,
    }
  }
  if (signal) {
    return { ...base, status: 'failed', code: CLI_CODES.signal, message: `terminated by ${signal}` }
  }

  // Exit zero from here on. These are the cases the old exit-code-only status
  // silently called "completed".
  if (base.truncated) {
    return {
      ...base,
      status: 'failed',
      code: CLI_CODES.truncated,
      message: 'the captured stream was truncated; the final message is not proven complete',
      retryable: false,
    }
  }
  if (expectJson) {
    // Machine-readable output was requested, so the raw stream is evidence,
    // not an answer. A recognized envelope without a terminal message, or no
    // envelope at all, is a semantic failure — never a fallback to stdout.
    if (!parsed || parsed.envelope !== true) {
      return {
        ...base,
        status: 'failed',
        code: CLI_CODES.semantic,
        message: 'the CLI exited zero but produced no recognizable JSON session stream',
        semantic: true,
        retryable: false,
      }
    }
    if (requireContent && (parsed.text ?? '').trim() === '') {
      return {
        ...base,
        status: 'failed',
        code: CLI_CODES.semantic,
        message: 'the CLI exited zero but its JSON stream ended without a terminal message',
        semantic: true,
        retryable: false,
      }
    }
  }
  if (resumeId && parsed && parsed.sessionId && parsed.sessionId !== resumeId) {
    base.idChanged = true
    base.code = CLI_CODES.idChanged
    base.message = 'the CLI started a different native conversation than the one it was asked to resume'
  } else if (resumeId && parsed && !parsed.sessionId) {
    base.unconfirmed = true
    base.code = base.code ?? CLI_CODES.unconfirmed
    base.message = 'the resumed CLI did not echo its native session id'
  }

  if (requireContent && outputText.trim() === '') {
    return {
      ...base,
      status: 'failed',
      code: base.code ?? CLI_CODES.empty,
      message: base.message || 'the CLI exited zero but produced no final message',
      semantic: true,
      retryable: false,
    }
  }

  return { ...base, status: 'completed', message: base.message || 'completed' }
}

/** One-line diagnostic for tool output. */
export function describeCliResult(classification) {
  if (!classification || !classification.code) return ''
  return `${classification.code}${classification.retryable ? ' (retryable)' : ''}: ${classification.message}`
}
