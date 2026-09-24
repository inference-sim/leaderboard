import type { KnobChip } from '../model'

/**
 * One deployment-argument chip, shared by the ranked table's deployment cell and the
 * two excluded bands so a knob reads identically wherever it appears.
 *
 * A scalar knob is a single boxed token ("max_num_seqs 8"). A structured knob
 * (routing_scorers, disaggregation) instead names the field once and lays out one boxed
 * token per scorer or pool, so a weighted profile reads as its parts rather than
 * collapsing to "[object Object]". The group is one flex item, so its label and tokens
 * wrap together and never split across the container's own wrap.
 */
export function Knob({ chip, rest = false }: { chip: KnobChip; rest?: boolean }) {
  const cls = chip.extra ? 'knob extra' : rest ? 'knob rest' : 'knob'
  if (chip.items && chip.items.length > 0) {
    return (
      <span className="knobgroup">
        <i className="knobgroup-label">{chip.label}</i>
        {chip.items.map((item) => (
          <span key={item} className={cls}>
            {item}
          </span>
        ))}
      </span>
    )
  }
  return <span className={cls}>{chip.label}</span>
}
