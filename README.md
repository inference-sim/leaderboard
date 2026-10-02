# leaderboard

A leaderboard for [BLIS](https://github.com/inference-sim/inference-sim), the
Blackbox Inference Simulator: publish and compare simulated LLM inference
deployments — model, hardware, serving configuration, workload, and offered load —
so a deployment choice can be argued from numbers instead of intuition.

**Status: schema and MVP readout.** A run declaration (authored in the web app's
new-run form, or a `runs.yaml` you write) names one comparability group and its
candidate deployments; `leaderboard run` executes them and writes
`results/<group_id>/<run_id>.json`; the web app renders one sortable table per group with
disqualified runs shown beneath it. The design and its evidence are in
`docs/superpowers/specs/` and `prototypes/`.

## Dependencies

This repo does not simulate anything itself. It stands on three first-party
dependencies, each versioned on its own and each declared to a running deployment
through an environment variable (see [Environment variables](#environment-variables)):

| Dependency | What it is | How it is located |
|---|---|---|
| **leaderboard** | this repo — the Go pipeline (`internal/`, `cmd/leaderboard`) and the web app (`web/`) | the binary you build / the image you run |
| **blis** | the upstream [BLIS](https://github.com/inference-sim/inference-sim) simulator (Go), consumed as a sibling checkout | `-blis` flag / the bundled checkout in the image |
| **blis-catalog** | the model catalog, a separate [repo](https://github.com/inference-sim/blis-catalog) (no in-repo models since inference-sim#1797) | `$BLIS_CATALOG` or `--catalog` (no default, no search path) |

The expected sibling layout for local work:

```
go/src/inference-sim/
├── inference-sim/   # upstream BLIS simulator (Go)
├── blis-catalog/    # model catalog (clone it once; see below)
└── leaderboard/     # this repo
```

BLIS is a CPU-only, deterministic discrete-event simulator — same flags and seed
produce the same numbers, so results are reproducible without GPUs.

### Environment variables

The pipeline and server are configured entirely through environment variables (a few
also have an equivalent CLI flag, which wins when set). Declare them in your shell with
`export NAME=value`; in a container with `ENV` / `docker run -e NAME=value`; and in the
OpenShift deployment through the container's `env:` block (see
`deploy/openshift/leaderboard.yaml`).

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `BLIS_CATALOG` | `--catalog` (blis) | *(none — required for any run)* | Path to a `blis-catalog` clone. `blis` has no default and no search path, so a run is refused without it. The server reads it at startup and every `blis` subprocess it spawns inherits it. |
| `LEADERBOARD_RESULTS` | `-out` | `~/leaderboard-results` | Where `results/<group_id>/<run_id>.json` is read and written. Point it at the repo (`results`) for local dev, or a persistent volume in a deployment. |
| `LEADERBOARD_USER_MODELS` | `-user-models` | `<out>/user-models` | The pristine store for models added through the web app, re-overlaid onto the catalog on each boot. |
| `LEADERBOARD_MAX_UPLOAD_MB` | `-max-upload-mb` | ~1 GiB | Cap for a trace upload to `/api/traces`, in MiB. Raise it for large Weka/OTel corpora. |
| `LEADERBOARD_VERSION` | *(env only)* | *(auto-detect, else `unknown`)* | Display-only override: the leaderboard build the web app reports. |
| `BLIS_VERSION` | *(env only)* | *(auto-detect, else `unknown`)* | Display-only override: the `blis` build the app reports. |
| `BLIS_CATALOG_VERSION` | *(env only)* | *(auto-detect, else `unknown`)* | Display-only override: the catalog version the app reports. |

The last three show as small text beside the project links in the web app's left nav rail
(served at `GET /api/version`), stating which build of each dependency the running server is
made of. Each value is free-form — a tag (`v1.2.3`), a commit (`abc1234`), a date, or any
combination — and is shown **verbatim**.

They resolve in order: **the env var wins** (set it to show a tag, or to correct a wrong
auto-detect); otherwise the server **auto-detects** at startup —

- `leaderboard` from the binary's embedded VCS stamp (`go build` from a git checkout records
  it automatically; an image built from a tree with `.git` stripped has none, so set the env
  var there — the OpenShift deployment does),
- `blis` from the bundled checkout's `git HEAD` (the image ships blis's `.git`),
- `catalog` from a `VERSION` file bundled with it (written by `deploy/openshift/build.sh`), or
  its `git HEAD` for a local checkout that still has one;

and failing both it shows `unknown`. Auto-detected or declared, these are **not verified** —
nothing proves the string matches the artifact actually serving — so treat them as a label,
not a guarantee. With no server at all (the static committed board), the links show without
versions.

### Getting a `blis` binary

Requires Go ≥ 1.24 (see `../inference-sim/go.mod`).

```bash
cd ../inference-sim
go build -o blis main.go
```

### Producing a result to rank

Run from the `inference-sim` repo root — `blis` resolves `defaults.yaml` relative to
the working directory. The model catalog is external and must be located explicitly:
`blis` has no default catalog and no search path, so set `BLIS_CATALOG` (or pass
`--catalog`) to a clone of the [`blis-catalog`](https://github.com/inference-sim/blis-catalog)
repo. The leaderboard image bundles it; for a raw run, clone it once.

```bash
git clone https://github.com/inference-sim/blis-catalog.git
export BLIS_CATALOG="$PWD/blis-catalog"
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
  is keyed.
- Valid `--hardware` names come from `../inference-sim/hardware_config.json`.
- BLIS fetches nothing at run time: a model runs only if its `config.json` is
  committed in the catalog at `<BLIS_CATALOG>/models/<name>/config.json`, otherwise
  the run is refused, naming the path the entry belongs at. Add a model by committing
  its `config.json` to `blis-catalog`.

## Building and running the leaderboard

Results are read and written under `$LEADERBOARD_RESULTS` (default
`~/leaderboard-results`; `-out` overrides it). For local dev, point it at the repo so
you can see the `results/` tree change with your edits: `export LEADERBOARD_RESULTS=results`,
or just use the `make` targets, which set it for you. The container image and the
OpenShift deployment set it to a persistent-volume path instead.

```bash
export LEADERBOARD_RESULTS=results   # local dev: write into the repo tree (make sets this too)
make blis                    # build the upstream simulator (Go >= 1.24)
make build                   # bin/leaderboard
./bin/leaderboard run -runs runs.yaml   # execute a run declaration -> $LEADERBOARD_RESULTS/<group_id>/<run_id>.json
./bin/leaderboard validate   # schema, ids, filing, and upstream drift
./bin/leaderboard verify     # re-run and diff; BLIS is deterministic, so a diff is a bug

make web-install             # npm ci
make web-test                # Vitest over prototypes/results.json
cd web && npm run dev        # view the tables
```

To declare and run candidates from the browser instead of the CLI, run the API and the
dev server together — the "Declare a run" screen sends each candidate to the API, which
executes blis from `../inference-sim` and files the result, and the leaderboard picks it
up without a rebuild:

```bash
make blis && make serve      # bin/leaderboard serve — the API blis runs behind (:8080)
make web-dev                 # Vite dev server; it proxies /api to the API above
```

`make verify-all` runs everything that does not need the simulator.

### Container image and releases

Publishing a GitHub Release builds a multi-architecture image (linux/amd64 and
linux/arm64) and pushes it to `ghcr.io/inference-sim/leaderboard` (see
`.github/workflows/release.yml`). The image runs `leaderboard serve` with a bundled
`blis` checkout, so it both displays stored results and executes new candidates via
`/api/run`.

Run a published tag:

```bash
docker run -p 8080:8080 -v "$PWD/results:/app/results" \
  ghcr.io/inference-sim/leaderboard:<tag>
```

The volume matters: the image ships no results, and `/api/run` writes new records
into `/app/results`, which is otherwise lost when the container stops.

To build it locally, check out the upstream repo as `upstream/` first (the workflow
does the same), then build:

```bash
git clone https://github.com/jgchn/inference-sim upstream   # or symlink ../inference-sim
docker build -t leaderboard:dev .
docker run -p 8080:8080 -v "$PWD/results:/app/results" leaderboard:dev
```

### What the table will and will not tell you

- Nothing is sorted on load and there is no composite score. Every column sorts on click.
- `Tokens/s` and `Resp/s` are bounded above by the offered load, so at a single load they
  measure "kept up" rather than capacity. Measuring capacity means a sweep per candidate,
  which is a second table.
- A run that shed or dropped part of its workload is shown below the table with the reason
  and the rank it would have taken. Its percentiles describe a smaller, easier job.
- Values the leaderboard computed rather than read from BLIS carry a dotted underline and
  name their formula on hover — the GPU count, the served fraction, output tokens per served
  request, and the arrival process.

## Trace / replay workloads

Besides the synthetic distribution and spec workloads, a workload can be a **recorded
trace** replayed through `blis replay`. A trace is a first-class, saved workload in the
catalog: author it in the web app's workload editor (the "Trace replay" kind), where you
upload the trace, choose how it is replayed, and save it like any other workload. The
trace bytes are stored once by content hash under `<results>/traces/<sha256>/`; the
workload references that hash, so the same trace replayed the same way is one table.

Three inputs are accepted (all become the TraceV2 pair `blis replay` consumes):

- **TraceV2** — a header YAML + data CSV, uploaded directly.
- **OpenTelemetry** agentic JSON — converted with `blis convert otel`.
- **Weka** agentic JSONL — converted with `blis convert weka`.

To prepare a trace outside the app (for inspection, or to script it):

```bash
cd ../inference-sim
export BLIS_CATALOG="$PWD/../blis-catalog"

# Convert a raw trace to the TraceV2 pair the leaderboard ingests (also what the web
# upload does for you):
./blis convert weka --input sessions.jsonl --trace-output mytrace   # -> mytrace.yaml + mytrace.csv
./blis convert otel --input spans.json    --trace-output mytrace

# Replay it directly (the same metrics the leaderboard collects):
./blis replay --trace-header mytrace.yaml --trace-data mytrace.csv \
  --model qwen/qwen3-14b --hardware H100 --tp 1 \
  --session-mode closed-loop --concurrent-sessions 32 \
  --metrics-path /tmp/metrics.json
```

The offered load for a trace is either its **recorded arrivals** (`fixed` /
`fixed-accumulate` / plain `closed-loop`) or a **pool of N concurrent sessions**
(`--concurrent-sessions N`, the offered-load analog of concurrency). A trace whose source
run spanned more than one node is refused: replay cannot reproduce a multi-node fleet.
Trace workloads are authored and run through `leaderboard serve`; a `runs.yaml` declares
only distribution workloads, exactly as with the spec variant.

## Comparability

Two runs are only comparable when they were offered the same work — the same
workload, request count, and arrival rate or concurrency. Model and hardware are
*candidates*, not part of the key: comparing an H100 against an L40S over identical
work, or Qwen 14B against Llama 70B, is the point. Ranking across different offered
loads compares nothing.

One trap worth knowing before any ranking is designed: `responses_per_sec` is
bounded above by the offered `--rate`, so at a single rate it measures "kept up"
rather than capacity, and stops discriminating between configurations. Measuring
capacity means sweeping load per candidate.

## Documentation

BLIS guides live in `../inference-sim/docs/` (`docs/guide/`, `docs/concepts/`).
