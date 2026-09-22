import { describe, it, expect } from 'vitest'
import { deleteRun, fetchResults } from './results'

describe('results api client', () => {
  it('fetchResults GETs the results endpoint and returns the records', async () => {
    let seen: string | null = null
    const fetchImpl = (async (url) => {
      seen = String(url)
      return new Response(JSON.stringify([{ run_id: 'r1' }]), { status: 200 })
    }) as typeof fetch
    const got = await fetchResults(fetchImpl)
    expect(seen).toBe('/api/results')
    expect(got).toEqual([{ run_id: 'r1' }])
  })

  it('deleteRun DELETEs the escaped group/run path', async () => {
    let seen: { url: string; method?: string } | null = null
    const fetchImpl = (async (url, init) => {
      seen = { url: String(url), method: init?.method }
      return new Response(JSON.stringify({ deleted: 'h100 tp1' }), { status: 200 })
    }) as typeof fetch
    await deleteRun('abc123', 'h100 tp1', fetchImpl)
    expect(seen).toEqual({ url: '/api/results/abc123/h100%20tp1', method: 'DELETE' })
  })

  it('surfaces the server error message on a non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'no run "r9" under group "abc123" to delete' }), {
        status: 404,
      })) as typeof fetch
    await expect(deleteRun('abc123', 'r9', fetchImpl)).rejects.toThrow(/no run "r9"/)
  })

  it('reports an unreachable server rather than a raw rejection', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(deleteRun('abc123', 'r1', fetchImpl)).rejects.toThrow(/Could not reach the run server/)
  })

  it('rejects a stale server that 200s the SPA index instead of confirming the delete', async () => {
    // A server predating the delete route has no handler for the path, so the request falls
    // through to the SPA catch-all and returns 200 with index.html. That must not read as a
    // silent success (which would leave the run on disk and the row on the board).
    const fetchImpl = (async () =>
      new Response('<!doctype html><title>BLIS Leaderboard</title>', { status: 200 })) as typeof fetch
    await expect(deleteRun('abc123', 'r1', fetchImpl)).rejects.toThrow(/did not confirm the delete/)
  })
})
