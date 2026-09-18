import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadWorkloads } from './load'
import type { RunRecord } from './load'
import { LiveRunBanner } from './components/LiveRunBanner'
import { ReadoutTable } from './components/ReadoutTable'
import { rowId } from './liverun'
import type { RunDecl } from './liverun'

/**
 * The live-run flow's presentational pieces, rendered to static markup like the rest of
 * render.test.tsx (no DOM required). The state-machine transitions in App and the
 * scroll/highlight effect need an event loop and layout, which this node harness lacks;
 * the pure claims those rest on are covered by liverun.test.ts.
 */

const MAIN = '5063e40dceb2' // the unbounded qwen/qwen3-14b workload
const records = fixture as unknown as RunRecord[]
const workloads = loadWorkloads(records)
const mainW = workloads.find((w) => w.groups.some((g) => g.groupId === MAIN))!

const decl: RunDecl = {
  runId: 'h100-tp8',
  model: 'qwen/qwen3-14b',
  workloadKey: mainW.workloadKey,
  workloadTitle: '500 requests at 6.0 req/s',
}

describe('LiveRunBanner, running', () => {
  const html = renderToStaticMarkup(
    <LiveRunBanner
      liveRun={{ status: 'running', decl }}
      onDismiss={() => {}}
      onReveal={() => {}}
    />,
  )

  it('announces politely without stealing focus', () => {
    expect(html).toMatch(/class="liverun"[^>]*role="status"[^>]*aria-live="polite"/)
  })

  it('shows a spinner, the run id, and the model · workload subline', () => {
    expect(html).toContain('class="liverun-spin"')
    expect(html).toContain('Running blis for')
    expect(html).toContain('h100-tp8')
    expect(html).toContain('qwen/qwen3-14b · 500 requests at 6.0 req/s')
  })

  it('notes it takes a few seconds of CPU, and offers no View button yet', () => {
    expect(html).toContain('few seconds of CPU')
    expect(html).not.toContain('View the run')
  })

  it('uses no em dashes in its copy', () => {
    expect(html).not.toContain('—')
  })
})

describe('LiveRunBanner, done', () => {
  const record = mainW.groups[0]!.complete[0]!
  const html = renderToStaticMarkup(
    <LiveRunBanner
      liveRun={{ status: 'done', decl, record }}
      onDismiss={() => {}}
      onReveal={() => {}}
    />,
  )

  it('says the run is in and offers a View the run control', () => {
    expect(html).toContain('is in.')
    expect(html).toContain('h100-tp8')
    expect(html).toMatch(/class="liverun-view"[^>]*>View the run</)
  })

  it('keeps a dismiss control so the banner can be cleared', () => {
    expect(html).toMatch(/class="liverun-dismiss"[^>]*aria-label="Dismiss this run notice"/)
  })

  it('drops the spinner once the run has landed', () => {
    expect(html).not.toContain('class="liverun-spin"')
  })
})

describe('ReadoutTable row ids (the reveal scroll target)', () => {
  const html = renderToStaticMarkup(<ReadoutTable workload={mainW} models={[]} />)

  it('gives every data row a stable run-<group_id>-<run_id> id', () => {
    for (const r of mainW.groups[0]!.complete) {
      expect(html).toContain(`id="${rowId(r)}"`)
      expect(html).toContain(`id="run-${MAIN}-${r.run_id}"`)
    }
  })

  it('gives the disqualified card the same kind of id, so a shed run can be revealed too', () => {
    const dq = mainW.groups[0]!.disqualified[0]!
    expect(html).toContain(`id="${rowId(dq)}"`)
  })

  it('carries no revealed highlight class at rest', () => {
    expect(html).not.toContain('class="revealed"')
  })
})
