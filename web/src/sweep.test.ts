import { describe, expect, it } from 'vitest'
import { initialValues } from './newrun'
import {
  SWEEPABLE_KEYS, BOOL_AXES, axisValues, toggleAxisValue, addAxisValue,
  removeAxisValue, axisVaries, applyPicks, sweepHasVariation,
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
