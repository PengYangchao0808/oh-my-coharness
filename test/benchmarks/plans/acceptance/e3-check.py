#!/usr/bin/env python3
"""E3 acceptance wrapper (real sipratt checkout worktree).

The candidate is `solution.py` at the worktree root (the worker writes it
there). The grading program is the frozen upstream hidden test extracted into
this repository at import time; it is never read from the worktree, so a worker
cannot weaken it by editing the upstream module.

Usage: python e3-check.py <07-crdt|08-orchestrator>
"""
import json
import os
import subprocess
import sys
import tempfile

GROUPS = {
    "07-crdt": ["basic", "serializable", "concurrent_order", "out_of_order", "convergence_fuzz"],
    "08-orchestrator": ["basic_dag", "true_concurrency", "failure_skip", "timeout_cancel", "validation"],
}

if len(sys.argv) != 2 or sys.argv[1] not in GROUPS:
    print("usage: e3-check.py <07-crdt|08-orchestrator>")
    sys.exit(2)
task = sys.argv[1]
groups = GROUPS[task]

# .../test/benchmarks/plans/acceptance/e3-check.py -> repository root
here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(here))))
hidden_path = os.path.join(repo, "test", "benchmarks", "imported", "sipratt-p", task, "acceptance", "hidden-test.py")
solution_path = os.path.join(os.getcwd(), "solution.py")

for path, label in ((solution_path, "solution.py"), (hidden_path, "hidden-test.py")):
    if not os.path.isfile(path):
        print(f"fail 0/{len(groups)}: missing {label} at {path}")
        sys.exit(1)

with open(solution_path, encoding="utf-8") as handle:
    solution = handle.read()
with open(hidden_path, encoding="utf-8") as handle:
    hidden = handle.read()

fd, program = tempfile.mkstemp(suffix=".py")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(solution + "\n\n" + hidden)
    try:
        proc = subprocess.run([sys.executable, program], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"fail 0/{len(groups)}: timed out")
        sys.exit(1)
finally:
    try:
        os.unlink(program)
    except OSError:
        pass

sys.stdout.write(proc.stdout)
if proc.stderr.strip():
    sys.stderr.write(proc.stderr)

found = [line.split(":")[0].strip() for line in proc.stdout.splitlines() if ": ok" in line]
missing = [group for group in groups if group not in found]
if "ALL_TESTS_PASSED" in proc.stdout and not missing and proc.returncode == 0:
    print(f"ok {len(groups)}/{len(groups)}")
    sys.exit(0)
print(f"fail {len(groups) - len(missing)}/{len(groups)}: missing {', '.join(missing) or 'ALL_TESTS_PASSED'}")
sys.exit(1)
