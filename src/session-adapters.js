/**
 * Native-session output adapters.
 *
 * A CLI prints either one JSON document, a stream of JSON lines, or plain text.
 * Only the JSON forms can be trusted to carry a native session id and real
 * usage; guessing an id out of a human log would make Session Resume unsafe.
 *
 * Every parser returns the same shape and uses `null` for facts the CLI did not
 * report. A missing usage number is never rewritten to zero.
 */

export const SESSION_FORMATS = Object.freeze(['codex-jsonl', 'claude-json', 'generic-json'])
export const SESSION_ID_KEYS = Object.freeze([
  'session_id',
  'sessionId',
  'thread_id',
  'threadId',
  'conversation_id',
  'conversationId',
  'chat_id',
  'chatId',
])

const TEXT_KEYS = ['result', 'response', 'text', 'message', 'content', 'output']
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']
const CACHED_KEYS = [
  'cached_input_tokens',
  'cachedInputTokens',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cached_tokens',
  'cachedTokens',
]
const COST_KEYS = ['total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd', 'cost']

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

function isSessionId(value) {
  return typeof value === 'string'
    && value.length >= 6
    && value.length <= 512
    && !/[\s\u0000-\u001f]/.test(value)
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object') return undefined
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key]
  }
  return undefined
}

/**
 * Normalise one usage object. Accepts the shapes emitted by Codex, Claude,
 * Gemini and OpenAI-compatible CLIs; returns null fields when absent.
 */
export function normalizeUsage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const nested = source.usage && typeof source.usage === 'object' ? { ...source, ...source.usage } : source
  const inputTokens = number(firstValue(nested, INPUT_KEYS))
  const outputTokens = number(firstValue(nested, OUTPUT_KEYS))
  const cachedInputTokens = number(firstValue(nested, CACHED_KEYS))
  const costUsd = number(firstValue(nested, COST_KEYS))
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null && costUsd === null) return null
  return { inputTokens, outputTokens, cachedInputTokens, costUsd }
}

/** Mask a native session id for logs and reports. The registry keeps the full value. */
export function maskSessionId(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId : ''
  if (value.length <= 8) return value ? '***' : ''
  return `${value.slice(0, 6)}…${value.slice(-2)}`
}

function textOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return null
}

function parseJsonLines(text) {
  const events = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A log line between events is not a protocol error; keep scanning.
    }
  }
  return events
}

function parseWholeJson(text) {
  try {
    return JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
}

function findSessionId(object, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 4) return null
  for (const key of SESSION_ID_KEYS) {
    if (isSessionId(object[key])) return object[key]
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findSessionId(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

function findText(object, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 3) return null
  for (const key of TEXT_KEYS) {
    const value = textOf(object[key])
    if (value !== null) return value
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findText(value, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

function parseCodexJsonl(text) {
  const events = parseJsonLines(text)
  let sessionId = null
  let usage = null
  let finalText = null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'thread.started' && isSessionId(event.thread_id)) sessionId = event.thread_id
    if (!sessionId && isSessionId(event.thread_id)) sessionId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const value = textOf(event.item.text)
      if (value !== null) finalText = value
    }
    if (event.type === 'turn.completed' && event.usage) usage = normalizeUsage(event.usage)
    if (!usage && event.usage) usage = normalizeUsage(event.usage)
  }
  if (!events.length) {
    const whole = parseWholeJson(text)
    if (whole) return { sessionId: findSessionId(whole), text: findText(whole), usage: normalizeUsage(whole) }
  }
  return { sessionId, text: finalText, usage }
}

function parseClaudeJson(text) {
  const whole = parseWholeJson(text)
  if (!whole) return { sessionId: null, text: null, usage: null }
  const object = Array.isArray(whole) ? [...whole].reverse().find((row) => row?.type === 'result') ?? whole.at(-1) : whole
  return {
    sessionId: findSessionId(object),
    text: textOf(object?.result) ?? textOf(object?.response) ?? findText(object),
    usage: normalizeUsage(object),
  }
}

function parseGenericJson(text) {
  const whole = parseWholeJson(text)
  if (!whole) {
    const events = parseJsonLines(text)
    if (!events.length) return { sessionId: null, text: null, usage: null }
    const last = events.at(-1)
    return { sessionId: findSessionId(last), text: findText(last), usage: normalizeUsage(last) }
  }
  return {
    sessionId: findSessionId(whole),
    text: findText(whole),
    usage: normalizeUsage(whole),
  }
}

/**
 * Parse one captured CLI stream.
 * @returns {{ text: string|null, sessionId: string|null, usage: object|null, format: string }}
 *   `text` is the CLI's user-visible answer; null means "use the raw stream".
 */
export function parseSessionOutput(format, stdout) {
  const value = String(stdout ?? '')
  if (value.trim() === '') return { text: null, sessionId: null, usage: null, format }
  let parsed
  if (format === 'codex-jsonl') parsed = parseCodexJsonl(value)
  else if (format === 'claude-json') parsed = parseClaudeJson(value)
  else parsed = parseGenericJson(value)
  return {
    text: parsed.text ?? null,
    sessionId: parsed.sessionId && isSessionId(parsed.sessionId) ? parsed.sessionId : null,
    usage: parsed.usage ?? null,
    format,
  }
}

/** True when a string looks like a native session id rather than a label. */
export function isNativeSessionId(value) {
  return isSessionId(value)
}
