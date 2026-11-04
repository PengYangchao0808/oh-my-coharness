Fix `src/parse-range.mjs` so `node acceptance/check.mjs` prints `ok 7/7`:
inclusive ascending ranges, single values, blank input -> empty list, descending
-> `RangeError`, non-numeric -> `TypeError`.

Change only files under `src/`. Do not edit `acceptance/check.mjs` or
`spec.json`. Re-run the command until it passes, and keep the current export name
`parseRange`.
