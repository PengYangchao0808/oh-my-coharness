# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses a `0.MINOR.PATCH` version line while the host APIs settle.

## [Unreleased]

_No unreleased changes._

## [0.3.0] — 2026-10-29

**Roles that really run on different CLIs.** The bundle now ships an agent preset
whose delegation tools are bound to the `omc:<id>` providers, so "give this to the
oracle" can mean Codex, and "ask the librarian" can mean Kimi — with a real DSH
child session, capacity slot and completion notice. No tool action and no schema
change: `coharness` is untouched.

### Added
- **`omc-harness` preset** (`preset-omc-harness`): the shipped `standard` tool
  surface (files, search, shell, jobs, skills, plan mode, compaction, web, todo,
  ask-user, workflow) plus four external specialists:
  - `subagent_codex` → `omc:codex` — architecture, hard debugging, review;
  - `subagent_antigravity` → `omc:antigravity` — UI, visual design, front-end;
  - `subagent_opencode` → `omc:opencode` — repository reconnaissance;
  - `subagent_kimi` → `omc:kimi` — long-context reading and surveys.
- A persona section names each specialist and its strength, and states the rules
  that actually hold: a self-contained brief, no follow-up question afterwards,
  no duplicate lanes, no claiming completion before the result returns.
- `scripts/check.mjs` and a unit test now assert the preset wiring (preset id,
  `@deepseek-ai/dsh-agent-preset` mount, one `provider: 'omc:<id>'` binding and
  `toolName` per specialist, `maxDepth: provider-managed`).
- `docs/ROLE-ROUTING.zh-CN.md` documents why slim's roles cannot do this
  (`provider: 'spawn'` is hard-coded in its role rows) and how this preset fixes
  it without forking or rewriting slim.

### Notes
- External children are **read-only by construction**: the provider runs with the
  configured `dispatch.defaultMode`, and the delegation tool has no mode switch.
  Writes still require an explicit `coharness({ mode: 'in-place' })`.
- External children are **one-shot**: no `send_message` follow-up, no
  continuation. The preset mounts the stock `subagent`/`subagent_fork` for work
  that needs this context.
- The preset is a new entry in Settings → Agent Presets; existing sessions keep
  the preset they started with.

## [0.2.0] — 2026-10-29

V0.2 "thin bridge" checkpoint: three new skills, five dispatch reliability fixes,
Slim companion detection, and an honest report for the degraded direct surface.
**No new tool actions, no new required parameters, no schema change.**

### Added
- **Three skills**, registered from `src/skills.js`:
  - `coharness-council` — two *different* harnesses, one read-only `tasks[]` call,
    synthesis (consensus / disagreement / unverified / recommendation) by the lead;
    a partial failure must be called "not a full council", never papered over.
  - `coharness-ulw` — Plan → Explore → Build → Review → Verify with explicit gates,
    `STATUS:` / `VERDICT:` footers, single writer, no parallel writes, and the
    frontend/backend lane split with a shared contract.
  - `coharness-verify` — risk-tiered evidence; command + exit code + output tail,
    and "unverified" whenever an exit code is missing.
- `src/skills.js` now exports `SKILLS`; `scripts/check.mjs` and
  `scripts/pack-check.mjs` read it, so adding a skill is one registry entry plus
  one directory. `check` reports the count dynamically (5).
- `doctor` companion block: detects oh-my-dsh-slim role tools (`subagent_oracle`,
  `subagent_designer`, `subagent_fixer`, `subagent_explorer`,
  `subagent_librarian`, `subagent_council`, `subagent_councillor_alpha`) and
  reports `detected` or `not detected (may be scoped)`. `coharness` visibility is
  `registered (preset visibility unverified)` — detection is never upgraded to
  "compatible"; that needs the Case B run.
- `skills/coharness/SKILL.md` gained skill pointers, a Companion section, a
  read-only strength table (enforced sandbox vs. advisory) and the
  `TOO-MANY-TASKS` / `BACKGROUND-UNSUPPORTED` failure rows.
- `scripts/live-check.mjs` (development tooling, not shipped): drives the real
  dispatch code against the CLIs installed here — two distinct harnesses, one
  read-only call, parallel timing, and `git status` unchanged.

### Changed
- `dispatch` auto-selection now prefers `auth === 'ok'`, then the field-tested
  `verified` flag, and never auto-selects `signed-out`. When nothing qualifies,
  the error lists every row and why it was rejected.
- Every `DispatchResult` carries `surface` (`provider` / `direct`) and, when the
  surface degraded, `downgradeReason`. The rendered text names both, so a direct
  run is no longer read as full support: it has no `childId`, no host capacity
  slot and no sub-session.
- `mode: 'worktree'` now says "not implemented in 0.2.0" instead of "reserved for
  v0.2".
- `scripts/check.mjs` also requires `name`, `whenToUse` and a matching directory
  name for every skill.

### Fixed
- **The `omc:<id>` provider surface could be lost entirely.** A Loader may apply
  this plugin before the `subagents` service exists (row order is not ours), and a
  one-shot registration attempt at apply time then silently registered nothing —
  every dispatch fell back to `surface: direct`, losing `childId`, capacity and the
  sub-session. Registration is now retried through `ctx.inject(['subagents'])` and
  on every tool/command entry point, and is idempotent. `doctor` prints a
  `providers:` line plus any `provider issues:` instead of hiding the failure.
- A degraded result that somehow carries no reason now says
  `degraded: direct surface (no reason reported)` instead of looking like full
  support.
- An over-limit `tasks[]` batch no longer drops tasks silently (`omitted`): it
  throws `OMC/TOO-MANY-TASKS` with the split advice.
- A batch with more than one `in-place` task is refused with `OMC/PARALLEL-WRITE`:
  0.2.0 is single-writer, and the guard now lives in code instead of only in the
  skill text.
- One unresolvable task (unknown harness, disabled harness, no usable target) no
  longer rejects the whole `Promise.all`; that task fails and the others finish.
- `delivery: 'background'` on the direct surface is refused with
  `OMC/BACKGROUND-UNSUPPORTED` instead of being silently awaited.
- An explicitly named `signed-out` harness still runs, but when the cached report
  has seen it the result carries `OMC/AUTH-SIGNED-OUT`.

### Docs
- `docs/V0.2-PLAN.zh-CN.md`: revised v2.1 plan — a **skill-first thin bridge**.
  0.2.0 adds three skills (council / ULW / verify), five dispatch reliability
  fixes, Slim companion detection, native-UI reuse, and an A–H acceptance
  matrix, delivered as five PRs and three checkpoints. It adds **no** tool
  actions, router, workflow engine, message bus, task store, client half,
  snapshot workspace or mode-qualified providers; those are deferred to
  0.2.1+ unless tests prove the skills insufficient.
- `docs/ACCEPTANCE-V0.2.md`: the A–H acceptance record with the command that
  produced each piece of evidence, and the cases that still need a host restart.
- `docs/ROLE-ROUTING.zh-CN.md`: why slim's role tools do **not** run on external
  harnesses (`provider: 'spawn'` is hard-coded in its role rows), what the two
  link types can and cannot do, and the two candidate routes for 0.2.1 / 0.3 —
  a `role` field on `coharness`, or a preset of harness-bound delegation tools
  built on the host's own `@deepseek-ai/dsh-tool-subagent`.
- `docs/ARCHITECTURE.zh-CN.md`: the OMC / oh-my-dsh-slim / DSH topology map —
  what is global (tool, command, skills, `omc:<id>` providers) versus what is
  session-scoped (preset tools), the two delegation paths into one provider
  layer, and the five recurring confusions.
- `docs/PLAN.zh-CN.md` §5.2 now marks its old work-package table as historical:
  role routing, worktree isolation and config UI are out of 0.2.0; council and
  ULW are skills over the existing `tasks[]` primitive.
- `README.md`: five skills, the new dispatch semantics, the companion section and
  the current test count.

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
