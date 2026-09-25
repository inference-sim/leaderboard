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
    expect(html).toMatch(/class="tscroll cmpscroll"/) // still the horizontal scroller, now bounded
    expect(html).toContain('Control')
    // never reuse the global page container class as a panel class
    expect(html).not.toContain('class="wrap"')
  })

  it('tints a varying config field and hides identical fields by default', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    // max_num_seqs differs -> its row carries the varying class
    expect(html).toMatch(/cfgvary/)
    expect(html).toContain('max_num_seqs')
    // scheduler is identical -> its row head is hidden by default (hide toggle on)
    expect(html).not.toMatch(/<th[^>]*class="cmprowhead"[^>]*>scheduler</)
    // the toggle is "Hide identical fields" and is checked by default
    expect(html).toMatch(/Hide identical fields/i)
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
  })

  it('renders the panel in a bounded, scrollable container', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/cmpscroll/)
  })

  it('separates configuration from performance with labelled super-header bands', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/cmpsuper/)
    expect(html).toContain('Configuration')
    expect(html).toContain('Performance')
  })

  it('omits the Simulation model group', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).not.toContain('Simulation model')
  })

  it('shows a signed delta pill on the non-control metric cell', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/\+100(\.0)?%/)
    expect(html).toMatch(/delta-bad/) // higher latency, worse
  })

  it('marks the whole control column, not just its header', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    // control column cells (config and metric) carry the control-column class
    expect((html.match(/cmpcontrolcol/g) ?? []).length).toBeGreaterThan(1)
  })

  it('gives every run column a remove control and draggable headers, with no move buttons', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/aria-label="Remove aaa from the comparison"/)
    expect(html).toMatch(/draggable="true"/)
    // reordering is drag-only now: no left/right move buttons
    expect(html).not.toMatch(/Move aaa (left|right)/)
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
