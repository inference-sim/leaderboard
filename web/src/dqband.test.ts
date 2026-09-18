import { describe, expect, it } from 'vitest'
import fixture from '../../prototypes/results.json'
import { loadGroups } from './load'
import type { RunRecord } from './load'
import { dqSummary } from './model'

const groups = loadGroups(fixture as unknown as RunRecord[])
const main = groups.find((g) => g.groupId === '5063e40dceb2')!
const horizon = groups.find((g) => g.groupId === '6beca76a8f45')!

describe('dqSummary', () => {
  it('is empty when every run completed', () => {
    expect(dqSummary({ ...main, disqualified: [] })).toHaveLength(0)
  })

  it('reports the rank the shedding run would have taken', () => {
    const [entry] = dqSummary(main)
    expect(entry!.runId).toBe('h100-tp2-len640')
    expect(entry!.wouldBeRank).toEqual({ rank: 1, of: 11 })
  })

  it('carries every disqualification reason with its class', () => {
    const [entry] = dqSummary(main)
    expect(entry!.reasons).toHaveLength(1)
    expect(entry!.reasons[0]!.code).toBe('requests_dropped')
    expect(entry!.reasons[0]!.class).toBe('incomplete')
    expect(entry!.reasons[0]!.detail).toContain('259 of 500')
  })

  it('quantifies the size bias: the served subset is easier, not just smaller', () => {
    const [entry] = dqSummary(main)
    expect(entry!.outputTokensPerRequest).toBeCloseTo(94.6, 1)
    // Against the group's complete runs, which averaged far more per request.
    expect(entry!.completeOutputTokensPerRequest).toBeGreaterThan(180)
  })

  it('reports both reasons when a run trips two rules', () => {
    const [entry] = dqSummary(horizon)
    expect(entry!.reasons.map((r) => r.code)).toEqual([
      'window_ended_busy',
      'injection_short',
    ])
  })

  it('ranks a lone disqualified run #1 of 1 rather than dividing by zero', () => {
    const [entry] = dqSummary(horizon)
    expect(entry!.wouldBeRank).toEqual({ rank: 1, of: 1 })
    expect(entry!.completeOutputTokensPerRequest).toBeNull()
  })
})
