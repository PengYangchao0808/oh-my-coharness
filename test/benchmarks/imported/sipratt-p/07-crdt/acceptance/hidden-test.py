
import sys, json, random

def ok(group):
    print(f"{group}: ok"); sys.stdout.flush()

def dup(op):
    return json.loads(json.dumps(op))

# basic single-replica editing
a = Replica("A")
ops = []
for i, ch in enumerate("hello"):
    ops.append(a.local_insert(i, ch))
assert a.text() == "hello"
ops.append(a.local_delete(0))
assert a.text() == "ello"
ops.append(a.local_insert(0, "H"))
assert a.text() == "Hello"
ok("basic")

# ops are JSON-serializable dicts
for op in ops:
    assert isinstance(op, dict)
    json.dumps(op)
ok("serializable")

# two-way convergence with the EXACT concurrent-order rule
a = Replica("A"); b = Replica("B")
oa = a.local_insert(0, "x")          # A: (1,"A")
b.apply(dup(oa))
assert b.text() == "x"
o1 = a.local_insert(1, "a")          # concurrent, same origin (after 'x'): A (2,"A")
o2 = b.local_insert(1, "b")          # B (2,"B")
a.apply(dup(o2)); b.apply(dup(o1))
assert a.text() == b.text(), f"diverged: {a.text()!r} vs {b.text()!r}"
assert a.text() == "xba", f"concurrent order rule: expected 'xba', got {a.text()!r}"
ok("concurrent_order")

# out-of-order + duplicate delivery, buffering
a = Replica("A"); b = Replica("B")
o1 = a.local_insert(0, "1")
o2 = a.local_insert(1, "2")
o3 = a.local_insert(2, "3")
od = a.local_delete(1)              # deletes '2'
assert a.text() == "13"
b.apply(dup(od))                    # delete before its insert arrives
b.apply(dup(o3))                    # insert whose origin hasn't arrived
assert b.text() in ("", "3"), "buffering should hold od/o3 or show only what is placeable"
b.apply(dup(o1))
b.apply(dup(o2))
assert b.text() == "13", f"after full delivery expected '13', got {b.text()!r}"
for op in (o1, o2, o3, od):
    b.apply(dup(op))                # duplicates
assert b.text() == "13", "idempotence violated"
ok("out_of_order")

# three-replica randomized convergence (deterministic seed)
random.seed(20260816)
reps = [Replica(s) for s in ("A", "B", "C")]
log = []
for step in range(120):
    r = random.choice(reps)
    if r.text() and random.random() < 0.3:
        log.append(r.local_delete(random.randrange(len(r.text()))))
    else:
        pos = random.randrange(len(r.text()) + 1)
        log.append(r.local_insert(pos, random.choice("abcdefg")))
    # occasionally deliver a random subset in random order to a random replica
    if random.random() < 0.5:
        tgt = random.choice(reps)
        batch = random.sample(log, min(len(log), random.randrange(1, 12)))
        for op in batch:
            tgt.apply(dup(op))
# full delivery, shuffled differently per replica, with duplicates
for r in reps:
    order = log[:]
    random.shuffle(order)
    for op in order:
        r.apply(dup(op))
        if random.random() < 0.2:
            r.apply(dup(op))
texts = [r.text() for r in reps]
assert texts[0] == texts[1] == texts[2], f"divergence: {[t[:40] for t in texts]}"
assert len(texts[0]) > 10, "fuzz produced implausibly short text"
ok("convergence_fuzz")

print("ALL_TESTS_PASSED")
