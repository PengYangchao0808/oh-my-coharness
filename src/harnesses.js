/**
 * Harness definition table — pure data, no ctx, no I/O.
 *
 * Adding a CLI must not require touching the provider, the tool, or a skill:
 * one entry here plus a recorded `--help` transcript in the pull request.
 *
 * `verified` means the headless argv shape was confirmed against the CLI's own
 * `--help` output or a real run. It does NOT mean dispatch works: that also needs
 * authentication, which doctor reports separately (`auth: ok | signed-out |
 * unknown | missing`).
 */

/** @typedef {{
 *   id: string, label: string, bin: string,
 *   argv: (task: string, opts: { model?: string, mode?: string }) => string[],
 *   versionArgs: string[],
 *   authProbe: { argv: string[], okExit: number } | null,
 *   capabilities: { write: boolean, model: boolean, resume: boolean, json: boolean, stdin: boolean },
 *   install: string, verified: boolean, notes?: string,
 *   defaultEnv?: Record<string, string>,
 * }} HarnessDef */

const READ_ONLY = 'read-only'

/** @type {HarnessDef[]} */
export const HARNESSES = [
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    // `opencode run [--model provider/model] "<task>"`
    argv: (task, opts) => ['run', ...(opts.model ? ['--model', opts.model] : []), task],
    versionArgs: ['--version'],
    authProbe: { argv: ['auth', 'list'], okExit: 0 },
    capabilities: { write: true, model: true, resume: false, json: true, stdin: false },
    install: 'curl -fsSL https://opencode.ai/install | bash   (inside WSL/Linux)',
    verified: true, // real read-only dispatch on this machine (2.1.4, 2026-10-29)
    notes: 'Model ids are "provider/model". Prefers a non-PATH install under WSL.',
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // `codex exec [-m MODEL] [-s SANDBOX] "<task>"` — confirmed by `codex exec --help` 0.165.0
    argv: (task, opts) => [
      'exec',
      // Headless runs cannot answer the interactive trust prompt, and the cwd is
      // chosen by the caller, so the repo check would only ever be a hard failure.
      '--skip-git-repo-check',
      ...(opts.model ? ['-m', opts.model] : []),
      // The sandbox flag is how `mode` stops being advisory for this harness.
      '-s',
      opts.mode === READ_ONLY ? 'read-only' : 'workspace-write',
      task,
    ],
    versionArgs: ['--version'],
    // `codex login status` exits 0 when signed in, 1 with "Not logged in".
    authProbe: { argv: ['login', 'status'], okExit: 0 },
    capabilities: { write: true, model: true, resume: true, json: true, stdin: true },
    install: 'npm i -g @openai/codex   (Node >=16)',
    verified: true,
    notes: 'Needs a trusted git repository as cwd. `codex exec resume` exists for v0.3.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    // `claude -p "<task>" --output-format text [--model M]` — confirmed by `claude --help` 2.1.312
    argv: (task, opts) => ['-p', task, '--output-format', 'text', ...(opts.model ? ['--model', opts.model] : [])],
    versionArgs: ['--version'],
    // `claude auth status` prints JSON and exits 1 when logged out.
    authProbe: { argv: ['auth', 'status'], okExit: 0 },
    capabilities: { write: true, model: true, resume: true, json: true, stdin: false },
    install: 'npm i -g @anthropic-ai/claude-code   (Node >=22)',
    verified: true,
    notes: 'No Anthropic account? Point it at another Anthropic-compatible endpoint (see `glm`).',
  },
  {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    bin: 'agy',
    // `agy -p "<task>" [--model slug] [--sandbox]` — confirmed by the official
    // headless docs for CLI 1.4.10 (text output is the default).
    argv: (task, opts) => [
      '-p',
      task,
      ...(opts.model ? ['--model', opts.model] : []),
      // Without a sandbox the CLI auto-allows workspace writes, which would make
      // read-only a lie. `--sandbox` is the documented restriction switch.
      ...(opts.mode === READ_ONLY ? ['--sandbox'] : []),
    ],
    versionArgs: ['--version'],
    // `agy models` exits 1 with "Please sign in" when there are no cached credentials.
    authProbe: { argv: ['models'], okExit: 0 },
    capabilities: { write: true, model: true, resume: true, json: true, stdin: true },
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash   (binary: ~/.local/bin/agy)',
    verified: true, // 2026-10-29: AGY-LIVE 10.9s, and a sandboxed README read 13.2s on 1.4.10
    notes:
      'Official successor to Gemini CLI; the free personal tier of gemini-cli is refused with ' +
      'UNSUPPORTED_CLIENT and points here. Headless runs use cached credentials, so run `agy` ' +
      'once interactively (TTY) to sign in. `--output-format json` carries conversation_id + usage, ' +
      'which is the natural source for DispatchResult.nativeSessionId in v0.3.',
  },
  {
    id: 'glm',
    label: 'GLM (via Claude Code)',
    bin: 'claude',
    // Same binary and argv as `claude`; only the endpoint and model differ.
    argv: (task, opts) => ['-p', task, '--output-format', 'text', ...(opts.model ? ['--model', opts.model] : [])],
    versionArgs: ['--version'],
    authProbe: null, // the remote endpoint answers; there is no local status command
    capabilities: { write: true, model: true, resume: true, json: true, stdin: false },
    install: 'install Claude Code, then put ANTHROPIC_AUTH_TOKEN in the env file',
    verified: true, // 2026-10-29: GLM-LIVE in 3.9 s through Z.ai's Anthropic endpoint
    // Z.ai serves GLM over the Anthropic Messages protocol, so any Anthropic client
    // can drive it. This entry is why a Harness is (binary × endpoint × model),
    // not a vendor: GLM ships no CLI of its own.
    defaultEnv: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    notes:
      'Disabled by default: needs a GLM Coding Plan key as ANTHROPIC_AUTH_TOKEN. ' +
      'Enable with harnesses.glm.enabled=true and point harnesses.glm.envFile at the secret file.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    // `gemini -p "<task>" [--model M] [--approval-mode plan]` — confirmed by `gemini --help` 0.66.0
    argv: (task, opts) => [
      '-p',
      task,
      ...(opts.model ? ['-m', opts.model] : []),
      // Without this the CLI overrides --approval-mode back to "default" because the
      // folder is untrusted, which silently undoes the read-only guarantee.
      '--skip-trust',
      // `plan` is Gemini's documented read-only mode.
      ...(opts.mode === READ_ONLY ? ['--approval-mode', 'plan'] : ['--approval-mode', 'auto_edit']),
    ],
    versionArgs: ['--version'],
    authProbe: null, // no status command; auth comes from env/config or first-run OAuth
    capabilities: { write: true, model: true, resume: false, json: true, stdin: true },
    install: 'npm i -g @google/gemini-cli   (Node >=20)',
    verified: true,
    notes: 'Auth is GEMINI_API_KEY or an interactive Google login; doctor therefore reports `unknown`.',
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    bin: 'kimi',
    // `kimi -p "<task>" [--model M]` — confirmed by `kimi --help` 2.4.0
    argv: (task, opts) => ['-p', task, ...(opts.model ? ['-m', opts.model] : [])],
    versionArgs: ['--version'],
    authProbe: null, // `kimi login` is a device-code flow with no status subcommand
    capabilities: { write: true, model: true, resume: true, json: true, stdin: false },
    install: 'npm i -g @moonshot-ai/kimi-code   (Node >=22.19)',
    verified: true,
    notes: '`kimi-cli` on npm is an unrelated placeholder. `-S` resumes a session.',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    argv: (task) => ['--prompt', task],
    versionArgs: ['--version'],
    authProbe: null,
    capabilities: { write: true, model: false, resume: false, json: false, stdin: false },
    install: 'npm i -g @qwen-code/qwen-code',
    verified: false,
  },
]

/** @type {Map<string, HarnessDef>} */
export const BY_ID = new Map(HARNESSES.map((def) => [def.id, def]))

/** @param {string} id */
export function harnessDef(id) {
  return BY_ID.get(id)
}

/**
 * Aliases a human or a model may type instead of the exact id.
 * Kept tiny on purpose: guessing a harness is worse than asking.
 */
const ALIASES = new Map([
  ['claude-code', 'claude'],
  ['claudecode', 'claude'],
  ['gemini-cli', 'gemini'],
  ['qwen-code', 'qwen'],
  ['oc', 'opencode'],
  ['open-code', 'opencode'],
  ['kimi-code', 'kimi'],
])

export function normalizeId(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  return ALIASES.get(id) ?? id
}
