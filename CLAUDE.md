# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A leaderboard for BLIS (Blackbox Inference Simulator) — ranks simulated LLM
inference deployments (model, hardware, serving configuration, workload, offered
load) so deployment choices can be compared on numbers.

**Status: schema and MVP readout, built.** Go pipeline (`internal/`, `cmd/leaderboard`)
plus a Vite + React + TypeScript app in `web/`. A run declaration (a `runs.yaml` you
author, or the web app's new-run form) names one comparability group and its candidate
deployments; `leaderboard run` executes them against `blis` and
writes `results/<group_id>/<run_id>.json`; the web app renders one sortable table per
group with disqualified runs shown beneath it. Read `README.md` for the dependency and
the BLIS invocation details, and `docs/superpowers/specs/` for the design and its
corrections; this file covers how to work here.

## Build and Test Commands

```bash
make verify-all          # everything that does not need the simulator — the review gate
make test                # Go unit tests, hermetic
make test-one T=TestGroupIDIsStable P=./internal/schema/   # a single Go test
make lint                # gofmt -l + go vet
make build               # bin/leaderboard
make drift               # fail if upstream MetricsOutput gained a required field
make blis                # build the upstream simulator this repo consumes
make integration         # real blis runs; needs make blis and BLIS_CATALOG (a blis-catalog clone)
make web-install         # npm ci
make web-test            # Vitest
make web-lint            # tsc --noEmit
make web-build           # vite build
cd web && npm test -- model            # one Vitest file
cd web && npm run gen:types            # regenerate src/types.ts from schema/run.schema.json
cd web && npm run gen:types:check      # fail if the committed types are stale
```

`go mod download` and `npm ci` need network egress, which the default Bash sandbox blocks;
run those two with the sandbox disabled.

## Working with the BLIS dependency

- `../inference-sim` is a **separate repo and read-only upstream**. Fixes belong
  there, in their own commit, on their own branch — never mixed into a leaderboard
  change. Never assume its working tree is clean or on `main`; check.
- `blis` must be invoked with `../inference-sim` as the working directory. It
  resolves `defaults.yaml` and `hardware_config.json` relative to cwd, and fails or
  silently mis-defaults otherwise. The model catalog is separate: since
  inference-sim#1797 the in-repo `model_configs/` tree is gone, and `blis` locates
  the catalog only via `BLIS_CATALOG` (or `--catalog`) pointing at a
  [`blis-catalog`](https://github.com/inference-sim/blis-catalog) clone — no default,
  no search path. The blis subprocess inherits `BLIS_CATALOG` from `leaderboard`'s env.
- BLIS is deterministic: identical flags and `--seed` give identical output. Treat
  a metrics JSON as reproducible, and treat a diff in output with no flag change as
  a bug worth chasing, not noise.
- Runs cost seconds of CPU, not GPUs — prefer regenerating a result over trusting a
  stale committed one when a claim depends on it.

## Design ground rules

- **Design from scratch.** BLIS ships its own `blis dashboard` leaderboard in
  `../inference-sim/cmd/dashboard/`. This repo is a deliberate redesign; do not
  port, copy, or treat that implementation's ranking, storage, or UI decisions as
  the starting point. Read it only if asked to.
- **A table is one workload; model and hardware are candidates.** A ranking is
  meaningful only across runs offered the same work (same workload, request count,
  and rate or concurrency). Model and hardware are both candidates under test, not
  part of the comparability key. Comparability across models is the reader's job via
  filters; the app makes no automatic ranking claim. Sorting is user-initiated only
  (sort on click, nothing on load).
- **Do not rank on `responses_per_sec`.** It is capped by the offered `--rate`, so
  at a single load it measures "kept up," not capacity.
- **Do not hide excluded runs.** If a run is disqualified, show it with the reason.
  A run that shed or dropped part of its workload has percentiles describing a
  subset, and ranking it beside a complete run rewards the shedding.
- **Prefer BLIS's own numbers.** If a quantity is not in the metrics JSON and has
  to be derived from flags, say so at the point it is displayed.
- **`group_id` is a stable hash of the work offered.** It is a content hash of the
  canonicalised `group` block (`internal/schema.GroupID`), the UI renders one table
  per `group_id`, and `leaderboard validate` refuses a record filed under a directory
  that does not match. A field belongs to `group` or to `deployment`, never both. The
  seed, `--horizon`, and `--timeout` are group-side; model and hardware are
  deployment-side (candidates).
- **Corrections to the design doc live in its §13**, not in code comments alone. Six of the
  original spec's claims did not survive contact with upstream source; the same is likely to
  happen again, and a correction that only exists in a comment will be re-introduced.

## Scope

Simulation semantics, latency models, and scheduling live upstream. This repo owns
collection, comparison, and presentation of results — resist the pull to
reimplement any part of the simulator here.
