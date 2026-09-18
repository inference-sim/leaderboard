#!/usr/bin/env python3
"""One-off: migrate results.json from the design-time shape to the shipped schema.

Applies the corrections in the plan's "Corrections to the spec" table:
  C1  workload.distribution "poisson" -> workload.arrival_process "constant"
  C2  deployment.preemption_policy "fcfs" added
  C3  deployment.max_num_scheduled_tokens -> max_num_batched_tokens
  C4  extra_flags.horizon -> group.horizon_ticks, which correctly makes that run
      its own comparability group
  +   group.request_timeout_s = 300 (the --timeout default)

Then recomputes group_id and work_id. The number rendering below mirrors Go's
encoding/json, because internal/schema.GroupID is the authority: if
TestFixtureValidatesAndIsSelfConsistent disagrees with this script, the Go value
wins and this script is wrong.

Run once:  python3 prototypes/migrate_v1.py
"""
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).parent
TARGET = HERE / "results.json"


def canon(o):
    """Canonical JSON matching internal/schema.CanonicalJSON."""
    if o is None:
        return "null"
    if o is True:
        return "true"
    if o is False:
        return "false"
    if isinstance(o, str):
        return json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    if isinstance(o, int):
        return str(o)
    if isinstance(o, float):
        # Go renders an integral float64 without a trailing ".0".
        r = repr(o)
        return r[:-2] if r.endswith(".0") else r
    if isinstance(o, dict):
        items = sorted(o.items())
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False, separators=(",", ":")) + ":" + canon(v)
            for k, v in items
        ) + "}"
    if isinstance(o, list):
        return "[" + ",".join(canon(v) for v in o) + "]"
    raise TypeError(f"canon: unsupported {type(o)}")


def short_hash(o):
    return hashlib.sha256(canon(o).encode()).hexdigest()[:12]


def migrate(rec):
    g, d = rec["group"], rec["deployment"]

    # C1: the arrival process is constant, not poisson.
    g["workload"].pop("distribution", None)
    g["workload"]["arrival_process"] = (
        "constant" if g["workload"]["load"]["kind"] == "rate" else "closed-loop"
    )

    # The --timeout default. Bounds completion, so it bounds the group.
    g.setdefault("request_timeout_s", 300)

    # C3: the deprecated flag spelling.
    if "max_num_scheduled_tokens" in d:
        d["max_num_batched_tokens"] = d.pop("max_num_scheduled_tokens")

    # C2: a field the design-time record omitted entirely.
    d.setdefault("preemption_policy", "fcfs")

    # C4: --horizon is group-side (A4), so a bounded run is its own group.
    horizon = d.get("extra_flags", {}).pop("horizon", None)
    if horizon is not None:
        g["horizon_ticks"] = int(horizon)

    # Keys the shipped schema requires to be present even when null.
    g.setdefault("horizon_ticks", None)
    g["workload"].setdefault("spec_file", None)
    g["workload"].setdefault("spec_sha256", None)

    # Every disqualification carries a class (A1).
    for dq in rec["status"]["disqualifications"]:
        dq.setdefault("class", "altered" if dq["code"] == "output_truncated" else "incomplete")

    # requests[] belongs in a sidecar, never in metrics_raw.
    rec["metrics_raw"].pop("requests", None)
    rec.setdefault("requests_sidecar", None)

    rec["group_id"] = short_hash(g)
    rec["work_id"] = short_hash({k: v for k, v in g.items() if k != "seed"})
    return rec


def main():
    records = [migrate(r) for r in json.loads(TARGET.read_text())]
    TARGET.write_text(json.dumps(records, indent=1) + "\n")
    counts = {}
    for r in records:
        counts[r["group_id"]] = counts.get(r["group_id"], 0) + 1
    for gid, n in sorted(counts.items()):
        print(f"{gid}  {n} records")


if __name__ == "__main__":
    main()
