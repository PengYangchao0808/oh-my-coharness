# Upstream OMD test suite (reference only)

These are the tests shipped with **oh-my-dsh-slim 0.8.6** at the pinned commit
`537d4c7f5dc3`. They are kept for provenance and for diffing against upstream
when a behavior question comes up.

They are **not** the merged product's release gate:

- They assert OMD's old identity strings (`oh-my-dsh-slim` preset id, settings
  namespace, config file names, RPC path, client module id). v0.4 deliberately
  changed all of those, so identity-only assertions fail even where behavior is
  unchanged.
- The merged contract tests live in `test/integration/` at the repository root
  and are the tests `npm test` runs.
- The native role path is the part these upstream tests protect best. When
  debugging a native regression, run the individual files directly with Node:
  `node vendor/omd/test/runtime.test.mjs` (the `node --test` runner spawns child
  processes and is blocked in some sandboxed environments).

At the pinned import, all 21 `*.test.mjs` files pass against pristine OMD 0.8.6.
After the merge, 13 still pass unchanged; the remaining 8 assert the old public
identity or the old config-file name. `vendor/omd/PATCHES.md` lists every
behavioral change.
