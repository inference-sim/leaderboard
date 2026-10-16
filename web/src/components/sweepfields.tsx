import type { ReactNode } from 'react'
import type { FormValues } from '../newrun'
import {
  addAxisValue,
  axisValues,
  axisVaries,
  removeAxisValue,
  toggleAxisValue,
} from '../sweep'
import type { SweepableKey, SweepAxes } from '../sweep'

/** The small count badge shown beside a label (and on a folded group's summary) once a field
 *  carries more than one value. Exported so tests can assert the exact badge text. */
export function variesBadge(n: number): ReactNode {
  return <span className="varies">varies ({n})</span>
}

/** A closed value shown in a chip or option, with the empty string rendered as (none). */
function display(value: string): string {
  return value === '' ? '(none)' : value
}

/** Split a typed or pasted string into candidate tokens (whitespace or comma separated). */
function tokens(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((t) => t !== '')
}

/** Fold several typed/pasted tokens onto the axes in one update, so a paste of "1 2 4" adds
 *  three values at once. Each step is a pure addAxisValue call; the base is left untouched. */
function addMany(
  key: SweepableKey,
  raw: string,
  base: FormValues,
  axes: SweepAxes,
  onAxesChange: (axes: SweepAxes) => void,
): void {
  let next = axes
  for (const t of tokens(raw)) next = addAxisValue(next, key, t, base)
  if (next !== axes) onAxesChange(next)
}

/** The removable-chip row shared by number, select and text axes. Every chip, including the
 *  base value (chip 0), is removable; removing every value empties the axis and the field warns. */
function chips(
  key: SweepableKey,
  base: FormValues,
  axes: SweepAxes,
  onAxesChange: (axes: SweepAxes) => void,
): ReactNode[] {
  const values = axisValues(key, base, axes)
  return values.map((v) => (
    <span className="chip" key={v}>
      {display(v)}
      <button
        type="button"
        aria-label={`Remove ${display(v)}`}
        onClick={() => onAxesChange(removeAxisValue(axes, key, v, base))}
      >
        ×
      </button>
    </span>
  ))
}

/** The per-field empty hint, shown inline inside the control row when a swept field has had
 *  every value removed. The sweep produces zero runs until a value is added back, mirroring
 *  the load-level hint. */
function emptyAxisWarning(key: SweepableKey, base: FormValues, axes: SweepAxes): ReactNode {
  return axisValues(key, base, axes).length === 0 ? (
    <span className="axishint" role="alert">needs a value</span>
  ) : null
}

/** The field label with its varies badge once the field carries more than one value. */
function labelWith(key: SweepableKey, label: string, base: FormValues, axes: SweepAxes): ReactNode {
  return (
    <span className="nrlabel">
      {label}
      {axisVaries(key, base, axes) && variesBadge(axisValues(key, base, axes).length)}
    </span>
  )
}

interface AxisFieldProps {
  fieldKey: SweepableKey
  label: string
  base: FormValues
  axes: SweepAxes
  onAxesChange: (axes: SweepAxes) => void
}

/** A segmented multi-toggle over a closed set: one lit/unlit pill per option, each toggled
 *  onto its axis. Used by closed-set toggle fields and (when names are supplied) hardware. */
export function MultiToggle({
  fieldKey,
  label,
  options,
  base,
  axes,
  onAxesChange,
}: AxisFieldProps & { options: readonly (string | number)[] }) {
  const selectedList = axisValues(fieldKey, base, axes)
  const selected = new Set(selectedList)
  // Render the passed options, then append any selected value not among them (the base, when a
  // caller narrows the option set) so every selected value shows as a lit pill. When the base is
  // one of the options (every live usage: TP_CHOICES, the catalog hardware names) this is exactly
  // the option list, so only a narrowed option set ever appends an extra pill.
  const optionValues = options.map((opt) => String(opt))
  const pills = [...optionValues, ...selectedList.filter((v) => !optionValues.includes(v))]
  return (
    <div className="nrrow">
      {labelWith(fieldKey, label, base, axes)}
      <div className="tagrow" role="group" aria-label={label}>
        {pills.map((value) => {
          return (
            <button
              type="button"
              className="tag"
              key={value}
              aria-pressed={selected.has(value)}
              onClick={() => onAxesChange(toggleAxisValue(axes, fieldKey, value, base))}
            >
              {display(value)}
            </button>
          )
        })}
        {emptyAxisWarning(fieldKey, base, axes)}
      </div>
    </div>
  )
}

/** A chip multi-select over a closed set: chosen values accumulate as removable chips and a
 *  dropdown offers the remaining options. Every chip, the base included, is removable. */
export function ChipSelect({
  fieldKey,
  label,
  options,
  base,
  axes,
  onAxesChange,
}: AxisFieldProps & { options: readonly string[] }) {
  const chosen = axisValues(fieldKey, base, axes)
  const remaining = options.filter((o) => !chosen.includes(o))
  return (
    <div className="nrrow">
      {labelWith(fieldKey, label, base, axes)}
      <div className="chiprow">
        {chips(fieldKey, base, axes, onAxesChange)}
        <select
          className="chipinput"
          aria-label={`Add ${label}`}
          value=""
          onChange={(e) => {
            if (e.target.value !== '') onAxesChange(addAxisValue(axes, fieldKey, e.target.value, base))
          }}
        >
          <option value="">add a value</option>
          {remaining.map((o) => (
            <option value={o} key={o}>
              {display(o)}
            </option>
          ))}
        </select>
        {emptyAxisWarning(fieldKey, base, axes)}
      </div>
    </div>
  )
}

/** A free number field whose values accumulate as removable chips (Enter or paste adds; split
 *  on whitespace or commas). Every chip, the base included, is removable. */
export function ChipNumber({ fieldKey, label, base, axes, onAxesChange }: AxisFieldProps) {
  return (
    <div className="nrrow">
      {labelWith(fieldKey, label, base, axes)}
      <div className="chiprow">
        {chips(fieldKey, base, axes, onAxesChange)}
        <input
          className="chipinput"
          type="text"
          inputMode="decimal"
          placeholder="add a value"
          aria-label={`Add ${label}`}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addMany(fieldKey, e.currentTarget.value, base, axes, onAxesChange)
              e.currentTarget.value = ''
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            addMany(fieldKey, e.clipboardData.getData('text'), base, axes, onAxesChange)
          }}
        />
        {emptyAxisWarning(fieldKey, base, axes)}
      </div>
    </div>
  )
}

/** The offered-load-level list: the same removable-chip pattern over a plain string[], managed
 *  directly (there is no sweep.ts axis for load). Every level, including the base (the single
 *  run's own load, seeded on entry), is removable; the sweep runs over whatever levels remain.
 *  When none remain the control warns and the sweep cannot run. */
export function ChipList({
  label,
  values,
  onChange,
}: {
  label: string
  values: string[]
  onChange: (v: string[]) => void
}) {
  const addLoads = (raw: string) => {
    const next = [...values]
    for (const t of tokens(raw)) if (!next.includes(t)) next.push(t)
    if (next.length !== values.length) onChange(next)
  }
  return (
    <div className="nrrow">
      <span className="nrlabel">
        {label}
        {values.length > 1 && variesBadge(values.length)}
      </span>
      <div className="chiprow">
        {values.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button
              type="button"
              aria-label={`Remove load ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="chipinput"
          type="text"
          inputMode="decimal"
          placeholder="add a level"
          aria-label="Add a load level"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addLoads(e.currentTarget.value)
              e.currentTarget.value = ''
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            addLoads(e.clipboardData.getData('text'))
          }}
        />
        {values.length === 0 && (
          <span className="axishint" role="alert">needs a level</span>
        )}
      </div>
    </div>
  )
}
