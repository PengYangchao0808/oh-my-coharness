# Shared prerequisite prompt (E2 session primer)

You are starting a fresh coding session. Work only inside this workspace.

1. Run `node acceptance/check.mjs` once. It exits 1 and prints the failing rows.
2. Read `src/session-brief.mjs` and fix `summariseTasks()` so the same task list
   always produces the same brief:
   - a non-array argument throws `TypeError`;
   - an entry without a non-empty string `id` throws `TypeError`;
   - ids are trimmed and statuses are trimmed and lower-cased;
   - a missing status becomes an empty status (row is `"id: "`);
   - rows are sorted by id and joined with exactly one newline;
   - an empty list yields the empty string.
3. Re-run `node acceptance/check.mjs` until it prints `ok 6/6`.

Do not edit `acceptance/check.mjs` or `spec.json`; change only files under `src/`.
This is a warm-up turn: the session strategy continues afterwards with the real
E2 tasks, so keep the workspace clean and leave the passing suite in place.
