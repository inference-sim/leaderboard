import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups, loadWorkloads, offeredLoad } from './load'
import type { RunRecord } from './load'

const records = fixture as unknown as RunRecord[]

const MAIN = '5063e40dceb2' // the unbounded qwen/qwen3-14b group, 11 records
const HORIZON = '6beca76a8f45' // the bounded-window lone disqualified run

/**
 * A second model against the same work. Model is a candidate now (E1): it rides on the
 * deployment, not the group, so a different model leaves the group_id unchanged and the
 * records merge into one comparability group. run_ids are suffixed so the merged rows
 * stay distinct.
 */
function asModel(groupId: string, model: string): RunRecord[] {
  return (JSON.parse(JSON.stringify(records)) as RunRecord[])
    .filter((r) => r.group_id === groupId)
    .map((r) => {
      r.deployment.model = model
      r.run_id = `${r.run_id}-alt`
      return r
    })
}

describe('loadGroups', () => {
  it('orders groups by the work they offered, not by hash, and unbounded before bounded', () => {
    // The fixture's two groups are identical apart from the observation window, so
    // this pins the tiebreak the reader actually cares about: the group whose work no
    // window could cut short comes first.
    const groups = loadGroups(records)
    expect(groups.map((g) => g.groupId)).toEqual([MAIN, HORIZON])
    expect(groups[0]!.group.horizon_ticks).toBeNull()
    expect(groups[1]!.group.horizon_ticks).toBe(20000000)
  })

  it('orders a heavier workload after a lighter one, whatever the hashes are', () => {
    const heavier = JSON.parse(JSON.stringify(records)) as RunRecord[]
    for (const r of heavier) {
      r.group.workload.num_requests = 2000
      r.group_id = `heavy-${r.group_id}`
    }
    const ids = loadGroups([...heavier, ...records]).map((g) => g.group.workload.num_requests)
    expect(ids).toEqual([500, 500, 2000, 2000])
  })

  it('titles each group with the work it offered, model-free since a group_id reads as noise', () => {
    const groups = loadGroups(records)
    expect(groups[0]!.title).toBe('500 requests at 6.0 req/s')
    expect(groups[0]!.title).not.toContain('qwen')
    expect(groups[1]!.title).toContain('bounded window')
  })

  it('carries the group block and work_id through, for the spec header', () => {
    const g = loadGroups(records)[0]!
    // Model is on the deployment now, not the group.
    expect(g.records[0]!.deployment.model).toBe('qwen/qwen3-14b')
    expect(g.group.workload.num_requests).toBe(500)
    expect(g.workId).toMatch(/^[0-9a-f]{12}$/)
  })

  it('reports the arrival process BLIS actually uses, not poisson', () => {
    const g = loadGroups(records)[0]!
    expect(g.group.workload.arrival_process).toBe('constant')
  })

  it('flags a dirty upstream tree so the header can caveat it', () => {
    const g = loadGroups(records)[0]!
    expect(g.treeDirty).toBe(true)
    expect(g.blisCommit).toBe('07622594')
  })

  it('throws on a mixed-group record set rather than guessing', () => {
    const broken = JSON.parse(JSON.stringify(records.slice(0, 2))) as RunRecord[]
    broken[1]!.group.seed = 999 // group_id no longer matches the group block
    expect(() => loadGroups(broken)).toThrow(/group/i)
  })
})

describe('loadWorkloads', () => {
  it('collapses records that differ only in model into one workload and one comparability group', () => {
    const llama = asModel(MAIN, 'meta/llama-3-8b')
    const only = records.filter((r) => r.group_id === MAIN)
    const workloads = loadWorkloads([...only, ...llama])

    // Two models, same work → one workload, one group_id (model left the key).
    expect(workloads).toHaveLength(1)
    const w = workloads[0]!
    expect(w.models).toEqual(['meta/llama-3-8b', 'qwen/qwen3-14b'])
    expect(w.groups).toHaveLength(1)
    expect(w.records).toHaveLength(22)
  })

  it('keeps records that differ in the work — seed, horizon, or workload — in different workloads', () => {
    // The fixture's two group_ids differ only in horizon_ticks, so they are two
    // distinct workloads.
    expect(loadWorkloads(records)).toHaveLength(2)

    const reseeded = (JSON.parse(JSON.stringify(records)) as RunRecord[])
      .filter((r) => r.group_id === MAIN)
      .map((r) => {
        r.group.seed = 7
        r.group_id = `seed7-${r.group_id}`
        return r
      })
    const differBySeed = loadWorkloads([...records.filter((r) => r.group_id === MAIN), ...reseeded])
    expect(differBySeed).toHaveLength(2)
  })

  it('titles the workload without a model or load clause, since one profile spans both', () => {
    const w = loadWorkloads(records).find((w) => w.title.startsWith('500 requests'))!
    // Load is a dimension of the profile now, so the rate leaves the title.
    expect(w.title).toBe('500 requests')
    expect(w.title).not.toContain('qwen')
    expect(w.title).not.toContain(' on ')
    expect(w.title).not.toMatch(/req\/s/)
  })

  it('merges every model’s complete and disqualified runs, none hidden', () => {
    const llama = asModel(MAIN, 'meta/llama-3-8b')
    const only = records.filter((r) => r.group_id === MAIN)
    const w = loadWorkloads([...only, ...llama])[0]!

    // 10 complete + 1 disqualified per model.
    expect(w.complete).toHaveLength(20)
    expect(w.disqualified).toHaveLength(2)
    expect(w.records).toHaveLength(22)
    expect(new Set(w.records.map((r) => r.deployment.model))).toEqual(
      new Set(['meta/llama-3-8b', 'qwen/qwen3-14b']),
    )
  })

  it('still fires the per-group_id integrity check inherited from loadGroups', () => {
    const broken = JSON.parse(JSON.stringify(records.slice(0, 2))) as RunRecord[]
    broken[1]!.group.seed = 999
    expect(() => loadWorkloads(broken)).toThrow(/group/i)
  })
})

describe('load as a workload dimension', () => {
  // The MAIN group at a second offered load: identical work but for the rate. A distinct
  // group_id per load (a real comparability group each), same profile.
  function twoLoads(): RunRecord[] {
    const at6 = records.filter((r) => r.group_id === MAIN)
    const at10 = (JSON.parse(JSON.stringify(at6)) as RunRecord[]).map((r) => {
      r.group.workload.load = { ...r.group.workload.load, value: 10 }
      r.group_id = `load10-${r.group_id}`
      r.run_id = `${r.run_id}-l10`
      return r
    })
    return [...at6, ...at10]
  }

  it('groups distribution runs that differ only in offered load into one workload', () => {
    const workloads = loadWorkloads(twoLoads())
    expect(workloads).toHaveLength(1)
    const w = workloads[0]!
    expect(w.groups).toHaveLength(2) // one comparability group per load level
    expect(w.records).toHaveLength(22) // 11 per load level
  })

  it('exposes the offered-load axis, sorted ascending, on the workload', () => {
    const w = loadWorkloads(twoLoads())[0]!
    expect(w.loadAxis.kind).toBe('rate')
    expect(w.loadAxis.values).toEqual([6, 10])
  })

  it('drops the load clause from a distribution workload title, since load now varies within it', () => {
    const w = loadWorkloads(twoLoads())[0]!
    expect(w.title).toBe('500 requests')
    expect(w.title).not.toMatch(/req\/s/)
  })

  it('still separates workloads that differ in a non-load field such as horizon', () => {
    // MAIN (unbounded) and HORIZON (bounded window) differ in horizon, not load.
    expect(loadWorkloads(records)).toHaveLength(2)
  })

  it('gives a single-load distribution workload a one-value axis, so it is not a sweep', () => {
    const w = loadWorkloads(records.filter((r) => r.group_id === MAIN))[0]!
    expect(w.loadAxis.values).toEqual([6])
  })

  it('orders a sweep by configuration by default, not pre-sorted by load', () => {
    // The comparability groups concatenate load-ascending; regrouping by config puts each
    // config's load levels adjacent, so the default is not load-sorted and the Load column
    // reorders on the first click.
    const w = loadWorkloads(twoLoads())[0]!
    const seq = w.complete.map((r) => offeredLoad(r.group).value)
    // First config's two levels sit together (6 then 10), not all-6-then-all-10.
    expect(seq.slice(0, 2)).toEqual([6, 10])
    expect(new Set(seq)).toEqual(new Set([6, 10]))
  })

  it('keeps the per-group summary naming its single load level', () => {
    const g = loadGroups(records).find((g) => g.groupId === MAIN)!
    expect(g.summary).toBe('500 requests at 6.0 req/s')
  })

  // A workload-spec carries its offered load inside the spec (aggregate_rate), so a spec
  // profile swept across load must group by the spec minus that rate.
  function specAt(rate: number, groupId: string): RunRecord {
    const r = specRecord({ group_id: groupId })
    r.group = JSON.parse(JSON.stringify(r.group)) as RunRecord['group']
    ;(r.group.workload.spec as Record<string, unknown>).aggregate_rate = rate
    r.group.workload.spec_sha256 = `sha-${rate}`
    return r
  }

  it('groups workload-spec runs that differ only in aggregate rate into one profile', () => {
    const ws = loadWorkloads([specAt(10, 'sg-10'), specAt(20, 'sg-20')])
    expect(ws).toHaveLength(1)
    expect(ws[0]!.groups).toHaveLength(2)
    expect(ws[0]!.loadAxis).toEqual({ kind: 'rate', values: [10, 20] })
  })

  it('reads a single spec profile as a one-level axis at its aggregate rate', () => {
    const ws = loadWorkloads([specRecord()])
    expect(ws[0]!.loadAxis.values).toEqual([10])
  })
})

describe('offeredLoad (the single offered-load reading across workload types)', () => {
  it('reads a distribution load from the group', () => {
    const g = loadGroups(records).find((g) => g.groupId === MAIN)!.group
    expect(offeredLoad(g)).toEqual({ kind: 'rate', value: 6 })
  })

  it('reads a workload-spec load from its aggregate rate', () => {
    expect(offeredLoad(specRecord().group)).toEqual({ kind: 'rate', value: 10 })
  })

  it('reads a trace sessions load from its concurrent-sessions pool', () => {
    expect(offeredLoad(traceRecord(8).group)).toEqual({ kind: 'sessions', value: 8 })
  })
})

// A trace-backed run: a session-pool replay. The flat fields are placeholder zeros; the load is
// the `sessions` pool, mirrored onto group.workload.load and carried on the trace block.
function traceRecord(sessions: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const base = JSON.parse(JSON.stringify(records.find((r) => r.group_id === MAIN)!)) as RunRecord
  base.group_id = `trace-${sessions}`
  base.run_id = 'weka'
  base.workload_name = 'weka-jsonl'
  base.group.workload = {
    type: 'trace',
    arrival_process: 'constant',
    num_requests: 0,
    load: { kind: 'sessions', value: sessions },
    prompt_tokens: 0,
    prompt_tokens_stdev: 0,
    output_tokens: 0,
    output_tokens_stdev: 0,
    spec_file: null,
    spec_sha256: null,
    trace: {
      sha256: 'weka-abc',
      session_mode: 'closed-loop',
      concurrent_sessions: sessions,
      total_sessions: 183,
      shuffle_corpus: true,
      think_time_ms: 30,
      think_time_dist: '',
      source_format: 'weka',
      records: 26648,
      sessions: 183,
      session_context_growth: 'accumulate',
    },
  } as RunRecord['group']['workload']
  return { ...base, ...overrides }
}

describe('trace workloads offer a sessions load that sweeps', () => {
  it('collapses trace runs that differ only in concurrent-sessions into one sweep table', () => {
    const ws = loadWorkloads([traceRecord(8), traceRecord(32)])
    expect(ws).toHaveLength(1)
    expect(ws[0]!.loadAxis).toEqual({ kind: 'sessions', values: [8, 32] })
  })

  it('does not collapse traces that differ in a replay knob other than the pool', () => {
    const other = traceRecord(32)
    ;(other.group.workload.trace as { think_time_ms: number }).think_time_ms = 999
    const ws = loadWorkloads([traceRecord(8), other])
    expect(ws).toHaveLength(2)
  })
})

// A spec-backed run (a preset or saved profile): the flat num_requests/load are
// placeholder zeros, and the real load lives in group.workload.spec. One record, with
// its own group_id so it forms its own workload.
function specRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const base = JSON.parse(JSON.stringify(records.find((r) => r.group_id === MAIN)!)) as RunRecord
  base.group_id = 'specgroup01'
  base.workload_name = 'chatbot'
  base.group.workload = {
    type: 'workload-spec',
    arrival_process: 'constant',
    num_requests: 0,
    load: { kind: 'rate', value: 0 },
    prompt_tokens: 0,
    prompt_tokens_stdev: 0,
    output_tokens: 0,
    output_tokens_stdev: 0,
    spec_file: null,
    spec_sha256: 'abc',
    spec: {
      version: '2',
      aggregate_rate: 10,
      num_requests: 500,
      clients: [
        {
          id: 'c0',
          input_distribution: { type: 'gaussian', params: { mean: 256, std_dev: 100, min: 2, max: 800 } },
          output_distribution: { type: 'gaussian', params: { mean: 256, std_dev: 100, min: 1, max: 1024 } },
        },
      ],
    },
  } as RunRecord['group']['workload']
  return { ...base, ...overrides }
}

describe('spec-backed workloads', () => {
  it('summarizes a spec by its request count and rate, never as "0 requests at 0.0 req/s"', () => {
    const [g] = loadGroups([specRecord()])
    expect(g!.summary).toBe('500 requests at 10.0 req/s')
    expect(g!.summary).not.toContain('at 0.0 req/s')
  })

  it('titles a named spec workload by its catalog name, with the shape as the summary', () => {
    const [w] = loadWorkloads([specRecord()])
    expect(w!.name).toBe('chatbot')
    expect(w!.title).toBe('chatbot')
    expect(w!.summary).toBe('500 requests at 10.0 req/s')
  })

  it('falls back to the summary as the title when no run carries a name', () => {
    const [w] = loadWorkloads([specRecord({ workload_name: undefined })])
    expect(w!.name).toBeNull()
    expect(w!.title).toBe('500 requests at 10.0 req/s')
  })

  it('tags a built-in as [preset, workload-spec], a saved profile as [workload-spec]', () => {
    expect(loadWorkloads([specRecord()])[0]!.tags).toEqual(['preset', 'workload-spec'])
    expect(loadWorkloads([specRecord({ workload_name: 'my-burst' })])[0]!.tags).toEqual(['workload-spec'])
  })
})

describe('distribution workload tags', () => {
  it('tags a distribution', () => {
    const [w] = loadWorkloads(records.filter((r) => r.group_id === MAIN))
    expect(w!.tags).toEqual(['distribution'])
  })
})
