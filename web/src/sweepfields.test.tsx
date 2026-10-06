import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultiToggle, ChipSelect, ChipNumber, ChipList } from './components/sweepfields'
import { initialValues } from './newrun'
import { toggleAxisValue, addAxisValue } from './sweep'

const base = initialValues()

describe('sweep field primitives', () => {
  it('MultiToggle lights every selected option', () => {
    const axes = toggleAxisValue({}, 'tp', '8', base)
    const html = renderToStaticMarkup(
      <MultiToggle fieldKey="tp" label="Tensor parallel" options={[2, 4, 8]}
        base={base} axes={axes} onAxesChange={() => {}} />)
    expect((html.match(/aria-pressed="true"/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(html).toMatch(/varies \(2\)/)
  })
  it('ChipSelect renders a chip per chosen value plus an add control', () => {
    const axes = addAxisValue({}, 'scheduler', 'priority', base)
    const html = renderToStaticMarkup(
      <ChipSelect fieldKey="scheduler" label="Scheduler" options={['fcfs', 'priority']}
        base={base} axes={axes} onAxesChange={() => {}} />)
    expect(html).toContain('priority')
    expect(html).toContain('chip')
    expect(html).toContain('add a value')
  })
  it('ChipNumber shows chips and the base chip has no remove', () => {
    const axes = addAxisValue({}, 'maxModelLen', '4096', base)
    const html = renderToStaticMarkup(
      <ChipNumber fieldKey="maxModelLen" label="Max model length"
        base={base} axes={axes} onAxesChange={() => {}} />)
    expect(html).toContain('4096')
    // one remove button for the added value, none for the base chip
    expect((html.match(/aria-label="Remove/g) || []).length).toBe(1)
  })
  it('ChipList renders each level, all levels removable', () => {
    const html = renderToStaticMarkup(
      <ChipList label="Load levels" values={[base.loadValue, '32']} onChange={() => {}} />)
    expect(html).toContain('32')
    // every level chip, including the base, now has a remove control
    expect((html.match(/aria-label="Remove/g) || []).length).toBe(2)
  })
  it('ChipList warns and shows no chips when the load list is empty', () => {
    const html = renderToStaticMarkup(
      <ChipList label="Load levels" values={[]} onChange={() => {}} />)
    expect(html).toContain('Add at least one load level')
    expect((html.match(/class="chip"/g) || []).length).toBe(0)
  })
})
