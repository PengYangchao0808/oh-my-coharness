# Third-Party Notices

Oh My CoHarness is MIT-licensed. This file records the third-party code and
text that ship inside the package, with the notices their licenses require.

---

## 1. oh-my-dsh-slim (OMD)

- **Project:** oh-my-dsh-slim
- **Repository:** https://github.com/ninipa/oh-my-dsh-slim
- **Version / commit:** 0.8.6 · `537d4c7f5dc316c449de4ccfff8ab15d15901fa6`
- **License:** MIT
- **Copyright:** Copyright (c) 2026 oh-my-dsh-slim contributors
- **What is included:** the entire `vendor/omd/npm-package/` tree — the agent
  preset, role tool wrapping, persona text, Council, role composition,
  configuration/profile registry, settings card and host companion.
- **Modifications:** the vendored copy is adapted for the merged product:
  package identity, preset id, settings namespace, RPC path, config/profile
  file names, execution-backend routing and the external task brief. The
  canonical list is in [`vendor/omd/PATCHES.md`](../vendor/omd/PATCHES.md).
- **Source record:** [`vendor/omd/UPSTREAM.json`](../vendor/omd/UPSTREAM.json)
- **License text:** [`vendor/omd/LICENSE`](../vendor/omd/LICENSE) (MIT, full text
  reproduced below in section 3).

## 2. oh-my-opencode-slim (OMO Slim)

- **Project:** oh-my-opencode-slim
- **Repository:** https://github.com/alvinunreal/oh-my-opencode-slim
- **License:** MIT
- **Copyright:** Copyright (c) 2025 alvinunreal
- **What is included:** the specialist role persona text (Oracle, Designer,
  Fixer, Explorer, Librarian, Observer) and the Council prompt structure were
  adapted by OMD from OMO Slim 2.2.18 and are carried into this package through
  `vendor/omd/npm-package/preset/preset.js`. The role design and attribution are
  retained per the license terms.
- **No OMO Slim source code repository is vendored.** Only the adapted persona
  text and design attribution travel with OMD.

## 3. MIT license text (applies to sections 1 and 2)

```
MIT License

Copyright (c) 2026 oh-my-dsh-slim contributors
Copyright (c) 2025 alvinunreal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 4. DeepSeek Harness (DSH)

DSH and its `@deepseek-ai/dsh-*` packages are **not** vendored or redistributed
by this package. They are consumed at runtime through the host's own module
loader. The optional `peerDependencies` in `package.json` declare the host
capabilities the plugin expects; they do not ship host code.

## 5. External CLIs

Codex, Claude Code, Gemini CLI, Antigravity, opencode, Kimi, Qwen Code and GLM
are separate products with their own licenses, logins and quotas. Oh My
CoHarness only launches the binaries the user installed; it does not bundle,
relicense or redistribute them, and it does not read their credential files.

## 6. Development-only packages

The upstream OMD test suite under `vendor/omd/test/` references `js-yaml` and
`semver` as development dependencies. Neither package is shipped in the
published npm tarball, and Oh My CoHarness has no runtime dependencies.
