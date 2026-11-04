
import asyncio, sys, time

def ok(group):
    print(f"{group}: ok"); sys.stdout.flush()

async def sleepy(t, ret=None, log=None, name=None):
    if log is not None: log.append((name, "start", time.monotonic()))
    await asyncio.sleep(t)
    if log is not None: log.append((name, "end", time.monotonic()))
    return ret

# --- basic DAG order + results routing
async def t_basic():
    o = Orchestrator()
    o.add_task("a", lambda res: sleepy(0.01, ret=2))
    o.add_task("b", lambda res: sleepy(0.01, ret=3))
    async def mul(res): return res["a"] * res["b"]
    o.add_task("c", mul, deps=["a", "b"])
    r = await o.run()
    assert r["a"] == {"status": "ok", "result": 2}
    assert r["c"]["status"] == "ok" and r["c"]["result"] == 6
    # results dict contains ONLY declared deps
    async def keys(res): return sorted(res.keys())
    o2 = Orchestrator()
    o2.add_task("x", lambda res: sleepy(0, ret=1))
    o2.add_task("y", lambda res: sleepy(0, ret=1))
    o2.add_task("z", keys, deps=["y"])
    r2 = await o2.run()
    assert r2["z"]["result"] == ["y"], f"results must contain only declared deps, got {r2['z']['result']}"
    return True
assert asyncio.run(t_basic())
ok("basic_dag")

# --- real concurrency: independent tasks overlap; C starts when B done (not when A done)
async def t_conc():
    log = []
    o = Orchestrator()
    o.add_task("A", lambda res: sleepy(0.5, log=log, name="A"))
    o.add_task("B", lambda res: sleepy(0.1, log=log, name="B"))
    o.add_task("C", (lambda res: sleepy(0.1, log=log, name="C")), deps=["B"])
    t0 = time.monotonic()
    await o.run()
    total = time.monotonic() - t0
    assert total < 0.75, f"A(0.5s) and B(0.1s)+C(0.1s) must overlap; took {total:.2f}s"
    ev = {(n, k): t for n, k, t in log}
    assert ev[("C", "start")] < ev[("A", "end")] - 0.15, "C must start while A still running (no level-sync)"
    return True
assert asyncio.run(t_conc())
ok("true_concurrency")

# --- failure propagation: transitive skip, unrelated tasks unaffected
async def t_fail():
    async def boom(res): raise RuntimeError("nope")
    o = Orchestrator()
    o.add_task("a", boom)
    o.add_task("b", lambda res: sleepy(0.05, ret="b"), deps=["a"])
    o.add_task("c", lambda res: sleepy(0.05, ret="c"), deps=["b"])
    o.add_task("free", lambda res: sleepy(0.05, ret="free"))
    r = await o.run()
    assert r["a"]["status"] == "failed" and isinstance(r["a"]["error"], RuntimeError)
    assert r["b"]["status"] == "skipped" and r["c"]["status"] == "skipped"
    assert r["free"] == {"status": "ok", "result": "free"}
    return True
assert asyncio.run(t_fail())
ok("failure_skip")

# --- timeout cancellation: task truly cancelled, dependents skipped
async def t_cancel():
    flag = {"leaked": False}
    async def slow(res):
        try:
            await asyncio.sleep(5)
            flag["leaked"] = True
        except asyncio.CancelledError:
            raise
    o = Orchestrator()
    o.add_task("slow", slow)
    o.add_task("dep", lambda res: sleepy(0.01, ret=1), deps=["slow"])
    o.add_task("quick", lambda res: sleepy(0.05, ret="q"))
    t0 = time.monotonic()
    r = await o.run(task_timeout=0.2)
    took = time.monotonic() - t0
    assert r["slow"]["status"] == "cancelled"
    assert r["dep"]["status"] == "skipped"
    assert r["quick"]["status"] == "ok"
    assert took < 1.5, f"run must not wait out the 5s sleep (took {took:.2f}s)"
    await asyncio.sleep(0.05)
    assert not flag["leaked"], "cancelled task kept running"
    return True
assert asyncio.run(t_cancel())
ok("timeout_cancel")

# --- validation: cycles + unknown deps + duplicate names
async def t_valid():
    o = Orchestrator()
    o.add_task("a", lambda res: sleepy(0), deps=["b"])
    o.add_task("b", lambda res: sleepy(0), deps=["a"])
    try:
        await o.run()
        raise AssertionError("cycle must raise ValueError")
    except ValueError:
        pass
    o2 = Orchestrator()
    o2.add_task("a", lambda res: sleepy(0), deps=["ghost"])
    try:
        await o2.run()
        raise AssertionError("unknown dep must raise ValueError")
    except ValueError:
        pass
    o3 = Orchestrator()
    o3.add_task("a", lambda res: sleepy(0))
    try:
        o3.add_task("a", lambda res: sleepy(0))
        raise AssertionError("duplicate name must raise ValueError")
    except ValueError:
        pass
    return True
assert asyncio.run(t_valid())
ok("validation")

print("ALL_TESTS_PASSED")
