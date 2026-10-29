# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses a `0.MINOR.PATCH` version line while the host APIs settle.

## [Unreleased]

## [0.1.10] — 2026-10-29

### Changed
- `glm` marked verified: `GLM-LIVE` in 3.9 s through Z.ai's Anthropic endpoint.
  This is the end-to-end proof of the env-file path — the token is read from
  `%USERPROFILE%\.dsh\coharness.env` by the Windows host and injected as an
  `export` into the WSL bash script.

### Notes
- The profile patch now enables `glm` and disables `claude` (no Anthropic account
  here), which is why `omc:glm` replaced `omc:claude` in the provider list.
- Do not pin `--model` for `glm` unless needed: Z.ai answers with its own default,
  and Claude Code warns that it does not recognise GLM model ids.

## [0.1.9] — 2026-10-29

### Changed
- `antigravity` marked verified after two real runs on 1.4.10: a bare token reply
  (10.9 s) and a sandboxed README read (13.2 s). `--sandbox` does not block file
  reads, so `mode: read-only` is both enforced and usable.

## [0.1.8] — 2026-10-29

### Added
- `antigravity` harness driving the official Antigravity CLI (`agy` 1.4.10), the
  successor Google points Gemini CLI users at after `UNSUPPORTED_CLIENT`.
  Headless argv: `agy -p "<task>" [--model slug] [--sandbox]`; auth probe is
  `agy models` (exits 1 while signed out), so doctor reports `signed-out` rather
  than `unknown`.
- `--sandbox` is passed for `mode: read-only`, because the CLI otherwise
  auto-allows workspace writes and read-only would be a lie.

### Notes
- Installing via the official script was impractical here: the WSL download ran
  at 19 KiB/s while the same file came down at 30–107 KiB/s on Windows, so the
  63.7 MiB archive was fetched with Windows `curl` and installed into
  `~/.local/bin/agy` (plus an `/etc/profile.d` entry for the login PATH).
  The archive's binary is named `antigravity`; the installer renames it to `agy`.

## [0.1.7] — 2026-10-29

### Fixed
- **gemini's read-only mode was silently overridden.** When the working folder is
  not trusted, the CLI resets `--approval-mode` to `default`. `--skip-trust` now
  travels with the call, so `plan` (read-only) actually holds.

## [0.1.6] — 2026-10-29

### Added
- `mode` now maps onto each CLI's own flag instead of being advisory:
  `codex -s read-only|workspace-write`, `gemini --approval-mode plan|auto_edit`.
  CLIs without a sandbox switch keep their default, and the tool says so.
- Stable auth probes: `codex login status` and `claude auth status` both exit 1
  when signed out, so doctor now reports `signed-out` rather than `unknown`.

### Fixed
- codex failed before reaching the model with "Not inside a trusted directory".
  Headless runs cannot answer the interactive trust prompt, so
  `--skip-git-repo-check` is passed; the failure is now an honest auth error.
- The failure diagnostic carries the exit code.

## [0.1.5] — 2026-10-29

### Added
- Harnesses verified against real `--help` output: codex 0.165.0, claude 2.1.312,
  gemini 0.66.0, kimi 2.4.0. `argv` now receives `mode`, `kimi` gained `-m`, and
  `gemini`/`kimi` were corrected to the flags their builds actually carry.

## [0.1.4] — 2026-10-29

### Changed
- **Scope frozen for the v0.1 phase.** No new harnesses, no worktree mode, no
  session reuse. Remaining gaps are documented rather than half-implemented;
  see `docs/CONVERGENCE.md`.

### Removed
- Temporary `OMC_ENV_PROBE` variable that was used to prove environment
  injection end to end through WSL.

## [0.1.3] — 2026-10-29

### Added
- `harnesses.<id>.env` and `harnesses.<id>.envFile`: per-harness environment,
  with `${VAR}` expansion. Native children receive a merged environment; WSL
  children receive `export` statements inside the bash script, which keeps the
  login PATH intact and avoids `WSLENV` translation.
- `glm` harness entry: the `claude` binary pointed at
  `https://api.z.ai/api/anthropic`. Proves a Harness is `binary × endpoint ×
  model`, not a vendor — GLM ships no CLI of its own. Disabled by default.
- `nvm`, `volta` and `pnpm` install roots in the WSL lookup, because a CLI
  installed under a version manager is not on the login PATH.

### Changed
- Doctor labels a usable harness whose argv shape has not been field-tested
  with `argv unverified` instead of implying full support.

## [0.1.2] — 2026-10-29

### Fixed
- A per-call `timeoutMs` was silently ignored on the provider surface: the
  provider never saw it, so a 1.5 s deadline ran to completion in 3.9 s. The
  deadline now travels as the activation `AbortSignal` and the result is
  re-classified as `timeout` after settlement.
- `graceMs` lowered from 3000 to 1500 for interactive cancellation.

## [0.1.1] — 2026-10-29

### Added
- Harness support matrix in the README, and the `argv unverified` label.

## [0.1.0] — 2026-10-29

### Added
- Host-only bundle: one tool (`coharness`), one command (`/coharness doctor`),
  two skills, and one `omc:<id>` subagent provider per enabled harness.
- Discovery in four steps: explicit command → PATH → known per-user install
  roots → WSL distributions (`command -v`, known prefixes, bounded `find`).
- Providers run through `ctx.subagents`, so capacity, cancellation, catalogue
  and the completion notice all come from the host.
- Doctor: native + WSL probing, honest `unknown` auth, redacted report.
- 16 unit tests against a `ctx` shim; no real CLI required.
