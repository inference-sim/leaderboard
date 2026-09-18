#!/usr/bin/env python3
"""One-off: correct the declared prompt/output token stdev in results.json.

gen.py never passed --prompt-tokens-stdev or --output-tokens-stdev to blis, so
blis used its own defaults — 256 for both (../inference-sim/cmd/root.go:44,48) —
while the fixture's group.workload declared 128/32. The metrics in the fixture
were produced at 256/256; only the declaration was wrong. This script corrects
the declaration to match what actually produced the numbers and recomputes
group_id/work_id. It does NOT touch metrics or metrics_raw.

Reuses canon()/short_hash() from migrate_v1.py, which mirrors Go's
internal/schema.CanonicalJSON — if TestCanonicalJSONSortsKeysAndDropsWhitespace
disagrees with this script, the Go value wins and this script is wrong.

Run once:  python3 prototypes/fix_stdev.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from migrate_v1 import canon, short_hash  # noqa: E402

HERE = pathlib.Path(__file__).parent
TARGET = HERE / "results.json"


def fix(rec):
    g = rec["group"]
    g["workload"]["prompt_tokens_stdev"] = 256
    g["workload"]["output_tokens_stdev"] = 256
    rec["group_id"] = short_hash(g)
    rec["work_id"] = short_hash({k: v for k, v in g.items() if k != "seed"})
    return rec


def main():
    records = [fix(r) for r in json.loads(TARGET.read_text())]
    TARGET.write_text(json.dumps(records, indent=1) + "\n")
    counts = {}
    for r in records:
        counts[r["group_id"]] = counts.get(r["group_id"], 0) + 1
    for gid, n in sorted(counts.items()):
        print(f"{gid}  {n} records")


if __name__ == "__main__":
    main()
