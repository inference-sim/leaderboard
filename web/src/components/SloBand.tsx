import type { MouseEvent } from 'react'
import type { RunRecord } from '../load'
import { runKey } from '../load'
import { distinctModels, knobChips, varyingDeploymentFields } from '../model'
import { missText, sloMisses } from '../slo'
import type { SloTargets } from '../slo'
import { Knob } from './Knob'

/**
 * The runs a set SLO target pulled out of the ranking, shown rather than hidden. A separate
 * exclusion from the disqualified rows in the table: these runs completed the
 * work and are comparable, they simply missed a latency ceiling the reader set at read
 * time, so clearing the target restores them to the table. Collapsed by default to a count
 * and a Show control (a native details/summary); expanded, each run names the target(s) it
 * missed and by how much. Renders nothing when no run is hidden.
 *
 * In compare mode these runs are part of the selection like every other visible row (Select all
 * includes them, and the Compare panel shows them), so each one is clickable to toggle its
 * highlight and carries `cmphl` when selected.
 */
export function SloBand({
  hidden,
  targets,
  compareMode = false,
  selectedIds = [],
  onToggleHighlight,
}: {
  hidden: RunRecord[]
  targets: SloTargets
  compareMode?: boolean
  selectedIds?: string[]
  onToggleHighlight?: (runId: string) => void
}) {
  if (hidden.length === 0) return null

  // The differentiators among the hidden runs, so a row reads like its table
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
        table. Any disqualified runs in the table above are a separate exclusion.
      </p>
      {hidden.map((record) => {
        const misses = sloMisses(record, targets)
        const chips = knobChips(record, varying)
        const key = runKey(record)
        const highlighted = selectedIds.includes(key)
        const selectable = compareMode && onToggleHighlight != null
        return (
          <article
            key={key}
            className={`slohidden${selectable ? ' selectable' : ''}${highlighted ? ' cmphl' : ''}`}
            {...(selectable
              ? {
                  role: 'button' as const,
                  'aria-pressed': highlighted,
                  onClick: (e: MouseEvent<HTMLElement>) => {
                    if ((e.target as HTMLElement).closest('button, a')) return
                    const sel = typeof window !== 'undefined' ? window.getSelection() : null
                    if (sel && !sel.isCollapsed) return
                    onToggleHighlight!(key)
                  },
                }
              : {})}
          >
            <div className="dqtop">
              {showModel && <span className="model">{record.deployment.model}</span>}
              <span className="nm">
                {record.deployment.hardware} tp{record.deployment.tp}
              </span>
              {chips.map((chip) => (
                <Knob key={chip.label} chip={chip} />
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
