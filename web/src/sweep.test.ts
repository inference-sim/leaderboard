import { describe, expect, it } from 'vitest'
import { initialValues } from './newrun'
import { expandSweep } from './sweep'
import type { RunGroup } from './load'
import { workloadKey } from './load'
import {
  SWEEPABLE_KEYS, BOOL_AXES, axisValues, toggleAxisValue, addAxisValue,
  removeAxisValue, axisVaries, applyPicks, sweepHasVariation,
  AXIS_ABBR, slug, sweepPrefix, cellToken, groupByConfig, guardFor, WARN_AT, BLOCK_AT,
} from './sweep'

const base = initialValues()

describe('axis model', () => {
  it('model, seed, timeout, loadKind, workloadSel are not sweepable', () => {
    for (const k of ['model', 'seed', 'requestTimeoutS', 'loadKind', 'workloadSel', 'customName', 'runId']) {
      expect(SWEEPABLE_KEYS).not.toContain(k)
    }
    expect(SWEEPABLE_KEYS).toContain('hardware')
    expect(SWEEPABLE_KEYS).toContain('tp')
    expect(SWEEPABLE_KEYS).toContain('scheduler')
  })

  it('BOOL_AXES contains only boolean sweepable keys', () => {
    expect(BOOL_AXES).toContain('enableExpertParallel')
    expect(BOOL_AXES).toContain('pdTransferContention')
    expect(BOOL_AXES).toHaveLength(2)
  })

  it('axisValues defaults to the single base value when the key is absent', () => {
    expect(axisValues('tp', base, {})).toEqual([String(base.tp)])
  })

  it('toggle adds then removes a value, keeping the base value first', () => {
    const a1 = toggleAxisValue({}, 'tp', '8', base)
    expect(a1.tp).toEqual([String(base.tp), '8'])
    const a2 = toggleAxisValue(a1, 'tp', '8', base)
    expect(a2.tp).toBeUndefined() // collapsed back to just the base -> fixed -> key dropped
  })

  it('toggling the base value off is a no-op (base is always present)', () => {
    const a = toggleAxisValue({}, 'tp', String(base.tp), base)
    expect(a.tp).toBeUndefined()
  })

  it('add splits a pasted list and dedups', () => {
    const a = addAxisValue({}, 'maxModelLen', '2048', base)
    const b = addAxisValue(a, 'maxModelLen', '2048', base) // dup ignored
    expect(b.maxModelLen).toEqual([String(base.maxModelLen), '2048'])
  })

  it('remove drops a value and collapses to fixed when only base remains', () => {
    const a = addAxisValue({}, 'dp', '2', base)
    const b = removeAxisValue(a, 'dp', '2', base)
    expect(b.dp).toBeUndefined()
  })

  it('axisVaries is true only with 2+ values', () => {
    expect(axisVaries('tp', base, {})).toBe(false)
    expect(axisVaries('tp', base, toggleAxisValue({}, 'tp', '8', base))).toBe(true)
  })

  it('applyPicks overlays strings and coerces boolean axes', () => {
    const v = applyPicks(base, { tp: '8', enableExpertParallel: 'on', scheduler: 'priority' })
    expect(v.tp).toBe('8')
    expect(v.enableExpertParallel).toBe(true)
    expect(v.scheduler).toBe('priority')
    expect(v.model).toBe(base.model) // untouched
  })

  it('sweepHasVariation sees varied axes and varied load levels', () => {
    expect(sweepHasVariation(base, {}, [base.loadValue])).toBe(false)
    expect(sweepHasVariation(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue])).toBe(true)
    expect(sweepHasVariation(base, {}, [base.loadValue, '32'])).toBe(true)
  })
})

describe('run id pieces', () => {
  it('slug is filename-safe', () => {
    expect(slug('H100')).toBe('h100')
    expect(slug('fcfs')).toBe('fcfs')
    expect(slug('')).toBe('none')
    expect(slug('a b/c')).toBe('a-b-c')
  })

  it('AXIS_ABBR has an entry for every sweepable key', () => {
    for (const k of SWEEPABLE_KEYS) expect(typeof AXIS_ABBR[k]).toBe('string')
  })

  it('cellToken combines abbreviation and value', () => {
    expect(cellToken('hardware', 'H100')).toBe('h100')
    expect(cellToken('tp', '8')).toBe('tp8')
    expect(cellToken('scheduler', 'fcfs')).toBe('schedfcfs')
  })

  it('prefix is the fixed hardware when hardware is not varied, else sweep', () => {
    const base = initialValues()
    expect(sweepPrefix({ ...base, hardware: 'H100' }, ['tp'])).toBe('h100')
    expect(sweepPrefix({ ...base, hardware: 'H100' }, ['hardware', 'tp'])).toBe('sweep')
  })
})

describe('expandSweep', () => {
  const profiles: any[] = []
  const models: any[] = []
  const hardware: any[] = []
  const groups: RunGroup[] = []

  function customBase() {
    return initialValues()
  }

  it('a fixed sweep expands to exactly one run', () => {
    const e = expandSweep(customBase(), {}, [], groups, profiles, models, hardware)
    expect(e.runs.length).toBe(1)
    expect(e.configCount).toBe(1)
    expect(e.loadCount).toBe(1)
    expect(e.dropped.length).toBe(0)
  })

  it('product counts multiply configs by load levels', () => {
    const base = customBase()
    let axes = toggleAxisValue({}, 'tp', '8', base)
    const e = expandSweep(base, axes, [base.loadValue, '32', '64'], groups, profiles, models, hardware)
    expect(e.configCount).toBe(2)
    expect(e.loadCount).toBe(3)
    expect(e.runs.length).toBe(6)
    expect(e.variedDeploymentKeys).toEqual(['tp'])
  })

  it('every valid cell shares one workloadKey (one-table invariant)', () => {
    const base = customBase()
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue, '32'],
      groups, profiles, models, hardware)
    const keys = new Set(e.runs.map((c) => workloadKey(c.output.group)))
    expect(keys.size).toBe(1)
  })

  it('a config shares one run id across its load levels; different configs differ', () => {
    const base = customBase()
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue, '32'],
      groups, profiles, models, hardware)
    const byCfg = new Map<string, Set<string>>()
    for (const c of e.runs) {
      const s = byCfg.get(c.configKey) ?? new Set()
      s.add(c.output.runId); byCfg.set(c.configKey, s)
    }
    for (const s of byCfg.values()) expect(s.size).toBe(1)
    expect(byCfg.size).toBe(2)
    const ids = [...byCfg.values()].map((s) => [...s][0])
    expect(new Set(ids).size).toBe(2)
  })

  it('invalid combinations are dropped with interpret messages', () => {
    const base = customBase()
    const e = expandSweep(base, addAxisValue({}, 'dp', '0', base), [], groups, profiles, models, hardware)
    expect(e.runs.length).toBe(1)
    expect(e.dropped.length).toBe(1)
    expect(e.dropped[0]!.issues.length).toBeGreaterThan(0)
    expect(e.dropped[0]!.label).toContain('dp')
  })
})

describe('grouping and guardrail', () => {
  it('groupByConfig keeps a config\'s load levels adjacent, first-seen order', () => {
    const base = initialValues()
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue, '32'],
      [], [], [], [])
    const groups = groupByConfig(e.runs)
    expect(groups.length).toBe(2)
    expect(groups[0]!.cells.length).toBe(2)       // two load levels for the first config
    expect(new Set(groups[0]!.cells.map((c) => c.configKey)).size).toBe(1)
    expect(groups[0]!.runId).toBe(groups[0]!.cells[0]!.output.runId)
  })

  it('guardFor flips at 32 and 100', () => {
    expect(WARN_AT).toBe(32)
    expect(BLOCK_AT).toBe(100)
    expect(guardFor(32)).toBe('ok')
    expect(guardFor(33)).toBe('warn')
    expect(guardFor(100)).toBe('warn')
    expect(guardFor(101)).toBe('block')
    expect(guardFor(0)).toBe('ok')
  })
})

import { initSweepRun, countsOf, classifyRecord, runPool } from './sweep'
import type { SweepRunCell } from './sweep'

describe('sweep run state', () => {
  it('initSweepRun queues every cell', () => {
    const base = initialValues()
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue], [], [], [], [])
    const run = initSweepRun(e.runs)
    expect(run.cells.length).toBe(2)
    expect(run.cells.every((c) => c.status === 'queued')).toBe(true)
    expect(run.stopped).toBe(false)
    expect(countsOf(run)).toEqual({ done: 0, disqualified: 0, failed: 0, running: 0, queued: 2, total: 2 })
  })

  it('classifyRecord reads status.complete', () => {
    expect(classifyRecord({ status: { complete: true } } as any)).toBe('done')
    expect(classifyRecord({ status: { complete: false } } as any)).toBe('disqualified')
  })

  it('countsOf tallies mixed statuses', () => {
    const base = initialValues()
    const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue], [], [], [], [])
    const run = initSweepRun(e.runs)
    run.cells[0]!.status = 'done'
    run.cells[1]!.status = 'failed'
    expect(countsOf(run)).toMatchObject({ done: 1, failed: 1, queued: 0, total: 2 })
  })
})

function cells(n: number): SweepRunCell[] {
  return Array.from({ length: n }, (_, i) => ({
    runId: `r${i}`, configKey: `c${i}`, output: {} as any,
    status: 'queued' as const, record: null, message: null,
  }))
}

describe('runPool', () => {
  it('bounds concurrency to four', async () => {
    const c = cells(12)
    let inFlight = 0, peak = 0
    await runPool(c, async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return { status: { complete: true } } as any
    }, { concurrency: 4, onUpdate: () => {}, shouldStop: () => false })
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('a failed cell does not stop the rest', async () => {
    const c = cells(5)
    const seen: number[] = []
    await runPool(c, async (cell) => {
      const i = Number(cell.runId.slice(1)); seen.push(i)
      if (i === 2) throw new Error('422 boom')
      return { status: { complete: true } } as any
    }, { concurrency: 2, onUpdate: () => {}, shouldStop: () => false })
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('reports done / disqualified / failed via onUpdate', async () => {
    const c = cells(3)
    const patches: any[] = []
    await runPool(c, async (cell) => {
      const i = Number(cell.runId.slice(1))
      if (i === 0) return { status: { complete: true } } as any
      if (i === 1) return { status: { complete: false } } as any
      throw new Error('nope')
    }, { concurrency: 3, onUpdate: (idx, patch) => patches.push({ idx, ...patch }), shouldStop: () => false })
    const final = (idx: number) => patches.filter((p) => p.idx === idx).pop()
    expect(final(0).status).toBe('done')
    expect(final(1).status).toBe('disqualified')
    expect(final(2).status).toBe('failed')
    expect(final(2).message).toContain('nope')
  })

  it('stop halts cells not yet started', async () => {
    const c = cells(6)
    let started = 0
    await runPool(c, async () => {
      started++
      return { status: { complete: true } } as any
    }, { concurrency: 1, onUpdate: () => {}, shouldStop: () => started >= 2 })
    expect(started).toBeLessThan(6)
  })
})
