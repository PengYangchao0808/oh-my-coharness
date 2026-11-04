Continue the same session in the isolated OMC worktree. The task fixture is
`test/benchmarks/session-strategies/should-reuse-module-fix/` and its working
sources are in `src/` (created from `start/src` in the previous turn).

Fix only `truncate()` in
`test/benchmarks/session-strategies/should-reuse-module-fix/src/text-utils.mjs`
so `node test/benchmarks/session-strategies/should-reuse-module-fix/acceptance/check.mjs`
prints `ok 6/6`, including the ellipsis-length, short-text, `max=1` and `max=0`
cases, while `slugify()` keeps its current behaviour.

Change only files under that fixture's `src/`. Do not edit `start/`,
`acceptance/`, `reference/` or `spec.json`. Re-run the command until it passes.
