import type { RunRecord } from './load'
import type { Column } from './model'

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
