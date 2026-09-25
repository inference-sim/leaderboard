interface CompareBarProps {
  /** Whether compare mode is on. */
  active: boolean
  /** How many runs are currently highlighted. */
  count: number
  onToggle: () => void
}

/**
 * The fixed bottom-right Compare toggle, shown only on the board view. Off by default; turning
 * it on puts the current table into compare mode (row-click highlights a run). The label
 * reflects the state and the count, e.g. "Comparing (2)". Board-only is enforced by where it is
 * rendered (WorkloadSection), not by CSS.
 */
export function CompareBar({ active, count, onToggle }: CompareBarProps) {
  return (
    <div className="comparebar">
      <button
        type="button"
        className={active ? 'cmpbtn on' : 'cmpbtn'}
        aria-pressed={active}
        onClick={onToggle}
      >
        {active ? `Comparing (${count})` : 'Compare'}
      </button>
    </div>
  )
}
