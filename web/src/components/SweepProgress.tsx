import type { CellStatus, SweepRun, SweepRunCell } from '../sweep'
import { countsOf } from '../sweep'
import { offeredLoad } from '../load'

/**
 * The output aside once a sweep is running, and after it finishes. It replaces the preview
 * and reports progress against the same matrix the preview promised:
 *   - a done / total bar from countsOf, with ok / disqualified / failed counts beside it,
 *   - the cells grouped by configuration (one config, its load levels adjacent), each a
 *     status chip plus a view-on-board control once the cell has a record,
 *   - a Stop button and a keep-this-tab-open line, both only while cells are in flight,
 *   - a summary line once every cell is terminal.
 * Reuses the single-mode aside's .nrout class so it sits where the preview did.
 */

const STATUS_LABEL: Record<CellStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'ok',
  disqualified: 'disqualified',
  failed: 'failed',
}

interface ConfigRow {
  configKey: string
  runId: string
  cells: SweepRunCell[]
}

/** Group the run cells by configKey in first-seen order, load levels adjacent. sweep.ts
 *  groupByConfig takes SweepCell[]; this one carries the live SweepRunCell status. */
function groupCells(cells: SweepRunCell[]): ConfigRow[] {
  const order: string[] = []
  const map = new Map<string, SweepRunCell[]>()
  for (const cell of cells) {
    const bucket = map.get(cell.configKey)
    if (bucket) bucket.push(cell)
    else {
      map.set(cell.configKey, [cell])
      order.push(cell.configKey)
    }
  }
  return order.map((key) => {
    const group = map.get(key)!
    return { configKey: key, runId: group[0]!.runId, cells: group }
  })
}

export function SweepProgress({
  run,
  onStop,
  onView,
  onReset,
}: {
  run: SweepRun
  onStop: () => void
  onView: (groupId: string, runId: string) => void
  onReset: () => void
}) {
  const counts = countsOf(run)
  // Once stopped, the pool returns without draining the still-queued cells, so they stay
  // queued forever. Gate inFlight on !stopped so the Stop button and tab-open hint drop and
  // the stopped summary renders; in-flight running cells still finish and update normally.
  const inFlight = !run.stopped && (counts.queued > 0 || counts.running > 0)
  const pct = counts.total > 0 ? Math.round((counts.done + counts.disqualified + counts.failed) / counts.total * 100) : 0
  const landed = counts.done + counts.disqualified + counts.failed
  const rows = groupCells(run.cells)

  return (
    <aside className="nrout">
      <div className="verdict">
        <h3>{inFlight ? 'Running sweep' : run.stopped ? 'Sweep stopped' : 'Sweep complete'}</h3>
        <p className="sweepcount">
          {landed} / {counts.total} runs
        </p>
        <div className="sweepbar" aria-hidden="true">
          <span className="sweepbarfill" style={{ width: `${pct}%` }} />
        </div>
        <p className="sweeptally">
          {counts.done} ok, {counts.disqualified} disqualified, {counts.failed} failed
        </p>
      </div>

      <div className="sweepbreak">
        <h3>Cells</h3>
        <ul>
          {rows.map((row) => (
            <li key={row.configKey}>
              <code>{row.runId}</code>
              <span className="sweepcells">
                {row.cells.map((cell) => (
                  <span
                    key={`${cell.runId}-${offeredLoad(cell.output.group).value}`}
                    className="sweepcell"
                  >
                    <span className="cellload">{offeredLoad(cell.output.group).value}</span>
                    <span className={`statuschip ${cell.status}`}>{STATUS_LABEL[cell.status]}</span>
                    {cell.record && (
                      <button
                        type="button"
                        className="viewboard"
                        onClick={() => onView(cell.record!.group_id, cell.record!.run_id)}
                      >
                        view on board
                      </button>
                    )}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {inFlight ? (
        <div className="nrrun">
          <button type="button" className="runbtn stopbtn" onClick={onStop}>
            Stop
          </button>
          <span className="nrrunhint">Keep this tab open to finish the sweep.</span>
        </div>
      ) : (
        <div className="verdict">
          <p>
            {run.stopped
              ? `Stopped after ${landed} of ${counts.total} runs. The runs that landed are on the board.`
              : `All ${counts.total} runs landed on the board: ${counts.done} ranked, ${counts.disqualified} disqualified, ${counts.failed} failed.`}
          </p>
          <div className="nrrun">
            <button type="button" className="runbtn" onClick={onReset}>
              New sweep
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
