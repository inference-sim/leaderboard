import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { loadWorkloads, runKey } from './load'
import { visibleOrder, visibleRows } from './rows'
import { selectionInDisplayOrder } from './compare'

const records = fixture as unknown as RunRecord[]
const w = loadWorkloads(records).find((x) => x.groups.some((g) => g.groupId === '5063e40dceb2'))!

describe('visibleRows / visibleOrder', () => {
  it('orders the ranked rows by the active sort', () => {
    const order = visibleOrder(visibleRows(w, w.models, [], [], {}, [{ key: 'e2e_p99_ms', dir: 1 }]))
    const e2e = order.filter((r) => r.status.complete).map((r) => r.metrics.e2e_p99_ms)
    for (let i = 1; i < e2e.length; i++) expect(e2e[i]!).toBeGreaterThanOrEqual(e2e[i - 1]!)
  })

  it('puts the disqualified band after the ranked rows', () => {
    const order = visibleOrder(visibleRows(w, w.models, [], [], {}, []))
    const firstDq = order.findIndex((r) => !r.status.complete)
    const lastComplete = order.map((r) => r.status.complete).lastIndexOf(true)
    expect(firstDq).toBeGreaterThan(lastComplete)
  })
})

describe('Compare opens in the table order, not click order', () => {
  it('returns selected runs in the current sorted order', () => {
    // Sort descending by latency; "click" the 3rd row then the 1st.
    const order = visibleOrder(visibleRows(w, w.models, [], [], {}, [{ key: 'e2e_p99_ms', dir: -1 }]))
    const picked = [runKey(order[2]!), runKey(order[0]!)]
    const got = selectionInDisplayOrder(order, picked)
    // Comes back in table order: order[0] is the control, order[2] the second column.
    expect(got.map(runKey)).toEqual([runKey(order[0]!), runKey(order[2]!)])
  })
})
