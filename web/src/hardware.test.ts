import { describe, expect, it } from 'vitest'
import { collapseHardwareAliases, hardwareAliases, listHardware } from './hardware'
import type { HardwareInfo } from './hardware'

const catalog: HardwareInfo[] = [
  { name: 'A100-80', aliases: ['A100-SXM'], spec: { MemoryGiB: 80, TFlopsPeak: 312 } },
  { name: 'H100', aliases: [], spec: { MemoryGiB: 80, TFlopsPeak: 989.5, TFlopsFP8: 1979 } },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('listHardware', () => {
  it('returns the accelerators the server sends', async () => {
    const fakeFetch = (async (url) => {
      expect(String(url)).toBe('/api/hardware')
      return jsonResponse({ hardware: catalog })
    }) as typeof fetch
    expect(await listHardware(fakeFetch)).toEqual(catalog)
  })

  it('returns an empty list when the server sends none', async () => {
    const fakeFetch = (async () => jsonResponse({ hardware: [] })) as typeof fetch
    expect(await listHardware(fakeFetch)).toEqual([])
  })

  it('explains how to start the server when the fetch itself fails', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(listHardware(fakeFetch)).rejects.toThrow(/leaderboard serve/)
  })

  it('throws the server {error} on an HTTP error', async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: 'read hardware_config.json: no such file' }, 500)) as typeof fetch
    await expect(listHardware(fakeFetch)).rejects.toThrow(/hardware_config\.json/)
  })
})

// The server returns every name (sorted), each carrying the other spec-identical names as its
// aliases (internal/hardware.Entries), so a spec-identical pair arrives as two entries that
// point at each other. This is the shape the two helpers below collapse.
const A100_SPEC = { MemoryGiB: 80, TFlopsPeak: 312 }
const paired: HardwareInfo[] = [
  { name: 'A100-80', aliases: ['A100-SXM'], spec: A100_SPEC },
  { name: 'A100-SXM', aliases: ['A100-80'], spec: A100_SPEC },
  { name: 'H100', aliases: [], spec: { MemoryGiB: 80, TFlopsPeak: 989.5 } },
]

describe('collapseHardwareAliases', () => {
  it('folds a spec-identical pair into one entry, keeping the more specific name', () => {
    const out = collapseHardwareAliases(paired)
    // A100-80 and A100-SXM are one accelerator, so they become one entry, not two. The longer
    // name (A100-SXM) is kept as the canonical one and the other rides along as its alias.
    expect(out.map((h) => h.name)).toEqual(['A100-SXM', 'H100'])
    const a100 = out.find((h) => h.name === 'A100-SXM')!
    expect(a100.aliases).toEqual(['A100-80'])
    expect(a100.spec).toEqual(A100_SPEC)
  })

  it('leaves an accelerator with no aliases as its own entry', () => {
    const h100 = collapseHardwareAliases(paired).find((h) => h.name === 'H100')!
    expect(h100.aliases).toEqual([])
  })

  it('tolerates aliases that arrive as null from the server', () => {
    const withNull = [{ name: 'H100', aliases: null, spec: {} }] as unknown as HardwareInfo[]
    expect(collapseHardwareAliases(withNull)).toEqual([{ name: 'H100', aliases: [], spec: {} }])
  })
})

describe('hardwareAliases', () => {
  it('returns the other names of a spec-identical group, whichever name is asked', () => {
    expect(hardwareAliases(paired, 'A100-80')).toEqual(['A100-SXM'])
    expect(hardwareAliases(paired, 'A100-SXM')).toEqual(['A100-80'])
  })

  it('returns nothing for an accelerator that stands alone or is unknown', () => {
    expect(hardwareAliases(paired, 'H100')).toEqual([])
    expect(hardwareAliases(paired, 'B200')).toEqual([])
  })
})
