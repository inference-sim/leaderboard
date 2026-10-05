import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SweepControls } from './components/SweepControls'
import { initialValues } from './newrun'
import { toggleAxisValue, addAxisValue } from './sweep'

const base = initialValues()
const render = (axes = {}, loadValues: string[] = []) =>
  renderToStaticMarkup(<SweepControls base={base} axes={axes} loadValues={loadValues}
    onAxesChange={() => {}} onLoadValuesChange={() => {}} />)

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
  it('load-level list renders each level', () => {
    const html = render({}, [base.loadValue, '32', '64'])
    expect(html).toContain('32')
    expect(html).toContain('64')
  })
})
