import { describe, expect, it } from 'vitest'
import {
  contextMeterFraction,
  familyKey,
  filterModels,
  formatContext,
  getModelConfig,
  groupByFamily,
  isMoE,
  listModels,
  modelOf,
  orgOf,
  precision,
} from './models'
import type { ModelDetail, ModelInfo } from './models'

const catalog: ModelInfo[] = [
  { name: 'qwen/qwen3-14b', moe: false },
  { name: 'mistralai/mixtral-8x7b-v0.1', moe: true },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('isMoE', () => {
  it('is true only for a name the catalog lists as MoE', () => {
    expect(isMoE(catalog, 'mistralai/mixtral-8x7b-v0.1')).toBe(true)
    expect(isMoE(catalog, 'qwen/qwen3-14b')).toBe(false)
  })

  it('treats an unknown name as dense', () => {
    expect(isMoE(catalog, 'gpt-4')).toBe(false)
    expect(isMoE([], 'qwen/qwen3-14b')).toBe(false)
  })
})

describe('listModels', () => {
  it('returns the models the server sends', async () => {
    const fakeFetch = (async (url) => {
      expect(String(url)).toBe('/api/models')
      return jsonResponse({ models: catalog })
    }) as typeof fetch
    expect(await listModels(fakeFetch)).toEqual(catalog)
  })

  it('returns an empty list when the server sends none', async () => {
    const fakeFetch = (async () => jsonResponse({ models: [] })) as typeof fetch
    expect(await listModels(fakeFetch)).toEqual([])
  })

  it('explains how to start the server when the fetch itself fails', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(listModels(fakeFetch)).rejects.toThrow(/leaderboard serve/)
  })

  it('throws the server {error} on an HTTP error', async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: 'set BLIS_CATALOG to a blis-catalog clone' }, 500)) as typeof fetch
    await expect(listModels(fakeFetch)).rejects.toThrow(/BLIS_CATALOG/)
  })
})

describe('orgOf / modelOf', () => {
  it('splits a canonical org/model name into its halves', () => {
    expect(orgOf('meta-llama/llama-3.1-8b-instruct')).toBe('meta-llama')
    expect(modelOf('meta-llama/llama-3.1-8b-instruct')).toBe('llama-3.1-8b-instruct')
  })

  it('treats a name with no slash as all model, no org', () => {
    expect(orgOf('solo')).toBe('')
    expect(modelOf('solo')).toBe('solo')
  })
})

describe('familyKey', () => {
  it('is the leading letters of the model half, so version digits do not split a family', () => {
    expect(familyKey('qwen/qwen3-30b-a3b')).toBe('qwen')
    expect(familyKey('qwen/qwen2.5-7b-instruct')).toBe('qwen')
    expect(familyKey('meta-llama/llama-3.1-8b-instruct')).toBe('llama')
  })

  it('groups a family that ships under different orgs together', () => {
    // llama-4-scout is published under redhatai but is a Llama.
    expect(familyKey('redhatai/llama-4-scout-17b-16e-instruct-fp8-dynamic')).toBe('llama')
    expect(familyKey('meta-llama/llama-2-70b-hf')).toBe('llama')
  })
})

describe('groupByFamily', () => {
  const models: ModelInfo[] = [
    { name: 'mistralai/mixtral-8x7b-v0.1', moe: true },
    { name: 'meta-llama/llama-3.1-8b-instruct', moe: false },
    { name: 'redhatai/llama-4-scout', moe: true },
    { name: 'qwen/qwen3-14b', moe: false },
  ]

  it('buckets by family label and orders biggest family first', () => {
    const fams = groupByFamily(models)
    expect(fams.map((f) => f.label)).toEqual(['Llama', 'Mixtral', 'Qwen'])
    // Llama collects both meta-llama and redhatai entries.
    const llama = fams.find((f) => f.label === 'Llama')
    expect(llama?.models.map((m) => m.name)).toEqual([
      'meta-llama/llama-3.1-8b-instruct',
      'redhatai/llama-4-scout',
    ])
  })
})

describe('formatContext', () => {
  it('renders token counts compactly and reports an absent one', () => {
    expect(formatContext(4096)).toBe('4K')
    expect(formatContext(131072)).toBe('128K')
    expect(formatContext(1048576)).toBe('1M')
    expect(formatContext(10485760)).toBe('10M')
    expect(formatContext(undefined)).toBeNull()
    expect(formatContext(0)).toBeNull()
  })
})

describe('contextMeterFraction', () => {
  it('places the ends of the catalog range at 0 and 1 and clamps outside it', () => {
    expect(contextMeterFraction(4096)).toBeCloseTo(0, 5)
    expect(contextMeterFraction(10485760)).toBeCloseTo(1, 5)
    expect(contextMeterFraction(undefined)).toBe(0)
    // A mid value lands between the ends.
    const mid = contextMeterFraction(131072)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
})

describe('precision', () => {
  it('reads torch_dtype when config.json carries it', () => {
    expect(precision({ name: 'x/y', moe: false, spec: { dtype: 'bfloat16' } })).toEqual({
      label: 'BF16',
      derived: false,
    })
    expect(precision({ name: 'x/y', moe: false, spec: { dtype: 'float16' } })).toEqual({
      label: 'FP16',
      derived: false,
    })
  })

  it('falls back to the name suffix and marks it derived when the config omits torch_dtype', () => {
    expect(precision({ name: 'nvidia/nemotron-3-ultra-550b-a55b-nvfp4', moe: true, spec: {} })).toEqual({
      label: 'NVFP4',
      derived: true,
    })
    expect(precision({ name: 'zai-org/glm-5.2-fp8', moe: true, spec: {} })).toEqual({
      label: 'FP8',
      derived: true,
    })
  })

  it('is null when neither the config nor the name states a precision', () => {
    expect(precision({ name: 'zai-org/glm-5.2', moe: true, spec: {} })).toBeNull()
  })
})

describe('filterModels', () => {
  const models: ModelInfo[] = [
    { name: 'qwen/qwen3-14b', moe: false, spec: { modelType: 'qwen3' } },
    { name: 'qwen/qwen3-30b-a3b', moe: true, spec: { modelType: 'qwen3_moe' } },
    { name: 'meta-llama/llama-3.1-8b-instruct', moe: false, spec: { modelType: 'llama' } },
  ]

  it('returns everything for a blank query and the "all" kind', () => {
    expect(filterModels(models, '', 'all')).toHaveLength(3)
  })

  it('filters by dense or MoE', () => {
    expect(filterModels(models, '', 'moe').map((m) => m.name)).toEqual(['qwen/qwen3-30b-a3b'])
    expect(filterModels(models, '', 'dense')).toHaveLength(2)
  })

  it('matches the query against the name, family, and model_type', () => {
    expect(filterModels(models, 'llama', 'all')).toHaveLength(1)
    // Family label is searchable even though it is not in the raw name.
    expect(filterModels(models, 'qwen', 'all')).toHaveLength(2)
    expect(filterModels(models, 'moe', 'all').map((m) => m.name)).toEqual(['qwen/qwen3-30b-a3b'])
  })
})

describe('getModelConfig', () => {
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

  it('requests the named model and returns its detail', async () => {
    const fakeFetch = (async (url) => {
      // The name is query-encoded (the slash survives as %2F).
      expect(String(url)).toBe('/api/models/config?name=qwen%2Fqwen3-30b-a3b')
      return jsonResponse(detail)
    }) as typeof fetch
    expect(await getModelConfig('qwen/qwen3-30b-a3b', fakeFetch)).toEqual(detail)
  })

  it('throws the server {error} for an unknown model (404)', async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: '"acme/nope": model not found in catalog' }, 404)) as typeof fetch
    await expect(getModelConfig('acme/nope', fakeFetch)).rejects.toThrow(/not found/)
  })

  it('explains how to start the server when the fetch itself fails', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(getModelConfig('qwen/qwen3-14b', fakeFetch)).rejects.toThrow(/leaderboard serve/)
  })
})
