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

describe('ComparePanel (cards)', () => {
  it('prompts to highlight more when fewer than two runs are selected', () => {
    const html = renderToStaticMarkup(<ComparePanel records={[twoRuns()[0]!]} onRemove={() => {}} />)
    expect(html).toMatch(/Highlight at least two runs/i)
  })

  it('renders one draggable card per run, the first tagged Control', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect((html.match(/<article/g) ?? []).length).toBe(2)
    expect(html).toContain('cmptag ctrl')
    expect(html).toContain('Control')
    expect(html).toMatch(/draggable="true"/)
    expect(html).not.toContain('class="wrap"')
  })

  it('groups each card into Configuration and Performance, and omits Simulation model', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toContain('Configuration')
    expect(html).toContain('Performance')
    expect(html).not.toContain('Simulation model')
  })

  it('hides identical config fields by default and shows a varying one', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/Hide identical fields/i)
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
    // max_num_seqs differs -> shown, and the non-control card highlights its changed value;
    // scheduler is identical everywhere -> hidden.
    expect(html).toContain('max_num_seqs')
    expect(html).toMatch(/class="chg"/)
    expect(html).not.toContain('scheduler')
  })

  it('shows a green/red delta chip on a non-control latency metric', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    // bbb's E2E p99 is 2x aaa's -> a "bad" chip with +100%.
    expect(html).toMatch(/cmpchip bad/)
    expect(html).toMatch(/\+100(\.0)?%/)
    // the control card's latency metric shows a plain baseline chip, not a delta.
    expect(html).toContain('baseline')
  })

  it('renders every card when many runs are selected at once (select-all)', () => {
    // Regression: selecting all runs re-renders the panel with more records than its column
    // order yet holds; the order must reconcile in-render so no metric cell is undefined.
    const [a, b] = twoRuns()
    const c = JSON.parse(JSON.stringify(a)) as RunRecord
    c.run_id = 'ccc'
    c.metrics = { ...c.metrics, tokens_per_sec: a!.metrics.tokens_per_sec * 1.5 }
    const html = renderToStaticMarkup(<ComparePanel records={[a!, b!, c]} onRemove={() => {}} />)
    expect((html.match(/<article/g) ?? []).length).toBe(3)
    expect(html).toContain('ccc')
  })

  it('gives every card a remove control', () => {
    const html = renderToStaticMarkup(<ComparePanel records={twoRuns()} onRemove={() => {}} />)
    expect(html).toMatch(/aria-label="Remove aaa from the comparison"/)
    expect(html).toMatch(/aria-label="Remove bbb from the comparison"/)
  })

  it('marks a disqualified run with a subset tag and neutral subset chips, never green/red', () => {
    const [a, b] = twoRuns()
    const dq = JSON.parse(JSON.stringify(b)) as RunRecord
    dq.run_id = 'dq'
    dq.metrics = { ...dq.metrics, e2e_p99_ms: a!.metrics.e2e_p99_ms / 2 } // "faster"
    dq.status = {
      ...dq.status,
      complete: false,
      disqualifications: [{ code: 'requests_dropped', class: 'altered', detail: 'dropped' }],
    }
    const html = renderToStaticMarkup(<ComparePanel records={[a!, dq]} onRemove={() => {}} />)
    expect(html).toMatch(/⚠ subset/)
    expect(html).toMatch(/cmpchip sub/)
    // its faster latency must not read as a clean win
    expect(html).not.toMatch(/cmpchip good/)
  })
})
