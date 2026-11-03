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
  // Optional absolute state root for tests/embedded hosts. Empty means the
  // profile-scoped `$DSH_HOME/omc/profiles/<profile>` default.
  stateDir: '',
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
    // A missing or rejecting provider must not silently become a direct run: the
    // direct surface has no child session and no host capacity slot. Direct is
    // still reachable by asking for it (`surface: 'direct'`, a write mode), so
    // only the *implicit* fallback is gated. Opt in to the old behaviour here.
    allowDirectFallback: false,
  },
  /**
   * Native Session Resume. OMC stores CLI session references, never prompts or
   * credentials. `allowUnverified` is the explicit gate for adapters whose argv
   * has not been exercised in this installation yet.
   */
  sessions: {
    enabled: true,
    path: '',
    resumePolicy: 'auto', // auto | new | require-resume
    maxTurns: 24,
    idleTtlMs: 7 * 24 * 60 * 60 * 1000,
    lockTimeoutMs: 120000,
    allowUnverified: false,
    captureUsage: true,
    maxEntries: 200,
  },
  /**
   * Advisory routing policy. Disabled by default: a policy may recommend an
   * executor, but it never overrides an explicit role.execution choice.
   */
  routing: {
    enabled: false,
    preset: 'balanced',
    roles: {},
    allowPaidApi: false,
    allowUnknownBilling: false,
    limits: {
      maxParallelExternal: 3,
      maxOracleCallsPerTask: 1,
      maxReviewRounds: 1,
    },
  },
  privacy: { reportBinaryPaths: false },
  /**
   * Efficiency features (0.5.0-alpha.2, V0.5-ALPHA2-PLAN §2). `observe` is the
   * upgrade default: it records calls, routes, usage and progress hints
   * without changing how tasks run. `balanced` turns on work packets, artifact
   * references, checkpoints and the managed path — it must be enabled
   * explicitly in a NEW session after the capability check. Correctness fixes
   * (WP01) always apply and are not part of this switch.
   */
  efficiency: {
    mode: 'observe', // 'off' | 'observe' | 'balanced'
    team: { maxActiveWorkers: 2, maxActiveWriters: 1 },
    checkpoints: {
      explorerSteps: 16,
      fixerSteps: 40,
      oracleSteps: 12,
      explorerInputTokens: 60000,
      fixerInputTokens: 120000,
    },
    context: { maxToolTextChars: 12000, packetMaxChars: 24000 },
    budget: { maxCalls: null, maxUsd: null, perTaskCalls: null, enforce: 'auto' },
    progress: { repeatWindow: 6, repeatThreshold: 3 },
  },
})

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Normalize the budget enforcement switch: the settings schema carries the
 * strings 'auto' | 'on' | 'off', while a row config or a hand-written document
 * may say `true` / `false`. Anything else falls back to 'auto'.
 */
function enforceMode(value) {
  if (value === true || value === 'on') return true
  if (value === false || value === 'off') return false
  return 'auto'
}

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
  merged.stateDir = typeof merged.stateDir === 'string' ? merged.stateDir.trim() : ''
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
  merged.dispatch.allowDirectFallback = merged.dispatch.allowDirectFallback === true
  if (typeof merged.wsl.distro !== 'string') merged.wsl.distro = ''
  merged.privacy.reportBinaryPaths = Boolean(merged.privacy.reportBinaryPaths)

  // ── efficiency (alpha.2 §2) ────────────────────────────────────────────────
  const eff = isObject(merged.efficiency) ? merged.efficiency : {}
  if (!['off', 'observe', 'balanced'].includes(eff.mode)) eff.mode = 'observe'
  eff.team = {
    maxActiveWorkers: intIn(eff.team?.maxActiveWorkers, 1, 8, DEFAULTS.efficiency.team.maxActiveWorkers),
    maxActiveWriters: intIn(eff.team?.maxActiveWriters, 1, 4, DEFAULTS.efficiency.team.maxActiveWriters),
  }
  eff.checkpoints = {
    explorerSteps: intIn(eff.checkpoints?.explorerSteps, 4, 400, DEFAULTS.efficiency.checkpoints.explorerSteps),
    fixerSteps: intIn(eff.checkpoints?.fixerSteps, 4, 1000, DEFAULTS.efficiency.checkpoints.fixerSteps),
    oracleSteps: intIn(eff.checkpoints?.oracleSteps, 4, 400, DEFAULTS.efficiency.checkpoints.oracleSteps),
    explorerInputTokens: intIn(eff.checkpoints?.explorerInputTokens, 1000, 10_000_000, DEFAULTS.efficiency.checkpoints.explorerInputTokens),
    fixerInputTokens: intIn(eff.checkpoints?.fixerInputTokens, 1000, 10_000_000, DEFAULTS.efficiency.checkpoints.fixerInputTokens),
  }
  eff.context = {
    maxToolTextChars: intIn(eff.context?.maxToolTextChars, 500, 200_000, DEFAULTS.efficiency.context.maxToolTextChars),
    packetMaxChars: intIn(eff.context?.packetMaxChars, 2000, 200_000, DEFAULTS.efficiency.context.packetMaxChars),
  }
  eff.budget = {
    maxCalls: Number.isSafeInteger(eff.budget?.maxCalls) && eff.budget.maxCalls > 0 ? eff.budget.maxCalls : null,
    maxUsd: typeof eff.budget?.maxUsd === 'number' && eff.budget.maxUsd >= 0 ? eff.budget.maxUsd : null,
    perTaskCalls: Number.isSafeInteger(eff.budget?.perTaskCalls) && eff.budget.perTaskCalls > 0 ? eff.budget.perTaskCalls : null,
    // 'auto' (the default) enforces exactly when a cap is configured: a cap
    // that never blocks would be a lie. `false`/'off' keeps the gate advisory.
    // The settings schema carries the strings 'auto'|'on'|'off'; the boolean
    // spellings stay accepted for row config and hand-written documents.
    enforce: enforceMode(eff.budget?.enforce),
  }
  eff.progress = {
    repeatWindow: intIn(eff.progress?.repeatWindow, 2, 50, DEFAULTS.efficiency.progress.repeatWindow),
    repeatThreshold: intIn(eff.progress?.repeatThreshold, 2, 10, DEFAULTS.efficiency.progress.repeatThreshold),
  }
  merged.efficiency = eff

  merged.sessions.enabled = merged.sessions.enabled !== false
  merged.sessions.path = typeof merged.sessions.path === 'string' ? merged.sessions.path : ''
  if (!['auto', 'new', 'require-resume'].includes(merged.sessions.resumePolicy)) {
    merged.sessions.resumePolicy = 'auto'
  }
  merged.sessions.maxTurns = intIn(merged.sessions.maxTurns, 1, 200, DEFAULTS.sessions.maxTurns)
  merged.sessions.idleTtlMs = intIn(
    merged.sessions.idleTtlMs,
    60_000,
    365 * 24 * 60 * 60 * 1000,
    DEFAULTS.sessions.idleTtlMs,
  )
  merged.sessions.lockTimeoutMs = intIn(
    merged.sessions.lockTimeoutMs,
    1_000,
    30 * 60 * 1000,
    DEFAULTS.sessions.lockTimeoutMs,
  )
  merged.sessions.maxEntries = intIn(merged.sessions.maxEntries, 1, 10_000, DEFAULTS.sessions.maxEntries)
  merged.sessions.allowUnverified = merged.sessions.allowUnverified === true
  merged.sessions.captureUsage = merged.sessions.captureUsage !== false

  merged.routing.enabled = merged.routing.enabled === true
  if (!['economy', 'balanced', 'quality'].includes(merged.routing.preset)) {
    merged.routing.preset = 'balanced'
  }
  merged.routing.roles = isObject(merged.routing.roles) ? merged.routing.roles : {}
  merged.routing.allowPaidApi = merged.routing.allowPaidApi === true
  merged.routing.allowUnknownBilling = merged.routing.allowUnknownBilling === true
  merged.routing.limits.maxParallelExternal = intIn(
    merged.routing.limits.maxParallelExternal,
    1,
    8,
    DEFAULTS.routing.limits.maxParallelExternal,
  )
  merged.routing.limits.maxOracleCallsPerTask = intIn(
    merged.routing.limits.maxOracleCallsPerTask,
    0,
    8,
    DEFAULTS.routing.limits.maxOracleCallsPerTask,
  )
  merged.routing.limits.maxReviewRounds = intIn(
    merged.routing.limits.maxReviewRounds,
    0,
    5,
    DEFAULTS.routing.limits.maxReviewRounds,
  )

  for (const [id, entry] of Object.entries(merged.harnesses)) {
    const value = isObject(entry) ? entry : {}
    merged.harnesses[id] = {
      enabled: value.enabled !== false,
      // Execution protocol, distinct from `transport` (native vs WSL process).
      adapter: ['cli', 'mcp', 'app-server'].includes(value.adapter) ? value.adapter : 'cli',
      // Subscription / API distinction for the cost guard. Unknown is not
      // treated as free: policy will not auto-select it.
      billing: ['subscription', 'api', 'unknown'].includes(value.billing) ? value.billing : 'unknown',
      // Manual acceptance record for a harness whose login cannot be probed without
      // interaction. It is the *only* way `auth: unknown` becomes authenticated;
      // the record is dated and names the mode it was validated in.
      verify:
        isObject(value.verify) && value.verify.accepted === true
          ? {
              accepted: true,
              at: typeof value.verify.at === 'string' ? value.verify.at : '',
              mode: ['read-only', 'patch'].includes(value.verify.mode) ? value.verify.mode : 'read-only',
              note: typeof value.verify.note === 'string' ? value.verify.note : '',
            }
          : null,
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
