Migrate `src/read-settings.mjs` to the current async contract so
`node acceptance/check.mjs` prints `ok 5/5`: `readSettings` is async, reads JSON
from disk, applies defaults for missing keys and for a missing file, and the
removed synchronous name `loadConfigSync` does not appear anywhere in `src/`.

Change only files under `src/`. Do not edit `acceptance/check.mjs` or
`spec.json`. Re-run the command until it passes.
