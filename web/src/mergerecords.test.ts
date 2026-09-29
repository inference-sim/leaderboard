import { describe, it, expect } from 'vitest'
import fixture from '../../prototypes/results.json'
import { mergeRecords, type RunRecord } from './load'

const recs = fixture as unknown as RunRecord[]

describe('mergeRecords', () => {
  it('keeps committed baseline records the live outDir does not have', () => {
    const committed = recs.slice(0, 3)
    const live: RunRecord[] = [] // a fresh outDir (e.g. ~/leaderboard-results) with no baseline
    const merged = mergeRecords(committed, live)
    expect(merged).toHaveLength(3)
  })

  it('lets a live record supersede the committed one with the same group_id/run_id', () => {
    const base = recs[0]!
    const live = [{ ...JSON.parse(JSON.stringify(base)), metrics: { ...base.metrics, tokens_per_sec: 9999 } } as RunRecord]
    const merged = mergeRecords([base], live)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.metrics.tokens_per_sec).toBe(9999)
  })

  it('unions distinct records (committed baseline + a session trace run)', () => {
    const committed = recs.slice(0, 2)
    const trace = { ...JSON.parse(JSON.stringify(recs[0])), group_id: 'tracegrp', run_id: 'trace-1' } as RunRecord
    const merged = mergeRecords(committed, [trace])
    const ids = merged.map((r) => `${r.group_id}/${r.run_id}`)
    expect(ids).toContain('tracegrp/trace-1')
    expect(merged).toHaveLength(3)
  })
})
