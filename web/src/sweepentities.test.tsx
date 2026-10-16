import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { groupSweeps } from './sweep'
import { SweepList, SweepScope } from './App'

const clone = () => JSON.parse(JSON.stringify(fixture)) as RunRecord[]

describe('SweepList', () => {
  it('lists each sweep by title and id, newest first', () => {
    const recs = clone().slice(0, 3)
    recs[0]!.sweep_id = 'swp-1-old'
    recs[0]!.sweep_label = 'first sweep'
    recs[1]!.sweep_id = 'swp-2-new'
    recs[1]!.sweep_label = 'second sweep'
    // recs[2] has no sweep_id and must not appear.
    const entries = groupSweeps(recs)
    const html = renderToStaticMarkup(
      <SweepList entries={entries} selected={entries[0]!.sweepId} onSelect={() => {}} />,
    )
    expect(html).toContain('first sweep')
    expect(html).toContain('second sweep')
    expect(html).toContain('swp-1-old')
    expect(html).toContain('swp-2-new')
    // Newest first: the swp-2 heading comes before swp-1 in the document.
    expect(html.indexOf('second sweep')).toBeLessThan(html.indexOf('first sweep'))
  })

  it('marks the selected sweep card as current and no other', () => {
    const recs = clone().slice(0, 2)
    recs[0]!.sweep_id = 'swp-1-a'
    recs[1]!.sweep_id = 'swp-2-b'
    const entries = groupSweeps(recs)
    const html = renderToStaticMarkup(
      <SweepList entries={entries} selected="swp-1-a" onSelect={() => {}} />,
    )
    expect((html.match(/wpick-card cur/g) ?? []).length).toBe(1)
    expect(html).toContain('aria-current="page"')
  })

  it('shows an empty-state prompt when there are no sweeps', () => {
    const html = renderToStaticMarkup(<SweepList entries={[]} selected={null} onSelect={() => {}} />)
    expect(html).toContain('No sweeps yet')
  })
})

describe('SweepScope', () => {
  it('scopes the rendered table to only the sweep’s runs', () => {
    const recs = clone().filter((r) => r.group_id === '86575212efc8')
    // Tag two runs as a sweep; the rest stay in the same workload but outside the sweep.
    recs[0]!.sweep_id = recs[1]!.sweep_id = 'swp-scope' // h100-tp1, h100-tp2
    const entry = groupSweeps(recs).find((e) => e.sweepId === 'swp-scope')!
    const html = renderToStaticMarkup(
      <SweepScope
        records={recs}
        entry={entry}
        revealTarget={null}
        onRevealed={() => {}}
        canDelete={false}
        onDelete={() => {}}
      />,
    )
    // The two swept runs appear (each row's repro control names its run_id)...
    expect(html).toContain('h100-tp1')
    expect(html).toContain('h100-tp2')
    // ...and a sibling run in the same workload but outside the sweep does not.
    expect(html).not.toContain('a100-tp1')
    expect(html).not.toContain('l40s-tp2')
  })

  it('says so when the selected sweep has no runs left on the board', () => {
    const recs = clone()
    const entry = {
      sweepId: 'swp-gone',
      label: null,
      title: 'gone',
      workload: 'x',
      date: null,
      runCount: 0,
      records: [],
    }
    const html = renderToStaticMarkup(
      <SweepScope
        records={recs}
        entry={entry}
        revealTarget={null}
        onRevealed={() => {}}
        canDelete={false}
        onDelete={() => {}}
      />,
    )
    expect(html).toContain('no runs on the board')
  })
})
