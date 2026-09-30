import type { RunRecord } from './load'
import { offeredLoad } from './load'

/**
 * Whether a record survives the model, hardware, and load filters — the single predicate the
 * table's visible rows and the Compare bar's "Select all" both run, so selecting all can never
 * reach a run the filters have hidden. A model selection narrows to its literal set; an empty
 * one falls back to `allModels` (the "all" reading, matched to the table's own fallback for
 * direct callers and tests). Hardware and load work the same, with [] read as every accelerator
 * / every load level. WorkloadSection guards the genuinely-empty case (a reader who cleared a
 * filter) separately, so that fallback never stands in for "nothing selected" there. `loads` is
 * optional so callers with no load axis (and older tests) need not pass it.
 */
export function keptByFilters(
  record: RunRecord,
  models: string[],
  allModels: string[],
  hardware: string[],
  loads: number[] = [],
): boolean {
  const shown = models.length > 0 ? models : allModels
  const modelOk = shown.includes(record.deployment.model)
  const hardwareOk = hardware.length === 0 || hardware.includes(record.deployment.hardware)
  const loadOk = loads.length === 0 || loads.includes(offeredLoad(record.group).value)
  return modelOk && hardwareOk && loadOk
}

/**
 * The filter selection after clicking `clicked`: it toggles that option in or out and
 * returns the literal set of selected options, in `options` (display) order. Unlike the
 * page's old "empty array means all" convention, this never canonicalises — turning off
 * the last selected option returns [], a real "none selected" state, and turning on the
 * last missing one returns the full list. The caller (WorkloadSection) starts the
 * selection at every option and treats [] as "show nothing", so the two are distinct.
 */
export function nextSelection(options: string[], selected: string[], clicked: string): string[] {
  const set = new Set(selected)
  if (set.has(clicked)) set.delete(clicked)
  else set.add(clicked)
  return options.filter((o) => set.has(o))
}

/**
 * Which shown filter, if any, has been emptied — so the section can explain the blank
 * table instead of rendering one silently. A filter that is not shown can never be
 * emptied by the reader, so its selection is ignored. Returns the plural noun to name in
 * the note, models taking precedence, or null when nothing is empty.
 */
export function emptyFilterNoun(
  showModels: boolean,
  models: string[],
  showHardware: boolean,
  hardware: string[],
  showLoad = false,
  loads: number[] = [],
): 'models' | 'hardware types' | 'load levels' | null {
  // Load sits on top of the filter stack, so an emptied load filter is named first.
  if (showLoad && loads.length === 0) return 'load levels'
  if (showModels && models.length === 0) return 'models'
  if (showHardware && hardware.length === 0) return 'hardware types'
  return null
}
