import { describe, it, expect } from 'vitest'
import {
  initialForm,
  interpret,
  variantOf,
  bodyToForm,
  profileToGroup,
  profileSummary,
  validateTraceForm,
  type FormValues,
  type ProfileBody,
  type TraceForm,
} from './workloads'

function traceForm(over: Partial<TraceForm> = {}): TraceForm {
  return {
    sessionMode: 'closed-loop',
    concurrentSessions: 32,
    totalSessions: 0,
    shuffleCorpus: false,
    thinkTimeMs: 0,
    thinkTimeDist: '',
    sha256: 'a'.repeat(64),
    sourceFormat: 'weka',
    records: 128000,
    sessions: 4000,
    sessionContextGrowth: 'accumulate',
    ...over,
  }
}

function traceValues(over: Partial<TraceForm> = {}): FormValues {
  return { ...initialForm(), name: 'acme-jan', kind: 'trace', trace: traceForm(over) }
}

describe('trace workload form', () => {
  it('variantOf reflects the chosen kind', () => {
    expect(variantOf({ ...initialForm(), kind: 'trace', trace: traceForm() })).toBe('trace')
    expect(variantOf(initialForm())).toBe('workload-spec')
  })

  it('interpret builds a trace body from a valid pooled accumulate replay', () => {
    const { issues, body } = interpret(traceValues())
    expect(issues).toEqual([])
    expect(body?.workload.type).toBe('trace')
    expect(body?.workload.trace?.sha256).toBe('a'.repeat(64))
    expect(body?.workload.trace?.concurrent_sessions).toBe(32)
    expect(body?.workload.trace?.records).toBe(128000)
  })

  it('interpret refuses a trace that has not been ingested', () => {
    const { issues, body } = interpret({ ...initialForm(), name: 'x', kind: 'trace', trace: null })
    expect(body).toBeNull()
    expect(issues.some((i) => i.field === 'trace')).toBe(true)
  })

  it('interpret surfaces a session-mode guard (fixed on an accumulate corpus)', () => {
    const { issues, body } = interpret(traceValues({ sessionMode: 'fixed', concurrentSessions: 0 }))
    expect(body).toBeNull()
    expect(issues.some((i) => i.message.includes('accumulate'))).toBe(true)
  })

  it('validateTraceForm mirrors the cross-flag guards', () => {
    expect(validateTraceForm(traceForm())).toEqual([])
    // think-time requires closed-loop
    expect(
      validateTraceForm(traceForm({ sessionMode: 'fixed-accumulate', concurrentSessions: 0, thinkTimeMs: 500 })),
    ).toContain('a think-time override requires session_mode closed-loop, not "fixed-accumulate"')
  })

  it('profileToGroup derives a sessions load for a pool and folds in the trace', () => {
    const body = interpret(traceValues()).body as ProfileBody
    const g = profileToGroup(body)
    expect(g.workload.type).toBe('trace')
    expect(g.workload.trace?.sha256).toBe('a'.repeat(64))
    expect(g.workload.load).toEqual({ kind: 'sessions', value: 32 })
  })

  it('profileToGroup derives a recorded load with no pool', () => {
    const body = interpret(traceValues({ sessionMode: 'fixed', concurrentSessions: 0, sessionContextGrowth: '' }))
      .body as ProfileBody
    expect(profileToGroup(body).workload.load).toEqual({ kind: 'recorded', value: 0 })
  })

  it('profileSummary describes the replay', () => {
    const body = interpret(traceValues()).body as ProfileBody
    expect(profileSummary(body)).toContain('32 concurrent sessions')
  })

  it('bodyToForm round-trips a trace profile back into the editor', () => {
    const body = interpret(traceValues()).body as ProfileBody
    const form = bodyToForm(body)
    expect(form.kind).toBe('trace')
    expect(form.trace?.sha256).toBe('a'.repeat(64))
    expect(form.trace?.sessionMode).toBe('closed-loop')
    expect(form.trace?.records).toBe(128000)
  })
})
