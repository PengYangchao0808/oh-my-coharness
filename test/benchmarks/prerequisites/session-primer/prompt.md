# Shared prerequisite prompt (E2 session primer)

You are starting a fresh coding session in an isolated git worktree of the OMC
repository. Work only inside this worktree.

Workspace contract (paths are relative to the worktree root):

- The fixture lives at `test/benchmarks/prerequisites/session-primer/`.
- Create `test/benchmarks/prerequisites/session-primer/src/` by copying
  `test/benchmarks/prerequisites/session-primer/start/src/` once. Do not edit
  anything under `start/`, `acceptance/`, `reference/` or `spec.json`.
- Run `node test/benchmarks/prerequisites/session-primer/acceptance/check.mjs`.
  It exits 1 and prints the failing rows.
- Fix `test/benchmarks/prerequisites/session-primer/src/session-brief.mjs` so
  the same task list always produces the same brief:
  - a non-array argument throws `TypeError`;
  - an entry without a non-empty string `id` throws `TypeError`;
  - ids are trimmed, statuses are trimmed and lower-cased;
  - a missing status becomes an empty status (row is `"id: "`);
  - rows are sorted by id and joined with exactly one newline;
  - an empty list yields the empty string.
- Re-run the same command until it prints `ok 6/6`.

Do not edit the grader or the spec. This is the shared warm-up turn: the session
strategy continues afterwards with the real E2 tasks, so leave the workspace
clean and the passing suite in place.
