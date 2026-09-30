import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups } from './load'
import type { RunRecord } from './load'
import {
  COLUMNS,
  KEY_SPEC_FIELDS,
  LOAD_COLUMN,
  deploymentSpec,
  distinctHardware,
  distinctModels,
  fieldDisplay,
  gpuCount,
  groupStartKeys,
  groupedHeaders,
  knobChips,
  outputTokensPerRequest,
  nextSort,
  preemptionRate,
  removeSort,
  servedFraction,
  sortRecords,
  varyingDeploymentFields,
  visibleColumns,
  wouldBeRank,
} from './model'

const records = fixture as unknown as RunRecord[]
const groups = loadGroups(records)
const main = groups.find((g) => g.groupId === '5063e40dceb2')!

describe('loadGroups', () => {
  it('buckets by group_id, so two runs offered different work cannot share a table', () => {
    expect(groups).toHaveLength(2)
    expect(main.records).toHaveLength(11)
    expect(groups.find((g) => g.groupId === '6beca76a8f45')!.records).toHaveLength(1)
  })

  it('separates complete runs from disqualified ones without dropping any', () => {
    expect(main.complete).toHaveLength(10)
    expect(main.disqualified).toHaveLength(1)
    expect(main.complete.length + main.disqualified.length).toBe(main.records.length)
    expect(main.disqualified[0]!.run_id).toBe('h100-tp2-len640')
  })
})

describe('varyingDeploymentFields', () => {
  // A3: no two rows may differ invisibly, so every field that differs anywhere in
  // the group is rendered on every row.
  it('reports exactly the deployment fields that differ across the group', () => {
    const fields = varyingDeploymentFields(main.records)
    expect(fields).toContain('hardware')
    expect(fields).toContain('tp')
    expect(fields).toContain('max_num_seqs')
    expect(fields).toContain('max_model_len')
    expect(fields).not.toContain('block_size_in_tokens')
    expect(fields).not.toContain('kv_cache_dtype')
    expect(fields).not.toContain('scheduler')
  })

  it('renders every extra_flags entry regardless, since it is the escape hatch', () => {
    const withExtra: RunRecord = JSON.parse(JSON.stringify(main.records[0]))
    withExtra.deployment.extra_flags = { 'prefix-tokens': '64' }
    const chips = knobChips(withExtra, varyingDeploymentFields(main.records))
    expect(chips.some((c) => c.label.includes('prefix-tokens'))).toBe(true)
  })
})

describe('knobChips', () => {
  it('names the knob and its value for a row that overrides one', () => {
    const fields = varyingDeploymentFields(main.records)
    const seqs8 = main.records.find((r) => r.run_id === 'h100-tp2-seqs8')!
    const labels = knobChips(seqs8, fields).map((c) => c.label)
    expect(labels).toContain('max_num_seqs 8')
  })

  it('omits model, hardware and tp, which get their own prominent slot', () => {
    // A second model makes model a varying field; it must still never chip (own slot, E1).
    const two = JSON.parse(JSON.stringify(main.records)) as RunRecord[]
    two[0]!.deployment.model = 'meta/llama-3-8b'
    const fields = varyingDeploymentFields(two)
    expect(fields).toContain('model')
    const labels = knobChips(two[0]!, fields).map((c) => c.label)
    expect(labels.some((l) => l.startsWith('model'))).toBe(false)
    expect(labels.some((l) => l.startsWith('hardware'))).toBe(false)
    expect(labels.some((l) => l.startsWith('tp '))).toBe(false)
  })
})

describe('deploymentSpec', () => {
  const fields = varyingDeploymentFields(main.records)

  it('always lists the key parallelism/instance fields, in order, however they vary', () => {
    const tp2 = main.records.find((r) => r.run_id === 'h100-tp2')!
    const spec = deploymentSpec(tp2, fields)
    expect(spec.key.map((p) => p.field)).toEqual([...KEY_SPEC_FIELDS])
    // tp, dp, num_instances.
    expect(spec.key.find((p) => p.field === 'tp')!.value).toBe('2')
  })

  it('treats max_model_len as a server-arg knob, not part of the always-shown topology', () => {
    // It is not one of the topology fields, and it varies in the fixture (the len640
    // run), so it chips on every row rather than sitting on the key line.
    const tp2 = main.records.find((r) => r.run_id === 'h100-tp2')!
    const spec = deploymentSpec(tp2, fields)
    expect(spec.key.some((p) => p.field === 'max_model_len')).toBe(false)
    expect(spec.knobs.map((c) => c.label)).toContain('max_model_len 40960')
  })

  it('puts a varying non-key field in knobs, not key or rest', () => {
    const seqs8 = main.records.find((r) => r.run_id === 'h100-tp2-seqs8')!
    const spec = deploymentSpec(seqs8, fields)
    expect(spec.knobs.map((c) => c.label)).toContain('max_num_seqs 8')
    expect(spec.rest.some((p) => p.field === 'max_num_seqs')).toBe(false)
  })

  it('renders every extra_flags entry as a knob, marked extra', () => {
    const withExtra: RunRecord = JSON.parse(JSON.stringify(main.records[0]))
    withExtra.deployment.extra_flags = { 'prefix-tokens': '64' }
    const spec = deploymentSpec(withExtra, fields)
    const flag = spec.knobs.find((c) => c.label.includes('prefix-tokens'))
    expect(flag).toBeDefined()
    expect(flag!.extra).toBe(true)
  })

  it('keeps constant non-key fields in rest, hidden until "show all"', () => {
    const spec = deploymentSpec(main.records[0]!, fields)
    // scheduler and kv_cache_dtype do not vary in the fixture, so they are secondary.
    expect(spec.rest.some((p) => p.field === 'scheduler')).toBe(true)
    expect(spec.rest.some((p) => p.field === 'kv_cache_dtype')).toBe(true)
    // Never the key fields, model or hardware, which have their own slots.
    for (const f of [...KEY_SPEC_FIELDS, 'model', 'hardware'])
      expect(spec.rest.some((p) => p.field === f)).toBe(false)
  })
})

describe('structured deployment fields render as per-item chips, never "[object Object]"', () => {
  // routing_scorers and disaggregation are the two structured deployment fields. String()
  // collapses them to "[object Object]"; the chip instead names the field once and lists
  // one token per scorer / pool, mirroring the value blis takes on the command line.
  const weighted = (): RunRecord => {
    const rec: RunRecord = JSON.parse(JSON.stringify(main.records[0]))
    rec.deployment.routing_policy = 'weighted'
    rec.deployment.routing_scorers = [
      { name: 'precise-prefix-cache', weight: 2 },
      { name: 'queue-depth', weight: 1 },
    ]
    return rec
  }

  it('lists one token per scorer, name ×weight', () => {
    const chip = knobChips(weighted(), ['routing_scorers']).find((c) => c.label === 'routing_scorers')
    expect(chip).toBeDefined()
    expect(chip!.items).toEqual(['precise-prefix-cache ×2', 'queue-depth ×1'])
    expect(JSON.stringify(chip)).not.toContain('object Object')
  })

  it('lists the disaggregation pools that are on, and only non-default transfer knobs', () => {
    const rec = weighted()
    rec.deployment.disaggregation = {
      prefill_instances: 2,
      decode_instances: 2,
      prefill_decode_instances: 0,
      decider: 'never',
      prefix_threshold: 16,
      transfer_bandwidth: 25,
      transfer_base_latency: 0.05,
      transfer_contention: false,
    }
    const chip = knobChips(rec, ['disaggregation']).find((c) => c.label === 'disaggregation')
    expect(chip!.items).toEqual(['prefill 2', 'decode 2'])
  })

  it('spells out the shared pool, decider and any non-default transfer physics', () => {
    const rec = weighted()
    rec.deployment.disaggregation = {
      prefill_instances: 1,
      decode_instances: 0,
      prefill_decode_instances: 3,
      decider: 'prefix-threshold',
      prefix_threshold: 32,
      transfer_bandwidth: 50,
      transfer_base_latency: 0.1,
      transfer_contention: true,
    }
    const chip = knobChips(rec, ['disaggregation']).find((c) => c.label === 'disaggregation')
    expect(chip!.items).toEqual([
      'prefill 1',
      'both 3',
      'decider prefix-threshold',
      'prefix-threshold 32',
      'transfer-bw 50 GB/s',
      'transfer-lat 0.1 ms',
      'contention',
    ])
  })

  it('groups a constant structured field the same way when it folds into rest', () => {
    const spec = deploymentSpec(weighted(), [])
    const pair = spec.rest.find((p) => p.field === 'routing_scorers')
    expect(pair).toBeDefined()
    expect(pair!.items).toEqual(['precise-prefix-cache ×2', 'queue-depth ×1'])
    expect(JSON.stringify(pair)).not.toContain('object Object')
  })
})

describe('distinctHardware / distinctModels', () => {
  it('counts the accelerators present, so the cell can drop a one-GPU-type label', () => {
    expect(distinctHardware(main.complete)).toEqual(['A100-SXM', 'H100', 'L40S'])
    const h100 = main.complete.filter((r) => r.deployment.hardware === 'H100')
    expect(distinctHardware(h100)).toEqual(['H100'])
  })

  it('counts the models present, so the cell can drop a one-model label', () => {
    expect(distinctModels(main.complete)).toEqual(['qwen/qwen3-14b'])
    const two = JSON.parse(JSON.stringify(main.complete)) as RunRecord[]
    two[0]!.deployment.model = 'meta/llama-3-8b'
    expect(distinctModels(two)).toEqual(['meta/llama-3-8b', 'qwen/qwen3-14b'])
  })
})

describe('wouldBeRank', () => {
  // "Would place it #1 of 11 on latency, by virtue of the work it never did."
  it('reports the rank a disqualified run would have taken', () => {
    const len640 = main.disqualified[0]!
    const { rank, of } = wouldBeRank(len640, main.complete, 'e2e_p99_ms')
    expect(rank).toBe(1)
    expect(of).toBe(11)
  })
})

describe('sortRecords', () => {
  it('leaves the declared order alone when nothing is sorted', () => {
    const ids = sortRecords(main.complete, []).map((r) => r.run_id)
    expect(ids).toEqual(main.complete.map((r) => r.run_id))
  })

  it('sorts ascending then descending on the same column', () => {
    const asc = sortRecords(main.complete, [{ key: 'e2e_p99_ms', dir: 1 }]).map((r) => r.run_id)
    const desc = sortRecords(main.complete, [{ key: 'e2e_p99_ms', dir: -1 }]).map((r) => r.run_id)
    expect(asc[0]).toBe('h100-tp4')
    expect(desc[0]).toBe('l40s-tp2')
    expect(asc).toEqual([...desc].reverse())
  })

  it('does not mutate its input', () => {
    const before = main.complete.map((r) => r.run_id)
    sortRecords(main.complete, [{ key: 'tokens_per_sec', dir: -1 }])
    expect(main.complete.map((r) => r.run_id)).toEqual(before)
  })

  it('breaks ties on the primary column with the secondary one', () => {
    // Two records made to tie on the primary metric but differ on the secondary,
    // so only a secondary spec can decide their order.
    const pool = JSON.parse(JSON.stringify(main.complete.slice(0, 2))) as RunRecord[]
    const a = pool[0]!
    const b = pool[1]!
    a.run_id = 'tie-a'
    b.run_id = 'tie-b'
    a.metrics.e2e_p99_ms = b.metrics.e2e_p99_ms // tie the primary
    a.metrics.tokens_per_sec = 100
    b.metrics.tokens_per_sec = 200

    const primaryOnly = sortRecords(pool, [{ key: 'e2e_p99_ms', dir: 1 }]).map((r) => r.run_id)
    expect(primaryOnly).toEqual(['tie-a', 'tie-b']) // tie keeps declared order

    const byTps = sortRecords(pool, [
      { key: 'e2e_p99_ms', dir: 1 },
      { key: 'tokens_per_sec', dir: -1 },
    ]).map((r) => r.run_id)
    expect(byTps).toEqual(['tie-b', 'tie-a']) // secondary desc puts 200 first
  })

  it('sorts across models by value, not grouping by model — the mixed table depends on it', () => {
    // A second model whose E2E p99 falls between the first model's values, so a
    // correct sort must interleave the two rather than keep each model in its own run.
    const llama = (JSON.parse(JSON.stringify(main.complete)) as RunRecord[]).map((r) => {
      r.deployment.model = 'meta/llama-3-8b'
      r.run_id = `llama-${r.run_id}`
      r.metrics.e2e_p99_ms += 0.5
      return r
    })
    const merged = [...main.complete, ...llama]
    const asc = sortRecords(merged, [{ key: 'e2e_p99_ms', dir: 1 }])

    const values = asc.map((r) => r.metrics.e2e_p99_ms)
    expect(values).toEqual([...values].sort((a, b) => a - b)) // globally value-ordered
    const models = asc.map((r) => r.deployment.model)
    // Not "all of one model then all of the other": the sort crosses the boundary.
    expect(new Set(models.slice(0, 5)).size).toBeGreaterThan(1)
  })
})

describe('LOAD_COLUMN (the offered-load column of a sweep)', () => {
  const at = (value: number, id: string): RunRecord => {
    const r = JSON.parse(JSON.stringify(main.complete[0]!)) as RunRecord
    r.run_id = id
    r.group.workload.load = { ...r.group.workload.load, value }
    return r
  }

  it('reads the offered-load value off the group', () => {
    expect(LOAD_COLUMN.value(main.records[0]!)).toBe(6)
  })

  it('is sortable through sortRecords by its key', () => {
    const rows = [at(20, 'a'), at(6, 'b'), at(10, 'c')]
    const asc = sortRecords(rows, [{ key: 'load', dir: 1 }]).map((r) => r.group.workload.load.value)
    const desc = sortRecords(rows, [{ key: 'load', dir: -1 }]).map((r) => r.group.workload.load.value)
    expect(asc).toEqual([6, 10, 20])
    expect(desc).toEqual([20, 10, 6])
  })
})

describe('nextSort (a header click applied to the current sort)', () => {
  it('adds an unsorted column as the lowest priority, ascending', () => {
    expect(nextSort([], 'e2e_p99_ms')).toEqual([{ key: 'e2e_p99_ms', dir: 1 }])
    expect(nextSort([{ key: 'e2e_p99_ms', dir: 1 }], 'tokens_per_sec')).toEqual([
      { key: 'e2e_p99_ms', dir: 1 },
      { key: 'tokens_per_sec', dir: 1 },
    ])
  })

  it('cycles a sorted column ascending → descending → off, leaving the rest in place', () => {
    const primary = { key: 'e2e_p99_ms', dir: 1 as const }
    const asc = [primary, { key: 'tokens_per_sec', dir: 1 as const }]
    const desc = nextSort(asc, 'tokens_per_sec')
    expect(desc).toEqual([primary, { key: 'tokens_per_sec', dir: -1 }])
    expect(nextSort(desc, 'tokens_per_sec')).toEqual([primary]) // third click drops it
  })
})

describe('removeSort (dropping one tier via its sort-note chip)', () => {
  it('removes the named column, keeping the priority order of the rest', () => {
    const sort = [
      { key: 'e2e_p99_ms', dir: 1 as const },
      { key: 'tokens_per_sec', dir: -1 as const },
      { key: 'ttft_p99_ms', dir: 1 as const },
    ]
    expect(removeSort(sort, 'tokens_per_sec')).toEqual([
      { key: 'e2e_p99_ms', dir: 1 },
      { key: 'ttft_p99_ms', dir: 1 },
    ])
  })

  it('leaves the sort untouched when the column is not sorted', () => {
    const sort = [{ key: 'e2e_p99_ms', dir: 1 as const }]
    expect(removeSort(sort, 'tokens_per_sec')).toEqual(sort)
  })

  it('empties the sort when the last remaining column is removed', () => {
    expect(removeSort([{ key: 'e2e_p99_ms', dir: 1 }], 'e2e_p99_ms')).toEqual([])
  })
})

describe('derived values', () => {
  it('computes the served fraction from the two counts BLIS reports separately', () => {
    const len640 = main.disqualified[0]!
    const served = servedFraction(len640)
    expect(served.completed).toBe(241)
    expect(served.injected).toBe(500)
    expect(served.percent).toBe(48)
  })

  it('computes the GPU count from flags, since blis does not report one', () => {
    const tp4 = main.records.find((r) => r.run_id === 'h100-tp4')!
    expect(gpuCount(tp4)).toBe(4)
  })

  // The honest tell that shedding changes the job: the served subset is smaller
  // AND easier.
  it('computes output tokens per served request', () => {
    const len640 = main.disqualified[0]!
    const stock = main.complete.find((r) => r.run_id === 'h100-tp2')!
    expect(outputTokensPerRequest(len640)).toBeCloseTo(94.6, 1)
    expect(outputTokensPerRequest(stock)).toBeCloseTo(186.1, 1)
  })
})

describe('COLUMNS', () => {
  it('groups headers as candidate, latency, throughput, health, kv', () => {
    const seen: string[] = []
    for (const c of COLUMNS) if (seen[seen.length - 1] !== c.group) seen.push(c.group)
    // KV is last so it appends to the right when toggled on, past the default readout.
    expect(seen).toEqual(['candidate', 'latency', 'throughput', 'health', 'kv'])
  })

  it('marks the derived columns so the UI can flag what BLIS did not report', () => {
    expect(COLUMNS.find((c) => c.key === 'gpus')!.derivedFrom).toBeTruthy()
    expect(COLUMNS.find((c) => c.key === 'served')!.derivedFrom).toBeTruthy()
    expect(COLUMNS.find((c) => c.key === 'e2e_p99_ms')!.derivedFrom).toBeUndefined()
  })
})

describe('KV cache columns', () => {
  const col = (key: string) => COLUMNS.find((c) => c.key === key)!
  const withKV = (over: Partial<RunRecord['metrics']> & { kv_thrashing_rate?: number }): RunRecord => {
    const r = JSON.parse(JSON.stringify(main.complete[0]!)) as RunRecord
    const { kv_thrashing_rate, ...metrics } = over
    Object.assign(r.metrics, metrics)
    if (kv_thrashing_rate !== undefined) r.kv_thrashing_rate = kv_thrashing_rate
    return r
  }

  it('appends the four KV columns in order, all in the kv group', () => {
    const kv = COLUMNS.filter((c) => c.group === 'kv').map((c) => c.key)
    expect(kv).toEqual(['cache_hit_rate', 'preemption_rate', 'kv_allocation_failures', 'kv_thrashing_rate'])
  })

  it('reads cache hit rate from the metric, higher is better, and shows null when absent', () => {
    expect(col('cache_hit_rate').higherIsBetter).toBe(true)
    expect(col('cache_hit_rate').value(withKV({ cache_hit_rate: 0.42 }))).toBe(0.42)
    // An older BLIS omits it: value is null (renders "—"), not a spurious 0.
    const noHit = withKV({})
    delete noHit.metrics.cache_hit_rate
    expect(col('cache_hit_rate').value(noHit)).toBeNull()
  })

  it('derives preemption rate and marks it derived at the point of display', () => {
    const c = col('preemption_rate')
    expect(c.derivedFrom).toBeTruthy()
    expect(c.derivedFrom!.formula).toContain('preemption_count')
    expect(c.value(withKV({ preemption_count: 12, completed_requests: 400 }))).toBeCloseTo(0.03, 6)
  })

  it('treats kv allocation failures as an integer count, defaulting an absent value to 0', () => {
    expect(col('kv_allocation_failures').digits).toBe(0)
    expect(col('kv_allocation_failures').value(withKV({ kv_allocation_failures: 7 }))).toBe(7)
    const none = withKV({})
    delete none.metrics.kv_allocation_failures
    expect(col('kv_allocation_failures').value(none)).toBe(0)
  })

  it('reads the scraped thrashing rate off the record, null when not reported', () => {
    expect(col('kv_thrashing_rate').value(withKV({ kv_thrashing_rate: 0.0345 }))).toBe(0.0345)
    const none = withKV({})
    delete none.kv_thrashing_rate
    expect(col('kv_thrashing_rate').value(none)).toBeNull()
  })
})

describe('preemptionRate', () => {
  const rec = (preemption_count: number, completed_requests: number): RunRecord => {
    const r = JSON.parse(JSON.stringify(main.complete[0]!)) as RunRecord
    r.metrics.preemption_count = preemption_count
    r.metrics.completed_requests = completed_requests
    return r
  }

  it('is preemption_count ÷ completed_requests', () => {
    expect(preemptionRate(rec(12, 400))).toBeCloseTo(0.03, 6)
  })

  it('is null when no request completed, so it never divides by zero', () => {
    expect(preemptionRate(rec(3, 0))).toBeNull()
  })
})

describe('groupedHeaders (the grouped top header row, over the visible columns)', () => {
  it('collapses runs of the same group into colspans, KV hidden by default', () => {
    expect(groupedHeaders(visibleColumns(false), false)).toEqual([
      { group: 'candidate', span: 2 },
      { group: 'latency', span: 5 },
      { group: 'throughput', span: 2 },
      { group: 'health', span: 2 },
    ])
  })

  it('appends a KV span when the KV columns are visible', () => {
    expect(groupedHeaders(visibleColumns(true), false)).toEqual([
      { group: 'candidate', span: 2 },
      { group: 'latency', span: 5 },
      { group: 'throughput', span: 2 },
      { group: 'health', span: 2 },
      { group: 'kv', span: 4 },
    ])
  })

  it('prepends a blank leading cell for the Load column of a sweep', () => {
    const headers = groupedHeaders(visibleColumns(false), true)
    expect(headers[0]).toEqual({ group: '', span: 1 })
  })
})

describe('groupStartKeys (the columns a group separator sits left of)', () => {
  it('marks the first column of each group after candidate, tracking the visible set', () => {
    expect([...groupStartKeys(visibleColumns(false))]).toEqual([
      'ttft_p99_ms',
      'tokens_per_sec',
      'served',
    ])
  })

  it('adds the KV group boundary when KV is visible', () => {
    expect(groupStartKeys(visibleColumns(true)).has('cache_hit_rate')).toBe(true)
  })
})

describe('visibleColumns', () => {
  it('drops the KV group when the toggle is off (the default readout)', () => {
    const keys = visibleColumns(false).map((c) => c.key)
    expect(keys).not.toContain('cache_hit_rate')
    expect(keys).not.toContain('kv_thrashing_rate')
    // Everything else is untouched, so the default table is exactly as before.
    expect(visibleColumns(false)).toEqual(COLUMNS.filter((c) => c.group !== 'kv'))
  })

  it('appends the KV columns to the right when the toggle is on', () => {
    const keys = visibleColumns(true).map((c) => c.key)
    expect(keys.slice(-4)).toEqual([
      'cache_hit_rate',
      'preemption_rate',
      'kv_allocation_failures',
      'kv_thrashing_rate',
    ])
    expect(visibleColumns(true)).toEqual(COLUMNS)
  })
})

describe('fieldDisplay', () => {
  const base = records[0]!
  it('renders a scalar field as its stringified value', () => {
    expect(fieldDisplay(base, 'tp')).toEqual({ value: String(base.deployment.tp) })
  })
  it('renders routing_scorers as name x weight tokens when present', () => {
    const r = JSON.parse(JSON.stringify(base)) as RunRecord
    r.deployment.routing_policy = 'weighted'
    r.deployment.routing_scorers = [{ name: 'precise-prefix-cache', weight: 2 }]
    const out = fieldDisplay(r, 'routing_scorers')
    expect(out.value).toBe('')
    expect(out.items).toEqual(['precise-prefix-cache ×2'])
  })
  it('renders disaggregation pools as tokens', () => {
    const r = JSON.parse(JSON.stringify(base)) as RunRecord
    r.deployment.disaggregation = {
      prefill_instances: 2,
      decode_instances: 1,
      prefill_decode_instances: 0,
      decider: 'never',
      prefix_threshold: 16,
      transfer_bandwidth: 25,
      transfer_base_latency: 0.05,
      transfer_contention: false,
    }
    expect(fieldDisplay(r, 'disaggregation').items).toEqual(['prefill 2', 'decode 1'])
  })
})
