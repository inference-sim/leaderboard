import type { FormValues } from '../newrun'
import {
  axisValues,
  groupByConfig,
  guardFor,
} from '../sweep'
import type { SweepAxes, SweepExpansion } from '../sweep'
import { offeredLoad } from '../load'

/**
 * The output aside in sweep mode, before running: a read-only preview of the matrix the
 * current form plus axes expand to. It makes the same claims the board will, up front, so
 * nothing about the sweep is a surprise once it runs:
 *   - how many runs land, as one table (count x configs x load levels),
 *   - which combinations were dropped and why,
 *   - which axes vary and the values each takes,
 *   - the per-config breakdown (one run id, its load levels adjacent),
 *   - the single join-or-new verdict for the whole sweep, and
 *   - the guardrail note from the run count.
 * The verdict is shown once for the sweep (every cell shares one workload, so one table),
 * not per cell. Reuses the single-mode aside's .nrout/.verdict/.runbtn classes.
 */
export function SweepPreview({
  expansion,
  base,
  axes,
  onRun,
  running,
}: {
  expansion: SweepExpansion
  base: FormValues
  axes: SweepAxes
  onRun: () => void
  running: boolean
}) {
  const guard = guardFor(expansion.runs.length)
  const byConfig = groupByConfig(expansion.runs)

  return (
    <aside className="nrout">
      <div className="verdict" aria-live="polite">
        <h3>Sweep preview</h3>
        <p className="sweepcount">
          {expansion.runs.length} runs in one table - {expansion.configCount} configs x{' '}
          {expansion.loadCount} load levels
        </p>

        {expansion.dropped.length > 0 && (
          <details className="sweepdropped">
            <summary>{expansion.dropped.length} combinations dropped</summary>
            <ul>
              {expansion.dropped.map((combo) => (
                <li key={combo.label}>
                  <span className="droppedlabel">{combo.label}</span>
                  <ul>
                    {combo.issues.map((issue) => (
                      <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="sweepaxes">
        <h3>Axes</h3>
        {expansion.variedDeploymentKeys.length === 0 && expansion.loadValues.length <= 1 ? (
          <p className="nrnote">No axis varies yet - add values to sweep.</p>
        ) : (
          <ul>
            {expansion.variedDeploymentKeys.map((key) => (
              <li key={key}>
                <span className="axiskey">{key}</span>:{' '}
                {axisValues(key, base, axes).join(', ')}
              </li>
            ))}
            {expansion.loadValues.length > 1 && (
              <li key="__load">
                <span className="axiskey">Load</span>: {expansion.loadValues.join(', ')}
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="sweepbreak">
        <h3>Configs</h3>
        <ul>
          {byConfig.map((cfg) => (
            <li key={cfg.configKey}>
              <code>{cfg.runId}</code>
              <span className="cfgloads">
                {cfg.cells.map((cell) => (
                  <span
                    key={`${cell.output.runId}-${offeredLoad(cell.output.group).value}`}
                    className="cfgload"
                  >
                    {offeredLoad(cell.output.group).value}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className={expansion.joins ? 'verdict joins' : 'verdict new'}>
        {expansion.joins ? (
          <>
            <h3>Joins an existing table</h3>
            <p>
              Same work as <code>{expansion.joins.groupId}</code>, which holds{' '}
              {expansion.joins.records.length} runs. These cells add to{' '}
              <span className="nrtitle">{expansion.joins.title}</span>.
            </p>
          </>
        ) : (
          <>
            <h3>Starts a new table</h3>
            <p>
              No stored group offers this work, so the sweep opens its own table. Every cell
              shares this workload, so they rank together.
            </p>
          </>
        )}
      </div>

      {guard === 'warn' && (
        <p className="guard-warn">
          {expansion.runs.length} runs is a lot to run at once. Consider narrowing an axis.
        </p>
      )}
      {guard === 'block' && (
        <p className="guard-block" role="alert">
          {expansion.runs.length} runs is above 100. Narrow an axis before running.
        </p>
      )}

      <div className="nrrun">
        <button
          type="button"
          className="runbtn"
          onClick={onRun}
          disabled={running || guard === 'block' || expansion.runs.length === 0}
        >
          {running ? 'Running blis…' : `Run ${expansion.runs.length} runs`}
        </button>
        <span className="nrrunhint">
          Each cell runs on the server, then lands in the board as its own row.
        </span>
      </div>
    </aside>
  )
}
