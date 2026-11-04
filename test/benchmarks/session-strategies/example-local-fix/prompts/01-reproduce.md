You are starting a real coding session in an isolated git worktree of the OMC
repository. Work only inside this worktree.

Workspace contract (paths are relative to the worktree root):

- The task fixture is `test/benchmarks/session-strategies/example-local-fix/`.
- Create `test/benchmarks/session-strategies/example-local-fix/src/` by copying
  `test/benchmarks/session-strategies/example-local-fix/start/src/` once. Do not
  edit `start/`, `acceptance/`, `reference/` or `spec.json`.
- Run `node test/benchmarks/session-strategies/example-local-fix/acceptance/check.mjs`.
  It exits 1.

This turn only reproduces the failure. Do not modify any file. Report exactly
which of the 7 contract cases in the acceptance script fail and what
`src/parse-range.mjs` currently returns for each failing input (include the
`"1-3"` case). The fix is the next turn.
