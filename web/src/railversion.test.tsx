import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RailVersion } from './components/RailVersion'

/**
 * The small version string shown beside a project name in the left nav rail, rendered to
 * static markup like the rest of the presentational pieces. App supplies the value from
 * /api/version and omits the element entirely when there is no server; the pure "what the
 * text says" claims rest here.
 */

describe('RailVersion', () => {
  it('shows the version verbatim', () => {
    const html = renderToStaticMarkup(<RailVersion value="07622594" />)
    expect(html).toContain('07622594')
    expect(html).toContain('railver')
  })

  it('renders an unset value as the literal "unknown" rather than a blank', () => {
    const html = renderToStaticMarkup(<RailVersion value="" />)
    expect(html).toContain('unknown')
  })
})
