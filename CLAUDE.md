# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A leaderboard for BLIS (Blackbox Inference Simulator) — ranks simulated LLM
inference deployments (model, hardware, serving configuration, workload, offered
load) so deployment choices can be compared on numbers.

**This repo is empty and in design phase.** One commit, a README, no code, and no
stack chosen. Read `README.md` for the dependency and the BLIS invocation details;
this file covers how to work here.

## Build and Test Commands

None yet — there is nothing to build. Do not invent or guess them. When a stack is
chosen, add the real build / test / lint commands to this section (including how to
run a single test) as part of the same change that introduces them.

The only command that works today builds the upstream simulator this repo consumes:

```bash
cd ../inference-sim && go build -o blis main.go   # Go >= 1.24
```

## Working with the BLIS dependency

- `../inference-sim` is a **separate repo and read-only upstream**. Fixes belong
  there, in their own commit, on their own branch — never mixed into a leaderboard
  change. Never assume its working tree is clean or on `main`; check.
- `blis` must be invoked with `../inference-sim` as the working directory. It
  resolves `defaults.yaml`, `hardware_config.json`, and the `model_configs/` cache
  relative to cwd, and fails or silently mis-defaults otherwise.
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
- **Only compare like with like.** A ranking is meaningful only across runs offered
  the same work (same model, hardware, workload, request count, and rate or
  concurrency). Any grouping key must make this structural, not advisory.
- **Do not rank on `responses_per_sec`.** It is capped by the offered `--rate`, so
  at a single load it measures "kept up," not capacity.
- **Do not hide excluded runs.** If a run is disqualified, show it with the reason.
  A run that shed or dropped part of its workload has percentiles describing a
  subset, and ranking it beside a complete run rewards the shedding.
- **Prefer BLIS's own numbers.** If a quantity is not in the metrics JSON and has
  to be derived from flags, say so at the point it is displayed.

## Scope

Simulation semantics, latency models, and scheduling live upstream. This repo owns
collection, comparison, and presentation of results — resist the pull to
reimplement any part of the simulator here.
