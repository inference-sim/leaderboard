import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadGroups } from './load'
import type { RunRecord } from './load'
import { SloBand } from './components/SloBand'
import { splitBySlo } from './slo'

const main = loadGroups(fixture as unknown as RunRecord[]).find((g) => g.groupId === '5063e40dceb2')!

describe('SloBand', () => {
  it('renders nothing when no run is hidden', () => {
    expect(renderToStaticMarkup(<SloBand hidden={[]} targets={{ e2e_p99_ms: 5000 }} />)).toBe('')
  })

  it('is a details element collapsed by default, with the count in its summary', () => {
    const { hidden } = splitBySlo(main.complete, { e2e_p99_ms: 5000 })
    const html = renderToStaticMarkup(<SloBand hidden={hidden} targets={{ e2e_p99_ms: 5000 }} />)
    expect(html).toMatch(/<details class="sloband">/)
    expect(html).not.toMatch(/<details[^>]*open/)
    // e2e p99 <= 5000 keeps only h100-tp4 and a100-tp4, so eight are hidden.
    expect(hidden).toHaveLength(8)
    expect(html).toContain('8 runs')
  })

  it('lists each hidden run by deployment identity and names the target it missed, with the delta', () => {
    const { hidden } = splitBySlo(main.complete, { e2e_p99_ms: 5000 })
    const html = renderToStaticMarkup(<SloBand hidden={hidden} targets={{ e2e_p99_ms: 5000 }} />)
    // h100-tp1's E2E p99 is 9749.6 ms; the target rendered as 5.00s.
    expect(html).toContain('H100 tp1')
    expect(html).toContain('E2E p99')
    expect(html).toContain('9.75s')
    expect(html).toContain('5.00s')
    expect(html).toContain('exceeds')
  })

  it('lists only the missed metric, not the ones the run satisfies', () => {
    // h100-tp1 misses E2E p99 <= 5000 but comfortably passes TTFT p99 <= 500.
    const { hidden } = splitBySlo(main.complete, { ttft_p99_ms: 500, e2e_p99_ms: 5000 })
    const only = hidden.filter((r) => r.run_id === 'h100-tp1')
    const html = renderToStaticMarkup(
      <SloBand hidden={only} targets={{ ttft_p99_ms: 500, e2e_p99_ms: 5000 }} />,
    )
    expect(html).toContain('E2E p99')
    expect(html).not.toContain('TTFT p99')
  })

  it('names a throughput floor a run fell short of, at the column precision', () => {
    // tokens_per_sec >= 1100 hides every run (the fastest is about 1099 tokens/s).
    const { hidden } = splitBySlo(main.complete, { tokens_per_sec: 1100 })
    const only = hidden.filter((r) => r.run_id === 'h100-tp1')
    const html = renderToStaticMarkup(<SloBand hidden={only} targets={{ tokens_per_sec: 1100 }} />)
    expect(html).toContain('Tokens/s')
    expect(html).toContain('falls short of')
    expect(html).toContain('1,100.0')
  })

  it('reports a null metric as a miss with no value rather than an em dash', () => {
    const nulled = JSON.parse(JSON.stringify(main.complete[0]!)) as RunRecord
    ;(nulled.metrics as unknown as Record<string, unknown>).e2e_p99_ms = null
    const html = renderToStaticMarkup(<SloBand hidden={[nulled]} targets={{ e2e_p99_ms: 5000 }} />)
    expect(html).toContain('E2E p99')
    expect(html).toContain('no value')
    expect(html).not.toContain('—')
  })
})
