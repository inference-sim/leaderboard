import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { buildPlot, defaultState, dimOptions, logTicks, metricOptions, niceTicks, presets } from './compareplot'

const base = (fixture as unknown as RunRecord[]).find((r) => r.status.complete)!
function clone(): RunRecord {
  return JSON.parse(JSON.stringify(base)) as RunRecord
}
/** Two records differing only in the given deployment field. */
function differBy(field: string, a: unknown, b: unknown): RunRecord[] {
  const x = clone()
  const y = clone()
  ;(x.deployment as unknown as Record<string, unknown>)[field] = a
  ;(y.deployment as unknown as Record<string, unknown>)[field] = b
  x.run_id = 'x'
  y.run_id = 'y'
  return [x, y]
}

describe('metricOptions (Y candidates)', () => {
  const opts = metricOptions()
  const byKey = new Map(opts.map((o) => [o.key, o]))

  it('offers the BLIS-measured latency, throughput, and health metrics', () => {
    for (const k of ['e2e_p99_ms', 'ttft_p99_ms', 'tokens_per_sec', 'served', 'preemption_count']) {
      expect(byKey.has(k)).toBe(true)
    }
  })

  it('offers the two leaderboard-derived metrics, each flagged as derived', () => {
    expect(byKey.get('gpus')?.derived).toBeTruthy()
    expect(byKey.get('output_tokens_per_req')?.derived).toBeTruthy()
  })

  it('carries the responses_per_sec cap caveat', () => {
    expect(byKey.get('responses_per_sec')?.caveat).toMatch(/rate/i)
  })

  it('excludes deployment fields — a knob is not an output', () => {
    expect(byKey.has('tp')).toBe(false)
    expect(byKey.has('max_num_seqs')).toBe(false)
  })

  it('offers the KV-cache metrics, with cache hit rate as a percentage', () => {
    expect(byKey.has('cache_hit_rate')).toBe(true)
    expect(byKey.has('kv_allocation_failures')).toBe(true)
    const hit = byKey.get('cache_hit_rate')!
    expect(hit.group).toBe('kv')
    expect(hit.unit).toBe('%')
    // a raw 0.42 fraction plots as 42 (matching the table's percentage cell)
    const r = clone()
    r.metrics = { ...r.metrics, cache_hit_rate: 0.42 }
    expect(hit.value(r)).toBeCloseTo(42)
  })
})

describe('dimOptions (X / Color candidates)', () => {
  it('always offers offered load as a numeric dimension', () => {
    const load = dimOptions(differBy('tp', 2, 4)).find((d) => d.key === 'load')
    expect(load).toBeTruthy()
    expect(load!.kind).toBe('numeric')
  })

  it('labels the load dimension by its kind: arrival rate vs concurrency', () => {
    // the fixture is a rate workload
    const rate = dimOptions(differBy('tp', 2, 4)).find((d) => d.key === 'load')!
    expect(rate.label).toBe('Arrival rate')
    expect(rate.unit).toBe('req/s')
    // a concurrency workload labels and units differently
    const conc = clone()
    conc.group = JSON.parse(JSON.stringify(conc.group)) as RunRecord['group']
    conc.group.workload.load = { kind: 'concurrency', value: 8 }
    const c = dimOptions([conc]).find((d) => d.key === 'load')!
    expect(c.label).toBe('Concurrency')
    expect(c.unit).toBe('sessions')
  })

  it('types a numeric knob as numeric and marks it varying', () => {
    const tp = dimOptions(differBy('tp', 2, 4)).find((d) => d.key === 'tp')
    expect(tp?.kind).toBe('numeric')
    expect(tp?.varies).toBe(true)
  })

  it('types a string knob as categorical', () => {
    const model = dimOptions(differBy('model', 'llama-a', 'llama-b')).find((d) => d.key === 'model')
    expect(model?.kind).toBe('categorical')
    expect(model?.varies).toBe(true)
  })

  it('marks a field constant across the records as not varying', () => {
    const tp = dimOptions(differBy('model', 'a', 'b')).find((d) => d.key === 'tp')
    expect(tp?.varies).toBe(false)
  })

  it('types an object/array knob as structured', () => {
    const scorers = dimOptions(
      differBy('routing_scorers', [{ name: 'a', weight: 1 }], [{ name: 'b', weight: 2 }]),
    ).find((d) => d.key === 'routing_scorers')
    expect(scorers?.kind).toBe('structured')
  })

  it('groups a structured feature (kv_offload) as on/off, not by its raw config', () => {
    // two "on" runs whose kv_offload objects differ, plus an "off" run with the field absent
    const on1 = clone()
    on1.deployment.kv_offload = { cpu_bytes_to_use: 100, block_size: 16 } as never
    const on2 = clone()
    on2.deployment.kv_offload = { cpu_bytes_to_use: 400, block_size: 16 } as never
    const off = clone()
    delete (off.deployment as { kv_offload?: unknown }).kv_offload
    const kv = dimOptions([on1, on2, off]).find((d) => d.key === 'kv_offload')!
    expect(kv.kind).toBe('structured')
    expect(kv.varies).toBe(true)
    // the two differing on-configs collapse to one label, so coloring yields on/off (two series)
    expect(kv.get(on1)).toBe('on')
    expect(kv.get(on2)).toBe('on')
    expect(kv.get(off)).toBe('off')
  })
})

/** A run at a given hardware / offered load, with an E2E p99 and a complete/subset status. */
function run(id: string, hardware: string, load: number, e2e: number, complete = true): RunRecord {
  const r = clone()
  r.run_id = id
  r.deployment.hardware = hardware
  r.group = JSON.parse(JSON.stringify(r.group)) as RunRecord['group']
  r.group.workload.load = { ...r.group.workload.load, value: load }
  r.metrics = { ...r.metrics, e2e_p99_ms: e2e, tokens_per_sec: e2e * 2 }
  r.status = { ...r.status, complete }
  return r
}
/** Two hardware types swept across two loads: the canonical sweep shape. */
function sweep(): RunRecord[] {
  return [
    run('a6', 'A100', 6, 300),
    run('a10', 'A100', 10, 900),
    run('h6', 'H100', 6, 200),
    run('h10', 'H100', 10, 600),
  ]
}

describe('buildPlot', () => {
  it('puts a numeric dimension on X as a continuous axis, one point per run', () => {
    const m = buildPlot(sweep(), { x: 'load', y: 'e2e_p99_ms', color: 'hardware', connect: true, log: false })
    expect(m.xKind).toBe('numeric')
    expect(m.points).toHaveLength(4)
    const p = m.points.find((p) => p.run.run_id === 'a6')!
    expect(p.x).toBe(6)
    expect(p.y).toBe(300)
  })

  it('groups into series by the Color dimension, colored in a fixed order by entity', () => {
    const m = buildPlot(sweep(), { x: 'load', y: 'e2e_p99_ms', color: 'hardware', connect: true, log: false })
    expect(m.series.map((s) => s.name)).toEqual(['A100', 'H100'])
    expect(m.series[0]!.colorVar).toBe('--plot-s1')
    expect(m.series[1]!.colorVar).toBe('--plot-s2')
    expect(m.points.find((p) => p.run.run_id === 'h6')!.series).toBe('H100')
  })

  it('flags a run that did not complete as disqualified', () => {
    const rows = [run('ok', 'A100', 6, 300, true), run('shed', 'A100', 10, 900, false)]
    const m = buildPlot(rows, { x: 'load', y: 'e2e_p99_ms', color: null, connect: true, log: false })
    expect(m.points.find((p) => p.run.run_id === 'shed')!.dq).toBe(true)
    expect(m.points.find((p) => p.run.run_id === 'ok')!.dq).toBe(false)
  })

  it('allows a metric on X (the throughput–latency tradeoff view)', () => {
    const m = buildPlot(sweep(), { x: 'tokens_per_sec', y: 'e2e_p99_ms', color: 'hardware', connect: false, log: false })
    expect(m.xKind).toBe('numeric')
    expect(m.points.find((p) => p.run.run_id === 'a6')!.x).toBe(600)
  })

  it('reports no confound when every varying dimension is on an axis', () => {
    const m = buildPlot(sweep(), { x: 'load', y: 'e2e_p99_ms', color: 'hardware', connect: true, log: false })
    expect(m.confounds).toEqual([])
  })

  it('names a dimension that varies within an (X, Color) group and is not shown', () => {
    const a = run('a', 'A100', 6, 300)
    const b = run('b', 'A100', 6, 320)
    a.deployment.max_num_seqs = 16
    b.deployment.max_num_seqs = 32
    const m = buildPlot([a, b], { x: 'hardware', y: 'e2e_p99_ms', color: null, connect: false, log: false })
    expect(m.confounds).toContain('max_num_seqs')
  })
})

describe('defaultState (the view the plot opens on)', () => {
  it('opens on latency-vs-load when the offered load varies', () => {
    const s = defaultState(sweep())
    expect(s.x).toBe('load')
    expect(s.y).toBe('e2e_p99_ms')
    expect(s.color).toBe('hardware')
  })

  it('opens on a varying numeric knob when the load is fixed', () => {
    const a = run('a', 'A100', 6, 300)
    const b = run('b', 'A100', 6, 320)
    a.deployment.tp = 2
    b.deployment.tp = 4
    expect(defaultState([a, b]).x).toBe('tp')
  })
})

describe('presets (context-aware)', () => {
  it('offers the load-sweep presets and the tradeoff view for a sweep', () => {
    const ids = presets(sweep()).map((p) => p.id)
    expect(ids).toContain('lat-load')
    expect(ids).toContain('thr-load')
    expect(ids).toContain('tradeoff')
  })

  it('omits the load-sweep presets and offers a grouped view when load is fixed', () => {
    const a = run('a', 'A100', 6, 300)
    const b = run('b', 'H100', 6, 320)
    const ids = presets([a, b]).map((p) => p.id)
    expect(ids).not.toContain('lat-load')
    expect(ids).toContain('by-hardware')
  })
})

describe('scale tick helpers', () => {
  it('niceTicks produces round, evenly spaced ticks from zero through the max', () => {
    expect(niceTicks(100, 5)).toEqual([0, 20, 40, 60, 80, 100])
  })

  it('logTicks produces 1-2-5 decade ticks within the range', () => {
    expect(logTicks(180, 3100)).toEqual([200, 500, 1000, 2000])
  })
})
