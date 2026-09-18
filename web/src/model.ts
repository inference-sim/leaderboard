import type { RunGroup, RunRecord } from './load'

export type ColumnGroup = 'candidate' | 'latency' | 'throughput' | 'health'

/** One column of the readout. */
export interface Column {
  key: string
  label: string
  group: ColumnGroup
  /** Pulls the sortable number out of a record. null for the deployment column. */
  value: (r: RunRecord) => number | null
  /**
   * True where a larger number is better. Latency columns are the opposite. Used to
   * orient the disqualified band's would-be rank; the app marks no automatic best (E5).
   */
  higherIsBetter?: boolean
  /**
   * A conceptual note for the header's info icon — what the column means, not how a
   * cell's number was derived (that is `derivedFrom`, rendered per-value). Use it where
   * the label alone invites a wrong reading a reader would carry into every row.
   */
  help?: string
  /** Fixed decimal places. Undefined means format as a duration. */
  digits?: number
  /**
   * Set when the leaderboard computed this rather than reading it from BLIS.
   * `formula` names the calculation in general terms; `note` explains why BLIS
   * doesn't report it directly. This is the single source for that wording —
   * the component that renders the value (ValueCell in ReadoutTable.tsx) reads
   * both and substitutes the row's actual numbers rather than hand-writing its
   * own copy of the formula, so the two cannot drift apart.
   */
  derivedFrom?: { formula: string; note: string }
}

/**
 * The Served header note. Served is a per-run outcome; the workload card's Requests is
 * the declared job every run in the group was offered. Keeping the distinction here, at
 * the header, stops a reader reading a below-100% run as merely "smaller".
 */
export const SERVED_NOTE =
  'completed ÷ injected requests — the share of the offered work this run actually ' +
  "finished. The workload card's Requests is the declared job size every run was offered; " +
  'Served is the per-run outcome. Below 100% the run shed or dropped work, so its ' +
  'percentiles describe a smaller, systematically easier subset.'

export const COLUMNS: Column[] = [
  { key: 'deployment', label: 'Deployment', group: 'candidate', value: () => null },
  {
    key: 'gpus',
    label: 'GPUs',
    group: 'candidate',
    value: (r) => gpuCount(r),
    derivedFrom: {
      formula: 'tp × num_instances',
      note: 'computed from flags — blis does not report a GPU count',
    },
  },
  { key: 'ttft_p99_ms', label: 'TTFT p99', group: 'latency', value: (r) => r.metrics.ttft_p99_ms },
  { key: 'itl_p99_ms', label: 'ITL p99', group: 'latency', value: (r) => r.metrics.itl_p99_ms },
  { key: 'e2e_p99_ms', label: 'E2E p99', group: 'latency', value: (r) => r.metrics.e2e_p99_ms },
  { key: 'e2e_mean_ms', label: 'E2E mean', group: 'latency', value: (r) => r.metrics.e2e_mean_ms },
  {
    key: 'scheduling_delay_p99_ms',
    label: 'Sched delay p99',
    group: 'latency',
    value: (r) => r.metrics.scheduling_delay_p99_ms,
  },
  {
    key: 'tokens_per_sec',
    label: 'Tokens/s',
    group: 'throughput',
    value: (r) => r.metrics.tokens_per_sec,
    higherIsBetter: true,
    digits: 1,
  },
  {
    key: 'responses_per_sec',
    label: 'Resp/s',
    group: 'throughput',
    value: (r) => r.metrics.responses_per_sec,
    higherIsBetter: true,
    // CLAUDE.md's rule is unconditional: responses_per_sec is capped by the offered
    // rate, so at a single load it measures "kept up", not capacity. It sorts on click
    // like any column, but the app asserts no ranking on it (E5 removed automatic
    // best-markers everywhere).
    digits: 2,
  },
  {
    key: 'served',
    label: 'Served',
    group: 'health',
    value: (r) => servedFraction(r).percent,
    help: SERVED_NOTE,
    derivedFrom: {
      formula: 'completed_requests ÷ injected_requests',
      note: 'blis reports the two counts separately',
    },
  },
  {
    key: 'preemption_count',
    label: 'Preempt',
    group: 'health',
    value: (r) => r.metrics.preemption_count,
    digits: 0,
  },
]

/** The numeric columns, i.e. everything the deployment cell does not render itself. */
export const NUMERIC_COLUMNS = COLUMNS.filter((c) => c.key !== 'deployment')

/** Metric fields compared when looking for twins. instance_id is a label, not a metric. */
const TWIN_IGNORED = new Set(['instance_id'])

/**
 * Runs whose metrics are identical, keyed by run_id. A knob that changed nothing is
 * a result worth showing, not a coincidence to hide: max_num_seqs 32 and the stock
 * 256 are byte-identical here because at this load the batch never reaches 32.
 */
export function findTwins(records: RunRecord[]): Record<string, string[]> {
  const key = (r: RunRecord): string => {
    const entries = Object.entries(r.metrics)
      .filter(([k]) => !TWIN_IGNORED.has(k))
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return JSON.stringify(entries)
  }

  const buckets = new Map<string, string[]>()
  for (const r of records) {
    const k = key(r)
    const bucket = buckets.get(k)
    if (bucket) bucket.push(r.run_id)
    else buckets.set(k, [r.run_id])
  }

  const out: Record<string, string[]> = {}
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue
    for (const id of ids) out[id] = ids.filter((other) => other !== id)
  }
  return out
}

/**
 * Deployment fields rendered in their own slot rather than as a chip. Model joined
 * hardware and tp here (E1): it leads the deployment cell as the candidate's headline
 * (shown when the table holds more than one model), so it never chips.
 */
const PROMINENT_FIELDS = new Set(['model', 'hardware', 'tp'])

/**
 * The deployment fields that are not identical across the group. Rendering every
 * one of them on every row is what makes A3 structural: two rows cannot differ in a
 * field the reader never sees.
 */
export function varyingDeploymentFields(records: RunRecord[]): string[] {
  if (records.length === 0) return []
  const first = records[0]!.deployment as unknown as Record<string, unknown>
  const out: string[] = []
  for (const field of Object.keys(first)) {
    if (field === 'extra_flags') continue // always rendered, see knobChips
    const baseline = JSON.stringify(first[field])
    const varies = records.some(
      (r) => JSON.stringify((r.deployment as unknown as Record<string, unknown>)[field]) !== baseline,
    )
    if (varies) out.push(field)
  }
  return out
}

export interface KnobChip {
  label: string
  /** True for an extra_flags entry: a flag with no first-class field. */
  extra: boolean
}

/**
 * The knob chips for one row: every varying deployment field except the two with
 * their own slot, plus every extra_flags entry unconditionally.
 */
export function knobChips(record: RunRecord, varyingFields: string[]): KnobChip[] {
  const deployment = record.deployment as unknown as Record<string, unknown>
  const chips: KnobChip[] = []
  for (const field of varyingFields) {
    if (PROMINENT_FIELDS.has(field)) continue
    chips.push({ label: `${field} ${String(deployment[field])}`, extra: false })
  }
  for (const [flag, value] of Object.entries(record.deployment.extra_flags ?? {})) {
    chips.push({ label: `--${flag} ${String(value)}`, extra: true })
  }
  return chips
}

/**
 * The parallelism/instance fields shown on their own line in every deployment cell,
 * in this order, whether or not they vary. They are the topology of the deployment —
 * how many GPUs it spreads across and how many instances it runs — so a reader reads
 * them first and reads them the same way on every row. max_model_len is deliberately
 * *not* here: it is a serving knob like max_num_seqs, so it chips when it varies across
 * the group and folds into "rest" when it does not.
 */
export const KEY_SPEC_FIELDS = ['tp', 'dp', 'num_instances'] as const

/** A deployment field as a label/value pair, for the spec lines. */
export interface SpecPair {
  field: string
  value: string
}

/**
 * One deployment's spec, partitioned for the readout's first column:
 *
 * - `key`   — {@link KEY_SPEC_FIELDS}, always shown, in a fixed order;
 * - `knobs` — the fields that differ across the group (minus the key ones and
 *   `hardware`, which have their own slots) plus every `extra_flags` entry: the
 *   differentiators the reader most needs, so they lead the collapsible region;
 * - `rest`  — the remaining fields, identical across the group, revealed only on
 *   "show all" so a resting cell stays compact.
 *
 * `hardware` appears in neither list: it is the cell's own (conditional) GPU line.
 */
export interface DeploymentSpec {
  key: SpecPair[]
  knobs: KnobChip[]
  rest: SpecPair[]
}

const KEY_SPEC_SET = new Set<string>(KEY_SPEC_FIELDS)

export function deploymentSpec(record: RunRecord, varyingFields: string[]): DeploymentSpec {
  const deployment = record.deployment as unknown as Record<string, unknown>
  const varying = new Set(varyingFields)

  const key: SpecPair[] = KEY_SPEC_FIELDS.map((field) => ({
    field,
    value: String(deployment[field]),
  }))

  const knobs: KnobChip[] = []
  const rest: SpecPair[] = []
  for (const field of Object.keys(deployment)) {
    // model and hardware have their own slots in the cell; extra_flags is always a chip.
    if (field === 'extra_flags' || field === 'hardware' || field === 'model' || KEY_SPEC_SET.has(field))
      continue
    if (varying.has(field)) knobs.push({ label: `${field} ${String(deployment[field])}`, extra: false })
    else rest.push({ field, value: String(deployment[field]) })
  }
  // extra_flags is the escape hatch: every entry is part of row identity (A3), so it
  // is always a knob, never folded into rest.
  for (const [flag, value] of Object.entries(record.deployment.extra_flags ?? {})) {
    knobs.push({ label: `--${flag} ${String(value)}`, extra: true })
  }

  return { key, knobs, rest }
}

/** The accelerators present across these records, sorted and de-duplicated. */
export function distinctHardware(records: RunRecord[]): string[] {
  return [...new Set(records.map((r) => r.deployment.hardware))].sort()
}

/** The models present across these records, sorted and de-duplicated. */
export function distinctModels(records: RunRecord[]): string[] {
  return [...new Set(records.map((r) => r.deployment.model))].sort()
}

/**
 * The rank a disqualified run would have taken among the complete runs, on one
 * column. Shown so the reader sees what the disqualification withheld: "would place
 * it #1 of 11 on latency, by virtue of the work it never did."
 */
export function wouldBeRank(
  record: RunRecord,
  complete: RunRecord[],
  columnKey: string,
): { rank: number; of: number } {
  const col = NUMERIC_COLUMNS.find((c) => c.key === columnKey)
  if (!col) throw new Error(`wouldBeRank: no column ${columnKey}`)
  const dir = col.higherIsBetter ? -1 : 1
  const field = col.value

  const contenders = [...complete, record]
    .map((r) => ({ id: r.run_id, value: field(r) }))
    .filter((c): c is { id: string; value: number } => c.value != null)
    .sort((a, b) => (a.value - b.value) * dir)

  return {
    rank: contenders.findIndex((c) => c.id === record.run_id) + 1,
    of: contenders.length,
  }
}

/**
/** One column's contribution to the sort, in priority order within a `SortSpec[]`. */
export interface SortSpec {
  key: string
  dir: 1 | -1
}

/**
 * Sorts a copy against an ordered list of columns: the first spec is primary, each
 * later spec breaks ties left by the ones before it. An empty list means the declared
 * order — nothing is sorted on load, and no column carries a default ranking (D3).
 *
 * A missing value sinks that row for the column deciding it, whichever direction it
 * points, so an incomplete metric never floats to the top of a descending sort.
 *
 * When every spec ties (h100-tp2 and h100-tp2-seqs32 are exact twins in the fixture),
 * order breaks on original position scaled by the last spec's direction. Without that,
 * a stable sort keeps tied records in the same relative order regardless of dir, so
 * reversing the direction would not reverse the array.
 */
export function sortRecords(records: RunRecord[], sort: SortSpec[]): RunRecord[] {
  const specs: { col: Column; dir: 1 | -1 }[] = []
  for (const s of sort) {
    const col = NUMERIC_COLUMNS.find((c) => c.key === s.key)
    if (col) specs.push({ col, dir: s.dir })
  }
  if (specs.length === 0) return [...records]
  const tieDir = specs[specs.length - 1]!.dir
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      for (const { col, dir } of specs) {
        const av = col.value(a.r)
        const bv = col.value(b.r)
        if (av == null && bv == null) continue
        if (av == null) return 1
        if (bv == null) return -1
        if (av !== bv) return (av - bv) * dir
      }
      return (a.i - b.i) * tieDir
    })
    .map(({ r }) => r)
}

/**
 * The sort a header click produces, applied as a pure step over the current list.
 * A column not yet sorted appends as the lowest priority (so the first-clicked column
 * stays primary and later clicks are secondary, tertiary, …); a column already sorted
 * cycles its own direction ascending → descending → off, dropping it without
 * disturbing the order of the rest.
 */
export function nextSort(sort: SortSpec[], key: string): SortSpec[] {
  const idx = sort.findIndex((s) => s.key === key)
  if (idx === -1) return [...sort, { key, dir: 1 }]
  if (sort[idx]!.dir === 1) {
    const next = [...sort]
    next[idx] = { key, dir: -1 }
    return next
  }
  return sort.filter((s) => s.key !== key)
}

/**
 * Drops one column from the sort, leaving the priority of every other tier intact —
 * what a sort-note chip's remove button applies. This is the removal half of
 * `nextSort`'s third click, pulled out so a chip can drop any tier directly rather
 * than only the one whose header the reader cycles off.
 */
export function removeSort(sort: SortSpec[], key: string): SortSpec[] {
  return sort.filter((s) => s.key !== key)
}

/** completed ÷ injected. Derived: BLIS reports the two counts separately. */
export function servedFraction(r: RunRecord): {
  completed: number
  injected: number
  percent: number
} {
  const completed = r.metrics.completed_requests
  const injected = r.metrics.injected_requests
  return {
    completed,
    injected,
    percent: injected === 0 ? 0 : Math.round((completed / injected) * 100),
  }
}

/** tp × num_instances. Derived: BLIS does not report a GPU count. */
export function gpuCount(r: RunRecord): number {
  return r.deployment.tp * r.deployment.num_instances
}

/**
 * Mean output tokens per served request. Derived, and the honest tell that shedding
 * changes the job rather than just shrinking it: dropping removes the requests that
 * did not fit, so the served subset is systematically easier. In the committed
 * fixture the max_model_len 640 run averages 94.6 against the stock run's 186.1.
 */
export function outputTokensPerRequest(r: RunRecord): number | null {
  const completed = r.metrics.completed_requests
  if (completed === 0) return null
  return r.metrics.total_output_tokens / completed
}

export interface DqReason {
  code: string
  class: string
  detail: string
}

export interface DqSummary {
  runId: string
  model: string
  hardware: string
  tp: number
  chips: KnobChip[]
  reasons: DqReason[]
  /** The rank this run would have taken on E2E p99 among the complete runs. */
  wouldBeRank: { rank: number; of: number }
  servedCompleted: number
  servedInjected: number
  e2eP99Ms: number
  ttftP99Ms: number
  tokensPerSec: number
  stillRunning: number
  stillQueued: number
  /** Mean output tokens per served request for this run. */
  outputTokensPerRequest: number | null
  /**
   * The same figure across the group's complete runs, for comparison. null when the
   * group has no complete run to compare against.
   */
  completeOutputTokensPerRequest: number | null
}

/**
 * Everything the band claims about each disqualified run, computed once so the
 * claims are testable rather than assembled inside JSX.
 */
export function dqSummary(group: RunGroup): DqSummary[] {
  const varying = varyingDeploymentFields(group.records)

  const completePerReq = group.complete
    .map(outputTokensPerRequest)
    .filter((v): v is number => v != null)
  const completeMean =
    completePerReq.length === 0
      ? null
      : completePerReq.reduce((a, b) => a + b, 0) / completePerReq.length

  return group.disqualified.map((record) => ({
    runId: record.run_id,
    model: record.deployment.model,
    hardware: record.deployment.hardware,
    tp: record.deployment.tp,
    chips: knobChips(record, varying),
    reasons: record.status.disqualifications.map((d) => ({
      code: d.code,
      class: d.class,
      detail: d.detail,
    })),
    wouldBeRank: wouldBeRank(record, group.complete, 'e2e_p99_ms'),
    servedCompleted: record.metrics.completed_requests,
    servedInjected: record.metrics.injected_requests,
    e2eP99Ms: record.metrics.e2e_p99_ms,
    ttftP99Ms: record.metrics.ttft_p99_ms,
    tokensPerSec: record.metrics.tokens_per_sec,
    stillRunning: record.metrics.still_running,
    stillQueued: record.metrics.still_queued,
    outputTokensPerRequest: outputTokensPerRequest(record),
    completeOutputTokensPerRequest: completeMean,
  }))
}
