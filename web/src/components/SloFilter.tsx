import { useId, useState } from 'react'
import { emptyTargets, parseTargets, targetChips } from '../slo'
import type { RawTargets, SloMetric } from '../slo'

interface Props {
  /** The metrics a target can be set against, in display order. */
  metrics: SloMetric[]
  /** The current raw input strings, one slot per metric. */
  targets: RawTargets
  onChange: (targets: RawTargets) => void
}

/** One metric's row: its label and a threshold input, sensed by the metric's direction. */
function SloRow({
  metric,
  value,
  onSet,
}: {
  metric: SloMetric
  value: string
  onSet: (value: string) => void
}) {
  const floor = metric.higherIsBetter
  return (
    <label className="slorow">
      <span className="slolabel">{metric.label}</span>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        className="sloinput"
        placeholder={floor ? 'min /s' : 'max ms'}
        value={value}
        aria-label={`${metric.label} ${floor ? 'minimum per second' : 'maximum milliseconds'}`}
        onChange={(e) => onSet(e.target.value)}
      />
    </label>
  )
}

/**
 * The SLO-target filter card, beside Models and Hardware. It wears the same frame as those
 * cards: a fieldset whose legend title dissects the top border. The title is the expand
 * toggle and the editable body is collapsed by default. While collapsed it still carries a
 * preview so it reads as a real card beside the always-open siblings: a muted "No targets
 * set" when nothing is set, or one pill per set target in the same tag design as the model
 * and hardware bubbles, each showing the ceiling (≤) or floor (≥) at the column precision.
 * Expanded, it lays out one section of latency ceilings ("max ms") and one of throughput
 * floors ("min /s"). A run must satisfy every set target to stay in the ranked table; one
 * that misses is relocated to the SloBand rather than hidden. Presentational and
 * prop-driven; only valid targets count, so a zero or blank slot reads as no target. Uses
 * its own slofilter class, never `wrap`.
 */
export function SloFilter({ metrics, targets, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const chips = targetChips(parseTargets(targets))

  const latency = metrics.filter((m) => m.group === 'latency')
  const throughput = metrics.filter((m) => m.group === 'throughput')
  const setSlot = (key: string, value: string) => onChange({ ...targets, [key]: value })

  const section = (group: SloMetric['group'], heading: string, rows: SloMetric[]) =>
    rows.length > 0 && (
      <div className="slogroup">
        <div className={`slogrouphd slogrouphd--${group}`}>{heading}</div>
        <div className="slorows">
          {rows.map((m) => (
            <SloRow key={m.key} metric={m} value={targets[m.key] ?? ''} onSet={(v) => setSlot(m.key, v)} />
          ))}
        </div>
      </div>
    )

  return (
    <fieldset className="slofilter">
      <legend>
        <button
          type="button"
          className="slotoggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="car" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          SLO targets
        </button>
      </legend>

      {/* Collapsed preview: the set targets as pills, or a resting summary. Hidden once the
          editable body opens, since the inputs then carry the same values. */}
      <div className="slopreview" hidden={open}>
        {chips.length > 0 ? (
          chips.map((c) => (
            <span key={c.key} className={`slochip slochip--${c.group}`}>
              {c.text}
            </span>
          ))
        ) : (
          <span className="slonone">No targets set</span>
        )}
      </div>

      <div id={bodyId} className="slobody" hidden={!open}>
        {section('latency', 'Latency (max ms)', latency)}
        {section('throughput', 'Throughput (min per second)', throughput)}
        <div className="sloactions">
          <button type="button" className="tagaction" onClick={() => onChange(emptyTargets())}>
            Clear
          </button>
        </div>
      </div>
    </fieldset>
  )
}
