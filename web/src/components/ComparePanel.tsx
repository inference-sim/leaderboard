import { useState, type CSSProperties, type DragEvent } from 'react'
import type { RunRecord } from '../load'
import { buildConfigRows, buildMetricRows, reconcileOrder, removeColumn, reorder } from '../compare'

interface ComparePanelProps {
  /** The highlighted records, in selection order. Fewer than two shows the prompt. */
  records: RunRecord[]
  /** Remove a run from the comparison (equivalent to un-highlighting its row). */
  onRemove: (runId: string) => void
}

interface ConfigLine {
  label: string
  cells: { runId: string; display: string }[]
}
interface MetricLine {
  label: string
  group: string
  cells: { runId: string; text: string; delta: string | null; cls: 'good' | 'bad' | 'neutral' }[]
}

/** A run's sub-headline: model and hardware. */
function runSub(r: RunRecord): string {
  return `${r.deployment.model} · ${r.deployment.hardware}`
}

/**
 * The docked comparison panel: one card per highlighted run, plus a single left label bar that
 * names each parameter and metric once (no per-card repetition). Cards and the label bar share
 * the same row tracks (subgrid), so a field sits on the same level in every card and reads
 * straight across. The control is the first card, banded in accent; every other card shows a
 * green/red delta chip per metric and softly highlights the config values that differ from the
 * control. Reorder by dragging a card - drop it first to make it the control. Comparison is
 * valid without further check because the caller only passes runs from one workload table.
 */
export function ComparePanel({ records, onRemove }: ComparePanelProps) {
  const [order, setOrder] = useState<string[]>([])
  const [hideIdentical, setHideIdentical] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  if (records.length < 2) {
    return (
      <section className="comparepanel" aria-label="Comparison">
        <p className="cmpprompt">Highlight at least two runs to compare.</p>
      </section>
    )
  }

  const view = reconcileOrder(order, records.map((r) => r.run_id))
  const byId = new Map(records.map((r) => [r.run_id, r]))
  const cols = view.map((id) => byId.get(id)).filter((r): r is RunRecord => r != null)
  const anyDq = cols.some((r) => !r.status.complete)
  const configGroups = buildConfigRows(records, view, !hideIdentical)
  const metricBlocks = buildMetricRows(records, view)

  const configLines: ConfigLine[] = configGroups.flatMap((g) =>
    g.rows.map((row) => ({
      label: row.label,
      cells: row.cells.map((c) => ({ runId: c.runId, display: c.items ? c.items.join(', ') : c.value })),
    })),
  )
  const metricLines: MetricLine[] = metricBlocks.flatMap((b) =>
    b.rows.map((row) => ({
      label: row.label,
      group: b.title,
      cells: row.cells.map((c) => ({ runId: c.runId, text: c.text, delta: c.delta, cls: c.cls })),
    })),
  )
  const noConfig = configLines.length === 0

  // Cards and the label bar are subgrids over these shared rows: header, optional status, the
  // Configuration divider + its fields (or one "identical" row), the Performance divider + its
  // metrics.
  const configRows = noConfig ? 1 : configLines.length
  const rowCount = 1 + (anyDq ? 1 : 0) + 1 + configRows + 1 + metricLines.length

  const endDrag = () => {
    setDragId(null)
    setOverId(null)
  }
  const dragProps = (runId: string, index: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData('text/plain', runId)
      e.dataTransfer.effectAllowed = 'move'
      setDragId(runId)
    },
    onDragEnter: () => setOverId(runId),
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      setOverId(runId)
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      const id = e.dataTransfer.getData('text/plain')
      if (id) setOrder(reorder(view, id, index))
      endDrag()
    },
    onDragEnd: endDrag,
  })

  const gridStyle = {
    '--cmp-rows': rowCount,
    // Fixed label column + fixed-width cards (no 1fr), so a card is the same size whether two
    // or ten are selected and the rail left-aligns rather than stretching across the page.
    gridTemplateColumns: `var(--cmp-gutter) repeat(${cols.length}, var(--cmp-card))`,
  } as CSSProperties

  return (
    <section className="comparepanel" aria-label="Comparison">
      <div className="cmptools">
        <label className="cmpswitch">
          <input
            type="checkbox"
            className="cmpswitch-input"
            checked={hideIdentical}
            onChange={(e) => setHideIdentical(e.target.checked)}
          />
          <span className="cmpswitch-track" aria-hidden="true">
            <span className="cmpswitch-thumb" />
          </span>
          <span className="cmpswitch-label">Hide identical fields</span>
        </label>
      </div>

      <div className="cmpcards" style={gridStyle}>
        {/* Left label bar: names each field and metric once, aligned to the card rows. */}
        <div className="cmpgutter">
          <div className="cmpg head" />
          {anyDq && <div className="cmpg status" />}
          <div className="cmpg sec">Configuration</div>
          {noConfig ? (
            <div className="cmpg label muted">All identical</div>
          ) : (
            configLines.map((l) => (
              <div key={l.label} className="cmpg label">
                {l.label}
              </div>
            ))
          )}
          <div className="cmpg sec perf">Performance</div>
          {metricLines.map((l) => (
            <div key={l.label} className="cmpg label">
              {l.label}
            </div>
          ))}
        </div>

        {/* One card per run. */}
        {cols.map((r, ci) => {
          const isControl = ci === 0
          const isDq = !r.status.complete
          const served = r.metrics.injected_requests
            ? Math.round((r.metrics.completed_requests / r.metrics.injected_requests) * 100)
            : 0
          const cardCls = [
            'cmpcard',
            isControl ? 'ctrl' : '',
            dragId === r.run_id ? 'dragging' : '',
            overId === r.run_id && dragId != null && dragId !== r.run_id ? 'over' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <article key={r.run_id} className={cardCls} {...dragProps(r.run_id, ci)}>
              <div className="cmpchead">
                <span className="cmpgrip" aria-hidden="true" title="Drag to reorder; drop first to make it the control">
                  ⠿
                </span>
                <span className="cmpcname" title={r.run_id}>
                  {r.run_id}
                  <span className="cmpcsub" title={runSub(r)}>
                    {runSub(r)}
                  </span>
                </span>
                {isControl && <span className="cmptag ctrl">Control</span>}
                {isDq && (
                  <span className="cmptag sub" title={r.status.disqualifications.map((d) => d.detail).join(' · ')}>
                    ⚠ subset
                  </span>
                )}
                <button
                  type="button"
                  className="cmpx"
                  aria-label={`Remove ${r.run_id} from the comparison`}
                  onClick={() => {
                    setOrder(removeColumn(view, r.run_id))
                    onRemove(r.run_id)
                  }}
                >
                  ✕
                </button>
              </div>
              {anyDq && (
                <div className="cmpstatus">
                  {isDq && (
                    <span className="cmpreasons">
                      served {served}% · {r.status.disqualifications.map((d) => d.code).join(', ')}
                    </span>
                  )}
                </div>
              )}

              <div className="cmpcarddiv" />
              {noConfig ? (
                <div className="cmpv muted">—</div>
              ) : (
                configLines.map((l) => {
                  const cell = l.cells[ci]!
                  const changed = !isControl && cell.display !== l.cells[0]!.display
                  return (
                    <div key={l.label} className="cmpv">
                      <span className={changed ? 'chg' : undefined}>{cell.display}</span>
                    </div>
                  )
                })
              )}

              <div className="cmpcarddiv perf" />
              {metricLines.map((l) => {
                const cell = l.cells[ci]!
                const chip =
                  l.group === 'health' ? null : isControl ? (
                    <span className="cmpchip base">baseline</span>
                  ) : isDq ? (
                    <span className="cmpchip sub">subset</span>
                  ) : cell.delta ? (
                    <span className={`cmpchip ${cell.cls}`}>{cell.delta}</span>
                  ) : null
                return (
                  <div key={l.label} className="cmpv metric">
                    <span className="mv">{cell.text}</span>
                    {chip}
                  </div>
                )
              })}
            </article>
          )
        })}
      </div>
    </section>
  )
}
