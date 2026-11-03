# Changes to the vendored OMD source

## 2026-11-03 practice.1

- `client/client.js`: the shipped version literal follows
  `0.5.0-alpha.2-practice.1`. Nothing else in the card changed; the contract
  test still compares the literal with `package.json`.

## 2026-11-02 usability changes (Unreleased)

- `preset/roles.js`: resolve the parent's working directory before signing an
  external handoff; accept a stable lane and bounded context/artifact/acceptance
  facts; consume the extension fields before calling the stock tool.
- `preset/role-wording.js` / `preset/preset.js`: advertise the executable external
  follow-up contract and the parent-scoped result controls. Native messaging stays
  the host's `send_message`; external lane reuse is a new activation.
- `preset/subagent-result.js`: do not report inherited fork messages as a child's
  own answer; clarify that a latest message alone does not prove settlement.
  The matching provenance test in `test/result.test.mjs` was updated deliberately.
- `lib/config-settings.js`: preserve `harnesses.*.verify` and
  `dispatch.allowDirectFallback` through the real host schema.
- `client/client.js`: paint native controls with the opaque theme layer token,
  following the independently documented OMD 0.8.8 popup diagnosis. No upstream
  0.8.8 source import or wholesale baseline change was performed.

The original 0.8.6 source pin below remains unchanged. Current behavior and test
evidence are documented in `docs/USABILITY-ACCEPTANCE.zh-CN.md` at the repo root.

This directory is a pinned source import of **oh-my-dsh-slim 0.8.6**
(`537d4c7f5dc316c449de4ccfff8ab15d15901fa6`). See `UPSTREAM.json` for provenance.

The merge deliberately keeps OMD's structure and most of its code. Files listed
here are the complete set of edits made for Oh My CoHarness v0.4.0-alpha.1.
Everything else under `npm-package/` is unchanged except mechanical
`oh-my-dsh-slim:` → `oh-my-coharness:` log/error prefixes.

## Product identity

| File | Change |
|---|---|
| `preset/preset.js` | `PRESET_ID` → `oh-my-coharness`; display name → `Oh My CoHarness`; English description; Orchestrator prompt gains an "Execution backends" paragraph. |
| `preset/config.js` | `SETTINGS_NS` → `oh-my-coharness`; config file → `oh-my-coharness.json`; `OH_MY_COHARNESS_CONFIG` with `OH_MY_DSH_SLIM_CONFIG` fallback; reads the old `~/.dsh/oh-my-dsh-slim.json` only when the new file is absent; returns `presetId`. |
| `lib/config-settings.js` | `SETTINGS_NS` → `oh-my-coharness`; legacy import prefers the new file, falls back to the old one. |
| `lib/index.js` | Brand, preset id/config file constants; RPC path `/omds` → `/coharness`; adds the `execution-status` endpoint; verbose report shows the execution backend. |
| `lib/profile-registry.js` | Registry entry id → `oh-my-coharness-profiles`; bundled profile id/name follow the preset; `setDefault`/`list` use `PRESET_ID`. |
| `lib/profile-transport.js` | Accepts an explicit RPC path (`/coharness`) with legacy-function compatibility. |
| `lib/host-version.js` | Brand strings; DSH `0.2.1-rc.3` added to the verified list. |

## Execution backend integration

| File | Change |
|---|---|
| `preset/config.js` | `validateRole()` calls `validateExecution()` for the `execution` block; rejects MCP servers on external roles. Structural errors reject the document, environment errors do not. |
| `preset/roles.js` | Imports the execution resolver, compatibility contract and external brief. `resolveRole()` resolves `role.execution` against the live `ctx.subagents.list()`. `stockConfig()` emits a provider-managed, argument-free config for external roles (no `agentOptions`, no `agentPreset`, no numeric `maxDepth`, no `backgroundMode`). The role tool's `execute()` wraps the task in the external brief. Blocked roles register a same-named failing tool via `blockedRoleTool()` instead of silently falling back. The persisted role marker is `oh-my-coharness-role:` and the old `oh-my-dsh-slim-role:` is still read for cold resumes. |
| `preset/role-wording.js` | External role description and prompt wording: one-shot, no follow-up, persona auto-attached, read-only level. Native wording is untouched. |
| `preset/council-mode.js` | Seat list names each seat's backend; mixed councils no longer assume identical tools; synthesizer explicitly native. |
| `preset/role-composition.js` | Unchanged behavior (mechanical prefix only). External runs never create a DSH child, so this path is native-only by construction. |
| `preset/subagent-roles.js`, `preset/role-mcp.js`, `preset/sandbox-strip.js`, `preset/early-close-context.js`, `preset/subagent-result.js` | Unchanged behavior (mechanical prefix only). |

## Settings card

| File | Change |
|---|---|
| `client/client.js` | Module id and settings namespace → `oh-my-coharness`; RPC path → `/coharness`; version → package version; bundled profile name; new execution-backend row (native/external, harness, fallback, advisory acceptance), provider-missing refresh, read-only class labels, external model-ownership hint. Draft/write helpers normalize `execution` so native remains "field absent" and untouched roles never gain a field. Fetches harness/provider status through the `execution-status` RPC. New test hooks: `normalizeExecution`, `executionForWrite`, `externalRoleAllowed`, `harnessOptions`, `harnessLabel`. |

## Contract that must not drift

- The external stock config must **omit** `agentOptions` entirely: the official
  `dsh-tool-subagent` checks `config.agentOptions !== undefined` and rejects a
  provider without `capabilities.agentOptions`.
- The external stock config must use `maxDepth: 'provider-managed'`: the OMC
  provider declares `depthLimit: false`.
- `role.execution` is not a DSH model route. `provider`/`model` on a role remain
  LLM-routing settings for the native path and must never be rewritten to
  `omc:<id>`.
