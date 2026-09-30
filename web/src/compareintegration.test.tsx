import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { loadWorkloads, runKey } from './load'
import { ReadoutTable } from './components/ReadoutTable'

const records = fixture as unknown as RunRecord[]
const workloads = loadWorkloads(records)
const w = workloads[0]!
const someId = runKey(w.groups[0]!.complete[0]!)

/** The MAIN profile swept across a second load, so the same run_id appears at two load levels. */
function sweepWorkload(): ReturnType<typeof loadWorkloads>[number] {
  const at6 = records.filter((r) => r.group_id === w.groups[0]!.groupId)
  const at10 = (JSON.parse(JSON.stringify(at6)) as RunRecord[]).map((r) => {
    r.group.workload.load = { ...r.group.workload.load, value: 10 }
    r.group_id = `l10-${r.group_id}` // new comparability group; run_id is deliberately unchanged
    return r
  })
  return loadWorkloads([...at6, ...at10])[0]!
}

describe('ReadoutTable compare mode', () => {
  it('marks a selected row with the highlight class', () => {
    const html = renderToStaticMarkup(
      <ReadoutTable
        workload={w}
        models={w.models}
        compareMode
        selectedIds={[someId]}
        onToggleHighlight={() => {}}
      />,
    )
    expect(html).toMatch(/class="[^"]*cmphl[^"]*"/)
  })

  it('highlights only the selected run, not its run_id twins at other load levels', () => {
    // Selecting one (group_id, run_id) must not light up the same run_id at another load —
    // the bug that keying on run_id alone caused once the table spanned load levels.
    const sweep = sweepWorkload()
    const target = sweep.complete.find((r) => r.group_id.startsWith('l10-'))!
    const html = renderToStaticMarkup(
      <ReadoutTable
        workload={sweep}
        models={sweep.models}
        compareMode
        selectedIds={[runKey(target)]}
        onToggleHighlight={() => {}}
      />,
    )
    // Exactly one ranked row carries the highlight, though two rows share the run_id.
    const twins = sweep.complete.filter((r) => r.run_id === target.run_id)
    expect(twins.length).toBeGreaterThan(1)
    expect((html.match(/cmphl/g) ?? []).length).toBe(1)
  })

  it('does not mark any row when not in compare mode', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={w} models={w.models} />)
    expect(html).not.toContain('cmphl')
  })

  it('gives every sweep row a unique React key — no duplicate-key warning across load twins', () => {
    // The bug: rows keyed on run_id collide when a run_id repeats across load levels, which
    // breaks React reconciliation (stale/doubled rows, misplaced highlights). Keys are runKey now.
    const sweep = sweepWorkload()
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '))
    })
    renderToStaticMarkup(<ReadoutTable workload={sweep} models={sweep.models} />)
    spy.mockRestore()
    expect(errors.join('\n')).not.toMatch(/same key/i)
  })
})
