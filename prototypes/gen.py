#!/usr/bin/env python3
"""Throwaway data generator: proves the schema shape against real blis runs."""
import json, subprocess, hashlib, os, time, sys, itertools

BLIS_DIR = os.path.abspath("../inference-sim")
OUT = os.path.abspath(".proto/results")
os.makedirs(OUT, exist_ok=True)
TMP = os.environ.get("TMPDIR", "/tmp")

GROUP = {
    "model": "qwen/qwen3-14b",
    "seed": 42,
    "workload": {
        "type": "distribution", "distribution": "poisson",
        "num_requests": 500,
        "load": {"kind": "rate", "value": 6.0},
        "prompt_tokens": 512, "prompt_tokens_stdev": 128,
        "output_tokens": 128, "output_tokens_stdev": 32,
        "spec_file": None, "spec_sha256": None,
    },
}

# candidate deployments: hardware x tp x block_size
CANDIDATES = []
for hw, tp in [("H100",1),("H100",2),("H100",4),("A100-SXM",1),("A100-SXM",2),
               ("A100-80",2),("A100-80",4),("L40S",2),("L40S",4)]:
    for blk in (16, 64):
        CANDIDATES.append({
            "hardware": hw, "tp": tp, "dp": 1, "num_instances": 1,
            "max_model_len": 40960, "block_size_in_tokens": blk,
            "max_num_seqs": 256, "max_num_batched_tokens": 8192,
            "scheduler": "fcfs", "routing_policy": "round-robin",
            "admission_policy": "always-admit", "kv_cache_dtype": "auto",
            "latency_model": "trained-physics", "extra_flags": {},
        })

def canon(o): return json.dumps(o, sort_keys=True, separators=(",", ":"))
def gid(g): return hashlib.sha256(canon(g).encode()).hexdigest()[:12]

REQUIRED_CORE = ["instance_id","completed_requests","still_queued","still_running",
 "injected_requests","total_input_tokens","total_output_tokens",
 "vllm_estimated_duration_s","responses_per_sec","tokens_per_sec",
 "e2e_mean_ms","e2e_p90_ms","e2e_p95_ms","e2e_p99_ms",
 "ttft_mean_ms","ttft_p90_ms","ttft_p95_ms","ttft_p99_ms",
 "itl_mean_ms","itl_p90_ms","itl_p95_ms","itl_p99_ms",
 "scheduling_delay_p99_ms","preemption_count","dropped_unservable",
 "length_capped_requests","timed_out_requests"]

def status_of(m, g):
    dq, warn = [], []
    if m.get("dropped_unservable",0) > 0:
        dq.append({"code":"requests_dropped","detail":f"{m['dropped_unservable']} of {g['workload']['num_requests']} requests dropped as unservable"})
    if m.get("timed_out_requests",0) > 0:
        dq.append({"code":"requests_timed_out","detail":f"{m['timed_out_requests']} requests timed out"})
    if m.get("length_capped_requests",0) > 0:
        dq.append({"code":"output_truncated","detail":f"{m['length_capped_requests']} requests hit max_model_len"})
    if m.get("still_queued",0) or m.get("still_running",0):
        dq.append({"code":"window_ended_busy","detail":f"{m.get('still_queued',0)} queued + {m.get('still_running',0)} running when the window closed"})
    inj, want = m.get("injected_requests",0), g["workload"]["num_requests"]
    if inj != want:
        dq.append({"code":"injection_short","detail":f"injected {inj}, declared {want}"})
    if m.get("preemption_count",0) > 0:
        warn.append({"code":"preemptions","detail":f"{m['preemption_count']} preemptions"})
    return {"complete": not dq, "disqualifications": dq, "warnings": warn}

commit = subprocess.run(["git","-C",BLIS_DIR,"rev-parse","--short","HEAD"],
                        capture_output=True,text=True).stdout.strip()
dirty = bool(subprocess.run(["git","-C",BLIS_DIR,"status","--porcelain"],
                        capture_output=True,text=True).stdout.strip())
bsha = hashlib.sha256(open(os.path.join(BLIS_DIR,"blis"),"rb").read()).hexdigest()

g_id = gid(GROUP)
records, failures = [], []
for i, dep in enumerate(CANDIDATES):
    rid = f"{dep['hardware'].lower()}-tp{dep['tp']}-blk{dep['block_size_in_tokens']}"
    mp = os.path.join(TMP, f"blis-{g_id}-{rid}.json")
    argv = ["./blis","run","--model",GROUP["model"],
            "--hardware",dep["hardware"],"--tp",str(dep["tp"]),
            "--num-requests",str(GROUP["workload"]["num_requests"]),
            "--rate",str(GROUP["workload"]["load"]["value"]),
            "--seed",str(GROUP["seed"]),
            "--block-size-in-tokens",str(dep["block_size_in_tokens"]),
            "--max-model-len",str(dep["max_model_len"]),
            "--max-num-seqs",str(dep["max_num_seqs"]),
            "--prompt-tokens",str(GROUP["workload"]["prompt_tokens"]),
            "--output-tokens",str(GROUP["workload"]["output_tokens"]),
            "--metrics-path",mp]
    t0 = time.time()
    p = subprocess.run(argv, cwd=BLIS_DIR, capture_output=True, text=True)
    wall = round(time.time()-t0, 3)
    if p.returncode != 0 or not os.path.exists(mp):
        failures.append((rid, p.returncode, (p.stderr or p.stdout).strip()[-400:]))
        print(f"FAIL {rid}: rc={p.returncode}", file=sys.stderr); continue
    raw = json.load(open(mp))
    missing = [k for k in REQUIRED_CORE if k not in raw]
    if missing:
        print(f"SCHEMA GAP {rid}: missing {missing}", file=sys.stderr)
    rec = {
        "schema_version": 1, "run_id": rid, "group_id": g_id,
        "group": GROUP, "deployment": dep,
        "provenance": {"blis_commit": commit, "blis_tree_dirty": dirty,
            "binary_sha256": bsha[:16], "argv": argv, "cwd": "../inference-sim",
            "ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "wall_s": wall},
        "status": status_of(raw, GROUP),
        "metrics": {k: raw.get(k) for k in REQUIRED_CORE},
        "metrics_raw": raw,
    }
    records.append(rec)
    print(f"ok {rid:24s} e2e_p99={raw['e2e_p99_ms']:9.1f} rps={raw['responses_per_sec']:6.2f} "
          f"complete={rec['status']['complete']}")

json.dump(records, open(os.path.join(OUT,"all.json"),"w"), indent=1)
print(f"\n{len(records)} records -> .proto/results/all.json ; {len(failures)} failures")
for rid, rc, err in failures: print(f"  {rid}: rc={rc} {err[:200]}")
