import { describe, expect, it } from 'vitest'
import { isMoE, listModels } from './models'
import type { ModelInfo } from './models'

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
