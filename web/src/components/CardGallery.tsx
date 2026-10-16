import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Rows of cards per page: a gallery pages through its items three rows at a time. */
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

/** The number of pages the items span at the given column count (always at least 1). */
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

interface Props<T> {
  /** The items to show, one card each, in order. */
  items: T[]
  /** A stable React key per item. */
  getKey: (item: T) => string
  /** Renders one item's card (the <button> or content inside the <li>). */
  renderCard: (item: T) => ReactNode
  /** The gallery's accessible name. */
  ariaLabel: string
  /** The index of the item to keep on the visible page (e.g. the selected one), or -1 for
   *  none. A reveal can select an item the pager had scrolled past, so the gallery pages to it. */
  activeIndex?: number
}

/**
 * A paged responsive card gallery: the shared presentation behind the leaderboard's workload
 * picker and its By-sweep list. It owns the responsive grid, the three-rows-a-page pager, and
 * keeping the active item on screen; the caller supplies the items and the card. The two
 * galleries therefore read identically and only their cards differ.
 */
export function CardGallery<T>({ items, getKey, renderCard, ariaLabel, activeIndex = -1 }: Props<T>) {
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

  const total = items.length
  const pages = pageCount(total, columns)
  const current = clampPage(page, total, columns)
  const [start, end] = pageBounds(total, columns, current)
  const shown = items.slice(start, end)

  // Keep the active item on the shown page: a reveal (declaring a run jumps the board to the
  // new run's workload) can land on a card the pager had scrolled past, so page to it. Only on
  // an active-index or page-span change, never on manual paging, so the arrows stay in control.
  useEffect(() => {
    if (activeIndex < 0 || columns <= 0) return
    setPage(Math.floor(activeIndex / (columns * ROWS_PER_PAGE)))
  }, [activeIndex, columns])

  return (
    <nav className="wpick" aria-label={ariaLabel}>
      {pages > 1 && (
        <div className="wpick-pager">
          <button
            type="button"
            className="wpick-arrow"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous page"
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
            aria-label="Next page"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      )}
      <ul className="wgallery" ref={listRef}>
        {shown.map((item) => (
          <li key={getKey(item)}>{renderCard(item)}</li>
        ))}
      </ul>
    </nav>
  )
}
