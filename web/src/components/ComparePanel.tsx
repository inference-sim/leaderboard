import { Fragment, useEffect, useState, type DragEvent } from 'react'
import type { RunRecord } from '../load'
import {
  buildConfigRows,
  buildMetricRows,
  moveColumn,
  reconcileOrder,
  removeColumn,
  reorder,
} from '../compare'

interface ComparePanelProps {
  /** The highlighted records, in selection order. Fewer than two shows the prompt. */
  records: RunRecord[]
  /** Remove a run from the comparison (equivalent to un-highlighting its row). */
  onRemove: (runId: string) => void
}

/** A run's short header label: model, hardware and tp, the candidate's headline. */
function runLabel(r: RunRecord): string {
  return `${r.deployment.model} · ${r.deployment.hardware} tp${r.deployment.tp}`
}

/**
 * The docked comparison panel: the highlighted runs transposed into columns, arguments and
 * metrics into rows. The leftmost column is the control and shows raw values; every other
 * column shows a control-relative delta. Column order and the identical-fields toggle are
 * panel-local; order is seeded from selection order and reconciled as the reader highlights or
 * unhighlights rows, so a manual reordering survives a selection change. Comparison is valid
 * without any further check because the caller only ever passes runs from one workload table
 * (one group_id, same work offered).
 */
export function ComparePanel({ records, onRemove }: ComparePanelProps) {
  const [order, setOrder] = useState<string[]>(() => records.map((r) => r.run_id))
  const [showIdentical, setShowIdentical] = useState(false)

  // Fold selection changes into the order, preserving any manual reordering.
  const presentKey = records.map((r) => r.run_id).join(',')
  useEffect(() => {
    setOrder((cur) => reconcileOrder(cur, presentKey ? presentKey.split(',') : []))
  }, [presentKey])

  if (records.length < 2) {
    return (
      <section className="comparepanel" aria-label="Comparison">
        <p className="cmpprompt">Highlight at least two runs to compare.</p>
      </section>
    )
  }

  const byId = new Map(records.map((r) => [r.run_id, r]))
  const cols = order.map((id) => byId.get(id)).filter((r): r is RunRecord => r != null)
  const control = cols[0]!
  const controlDq = !control.status.complete
  const configGroups = buildConfigRows(records, order, showIdentical)
  const metricBlocks = buildMetricRows(records, order)

  const onDrop = (e: DragEvent<HTMLTableCellElement>, toIndex: number) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id) setOrder((cur) => reorder(cur, id, toIndex))
  }

  return (
    <section className="comparepanel" aria-label="Comparison">
      <div className="cmptools">
        <label className="cmptoggle">
          <input type="checkbox" checked={showIdentical} onChange={(e) => setShowIdentical(e.target.checked)} />
          Show identical fields
        </label>
      </div>

      {controlDq && (
        <p className="cmpsubsetnote" role="note">
          The control is disqualified, so the baseline itself covers a subset of the offered work.
        </p>
      )}

      <div className="tscroll">
        <table className="cmptable">
          <thead>
            <tr>
              <th scope="col" className="cmprowhead" />
              {cols.map((r, i) => {
                const dq = !r.status.complete
                return (
                  <th
                    key={r.run_id}
                    scope="col"
                    className={i === 0 ? 'cmpcol cmpcontrol' : 'cmpcol'}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', r.run_id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(e, i)}
                  >
                    <div className="cmphead">
                      <span className="cmpname">{runLabel(r)}</span>
                      {i === 0 && <span className="cmpbadge control">Control</span>}
                      {dq && (
                        <span
                          className="cmpbadge subset"
                          title={r.status.disqualifications.map((d) => d.detail).join(' · ')}
                        >
                          ⚠ subset
                        </span>
                      )}
                      <span className="cmpmove">
                        <button
                          type="button"
                          onClick={() => setOrder((cur) => moveColumn(cur, r.run_id, -1))}
                          disabled={i === 0}
                          aria-label={`Move ${r.run_id} left`}
                        >
                          ◂
                        </button>
                        <button
                          type="button"
                          onClick={() => setOrder((cur) => moveColumn(cur, r.run_id, 1))}
                          disabled={i === cols.length - 1}
                          aria-label={`Move ${r.run_id} right`}
                        >
                          ▸
                        </button>
                        <button
                          type="button"
                          className="cmpremove"
                          onClick={() => {
                            setOrder((cur) => removeColumn(cur, r.run_id))
                            onRemove(r.run_id)
                          }}
                          aria-label={`Remove ${r.run_id} from the comparison`}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    {dq && (
                      <span className="cmpreasons">{r.status.disqualifications.map((d) => d.code).join(', ')}</span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {configGroups.map((grp) => (
              <Fragment key={`cfg-${grp.title}`}>
                <tr className="cmpsection">
                  <th scope="colgroup" colSpan={cols.length + 1}>
                    {grp.title}
                  </th>
                </tr>
                {grp.rows.map((row) => (
                  <tr key={row.field} className={row.varies ? 'cfgvary' : 'cfgsame'}>
                    <th scope="row" className="cmprowhead">
                      {row.label}
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.runId} className="cmpval">
                        {cell.items ? cell.items.join(', ') : cell.value}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}

            {metricBlocks.map((block) => (
              <Fragment key={`m-${block.title}`}>
                <tr className="cmpsection cmpmetrichead">
                  <th scope="colgroup" colSpan={cols.length + 1}>
                    {block.title}
                  </th>
                </tr>
                {block.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="cmprowhead">
                      {row.label}
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.runId} className={`cmpval delta-${cell.cls}`}>
                        <span className="cmpraw">{cell.text}</span>
                        {cell.delta && <span className="cmpdelta">{cell.delta}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
