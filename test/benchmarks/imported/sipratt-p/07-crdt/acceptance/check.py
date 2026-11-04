#!/usr/bin/env python3
"""Fixed acceptance program for the upstream sipratt-p task "Convergent Replicated Text (CRDT)".

Grading program: `acceptance/hidden-test.py` is the task's upstream hidden test
program, extracted verbatim from bench/coding_benchmark_v3.py (CRDT_TASK["test_code"])
at the frozen commit. Its sha256 is recorded in spec.json and MANIFEST.json.

This wrapper reproduces the FUNCTIONAL half of the upstream grader only: it
concatenates the candidate `solution.py` with the hidden test and runs it in a
child interpreter, exactly like bench/coding_benchmark_v2.py#run_python. It does
NOT reproduce the upstream `code_quality` text heuristic or the partial-credit
group mapping, so this verdict is "all functional groups passed", not an
official score.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GROUPS = ["basic","serializable","concurrent_order","out_of_order","convergence_fuzz"]

solution_path = os.path.join(ROOT, "solution.py")
hidden_path = os.path.join(HERE, "hidden-test.py")
for path in (solution_path, hidden_path):
    if not os.path.isfile(path):
        print(f"fail 0/{len(GROUPS)}: missing {os.path.basename(path)}")
        sys.exit(1)

with open(solution_path, encoding="utf-8") as handle:
    solution = handle.read()
with open(hidden_path, encoding="utf-8") as handle:
    hidden = handle.read()

fd, program_path = tempfile.mkstemp(suffix=".py")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(solution + "\n\n" + hidden)
    try:
        proc = subprocess.run([sys.executable, program_path], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"fail 0/{len(GROUPS)}: timed out")
        sys.exit(1)
finally:
    try:
        os.unlink(program_path)
    except OSError:
        pass

sys.stdout.write(proc.stdout)
if proc.stderr.strip():
    sys.stderr.write(proc.stderr)

found = [line.split(":")[0].strip() for line in proc.stdout.splitlines() if ": ok" in line]
missing = [group for group in GROUPS if group not in found]
passed = "ALL_TESTS_PASSED" in proc.stdout and not missing and proc.returncode == 0
if passed:
    print(f"ok {len(GROUPS)}/{len(GROUPS)}")
    sys.exit(0)
print(f"fail {len(GROUPS) - len(missing)}/{len(GROUPS)}: missing {', '.join(missing) or 'ALL_TESTS_PASSED'}")
sys.exit(1)
