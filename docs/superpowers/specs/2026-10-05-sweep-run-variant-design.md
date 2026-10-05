# Sweep variant of Declare a run design

Date: 2026-10-05

## Summary

Declare a run gains a second mode, **Sweep**, on the same page. In sweep mode every
field except the model becomes multi-valued: segmented controls light more than one
option, dropdowns become multi-select, number fields take a list of values, and the
workload load becomes a list of levels. The form expands the multi-selected fields into
their cartesian product and fires one run per cell, in parallel, against the existing
`/api/run`. The reader watches them land in a progress panel on the Declare page and
then on the board.

A sweep fixes one workload and varies the load levels and the candidate configuration.
Because the board already groups load levels of one workload into a single section with
a Load axis (see `2026-09-29-load-sweep-comparison-design.md`), **one sweep populates
exactly one table** under this scope: the candidate configurations are its rows and the
load levels are its Load axis. The sweep form is, in effect, the authoring front end for
the sweep the board already knows how to display.

The feature is front-end only: no schema change, no Go change, no new BLIS invocation.
It reuses `interpret()` to validate and build every cell, and the single-run `/api/run`
path to execute each one.

## Motivation

The single-run form answers "how does this one candidate do at this one load." The
questions a leaderboard exists for are plural: "across these three accelerators and two
tensor-parallel degrees, as concurrency climbs 16 → 32 → 64, which configuration holds
its latency longest?" Today that is a dozen trips through the form, each declaration
typed again with one knob changed, each run watched to completion before the next is
started. A sweep declares the whole matrix once and runs it unattended.

The board is already built for the result: load levels of one workload collapse into one
section with a Load column, and candidate configurations are its rows. What is missing is
a way to *author* that matrix without a dozen manual runs. This feature fills that gap.

## Decisions (from brainstorming)

1. **Swept dimensions: everything but the model.** All candidate serving flags, plus
   hardware and tensor/data parallel (deployment-side, become rows), plus the workload
   load levels (group-side, become the Load axis). The model stays single-valued; so do
   seed, horizon, timeout, and the workload selection itself.
2. **Execution: the browser fans out to `/api/run`.** It expands the matrix and fires the
   cells with a small client-side concurrency limit. No new endpoint; the server already
   runs concurrent `/api/run` subprocesses.
3. **Guardrail: live count, soft warn at 32, hard block above 100.** Invalid combinations
   are dropped before firing and listed with their reasons.
4. **Progress stays on the Declare page.** The output aside becomes a live sweep panel;
   the board refreshes underneath as cells land.
5. **Mode switch is a superset collapse.** Sweep with one value per axis equals one run;
   switching back to Single collapses each axis to its first value, confirming first if
   any axis holds more than one.

## The invariant: one sweep is one table

This holds because of where the swept fields sit relative to the board's grouping key,
and it is worth stating precisely because the storage layer and the board layer disagree
about the word "table."

- **Storage:** `schema.GroupID` hashes the whole `group` block, and `Load.Value` is in it
  (`internal/schema/canon.go`). So each load level is a distinct `group_id` and a distinct
  `results/<group_id>/<run_id>.json`. Three load levels of one config are three files.
- **Board:** `loadWorkloads` buckets by `workloadKey`, which deletes the load value before
  canonicalising (`web/src/load.ts`), while keeping seed, horizon, timeout, and the
  workload shape. So all load levels of one workload collapse into one `WorkloadGroup` =
  one page section = one table, with load rendered as a Load column and axis.

Under this feature's scope the only group-side field that varies is the load level, and
`workloadKey` factors that out. Therefore every cell of a sweep shares one `workloadKey`,
and the sweep lands in exactly one table. If a future variant swept a group-side field
that `workloadKey` keeps — seed, horizon, timeout, or the workload — it would produce
several sections; that is out of scope here, and the one-table invariant depends on it
staying so.

The per-cell `group_id` difference across load levels is an internal storage fact. The
preview and progress UI present a sweep as one table, the way the board will, not as a
set of tables.

## Data model: a base plus axes

The sweep is layered on the existing form state rather than duplicating it.

- **`FormValues` is unchanged** and remains the base: it holds every field's single value,
  which covers the non-swept fields outright (model, seed, horizon, timeout, custom
  workload shape, run-id prefix) and supplies the first value of every swept field.
- **`SweepAxes = Partial<Record<SweepableKey, string[]>>`** holds the *additional* values
  per swept field. A field absent from the map, or present with one value, is fixed. The
  value strings match `FormValues`' own string representation, so an axis pick overlays
  onto the base with no conversion.
- **The load levels** are a dedicated axis (`loadValues: string[]`) in the current load
  kind's unit, because load is set apart from the serving flags in the single form too.

**Expansion reuses `interpret()`.** `expandSweep(base, axes)` in `web/src/newrun.ts`:

1. Takes the cartesian product of the axes (each swept field contributes its value list;
   a fixed field contributes its single base value).
2. For each combination, overlays the picks onto `base` to produce a `FormValues`, sets a
   generated run id (below), and runs the existing `interpret(values, groups, profiles,
   models, hardware)`.
3. Partitions the results: a cell that yields an `Output` is a **run**; a cell that yields
   issues is **dropped**, carrying `interpret`'s own issue messages.

Reusing `interpret` means the group/deployment split, the group_id targeting, the
join/new-table verdict, the argv, and the per-field validation are all exercised per cell
with no reimplementation. The sweep adds only the product, the naming, and the
orchestration.

The expansion result is grouped for display by **configuration** (canonical JSON of the
deployment, the same key `byConfig` uses in `load.ts`), so a config's load levels sit
together, matching the board.

## UI

### Mode toggle

A segmented `Single run | Sweep` control under the "Declare a run" heading. The mode and
the `SweepAxes` live in `App` beside `formValues`, so they survive the navigation to the
board the same way the single form does.

- **Single → Sweep** seeds nothing new; each control simply starts showing its single base
  value as the first (and only) selected value, ready for more to be added.
- **Sweep → Single** collapses each axis to its first value. If any axis holds more than
  one value, a `ConfirmDialog` warns first ("Switching to a single run keeps only the
  first value of each varied field") so the matrix is not silently lost.

### Per-field sweep controls

Each single-mode control has a sweep variant seeded with the base value as its first
selection. No field is ever a comma-separated text box.

- **Segmented controls** (hardware, tensor parallel, expert parallel, routing policy,
  every on/off, the PD decider, the KV toggles, the load kind) become **multi-toggle**:
  the same pills, with checkbox rather than radio semantics, so more than one lights. A
  boolean swept across both states is both pills lit. This reuses the routing-scorer tag
  pattern already in `NewRun` (`aria-pressed`, click to toggle).
- **Dropdowns** (scheduler, preemption, admission, KV cache dtype, MoE comm backend,
  latency model, speculative method) become **multi-select**: a pick adds a removable chip
  below the control; the chip row is the axis.
- **Number fields** (data parallel, instances, max model length, block size, max
  sequences, max batched tokens, long-prefill threshold, GPU memory utilization, total KV
  blocks, every PD and KV-offload and speculative number) become a **chip input**: type a
  value, Enter adds it as a chip with a remove affordance. Pasting several values splits
  them into chips.
- **The load level** becomes an **add-a-level** chip list in the current kind's unit (req/s
  for rate, sessions/users for concurrency). This is the one group-side axis and the Load
  axis of the resulting table.

A field with more than one value shows a small "varies (n)" badge. Any collapsed
`<details>` flag group that contains a varied axis shows the count on its summary, so a
swept dimension is never hidden inside a folded group.

The model control stays a single `Select`, by decision. The run-id field becomes a prefix
field (below). Seed, horizon, timeout, and the custom-workload shape stay single-valued.

### Matrix preview

The output aside, in sweep mode and before running, becomes the matrix preview:

- **Live count**, phrased as the one-table reality: "24 runs in one table — 8 configs ×
  3 load levels." When cells were dropped, a line says so ("2 combinations dropped") and
  expands to the per-cell reasons from `interpret`.
- **Axis summary**: the varied axes and their values, one line each ("Hardware: H100,
  A100", "Tensor parallel: 4, 8", "Concurrency: 16, 32, 64").
- **Breakdown**: one entry per candidate configuration (not per table), each listing its
  generated run id and its load levels adjacent, in `byConfig` order — a direct preview of
  the rows and the Load axis the board will show. The join-or-new-table verdict from
  `interpret`'s `Target` is summarised once for the whole sweep, since it is one table.
- **Guardrail**: 32 or fewer is quiet; 33 to 100 shows an amber note; above 100 blocks the
  Run button with a red note. The count is always visible.

### Run-id scheme

A **prefix** field, defaulting to the fixed hardware name when hardware is not swept, else
`sweep`. Each cell's id is the prefix plus a suffix built from the **varied deployment
axes only**, in a fixed field order, as compact tokens (`h100-tp8-sched-fcfs`).

Load levels are *not* in the id: they split `group_id` directories, so the same
configuration at different loads can share a run id, and the board stitches a config's
load levels together by deployment, keying each row on `group_id + run_id` (`rowId`). The
suffix therefore only needs to disambiguate configurations within a single load level's
`group_id`, which the varied deployment axes do by construction. A residual collision with
an existing stored row is resolved with a numeric suffix, reusing `suggestRunId`'s dedup.

## Execution: client fan-out

`App` gains a `sweepRun` state machine beside `liveRun`: the list of cells, each with a
status (`queued | running | done | disqualified | failed`), and overall counts. The pure
pieces live in a new `web/src/sweep.ts` so they are testable in isolation, the way
`liverun.ts` holds the single-run helpers:

- the axis model and `expandSweep` wiring,
- the run-id suffix builder,
- the `byConfig` grouping for display,
- a **bounded pool runner** (concurrency 4) that takes the cell list and a per-cell run
  function (the `fetch` injected, so tests drive it with a stub).

On "Run sweep":

1. **Save the workload once.** A sweep fixes one workload, so if it is a custom
   distribution it is saved to the catalog a single time up front (via the existing
   `saveThenRun` save step), before any cell fires, so parallel cells do not race to
   create duplicate profiles. The load level is per-run and never changes the saved
   profile.
2. **Fan out** the valid cells through the pool to `/api/run`, four at a time.
3. Each completion updates that cell's status and triggers a debounced board reload, so
   rows appear as they land.

Per-cell outcomes:

- **done** — blis completed and the record was written.
- **disqualified** — blis completed but the run shed or dropped work; the record is still
  written and appears in the board's disqualified band. Not a failure.
- **failed** — blis rejected the declaration (HTTP 422); blis's own message is shown on
  the cell. A failure never aborts the sweep.

**Tab-close semantics.** The orchestration lives in the browser. If the tab closes
mid-sweep, blis subprocesses already started finish server-side and write their files,
which the board picks up on its next load; only cells not yet fired are lost. The panel
says so ("Keep this tab open to finish the sweep"). A server-side job store that survives
a close is a deliberate non-goal for this cut (see Out of scope).

## Progress panel

The sweep panel replaces the aside once a sweep is running, and the form stays mounted so
the reader can adjust and run again:

- A `done / total` progress bar with ok / disqualified / failed counts.
- The cells grouped by configuration (`byConfig`), load levels adjacent — the same shape
  as the preview and the board — each with a status chip and, once landed, a "view on
  board" link. The link opens the board and pulses the row, reusing `rowId` and the
  existing reveal mechanism.
- A **Stop** button that halts firing new cells; in-flight cells finish.
- On completion, a summary line and a "View table" link to the workload section.

## Scope of changes

Front-end only. The server already runs parallel `/api/run` subprocesses, so there is no
Go change, no schema change, and no new BLIS invocation.

- **`web/src/sweep.ts`** (new) — axis model, `expandSweep` wiring, run-id suffixes,
  `byConfig` grouping, and the bounded pool runner with the fetch injected. Unit-tested.
- **`web/src/newrun.ts`** — `expandSweep(base, axes)` and the run-id suffix builder,
  reusing `interpret`.
- **`web/src/App.tsx`** — the `sweepRun` state machine and the orchestration call into
  `sweep.ts`; thin, with the logic in the module.
- **`web/src/components/NewRun.tsx`** — the mode toggle only. The sweep UI is new sibling
  components rather than more lines in this already ~1300-line file:
  **`SweepControls`** (the multi-value field variants), **`SweepPreview`** (the matrix
  preview), and **`SweepProgress`** (the progress panel).
- **`web/src/styles.css`** — chips, multi-toggle, the preview, and the progress panel.

## Testing

Hermetic Vitest, records and form values synthesised inline as the existing tests do; no
blis.

- **Expansion** (`sweep.ts` / `newrun.ts`) — the cartesian product counts correctly; a
  fixed field contributes one value; valid cells become `Output`s and invalid cells are
  dropped with `interpret`'s messages; the one-table invariant holds (every cell shares a
  `workloadKey`); `byConfig` grouping puts a config's load levels together.
- **Run ids** — the suffix encodes only varied deployment axes; the same config at two
  loads shares an id; a collision with an existing row is deduped.
- **Guardrail** — the count is right; the warn and block thresholds flip at 32 and 100.
- **Pool runner** — concurrency is bounded to four; a failed cell does not stop the rest;
  done / disqualified / failed are classified from the injected responses; Stop halts new
  cells.
- **Mode switch** — Sweep with one value per axis expands to exactly one run; collapsing
  to Single keeps each axis's first value and confirms when any axis has more than one.
- **Controls** (component tests) — a multi-toggle lights several options; a dropdown adds
  and removes chips; a number chip input adds on Enter; the load-level list adds levels;
  the "varies (n)" badge and the folded-group count appear.

## Out of scope

- **Server-side sweep orchestration** — a `/api/sweep` endpoint, a job queue, a worker
  pool, or progress streaming. The browser fan-out covers async and parallel execution for
  this cut; a server job store that survives a tab close is a later upgrade.
- **Sweeping the model** — single-valued by decision; the dependent MoE and context-length
  behaviour it drives would need its own treatment.
- **Sweeping group-side fields that `workloadKey` keeps** — seed, horizon, timeout, or the
  workload selection. Allowing these would break the one-table invariant and produce
  several sections; a separate design if ever wanted.
- **Line charts or scaling curves** — the result is read on the existing board (table plus
  Load axis and Compare mode); no new visualisation.
- **Persisting a sweep declaration** to a URL, a file, or across reloads.

## §13 Corrections

Corrections to this design discovered against the source, in the spirit of the repo's
convention that a correction must outlive a code comment.

- **A sweep does not span multiple tables.** The first draft of this design claimed that
  varying load levels fans runs "across several tables," reasoning from `GroupID` hashing
  the load value. That is true of storage (`group_id`) but false of the board: `loadWorkloads`
  buckets by `workloadKey`, which deletes the load value, so load levels of one workload
  render as one section with a Load axis. Under this feature's scope — only load varies on
  the group side — every sweep is exactly one table. The preview and progress UI present
  it that way. The multiple-`group_id` fact is retained only as an internal storage detail.
- **Load kind is single-valued, not swept.** The "Per-field sweep controls" section lists "the
  load kind" among the segmented controls that become multi-toggle. Sweeping it would be wrong:
  `load.ts workloadKey` keeps the load *kind* in the key (a rate profile and a concurrency
  profile are different workloads and never merge), so a kind sweep would split one sweep across
  two board tables and break the one-table invariant this design rests on. Only the load *level*
  (`loadValues`) is a group-side axis; the load kind stays fixed, like the workload selection.
- **`expandSweep` lives in `sweep.ts`, not `newrun.ts`.** The Scope section lists `expandSweep`
  and the run-id builder under both `newrun.ts` and `sweep.ts`. They live only in `sweep.ts`
  (which imports `interpret` from `newrun.ts`): `newrun.ts` is already ~1500 lines, and keeping
  the dependency one-way (sweep -> newrun) avoids a circular import. This mirrors `liverun.ts`
  holding the single-run helpers outside `newrun.ts`.
- **`SweepAxes` stores the full value list, base value first - not "additional" values.** The
  "Data model" section calls the map the "additional values per swept field." The implementation
  stores the complete ordered list (base value first); a key absent or length-1 is fixed. This
  makes `axisValues`/`toggleAxisValue` total and keeps the base value from being silently
  droppable.
- **The join-vs-new verdict is computed board-side, once.** `findTarget`/`workloadContentKey`
  keep the load level, so a cell's per-load-level `Output.target` legitimately differs across
  levels (each load level is its own stored `group_id`). The preview's single verdict and the
  run-id dedup are computed from `workloadKey` (load stripped), which is the board's one-table
  notion, so a sweep reads as one table even though it writes several `group_id` directories.
