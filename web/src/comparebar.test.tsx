import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareBar } from './components/CompareBar'

describe('CompareBar', () => {
  it('reads "Compare" when off, with aria-pressed false', () => {
    const html = renderToStaticMarkup(<CompareBar active={false} count={0} onToggle={() => {}} />)
    expect(html).toContain('Compare')
    expect(html).toMatch(/aria-pressed="false"/)
    expect(html).not.toContain('class="wrap"')
  })
  it('reads "Comparing (2)" and aria-pressed true when active with a selection', () => {
    const html = renderToStaticMarkup(<CompareBar active={true} count={2} onToggle={() => {}} />)
    expect(html).toContain('Comparing (2)')
    expect(html).toMatch(/aria-pressed="true"/)
  })
})
