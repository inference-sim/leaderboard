import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SweepControls } from './components/SweepControls'
import { initialValues } from './newrun'
import { toggleAxisValue, addAxisValue } from './sweep'

const base = initialValues()
const render = (axes = {}, loadValues: string[] = [], hardwareNames?: string[]) =>
  renderToStaticMarkup(<SweepControls base={base} axes={axes} loadValues={loadValues}
    hardwareNames={hardwareNames} onAxesChange={() => {}} onLoadValuesChange={() => {}} />)

describe('SweepControls', () => {
  it('a multi-toggle lights several options', () => {
    const axes = toggleAxisValue({}, 'tp', '8', base)
    const html = render(axes)
    const pressed = (html.match(/aria-pressed="true"/g) || []).length
    expect(pressed).toBeGreaterThanOrEqual(2) // base tp and tp=8 both lit
  })
  it('a number axis renders a chip per value', () => {
    const axes = addAxisValue({}, 'maxModelLen', '2048', base)
    expect(render(axes)).toContain('2048')
    expect(render(axes)).toContain('chip')
  })
  it('shows a varies (n) badge when a field varies', () => {
    const axes = toggleAxisValue({}, 'tp', '8', base)
    expect(render(axes)).toMatch(/varies \(2\)/)
  })
  it('renders hardware as a multi-toggle when names are passed, base pill lit', () => {
    const html = render({}, [], ['H100', 'A100'])
    // A pressed toggle for the base hardware (H100), not a free-text chip input.
    expect(html).toContain('aria-pressed="true"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>H100/)
    expect(html).toMatch(/aria-pressed="false"[^>]*>A100/)
    // The Accelerator field no longer offers the free-text "Add Accelerator" input.
    expect(html).not.toContain('aria-label="Add Accelerator"')
  })
  it('keeps hardware as a free-text chip input when no names are passed', () => {
    const html = render()
    expect(html).toContain('aria-label="Add Accelerator"')
  })
  it('load-level list renders each level', () => {
    const html = render({}, [base.loadValue, '32', '64'])
    expect(html).toContain('32')
    expect(html).toContain('64')
  })
})
