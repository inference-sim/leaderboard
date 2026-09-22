import type { RunRecord } from '../load'
import { distinctModels, knobChips, varyingDeploymentFields } from '../model'
import { missText, sloMisses } from '../slo'
import type { SloTargets } from '../slo'

/**
 * The runs a set SLO target pulled out of the ranking, shown rather than hidden. A sibling
 * of DqBand in structure and styling, but a separate exclusion: these runs completed the
 * work and are comparable, they simply missed a latency ceiling the reader set at read
 * time, so clearing the target restores them to the table. Collapsed by default to a count
 * and a Show control (a native details/summary); expanded, each run names the target(s) it
 * missed and by how much. Renders nothing when no run is hidden.
 */
export function SloBand({ hidden, targets }: { hidden: RunRecord[]; targets: SloTargets }) {
  if (hidden.length === 0) return null

  // The differentiators among the hidden runs, so a row reads like its DqBand and table
  // counterparts. hardware and tp lead every row regardless; the knobs fill in the rest.
  const varying = varyingDeploymentFields(hidden)
  const showModel = distinctModels(hidden).length > 1

  return (
    <details className="sloband">
      <summary className="slobandsum">
        <span className="slobandhead">
          Hidden by SLO targets · {hidden.length} {hidden.length === 1 ? 'run' : 'runs'}
        </span>
      </summary>
      <p className="slobandintro">
        These runs met the model and hardware filters but missed a latency target you set. They
        are pulled out of the ranking, not dropped: clear the target and they return to the
        table. The disqualified band below is a separate exclusion.
      </p>
      {hidden.map((record) => {
        const misses = sloMisses(record, targets)
        const chips = knobChips(record, varying)
        return (
          <article key={record.run_id} className="slohidden">
            <div className="dqtop">
              {showModel && <span className="model">{record.deployment.model}</span>}
              <span className="nm">
                {record.deployment.hardware} tp{record.deployment.tp}
              </span>
              {chips.map((chip) => (
                <span key={chip.label} className={chip.extra ? 'knob extra' : 'knob'}>
                  {chip.label}
                </span>
              ))}
            </div>
            <ul className="slomisses">
              {misses.map((m) => (
                <li key={m.key}>{missText(m)}</li>
              ))}
            </ul>
          </article>
        )
      })}
    </details>
  )
}
