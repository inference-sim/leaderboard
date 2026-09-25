import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { COLUMNS } from './model'
import {
  compareDelta,
  deltaClass,
  moveColumn,
  reconcileOrder,
  removeColumn,
  reorder,
  toggleSelection,
} from './compare'

const records = fixture as unknown as RunRecord[]
const col = (key: string) => COLUMNS.find((c) => c.key === key)!

/** Build a record with a chosen metric value and completeness, for delta/colour tests. */
function withMetric(base: RunRecord, patch: Partial<RunRecord['metrics']>, complete = true): RunRecord {
  const r = JSON.parse(JSON.stringify(base)) as RunRecord
  r.metrics = { ...r.metrics, ...patch }
  r.status = { ...r.status, complete, disqualifications: complete ? [] : r.status.disqualifications }
  return r
}

describe('toggleSelection', () => {
  it('appends an unselected id and preserves order', () => {
    expect(toggleSelection(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })
  it('removes an already-selected id', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})

describe('reconcileOrder', () => {
  it('keeps existing order, appends new ids, drops absent ones', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['c', 'a', 'd'])).toEqual(['a', 'c', 'd'])
  })
})

describe('moveColumn', () => {
  it('moves an id left, promoting it toward control', () => {
    expect(moveColumn(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
  })
  it('moves an id right', () => {
    expect(moveColumn(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
  })
  it('is a no-op at the left edge', () => {
    expect(moveColumn(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })
  it('is a no-op at the right edge', () => {
    expect(moveColumn(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
  })
})

describe('removeColumn', () => {
  it('drops the id; the next column becomes control when the control is removed', () => {
    const next = removeColumn(['a', 'b', 'c'], 'a')
    expect(next).toEqual(['b', 'c'])
    expect(next[0]).toBe('b')
  })
})

describe('reorder', () => {
  it('moves an id to a target index (drag-and-drop)', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(reorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
  })
})

describe('compareDelta', () => {
  const base = records.find((r) => r.status.complete)!
  it('computes a signed fraction against the control', () => {
    const control = withMetric(base, { ttft_p99_ms: 100 })
    const worse = withMetric(base, { ttft_p99_ms: 150 })
    const d = compareDelta(worse, control, col('ttft_p99_ms'))
    expect(d.pct).toBeCloseTo(0.5, 5)
    expect(d.neutral).toBe(false)
  })
  it('marks a lower latency as better (higherIsBetter falsy)', () => {
    const control = withMetric(base, { e2e_p99_ms: 200 })
    const faster = withMetric(base, { e2e_p99_ms: 100 })
    expect(compareDelta(faster, control, col('e2e_p99_ms')).better).toBe(true)
  })
  it('marks a higher throughput as better (higherIsBetter true)', () => {
    const control = withMetric(base, { tokens_per_sec: 100 })
    const faster = withMetric(base, { tokens_per_sec: 200 })
    expect(compareDelta(faster, control, col('tokens_per_sec')).better).toBe(true)
  })
  it('is neutral when equal', () => {
    const a = withMetric(base, { tokens_per_sec: 100 })
    const b = withMetric(base, { tokens_per_sec: 100 })
    expect(compareDelta(a, b, col('tokens_per_sec'))).toMatchObject({ neutral: true, pct: 0 })
  })
  it('returns a null pct when a value is missing', () => {
    const control = withMetric(base, { tokens_per_sec: 100 })
    const missing = JSON.parse(JSON.stringify(control)) as RunRecord
    // preemption_count is a real column; null it to simulate a missing metric.
    ;(missing.metrics as Record<string, unknown>).preemption_count = null
    const d = compareDelta(missing, control, col('preemption_count'))
    expect(d.pct).toBeNull()
    expect(d.neutral).toBe(true)
  })
})

describe('deltaClass', () => {
  const base = records.find((r) => r.status.complete)!
  it('is good when better, bad when worse, neutral when equal', () => {
    const control = withMetric(base, { e2e_p99_ms: 200 })
    const faster = withMetric(base, { e2e_p99_ms: 100 })
    const slower = withMetric(base, { e2e_p99_ms: 300 })
    expect(deltaClass(faster, compareDelta(faster, control, col('e2e_p99_ms')))).toBe('good')
    expect(deltaClass(slower, compareDelta(slower, control, col('e2e_p99_ms')))).toBe('bad')
    expect(deltaClass(control, compareDelta(control, control, col('e2e_p99_ms')))).toBe('neutral')
  })
  it('is always neutral for a disqualified record, even when its number is better', () => {
    const control = withMetric(base, { e2e_p99_ms: 200 })
    const dqFaster = withMetric(base, { e2e_p99_ms: 100 }, false)
    // Its raw delta says "better", but a DQ run never reads as a clean win.
    expect(compareDelta(dqFaster, control, col('e2e_p99_ms')).better).toBe(true)
    expect(deltaClass(dqFaster, compareDelta(dqFaster, control, col('e2e_p99_ms')))).toBe('neutral')
  })
})
