interface Props {
  /** The plural noun for the emptied filter, e.g. "models" or "hardware types". */
  noun: string
}

/**
 * Shown in place of the table when the reader has deselected every option in a filter.
 * Deselecting all is a legitimate state (not "show everything"), so the section says so
 * and points back to the fix — pick a value to show runs again.
 */
export function EmptyFilterNote({ noun }: Props) {
  return (
    <p className="filterempty" role="status">
      No {noun} selected — pick one to show runs.
    </p>
  )
}
