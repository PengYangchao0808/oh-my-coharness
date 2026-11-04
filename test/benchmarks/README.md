# Benchmark fixtures (0.8 / PR-06 + PR-07 plans)

Fixtures, the provenance registry and the frozen experiment plans live here:

- `session-strategies/` — **C group**, 3 OMC-authored continuous tasks used by
  experiment **E2** (reuse/compact vs fresh handoff vs adaptive). See
  [`session-strategies/README.md`](session-strategies/README.md).
- `prerequisites/` — the **E2 shared prerequisite** (`session-primer`): real
  graded work run once per arm before that arm's first trial. It is registered
  under `MANIFEST.json#prerequisites`, never counted as a trial, and therefore
  does not change the 4 / 2 / 3 task counts.
- `plans/e1.json`, `plans/e2.json`, `plans/e3.json` — executable frozen plan
  documents consumed by `node scripts/strategy-runner.mjs --manifest <plan>
  --plan`. They bind **12 + 9 + 4 = 25** trials to the real fixtures against
  frozen checkouts, freeze seed, repeats=1, budget caps ($12/$12/$8),
  concurrency 1 and deadline, and select real native models
  (`kimi-coding/k3.1-pro` writer; `kimi-coding/kimi-for-coding` reviewer for the
  different-model arms). `status: "ready"` means every input is resolved;
  `executionStatus: "not-executed"` means no trial has run. `--plan` writes no
  receipt and executes nothing; `--execute` still needs
  `--max-usd` + `--confirm-paid-experiment` and a host executor.
- `plans/acceptance/` — the per-task acceptance documents the plans freeze
  (upstream-relative commands for E1, hidden-test wrappers for E2/E3) plus the
  E2/E3 wrappers they invoke.
- `imported/` — **A group** (4 JavaScript tasks from
  `latitude-dev/coding-agent-benchmark`, experiment **E1**) and **B group**
  (2 Python tasks from `sipratt-p/coding-agent-bench`, experiment **E3**).
- `upstream/` — the vendored upstream bytes the imported fixtures were cut
  from, kept verbatim (including each dataset's `LICENSE`).

## Executable inputs frozen in the plans

- **Repositories**: E1 and E3 use the verified frozen checkouts under
  `.ops/benchmark-repos/` at `cd28f39…` / `3e9bca9…`; E2 uses the current OMC
  checkout at `66de9df…`.
- **Prompts**: every task carries a real prompt string plus
  `promptMeta { sha256, source }`. E1 appends only an execution-workspace
  paragraph to the verbatim upstream `tasks/<id>/prompt.md`; E3 does the same for
  the upstream `CRDT_TASK`/`ORCH_TASK` prompt literal (and pins the module
  sha256/anchor); E2 uses the OMC per-turn prompts, one per chain step, each
  naming the real acceptance command and fixture path.
- **Acceptance**: each task points at an absolute acceptance JSON document and
  freezes its sha256, `command`, `acceptanceFiles`, `forbidChanges` and the
  fixture `gradingSha256`; every frozen worktree-relative file is checked to
  exist at the base commit.
- **Roles**: `manifest.armExecution` (and the document-level
  `execution.armExecution` mirror, because the evaluator drops the field) freezes
  `writer`/`reviewer` with `surface: "native"`, `writer: false`,
  `readOnly: true` for reviewers. E2 chain trials run the writer for each turn;
  the session strategy supplies reuse/handoff/adaptive semantics.
- **Worktree check**: each plan records a `git cat-file`/`git show` verification
  of its base commit and every start/reference/acceptance/spec path (E2 also
  re-checks the frozen spec and grading sha256).

`manifest.conditions.promptDigest` is a digest over every task/turn prompt hash,
so editing an instruction changes the frozen plan.

`MANIFEST.json` is the single registry: datasets (repo URL, frozen commit,
license, runtime floor), experiments (E1=4, E2=3, E3=2), the digest of every
vendored upstream file, one entry per trial task pointing at its `spec.json`,
and the shared prerequisites that are registered but never counted as trials.

Each `spec.json` carries a `provenance` block. The acceptance runner ignores
unknown keys, so provenance never changes grading.

## Provenance rules

| field | meaning |
|---|---|
| `dataset` | `latitude-dev/...`, `sipratt-p/...` or `omc-authored` |
| `repoUrl` / `baseCommit` | the GitHub repo and the **frozen 40-hex commit** |
| `license` | `{spdx, path, url}`; the vendored `LICENSE` is in `upstream/` |
| `importedAt` | when the fixture was cut |
| `upstreamDigests` | upstream path → `{sha256, gitBlobSha1, localPath}`; `gitBlobSha1` is recomputed as `sha1("blob <len>\\0" + bytes)` and must equal the GitHub tree sha at the frozen commit |
| `grading` | the frozen grading program's sha256 plus the literal argv the runner executes |
| `startState` / `reference` | origin (`upstream-workspace`, `upstream-solution`, `omc-authored`) and pins |

Digests are computed over the bytes on disk after normalising CRLF to LF, so
they stay correct under `core.autocrlf` while still matching the upstream git
blob exactly.

OMC-authored tasks must **not** claim upstream provenance: they record
`authoredBy: "OMC"`, the OMC checkout `baseCommit`, an empty `upstreamDigests`
and their own `localDigests`.

## Honest limits and quarantine

- **A group** reproduces the upstream grading fully: the frozen test file is
  restored over the start tree and run with `node --test`. Upstream requires
  Node >= 24 for its own harness; the fixtures run the same suite on the local
  Node 24 runtime and record that floor.
- **B group** is a one-shot generation benchmark upstream: it ships a prompt, a
  hidden test program and a reference solution, but **no start workspace**. The
  `start/solution.py` files are therefore labelled OMC-authored stubs. Grading
  re-runs the upstream hidden test verbatim and asserts that every functional
  group passes, but upstream also awards points from a `code_quality` text
  heuristic and a partial-credit group mapping. Those components are
  **quarantined/unknown** in the spec and are not scored or claimed here; no
  official 0–100 score is reproduced.
- Nothing quarantined is counted in a final benchmark score. A task with a
  quarantined component is `verified-functional`, never `verified`.
- **The plans are ready, not run.** `plans/*.json` freeze complete inputs
  (checkouts, prompts, acceptance, roles, budget/concurrency/deadline) and
  `conditions.modelSelected/harnessSelected` are `true`, but
  `executionStatus` is `not-executed`: no trial has run and no receipt exists.
  A paid execute still needs a host executor (`runTrial()`), which this CLI
  deliberately does not provide.

## Verifying

```bash
node --test test/integration/manifest-provenance.test.mjs
node --test test/integration/benchmark-plan.test.mjs
node --test test/integration/benchmark-tasks.test.mjs
```

`manifest-provenance.test.mjs` recomputes every digest, re-extracts the B hidden
tests from the vendored upstream source, checks that paths stay inside their
fixture, that grading argv contains no shell string, and grades every task plus
the shared prerequisite both ways through the real acceptance runner (start
fails, reference passes, frozen grading untouched). B grading is skipped with an
explicit skip when Python is unavailable; the recorded Python floor is still
checked.

`benchmark-plan.test.mjs` runs `strategy-runner.mjs --plan` against the three
plans: 12/9/4 trials, deterministic output, one real fixture per trial with its
`baseCommit`/license/acceptance digest, E2's shared prerequisite (one run per
arm, not a trial) and ordered chains, and the paid-execute double gate still
refusing. No model is ever executed.

`benchmark-tasks.test.mjs` covers the C group (including `example-local-fix`).

Fixtures are frozen data: do not edit `start/`, `reference/` or `acceptance/`
to make a test pass. Change the registry only by importing a new frozen commit
with real digests.
