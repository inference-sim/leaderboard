import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Toast } from './components/Toast'

/**
 * The toast's presentational contract, rendered to static markup like the live-run banner
 * (no DOM required). The auto-dismiss timer and hover-pause are effects that need an event
 * loop, which this node harness lacks; this covers what the markup must say and offer.
 */
describe('Toast', () => {
  const html = renderToStaticMarkup(
    <Toast workloadName="bursty-32k" onView={() => {}} onDismiss={() => {}} />,
  )

  it('announces politely without stealing focus', () => {
    expect(html).toMatch(/class="toast"[^>]*role="status"[^>]*aria-live="polite"/)
  })

  it('names the workload that was added to the catalog', () => {
    expect(html).toContain('Added to the catalog')
    expect(html).toContain('bursty-32k')
  })

  it('offers a View in catalog action and a dismiss control', () => {
    expect(html).toMatch(/class="toast-view"[^>]*>View in catalog</)
    expect(html).toMatch(/class="toast-dismiss"[^>]*aria-label="Dismiss this notice"/)
  })

  it('uses no em dashes in its copy', () => {
    expect(html).not.toContain('—')
  })
})

describe('Toast without a View action (saved from inside the catalog)', () => {
  const html = renderToStaticMarkup(
    <Toast workloadName="bursty-32k" onDismiss={() => {}} />,
  )

  it('still confirms and still offers dismiss', () => {
    expect(html).toContain('Added to the catalog')
    expect(html).toContain('bursty-32k')
    expect(html).toContain('class="toast-dismiss"')
  })

  it('omits the View in catalog button, since the reader is already there', () => {
    expect(html).not.toContain('View in catalog')
    expect(html).not.toContain('toast-view')
  })
})
