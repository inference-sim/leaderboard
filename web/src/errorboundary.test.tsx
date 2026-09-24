import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from './components/ErrorBoundary'

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    )
    expect(html).toContain('all good')
  })

  it('derives the caught error into state so the fallback can show it', () => {
    // React invokes error boundaries only on the client, so the fallback is not exercised by
    // static render; the derivation that drives it is a pure static method worth pinning.
    const err = new Error('h.aliases is not iterable')
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err })
  })
})
