Fix only `truncate()` in `src/text-utils.mjs` so `node acceptance/check.mjs`
prints `ok 6/6`, including the ellipsis-length, short-text, `max=1` and `max=0`
cases, while `slugify()` keeps its current behaviour.

Change only files under `src/`. Do not edit `acceptance/check.mjs` or
`spec.json`. Re-run the command until it passes.
