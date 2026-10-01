import { describe, expect, it } from 'vitest'
import { fetchTraceRecords, fetchTraceStats } from './workloads'

/** A minimal server stats payload — only the fields the test asserts need be real. */
const payload = {
  records: 26,
  sessions: 4,
  input_tokens: { bins: [{ lo: 0, hi: 10, count: 26 }], min: 2, max: 9, mean: 5, p50: 5, p95: 9, count: 26 },
  output_tokens: { bins: [], min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 0 },
  turns_per_session: { bins: [], min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 0 },
  think_time_ms: { bins: [], min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 0 },
  arrival_timeline: { buckets: [], span_ms: 0, count: 0 },
}

describe('fetchTraceStats', () => {
  it('GETs /api/traces/{sha}/stats and returns the parsed stats', async () => {
    let seenUrl = ''
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch
    const got = await fetchTraceStats('deadbeef', fetchImpl)
    expect(seenUrl).toBe('/api/traces/deadbeef/stats')
    expect(got.records).toBe(26)
    expect(got.input_tokens.count).toBe(26)
  })

  it('surfaces the server {error} on a non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'no stored trace' }), { status: 404 })) as unknown as typeof fetch
    await expect(fetchTraceStats('abc', fetchImpl)).rejects.toThrow(/no stored trace/)
  })

  it('becomes the start-the-server message when the server is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(fetchTraceStats('abc', fetchImpl)).rejects.toThrow(/server/i)
  })

  it('rejects a stale server that answers 200 with the SPA index.html instead of stats', async () => {
    // A `leaderboard serve` built before the stats route falls through to the SPA catch-all,
    // returning index.html with 200 — which must read as "rebuild the server", not crash the
    // charts on a null stats object.
    const fetchImpl = (async () =>
      new Response('<!doctype html><html><body>app</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    await expect(fetchTraceStats('abc', fetchImpl)).rejects.toThrow(/rebuild|predate/i)
  })
})

describe('fetchTraceRecords', () => {
  const payload = {
    header: { trace_version: 3, time_unit: 'microseconds' },
    total_records: 26648,
    limit: 50,
    records: [{ session_id: '009d', input_tokens: 418, output_tokens: 20 }],
  }

  it('GETs /api/traces/{sha}/records with the limit and returns the parsed body', async () => {
    let seenUrl = ''
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch
    const got = await fetchTraceRecords('deadbeef', 50, fetchImpl)
    expect(seenUrl).toBe('/api/traces/deadbeef/records?limit=50')
    expect(got.total_records).toBe(26648)
    expect(got.records).toHaveLength(1)
  })

  it('omits the limit query when none is given', async () => {
    let seenUrl = ''
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch
    await fetchTraceRecords('abc', undefined, fetchImpl)
    expect(seenUrl).toBe('/api/traces/abc/records')
  })

  it('rejects a stale server that answers 200 with the SPA index.html', async () => {
    const fetchImpl = (async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    await expect(fetchTraceRecords('abc', 50, fetchImpl)).rejects.toThrow(/rebuild|predate/i)
  })
})
