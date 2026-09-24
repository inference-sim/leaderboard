import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups } from './load'
import type { RunRecord } from './load'
import { COLUMNS } from './model'
import {
  SLO_METRICS,
  emptyTargets,
  missText,
  parseTargets,
  passesSlo,
  sloMisses,
  splitBySlo,
  targetChips,
} from './slo'

const records = fixture as unknown as RunRecord[]
const main = loadGroups(records).find((g) => g.groupId === '5063e40dceb2')!
const byId = (id: string): RunRecord => main.complete.find((r) => r.run_id === id)!

/** A clone of one complete run with one metric nulled, for the missing-value case. */
function withNull(id: string, key: string): RunRecord {
  const r = JSON.parse(JSON.stringify(byId(id))) as RunRecord
  ;(r.metrics as unknown as Record<string, unknown>)[key] = null
  return r
}

describe('SLO_METRICS', () => {
  it('is the latency and throughput columns, tracking COLUMNS rather than a hand-kept list', () => {
    const cols = COLUMNS.filter((c) => c.group === 'latency' || c.group === 'throughput')
    expect(SLO_METRICS.map((m) => m.key)).toEqual(cols.map((c) => c.key))
    expect(SLO_METRICS.map((m) => m.label)).toEqual(cols.map((c) => c.label))
    // Five latency ceilings plus the two throughput floors.
    expect(SLO_METRICS).toHaveLength(7)
  })

  it('marks the throughput metrics as higher-is-better (a floor) and latency as a ceiling', () => {
    const byKey = Object.fromEntries(SLO_METRICS.map((m) => [m.key, m]))
    expect(byKey.ttft_p99_ms!.higherIsBetter).toBe(false)
    expect(byKey.ttft_p99_ms!.group).toBe('latency')
    expect(byKey.tokens_per_sec!.higherIsBetter).toBe(true)
    expect(byKey.tokens_per_sec!.group).toBe('throughput')
    expect(byKey.responses_per_sec!.higherIsBetter).toBe(true)
  })
})

describe('emptyTargets', () => {
  it('is one empty slot per metric, the resting form value', () => {
    const empty = emptyTargets()
    expect(Object.keys(empty).sort()).toEqual(SLO_METRICS.map((m) => m.key).sort())
    expect(Object.values(empty).every((v) => v === '')).toBe(true)
    expect(parseTargets(empty)).toEqual({})
  })
})

describe('parseTargets', () => {
  it('keeps only entries that parse to a finite number greater than zero', () => {
    expect(
      parseTargets({
        ttft_p99_ms: '500',
        itl_p99_ms: '',
        e2e_p99_ms: '   ',
        e2e_mean_ms: 'abc',
        tokens_per_sec: '1000',
      }),
    ).toEqual({ ttft_p99_ms: 500, tokens_per_sec: 1000 })
  })

  it('drops zero and negative targets rather than making them a no-op threshold', () => {
    expect(parseTargets({ ttft_p99_ms: '0', tokens_per_sec: '-5' })).toEqual({})
  })
})

describe('passesSlo', () => {
  it('passes any run when no targets are set', () => {
    expect(passesSlo(byId('a100-tp1'), {})).toBe(true)
  })

  it('treats a latency target as a ceiling: at or below passes, above fails', () => {
    const ttft = byId('h100-tp1').metrics.ttft_p99_ms // about 44.5 ms
    expect(passesSlo(byId('h100-tp1'), { ttft_p99_ms: ttft })).toBe(true) // exactly at the ceiling
    expect(passesSlo(byId('h100-tp1'), { ttft_p99_ms: ttft + 10 })).toBe(true)
    expect(passesSlo(byId('h100-tp1'), { ttft_p99_ms: ttft - 10 })).toBe(false)
  })

  it('treats a throughput target as a floor: at or above passes, below fails', () => {
    const tps = byId('h100-tp1').metrics.tokens_per_sec // about 1019.4 tokens/s
    expect(passesSlo(byId('h100-tp1'), { tokens_per_sec: tps })).toBe(true) // exactly at the floor
    expect(passesSlo(byId('h100-tp1'), { tokens_per_sec: tps - 50 })).toBe(true)
    expect(passesSlo(byId('h100-tp1'), { tokens_per_sec: tps + 50 })).toBe(false)
  })

  it('combines latency and throughput targets with AND', () => {
    // h100-tp1 passes TTFT p99 <= 50 but misses tokens_per_sec >= 1100.
    expect(passesSlo(byId('h100-tp1'), { ttft_p99_ms: 50, tokens_per_sec: 1100 })).toBe(false)
  })

  it('treats a null metric with a target set as a miss, in either direction', () => {
    expect(passesSlo(withNull('h100-tp1', 'ttft_p99_ms'), { ttft_p99_ms: 500 })).toBe(false)
    expect(passesSlo(withNull('h100-tp1', 'tokens_per_sec'), { tokens_per_sec: 100 })).toBe(false)
  })
})

describe('sloMisses', () => {
  it('reports no misses when no targets are set', () => {
    expect(sloMisses(byId('h100-tp1'), {})).toEqual([])
  })

  it('names each missed metric with its value, target, and direction', () => {
    const misses = sloMisses(byId('h100-tp1'), { ttft_p99_ms: 40, tokens_per_sec: 1100 })
    expect(misses).toEqual([
      {
        key: 'ttft_p99_ms',
        label: 'TTFT p99',
        value: byId('h100-tp1').metrics.ttft_p99_ms,
        target: 40,
        higherIsBetter: false,
        digits: undefined,
      },
      {
        key: 'tokens_per_sec',
        label: 'Tokens/s',
        value: byId('h100-tp1').metrics.tokens_per_sec,
        target: 1100,
        higherIsBetter: true,
        digits: 1,
      },
    ])
  })

  it('omits a metric the run satisfies in either direction', () => {
    // h100-tp4 E2E p99 3109.1 is under 5000; tokens_per_sec 1099.4 is above 1000.
    expect(sloMisses(byId('h100-tp4'), { e2e_p99_ms: 5000, tokens_per_sec: 1000 })).toEqual([])
  })

  it('reports a null value as a miss with value null', () => {
    expect(sloMisses(withNull('h100-tp1', 'tokens_per_sec'), { tokens_per_sec: 100 })).toEqual([
      { key: 'tokens_per_sec', label: 'Tokens/s', value: null, target: 100, higherIsBetter: true, digits: 1 },
    ])
  })
})

describe('missText', () => {
  it('says a latency value exceeds its ceiling, formatted as a duration', () => {
    expect(
      missText({ key: 'e2e_p99_ms', label: 'E2E p99', value: 9749.6, target: 5000, higherIsBetter: false }),
    ).toBe('E2E p99 9.75s exceeds the 5.00s target.')
  })

  it('says a throughput value falls short of its floor, at the column precision', () => {
    expect(
      missText({
        key: 'tokens_per_sec',
        label: 'Tokens/s',
        value: 1019.4,
        target: 1100,
        higherIsBetter: true,
        digits: 1,
      }),
    ).toBe('Tokens/s 1,019.4 falls short of the 1,100.0 target.')
  })

  it('spells out a null value rather than printing an em dash', () => {
    const text = missText({ key: 'tokens_per_sec', label: 'Tokens/s', value: null, target: 100, higherIsBetter: true, digits: 1 })
    expect(text).toContain('has no value')
    expect(text).not.toContain('—')
  })
})

describe('targetChips', () => {
  it('is empty when no target is set', () => {
    expect(targetChips({})).toEqual([])
  })

  it('labels each set target with its direction and formatted value, in metric order', () => {
    expect(targetChips({ ttft_p99_ms: 500, e2e_p99_ms: 5000, tokens_per_sec: 1000 })).toEqual([
      { key: 'ttft_p99_ms', text: 'TTFT p99 ≤ 500.0ms', group: 'latency' },
      { key: 'e2e_p99_ms', text: 'E2E p99 ≤ 5.00s', group: 'latency' },
      { key: 'tokens_per_sec', text: 'Tokens/s ≥ 1,000.0', group: 'throughput' },
    ])
  })
})

describe('splitBySlo', () => {
  it('puts everything in passing and nothing in hidden when no targets are set', () => {
    const { passing, hidden } = splitBySlo(main.complete, {})
    expect(passing).toHaveLength(main.complete.length)
    expect(hidden).toHaveLength(0)
  })

  it('partitions on a latency ceiling, keeping run order within each half', () => {
    const { passing, hidden } = splitBySlo(main.complete, { e2e_p99_ms: 5000 })
    // Only h100-tp4 (3109.1) and a100-tp4 (4517.8) are at or below 5000 ms.
    expect(passing.map((r) => r.run_id)).toEqual(['h100-tp4', 'a100-tp4'])
    expect(hidden).toHaveLength(main.complete.length - 2)
  })

  it('partitions on a throughput floor', () => {
    const { passing, hidden } = splitBySlo(main.complete, { tokens_per_sec: 1050 })
    // a100-tp1, l40s-tp2, l40s-tp4, h100-tp1, a100-tp2 are all below 1050 tokens/s.
    expect(passing.map((r) => r.run_id)).toEqual(['h100-tp2', 'h100-tp4', 'a100-tp4', 'h100-tp2-seqs32', 'h100-tp2-seqs8'])
    expect(hidden).toHaveLength(5)
  })
})
