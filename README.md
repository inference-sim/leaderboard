# leaderboard

A leaderboard for [BLIS](https://github.com/inference-sim/inference-sim), the
Blackbox Inference Simulator: publish and compare simulated LLM inference
deployments — model, hardware, serving configuration, workload, and offered load —
so a deployment choice can be argued from numbers instead of intuition.

**Status: empty repo, design phase.** Nothing is built yet and no stack has been
chosen. This README records what the project depends on and how to produce the
inputs it will rank; build, test, and run instructions belong here as soon as there
is something to build.

## Dependency: BLIS

This repo does not simulate anything itself. It consumes the JSON output of the
`blis` binary from a sibling checkout:

```
go/src/inference-sim/
├── inference-sim/   # upstream BLIS simulator (Go)
└── leaderboard/     # this repo
```

BLIS is a CPU-only, deterministic discrete-event simulator — same flags and seed
produce the same numbers, so results are reproducible without GPUs.

### Getting a `blis` binary

Requires Go ≥ 1.24 (see `../inference-sim/go.mod`).

```bash
cd ../inference-sim
go build -o blis main.go
```

### Producing a result to rank

Run from the `inference-sim` repo root — `blis` resolves `defaults.yaml` and the
`model_configs/` cache relative to the working directory.

```bash
cd ../inference-sim
./blis run --model qwen/qwen3-14b --hardware H100 --tp 1 \
  --num-requests 2000 --metrics-path result.json
```

Aggregate metrics print to stdout as JSON; `--metrics-path` writes the same to a
file. The fields a leaderboard cares about:

| Field | Meaning |
|---|---|
| `ttft_mean_ms`, `ttft_p99_ms` | time to first token |
| `itl_mean_ms`, `itl_p99_ms` | inter-token latency |
| `e2e_mean_ms`, `e2e_p99_ms` | end-to-end request latency |
| `tokens_per_sec` | output token throughput |
| `responses_per_sec` | completed requests per second |
| `completed_requests` | requests finished inside the simulation window |
| `preemption_count` | evictions to make room in the batch (0 = healthy) |

Practical notes:

- `--hardware` and `--tp` are effectively required. The default latency backend
  (`trained-physics`) refuses to run without them unless the model has a
  `defaults.yaml` entry, and omitting them silently defaults to H100 / TP=1.
- `--model` must be org-prefixed (`qwen/qwen3-14b`), which is how `defaults.yaml`
  is keyed — the bare directory names under `model_configs/` do not resolve.
- Valid `--hardware` names come from `../inference-sim/hardware_config.json`.
- On first run BLIS fetches the model's `config.json` from HuggingFace and caches
  it in `model_configs/`. Set `HF_TOKEN` for gated models and to avoid rate limits.

## Comparability

Two runs are only comparable when they were offered the same work — the same
model, hardware, workload, request count, and arrival rate or concurrency. Ranking
across different offered loads compares nothing.

One trap worth knowing before any ranking is designed: `responses_per_sec` is
bounded above by the offered `--rate`, so at a single rate it measures "kept up"
rather than capacity, and stops discriminating between configurations. Measuring
capacity means sweeping load per candidate.

## Documentation

BLIS guides live in `../inference-sim/docs/` (`docs/guide/`, `docs/concepts/`).
