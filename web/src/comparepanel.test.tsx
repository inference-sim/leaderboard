import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { ComparePanel } from './components/ComparePanel'

const records = fixture as unknown as RunRecord[]

function twoRuns(): RunRecord[] {
  const complete = records.filter((r) => r.status.complete)
  const a = JSON.parse(JSON.stringify(complete[0])) as RunRecord
  const b = JSON.parse(JSON.stringify(complete[0])) as RunRecord
  a.run_id = 'aaa'
  b.run_id = 'bbb'
  b.deployment.max_num_seqs = a.deployment.max_num_seqs + 8
  b.metrics = { ...b.metrics, e2e_p99_ms: a.metrics.e2e_p99_ms * 2 }
  return [a, b]
}

describe('ComparePanel', () => {
  it('prompts to highlight more when fewer than two runs are selected', () => {
    const html = renderToStaticMarkup(<ComparePanel records={[twoRuns()[0]!]} onRemove={() => {}} />)
    expect(html).toMatch(/Highlight at least two runs/i)
  })

  it('labels the leftmost run column Control and renders inside a horizontal scroller', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toContain('class="tscroll"')
    expect(html).toContain('Control')
    // never reuse the global page container class as a panel class
    expect(html).not.toContain('class="wrap"')
  })

  it('tints a varying config field and hides identical fields by default', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    // max_num_seqs differs -> its row carries the varying class
    expect(html).toMatch(/cfgvary/)
    expect(html).toContain('max_num_seqs')
    // scheduler is identical -> its row head is hidden by default (identical toggle off)
    expect(html).not.toMatch(/<th[^>]*class="cmprowhead"[^>]*>scheduler</)
    // the toggle to reveal identical fields is present
    expect(html).toMatch(/Show identical fields/i)
  })

  it('shows a signed delta on the non-control metric cell', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/\+100(\.0)?%/)
    expect(html).toMatch(/delta-bad/) // higher latency, worse
  })

  it('gives every run column a remove control and keyboard move controls', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/aria-label="Remove aaa from the comparison"/)
    expect(html).toMatch(/aria-label="Move aaa left"/)
    expect(html).toMatch(/aria-label="Move aaa right"/)
    expect(html).toMatch(/draggable="true"/)
  })

  it('names a disqualified control baseline as covering a subset', () => {
    const [a, b] = twoRuns()
    const dq = JSON.parse(JSON.stringify(a)) as RunRecord
    dq.run_id = 'dq'
    dq.status = {
      ...dq.status,
      complete: false,
      disqualifications: [{ code: 'requests_dropped', class: 'altered', detail: 'dropped' }],
    }
    const html = renderToStaticMarkup(<ComparePanel records={[dq, b!]} onRemove={() => {}} />)
    expect(html).toMatch(/subset/i)
    expect(html).toMatch(/served/i)
  })
})
