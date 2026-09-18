import { COLUMNS } from '../model'
import type { SortSpec } from '../model'

/**
 * The active sort spelled out above the table, one removable chip per tier. Each chip
 * is its own unit the reader drops independently through its ✕, so a multi-tier sort
 * can be pared back one column at a time rather than only cleared whole — the header
 * carets can only cycle a column off in place, and never say, in one glance, what the
 * table is ordered by. Renders nothing when the table is unsorted.
 *
 * The priority number rides each chip only when two or more tiers are in play; a lone
 * sort has no rank to disambiguate. The caret is decorative — the remove button's label
 * carries the column and its direction for a screen reader.
 */
export function SortNote({
  sort,
  onRemove,
}: {
  sort: SortSpec[]
  onRemove: (key: string) => void
}) {
  if (sort.length === 0) return null
  return (
    <div className="sortnote">
      <span className="sortnote-label">Sorted by</span>
      {sort.map((s, i) => {
        const label = COLUMNS.find((c) => c.key === s.key)?.label ?? s.key
        const dir = s.dir === 1 ? 'ascending' : 'descending'
        return (
          <span className="sortnote-chip" key={s.key}>
            {sort.length > 1 && (
              <span className="sortnote-rank" aria-hidden="true">
                {i + 1}
              </span>
            )}
            <b>{label}</b>
            <span className="sortnote-car" aria-hidden="true">
              {s.dir === 1 ? '▲' : '▼'}
            </span>
            <button
              type="button"
              className="sortnote-remove"
              onClick={() => onRemove(s.key)}
              aria-label={`Remove sort by ${label}, ${dir}`}
            >
              ✕
            </button>
          </span>
        )
      })}
    </div>
  )
}
