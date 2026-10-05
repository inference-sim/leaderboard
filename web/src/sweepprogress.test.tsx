import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SweepProgress } from './components/SweepProgress'
import { initialValues } from './newrun'
import { expandSweep, initSweepRun, toggleAxisValue } from './sweep'

const base = initialValues()
const e = expandSweep(base, toggleAxisValue({}, 'tp', '8', base), [base.loadValue], [], [], [], [])

describe('SweepProgress', () => {
  it('shows done / total and the tab-open hint while queued', () => {
    const run = initSweepRun(e.runs)
    const html = renderToStaticMarkup(<SweepProgress run={run} onStop={() => {}} onView={() => {}} />)
    expect(html).toMatch(/0 \/ 2/)
    expect(html).toContain('Keep this tab open')
  })
  it('shows a view-on-board affordance for a landed cell', () => {
    const run = initSweepRun(e.runs)
    run.cells[0]!.status = 'done'
    run.cells[0]!.record = { group_id: 'g1', run_id: run.cells[0]!.runId, status: { complete: true } } as any
    const html = renderToStaticMarkup(<SweepProgress run={run} onStop={() => {}} onView={() => {}} />)
    expect(html).toMatch(/view on board/i)
  })
  it('summarizes on completion', () => {
    const run = initSweepRun(e.runs)
    run.cells.forEach((c) => (c.status = 'done'))
    const html = renderToStaticMarkup(<SweepProgress run={run} onStop={() => {}} onView={() => {}} />)
    expect(html).toMatch(/2 \/ 2/)
    expect(html).not.toContain('Keep this tab open')
  })
  it('settles to the stopped summary when stopped with cells still queued', () => {
    // After Stop, the pool returns without firing the queued cells, so they stay queued and
    // none are running. The panel must still settle: no Stop button, no tab-open hint, and the
    // stopped summary shown. (Before the fix, inFlight stayed true and this branch was dead.)
    const run = initSweepRun(e.runs)
    run.stopped = true
    run.cells.forEach((c) => (c.status = 'queued'))
    const html = renderToStaticMarkup(<SweepProgress run={run} onStop={() => {}} onView={() => {}} />)
    expect(html).not.toContain('Keep this tab open')
    expect(html).not.toContain('stopbtn') // the Stop button's class, present only while in flight
    expect(html).toContain('Stopped after')
  })
})
