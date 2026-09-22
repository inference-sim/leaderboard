import type { RunRecord } from '../load'

// A trash-can glyph, stroked in currentColor like the rail and copy icons, so it inverts
// with the button on hover and reads as an icon alone.
function TrashIcon() {
  return (
    <svg className="delico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  )
}

/**
 * The per-run delete control: a trash icon that asks App to delete this run. It only
 * opens the confirmation; the destructive call and the reload live in App, next to the
 * records and the live run it may have to clear. The board shows it only when the run
 * server is reachable (delete removes the results file from disk, which the static build
 * cannot do), so the button never appears where it could not work. `variant` places it:
 * "onrow" pins it to the table row's top-right beside the reproduce caret, "dq" lets it
 * ride to the end of a disqualified card's header.
 */
export function DeleteRunButton({
  record,
  onDelete,
  variant,
}: {
  record: RunRecord
  onDelete: (record: RunRecord) => void
  variant: 'onrow' | 'dq'
}) {
  return (
    <button
      type="button"
      className={`delrow ${variant}`}
      aria-label={`Delete the run ${record.run_id}`}
      title={`Delete ${record.run_id}`}
      onClick={() => onDelete(record)}
    >
      <TrashIcon />
    </button>
  )
}
