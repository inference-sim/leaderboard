import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { ComparePlot, PlotChart } from './components/ComparePlot'
import { RunDetailModal } from './components/RunDetail'
import { dimOptions, metricOptions, presets, type PlotState } from './compareplot'

const base = (fixture as unknown as RunRecord[]).find((r) => r.status.complete)!
function run(id: string, hardware: string, load: number, e2e: number, complete = true): RunRecord {
  const r = JSON.parse(JSON.stringify(base)) as RunRecord
  r.run_id = id
  r.deployment.hardware = hardware
  r.group = JSON.parse(JSON.stringify(r.group)) as RunRecord['group']
  r.group.workload.load = { ...r.group.workload.load, value: load }
  r.metrics = { ...r.metrics, e2e_p99_ms: e2e, tokens_per_sec: e2e * 2 }
  r.status = { ...r.status, complete }
  return r
}
function sweep(): RunRecord[] {
  return [run('a6', 'A100', 6, 300), run('a10', 'A100', 10, 900), run('h6', 'H100', 6, 200), run('h10', 'H100', 10, 600)]
}
/** Render a single chart in isolation, decoupled from the container's default chart count. */
function oneChart(rows: RunRecord[], y = 'e2e_p99_ms'): string {
  const state: PlotState = { x: 'load', y, color: 'hardware', connect: true, log: false }
  return renderToStaticMarkup(
    <PlotChart
      records={rows}
      metrics={metricOptions()}
      dims={dimOptions(rows)}
      presetList={presets(rows)}
      state={state}
      onChange={() => {}}
    />,
  )
}
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

describe('ComparePlot container', () => {
  it('renders the axis dropdowns for X, Y, and Color', () => {
    const html = renderToStaticMarkup(<ComparePlot records={sweep()} />)
    expect(html).toContain('Plot')
    expect(html).toMatch(/data-axis="x"/)
    expect(html).toMatch(/data-axis="y"/)
    expect(html).toMatch(/data-axis="color"/)
  })

  it('opens with two plots laid out two to a row', () => {
    const html = renderToStaticMarkup(<ComparePlot records={sweep()} />)
    expect(count(html, /class="plot-figure"/g)).toBe(2)
    expect(html).toMatch(/class="plot-grid multi"/)
  })

  it('offers an Add plot control', () => {
    expect(renderToStaticMarkup(<ComparePlot records={sweep()} />)).toContain('Add plot')
  })

  it('gives each chart a drag handle for reordering when there is more than one', () => {
    const html = renderToStaticMarkup(<ComparePlot records={sweep()} />)
    expect(count(html, /class="plot-grip"/g)).toBe(2)
  })

  it('gives each chart an enlarge control', () => {
    const html = renderToStaticMarkup(<ComparePlot records={sweep()} />)
    expect(count(html, /aria-label="Enlarge this plot"/g)).toBe(2)
  })

  it('gives each plot its own Views presets to get started', () => {
    const html = renderToStaticMarkup(<ComparePlot records={sweep()} />)
    expect(html).toContain('Latency vs load')
    expect(html).toContain('Throughput vs load')
    // two charts, so each sensible preset label appears once per plot
    expect(count(html, /Latency vs load/g)).toBe(2)
  })
})

describe('PlotChart', () => {
  it('draws one marker per highlighted run', () => {
    expect(count(oneChart(sweep()), /class="plotmark/g)).toBe(4)
  })

  it('places every marker inside the plot rectangle with finite coordinates', () => {
    const coords = [...oneChart(sweep()).matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)]
    expect(coords).toHaveLength(4)
    for (const m of coords) {
      const cx = Number(m[1]),
        cy = Number(m[2])
      expect(Number.isFinite(cx) && cx >= 66 && cx <= 664).toBe(true)
      expect(Number.isFinite(cy) && cy >= 20 && cy <= 386).toBe(true)
    }
  })

  it('marks a disqualified run as a subset point', () => {
    const rows = [run('ok', 'A100', 6, 300, true), run('shed', 'A100', 10, 900, false), run('h', 'H100', 6, 200, true)]
    expect(oneChart(rows)).toMatch(/plotmark[^"]*dq/)
  })

  it('connects a clean trajectory but not a confounded series', () => {
    const seg = /stroke="var\(--plot-s/g
    // clean: one point per load within each hardware series -> a connecting line is drawn
    expect(count(oneChart(sweep()), seg)).toBeGreaterThan(0)
    // confounded: color by hardware while model also varies within a load, so a hardware
    // series has two points at the same X -> no line, even with connect on
    const rows = [
      run('a', 'A100', 6, 300),
      run('b', 'A100', 6, 320),
      run('c', 'A100', 10, 900),
      run('d', 'A100', 10, 950),
    ]
    rows[0]!.deployment.model = 'm1'
    rows[1]!.deployment.model = 'm2'
    rows[2]!.deployment.model = 'm1'
    rows[3]!.deployment.model = 'm2'
    const state: PlotState = { x: 'load', y: 'e2e_p99_ms', color: 'hardware', connect: true, log: false }
    const html = renderToStaticMarkup(
      <PlotChart records={rows} metrics={metricOptions()} dims={dimOptions(rows)} presetList={presets(rows)} state={state} onChange={() => {}} />,
    )
    expect(count(html, seg)).toBe(0)
  })

  it('emits enough decimals for a small-valued Y axis instead of a column of 0.0', () => {
    // preemption_rate = preemption_count / completed_requests -> 0.0001, 0.0002, 0.0004
    const mk = (id: string, load: number, preempt: number) => {
      const r = run(id, 'A100', load, 300)
      r.metrics = { ...r.metrics, completed_requests: 100000, preemption_count: preempt }
      return r
    }
    const rows = [mk('a', 4, 10), mk('b', 8, 20), mk('c', 16, 40)]
    const state: PlotState = { x: 'load', y: 'preemption_rate', color: null, connect: true, log: false }
    const html = renderToStaticMarkup(
      <PlotChart records={rows} metrics={metricOptions()} dims={dimOptions(rows)} presetList={presets(rows)} state={state} onChange={() => {}} />,
    )
    const ticks = [...html.matchAll(/class="tick"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(ticks).toContain('0.0001')
    expect(ticks).toContain('0.0004')
    // not every y tick collapsed to the same "0.0"
    expect(ticks.filter((t) => t === '0.0').length).toBeLessThan(2)
  })

  it('renders a toggleable legend entry per color series', () => {
    const html = oneChart(sweep())
    expect(html).toContain('A100')
    expect(html).toContain('H100')
    expect(count(html, /class="lgd/g)).toBe(2)
  })

  it('flags a confounding dimension that sits on no axis', () => {
    const rows = sweep()
    rows[0]!.deployment.max_num_seqs = 16
    const extra = run('a6b', 'A100', 6, 320)
    extra.deployment.max_num_seqs = 64
    rows.push(extra)
    expect(oneChart(rows)).toContain('max_num_seqs')
  })
})

describe('RunDetailModal', () => {
  it('shows the config, performance, and the exact BLIS command for a run', () => {
    const r = run('detail-me', 'H100', 6, 372)
    const html = renderToStaticMarkup(<RunDetailModal record={r} onClose={() => {}} />)
    expect(html).toContain('detail-me')
    expect(html).toContain('Configuration')
    expect(html).toContain('max_num_seqs') // a deployment field
    expect(html).toContain('E2E p99') // a performance metric
    expect(html).toContain('Reproduce') // the command block
    expect(html).toContain('./blis') // the verbatim argv
    expect(html).toContain(r.provenance.cwd) // where to run it
  })
})
