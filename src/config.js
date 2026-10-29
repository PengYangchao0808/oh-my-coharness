/**
 * Configuration surface.
 *
 * The bundle patch supplies `config`; without a `Config` export the Loader passes it
 * through unvalidated, so this module owns both defaults and bounds. Keeping the
 * schema hand-written is deliberate: the package stays free of peer dependencies,
 * which is what lets `engines.dsh` be the only version coupling (see PLAN §6.1).
 */

export const DEFAULTS = Object.freeze({
  surface: 'auto', // 'auto' | 'provider' | 'direct'
  transport: 'auto', // 'auto' | 'native' | 'wsl'
  harnesses: {
    opencode: { enabled: true },
    claude: { enabled: true },
    // Off by default: it reuses the `claude` binary against the GLM endpoint and
    // needs a GLM Coding Plan key, which most users do not have.
    glm: { enabled: false },
    codex: { enabled: true },
    gemini: { enabled: true },
    // Official successor to Gemini CLI; harmless when absent (doctor shows `missing`).
    antigravity: { enabled: true },
    kimi: { enabled: true },
    qwen: { enabled: false },
  },
  wsl: { distro: '' },
  dispatch: {
    maxParallel: 4,
    defaultMode: 'read-only',
    timeoutMs: 600000,
    maxOutputBytes: 20000,
  },
  privacy: { reportBinaryPaths: false },
})

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function merge(base, over) {
  if (!isObject(over)) return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

function intIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * @param {unknown} input raw row config
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(input) {
  const merged = merge(DEFAULTS, input)

  merged.surface = ['auto', 'provider', 'direct'].includes(merged.surface) ? merged.surface : 'auto'
  merged.transport = ['auto', 'native', 'wsl'].includes(merged.transport) ? merged.transport : 'auto'
  merged.dispatch.maxParallel = intIn(merged.dispatch.maxParallel, 1, 8, DEFAULTS.dispatch.maxParallel)
  merged.dispatch.timeoutMs = intIn(merged.dispatch.timeoutMs, 5000, 86400000, DEFAULTS.dispatch.timeoutMs)
  merged.dispatch.maxOutputBytes = intIn(
    merged.dispatch.maxOutputBytes,
    1024,
    1024 * 1024,
    DEFAULTS.dispatch.maxOutputBytes,
  )
  if (!['read-only', 'in-place', 'worktree'].includes(merged.dispatch.defaultMode)) {
    merged.dispatch.defaultMode = 'read-only'
  }
  if (typeof merged.wsl.distro !== 'string') merged.wsl.distro = ''
  merged.privacy.reportBinaryPaths = Boolean(merged.privacy.reportBinaryPaths)

  for (const [id, entry] of Object.entries(merged.harnesses)) {
    const value = isObject(entry) ? entry : {}
    merged.harnesses[id] = {
      enabled: value.enabled !== false,
      command: typeof value.command === 'string' ? value.command : '',
      model: typeof value.model === 'string' ? value.model : '',
      transport: ['auto', 'native', 'wsl'].includes(value.transport) ? value.transport : 'auto',
      distro: typeof value.distro === 'string' ? value.distro : '',
      timeoutMs: Number.isSafeInteger(value.timeoutMs) ? value.timeoutMs : 0,
      env: isObject(value.env) ? value.env : {},
      envFile: typeof value.envFile === 'string' ? value.envFile : '',
    }
  }
  return merged
}

/** @param {typeof DEFAULTS} cfg @param {string} id */
export function harnessConfig(cfg, id) {
  return cfg.harnesses[id] ?? { enabled: false }
}

/** @param {typeof DEFAULTS} cfg @param {string} id */
export function isEnabled(cfg, id) {
  return harnessConfig(cfg, id).enabled !== false
}
