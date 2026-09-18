import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups, loadWorkloads } from './load'
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

  it('titles the workload without a model clause, since one table spans many models', () => {
    const w = loadWorkloads(records).find((w) => w.title.startsWith('500 requests'))!
    expect(w.title).toBe('500 requests at 6.0 req/s')
    expect(w.title).not.toContain('qwen')
    expect(w.title).not.toContain(' on ')
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
