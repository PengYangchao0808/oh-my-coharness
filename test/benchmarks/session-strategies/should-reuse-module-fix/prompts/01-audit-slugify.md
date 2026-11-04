You are starting a real coding session in an isolated git worktree of the OMC
repository. Work only inside this worktree.

Workspace contract (paths are relative to the worktree root):

- The task fixture is `test/benchmarks/session-strategies/should-reuse-module-fix/`.
- Create `test/benchmarks/session-strategies/should-reuse-module-fix/src/` by
  copying `test/benchmarks/session-strategies/should-reuse-module-fix/start/src/`
  once. Do not edit `start/`, `acceptance/`, `reference/` or `spec.json`.
- Run `node test/benchmarks/session-strategies/should-reuse-module-fix/acceptance/check.mjs`.
  It exits 1.

This turn only audits the failure. Do not modify any file. Report which
`truncate()` cases fail and confirm that the two `slugify()` cases currently
pass, quoting the observed values. The fix is the next turn.
