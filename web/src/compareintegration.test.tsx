import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import type { RunRecord } from './load'
import { loadWorkloads } from './load'
import { ReadoutTable } from './components/ReadoutTable'

const records = fixture as unknown as RunRecord[]
const workloads = loadWorkloads(records)
const w = workloads[0]!
const someId = w.groups[0]!.complete[0]!.run_id

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

  it('does not mark any row when not in compare mode', () => {
    const html = renderToStaticMarkup(<ReadoutTable workload={w} models={w.models} />)
    expect(html).not.toContain('cmphl')
  })
})
