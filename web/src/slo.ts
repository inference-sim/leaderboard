import type { RunRecord } from './load'
import { formatMs, formatNumber } from './format'
import { COLUMNS } from './model'

/**
 * The reader-side SLO (service level objective) filter: a threshold on any of the table's
 * latency or throughput metrics. Latency metrics take a maximum-milliseconds ceiling;
 * throughput metrics (higher is better) take a minimum-per-second floor. A run passes when
 * it satisfies every set threshold (they combine with AND); a run that misses is relocated
 * to the SloBand beneath the table, never silently dropped. Pure and unit-tested; no
 * schema, Go, or BLIS involvement: every metric here is an always-present typed field of
 * `metrics`.
 */

/** One metric a target can be set against. */
export interface SloMetric {
  key: string
  label: string
  /** Pulls the metric out of a record. Reused from the column so the two cannot drift. */
  value: (r: RunRecord) => number | null
  /** True when a larger value is better, so the target is a floor (minimum), not a ceiling. */
  higherIsBetter: boolean
  /** Which section and threshold sense the metric belongs to. */
  group: 'latency' | 'throughput'
  /** Fixed decimal places for a throughput value; undefined means format as a duration. */
  digits?: number
}

/**
 * The metrics a target can be set on: the table's latency and throughput columns, derived
 * from COLUMNS so the filter tracks the column set rather than a hand-kept duplicate.
 * Latency columns are ceilings; throughput columns (higherIsBetter) are floors.
 */
export const SLO_METRICS: SloMetric[] = COLUMNS.filter(
  (c) => c.group === 'latency' || c.group === 'throughput',
).map((c) => ({
  key: c.key,
  label: c.label,
  value: c.value,
  higherIsBetter: c.higherIsBetter ?? false,
  group: c.group as 'latency' | 'throughput',
  digits: c.digits,
}))

/** The raw input strings, one slot per metric key, as held by the form. */
export type RawTargets = Record<string, string>

/** Parsed, valid targets only: metric key to a threshold value. */
export type SloTargets = Record<string, number>

/** The resting form value: one empty slot per metric, no target set. */
export function emptyTargets(): RawTargets {
  const out: RawTargets = {}
  for (const m of SLO_METRICS) out[m.key] = ''
  return out
}

/**
 * Keeps only the slots that parse to a finite number greater than zero; blanks, NaN, zero,
 * and negatives are dropped, so a non-positive or non-numeric input is a no-op target
 * rather than an error state.
 */
export function parseTargets(raw: RawTargets): SloTargets {
  const out: SloTargets = {}
  for (const [key, str] of Object.entries(raw)) {
    if (str.trim() === '') continue
    const n = Number(str)
    if (Number.isFinite(n) && n > 0) out[key] = n
  }
  return out
}

/** True when a run's value satisfies one metric's target, given the metric's direction. */
function meetsTarget(value: number | null, target: number, higherIsBetter: boolean): boolean {
  if (value == null || !Number.isFinite(value)) return false
  return higherIsBetter ? value >= target : value <= target
}

/**
 * True when the record satisfies every set target: a latency value at or below its ceiling,
 * a throughput value at or above its floor. A missing or null value with a target set is
 * treated as a miss.
 */
export function passesSlo(record: RunRecord, targets: SloTargets): boolean {
  return SLO_METRICS.every((m) => {
    const target = targets[m.key]
    if (target == null) return true
    return meetsTarget(m.value(record), target, m.higherIsBetter)
  })
}

/** One target a record missed: the metric, the run's value (null when absent), the threshold. */
export interface SloMiss {
  key: string
  label: string
  value: number | null
  target: number
  /** True when the threshold is a floor the value fell short of, false when a ceiling it exceeded. */
  higherIsBetter: boolean
  /** Column precision for a throughput value; undefined means format as a duration. */
  digits?: number
}

/** The specific misses for one record, used to write the band's per-run copy. */
export function sloMisses(record: RunRecord, targets: SloTargets): SloMiss[] {
  const misses: SloMiss[] = []
  for (const m of SLO_METRICS) {
    const target = targets[m.key]
    if (target == null) continue
    const value = m.value(record)
    if (!meetsTarget(value, target, m.higherIsBetter)) {
      misses.push({
        key: m.key,
        label: m.label,
        value: value != null && Number.isFinite(value) ? value : null,
        target,
        higherIsBetter: m.higherIsBetter,
        digits: m.digits,
      })
    }
  }
  return misses
}

/** Renders one miss's value or target for display: a duration for latency, a fixed-digit
 * count for throughput. */
function formatSlo(miss: SloMiss, v: number): string {
  return miss.digits != null ? formatNumber(v, miss.digits) : formatMs(v)
}

/** The band's one-line copy for a single missed target. No em dashes; null is spelled out. */
export function missText(miss: SloMiss): string {
  const targetStr = formatSlo(miss, miss.target)
  if (miss.value == null) {
    return `${miss.label} has no value, but a ${targetStr} target was set.`
  }
  const valueStr = formatSlo(miss, miss.value)
  return miss.higherIsBetter
    ? `${miss.label} ${valueStr} falls short of the ${targetStr} target.`
    : `${miss.label} ${valueStr} exceeds the ${targetStr} target.`
}

/**
 * A one-line pill label for each set target, e.g. "TTFT p99 ≤ 500.0ms" or "Tokens/s ≥
 * 1,000.0", in metric order. Used by the collapsed filter card to preview what is set
 * without expanding: a ceiling reads with ≤, a floor with ≥, each at the column precision.
 */
export function targetChips(targets: SloTargets): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  for (const m of SLO_METRICS) {
    const t = targets[m.key]
    if (t == null) continue
    const v = m.digits != null ? formatNumber(t, m.digits) : formatMs(t)
    out.push({ key: m.key, text: `${m.label} ${m.higherIsBetter ? '≥' : '≤'} ${v}` })
  }
  return out
}

/**
 * Partitions a list into the runs that pass every set target and the runs pulled out to
 * the band. With no targets set, everything passes and hidden is empty. Run order is kept
 * within each half.
 */
export function splitBySlo(
  records: RunRecord[],
  targets: SloTargets,
): { passing: RunRecord[]; hidden: RunRecord[] } {
  const passing: RunRecord[] = []
  const hidden: RunRecord[] = []
  for (const r of records) {
    if (passesSlo(r, targets)) passing.push(r)
    else hidden.push(r)
  }
  return { passing, hidden }
}
