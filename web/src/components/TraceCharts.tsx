import { useEffect, useState } from 'react'
import { fetchTraceStats, type TraceHistogram, type TraceStats, type TraceTimeline } from '../workloads'
import { formatNumber } from '../format'

/**
 * The distribution charts for a stored trace, shown in the Saved-workloads detail panel: what
 * a weka trace actually contains — prompt/output token sizes, turns per session, arrival
 * burstiness, and think time between turns. The server reads the trace's data.csv and returns
 * pre-binned histograms (a real corpus is tens of thousands of records), so these components
 * only draw bars.
 *
 * `TraceCharts` fetches on mount (the panel mounts only when a trace card is opened) and needs
 * the run server; `TraceChartsView` is the pure renderer, split out so the charts can be tested
 * from a fixture without a server or an event loop.
 */
export function TraceCharts({ sha256 }: { sha256: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; stats: TraceStats }
  >({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    fetchTraceStats(sha256)
      .then((stats) => live && setState({ status: 'ready', stats }))
      .catch((e) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [sha256])

  if (state.status === 'loading') return <p className="dek">Reading the trace.</p>
  if (state.status === 'error') {
    return (
      <p className="dek issue">
        {state.message} The charts need the run server:{' '}
        <code>make build &amp;&amp; ./bin/leaderboard serve</code>.
      </p>
    )
  }
  return <TraceChartsView stats={state.stats} />
}

/** The five trace distributions, pure so a fixture renders them without a fetch. */
export function TraceChartsView({ stats }: { stats: TraceStats }) {
  return (
    <div className="tc-grid">
      <HistogramChart title="Prompt tokens" hist={stats.input_tokens} unit="tokens" />
      <HistogramChart title="Output tokens" hist={stats.output_tokens} unit="tokens" />
      <HistogramChart title="Turns per session" hist={stats.turns_per_session} unit="turns" />
      <HistogramChart title="Think time" hist={stats.think_time_ms} unit="ms" />
      <TimelineChart title="Arrivals over time" timeline={stats.arrival_timeline} />
    </div>
  )
}

const CHART_W = 320
const CHART_H = 96

/** A compact bar chart of a pre-binned distribution, with min/max axis labels and a summary
 * line. An empty distribution (the column was absent) says so rather than drawing nothing. */
function HistogramChart({ title, hist, unit }: { title: string; hist: TraceHistogram; unit: string }) {
  if (hist.count === 0 || hist.bins.length === 0) {
    return (
      <figure className="tc">
        <figcaption className="tc-title">{title}</figcaption>
        <p className="tc-empty dek">No data in this trace.</p>
      </figure>
    )
  }
  const maxCount = Math.max(...hist.bins.map((b) => b.count), 1)
  const bw = CHART_W / hist.bins.length
  const label = `${title}: ${hist.count} values from ${num(hist.min)} to ${num(hist.max)} ${unit}`
  return (
    <figure className="tc">
      <figcaption className="tc-title">{title}</figcaption>
      <svg className="tc-svg" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {hist.bins.map((b, i) => {
          const h = (b.count / maxCount) * CHART_H
          return <rect key={i} className="tc-bar" x={i * bw} y={CHART_H - h} width={Math.max(bw - 1, 0.5)} height={h} />
        })}
      </svg>
      <div className="tc-axis mono">
        <span>{num(hist.min)}</span>
        <span>
          {num(hist.max)} {unit}
        </span>
      </div>
      <p className="tc-stats mono">
        mean {num(hist.mean)} · p50 {num(hist.p50)} · p95 {num(hist.p95)} · n={hist.count}
      </p>
    </figure>
  )
}

/** Request arrivals over wall-clock time, as bars per time slice. The x-axis is milliseconds
 * from the first arrival; the span label states the whole recorded window. */
function TimelineChart({ title, timeline }: { title: string; timeline: TraceTimeline }) {
  if (timeline.count === 0 || timeline.buckets.length === 0) {
    return (
      <figure className="tc">
        <figcaption className="tc-title">{title}</figcaption>
        <p className="tc-empty dek">No arrivals recorded.</p>
      </figure>
    )
  }
  const maxCount = Math.max(...timeline.buckets.map((b) => b.count), 1)
  const bw = CHART_W / timeline.buckets.length
  const span = humanMs(timeline.span_ms)
  const label = `${title}: ${timeline.count} arrivals over ${span}`
  return (
    <figure className="tc">
      <figcaption className="tc-title">{title}</figcaption>
      <svg className="tc-svg" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {timeline.buckets.map((b, i) => {
          const h = (b.count / maxCount) * CHART_H
          return <rect key={i} className="tc-bar" x={i * bw} y={CHART_H - h} width={Math.max(bw - 1, 0.5)} height={h} />
        })}
      </svg>
      <div className="tc-axis mono">
        <span>0</span>
        <span>{span}</span>
      </div>
      <p className="tc-stats mono">{timeline.count} arrivals</p>
    </figure>
  )
}

/** A whole number for counts, one decimal for fractional stats (mean/percentiles). */
function num(v: number): string {
  return Number.isInteger(v) ? formatNumber(v, 0) : formatNumber(v, 1)
}

/** A readable duration from milliseconds: ms, seconds, or minutes as the span grows. */
function humanMs(ms: number): string {
  if (ms < 1000) return `${num(ms)} ms`
  if (ms < 60000) return `${formatNumber(ms / 1000, 1)} s`
  return `${formatNumber(ms / 60000, 1)} min`
}
