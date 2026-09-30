import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelFilter } from './components/ModelFilter'
import { HardwareFilter } from './components/HardwareFilter'
import { LoadFilter } from './components/LoadFilter'
import { EmptyFilterNote } from './components/EmptyFilterNote'
import { emptyFilterNoun, keptByFilters, nextSelection } from './filter'
import type { RunRecord } from './load'

const models = ['meta/llama-3-8b', 'qwen/qwen3-14b']
const hardware = ['A100-SXM', 'H100', 'L40S']

/** A minimal record carrying just the fields the filter reads. */
function rec(model: string, hw: string): RunRecord {
  return { deployment: { model, hardware: hw } } as unknown as RunRecord
}

/** As `rec`, plus the offered-load value the load filter reads. */
function recL(model: string, hw: string, load: number): RunRecord {
  return {
    deployment: { model, hardware: hw },
    group: { workload: { load: { kind: 'rate', value: load } } },
  } as unknown as RunRecord
}

/** The selectable bubbles, i.e. everything but the Clear button. */
function tags(html: string): string[] {
  return html.match(/<button[^>]*class="tag"[^>]*>[\s\S]*?<\/button>/g) ?? []
}

describe('nextSelection (the toggle result)', () => {
  it('turns an unselected option on, preserving display order not click order', () => {
    expect(nextSelection(hardware, ['L40S'], 'A100-SXM')).toEqual(['A100-SXM', 'L40S'])
  })

  it('turns a selected option off', () => {
    expect(nextSelection(hardware, ['A100-SXM', 'H100'], 'H100')).toEqual(['A100-SXM'])
  })

  it('deselecting the last selected option yields none — it never snaps back to all', () => {
    // The bug this fixes: turning off the final bubble used to canonicalise to the
    // empty array, which the app read as "no filter → show everything".
    expect(nextSelection(models, ['qwen/qwen3-14b'], 'qwen/qwen3-14b')).toEqual([])
  })

  it('selecting the final missing option yields the full literal list, not an empty "all"', () => {
    expect(nextSelection(models, ['meta/llama-3-8b'], 'qwen/qwen3-14b')).toEqual(models)
  })
})

describe('emptyFilterNoun (which shown filter, if any, has nothing selected)', () => {
  it('names models when the model filter is shown and nothing is selected', () => {
    expect(emptyFilterNoun(true, [], true, hardware)).toBe('models')
  })

  it('names hardware types when models are selected but hardware is emptied', () => {
    expect(emptyFilterNoun(true, models, true, [])).toBe('hardware types')
  })

  it('is null when both shown filters have a selection', () => {
    expect(emptyFilterNoun(true, models, true, hardware)).toBeNull()
  })

  it('ignores an empty array for a filter that is not shown', () => {
    expect(emptyFilterNoun(false, [], true, hardware)).toBeNull()
  })
})

describe('keptByFilters (the model + hardware row predicate the table and Select all share)', () => {
  it('keeps a record whose model and hardware are both in the selected sets', () => {
    expect(keptByFilters(rec('qwen/qwen3-14b', 'H100'), models, models, hardware)).toBe(true)
  })

  it('drops a record whose model was filtered out, even if its hardware is kept', () => {
    // Select all after narrowing the model filter must not pull this back in.
    expect(keptByFilters(rec('meta/llama-3-8b', 'H100'), ['qwen/qwen3-14b'], models, hardware)).toBe(
      false,
    )
  })

  it('drops a record whose hardware was filtered out, even if its model is kept', () => {
    expect(keptByFilters(rec('qwen/qwen3-14b', 'L40S'), models, models, ['H100'])).toBe(false)
  })

  it('reads an empty model selection as "all models" via the allModels fallback', () => {
    expect(keptByFilters(rec('meta/llama-3-8b', 'H100'), [], models, hardware)).toBe(true)
  })

  it('reads an empty hardware selection as "all hardware"', () => {
    expect(keptByFilters(rec('qwen/qwen3-14b', 'L40S'), models, models, [])).toBe(true)
  })

  it('keeps a record whose offered load is in the selected load levels', () => {
    expect(keptByFilters(recL('qwen/qwen3-14b', 'H100', 10), models, models, hardware, [6, 10])).toBe(true)
  })

  it('drops a record whose load level was filtered out', () => {
    expect(keptByFilters(recL('qwen/qwen3-14b', 'H100', 20), models, models, hardware, [6, 10])).toBe(false)
  })

  it('reads an empty load selection as "all loads"', () => {
    expect(keptByFilters(recL('qwen/qwen3-14b', 'H100', 20), models, models, hardware, [])).toBe(true)
  })
})

describe('emptyFilterNoun — load levels', () => {
  it('names load levels when the load filter is shown and emptied', () => {
    expect(emptyFilterNoun(true, models, true, hardware, true, [])).toBe('load levels')
  })

  it('ignores an empty load array when the load filter is not shown', () => {
    expect(emptyFilterNoun(true, models, true, hardware, false, [])).toBeNull()
  })
})

describe('LoadFilter', () => {
  it('renders one bubble per rate level, labelled with one decimal, and names the rate axis', () => {
    const html = renderToStaticMarkup(
      <LoadFilter kind="rate" options={[6, 10]} selected={[6, 10]} onChange={() => {}} />,
    )
    expect(tags(html)).toHaveLength(2)
    expect(html).toContain('6.0')
    expect(html).toContain('10.0')
    expect(html.toLowerCase()).toContain('rate')
    expect(html).not.toContain('type="checkbox"')
  })

  it('labels a concurrency axis with integers and names concurrency', () => {
    const html = renderToStaticMarkup(
      <LoadFilter kind="concurrency" options={[16, 32]} selected={[16, 32]} onChange={() => {}} />,
    )
    expect(html).toContain('>16<')
    expect(html).toContain('>32<')
    expect(html.toLowerCase()).toContain('concurrency')
  })

  it('presses only the selected levels', () => {
    const html = renderToStaticMarkup(
      <LoadFilter kind="rate" options={[6, 10]} selected={[10]} onChange={() => {}} />,
    )
    const six = html.match(/<button[^>]*value="6.0"[^>]*>/)?.[0]
    const ten = html.match(/<button[^>]*value="10.0"[^>]*>/)?.[0]
    expect(six).toContain('aria-pressed="false"')
    expect(ten).toContain('aria-pressed="true"')
  })
})

describe('EmptyFilterNote', () => {
  it('tells the reader to pick a value for the emptied filter', () => {
    const html = renderToStaticMarkup(<EmptyFilterNote noun="models" />)
    expect(html).toContain('No models selected')
    expect(html.toLowerCase()).toContain('pick')
  })
})

describe('ModelFilter', () => {
  it('renders one selectable bubble per model, in the order given — no checkboxes', () => {
    const html = renderToStaticMarkup(
      <ModelFilter models={models} selected={models} onChange={() => {}} />,
    )
    expect(html).not.toContain('type="checkbox"')
    expect(tags(html)).toHaveLength(2)
    expect(html.indexOf('meta/llama-3-8b')).toBeLessThan(html.indexOf('qwen/qwen3-14b'))
  })

  it('reflects the selection: a selected bubble is pressed, an unselected one is not', () => {
    const html = renderToStaticMarkup(
      <ModelFilter models={models} selected={['qwen/qwen3-14b']} onChange={() => {}} />,
    )
    const qwenTag = html.match(/<button[^>]*value="qwen\/qwen3-14b"[^>]*>/)?.[0]
    const llamaTag = html.match(/<button[^>]*value="meta\/llama-3-8b"[^>]*>/)?.[0]
    expect(qwenTag).toContain('aria-pressed="true"')
    expect(llamaTag).toContain('aria-pressed="false"')
  })

  it('with every model selected, presses them all and still offers enabled Show all / Clear', () => {
    const html = renderToStaticMarkup(
      <ModelFilter models={models} selected={models} onChange={() => {}} />,
    )
    expect(html.toLowerCase()).toContain('all models')
    expect(html).toContain('Show all')
    expect(html).toContain('Clear')
    expect(html).not.toContain('disabled')
    expect(tags(html)).toHaveLength(2)
    expect(html).not.toContain('aria-pressed="false"')
  })

  it('with none selected, presses nothing, summarises "no models", and still offers enabled Show all / Clear', () => {
    const html = renderToStaticMarkup(<ModelFilter models={models} selected={[]} onChange={() => {}} />)
    expect(html.toLowerCase()).toContain('no models')
    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toContain('Show all')
    expect(html).toContain('Clear')
    expect(html).not.toContain('disabled')
  })

  it('offers an enabled Clear when a strict subset is selected', () => {
    const html = renderToStaticMarkup(
      <ModelFilter models={models} selected={['qwen/qwen3-14b']} onChange={() => {}} />,
    )
    expect(html).toContain('Clear')
    expect(html).not.toContain('disabled')
    expect(html).toContain('1 of 2')
  })
})

describe('HardwareFilter', () => {
  it('renders one selectable bubble per hardware type, in the order given', () => {
    const html = renderToStaticMarkup(
      <HardwareFilter options={hardware} selected={hardware} onChange={() => {}} />,
    )
    expect(html).not.toContain('type="checkbox"')
    expect(tags(html)).toHaveLength(3)
    expect(html.indexOf('A100-SXM')).toBeLessThan(html.indexOf('H100'))
    expect(html.indexOf('H100')).toBeLessThan(html.indexOf('L40S'))
  })

  it('with every type selected presses all bubbles and still offers an enabled Clear; with a bubble deselected reflects and keeps Clear enabled', () => {
    const all = renderToStaticMarkup(
      <HardwareFilter options={hardware} selected={hardware} onChange={() => {}} />,
    )
    expect(all.toLowerCase()).toContain('all hardware')
    expect(all).not.toContain('aria-pressed="false"')
    expect(all).toContain('Clear')
    expect(all).not.toContain('disabled')

    const html = renderToStaticMarkup(
      <HardwareFilter options={hardware} selected={['H100']} onChange={() => {}} />,
    )
    const h100 = html.match(/<button[^>]*value="H100"[^>]*>/)?.[0]
    const a100 = html.match(/<button[^>]*value="A100-SXM"[^>]*>/)?.[0]
    expect(h100).toContain('aria-pressed="true"')
    expect(a100).toContain('aria-pressed="false"')
    expect(html).toContain('1 of 3')
    expect(html).toContain('Clear')
    expect(html).not.toContain('disabled')
  })

  it('with none selected, presses nothing and offers an enabled Clear', () => {
    const html = renderToStaticMarkup(
      <HardwareFilter options={hardware} selected={[]} onChange={() => {}} />,
    )
    expect(html).not.toContain('aria-pressed="true"')
    expect(html.toLowerCase()).toContain('no hardware')
    expect(html).toContain('Clear')
    expect(html).not.toContain('disabled')
  })
})
