import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ModelsList,
  ModelConfigView,
  HardwareCatalog,
  catalogTabFromHash,
} from './components/Catalog'
import type { ModelInfo, ModelDetail } from './models'
import type { HardwareInfo } from './hardware'

describe('catalogTabFromHash', () => {
  it('opens on Workloads (the first tab) for the bare catalog hash', () => {
    expect(catalogTabFromHash('#/catalog')).toBe('workloads')
    expect(catalogTabFromHash('#/catalog/workloads')).toBe('workloads')
    // The Declare form's workload hand-off carries a ?workload= query after the tab.
    expect(catalogTabFromHash('#/catalog/workloads?workload=chat-6rps')).toBe('workloads')
  })

  it('selects Models or Hardware for their suffixes', () => {
    expect(catalogTabFromHash('#/catalog/models')).toBe('models')
    expect(catalogTabFromHash('#/catalog/hardware')).toBe('hardware')
  })

  it('honours the old top-level deep links', () => {
    // #/models, #/hardware and #/workloads were top-level tabs before the merge; they still
    // pick the right inner tab so bookmarks and the workload hand-off keep working.
    expect(catalogTabFromHash('#/hardware')).toBe('hardware')
    expect(catalogTabFromHash('#/models')).toBe('models')
    expect(catalogTabFromHash('#/workloads?workload=chat-6rps')).toBe('workloads')
  })
})

const models: ModelInfo[] = [
  {
    name: 'meta-llama/llama-3.1-8b-instruct',
    moe: false,
    spec: { arch: 'LlamaForCausalLM', context: 131072, layers: 32, hidden: 4096, heads: 32, kvHeads: 8, dtype: 'bfloat16' },
  },
  {
    name: 'qwen/qwen3-14b',
    moe: false,
    spec: { arch: 'Qwen3ForCausalLM', context: 40960, layers: 40, hidden: 5120, heads: 40, kvHeads: 8, dtype: 'bfloat16' },
  },
  {
    name: 'qwen/qwen3-30b-a3b',
    moe: true,
    spec: { arch: 'Qwen3MoeForCausalLM', context: 40960, layers: 48, hidden: 2048, heads: 32, kvHeads: 4, dtype: 'bfloat16', experts: 128, active: 8 },
  },
  {
    // A Llama-family model that ships under a different org (redhatai), so grouping by family
    // must collect it with meta-llama's Llamas rather than filing it under its org.
    name: 'redhatai/llama-4-scout-17b-16e-instruct-fp8-dynamic',
    moe: true,
    spec: { arch: 'Llama4ForConditionalGeneration', context: 10485760, layers: 48, hidden: 5120, heads: 40, kvHeads: 8, dtype: 'bfloat16', experts: 16, active: 1 },
  },
  {
    name: 'mistralai/mixtral-8x7b-v0.1',
    moe: true,
    spec: { arch: 'MixtralForCausalLM', context: 32768, layers: 32, hidden: 4096, heads: 32, kvHeads: 8, dtype: 'bfloat16', experts: 8, active: 2 },
  },
]

const noop = () => {}
const none = () => undefined

describe('ModelsList', () => {
  it('groups models by family, not by provider org', () => {
    const html = renderToStaticMarkup(
      <ModelsList models={models} expanded={null} onToggle={noop} configFor={none} />,
    )
    // Family headings, not org headings.
    for (const family of ['Llama', 'Qwen', 'Mixtral']) {
      expect(html).toContain(`>${family}</h3>`)
    }
    // The org is a per-card kicker, never a group heading — llama-4-scout's redhatai org must
    // not become its own family.
    expect(html).not.toContain('>redhatai</h3>')
    expect(html).toContain('llama-4-scout-17b-16e-instruct-fp8-dynamic')
  })

  it('badges each model dense or MoE', () => {
    const html = renderToStaticMarkup(
      <ModelsList models={models} expanded={null} onToggle={noop} configFor={none} />,
    )
    expect(html.match(/badge moe/g)).toHaveLength(3)
    expect(html.match(/badge dense/g)).toHaveLength(2)
  })

  it('shows each model’s architecture spec on the card face', () => {
    const html = renderToStaticMarkup(
      <ModelsList models={models} expanded={null} onToggle={noop} configFor={none} />,
    )
    // The context window is formatted and metered; the widest model reaches 10M.
    expect(html).toContain('Context window')
    expect(html).toContain('10M')
    expect(html).toContain('128K')
    // MoE cards show the active/total expert split.
    expect(html).toContain('128 total')
    expect(html).toContain('8 active')
    // The architecture is named.
    expect(html).toContain('Qwen3MoeForCausalLM')
  })

  it('shows no config panel until a model is opened', () => {
    const html = renderToStaticMarkup(
      <ModelsList models={models} expanded={null} onToggle={noop} configFor={none} />,
    )
    // Every card is collapsed.
    expect(html).not.toContain('aria-expanded="true"')
    expect(html).not.toContain('config.json')
  })

  it('renders the open model’s config inline', () => {
    const detail: ModelDetail = {
      name: 'qwen/qwen3-30b-a3b',
      moe: true,
      source: {
        provider: 'huggingface',
        repo: 'Qwen/Qwen3-30B-A3B',
        revision: 'abc123',
        retrieved: '',
      },
      config: '{\n  "num_experts": 128\n}',
    }
    const html = renderToStaticMarkup(
      <ModelsList
        models={models}
        expanded="qwen/qwen3-30b-a3b"
        onToggle={noop}
        configFor={(n) => (n === 'qwen/qwen3-30b-a3b' ? { status: 'ready', detail } : undefined)}
      />,
    )
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('num_experts')
    expect(html).toContain('Qwen/Qwen3-30B-A3B')
  })

  it('shows a load note while the open model’s config is in flight', () => {
    const html = renderToStaticMarkup(
      <ModelsList
        models={models}
        expanded="qwen/qwen3-14b"
        onToggle={noop}
        configFor={(n) => (n === 'qwen/qwen3-14b' ? { status: 'loading' } : undefined)}
      />,
    )
    expect(html.toLowerCase()).toContain('reading the config')
  })

  it('reports an empty catalog rather than a blank list', () => {
    const html = renderToStaticMarkup(
      <ModelsList models={[]} expanded={null} onToggle={noop} configFor={none} />,
    )
    expect(html.toLowerCase()).toContain('no models')
    expect(html).toContain('BLIS_CATALOG')
  })
})

describe('ModelConfigView', () => {
  it('shows the model.yaml provenance as tags beside the config.json', () => {
    const detail: ModelDetail = {
      name: 'qwen/qwen3-30b-a3b',
      moe: true,
      source: {
        provider: 'huggingface',
        repo: 'Qwen/Qwen3-30B-A3B',
        revision: 'abc123',
        retrieved: '2026-09-16',
      },
      config: '{\n  "num_experts": 128\n}',
    }
    const html = renderToStaticMarkup(<ModelConfigView detail={detail} />)
    // Each present source field is a labeled tag, not raw YAML.
    for (const label of ['provider', 'repo', 'revision', 'retrieved']) {
      expect(html).toContain(`>${label}</dt>`)
    }
    expect(html).toContain('huggingface')
    expect(html).toContain('abc123')
    expect(html).toContain('2026-09-16')
    // The HuggingFace repo links to its page.
    expect(html).toContain('href="https://huggingface.co/Qwen/Qwen3-30B-A3B"')
    // config.json sits beside the tags, still as a copyable block.
    expect(html).toContain('config.json')
    expect(html).toContain('num_experts')
  })

  it('omits a tag for a source field model.yaml does not carry', () => {
    const detail: ModelDetail = {
      name: 'someorg/dense',
      moe: false,
      source: { provider: 'huggingface', repo: 'someorg/Dense', revision: '', retrieved: '' },
      config: '',
    }
    const html = renderToStaticMarkup(<ModelConfigView detail={detail} />)
    expect(html).toContain('>provider</dt>')
    expect(html).toContain('>repo</dt>')
    // No revision or retrieved recorded, so neither tag appears.
    expect(html).not.toContain('>revision</dt>')
    expect(html).not.toContain('>retrieved</dt>')
    // config.json is absent, so the panel says so.
    expect(html.toLowerCase()).toContain('no config.json')
  })
})

const hardware: HardwareInfo[] = [
  {
    name: 'A100-80',
    aliases: ['A100-SXM'],
    spec: { MemoryGiB: 80, BwPeakTBs: 2.039, TFlopsPeak: 312, TFlopsFP8: 0 },
  },
  {
    name: 'A100-SXM',
    aliases: ['A100-80'],
    spec: { MemoryGiB: 80, BwPeakTBs: 2.039, TFlopsPeak: 312, TFlopsFP8: 0 },
  },
  {
    name: 'H100',
    aliases: [],
    spec: { MemoryGiB: 80, BwPeakTBs: 3.35, TFlopsPeak: 989.5, TFlopsFP8: 1979 },
  },
]

describe('HardwareCatalog', () => {
  it('labels the specs with units', () => {
    const html = renderToStaticMarkup(<HardwareCatalog hardware={hardware} />)
    expect(html).toContain('Memory')
    expect(html).toContain('80 GiB')
    expect(html).toContain('3.35 TB/s')
    expect(html).toContain('989.5 TFLOPs')
  })

  it('collapses a spec-identical alias pair into one card that names the other', () => {
    const html = renderToStaticMarkup(<HardwareCatalog hardware={hardware} />)
    expect(html.match(/class="hw-card"/g)).toHaveLength(2)
    // The more specific name (A100-SXM) is the card title; the shorter A100-80 is its alias.
    expect(html).toContain('A100-SXM')
    expect(html).toContain('also A100-80')
  })

  it('shows a zero FP8 spec as "none", not a bare zero', () => {
    const html = renderToStaticMarkup(<HardwareCatalog hardware={hardware} />)
    expect(html).toContain('none') // A100 has no FP8 path
    expect(html).toContain('1979 TFLOPs') // H100 does
  })

  it('reports an empty catalog', () => {
    const html = renderToStaticMarkup(<HardwareCatalog hardware={[]} />)
    expect(html.toLowerCase()).toContain('no accelerators')
  })

  // The server marshals an accelerator with no aliases as `"aliases": null` (a nil Go
  // slice), not `[]`. Spreading null would throw and blank the whole page, so a null must
  // render as cleanly as an empty list.
  it('renders an accelerator whose aliases come back null', () => {
    const withNull = [
      { name: 'H100', aliases: null, spec: { MemoryGiB: 80, TFlopsPeak: 989.5 } },
    ] as unknown as HardwareInfo[]
    const html = renderToStaticMarkup(<HardwareCatalog hardware={withNull} />)
    expect(html).toContain('H100')
    expect(html).toContain('80 GiB')
    expect(html).not.toContain('also ')
  })
})
