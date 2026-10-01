import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TraceChartsView } from './components/TraceCharts'
import type { TraceHistogram, TraceStats } from './workloads'

function hist(count: number): TraceHistogram {
  return {
    bins: [
      { lo: 0, hi: 128, count: Math.ceil(count / 2) },
      { lo: 128, hi: 256, count: Math.floor(count / 2) },
    ],
    min: 2,
    max: 250,
    mean: 120,
    p50: 110,
    p95: 240,
    count,
  }
}

const empty: TraceHistogram = { bins: [], min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 0 }

const stats: TraceStats = {
  records: 26,
  sessions: 4,
  input_tokens: hist(26),
  output_tokens: hist(26),
  turns_per_session: hist(4),
  think_time_ms: empty, // exercises the "no data" branch
  arrival_timeline: { buckets: [{ t_ms: 0, count: 20 }, { t_ms: 50, count: 6 }], span_ms: 100, count: 26 },
}

describe('TraceChartsView', () => {
  const html = renderToStaticMarkup(<TraceChartsView stats={stats} />)

  it('renders all five distributions by title', () => {
    for (const t of ['Prompt tokens', 'Output tokens', 'Turns per session', 'Think time', 'Arrivals over time']) {
      expect(html, `missing ${t}`).toContain(t)
    }
  })

  it('draws bars for a populated distribution', () => {
    expect(html).toContain('tc-bar')
  })

  it('shows a no-data note for an empty distribution (think time here)', () => {
    expect(html).toContain('No data in this trace')
  })

  it('labels the arrival timeline with its span', () => {
    expect(html).toContain('100 ms')
    expect(html).toContain('26 arrivals')
  })

  it('summarizes a histogram with mean and percentiles', () => {
    expect(html).toContain('p95')
    expect(html).toContain('n=26')
  })
})
