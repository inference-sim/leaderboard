import { useEffect, useMemo, useRef, useState, type DragEvent, type DragEventHandler } from 'react'
import type { RunRecord } from '../load'
import { formatMs, formatNumber } from '../format'
import {
  buildPlot,
  defaultState,
  dimOptions,
  logTicks,
  metricOptions,
  niceTicks,
  presets,
  type DimOption,
  type MetricOption,
  type PlotModel,
  type PlotState,
  type Preset,
} from '../compareplot'
import { RunDetailModal } from './RunDetail'

interface ComparePlotProps {
  /** The highlighted runs: the same set the cards above compare. */
  records: RunRecord[]
}

/** SVG viewport and plot margins. Room is left on the right for series end-labels. */
const W = 760,
  H = 440,
  mL = 66,
  mR = 96,
  mT = 20,
  mB = 54
const x0 = mL,
  x1 = W - mR,
  y0 = mT,
  y1 = H - mB,
  iw = x1 - x0,
  ih = y1 - y0

/** A metric value, formatted the way the table formats it: durations in ms/s, everything
 *  else at its fixed precision, with a trailing % for the served share. */
function fmt(v: number | null | undefined, opt: MetricOption): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (opt.unit === 'ms') return formatMs(v)
  const s = formatNumber(v, opt.digits ?? 0)
  return opt.unit === '%' ? `${s}%` : s
}

/** A compact y-axis tick label: no unit (the axis title carries it), thousands folded to k, and
 *  `decimals` fractional digits so a small-valued axis (e.g. preempt rate near 0.0001) shows
 *  distinct numbers rather than a column of "0.0". */
function fmtTick(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return ''
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1000) {
    const k = v / 1000
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
  }
  if (a >= 1) return Number.isInteger(v) ? String(v) : v.toFixed(Math.max(1, decimals))
  return v.toFixed(Math.max(1, decimals))
}

/** Fractional digits needed to show a tick step distinctly (a nice 1/2/5×10^k step). */
function tickDecimals(step: number): number {
  if (!(step > 0)) return 0
  return Math.max(0, Math.min(8, -Math.floor(Math.log10(step))))
}

interface ChartEntry {
  id: number
  state: PlotState
}

/** Drag-to-reorder wiring for one chart: handlers for its grip (the draggable handle) and its
 *  card (the drop target), plus the two visual flags. Supplied by the container only when there
 *  is more than one chart to reorder. */
export interface PlotDnd {
  dragging: boolean
  over: boolean
  grip: { draggable: boolean; onDragStart: DragEventHandler; onDragEnd: DragEventHandler }
  card: { onDragOver: DragEventHandler; onDragLeave: DragEventHandler; onDrop: DragEventHandler }
}

/**
 * The compare-mode plotting area. Holds one or more small-multiple charts over the same
 * highlighted runs so several metrics can be read at once: "Add plot" clones the last chart
 * (change its Y to a different output), charts lay out two to a row, and each is independently
 * configurable. Options (the field lists, the presets) are computed once here and shared.
 */
export function ComparePlot({ records }: ComparePlotProps) {
  const dims = useMemo(() => dimOptions(records), [records])
  const presetList = useMemo(() => presets(records), [records])
  // KV-cache metrics are offered only when the highlighted runs actually report KV data, the
  // same "show KV" condition the table uses — otherwise the Y menu fills with always-empty rows.
  const metrics = useMemo(() => {
    const kvPresent = records.some(
      (r) =>
        r.metrics.cache_hit_rate != null ||
        r.kv_thrashing_rate != null ||
        r.metrics.kv_allocation_failures != null,
    )
    return metricOptions().filter((m) => m.group !== 'kv' || kvPresent)
  }, [records])

  // Open with two plots so a pair of metrics (typically latency and throughput) reads at once.
  const makeInitial = (): ChartEntry[] => {
    const a = defaultState(records)
    const bY = a.y === 'tokens_per_sec' ? 'e2e_p99_ms' : 'tokens_per_sec'
    return [
      { id: 0, state: a },
      { id: 1, state: { ...a, y: bY, log: bY === 'tokens_per_sec' ? false : a.log } },
    ]
  }
  const nextId = useRef(2)
  const [charts, setCharts] = useState<ChartEntry[]>(makeInitial)

  // When the highlighted set changes shape (a dimension starts or stops varying), reset to the
  // two default charts. Keyed on a signature of the dimensions, not the array identity.
  const sig = useMemo(() => dims.map((d) => `${d.key}:${d.varies ? 1 : 0}`).join(','), [dims])
  const prevSig = useRef(sig)
  useEffect(() => {
    if (prevSig.current !== sig) {
      prevSig.current = sig
      nextId.current = 2
      setCharts(makeInitial())
    }
  }, [sig, records])

  const multi = charts.length > 1
  const addChart = () =>
    setCharts((cs) => [...cs, { id: nextId.current++, state: { ...cs[cs.length - 1]!.state } }])
  const updateChart = (id: number, state: PlotState) =>
    setCharts((cs) => cs.map((c) => (c.id === id ? { ...c, state } : c)))
  const removeChart = (id: number) =>
    setCharts((cs) => (cs.length > 1 ? cs.filter((c) => c.id !== id) : cs))

  // The chart shown enlarged, and the run whose details are open, each in a modal. Escape closes
  // the run detail first (it can sit above an enlarged chart), then the enlarged chart.
  const [enlargedId, setEnlargedId] = useState<number | null>(null)
  const [detailRun, setDetailRun] = useState<RunRecord | null>(null)
  const enlarged = charts.find((c) => c.id === enlargedId) ?? null
  useEffect(() => {
    if (!enlarged && !detailRun) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (detailRun) setDetailRun(null)
      else setEnlargedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enlarged, detailRun])

  // Drag one chart's grip onto another chart to reorder; the dragged card fades, the drop
  // target outlines. Moving a chart to a target inserts it at the target's position.
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)
  const reorder = (fromId: number, toId: number) =>
    setCharts((cs) => {
      const from = cs.findIndex((c) => c.id === fromId)
      const to = cs.findIndex((c) => c.id === toId)
      if (from < 0 || to < 0 || from === to) return cs
      const next = [...cs]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      return next
    })
  const dndFor = (id: number): PlotDnd => ({
    dragging: dragId === id,
    over: overId === id && dragId != null && dragId !== id,
    grip: {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        setDragId(id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(id))
      },
      onDragEnd: () => {
        setDragId(null)
        setOverId(null)
      },
    },
    card: {
      onDragOver: (e: DragEvent) => {
        if (dragId != null && dragId !== id) {
          e.preventDefault()
          setOverId(id)
        }
      },
      onDragLeave: () => setOverId((o) => (o === id ? null : o)),
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        if (dragId != null) reorder(dragId, id)
        setDragId(null)
        setOverId(null)
      },
    },
  })

  return (
    <section className="cmpplot" aria-label="Plot">
      <div className="cmpplot-head">
        <h3>Plot</h3>
        <button type="button" className="plot-add" onClick={addChart}>
          + Add plot
        </button>
      </div>

      <div className={`plot-grid${multi ? ' multi' : ''}`}>
        {charts.map((c) => (
          <PlotChart
            key={c.id}
            records={records}
            metrics={metrics}
            dims={dims}
            presetList={presetList}
            state={c.state}
            onChange={(s) => updateChart(c.id, s)}
            onRemove={multi ? () => removeChart(c.id) : undefined}
            onEnlarge={() => setEnlargedId(c.id)}
            onPointClick={setDetailRun}
            dnd={multi ? dndFor(c.id) : undefined}
          />
        ))}
      </div>

      {enlarged && (
        <div className="plot-modal-backdrop" onClick={() => setEnlargedId(null)}>
          <div
            className="plot-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Enlarged plot"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="plot-modal-close" aria-label="Close" onClick={() => setEnlargedId(null)}>
              ×
            </button>
            <PlotChart
              records={records}
              metrics={metrics}
              dims={dims}
              presetList={presetList}
              state={enlarged.state}
              onChange={(s) => updateChart(enlarged.id, s)}
              onPointClick={setDetailRun}
            />
          </div>
        </div>
      )}

      {detailRun && <RunDetailModal record={detailRun} onClose={() => setDetailRun(null)} />}
    </section>
  )
}

export interface PlotChartProps {
  records: RunRecord[]
  metrics: MetricOption[]
  dims: DimOption[]
  /** The context-aware presets, offered per chart as a one-click "view" that sets this chart's
   *  whole shape (X, Y, and Color). */
  presetList: Preset[]
  state: PlotState
  onChange: (s: PlotState) => void
  onRemove?: () => void
  /** Open this chart enlarged in a modal. Absent when the chart is already the modal's content. */
  onEnlarge?: () => void
  /** Open the full detail (config, performance, command) for a clicked point's run. */
  onPointClick?: (r: RunRecord) => void
  /** Drag-to-reorder wiring, present only when there is more than one chart. */
  dnd?: PlotDnd
}

/**
 * One chart: the axis assignment as a sentence of dropdowns (Y vs X, colored by a third
 * dimension), chart-local toggles, the SVG plot, a toggleable legend, and the honesty notes.
 * When shown as a small multiple (`compact`) the Views shortcuts are hidden to save room.
 */
export function PlotChart({ records, metrics, dims, presetList, state, onChange, onRemove, onEnlarge, onPointClick, dnd }: PlotChartProps) {
  const [menuAxis, setMenuAxis] = useState<'x' | 'y' | 'color' | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  const model = buildPlot(records, state)
  const dimByKey = new Map(dims.map((d) => [d.key, d]))

  const xKey = model.xOption.key
  const yKey = model.yOption.key
  const colorKey =
    state.color != null && state.color !== xKey && dimByKey.has(state.color) ? state.color : null

  function assign(axis: 'x' | 'y' | 'color', key: string) {
    const n = { ...state }
    if (n.x === key && axis !== 'x') n.x = null
    if (n.color === key && axis !== 'color') n.color = null
    n[axis] = key
    if (axis === 'x' && n.color === key) n.color = null
    onChange(n)
    if (axis !== 'y') setHidden(new Set())
    setMenuAxis(null)
  }
  function clearAxis(axis: 'x' | 'y' | 'color') {
    if (axis === 'y') return
    onChange({ ...state, [axis]: null })
    setHidden(new Set())
    setMenuAxis(null)
  }
  function toggleSeries(name: string) {
    setHidden((h) => {
      const n = new Set(h)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })
  }

  const axisTerm = (axis: 'x' | 'y' | 'color') => {
    const key = axis === 'x' ? xKey : axis === 'y' ? yKey : colorKey
    const opt = axis === 'y' ? model.yOption : axis === 'x' ? model.xOption : key ? dimByKey.get(key) : null
    const unit = opt && 'unit' in opt && opt.unit ? opt.unit : ''
    const options =
      axis === 'y'
        ? metrics
        : axis === 'x'
          ? [...dims.filter((d) => d.varies && d.kind !== 'structured'), ...metrics]
          : dims.filter((d) => d.varies)
    return (
      <span className="plot-term-wrap">
        <button
          type="button"
          className={`plot-term${opt ? '' : ' add'}`}
          data-axis={axis}
          aria-haspopup="listbox"
          aria-expanded={menuAxis === axis}
          onClick={() => setMenuAxis((m) => (m === axis ? null : axis))}
        >
          <span className="lbl">
            {opt ? opt.label : 'add color'}
            {unit ? <span className="u">({unit})</span> : null}
            {opt && 'derived' in opt && opt.derived ? <span className="u">∗</span> : null}
          </span>
          <span className="caret" aria-hidden="true">▾</span>
        </button>
        {menuAxis === axis && (
          <div className="plot-menu" role="listbox">
            {axis !== 'y' && (
              <button type="button" className="plot-menu-item" onClick={() => clearAxis(axis)}>
                (none)
              </button>
            )}
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                className="plot-menu-item"
                aria-selected={key === o.key}
                onClick={() => assign(axis, o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </span>
    )
  }

  const chart = layout(model, state.log, state.connect, hidden)
  const showLegend = model.series[0]?.name !== 'all'

  return (
    <figure
      className={`plot-figure${dnd?.dragging ? ' dragging' : ''}${dnd?.over ? ' over' : ''}`}
      {...(dnd?.card ?? {})}
    >
      {(onEnlarge || onRemove) && (
        <div className="plot-actions">
          {onEnlarge && (
            <button type="button" className="plot-act" aria-label="Enlarge this plot" onClick={onEnlarge}>
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M16 21h4a1 1 0 0 0 1-1v-4M8 21H4a1 1 0 0 1-1-1v-4" />
              </svg>
            </button>
          )}
          {onRemove && (
            <button type="button" className="plot-act danger" aria-label="Remove this plot" onClick={onRemove}>
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7M10 11v6M14 11v6" />
              </svg>
            </button>
          )}
        </div>
      )}

      {(dnd || presetList.length > 0) && (
        <div className="plot-views">
          {dnd && (
            <span className="plot-grip" title="Drag to reorder" aria-label="Drag to reorder" {...dnd.grip}>
              ⠿
            </span>
          )}
          {presetList.length > 0 && (
            <>
              <span className="plot-views-label">Views</span>
              <div className="plot-views-list">
                {presetList.map((p) => {
                  const on = p.state.x === state.x && p.state.y === state.y && p.state.color === state.color
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="plot-view-btn"
                      aria-pressed={on}
                      onClick={() => {
                        onChange(p.state)
                        setHidden(new Set())
                        setMenuAxis(null)
                      }}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div className="plot-figure-head">
        <div className="plot-readout">
          {axisTerm('y')}
          <span className="op">vs</span>
          {axisTerm('x')}
          <span className="op">·</span>
          {colorKey ? <>color {axisTerm('color')}</> : axisTerm('color')}
        </div>
        <div className="plot-chart-controls">
          {model.xKind === 'numeric' && (
            <label className="plot-toggle">
              <input
                type="checkbox"
                checked={state.connect}
                onChange={(e) => onChange({ ...state, connect: e.target.checked })}
              />{' '}
              connect
            </label>
          )}
          <label className="plot-toggle">
            <input
              type="checkbox"
              checked={state.log}
              onChange={(e) => onChange({ ...state, log: e.target.checked })}
            />{' '}
            log Y
          </label>
        </div>
      </div>

      <div className="plot-svgbox">
        <svg
          className="plotchart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${model.yOption.label} by ${model.xOption.label}`}
        >
          {chart.gridY.map((t, i) => (
            <g key={`gy${i}`}>
              <line x1={x0} y1={t.py} x2={x1} y2={t.py} stroke="var(--plot-grid)" strokeWidth={1} />
              <text className="tick" x={x0 - 9} y={t.py + 4} textAnchor="end" fontSize={12}>
                {t.label}
              </text>
            </g>
          ))}
          <line x1={x0} y1={y0} x2={x0} y2={y1} stroke="var(--plot-axis)" strokeWidth={1} />
          <line x1={x0} y1={y1} x2={x1} y2={y1} stroke="var(--plot-axis)" strokeWidth={1} />
          <text className="axtitle" transform={`translate(13,${(y0 + y1) / 2}) rotate(-90)`} textAnchor="middle" fontSize={13}>
            {model.yOption.label}
            {model.yOption.unit ? ` (${model.yOption.unit})` : ''}
            {model.yOption.derived ? ' ∗' : ''}
          </text>
          {chart.xTicks.map((t, i) => (
            <text key={`xt${i}`} className="tick" x={t.px} y={y1 + 19} textAnchor="middle" fontSize={12}>
              {t.label}
            </text>
          ))}
          <text className="axtitle" x={(x0 + x1) / 2} y={H - 8} textAnchor="middle" fontSize={13}>
            {model.xOption.label}
            {'unit' in model.xOption && model.xOption.unit ? ` (${model.xOption.unit})` : ''}
          </text>

          {chart.segments.map((s, i) => (
            <line
              key={`seg${i}`}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke={`var(${s.colorVar})`}
              strokeWidth={2}
              fill="none"
              {...(s.dashed ? { strokeDasharray: '3 4', opacity: 0.55 } : {})}
            />
          ))}
          {chart.endLabels.map((l, i) => (
            <text key={`el${i}`} className="endlabel" x={l.px + 8} y={l.py + 4} fontSize={12}>
              {l.name}
            </text>
          ))}

          {chart.marks.map((m) => (
            <g
              key={m.i}
              className={`plotmark${m.dq ? ' dq' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`${m.point.run.run_id}, ${model.yOption.label} ${fmt(m.point.y, model.yOption)}${m.dq ? ', subset' : ''}. Click for full detail.`}
              onMouseEnter={() => setHover(m.i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(m.i)}
              onBlur={() => setHover(null)}
              onClick={() => onPointClick?.(m.point.run)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPointClick?.(m.point.run)
                }
              }}
            >
              {m.dq ? (
                <circle cx={m.cx} cy={m.cy} r={6} fill="var(--panel)" stroke={`var(${m.colorVar})`} strokeWidth={2} strokeDasharray="2.6 2.4" />
              ) : (
                <circle cx={m.cx} cy={m.cy} r={5.5} fill={`var(${m.colorVar})`} stroke="var(--panel)" strokeWidth={1.5} />
              )}
            </g>
          ))}
        </svg>

        {hover != null && chart.marks.find((m) => m.i === hover) && (
          <Tooltip mark={chart.marks.find((m) => m.i === hover)!} yOption={model.yOption} />
        )}
      </div>

      {showLegend && (
        <div className="plot-legend">
          {model.series.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`lgd${hidden.has(s.name) ? ' off' : ''}`}
              aria-pressed={!hidden.has(s.name)}
              onClick={() => toggleSeries(s.name)}
            >
              <span className="plot-swatch" style={{ background: `var(${s.colorVar})` }} />
              {s.name}
            </button>
          ))}
        </div>
      )}

      {(model.confounds.length > 0 ||
        model.points.some((p) => p.dq) ||
        model.overflowSeries ||
        model.yOption.derived ||
        model.yOption.caveat) && (
        <figcaption className="plot-notes">
          {model.confounds.length > 0 && (
            <div className="plot-note confound">
              <span className="ic">⚠</span>
              <span>
                <b>{model.confounds.join(', ')}</b> also {model.confounds.length > 1 ? 'vary' : 'varies'} within a
                group here and {model.confounds.length > 1 ? 'are' : 'is'} on no axis, so points can differ for
                reasons this plot does not show. Set one as <b>color</b>, or narrow it in the filters above.
              </span>
            </div>
          )}
          {model.points.some((p) => p.dq) && (
            <div className="plot-note">
              <span className="ic"><span className="plot-ring" /></span>
              <span>
                <b>Subset runs</b> (served below 100%) plot hollow and stay off the solid line: their percentiles
                describe an easier subset of the work.
              </span>
            </div>
          )}
          {model.overflowSeries && (
            <div className="plot-note">
              <span className="ic">i</span>
              <span>More groups than the palette has colors; extra groups share a neutral color. Pick a coarser color dimension.</span>
            </div>
          )}
          {model.yOption.derived && (
            <div className="plot-note">
              <span className="ic">∗</span>
              <span>
                <b>{model.yOption.label}</b> is derived: {model.yOption.derived}
              </span>
            </div>
          )}
          {model.yOption.caveat && (
            <div className="plot-note">
              <span className="ic">i</span>
              <span>{model.yOption.caveat}</span>
            </div>
          )}
        </figcaption>
      )}
    </figure>
  )
}

function Tooltip({ mark, yOption }: { mark: Mark; yOption: MetricOption }) {
  const r = mark.point.run
  const rows: [string, MetricOption][] = metricOptions()
    .filter((m) => ['e2e_p99_ms', 'ttft_p99_ms', 'tokens_per_sec', 'served', 'preemption_count'].includes(m.key))
    .map((m) => [m.key, m])
  return (
    <div
      className="plot-tip on"
      style={{ left: `${(mark.cx / W) * 100}%`, top: `${(mark.cy / H) * 100}%` }}
    >
      <div className="tid">
        <span className="plot-swatch" style={{ background: `var(${mark.colorVar})` }} />
        {r.run_id}
      </div>
      <div className="tsub">
        {r.deployment.model} · {r.deployment.hardware} · tp{r.deployment.tp}
      </div>
      <dl>
        {rows.map(([k, m]) => (
          <div key={k} className="tr">
            <dt>{m.label}</dt>
            <dd className={k === yOption.key ? 'yhot' : ''}>{fmt(m.value(r), m)}</dd>
          </div>
        ))}
      </dl>
      {mark.dq && <div className="subtag">⚠ subset: shed work, ranked apart</div>}
    </div>
  )
}

// ---- pure layout: turn a PlotModel into SVG-space marks, segments, ticks, labels ----
interface Mark {
  i: number
  cx: number
  cy: number
  dq: boolean
  colorVar: string
  point: PlotModel['points'][number]
}
interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
  colorVar: string
  dashed: boolean
}
interface ChartLayout {
  gridY: { v: number; py: number; label: string }[]
  xTicks: { px: number; label: string }[]
  marks: Mark[]
  segments: Segment[]
  endLabels: { px: number; py: number; name: string }[]
}

function layout(model: PlotModel, log: boolean, connect: boolean, hidden: Set<string>): ChartLayout {
  const visible = model.points.filter((p) => !hidden.has(p.series))
  const ys = visible.map((p) => p.y).filter((v): v is number => v != null)
  let ymax = ys.length ? Math.max(...ys) : 1
  const ymin = ys.length ? Math.min(...ys) : 0
  if (ymax === ymin) ymax = ymin + 1

  const useLog = log && ymin > 0
  let gridY: { v: number; py: number; label: string }[]
  let yToPx: (v: number) => number
  if (useLog) {
    const lo = ymin * 0.8,
      hi = ymax * 1.15
    const l0 = Math.log10(lo),
      l1 = Math.log10(hi)
    yToPx = (v) => y1 - ((Math.log10(Math.max(v, lo)) - l0) / (l1 - l0)) * ih
    // log ticks span decades, so each gets enough decimals for its own magnitude
    gridY = logTicks(lo, hi).map((v) => {
      const dec = v > 0 && v < 1 ? Math.max(0, Math.min(8, -Math.floor(Math.log10(v)))) : 0
      return { v, py: yToPx(v), label: fmtTick(v, dec) }
    })
  } else {
    const ticks = niceTicks(ymax * 1.08, 5)
    const top = ticks[ticks.length - 1]! || 1
    const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : top
    const dec = tickDecimals(step)
    yToPx = (v) => y1 - (v / top) * ih
    gridY = ticks.map((v) => ({ v, py: yToPx(v), label: fmtTick(v, dec) }))
  }

  const marks: Mark[] = []
  const segments: Segment[] = []
  const endLabels: { px: number; py: number; name: string }[] = []
  let xTicks: { px: number; label: string }[] = []

  if (model.xKind === 'numeric') {
    // Axis ticks come from every point (stable while series are toggled); the Y scale above
    // came from visible points only, so hiding a series reclaims the space.
    const xs = model.points.map((p) => p.x).filter((v): v is number => typeof v === 'number')
    const isMetricX = 'value' in model.xOption
    const distinct = [...new Set(xs)].sort((a, b) => a - b)
    let xmin: number, xmax: number
    if (isMetricX || distinct.length > 8) {
      xmax = niceTicks(Math.max(...xs, 1), 5).slice(-1)[0]!
      xmin = 0
      xTicks = niceTicks(xmax, 5).map((v) => ({ px: x0 + (v / xmax) * iw, label: String(v) }))
    } else {
      xmin = distinct[0]!
      xmax = distinct[distinct.length - 1]!
      if (xmin === xmax) {
        xmin -= 1
        xmax += 1
      }
      xTicks = distinct.map((v) => ({ px: x0 + ((v - xmin) / (xmax - xmin)) * iw, label: String(v) }))
    }
    const xToPx = (v: number) => x0 + ((v - xmin) / (xmax - xmin || 1)) * iw

    for (const s of model.series) {
      if (hidden.has(s.name)) continue
      const pts = model.points
        .filter((p) => p.series === s.name && typeof p.x === 'number' && p.y != null)
        .sort((a, b) => (a.x as number) - (b.x as number))
      // Only connect a genuine trajectory: one point per X. If a series has two points at the
      // same X (another dimension varies within it — a confound), a line would join unrelated
      // runs, so leave it as scatter. The confound advisory explains why.
      const onePerX = new Set(pts.map((p) => p.x)).size === pts.length
      if (connect && onePerX && pts.length > 1) {
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k]!,
            b = pts[k + 1]!
          segments.push({
            x1: xToPx(a.x as number),
            y1: yToPx(a.y as number),
            x2: xToPx(b.x as number),
            y2: yToPx(b.y as number),
            colorVar: s.colorVar,
            dashed: a.dq || b.dq,
          })
        }
      }
      const lastComplete = [...pts].reverse().find((p) => !p.dq) ?? pts[pts.length - 1]
      if (lastComplete && model.series.length > 1) {
        // Truncate so a long series name (a scorer list, a long model id) can't run past the
        // right edge; the full name is in the legend.
        const name = s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name
        endLabels.push({ px: xToPx(lastComplete.x as number), py: yToPx(lastComplete.y as number), name })
      }
    }

    model.points.forEach((p, i) => {
      if (hidden.has(p.series) || typeof p.x !== 'number' || p.y == null) return
      marks.push({ i, cx: xToPx(p.x), cy: yToPx(p.y), dq: p.dq, colorVar: colorFor(model, p.series), point: p })
    })
  } else {
    const cats = [...new Set(model.points.map((p) => String(p.x)))].sort()
    const band = iw / (cats.length || 1)
    xTicks = cats.map((c, ci) => ({ px: x0 + band * (ci + 0.5), label: c }))
    const nSeries = model.series.length
    model.points.forEach((p, i) => {
      if (hidden.has(p.series) || p.y == null) return
      const ci = cats.indexOf(String(p.x))
      const sIdx = model.series.findIndex((s) => s.name === p.series)
      const jitter = nSeries > 1 ? (sIdx - (nSeries - 1) / 2) * 14 : 0
      marks.push({ i, cx: x0 + band * (ci + 0.5) + jitter, cy: yToPx(p.y), dq: p.dq, colorVar: colorFor(model, p.series), point: p })
    })
  }

  return { gridY, xTicks, marks, segments, endLabels }
}

function colorFor(model: PlotModel, series: string): string {
  return model.series.find((s) => s.name === series)?.colorVar ?? '--accent'
}
