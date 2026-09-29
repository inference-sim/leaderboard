import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TraceCard } from './components/TraceCard'
import type { TraceForm } from './workloads'

function ingested(over: Partial<TraceForm> = {}): TraceForm {
  return {
    sessionMode: 'closed-loop',
    concurrentSessions: 32,
    totalSessions: 0,
    shuffleCorpus: false,
    thinkTimeMs: 0,
    thinkTimeDist: '',
    sha256: 'a'.repeat(64),
    sourceFormat: 'weka',
    records: 128000,
    sessions: 4000,
    sessionContextGrowth: 'accumulate',
    ...over,
  }
}

describe('TraceCard', () => {
  it('shows the upload controls before a trace is ingested', () => {
    const html = renderToStaticMarkup(<TraceCard trace={null} onChange={() => {}} />)
    expect(html).toContain('Ingest trace')
    expect(html).toContain('Source format')
    // The styled file picker, not a raw OS file input label.
    expect(html).toContain('filepick-btn')
    expect(html).toContain('No file chosen')
    expect(html).not.toContain('Session mode')
  })

  it('shows the corpus and replay knobs once ingested', () => {
    const html = renderToStaticMarkup(<TraceCard trace={ingested()} onChange={() => {}} />)
    expect(html).toContain('128,000 records')
    expect(html).toContain('4,000 sessions')
    expect(html).toContain('Session mode')
    expect(html).toContain('Concurrent sessions')
    // The dropdowns use the app's custom Select (a listbox), not a native <select>.
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).not.toContain('<select')
    // An accumulate corpus must not offer plain fixed as a session-mode option.
    expect(html).not.toContain('>fixed<')
  })

  it('surfaces a guard violation live (fixed-accumulate on a pool)', () => {
    const html = renderToStaticMarkup(
      <TraceCard trace={ingested({ sessionMode: 'fixed-accumulate', concurrentSessions: 8 })} onChange={() => {}} />,
    )
    expect(html).toContain('incompatible with session_mode fixed-accumulate')
  })
})
