Continue the same session in the isolated OMC worktree. The task fixture is
`test/benchmarks/session-strategies/should-restart-stale-api/` and its working
sources are in `src/` (created from `start/src` in the previous turn).

Migrate `test/benchmarks/session-strategies/should-restart-stale-api/src/read-settings.mjs`
to the current async contract so
`node test/benchmarks/session-strategies/should-restart-stale-api/acceptance/check.mjs`
prints `ok 5/5`: `readSettings` is async, reads JSON from disk, applies defaults
for missing keys and for a missing file, and the removed synchronous name
`loadConfigSync` does not appear anywhere in `src/`.

Change only files under that fixture's `src/`. Do not edit `start/`,
`acceptance/`, `reference/` or `spec.json`. Re-run the command until it passes.
