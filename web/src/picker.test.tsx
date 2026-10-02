import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadWorkloads } from './load'
import type { RunRecord } from './load'
import {
  WorkloadPicker,
  ROWS_PER_PAGE,
  clampPage,
  columnsForWidth,
  pageBounds,
  pageCount,
} from './components/WorkloadPicker'

const records = fixture as unknown as RunRecord[]
const workloads = loadWorkloads(records) // the fixture's two workloads (differ by window)

describe('WorkloadPicker', () => {
  it('lists every workload by its title', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    for (const w of workloads) expect(html).toContain(w.title)
  })

  it('marks the selected workload as current and no other', () => {
    // Pick a workload by identity, not gallery position: the gallery is ordered by run count,
    // so which workload sits at a given index is not fixed.
    const target = workloads[workloads.length - 1]!
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={target.workloadKey} onSelect={() => {}} />,
    )
    const current = html.match(/aria-current="[^"]*"/g) ?? []
    expect(current).toHaveLength(1)
    const currentEntry = html.match(/<button[^>]*aria-current[\s\S]*?<\/button>/)?.[0]
    expect(currentEntry).toContain(target.title)
  })

  it('does not list the models — that choice is made inside the table, not the picker', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).not.toContain('qwen/qwen3-14b')
  })

  // The MAIN profile swept across a second offered load: one card, two levels.
  function sweep() {
    const at6 = records.filter((r) => r.group_id === '86575212efc8')
    const at10 = (JSON.parse(JSON.stringify(at6)) as RunRecord[]).map((r) => {
      ;(r.group.workload.spec as Record<string, unknown>).aggregate_rate = 10
      r.group_id = `l10-${r.group_id}`
      r.run_id = `l10-${r.run_id}`
      return r
    })
    return loadWorkloads([...at6, ...at10])
  }

  it('does not show a load-levels count on a sweep card (the Load filter shows levels once selected)', () => {
    const w = sweep()
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={w} selected={w[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).not.toContain('load levels')
  })

  it('tags the card with its load kind, colour-coded (rate in its own class)', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    // The fixture workloads are rate workloads, so the card carries the rose rate tag.
    expect(html).toContain('tag-rate')
    expect(html).toContain('>rate<')
  })

  it('tags a trace card as concurrency (its own class), not the internal "sessions" kind', () => {
    const rec = JSON.parse(JSON.stringify(records.find((r) => r.status.complete))) as RunRecord
    rec.group = JSON.parse(JSON.stringify(rec.group)) as RunRecord['group']
    rec.group.workload.type = 'trace'
    rec.group.workload.load = { kind: 'sessions', value: 1 }
    rec.group_id = 'traceg'
    rec.run_id = 'tr1'
    const w = loadWorkloads([rec])
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={w} selected={w[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).toContain('tag-concurrency')
    expect(html).toContain('>concurrency<')
    expect(html).not.toContain('>sessions<')
  })

  it('still shows ranked and disqualified run counts on the card', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).toContain('ranked')
  })

  // Before the gallery is laid out (server render, first paint) the column count is unknown,
  // so it is a single page of everything: every card is shown and no pager appears.
  it('shows every workload on one page when the column count is not yet measured', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    for (const w of workloads) expect(html).toContain(w.title)
    expect(html).not.toContain('Page 1 of')
  })
})

describe('workload gallery pagination', () => {
  it('derives columns from the gallery width with the grid track formula', () => {
    // minmax(240px, 1fr), 12px gap: 240 fits one, 500 fits two (2*240 + 12 = 492), 760
    // fits three (3*240 + 2*12 = 744).
    expect(columnsForWidth(240)).toBe(1)
    expect(columnsForWidth(500)).toBe(2)
    expect(columnsForWidth(760)).toBe(3)
    // Even a too-narrow container keeps one column; an unmeasured width is 0 (one page).
    expect(columnsForWidth(100)).toBe(1)
    expect(columnsForWidth(0)).toBe(0)
  })

  it('splits the workloads into pages of three rows of cards', () => {
    // 4 columns => 12 per page; 20 workloads span two pages.
    expect(pageCount(20, 4)).toBe(2)
    expect(pageCount(12, 4)).toBe(1)
    expect(pageCount(13, 4)).toBe(2)
    expect(ROWS_PER_PAGE).toBe(3)
  })

  it('keeps a single page while the column count is unknown', () => {
    expect(pageCount(20, 0)).toBe(1)
  })

  it('clamps an out-of-range page into the valid span after a resize shrinks it', () => {
    expect(clampPage(5, 20, 4)).toBe(1) // only two pages exist
    expect(clampPage(-1, 20, 4)).toBe(0)
  })

  it('slices the right cards for each page, with a short final page', () => {
    expect(pageBounds(20, 4, 0)).toEqual([0, 12])
    expect(pageBounds(20, 4, 1)).toEqual([12, 20])
    // Unknown columns: one page spanning everything.
    expect(pageBounds(20, 0, 0)).toEqual([0, 20])
  })
})
