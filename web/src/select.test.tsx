import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Select } from './components/Select'
import type { SelectOption } from './components/Select'

const opts: SelectOption[] = [
  { value: 'a', label: 'Alpha', hint: 'preset' },
  { value: 'b', label: 'Beta' },
  { value: '', label: 'Custom (define below)' },
]

describe('Select', () => {
  it('shows the selected option label in the trigger, as a listbox combobox', () => {
    const html = renderToStaticMarkup(
      <Select value="b" onChange={() => {}} options={opts} ariaLabel="Workload" />,
    )
    expect(html).toContain('Beta')
    expect(html).toMatch(/aria-haspopup="listbox"/)
    expect(html).toMatch(/aria-expanded="false"/)
    expect(html).toMatch(/aria-label="Workload"/)
  })

  it('keeps every option in the DOM even while closed, so SSR and tests still see them', () => {
    const html = renderToStaticMarkup(
      <Select value="b" onChange={() => {}} options={opts} ariaLabel="W" />,
    )
    expect(html).toMatch(/role="listbox"/)
    expect(html).toContain('Alpha')
    expect(html).toContain('Custom (define below)')
    expect((html.match(/role="option"/g) ?? []).length).toBe(3)
    // The list is hidden until opened — options exist but are not shown.
    expect(html).toMatch(/role="listbox"[^>]*hidden/)
  })

  it('marks the current value selected and renders its hint', () => {
    const html = renderToStaticMarkup(
      <Select value="a" onChange={() => {}} options={opts} ariaLabel="W" />,
    )
    expect(html).toContain('preset')
    expect(html).toMatch(/aria-selected="true"[^>]*>\s*<span[^>]*>Alpha/)
  })

  it('associates with a visible label via labelledBy and carries an id for htmlFor', () => {
    const html = renderToStaticMarkup(
      <Select value="a" onChange={() => {}} options={opts} labelledBy="lbl-x" id="ctl-x" />,
    )
    expect(html).toMatch(/aria-labelledby="lbl-x"/)
    expect(html).toMatch(/id="ctl-x"/)
  })

  it('falls back to a placeholder when no option matches the value', () => {
    const html = renderToStaticMarkup(
      <Select value="zzz" onChange={() => {}} options={opts} ariaLabel="W" placeholder="Pick one" />,
    )
    expect(html).toContain('Pick one')
  })
})
