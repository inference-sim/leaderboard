import { TagFilter } from './TagFilter'

interface Props {
  /** The hardware types present in this workload, in display order. */
  options: string[]
  /** The currently selected hardware types — the literal set shown. */
  selected: string[]
  onChange: (selected: string[]) => void
}

/**
 * The per-workload hardware filter: a toggle bubble per accelerator present, same
 * literal multi-select behaviour as the model filter (the types shown are exactly the
 * ones pressed). Hardware and model are both candidates under test, not part of the
 * comparability key (D4, E1), so both filters only narrow which rows show; neither
 * changes what table you are in, and nothing on the table is ranked automatically.
 */
export function HardwareFilter({ options, selected, onChange }: Props) {
  return (
    <TagFilter
      legend="Hardware"
      noun="hardware types"
      options={options}
      selected={selected}
      onChange={onChange}
    />
  )
}
