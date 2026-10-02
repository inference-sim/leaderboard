import { describe, expect, it } from 'vitest'
import { fetchVersion } from './version'

// A fetch stub returning the given status and body, matching the one results.test.ts uses.
function stubFetch(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
}

describe('fetchVersion', () => {
  it('returns the three dependency versions when /api/version resolves', async () => {
    const got = await fetchVersion(
      stubFetch(200, JSON.stringify({ leaderboard: 'v0.1.7', blis: 'v1.4.0', catalog: '2026-09-30' })),
    )
    expect(got).toEqual({ leaderboard: 'v0.1.7', blis: 'v1.4.0', catalog: '2026-09-30' })
  })

  it('rejects on a 404 (no such route) so the footer stays hidden', async () => {
    await expect(fetchVersion(stubFetch(404, '{"error":"not found"}'))).rejects.toThrow()
  })

  it('rejects when the fetch itself fails (no server at all — the static build)', async () => {
    const dead: typeof fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(fetchVersion(dead)).rejects.toThrow()
  })

  it('rejects when the body is not the expected shape (an older serve returns index.html via the SPA catch-all)', async () => {
    await expect(fetchVersion(stubFetch(200, '<!doctype html><title>app</title>'))).rejects.toThrow()
  })
})
