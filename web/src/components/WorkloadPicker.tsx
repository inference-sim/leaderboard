import type { WorkloadGroup } from '../load'
import { loadKindTag } from '../load'
import { CardGallery } from './CardGallery'
// Re-exported so existing importers (and picker.test.tsx) keep reading the paging helpers
// from here, now that the gallery mechanics live in the shared CardGallery.
export { ROWS_PER_PAGE, columnsForWidth, pageCount, clampPage, pageBounds } from './CardGallery'

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
 *
 * The card carries a load-kind tag (rate or concurrency, colour-coded) so the reader can tell
 * at a glance what a workload's offered load is measured in; the specific levels are not on
 * the card (once selected, the section's Load filter lists them, and the spec header carries a
 * single workload's load). A recorded-arrivals trace has no load kind to vary, so it shows no
 * such tag.
 *
 * The gallery mechanics (responsive grid, paging, keeping the selection on screen) live in the
 * shared CardGallery, so the By-sweep list renders the same way with only its card differing.
 */
export function WorkloadPicker({ workloads, selected, onSelect }: Props) {
  const selectedIndex = workloads.findIndex((w) => w.workloadKey === selected)
  return (
    <CardGallery
      items={workloads}
      getKey={(w) => w.workloadKey}
      ariaLabel="Workloads"
      activeIndex={selectedIndex}
      renderCard={(workload) => {
        const isCurrent = workload.workloadKey === selected
        const dq = workload.disqualified.length
        const loadTag = loadKindTag(workload.loadAxis.kind)
        return (
          <button
            type="button"
            className={isCurrent ? 'wpick-card cur' : 'wpick-card'}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelect(workload.workloadKey)}
          >
            <span className="wtitle">{workload.title}</span>
            {(loadTag || workload.tags.length > 0) && (
              <span className="wtags">
                {loadTag && <span className={`spec-tag ${loadTag.className}`}>{loadTag.label}</span>}
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
        )
      }}
    />
  )
}
