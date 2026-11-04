Continue the same session in the isolated OMC worktree. The task fixture is
`test/benchmarks/session-strategies/example-local-fix/` and its working sources
are in `src/` (created from `start/src` in the previous turn).

Fix `test/benchmarks/session-strategies/example-local-fix/src/parse-range.mjs`
so `node test/benchmarks/session-strategies/example-local-fix/acceptance/check.mjs`
prints `ok 7/7`: inclusive ascending ranges, single values, blank input -> empty
list, descending -> `RangeError`, non-numeric -> `TypeError`.

Change only files under that fixture's `src/`. Do not edit `start/`,
`acceptance/`, `reference/` or `spec.json`. Re-run the command until it passes
and keep the export name `parseRange`.
