import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareBar } from './components/CompareBar'

const noop = () => {}

describe('CompareBar', () => {
  it('is a single "Compare" button when off, aria-pressed false', () => {
    const html = renderToStaticMarkup(
      <CompareBar active={false} count={0} total={5} onToggle={noop} onSelectAll={noop} onClear={noop} />,
    )
    expect(html).toContain('Compare')
    expect(html).toMatch(/aria-pressed="false"/)
    expect(html).not.toContain('Select all')
  })

  it('expands to a labelled panel with the count, instruction and actions when on', () => {
    const html = renderToStaticMarkup(
      <CompareBar active={true} count={2} total={5} onToggle={noop} onSelectAll={noop} onClear={noop} />,
    )
    expect(html).toMatch(/aria-label="Compare mode"/)
    expect(html).toContain('Comparing · 2')
    expect(html).toMatch(/Click rows to add or remove/i)
    expect(html).toContain('Select all 5')
    expect(html).toContain('Clear')
    expect(html).toMatch(/aria-pressed="true"/)
  })

  it('disables Select all when everything is selected and Clear when nothing is', () => {
    const allSelected = renderToStaticMarkup(
      <CompareBar active={true} count={5} total={5} onToggle={noop} onSelectAll={noop} onClear={noop} />,
    )
    // "Select all" is disabled; "Clear" is enabled.
    expect(allSelected).toMatch(/Select all 5<\/button>/)
    expect(allSelected).toMatch(/disabled=""[^>]*>\s*Select all/)

    const noneSelected = renderToStaticMarkup(
      <CompareBar active={true} count={0} total={5} onToggle={noop} onSelectAll={noop} onClear={noop} />,
    )
    expect(noneSelected).toMatch(/disabled=""[^>]*>\s*Clear/)
  })
})
