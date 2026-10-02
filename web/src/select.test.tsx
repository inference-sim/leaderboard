import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Select, filterOptions } from './components/Select'
import type { SelectOption } from './components/Select'

const opts: SelectOption[] = [
  { value: 'a', label: 'Alpha', hint: 'preset' },
  { value: 'b', label: 'Beta' },
  { value: '', label: 'Custom (define below)' },
]

describe('filterOptions', () => {
  const models: SelectOption[] = [
    { value: 'qwen/qwen3-14b', label: 'qwen/qwen3-14b' },
    { value: 'meta-llama/llama-3.1-8b', label: 'meta-llama/llama-3.1-8b' },
    { value: 'mistralai/mixtral-8x7b', label: 'mistralai/mixtral-8x7b' },
  ]

  it('returns everything for a blank query', () => {
    expect(filterOptions(models, '')).toHaveLength(3)
    expect(filterOptions(models, '   ')).toHaveLength(3)
  })

  it('matches label or value, case-insensitively', () => {
    expect(filterOptions(models, 'QWEN').map((o) => o.value)).toEqual(['qwen/qwen3-14b'])
    expect(filterOptions(models, 'llama').map((o) => o.value)).toEqual(['meta-llama/llama-3.1-8b'])
  })

  it('is empty when nothing matches', () => {
    expect(filterOptions(models, 'gpt')).toEqual([])
  })
})

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
