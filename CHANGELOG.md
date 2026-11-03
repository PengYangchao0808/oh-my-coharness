# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses a `0.MINOR.PATCH` version line while the host APIs settle.

## [0.5.0-alpha.2-practice.1] — 2026-11-03

A practice increment, not the alpha.2 release. R00 (baseline) and R01 (native
event bridge) are done; R02–R10 and the alpha.2 release gate are not.

### Added
- **Native event bridge (R01):** `integration/native-runtime.js` subscribes to
  the host's `session/event` and `agent/created`, and puts a real native child
  into the same records as everything else. Child lineage comes from the
  session header the host persists (`header.parentSession`), nested children are
  attributed through their own parent, and a top-level session created under
  this preset is bound as its own parent — another preset's session is never
  adopted. Usage is booked once per `(native, session, seq)`, so a replayed or
  duplicated event bills nothing; a failed attempt without usage stays
  `unknown`. `turn/end` settles execution (`completed|blocked|error|max-tokens|
  aborted`) and never fills the acceptance row.
- **`/coharness usage`:** whether the bridge is installed, how many sessions it
  bound, what it booked, and the derived token rollup for the calling parent.
- **Baseline tooling (R00):** `scripts/run-tests.mjs` records a machine-readable
  suite result, and `scripts/practice-baseline.mjs` turns it plus
  `practice-baseline.sources.json` into a layered baseline
  (implementation / tests / host probe / real model / Desktop / cost coverage).
  A claimed pass whose artifact is missing is demoted to `unverified`.
- **`scripts/native-bridge-live-check.mjs`:** boots the installed host with a
  synthetic adapter (0 model calls) and asserts the bridge on real event
  payloads; evidence lands in
  `docs/evidence/alpha.2/practice-r01-native-runtime.json`.

### Fixed
- `scripts/check.mjs` now captures a child's output through a file instead of a
  pipe, so a confined host sandbox no longer reports healthy modules as broken
  (`spawn blocked` was an environment verdict, not a module verdict).
- `usage-ledger.entries({ parentId })` now filters by parent in the in-memory
  backend too; previously a rollup could include another parent's bookings.

### Changed
- Package version `0.5.0-alpha.2-practice.1`; the client card version literal
  moved with it.

## [Unreleased]

### Added
- **Durable orchestration (2026-11-02 late):** profile-scoped state under
  `$DSH_HOME/omc/profiles/<profile>/`; cross-process file locks with token,
  heartbeat and stale-owner takeover; native-session Lane leases; per-process
  dirty-record merge on save. External task receipts and result bodies are
  durable, and a missing body reads as `status: "unknown"`. New `graph`,
  `send`, `inbox`, `ack`, `thread`, and `reuse` `coharness` actions add a
  parent work graph (dependencies, acceptance evidence, write-scope claims and
  audit) and a durable mailbox. `/coharness sessions` gains per-Lane clear,
  Lane filtering and usage totals.
- **Runtime settings tab:** the settings card now has a third **Runtime** tab
  for session reuse, `resumePolicy`, `maxTurns`, `allowUnverified`, routing and
  billing authorization, plus usage/lane counts. Writes use the same atomic
  revision-fenced mutate as role edits. Per-Lane forget is available through
  `/coharness sessions --clear --lane=<id>`.
- **Dispatch fallback, project policy floor and worktree action:** `dispatch`
  accepts ordered `fallbacks` and only advances on retryable CLI codes, returning
  per-attempt diagnostics. `<cwd>/.omc/project.json` can tighten dispatch,
  disable harnesses, force read-only, and turn routing/billing authorization off;
  it can never widen operator authority. `dispatch` with `mode:"worktree"` creates
  a disposable branch checkout per external task, runs the CLI there, and
  returns branch/path/files/diff without merging. `coharness worktree` creates
  and enters a retained session-wide checkout; `merge:true` runs a clean-tree
  preflight, `git merge --no-ff`, a diff check, and aborts on conflict.
  `require_acceptance:true` + `node_id` first checks the graph node is
  completed with its acceptance evidence. Native children still have no
  per-child cwd.
- **Native RoleResult envelope:** `subagent_result` now returns
  `roleId/state/complete/capturedThroughSeq/readAt`; `complete` is always false
  because a latest assistant message is not settlement proof, and a missing
  message is `state: "unknown"`. `coharness result` now also projects an
  external task into `roleResult` (taskId/roleId/surface/state/complete/error)
  while preserving the raw task; external provider/model/structured/artifacts
  remain empty because the CLI does not prove them.
- **Session preset snapshots:** `coharness preset snapshot/status` stores the
  effective OMC role config for the calling parent session and diffs it against
  the live global config. It always returns `hotSwitch: false`; DSH still locks
  the agent preset after the first turn, so this is an audit snapshot, not a
  switch.
- **Explicit external session outcome:** provider dispatch results now expose
  `sessionOutcome: "new" | "resumed" | "unconfirmed"` from the CLI echo and
  resume diagnostics; direct runs omit it rather than inventing a session. The
  session registry stores `lastSessionOutcome` and `stats.outcomes`, and
  `/coharness sessions` prints new/resumed/unconfirmed/unknown counts.
- **Per-call dispatch model:** `dispatch` accepts a top-level or per-task
  `model`, applied to that CLI invocation only; the configured
  `harnesses.<id>.model` is not mutated. Custom roles can store the same
  override, and fallbacks inherit it.
- **Custom external role templates:** `coharness role` can list/add/remove/run
  named title+persona+harness templates. Runs are restricted to enforced
  read-only harnesses and reuse the normal dispatch/project-policy/result
  classifier; they are templates, not a second native role runtime. A project
  can also supply `<cwd>/.omc/roles.json`; project entries are normalized to
  read-only and invalid entries are skipped with warnings. Roles may declare
  up to three enforced read-only fallback harnesses; non-enforced fallbacks are
  skipped with a visible note.
- **CLI result classification** (`integration/cli-result.js`): auth, quota,
  rate-limit, context, truncated, semantic-JSON, empty-final-message and
  resume-identity outcomes have stable codes; exit zero is no longer a
  completion proof. Provider and direct dispatch share the classifier.
- **Native model fleet + demo (2026-11-02 evening):** `/coharness fleet` reads
  the live DSH provider/model catalog, prefers complete routes already configured
  in a mounted `oh-my-dsh-slim`, and assigns the remaining native roles with
  explainable keyword matching. `/coharness fleet --apply` writes only
  `provider/model/execution` (tools, deny lists, MCPs and persona text are
  preserved) after backing up the previous settings document. `/coharness demo`
  applies the fleet, seeds a deterministic one-bug/three-test workspace, and
  returns a ready Explorer → Oracle → Fixer prompt. New `coharness` actions
  `fleet` and `demo` expose the same behavior to the model.
- **Native route visibility:** `/coharness status` now prints
  `native · provider/model` for pinned native roles and marks a model that is
  absent from the live DSH catalog. Provider availability is checked against the
  LLM provider routes, not the subagent provider list.
- **Fleet tests** (`test/integration/fleet.test.mjs`, 14 cases): catalog
  normalization, distinct role assignment, OMD inheritance, explicit overrides,
  per-role settings merge, status projection and demo seeding.
- **OMO-SLIM usability pass (2026-11-02):** external role tools now expose stable
  lanes and bounded context, file, artifact and acceptance handoffs. Parent-scoped
  `coharness` actions `tasks`, `result`, and `cancel` retain external provider
  receipts without new model calls; DSH still owns activation and interruption.
- **Reproducible acceptance probes:** `scripts/session-live-check.mjs` uses the
  real OMC Provider for two-round native-session recall; `scripts/host-live-check.cjs`
  checks installed-host preset/tool mounting without model calls. New parity,
  ecosystem and acceptance reports are linked from README. These probes remain
  developer tooling and are excluded from the published package.
- **Harness adapter contract** (`src/adapters.js`): one lifecycle for every
  execution backend — `capabilities → start | resume → status → collect →
  cancel`. The provider and the direct dispatcher share it, so a new transport
  cannot grow a second task state machine. `cli` is implemented; `mcp` and
  `app-server` are declared and return `OMC/ADAPTER-UNSUPPORTED` instead of
  silently degrading to another backend.
- **Billing guard for automatic routing** (`integration/model-policy.js`):
  `harnesses.<id>.billing` (`subscription | api | unknown`), plus
  `routing.allowPaidApi`, `routing.allowUnknownBilling` and a per-role
  `authorizeBilling`. Only subscription routes are eligible by default; unknown
  billing is never treated as free. Blocked routes are reported with a reason.
- **`harnesses.<id>.adapter`** protocol field, kept separate from
  `harnesses.<id>.transport` (native vs WSL CLI process).
- **Settings schema** for `routing` and `sessions`; the OMD preset now forwards
  `routing` and `harnesses` to the role tool so the policy applies at dispatch,
  not only in the status card.
- `test/integration/adapters.test.mjs`, wired into `npm test`.
- **Explicit-only direct fallback** (`dispatch.allowDirectFallback`, default
  `false`): a missing or rejecting provider now fails with
  `OMC/PROVIDER-UNAVAILABLE` instead of silently running on the direct surface.
  Direct stays reachable by asking for it (`surface: direct`, a write mode) or by
  opting in.
- **Connection state model** (`src/connection.js`):
  `disabled → missing → installed → authenticated → verified → routable`.
  `auth: unknown` is never authenticated; `harnesses.<id>.verify` is the only
  dated manual-acceptance record that upgrades a harness whose login cannot be
  probed non-interactively.
- **Config templates** (`presets/`): `safe-native.json`,
  `hybrid-subscription.json` and a `native-model-profiles` example.
- **CI** (`.github/workflows/ci.yml`): static/contracts on Node 20/22, package
  manifest + tarball install, and a dispatch-only DSH runtime placeholder.

### Changed
- Native roles no longer look "native" without their route: status names the
  pinned provider/model and separates "provider not registered" from "model not
  in the catalog". Fleet application merges per role, so a route update cannot
  silently drop a role's tools or MCP selection.
- External follow-ups use the same role/cwd/lane with a new task; tool wording
  and the bundled routing skill now distinguish this from native `send_message`.
- Session selection honors `new` and `require-resume`, resets the turn budget on
  conversation replacement, observes cancellation while waiting, and refuses
  mismatched handoff workspaces. Invalidated references cannot be revived by
  late results. Providers stay read-only even if a caller omits the option.
- Local result retrieval excludes inherited fork messages. Native controls paint
  an opaque theme surface; the host schema retains verify/direct-fallback settings.
- **Automatic routing only elects `routable` harnesses**. `recommendRoute` takes
  the connection table, blocks registered-but-signed-out or billing-unauthorized
  routes with a reason, and the OMD role tool never auto-routes a harness that
  only has `auth: unknown`. Omitting the table keeps the previous behaviour.
- `recommendRoute` / status / doctor now share one connection table: status shows
  `signed-out · not routable`, suppresses recommendations for non-routable
  harnesses, and doctor embeds the real probe rows instead of `unknown`.
- **Routing is applied at dispatch** when `routing.enabled` is true and the role
  has no explicit `execution`. An explicit `role.execution` still wins, and only
  external-capable roles are eligible. `/coharness status` shows the applied
  `policy` per role and renders `api allowed|blocked` / `unknown allowed|blocked`.
- **Presets**: `balanced` and `quality` now run Designer on Codex (quality falls
  back to Antigravity); Kimi is no longer the default Designer backend.
- **`codex exec resume` no longer passes `-s`**: the resumed turn has no sandbox
  flag and inherits the policy recorded on the session. Never resume a session
  created writable. Codex session support is now `verified` (2026-10-30,
  two-round check); Claude remains `documented`.
- Role status rows report the effective execution (`omc:<harness>`) instead of
  the raw configuration, and expose `adapter` / `billing` per harness.

### Notes
- Verification: `168 tests / 0 fail`, `scripts/check.mjs` reports `14 modules`,
  `scripts/pack-check.mjs` passes with `presets/` in the tarball, and
  `docs/V0.5.md` §8 records the Codex two-round result plus remaining gaps.
- `docs/STABILIZATION.zh-CN.md` is the v0.6 release gate: positioning, channel
  model, connection states, the two official defaults, PR plan and the P0
  acceptance matrix. It also records the reachability audit: every `src/` and
  `integration/` module is statically reachable, so PR-02 must not delete
  modules on "nobody imports it" grounds.
- MCP and app-server adapters are contract placeholders only. They fail loudly by
  design; no MCP server or app-server endpoint is shipped or probed.

## [0.5.0-alpha.1] — 2026-10-30

**Task handoff and native session reuse.** v0.5 keeps the v0.4 topology — one
Orchestrator, no agent-to-agent bus — and adds the missing efficiency layer:
a signed handoff identity, a local native-session registry, and resume adapters
for the CLIs that expose a session id. The DSH child id remains per-run; it is
never reused as a CLI session id.

### Added
- **Handoff contract** (`integration/handoff.js`): `taskId`, `projectId`,
  `laneId`, workspace, changed files, artifact refs, acceptance and constraints.
  Artifact paths must stay workspace-relative; absolute paths and `..` are
  rejected before signing.
- **Signed handoff marker** in the external brief. The marker is HMAC-signed with
  a per-process key, stripped before the CLI sees the prompt, and ignored when an
  unsigned copy is injected into a direct `coharness` prompt.
- **Native Session Registry** (`integration/sessions.js`): one user-scoped JSON
  file, atomic writes, `0600` on POSIX, a single-writer lease per key, turn cap,
  idle TTL, failure/unconfirmed invalidation, and redacted listing.
- **Resume adapters** (`src/session-adapters.js`, `src/harnesses.js`):
  Codex JSONL (`thread.started` / `item.completed` / usage) and Claude JSON
  (`session_id` / `result` / usage) are enabled by default as `documented`.
  Kimi, OpenCode, Gemini and GLM adapters exist but are `unverified` and require
  `sessions.allowUnverified: true`.
- **Usage metadata** on provider results and session records. Missing token or
  cost fields stay `null`, never zero.
- **Transport plan cache** (60 s) so repeated role turns do not re-run WSL
  discovery; failures are never cached.
- **`/coharness sessions`** and the `coharness` tool's `sessions` action
  (`clear: true` forgets OMC references without deleting CLI history).
- **Advisory routing policy** (`integration/model-policy.js`): economy /
  balanced / quality recommendations, explicit `role.execution` always wins,
  unavailable providers degrade to native. Disabled by default.
- **Designer external patch mode** and the settings-card harness editor from the
  post-alpha.1 work: designer still only produces a diff, and a native fixer
  applies it.

### Changed
- `role.execution` external rows now also carry `mode` (`read-only` | `patch`)
  through resolution, status, doctor and the external brief.
- `provider.start` computes project/lane/role identity, acquires a session lease,
  captures the CLI's native id and usage, and reports a compact session line in
  the completion diagnostic.
- External role wording no longer claims the CLI can never be resumed; it states
  that a later call in the same lane may continue the native session when reuse
  is enabled.
- `execution-status` includes `sessions` and `routing` blocks; the harness rows
  include `session.format` / `session.confidence`.
- Test suite grows to 134 tests across the v0.4 regression, golden contracts,
  handoff, adapters, registry, provider resume and routing policy.

### Security
- Session reuse requires a signed marker; a v0.4 brief or a direct dispatch
  prompt never resumes a session.
- Session keys include endpoint and env-file epoch, so GLM and Claude — same
  binary, different endpoints — cannot share a native session.
- The registry stores no prompt, conversation or credential.

### Notes
- `documented` means the CLI command shape is documented, **not** that a real
  two-turn resume has been verified in this installation. Codex/Claude need that
  live acceptance before v0.5 can call resume a stable feature.
- Not in this release: a writable external provider, worktree isolation,
  settings-card session controls, automatic model selection, and a real
  performance A/B. See `docs/V0.5.md` for the remaining gates.

## [0.4.0-alpha.1] — 2026-10-30

**OMC 与 OMD 的原生合并。** One install, one preset family: OMD's Orchestrator,
specialist roles, Council and settings card now ship inside Oh My CoHarness, and
each role can run natively in DSH or on an external CLI through the existing
`omc:<id>` providers. DSH remains the runtime; no second role system, no message
bus, no reimplementation of session management.

### Added
- **Vendored OMD 0.8.6** (`vendor/omd/`, commit `537d4c7`) with its LICENSE and
  provenance record. Role personas, Council, profile registry, settings card and
  the native role path are preserved.
- **Single bundle**: Host row `oh-my-coharness`, preset `preset-oh-my-coharness`,
  profile row `oh-my-coharness-profiles`, and `agent-preset-registry` default
  `oh-my-coharness`. The old `preset-omc-harness` and `preset-oh-my-dsh-slim`
  rosters are gone.
- **`role.execution`**: `{ backend: 'native' | 'omc', harness, fallback, allowAdvisory }`.
  Native stays the default; external execution is opt-in per role.
- **Execution resolver** (`integration/execution.js`): uses the live
  `ctx.subagents.list()`, refuses advisory-only read-only by default, and returns
  a blocked role instead of silently falling back to native.
- **External task brief** (`integration/external-brief.js`): the same persona the
  native child receives, with DSH-tool paragraphs replaced by the CLI environment
  and a fixed report format.
- **Read-only classes** for every harness: `enforced` (codex, gemini,
  antigravity), `advisory` (opencode, kimi, claude, glm), `unsupported` (qwen,
  unknown ids).
- **`omc:<id>` providers are fixed read-only**: changing `dispatch.defaultMode`
  can no longer turn a role into a writer. In-place `coharness` dispatch uses the
  documented direct surface instead.
- **Council backend mixing**: seats may use different backends; the Council mode
  prompt names each backend, stops assuming identical tools, and keeps the
  synthesizer native.
- **Settings card execution controls**: backend, harness, fallback, advisory
  acceptance, provider-missing refresh, read-only labels. Harness/provider status
  comes from the new `/coharness` `execution-status` RPC.
- **`/coharness migrate`**: preview, backup, apply, `--force`, `--rollback`, and
  custom-profile import. Old JSON files and old registry rows are preserved;
  credentials are never copied.
- **`/coharness status`** and the `coharness` tool's `status` action for a
  role → backend table without probing CLIs.
- Doctor now reports the merged preset, role execution rows, read-only classes,
  blocked roles and a still-mounted legacy OMD.

### Changed
- The package's main entry is the merged Host row (`src/entry.js`); the OMC Host
  remains importable as `oh-my-coharness/host`, and the OMD companion as
  `oh-my-coharness/orchestrator`.
- Settings namespace, preset id, browser module id, RPC path and config file are
  now `oh-my-coharness` / `/coharness` / `oh-my-coharness.json`.
- Native role behavior is unchanged: `role-composition`, `subagent-roles`,
  `role-mcp` and the official `@deepseek-ai/dsh-tool-subagent` still own the
  native path.
- External stock config now omits `agentOptions` entirely and uses
  `maxDepth: 'provider-managed'`, matching the host's capability checks.

### Breaking
- Installing alongside `oh-my-dsh-slim` is unsupported: two role rosters fight
  for the same tool names. Uninstall OMD after migration.
- Sessions bound to the old preset ids (`oh-my-dsh-slim`, `omc-harness`) cannot
  resolve their composition; migration reports them but does not rewrite them.
- The `omc:<id>` provider surface no longer honors a writable
  `dispatch.defaultMode`. Write dispatches take `surface: direct`.

### License
- MIT. OMD and OMO Slim attribution retained in [`LICENSE`](LICENSE) and
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

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
