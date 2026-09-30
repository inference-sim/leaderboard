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

  // The MAIN profile swept across a second offered load: one card, two levels.
  function sweep() {
    const at6 = records.filter((r) => r.group_id === '5063e40dceb2')
    const at10 = (JSON.parse(JSON.stringify(at6)) as RunRecord[]).map((r) => {
      r.group.workload.load = { ...r.group.workload.load, value: 10 }
      r.group_id = `l10-${r.group_id}`
      r.run_id = `l10-${r.run_id}`
      return r
    })
    return loadWorkloads([...at6, ...at10])
  }

  it('counts the load levels of a sweep on its card', () => {
    const w = sweep()
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={w} selected={w[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).toContain('2 load levels')
  })

  it('tags the card with the load kind being varied', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).toContain('tag-load')
    expect(html).toContain('>rate<') // the fixture workloads are rate distributions
  })

  it('omits the load-levels count for a single-load workload', () => {
    const html = renderToStaticMarkup(
      <WorkloadPicker workloads={workloads} selected={workloads[0]!.workloadKey} onSelect={() => {}} />,
    )
    expect(html).not.toContain('load levels')
  })
})
