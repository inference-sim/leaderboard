# Prototypes

Design-time evidence for
[`docs/superpowers/specs/2026-09-15-result-schema-and-readout-design.md`](../docs/superpowers/specs/2026-09-15-result-schema-and-readout-design.md).
Not shipped code, and not the runner — the runner is `cmd/leaderboard` once the spec is
approved.

| File | What it is |
|---|---|
| `gen.py` | Throwaway generator. Invokes real `blis` runs and writes records in the proposed schema shape. Proved the shape against actual output rather than a mock. |
| `results.json` | Twelve real runs, migrated to the shipped schema: eleven share `group_id 82775e678d3b`, the `--horizon` run is alone under `baa860a0557d`. The fixture §10 of the spec tests against. |
| `migrate_v1.py` | One-off: migrated `results.json` from the shape `gen.py` wrote to the shipped schema (see below). Kept for its `canon()`/`short_hash()`, which `fix_stdev.py` reuses. |
| `fix_stdev.py` | One-off: corrected `group.workload.prompt_tokens_stdev`/`output_tokens_stdev` from the declared 128/32 to the 256/256 `gen.py` actually ran with, and recomputed `group_id`/`work_id` (see below). Did not touch `metrics`/`metrics_raw`. |
| `2026-09-15-readout.html` | Three table treatments over that data: Readout, Relative, Tail profile. Single self-contained file. |

Open the table with `open 2026-09-15-readout.html` — no build step, no server.

## Provenance

All twelve rows are real `blis run` output at upstream commit `07622594`, 500 requests
each, wall time under 0.3s per run. The upstream tree was dirty when they were generated,
which is recorded in each record's `provenance.blis_tree_dirty` — the same caveat the
shipped UI is specified to surface.

`requests[]` has been stripped from `metrics_raw` in the committed copy: it was 97.3% of
the bytes (1.36 MB against 36 KB of aggregates), which is what drove the sidecar decision
in §4.1 of the spec.

## Regenerating

```bash
cd ../inference-sim && go build -o blis main.go   # Go >= 1.24
cd ../leaderboard && python3 prototypes/gen.py
```

BLIS is deterministic, so identical flags and `--seed` reproduce these numbers exactly. A
diff with no flag change is a bug worth chasing, not noise.

Note `gen.py` predates two schema decisions and writes neither `work_id` nor the `class`
field on disqualifications; `results.json` has both, applied after the fact. The real
runner implements the schema properly — `gen.py` is kept only because it documents how the
matrix was produced.

`results.json` was migrated once, by `migrate_v1.py`, from the shape `gen.py` wrote to the
shipped schema: `workload.arrival_process "constant"` replaces `distribution "poisson"`
(BLIS's rate-mode synthesizer sets a constant arrival process, not a Poisson one),
`max_num_scheduled_tokens` becomes `max_num_batched_tokens`, `preemption_policy` and
`request_timeout_s` are filled with their BLIS defaults, and the `h100-tp4-horizon` run's
`--horizon` moves from `extra_flags` into `group.horizon_ticks` — which correctly makes it
a group of its own, since a bounded observation window is different work offered.

The `group_id` values therefore changed. The design-time id `55faf3a90f47` was minted by
`gen.py` under Python's `json.dumps`, which renders `6.0` as `6.0`; the shipped hasher is
Go's, which renders it `6`. After that migration the ids were `6d3c3a445e84` (eleven rows)
and `39d906e637e8` (the horizon run).

`results.json` was corrected a second time, by `fix_stdev.py`: `gen.py` never passed
`--prompt-tokens-stdev` or `--output-tokens-stdev` to `blis`, so `blis` used its own
defaults — 256 for both — while `group.workload` declared 128/32. The declaration never
matched the flags that produced the metrics. The metrics were correct as they stood; only
the declaration was wrong, so `fix_stdev.py` set both stdevs to 256 and recomputed
`group_id`/`work_id` without touching `metrics` or `metrics_raw`. The current ids are
`82775e678d3b` (eleven rows) and `baa860a0557d` (the horizon run).

## What this data settled

- A run that dropped 259 of 500 requests posted the **best** tail latency in the file
  (E2E p99 2,960ms vs 3,109ms). Disqualification is load-bearing, not defensive.
- `max_num_seqs 8` looks healthy on throughput (1,069 vs 1,079 tokens/s, 0.9% apart) while
  its TTFT p99 is 110× worse (3,471ms vs 31.4ms).
- `block_size_in_tokens` at 16/64/128 produced byte-identical metrics, so it is not a
  column. `max_num_seqs` 32 vs 256 is identical too, and is shown as a finding.
- `A100-80` is a documented alias of `A100-SXM` and was producing a duplicate row.
