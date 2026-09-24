import { describe, expect, it } from 'vitest'
import { getModelConfig, isMoE, listModels } from './models'
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
