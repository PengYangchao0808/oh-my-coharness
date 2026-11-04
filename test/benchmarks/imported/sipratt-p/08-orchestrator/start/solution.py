"""OMC-authored failing start state for the upstream orchestrator task.

The upstream dataset is a one-shot generation benchmark: it ships a prompt, a
hidden test program and a reference solution, but no start workspace. OMC
therefore supplies this deliberately incomplete stub so the grader's failing
direction is exercised. This file is NOT upstream code and carries no upstream
claim; the reference solution next to it is upstream.
"""
import asyncio


class Orchestrator:
    def __init__(self):
        self._tasks = []

    def add_task(self, name, fn, deps=None):
        self._tasks.append((name, fn, list(deps or [])))

    async def run(self, task_timeout=None):
        results = {}
        for name, fn, deps in self._tasks:
            results[name] = {"status": "ok", "result": await fn({})}
        return results
