import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { COLUMNS } from './model'
import {
  buildConfigRows,
  buildMetricRows,
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
    ;(missing.metrics as unknown as Record<string, unknown>).preemption_count = null
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

/** Two complete records differing only in max_num_seqs, plus one DQ record. */
function trio() {
  const complete = records.filter((r) => r.status.complete)
  const a = JSON.parse(JSON.stringify(complete[0])) as RunRecord
  const b = JSON.parse(JSON.stringify(complete[0])) as RunRecord
  a.run_id = 'A'
  b.run_id = 'B'
  b.deployment.max_num_seqs = a.deployment.max_num_seqs + 8
  b.metrics = { ...b.metrics, e2e_p99_ms: a.metrics.e2e_p99_ms * 2, tokens_per_sec: a.metrics.tokens_per_sec / 2 }
  const dq = JSON.parse(JSON.stringify(complete[0])) as RunRecord
  dq.run_id = 'D'
  dq.status = {
    ...dq.status,
    complete: false,
    disqualifications: [{ code: 'requests_dropped', class: 'altered', detail: 'dropped work' }],
  }
  dq.metrics = { ...dq.metrics, e2e_p99_ms: a.metrics.e2e_p99_ms / 2 } // "faster", but must stay neutral
  return { a, b, dq }
}

describe('buildConfigRows', () => {
  it('groups fields under the Declare titles and marks a differing field as varying', () => {
    const { a, b } = trio()
    const groups = buildConfigRows([a, b], ['A', 'B'], true)
    const sched = groups.find((g) => g.title === 'Scheduling & batching')!
    const seqs = sched.rows.find((r) => r.field === 'max_num_seqs')!
    expect(seqs.varies).toBe(true)
    expect(seqs.cells.map((c) => c.runId)).toEqual(['A', 'B'])
  })
  it('hides identical rows when showIdentical is false and shows them when true', () => {
    const { a, b } = trio()
    const hidden = buildConfigRows([a, b], ['A', 'B'], false)
    const shown = buildConfigRows([a, b], ['A', 'B'], true)
    const hasScheduler = (gs: ReturnType<typeof buildConfigRows>) =>
      gs.some((g) => g.rows.some((r) => r.field === 'scheduler'))
    expect(hasScheduler(hidden)).toBe(false) // scheduler is identical across A and B
    expect(hasScheduler(shown)).toBe(true)
    // The varying field survives the collapse.
    expect(hidden.some((g) => g.rows.some((r) => r.field === 'max_num_seqs'))).toBe(true)
  })
  it('never renders the Simulation model group (latency_model is a sim setting, not under test)', () => {
    const { a, b } = trio()
    // Even with showIdentical on, the simulator group is excluded from the comparison.
    const groups = buildConfigRows([a, b], ['A', 'B'], true)
    expect(groups.some((g) => g.title === 'Simulation model')).toBe(false)
  })
  it('renders every extra_flags entry unconditionally, even when identical', () => {
    const { a, b } = trio()
    a.deployment.extra_flags = { 'my-flag': '1' }
    b.deployment.extra_flags = { 'my-flag': '1' }
    const groups = buildConfigRows([a, b], ['A', 'B'], false)
    const extra = groups.find((g) => g.title === 'Extra flags')!
    expect(extra.rows.map((r) => r.label)).toContain('--my-flag')
  })
})

describe('buildMetricRows', () => {
  it('shows the control raw and a signed percentage delta for the others', () => {
    const { a, b } = trio()
    const blocks = buildMetricRows([a, b], ['A', 'B'])
    const latency = blocks.find((bl) => bl.title === 'latency')!
    const e2e = latency.rows.find((r) => r.key === 'e2e_p99_ms')!
    const [control, other] = e2e.cells
    expect(control!.isControl).toBe(true)
    expect(control!.delta).toBeNull()
    expect(other!.delta).toMatch(/\+100(\.0)?%/) // B's e2e is 2x A's
    expect(other!.cls).toBe('bad') // higher latency is worse
  })
  it('colours a throughput loss red and a gain green', () => {
    const { a, b } = trio() // b halves tokens_per_sec
    const loss = buildMetricRows([a, b], ['A', 'B'])
    const lossTps = loss.find((bl) => bl.title === 'throughput')!.rows.find((r) => r.key === 'tokens_per_sec')!
    expect(lossTps.cells[1]!.cls).toBe('bad')
    // A run whose throughput beats the control reads green.
    const gain = JSON.parse(JSON.stringify(a)) as RunRecord
    gain.run_id = 'G'
    gain.metrics = { ...gain.metrics, tokens_per_sec: a.metrics.tokens_per_sec * 2 }
    const gainBlocks = buildMetricRows([a, gain], ['A', 'G'])
    const gainTps = gainBlocks.find((bl) => bl.title === 'throughput')!.rows.find((r) => r.key === 'tokens_per_sec')!
    expect(gainTps.cells[1]!.cls).toBe('good')
  })
  it('renders served as a plain value with no delta', () => {
    const { a, b } = trio()
    const blocks = buildMetricRows([a, b], ['A', 'B'])
    const health = blocks.find((bl) => bl.title === 'health')!
    const served = health.rows.find((r) => r.key === 'served')!
    expect(served.cells.every((c) => c.delta === null)).toBe(true)
    expect(served.cells.every((c) => c.cls === 'neutral')).toBe(true)
  })
  it('keeps a disqualified column neutral even when its number beats the control', () => {
    const { a, dq } = trio()
    const blocks = buildMetricRows([a, dq], ['A', 'D'])
    const latency = blocks.find((bl) => bl.title === 'latency')!
    const e2e = latency.rows.find((r) => r.key === 'e2e_p99_ms')!
    expect(e2e.cells[1]!.cls).toBe('neutral')
  })
  it('renders a missing metric as an em-dash with no delta', () => {
    const { a, b } = trio()
    ;(b.metrics as unknown as Record<string, unknown>).preemption_count = null
    const blocks = buildMetricRows([a, b], ['A', 'B'])
    const health = blocks.find((bl) => bl.title === 'health')!
    const pre = health.rows.find((r) => r.key === 'preemption_count')!
    expect(pre.cells[1]!.text).toBe('—')
    expect(pre.cells[1]!.delta).toBeNull()
  })
})
