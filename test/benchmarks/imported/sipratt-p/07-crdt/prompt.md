Implement a convergent replicated text document (a CRDT) in Python, stdlib only.

API:
- `Replica(site_id: str)` — one collaborator's copy. `site_id` is unique per replica.
- `r.local_insert(pos: int, ch: str) -> dict` — insert single char at index `pos` in r's current visible text; apply locally and return the operation as a JSON-serializable dict to broadcast.
- `r.local_delete(pos: int) -> dict` — delete visible char at index `pos`; apply locally, return the op.
- `r.apply(op: dict) -> None` — apply an op received from another replica (or a duplicate of any op, including one's own).
- `r.text() -> str` — current visible text.

Required semantics (exactly these — they are what the tests check):
1. IDENTITY: every inserted character gets the id `(counter, site_id)` where `counter` is a Lamport clock: each replica's counter starts at 0, increments by 1 on each LOCAL insert, and on receiving any op updates to `max(local, op_counter)` before/so that later local ids stay unique and causally greater. Deletes do not create new ids; a delete op names the id of the deleted character.
2. STRUCTURE (RGA / insert-after): an insert op records the id of the character it was inserted AFTER (`origin`), or the sentinel origin `None` for position 0. Deleted characters become invisible TOMBSTONES but keep their place in the sequence (they still serve as origins).
3. CONCURRENT ORDER RULE: characters inserted after the SAME origin appear in DESCENDING order of `(counter, site_id)` — i.e. higher counter first; ties on counter broken by higher site_id first. (This makes a replica's own consecutive typing read left-to-right, and gives one deterministic answer for concurrent inserts.) When walking to place a new node after its origin, it must skip over any nodes (and their descendants) with greater `(counter, site_id)` per this rule — the standard RGA insertion scan.
4. DELIVERY: ops may arrive OUT OF ORDER and DUPLICATED. `apply` must be idempotent (same op twice = once). An insert whose origin hasn't arrived yet, or a delete whose target hasn't arrived yet, must be BUFFERED and applied automatically once its dependency arrives. No exceptions thrown for any of this.
5. CONVERGENCE: any set of replicas that has received the same set of ops (in any order, with any duplication) has identical `text()`.

Output only the Python code, no explanation.