import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SloFilter } from './components/SloFilter'
import { SLO_METRICS, emptyTargets } from './slo'

describe('SloFilter', () => {
  it('is a fieldset with a border-dissecting legend title, like the sibling filter cards', () => {
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={emptyTargets()} onChange={() => {}} />,
    )
    expect(html).toMatch(/<fieldset class="slofilter">/)
    expect(html).toMatch(/<legend>/)
    expect(html).not.toContain('class="wrap"')
  })

  it('collapses the editable body by default, with the title as the expand toggle', () => {
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={emptyTargets()} onChange={() => {}} />,
    )
    expect(html).toMatch(/aria-expanded="false"/)
    expect(html).toMatch(/class="slobody"[^>]*hidden=""/)
    // The preview is what shows while collapsed, so it is not hidden.
    expect(html).toMatch(/class="slopreview"(?![^>]*hidden)/)
  })

  it('previews "No targets set" while collapsed with nothing set, and no chips', () => {
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={emptyTargets()} onChange={() => {}} />,
    )
    expect(html).toContain('No targets set')
    expect(html).not.toContain('slochip')
  })

  it('previews the set targets as chips in the sibling tag design, ceiling and floor', () => {
    const targets = { ...emptyTargets(), ttft_p99_ms: '500', tokens_per_sec: '1000', e2e_p99_ms: '0' }
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={targets} onChange={() => {}} />,
    )
    // ttft and tokens/s are valid; e2e '0' is a no-op, so two chips.
    expect((html.match(/class="slochip"/g) ?? []).length).toBe(2)
    expect(html).toContain('TTFT p99 ≤ 500.0ms')
    expect(html).toContain('Tokens/s ≥ 1,000.0')
    expect(html).not.toContain('No targets set')
  })

  it('renders a number input per metric, with a max-ms hint for latency and a min hint for throughput', () => {
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={emptyTargets()} onChange={() => {}} />,
    )
    const inputs = html.match(/<input[^>]*type="number"[^>]*>/g) ?? []
    expect(inputs).toHaveLength(SLO_METRICS.length)
    expect((html.match(/placeholder="max ms"/g) ?? []).length).toBe(5)
    expect((html.match(/placeholder="min \/s"/g) ?? []).length).toBe(2)
    for (const m of SLO_METRICS) expect(html).toContain(m.label)
  })

  it('splits the editable body into a Latency section and a Throughput section', () => {
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={emptyTargets()} onChange={() => {}} />,
    )
    expect(html).toContain('Latency')
    expect(html).toContain('Throughput')
    expect(html.indexOf('Latency')).toBeLessThan(html.indexOf('Throughput'))
  })

  it('binds each input to its current raw value and offers a Clear action', () => {
    const targets = { ...emptyTargets(), tokens_per_sec: '1000' }
    const html = renderToStaticMarkup(
      <SloFilter metrics={SLO_METRICS} targets={targets} onChange={() => {}} />,
    )
    expect(html).toMatch(/value="1000"/)
    expect(html).toContain('Clear')
  })
})
