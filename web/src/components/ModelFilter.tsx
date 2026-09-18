import { TagFilter } from './TagFilter'

interface Props {
  /** The models present in this workload, in display order. */
  models: string[]
  /** The currently selected models — the literal set shown. */
  selected: string[]
  onChange: (selected: string[]) => void
}

/**
 * The per-workload model filter: a toggle bubble per model, multi-select, the selection
 * literal — the models shown are exactly the ones pressed. Model is a candidate under
 * test now (E1), so this filter behaves exactly like the hardware filter beside it: it
 * only narrows which rows show, never changing the table or asserting a ranking. Selecting
 * none shows nothing, and the owning section explains it.
 */
export function ModelFilter({ models, selected, onChange }: Props) {
  return (
    <TagFilter legend="Models" noun="models" options={models} selected={selected} onChange={onChange} />
  )
}
