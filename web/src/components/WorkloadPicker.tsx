import type { WorkloadGroup } from '../load'

interface Props {
  workloads: WorkloadGroup[]
  /** The workloadKey of the selected workload. */
  selected: string
  onSelect: (workloadKey: string) => void
}

/**
 * The page's top level: the workloads, one card each, as a selector (W1) — a gallery of
 * cards. Picking a card shows its results below; the tables are not all stacked on the
 * page at once. A card carries the workload's title and its run counts, not the models —
 * which model to narrow to is a decision made inside the table, via the section's
 * ModelFilter. The disqualified count is shown in its own critical tone rather than folded
 * into the ranked count: an excluded run is surfaced here, never hidden.
 */
export function WorkloadPicker({ workloads, selected, onSelect }: Props) {
  return (
    <nav className="wpick" aria-label="Workloads">
      <ul className="wgallery">
        {workloads.map((workload) => {
          const isCurrent = workload.workloadKey === selected
          const dq = workload.disqualified.length
          return (
            <li key={workload.workloadKey}>
              <button
                type="button"
                className={isCurrent ? 'wpick-card cur' : 'wpick-card'}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => onSelect(workload.workloadKey)}
              >
                <span className="wtitle">{workload.title}</span>
                {workload.tags.length > 0 && (
                  <span className="wtags">
                    {workload.tags.map((tag) => (
                      <span key={tag} className={`spec-tag tag-${tag}`}>
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
                <span className="gcount">
                  <span className="ranked">{workload.complete.length} ranked</span>
                  {dq > 0 && <span className="dq">{dq} disqualified</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
