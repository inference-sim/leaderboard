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
): 'models' | 'hardware types' | null {
  if (showModels && models.length === 0) return 'models'
  if (showHardware && hardware.length === 0) return 'hardware types'
  return null
}
