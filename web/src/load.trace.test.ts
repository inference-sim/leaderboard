import { describe, it, expect } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups, loadWorkloads, type RunRecord } from './load'

const records = fixture as unknown as RunRecord[]
const MAIN = '5063e40dceb2'

// A trace record reuses a real record as its base, then swaps in a trace workload and its
// record-level trace_meta, so the board can be exercised without a stored trace blob.
function traceRecord(overrides: Partial<RunRecord> = {}, pool = 32): RunRecord {
  const base = JSON.parse(
    JSON.stringify((records as RunRecord[]).find((r) => r.group_id === MAIN)!),
  ) as RunRecord
  base.group_id = 'tracegroup01'
  base.workload_name = 'acme-jan'
  base.group.workload = {
    type: 'trace',
    arrival_process: 'constant',
    num_requests: 0,
    load: pool > 0 ? { kind: 'sessions', value: pool } : { kind: 'recorded', value: 0 },
    prompt_tokens: 0,
    prompt_tokens_stdev: 0,
    output_tokens: 0,
    output_tokens_stdev: 0,
    spec_file: null,
    spec_sha256: null,
    trace: {
      sha256: 'a'.repeat(64),
      session_mode: pool > 0 ? 'closed-loop' : 'fixed',
      concurrent_sessions: pool,
      total_sessions: 0,
      shuffle_corpus: false,
      think_time_ms: 0,
      think_time_dist: '',
    },
  } as RunRecord['group']['workload']
  base.trace_meta = { source_format: 'weka', records: 128000, sessions: 4000, session_context_growth: 'accumulate' }
  return { ...base, ...overrides }
}

describe('trace workloads on the board', () => {
  it('summarizes a pooled trace by its concurrent-session count, never "0 requests"', () => {
    const [g] = loadGroups([traceRecord()])
    expect(g!.summary).toContain('32 concurrent sessions')
    expect(g!.summary).not.toContain('0 requests')
  })

  it('summarizes a recorded-arrival trace as such', () => {
    const [g] = loadGroups([traceRecord({}, 0)])
    expect(g!.summary).toContain('recorded arrivals')
  })

  it('titles a named trace by its catalog name and tags it as a trace', () => {
    const [w] = loadWorkloads([traceRecord()])
    expect(w!.name).toBe('acme-jan')
    expect(w!.title).toBe('acme-jan')
    expect(w!.tags).toContain('trace')
  })
})
