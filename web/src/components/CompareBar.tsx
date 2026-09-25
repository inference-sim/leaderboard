interface CompareBarProps {
  /** Whether compare mode is on. */
  active: boolean
  /** How many runs are currently highlighted. */
  count: number
  /** How many runs the table holds (the select-all target). */
  total: number
  onToggle: () => void
  /** Highlight every run in the table. */
  onSelectAll: () => void
  /** Clear the highlight selection. */
  onClear: () => void
}

/**
 * The fixed bottom-right compare control, shown only on the board (it is rendered by
 * WorkloadSection). Off, it is a single "Compare" button. On, it expands into a small always-
 * visible panel in the same corner - where the reader just clicked - holding the count, the
 * "click rows" instruction, and the Select all / Clear actions, so the compare controls are
 * one findable place rather than scattered up the page.
 */
export function CompareBar({ active, count, total, onToggle, onSelectAll, onClear }: CompareBarProps) {
  if (!active) {
    return (
      <div className="comparebar">
        <button type="button" className="cmpbtn" aria-pressed={false} onClick={onToggle}>
          Compare
        </button>
      </div>
    )
  }
  return (
    <div className="comparebar on" role="group" aria-label="Compare mode">
      <div className="cbrow">
        <span className="cbtitle">Comparing · {count}</span>
        <button type="button" className="cbexit" aria-pressed onClick={onToggle}>
          Exit
        </button>
      </div>
      <p className="cbnote">Click rows to add or remove them for comparison.</p>
      <div className="cbactions">
        <button type="button" className="cbbtn" onClick={onSelectAll} disabled={count === total}>
          Select all {total}
        </button>
        <button type="button" className="cbbtn ghost" onClick={onClear} disabled={count === 0}>
          Clear
        </button>
      </div>
    </div>
  )
}
