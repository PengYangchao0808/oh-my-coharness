# Session-strategy benchmark tasks (R07)

Small, fixed tasks used to compare session strategies (reuse/compact vs fresh
handoff vs adaptive). Every task is graded by a command, not by a model's
opinion, so two strategies solving the same task get the same acceptance
result.

Start with `example-local-fix/` — it is real and runnable.

## The tasks that ship today

| task | `kind` | family | what it rewards |
|---|---|---|---|
| `example-local-fix` | should-reuse | `local-fix` | a small local fix in a session that already knows the module |
| `should-reuse-module-fix` | should-reuse | `module-followup` | keeping an already-working function intact while fixing the next one |
| `should-restart-stale-api` | should-restart | `api-migration` | noticing the synchronous loader was removed and migrating to the async contract |

`kind` is a task-set convention read by
`test/integration/benchmark-tasks.test.mjs`; the runner itself ignores it.
Every task in the table is graded both ways (start fails, reference passes).

```
example-local-fix/
  spec.json                     the task definition (graded, read-only)
  start/src/parse-range.mjs     the broken start state a worker receives
  reference/src/parse-range.mjs the reference fix (must pass)
  acceptance/check.mjs          the fixed acceptance command (must pass/fail)
```

`start/` is the whole tree a worker receives; `reference/` is an **overlay** of
the files the fix changes (it does not have to repeat untouched files).

## Add a task

1. `mkdir test/benchmarks/session-strategies/<task-id>/` and add
   `spec.json`, a `start/` tree, a `reference/` fix and an `acceptance/`
   directory with one small script (no dependencies, no network).
2. `spec.json` fields, all of which `integration/acceptance-runner.js`
   validates:

   | field | meaning |
   |---|---|
   | `taskId` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,79}` |
   | `family` | problem family; reworded variants share one family |
   | `split` | `development` \| `validation` \| `holdout` |
   | `goal` | what the worker is asked to achieve |
   | `startState` | `{ from, knownFailure }` — the tree and its known failure |
   | `reference` | path to the reference fix (relative to the family dir) |
   | `writeScope` | directories the worker may change |
   | `commands` | `[{ name, run: [argv...], expect: { exitCode, stdoutContains, stdoutNotContains } }]` |
   | `acceptanceFiles` | files digested before/after the run; editing one is `OMC/ACCEPTANCE-TAMPERED` |
   | `forbidChanges` | files/directories the delivery must not have modified |
   | `rubric` | human/LLM criteria; never the sole truth |

   Unknown extra keys (for example `notes`) are ignored by the runner — it
   grades only the fields above.

3. Check both directions before committing: the reference fix passes
   (`passed: true`) and the start state fails (`passed: false`).
   `test/integration/acceptance-runner.test.mjs` does exactly this against
   `example-local-fix`; add your task the same way.

## The three splits

- `development` — the split you iterate on. Expect to see these tasks again;
  tuning against them is allowed.
- `validation` — used to pick between candidates. Look at it, do not tune on
  it repeatedly.
- `holdout` — untouched until a candidate is frozen. Any number read from
  holdout becomes evidence once; re-reading it to optimise means it is no
  longer holdout.

`deterministicSplit({ tasks, salt })` assigns whole families, never single
tasks, so variants of one problem cannot leak across splits. A family with one
task is development-preferred and the returned `notes` says so — a one-task
family cannot demonstrate leakage and must not count as holdout evidence.

## Two rules that make the results mean anything

1. **The acceptance definition lives outside the worker's write scope.** The
   runner digests `acceptanceFiles` before and after the run and refuses a
   verdict when they changed; `forbidChanges` refuses a delivery that touched
   `acceptance/` or `spec.json`. A worker may add tests, it may not edit the
   grading.
2. **Tasks must include both "should reuse" and "should restart" kinds.**
   A set made only of continuing-a-thread tasks rewards carrying context
   forward — including context that had gone stale. Record the intent in the
   family name or rubric, e.g. `local-fix` / `interface-change` (reuse the
   session) versus `wrong-assumption-recovery` / `restart-after-cancel`
   (the cheapest successful path is a fresh context). Otherwise a strategy
   comparison only measures how good the strategy is at one skill.

`example-local-fix` is a "should reuse" task (a small local fix in a session
that already knows the module). A matching restart task belongs next to it
before any split is used for a promotion claim.
