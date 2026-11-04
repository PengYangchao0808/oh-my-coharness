# Worktree CI failure on Linux — root cause and fix (PR-09 follow-up)

CI baseline `a5d60d7` failed only on the two Ubuntu lanes:

```
test/integration/worktree.test.mjs:62
'a task worktree is a branch checkout under the repository root'
false !== true   (created.ok)
```

Windows Node 22 passed, package/real-install passed.

## Root cause: platform-specific test fixture, not a production bug

The test built its repository fixture from a literal Windows path:

```js
await createTaskWorktree(git.ctx, { repo: 'C:/repo', name: 'task-codex' })
```

`integration/worktree.js` deliberately requires a **platform-absolute** repository
path before it runs any git command:

```js
if (typeof repo !== 'string' || repo.trim() === '' || !isAbsolute(repo)) {
  return { ok: false, code: 'OMC/WORKTREE-REPO', ... }
}
```

`isAbsolute` is `node:path`'s platform implementation:

| platform | `isAbsolute('C:/repo')` | result |
|---|---|---|
| win32 | `true` | worktree proceeds |
| posix (Linux) | `false` | `OMC/WORKTREE-REPO` returned before git |

So on Ubuntu the fixture was rejected immediately, `created.ok` was `false`, and
line 62 failed. The failure is **not** git availability (the test uses a fake git
and CI has git) and **not** realpath/separator handling in the production path
logic; the production guard is correct — a git `cwd` and the joined worktree path
must be absolute *on the running platform*. The old assertion also hard-coded the
Windows drive prefix, so it could only ever pass on Windows.

## Fix (test only; assertions kept strict)

`test/integration/worktree.test.mjs`:

- repository fixture now follows the running platform:
  `process.platform === 'win32' ? 'C:/repo' : '/repo'`;
- the expected worktree location is derived with `node:path`'s `join(...)` and
  compared after separator normalisation, instead of matching a literal
  `^C:/repo/...` regex;
- added `assert.equal(isAbsolute(REPO), true)` so the fixture premise is explicit;
- added a regression test: a relative repository path is refused with
  `OMC/WORKTREE-REPO` **before any git call** (`git.calls.length === 0`). This
  pins the production guard instead of loosening it.

No production file changed. No assertion was deleted or weakened.

## Verification

| Check | Platform | Result |
|---|---|---|
| `node test/integration/worktree.test.mjs` | Windows (win32-x64, Node v24.21.0) | 8/8 pass |
| `node test/integration/worktree.test.mjs` | WSL Ubuntu (Linux, Node v22.23.4) | 8/8 pass, exit 0 |
| `node test/integration/host-executor.test.mjs` | Windows | 9/9 pass |
| `node test/integration/host-executor.test.mjs` | WSL Ubuntu | 9/9 pass, exit 0 |
| `node test/integration/strategy-eval.test.mjs` | Windows | 22/22 pass |
| `node test/integration/strategy-eval.test.mjs` | WSL Ubuntu | 22/22 pass, exit 0 |

Root-cause reproduction on Linux with the old fixture (fake git records calls):

```
old Windows-style fixture on Linux -> ok=false code=OMC/WORKTREE-REPO gitCalls=0
platform-absolute fixture on Linux -> ok=true path=/repo/.agents/worktrees/task-codex-... repoRoot=/repo
```

That is the exact pre-fix behaviour: zero git calls, so `created.ok` could never
be true on POSIX.

## Boundaries

- The fix was not pushed and no commit was made; the integrator owns the commit.
- Local Linux verification used WSL Ubuntu with Node 22.23.4; CI Ubuntu Node 20/22
  re-run is still required.
- A full `npm test` was not repeated here (other lanes were still writing); the
  affected suites above plus the real-install packaging job are the evidence.
