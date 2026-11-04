Implement an async task orchestrator in Python (pure stdlib, asyncio only).

API:
- `class Orchestrator:`
  - `add_task(name: str, fn, deps: list[str] = []) -> None`
    `fn` is an async callable invoked as `await fn(results)` where `results` is a
    dict {dep_name: dep_result} containing ONLY that task's declared deps.
    Re-adding an existing name raises `ValueError`. A dep that was never added
    by the time `run()` is called raises `ValueError` from `run()`.
  - `async def run(self, task_timeout: float | None = None) -> dict`
    Executes the whole DAG and returns {name: outcome} for EVERY task, where
    outcome is one of:
      {"status": "ok", "result": <return value>}
      {"status": "failed", "error": <the exception instance>}
      {"status": "cancelled"}            # exceeded task_timeout
      {"status": "skipped"}              # any transitive dep not "ok"

RULES — read carefully, they are exactly graded:
1. CONCURRENCY IS REAL: tasks whose deps are satisfied run concurrently
   (the tests wall-clock this). A task starts as soon as ALL its deps are "ok"
   — not in topological "levels"/batches: if A takes 0.3s and B takes 0.1s and
   C depends only on B, C must start ~0.1s in, while A is still running.
2. A task failure (exception) marks it "failed"; every transitive dependent
   becomes "skipped" (never started). Unrelated tasks keep running to completion.
3. `task_timeout` applies per task: a task exceeding it is cancelled
   (asyncio-cancelled, not left running) and reported "cancelled"; its
   dependents are "skipped".
4. Cycles: `run()` raises `ValueError` BEFORE starting any task.
5. `run()` never raises for task failures/timeouts — they are reported in the
   returned dict.

Output only the Python code, no explanation.