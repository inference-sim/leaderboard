import { nextSelection } from '../filter'

interface Props {
  /** Legend label, e.g. "Models" or "Hardware". */
  legend: string
  /** Plural noun for the selection summary, e.g. "models", "hardware types". */
  noun: string
  /** The options present, in display order. */
  options: string[]
  /** The currently selected options — the literal set shown. Empty means none shown. */
  selected: string[]
  onChange: (selected: string[]) => void
}

/**
 * A multi-select filter rendered as toggle "bubbles": one pill per option, each an
 * aria-pressed button rather than a checkbox. The selection is literal — a pressed
 * bubble is shown, an unpressed one is hidden — so the reader can turn every option off
 * and see nothing, a real state the owning section explains. The control opens with
 * every option on (the caller seeds the selection with all of them). Two action buttons
 * sit at the card's right edge: "Show all" turns every bubble on, "Clear" turns every
 * bubble off. Both are always enabled — including from the default all-selected state,
 * where "Clear" was previously dead — so either endpoint is one click away regardless of
 * the current selection. Presentational and domain-free: ModelFilter
 * and HardwareFilter wrap it with their own legend.
 */
export function TagFilter({ legend, noun, options, selected, onChange }: Props) {
  const active = new Set(selected)
  const all = selected.length === options.length
  const none = selected.length === 0
  const summary = none
    ? `· no ${noun} shown`
    : all
      ? `· all ${noun} shown`
      : `· ${selected.length} of ${options.length}`

  return (
    <fieldset className="tagfilter">
      <legend>
        {legend}
        <span className="muted"> {summary}</span>
      </legend>
      <div className="tagbody">
        <div className="tagrow">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="tag"
              value={option}
              aria-pressed={active.has(option)}
              onClick={() => onChange(nextSelection(options, selected, option))}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="tagactions">
          <button type="button" className="tagaction" onClick={() => onChange(options)}>
            Show all
          </button>
          <button type="button" className="tagaction" onClick={() => onChange([])}>
            Clear
          </button>
        </div>
      </div>
    </fieldset>
  )
}
