"""OMC-authored failing start state for the upstream CRDT task.

The upstream dataset is a one-shot generation benchmark: it ships a prompt, a
hidden test program and a reference solution, but no start workspace. OMC
therefore supplies this deliberately incomplete stub so the grader's failing
direction is exercised. This file is NOT upstream code and carries no upstream
claim; the reference solution next to it is upstream.
"""


class Replica:
    def __init__(self, site_id: str):
        self.site_id = site_id
        self.chars = []

    def local_insert(self, pos: int, ch: str):
        self.chars.insert(pos, ch)
        return {"ch": ch, "pos": pos}

    def local_delete(self, pos: int):
        return {"pos": pos}

    def apply(self, op):
        return None

    def text(self) -> str:
        return "".join(self.chars)
