import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkloadGroup } from '../load'
import { loadKindTag } from '../load'

interface Props {
  workloads: WorkloadGroup[]
  /** The workloadKey of the selected workload. */
  selected: string
  onSelect: (workloadKey: string) => void
}

/** Rows of cards per page: the gallery pages through its workloads three rows at a time. */
export const ROWS_PER_PAGE = 3

// The grid's track sizing, mirrored from .wgallery in styles.css (repeat(auto-fill,
// minmax(240px, 1fr)) with a 12px gap). The column count is derived from the container
// width with the same arithmetic the grid uses, rather than read back from the laid-out
// cards: a partial last page would otherwise under-report the columns. Keep these in step
// with the CSS.
const CARD_MIN_PX = 240
const GALLERY_GAP_PX = 12

/**
 * How many columns an `auto-fill` grid of `minmax(CARD_MIN_PX, 1fr)` tracks resolves to at
 * the given content width. 0 for an unmeasured (zero) width, in which case the caller shows
 * a single page holding everything, so nothing is ever hidden without a way to reach it.
 */
export function columnsForWidth(width: number): number {
  if (width <= 0) return 0
  return Math.max(1, Math.floor((width + GALLERY_GAP_PX) / (CARD_MIN_PX + GALLERY_GAP_PX)))
}

/** The number of pages the workloads span at the given column count (always at least 1). */
export function pageCount(total: number, columns: number): number {
  if (columns <= 0) return 1
  return Math.max(1, Math.ceil(total / (columns * ROWS_PER_PAGE)))
}

/** A page index clamped into range, so a resize that shrinks the page span can't strand us. */
export function clampPage(page: number, total: number, columns: number): number {
  return Math.min(Math.max(page, 0), pageCount(total, columns) - 1)
}

/**
 * The [start, end) slice of cards shown on `page`. `columns <= 0` (unmeasured) is a single
 * page of everything; otherwise each page holds ROWS_PER_PAGE rows of `columns` cards. The
 * page is clamped first, so an out-of-range index lands on real cards.
 */
export function pageBounds(total: number, columns: number, page: number): [number, number] {
  if (columns <= 0) return [0, total]
  const size = columns * ROWS_PER_PAGE
  const start = clampPage(page, total, columns) * size
  return [start, Math.min(start + size, total)]
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
 */
export function WorkloadPicker({ workloads, selected, onSelect }: Props) {
  const listRef = useRef<HTMLUListElement>(null)
  // The columns the responsive grid currently resolves to, from the gallery's width. 0 until
  // the first layout pass, so the gallery renders in full first (one page of everything) and
  // only pages up once it knows how many cards make a page.
  const [columns, setColumns] = useState(0)
  const [page, setPage] = useState(0)

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => setColumns(columnsForWidth(el.clientWidth))
    measure()
    // Re-measure as the gallery reflows: a width change changes how many cards fit a row, so
    // the page span has to follow.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = workloads.length
  const pages = pageCount(total, columns)
  const current = clampPage(page, total, columns)
  const [start, end] = pageBounds(total, columns, current)
  const shown = workloads.slice(start, end)

  // Keep the selected workload on the shown page: a reveal (declaring a run jumps the board to
  // the new run's workload) can land on a card the pager had scrolled past, so page to it. Only
  // on a selection or page-span change, never on manual paging, so the arrows stay in control.
  const selectedIndex = workloads.findIndex((w) => w.workloadKey === selected)
  useEffect(() => {
    if (selectedIndex < 0 || columns <= 0) return
    setPage(Math.floor(selectedIndex / (columns * ROWS_PER_PAGE)))
  }, [selected, selectedIndex, columns])

  return (
    <nav className="wpick" aria-label="Workloads">
      {pages > 1 && (
        <div className="wpick-pager">
          <button
            type="button"
            className="wpick-arrow"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous workloads"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span
            className="wpick-pageno"
            aria-live="polite"
            aria-label={`Page ${current + 1} of ${pages}`}
          >
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            className="wpick-arrow"
            onClick={() => setPage(current + 1)}
            disabled={current >= pages - 1}
            aria-label="Next workloads"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      )}
      <ul className="wgallery" ref={listRef}>
        {shown.map((workload) => {
          const isCurrent = workload.workloadKey === selected
          const dq = workload.disqualified.length
          const loadTag = loadKindTag(workload.loadAxis.kind)
          return (
            <li key={workload.workloadKey}>
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
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
