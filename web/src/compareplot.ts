import type { RunRecord } from './load'
import { offeredLoad } from './load'
import { COLUMNS, gpuCount, outputTokensPerRequest, type ColumnGroup } from './model'

/**
 * How a dimension can sit on an axis. A `numeric` dimension (tp, offered load) gives a
 * continuous X and a connectable line; a `categorical` one (model, hardware, a scheduler
 * name) gives grouped positions; a `structured` one (routing_scorers, disaggregation) has
 * no single scalar, so it can only group by Color, never be a numeric X.
 */
export type AxisKind = 'numeric' | 'categorical' | 'structured'

/** A Y-axis candidate: something BLIS measured, or a figure the leaderboard derives. */
export interface MetricOption {
  key: string
  label: string
  /** 'ms' | 'tok/s' | 'req/s' | '%' | '' (shown beside the axis title and in tooltips). */
  unit: string
  higherIsBetter: boolean
  /** Fixed decimals; undefined means format as a duration (ms/s). */
  digits?: number
  /** The column group this metric came from; 'kv' options are offered only when the highlighted
   *  runs actually carry KV-cache data. */
  group: ColumnGroup
  /** Set when the leaderboard computes this rather than reading it from BLIS. */
  derived?: string
  /** A standing caveat shown when this metric is on Y (e.g. the responses_per_sec cap). */
  caveat?: string
  value: (r: RunRecord) => number | null
}

/** An X- or Color-axis candidate: the offered load, or a deployment field. */
export interface DimOption {
  /** 'load', a deployment field key, or `extra_flags.<flag>`. */
  key: string
  label: string
  kind: AxisKind
  /** For the offered load: 'req/s' or 'sessions'. */
  unit?: string
  /** True when the value is not identical across the highlighted runs. A constant makes a
   *  flat, meaningless axis, so the UI shows it dimmed and non-draggable. */
  varies: boolean
  /** The plottable value: a number for a numeric dim, else a stable string for grouping. */
  get: (r: RunRecord) => number | string | null
}

/** Per-metric unit, keyed by column. Kept explicit because a column's `digits` alone can't
 *  tell ms from a percentage from a bare count. */
const METRIC_UNITS: Record<string, string> = {
  ttft_p99_ms: 'ms',
  itl_p99_ms: 'ms',
  e2e_p99_ms: 'ms',
  e2e_mean_ms: 'ms',
  scheduling_delay_p99_ms: 'ms',
  tokens_per_sec: 'tok/s',
  responses_per_sec: 'req/s',
  served: '%',
  preemption_count: '',
}

/** The column groups whose members are output metrics (as opposed to work/candidate inputs).
 *  'kv' is included so KV-cache metrics can be plotted when the runs report them. */
const METRIC_GROUPS = new Set<ColumnGroup>(['latency', 'throughput', 'health', 'kv'])

/**
 * The Y-axis candidates: every BLIS-measured metric the Compare table can show (latency,
 * throughput, health, and the KV-cache group), plus the two figures the leaderboard derives
 * (GPU count and output tokens per request). A `percent` column (cache hit rate) plots as a
 * 0–100 value with a % unit, matching the table. Deployment knobs are never here: a knob is
 * an input, not an output.
 */
export function metricOptions(): MetricOption[] {
  const measured: MetricOption[] = COLUMNS.filter((c) => METRIC_GROUPS.has(c.group)).map((c) => ({
    key: c.key,
    label: c.label,
    unit: c.percent ? '%' : (METRIC_UNITS[c.key] ?? ''),
    higherIsBetter: c.higherIsBetter ?? false,
    digits: c.percent ? 1 : c.digits,
    group: c.group,
    // A percent column stores the raw fraction; the plot shows 0–100 like the table's cell.
    value: c.percent ? (r) => { const v = c.value(r); return v == null ? null : v * 100 } : c.value,
    caveat:
      c.key === 'responses_per_sec'
        ? 'Capped by the offered rate: at one load it measures whether the run kept up, not its capacity.'
        : undefined,
  }))
  const derived: MetricOption[] = [
    {
      key: 'gpus',
      label: 'GPUs',
      unit: '',
      higherIsBetter: false,
      digits: 0,
      group: 'candidate',
      derived: 'tp × num_instances; BLIS reports no GPU count.',
      value: (r) => gpuCount(r),
    },
    {
      key: 'output_tokens_per_req',
      label: 'Output tok/req',
      unit: '',
      higherIsBetter: true,
      digits: 0,
      group: 'throughput',
      derived: 'total_output_tokens ÷ completed_requests; BLIS reports the totals.',
      value: (r) => outputTokensPerRequest(r),
    },
  ]
  return [...measured, ...derived]
}

/** latency_model is a simulator setting rather than a candidate under test, so it is not an
 *  axis (the Compare table hides it the same way). */
const DIM_EXCLUDED = new Set<string>(['extra_flags', 'latency_model'])

/** The runtime type of a value decides how it plots: numbers are continuous, strings and
 *  booleans are categories, objects and arrays are structured. */
function kindOf(value: unknown): AxisKind {
  const t = typeof value
  if (t === 'number') return 'numeric'
  if (t === 'object' && value !== null) return 'structured'
  return 'categorical'
}

/**
 * The X / Color candidates for a highlighted set: the offered load, then every deployment
 * field, typed from the data. Constants are included but flagged `varies: false` so the UI
 * can dim them. The offered load is always offered (it is the sweep dimension) and reads its
 * value through {@link offeredLoad}, so a workload-spec's concurrency and a distribution's
 * rate both land on the same axis.
 */
export function dimOptions(records: RunRecord[]): DimOption[] {
  const out: DimOption[] = []

  const loads = records.map((r) => offeredLoad(r.group))
  const loadKind = loads[0]?.kind ?? 'rate'
  out.push({
    key: 'load',
    // Two offered-load kinds only: an arrival rate, or a concurrency. A trace's pool of
    // concurrent closed-loop sessions ('sessions') is the same thing as concurrency, so it
    // reads as Concurrency here too.
    label: loadKind === 'rate' ? 'Arrival rate' : 'Concurrency',
    kind: 'numeric',
    unit: loadKind === 'rate' ? 'req/s' : 'sessions',
    varies: new Set(loads.map((l) => l.value)).size > 1,
    get: (r) => offeredLoad(r.group).value,
  })

  const fieldKeys = new Set<string>()
  for (const r of records) {
    for (const k of Object.keys(r.deployment)) {
      if (!DIM_EXCLUDED.has(k)) fieldKeys.add(k)
    }
  }

  for (const field of fieldKeys) {
    const raw = (r: RunRecord) => (r.deployment as unknown as Record<string, unknown>)[field]
    const firstDefined = records.map(raw).find((v) => v != null)
    const kind = kindOf(firstDefined)
    // The plottable value: a number for a numeric dim, else a short categorical label. A
    // structured field (kv_offload, disaggregation, routing_scorers) collapses to a concise
    // label so it groups and legends cleanly, rather than as raw JSON that splits near-identical
    // configs into singleton series and overflows the plot.
    const get = (r: RunRecord): number | string | null => {
      const v = raw(r)
      if (kind === 'numeric') return v == null ? null : (v as number)
      if (kind === 'structured') return structuredLabel(field, v)
      return v == null ? null : String(v)
    }
    const varies = new Set(records.map((r) => JSON.stringify(get(r) ?? null))).size > 1
    out.push({ key: field, label: field, kind, varies, get })
  }

  return out
}

/**
 * A concise categorical label for a structured deployment field, used when it colors the plot.
 * Feature objects read as on/off by presence; a routing profile names its scorers. This is the
 * grouping key too, so all "on" configs share one series (and one line) rather than each distinct
 * object splitting off on its own.
 */
function structuredLabel(field: string, value: unknown): string {
  if (value == null) return 'off'
  if (field === 'disaggregation') {
    const d = value as Record<string, unknown>
    const active =
      (typeof d.prefill_instances === 'number' && d.prefill_instances > 0) ||
      (typeof d.decode_instances === 'number' && d.decode_instances > 0) ||
      (typeof d.prefill_decode_instances === 'number' && d.prefill_decode_instances > 0) ||
      (d.decider != null && d.decider !== 'never')
    return active ? 'on' : 'off'
  }
  if (field === 'routing_scorers' && Array.isArray(value)) {
    const names = (value as { name?: string }[]).map((s) => s.name).filter(Boolean)
    return names.length ? names.join('+') : 'off'
  }
  return 'on'
}

/** The axis assignment the reader has arranged. `x` is a dim key or a metric key (metrics are
 *  allowed on X for the throughput–latency tradeoff view); `y` is always a metric; `color` is a
 *  dim key or null (monochrome). */
export interface PlotState {
  x: string | null
  y: string
  color: string | null
  connect: boolean
  log: boolean
}

/** One plotted run. `x` is a number for a numeric axis, a string for a categorical one. */
export interface PlotPoint {
  run: RunRecord
  x: number | string | null
  y: number | null
  /** The Color group this point belongs to, or 'all' when Color is unset. */
  series: string
  /** True when the run did not complete its offered work (served < 100%): plotted apart. */
  dq: boolean
}

export interface PlotSeries {
  name: string
  /** A CSS custom-property name (e.g. '--plot-s1'); the component paints from it. */
  colorVar: string
}

export interface PlotModel {
  xKind: 'numeric' | 'categorical'
  xOption: MetricOption | DimOption
  yOption: MetricOption
  series: PlotSeries[]
  points: PlotPoint[]
  /** Labels of dimensions that vary within a single (X, Color) group but sit on no axis, so
   *  points coincide for reasons the plot does not encode. The UI surfaces these as an advisory. */
  confounds: string[]
  /** True when there are more Color groups than the categorical ramp has slots. */
  overflowSeries: boolean
}

/** The categorical ramp for Color series, in fixed order. Validated (light and dark) in the
 *  design mockup; the values live in styles.css so both themes can redefine them. */
export const PLOT_SERIES_VARS = ['--plot-s1', '--plot-s2', '--plot-s3', '--plot-s4']

/**
 * Resolves an axis assignment against a highlighted set into everything the chart needs:
 * the X kind, the resolved X/Y options, the Color series (colored by entity in a fixed order,
 * never by rank), one point per run, and the confound advisory. Tolerant by construction: an
 * unresolvable or structured X falls back to the offered load, and a Color equal to X (or
 * unknown) is dropped, so a selection change that invalidates the current axes never throws.
 */
export function buildPlot(records: RunRecord[], state: PlotState): PlotModel {
  const metrics = metricOptions()
  const dims = dimOptions(records)
  const metricByKey = new Map(metrics.map((m) => [m.key, m]))

  const yOption = metricByKey.get(state.y) ?? metrics[0]!

  const xMetric = state.x != null ? metricByKey.get(state.x) : undefined
  let xOption: MetricOption | DimOption
  let xGet: (r: RunRecord) => number | string | null
  let xKind: 'numeric' | 'categorical'
  if (xMetric) {
    xOption = xMetric
    xGet = (r) => xMetric.value(r)
    xKind = 'numeric'
  } else {
    const dim =
      dims.find((d) => d.key === state.x && d.kind !== 'structured') ??
      dims.find((d) => d.key === 'load')!
    xOption = dim
    xGet = (r) => dim.get(r)
    xKind = dim.kind === 'numeric' ? 'numeric' : 'categorical'
  }

  const colorOption =
    state.color != null
      ? dims.find((d) => d.key === state.color && d.key !== xOption.key) ?? null
      : null

  const seriesName = (r: RunRecord): string =>
    colorOption ? String(colorOption.get(r) ?? '—') : 'all'

  let series: PlotSeries[]
  let overflowSeries = false
  if (colorOption) {
    const names = [...new Set(records.map(seriesName))]
    names.sort(
      colorOption.kind === 'numeric'
        ? (a, b) => Number(a) - Number(b)
        : (a, b) => a.localeCompare(b),
    )
    overflowSeries = names.length > PLOT_SERIES_VARS.length
    series = names.map((name, i) => ({
      name,
      colorVar: i < PLOT_SERIES_VARS.length ? PLOT_SERIES_VARS[i]! : '--plot-other',
    }))
  } else {
    series = [{ name: 'all', colorVar: '--accent' }]
  }

  const points: PlotPoint[] = records.map((r) => ({
    run: r,
    x: xGet(r),
    y: yOption.value(r),
    series: seriesName(r),
    dq: !r.status.complete,
  }))

  // A dim is a confound when it varies within at least one (X, Color) group and is not itself
  // on an axis: points that share an X (and a color) then differ for a reason the plot hides.
  const shown = new Set<string>()
  if (!xMetric) shown.add(xOption.key)
  if (colorOption) shown.add(colorOption.key)
  const cellKey = (r: RunRecord) => `${String(xGet(r))}\u0000${seriesName(r)}`
  const confounds = dims
    .filter((d) => d.varies && !shown.has(d.key))
    .filter((d) => {
      const cells = new Map<string, Set<string>>()
      for (const r of records) {
        const k = cellKey(r)
        if (!cells.has(k)) cells.set(k, new Set())
        cells.get(k)!.add(String(d.get(r)))
      }
      return [...cells.values()].some((s) => s.size > 1)
    })
    .map((d) => d.label)

  return { xKind, xOption, yOption, series, points, confounds, overflowSeries }
}

/** A one-click starting view. Only presets whose dimensions are present in the highlighted
 *  set are offered (see {@link presets}). */
export interface Preset {
  id: string
  label: string
  state: PlotState
}

/** The identity dimension to color by: the varying categorical field a reader most expects to
 *  separate runs: hardware, then model, then whatever else varies. null when none varies. */
function identityDim(dims: DimOption[]): DimOption | null {
  const cat = dims.filter((d) => d.varies && d.kind === 'categorical')
  return cat.find((d) => d.key === 'hardware') ?? cat.find((d) => d.key === 'model') ?? cat[0] ?? null
}

/**
 * The axis assignment the plot opens on, chosen from what varies: a load sweep opens on
 * latency-vs-load; otherwise the first varying numeric knob becomes X; otherwise a varying
 * identity dimension is grouped along X. Color defaults to the identity dimension.
 */
export function defaultState(records: RunRecord[]): PlotState {
  const dims = dimOptions(records)
  const load = dims.find((d) => d.key === 'load')!
  const id = identityDim(dims)
  const color = id ? id.key : null
  if (load.varies) return { x: 'load', y: 'e2e_p99_ms', color, connect: true, log: true }
  const knob = dims.find((d) => d.varies && d.kind === 'numeric' && d.key !== 'load')
  if (knob) return { x: knob.key, y: 'e2e_p99_ms', color, connect: false, log: false }
  if (id) return { x: id.key, y: 'tokens_per_sec', color: null, connect: false, log: false }
  return { x: 'load', y: 'e2e_p99_ms', color, connect: true, log: false }
}

/**
 * The starting views to offer for a highlighted set, each gated on the dimensions it needs:
 * the load-sweep curves and the throughput/latency tradeoff appear only when the offered load
 * varies; the GPU-scaling view only when the GPU count varies; the grouped view only when an
 * identity dimension varies. The first is the {@link defaultState}.
 */
export function presets(records: RunRecord[]): Preset[] {
  const dims = dimOptions(records)
  const load = dims.find((d) => d.key === 'load')!
  const id = identityDim(dims)
  const color = id ? id.key : null
  const gpusVary = new Set(records.map(gpuCount)).size > 1
  const out: Preset[] = []
  if (load.varies) {
    out.push({ id: 'lat-load', label: 'Latency vs load', state: { x: 'load', y: 'e2e_p99_ms', color, connect: true, log: true } })
    out.push({ id: 'thr-load', label: 'Throughput vs load', state: { x: 'load', y: 'tokens_per_sec', color, connect: true, log: false } })
    out.push({ id: 'ttft-load', label: 'TTFT vs load', state: { x: 'load', y: 'ttft_p99_ms', color, connect: true, log: true } })
    out.push({ id: 'tradeoff', label: 'Throughput vs latency', state: { x: 'tokens_per_sec', y: 'e2e_p99_ms', color, connect: true, log: true } })
  }
  if (gpusVary) {
    out.push({ id: 'gpus-scale', label: 'Tokens/s vs GPUs', state: { x: 'gpus', y: 'tokens_per_sec', color, connect: true, log: false } })
  }
  if (id) {
    out.push({ id: `by-${id.key}`, label: `By ${id.label}`, state: { x: id.key, y: 'tokens_per_sec', color: null, connect: false, log: false } })
  }
  return out
}

/** Round, evenly spaced ticks from zero through `max`, aiming for about `count` of them. */
export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const steps = Math.floor(max / step + 1e-9)
  const out: number[] = []
  for (let i = 0; i <= steps; i++) out.push(Number((i * step).toFixed(6)))
  if (out[out.length - 1]! < max - 1e-9) out.push(Number(((steps + 1) * step).toFixed(6)))
  return out
}

/** 1-2-5 decade ticks lying within [min, max], for a logarithmic axis. */
export function logTicks(min: number, max: number): number[] {
  const out: number[] = []
  let d = Math.pow(10, Math.floor(Math.log10(min)))
  while (d <= max * 1.0001) {
    for (const m of [1, 2, 5]) {
      const v = d * m
      if (v >= min * 0.999 && v <= max * 1.0001) out.push(v)
    }
    d *= 10
  }
  return out
}
