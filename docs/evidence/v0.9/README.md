# PR-09 independent freeze verification — evidence (v0.9)

> **Final update (2026-11-04)**：GitHub Actions [run 41871037131](https://github.com/PengYangchao0808/oh-my-coharness/actions/runs/41871037131) 已全绿（Ubuntu Node20/22、Windows Node22、真实 npm pack/install），机器可读记录见 [final-ci.json](final-ci.json)。本机无 npm 的阻塞已由 CI 的真实安装证据解除。零模型宿主、原生 closure、efficiency 与 cache identity 探针也通过。Desktop 点击与 External Mixed/managed Council 的真实模型验收未执行，0.X 未冻结。下文保留初始本机验证记录，不再代表“CI 未运行”的当前状态。

Scope: the independent verification tools for the 0.X freeze. This directory
contains only machine-readable/text output produced by the commands below, plus
this note. It is written by `scripts/run-tests.mjs` in CI as well
(`test-run-<os>-node<version>.json`) and is the only working-tree change the CI
dirty-tree gate allows.

## What was verified locally

| Command | Result | Evidence |
|---|---|---|
| `node scripts/check.mjs` | pass (exit 0) | `check.txt` |
| `node scripts/pack-check.mjs` | pass (exit 0) | `pack-check.txt` |
| `node scripts/license-check.mjs --out …` | pass (exit 0) | `license-check.txt`, `license-check.json` |
| `node test/integration/registration-surface.test.mjs` | pass (3 pass / 1 explicit skip / 0 fail) | `registration-surface.txt` |
| `node scripts/install-check.mjs --json --out …` | **blocked** (exit 3) | `install-check.txt`, `install-check.json` |

Environment: `win32-x64`, Node `v24.21.0` (the Node bundled with the local DSH
runtime). The package declares `engines.node >= 20`; CI covers Node 20.x/22.x on
Ubuntu plus one Windows/Node 22.x lane.

## What each new/updated tool proves

- **`scripts/license-check.mjs`** — offline. Reads `vendor/omd/UPSTREAM.json`,
  rejects a missing/empty/moving pin (`HEAD`, `main`, `latest`, …) and requires a
  fixed 40-hex commit; requires `vendor/omd/PATCHES.md` and that every
  repository path it names resolves (22 paths); checks the OMD `LICENSE`, the
  root `LICENSE` and `THIRD_PARTY_NOTICES.md` attribution/permission grant; and
  checks `package.json` `files` coverage for the vendored provenance documents.
  It never fetches the network and never infers "dead code" from static import
  reachability — Cordis registers plugins dynamically.
- **`scripts/install-check.mjs`** — runs the real pipeline
  `npm pack` → scratch `npm init -y` → `npm install <tgz>` →
  `require.resolve(oh-my-coharness/package.json)` / entry / preset export, with
  every artifact (tarball, project, npm cache/config, synthetic HOME) inside one
  temp directory. It never runs `npm publish` and does not exist to be a
  pack-check substitute. With no npm it must report `status: "blocked"` and a
  non-zero exit; that is the local result recorded here.
- **`test/integration/registration-surface.test.mjs`** — host-mock contract for
  the dynamic registration surface: `coharness` tool, `/coharness` command, all
  bundled skills, every `omc:<id>` provider, the native-runtime bridge
  (`agent/created`, `session/event`) and budget gate (`agent/pre-step`,
  `agent/request`), the companion settings binding, and the preset row's role
  rows plus every dynamic `file:` module (each target file must exist). The one
  skipped item (real profile RPC transport / host settings card) needs a real
  DSH host; its injection declaration is asserted instead.
- **`scripts/pack-check.mjs`** — now also requires
  `vendor/omd/PATCHES.md`/`UPSTREAM.json`/`LICENSE` and
  `THIRD_PARTY_NOTICES.md`, asserts `private: true`, and keeps the
  forbidden-tree rule (`.github`, `.ops`, `node_modules`, `docs/archive`,
  `*.tgz`).
- **`scripts/check.mjs`** — runs the offline licence check as part of the static
  pass and loads the new `integration/writer-lease.js` module.
  `install-check` is deliberately not part of the static/unit pass: it needs the
  real npm CLI.

## Boundaries (not claimed here)

- **CI was not executed on this machine.** `.github/workflows/ci.yml` was edited
  and inspected, but no GitHub Actions runner was available. The Windows lane,
  artifact upload, dirty-tree gate and the real `install-check` step are
  unverified until CI runs.
- **No real npm on this machine** (the DSH runtime ships Node/pnpm only), so
  `install-check` recorded `blocked` with the exact searched locations; it did
  not pretend to install anything, and pack-check was not used as a stand-in.
- **No DSH Desktop / real Cordis host** was exercised. The registration test
  uses a host mock; `dsh-runtime-smoke` in CI remains an explicit placeholder
  and must not be read as a passing DSH check.
- The tree contained other lanes' in-progress changes during this run. This
  evidence covers only the PR-09 scope; full regression belongs to the
  integrator.
- No `npm publish`, no network access, and no real user npm profile access were
  performed by any of the commands above.

## CI matrix and jobs

- `static-and-contracts`: Ubuntu Node 20.x, Ubuntu Node 22.x, Windows Node 22.x.
  Each lane asserts `private: true`, runs `npm run check` (includes
  `license-check`), runs the test list with `scripts/run-tests.mjs` writing JSON,
  runs the registration-surface test, uploads the JSON artifact, then applies the
  dirty-tree gate (allows only `docs/evidence/v0.9/**`).
- `package-and-install`: Ubuntu Node 20.x. `npm pack --dry-run`, `pack-check`,
  `license-check`, then `install-check --json --out` (real pack + scratch
  install + resolution), artifact upload, and a clean-tree gate.
- `dsh-runtime-smoke`: unchanged placeholder, manual dispatch only.
