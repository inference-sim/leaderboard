import { TagFilter } from './TagFilter'
import { formatNumber } from '../format'

interface Props {
  /** The offered-load kind: "rate" (req/s) or "concurrency" (users). Sets the label format. */
  kind: string
  /** The load levels present in this profile, ascending. */
  options: number[]
  /** The currently selected levels — the literal set shown. */
  selected: number[]
  onChange: (selected: number[]) => void
}

/**
 * The per-profile offered-load filter: a toggle bubble per load level a workload was swept
 * across, with the same literal multi-select behaviour as the model and hardware filters (the
 * levels shown are exactly the ones pressed). Load is a dimension of the profile, not part of
 * the comparability key, so this only narrows which rows show. It wraps the string-based
 * TagFilter by mapping each numeric level to its formatted label and back — rate to one decimal
 * ("6.0"), concurrency to an integer ("32") — so the selection stays numeric for the table.
 */
export function LoadFilter({ kind, options, selected, onChange }: Props) {
  const digits = kind === 'rate' ? 1 : 0
  const label = (v: number) => formatNumber(v, digits)
  const byLabel = new Map(options.map((v) => [label(v), v]))
  return (
    <TagFilter
      legend={kind === 'rate' ? 'Offered rate (req/s)' : 'Concurrency (users)'}
      noun="load levels"
      options={options.map(label)}
      selected={selected.map(label)}
      onChange={(picked) => onChange(picked.map((l) => byLabel.get(l)!))}
    />
  )
}
