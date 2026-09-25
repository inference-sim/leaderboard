import type { RunRecord } from './load'
import type { Column } from './model'
import { COLUMNS, fieldDisplay, servedFraction, varyingDeploymentFields } from './model'
import { formatCount, formatMs, formatNumber } from './format'
import { FIELD_GROUPS, SEPARATELY_RENDERED } from './fieldgroups'

/** Add an unselected run to the comparison, or remove it if already selected. Insertion
 *  order is preserved, so the first-highlighted run seeds the control slot. */
export function toggleSelection(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}

/**
 * Fold a fresh set of present run ids into the panel's column order: keep the order the
 * reader arranged for ids still present, append newly selected ids at the end, and drop ids
 * that left the selection. Lets the open panel absorb a highlight/unhighlight without losing
 * a manual reordering.
 */
export function reconcileOrder(order: string[], present: string[]): string[] {
  const set = new Set(present)
  const kept = order.filter((id) => set.has(id))
  const added = present.filter((id) => !order.includes(id))
  return [...kept, ...added]
}

/** Swap a column with its neighbour. dir -1 moves it toward the control (left), +1 right.
 *  A move off either edge is a no-op. */
export function moveColumn(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id)
  const j = i + dir
  if (i === -1 || j < 0 || j >= order.length) return order
  const next = [...order]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}

/** Drop a column. The control is order[0], so removing it promotes the next column. */
export function removeColumn(order: string[], id: string): string[] {
  return order.filter((x) => x !== id)
}

/** Move a column to an absolute index (drag-and-drop drop target). Index 0 is the control. */
export function reorder(order: string[], id: string, toIndex: number): string[] {
  const without = order.filter((x) => x !== id)
  const clamped = Math.max(0, Math.min(toIndex, without.length))
  return [...without.slice(0, clamped), id, ...without.slice(clamped)]
}

/**
 * The control-relative delta for one metric: the signed fraction (value - control) / control,
 * whether the run is better than the control (oriented by Column.higherIsBetter, so latency
 * and throughput orient correctly with no extra table), and whether it is neutral (equal, or
 * a value/control that cannot form a delta). pct is null when either side is missing or the
 * control is zero; the caller renders an em-dash then.
 */
export function compareDelta(
  record: RunRecord,
  control: RunRecord,
  col: Column,
): { pct: number | null; better: boolean; neutral: boolean } {
  const a = col.value(record)
  const b = col.value(control)
  if (a == null || b == null || b === 0) return { pct: null, better: false, neutral: true }
  if (a === b) return { pct: 0, better: false, neutral: true }
  const better = col.higherIsBetter ? a > b : a < b
  return { pct: (a - b) / b, better, neutral: false }
}

export type DeltaClass = 'good' | 'bad' | 'neutral'

/**
 * The colour class for a delta cell. A disqualified run is always neutral: its percentiles
 * describe a smaller, systematically easier subset, so colouring a faster number green would
 * present "did less work" as "faster" - the shedding-reward the board forbids. Otherwise a
 * better value is green, worse red, equal neutral.
 */
export function deltaClass(
  record: RunRecord,
  delta: { pct: number | null; better: boolean; neutral: boolean },
): DeltaClass {
  if (!record.status.complete) return 'neutral'
  if (delta.pct == null || delta.neutral) return 'neutral'
  return delta.better ? 'good' : 'bad'
}

/** The metric columns of the panel: everything BLIS-measured, grouped as in the table. The
 *  candidate group (the deployment cell and the derived gpus count) is configuration, not a
 *  metric, so it is excluded here. */
export const METRIC_COLUMNS: Column[] = COLUMNS.filter(
  (c) => c.group === 'latency' || c.group === 'throughput' || c.group === 'health',
)

export interface ConfigCell {
  runId: string
  value: string
  items?: string[]
}
export interface ConfigRow {
  /** The deployment field key, or `extra_flags.<flag>` for an extra_flags row. */
  field: string
  /** The label shown in the row's left cell (the field key, or `--flag` for extra flags). */
  label: string
  /** True when the value differs across the selected runs: the cell is tinted. */
  varies: boolean
  /** True for an extra_flags row (always shown, never collapsed). */
  extra: boolean
  cells: ConfigCell[]
}
export interface ConfigGroup {
  title: string
  rows: ConfigRow[]
}

/**
 * Declare groups the Compare panel does not show. Simulation model (latency_model) is a blis
 * simulator setting, not a deployment property under test - it rides on the record so a run
 * reproduces, but it is not something a candidate competes on, so it has no place in a
 * performance comparison. It stays in FIELD_GROUPS (which mirrors the Declare form) so the
 * coverage test and any future NewRun reuse are unaffected.
 */
const COMPARE_HIDDEN_GROUPS = new Set<string>(['Simulation model'])

/** Look records up by run id, in column order; ids with no record are skipped. */
function inOrder(records: RunRecord[], order: string[]): RunRecord[] {
  const byId = new Map(records.map((r) => [r.run_id, r]))
  return order.map((id) => byId.get(id)).filter((r): r is RunRecord => r != null)
}

/**
 * The configuration section: one group per FIELD_GROUPS entry, rows in the group's field
 * order, plus a trailing "Extra flags" group with one row per distinct flag across the
 * selected runs. A row is `varies` when its value is not identical across the columns; when
 * `showIdentical` is false, identical non-extra rows are dropped so a resting panel shows only
 * differences. extra_flags rows are always kept (part of row identity).
 */
export function buildConfigRows(records: RunRecord[], order: string[], showIdentical: boolean): ConfigGroup[] {
  const cols = inOrder(records, order)
  const varying = new Set(varyingDeploymentFields(cols))
  const groups: ConfigGroup[] = []

  for (const grp of FIELD_GROUPS) {
    if (COMPARE_HIDDEN_GROUPS.has(grp.title)) continue
    const rows: ConfigRow[] = []
    for (const field of grp.fields) {
      const varies = varying.has(field)
      if (!varies && !showIdentical) continue
      rows.push({
        field,
        label: field,
        varies,
        extra: false,
        cells: cols.map((r) => ({ runId: r.run_id, ...fieldDisplay(r, field) })),
      })
    }
    if (rows.length > 0) groups.push({ title: grp.title, rows })
  }

  // Extra flags: the union of flag names, always rendered. SEPARATELY_RENDERED documents that
  // extra_flags is handled here rather than in a group; the assertion in fieldgroups.test.ts
  // ties the two together.
  void SEPARATELY_RENDERED
  const flagNames = [...new Set(cols.flatMap((r) => Object.keys(r.deployment.extra_flags ?? {})))].sort()
  if (flagNames.length > 0) {
    const rows: ConfigRow[] = flagNames.map((flag) => {
      const values = cols.map((r) => (r.deployment.extra_flags ?? {})[flag])
      const varies = new Set(values.map((v) => String(v ?? ''))).size > 1
      return {
        field: `extra_flags.${flag}`,
        label: `--${flag}`,
        varies,
        extra: true,
        cells: cols.map((r) => ({
          runId: r.run_id,
          value: (r.deployment.extra_flags ?? {})[flag] ?? '—',
        })),
      }
    })
    groups.push({ title: 'Extra flags', rows })
  }

  return groups
}

export interface MetricCell {
  runId: string
  isControl: boolean
  /** The raw value, formatted (or an em-dash when missing). */
  text: string
  /** The signed percentage delta with an arrow (e.g. "▲ +12.3%"), or null for the control,
   *  the served row, and missing values. */
  delta: string | null
  cls: DeltaClass
}
export interface MetricRow {
  key: string
  label: string
  group: string
  cells: MetricCell[]
}
export interface MetricGroupBlock {
  title: string
  rows: MetricRow[]
}

/** A column's raw value, formatted the way the table formats it. served is its percent. */
function rawText(record: RunRecord, col: Column): string {
  if (col.key === 'served') return `${servedFraction(record).percent}%`
  const v = col.value(record)
  if (v == null) return '—'
  if (col.key === 'gpus') return formatCount(v)
  return col.digits != null ? formatNumber(v, col.digits) : formatMs(v)
}

/** The signed-percentage delta string with a direction arrow, e.g. "▲ +12.3%" / "▼ -8.0%". */
function deltaText(pct: number): string {
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : ''
  const sign = pct > 0 ? '+' : ''
  return `${arrow} ${sign}${(pct * 100).toFixed(1)}%`.trim()
}

/**
 * The metrics section: latency, throughput, health, in COLUMNS order. The control (order[0])
 * shows raw values only. Every other run shows the raw value plus a control-relative delta,
 * coloured by deltaClass. served is always a plain value (a share of offered work, not a
 * percentage-of-a-percentage), and doubles as the honesty signal for a disqualified column.
 */
export function buildMetricRows(records: RunRecord[], order: string[]): MetricGroupBlock[] {
  const cols = inOrder(records, order)
  const control = cols[0]
  const blocks: MetricGroupBlock[] = []

  for (const groupName of ['latency', 'throughput', 'health'] as const) {
    const groupCols = METRIC_COLUMNS.filter((c) => c.group === groupName)
    const rows: MetricRow[] = groupCols.map((col) => ({
      key: col.key,
      label: col.label,
      group: groupName,
      cells: cols.map((r, i) => {
        const isControl = i === 0
        const text = rawText(r, col)
        if (isControl || control == null || col.key === 'served' || col.value(r) == null) {
          return { runId: r.run_id, isControl, text, delta: null, cls: 'neutral' as DeltaClass }
        }
        const d = compareDelta(r, control, col)
        return {
          runId: r.run_id,
          isControl,
          text,
          delta: d.pct == null ? null : deltaText(d.pct),
          cls: deltaClass(r, d),
        }
      }),
    }))
    blocks.push({ title: groupName, rows })
  }

  return blocks
}
