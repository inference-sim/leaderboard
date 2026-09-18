import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixture from '../../prototypes/results.json'
import { loadWorkloads } from './load'
import type { RunRecord } from './load'
import { WorkloadPicker } from './components/WorkloadPicker'

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
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[1]!.workloadKey} onSelect={() => {}} />,
    )
    const current = html.match(/aria-current="[^"]*"/g) ?? []
    expect(current).toHaveLength(1)
    // The current entry is the second workload's, so it names the bounded window.
    const currentEntry = html.match(/<button[^>]*aria-current[\s\S]*?<\/button>/)?.[0]
    expect(currentEntry).toContain('bounded window')
  })

  it('does not list the models — that choice is made inside the table, not the picker', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).not.toContain('qwen/qwen3-14b')
  })
})
