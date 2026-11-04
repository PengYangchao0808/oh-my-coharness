You are starting a real coding session in an isolated git worktree of the OMC
repository. Work only inside this worktree.

Workspace contract (paths are relative to the worktree root):

- The task fixture is `test/benchmarks/session-strategies/should-restart-stale-api/`.
- Create `test/benchmarks/session-strategies/should-restart-stale-api/src/` by
  copying `test/benchmarks/session-strategies/should-restart-stale-api/start/src/`
  once. Do not edit `start/`, `acceptance/`, `reference/` or `spec.json`.
- Run `node test/benchmarks/session-strategies/should-restart-stale-api/acceptance/check.mjs`.
  It exits 1.

This turn only detects the stale context. Do not modify any file. Report the
import/loader error, confirm that `loadConfigSync` no longer exists anywhere in
`src/`, and name the async replacement exported by `src/config.mjs`. The
migration is the next turn.
