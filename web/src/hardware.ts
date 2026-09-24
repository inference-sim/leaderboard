/**
 * The accelerator catalog the Catalog page shows, fetched live from the server rather
 * than frozen into the front-end. `leaderboard serve` reads it from the upstream
 * hardware_config.json (GET /api/hardware) the same file blis checks a run's hardware
 * against, so the list is never a hand-maintained snapshot. Kept out of the components,
 * like models.ts and workloads.ts, so every claim it makes is testable.
 *
 * There is no committed fallback list: when the config cannot be read (no server, or a
 * missing hardware_config.json) the page says so, exactly as the Workloads tab reports an
 * unreachable server.
 */

/** One accelerator: its name, the spec-identical names that are the same accelerator
 * (aliases, not rival candidates), and blis's numeric spec. Mirrors internal/hardware.Entry. */
export interface HardwareInfo {
  name: string
  aliases: string[]
  spec: Record<string, number>
}

const UNREACHABLE =
  'Could not reach the hardware server. Start it with `make build && ./bin/leaderboard serve`, then try again.'

/**
 * The other names of `name`'s accelerator: the spec-identical names, which are the same
 * accelerator, not rival candidates. The server hands each entry its own aliases, so this
 * answers the question whichever name is asked (a canonical name or one of its aliases). An
 * unknown name has none. The Declare form's duplicate-row guard reads this to refuse a
 * candidate whose accelerator already sits in the table under one of these names.
 */
export function hardwareAliases(hardware: HardwareInfo[], name: string): string[] {
  const entry = hardware.find((h) => h.name === name || (h.aliases ?? []).includes(name))
  if (!entry) return []
  return [entry.name, ...(entry.aliases ?? [])].filter((n) => n !== name).sort()
}

/**
 * Folds spec-identical names into one entry each, so the same accelerator is offered once
 * rather than as two rival candidates (running both would be a duplicate row, not a second
 * choice). The server sends every name with the others as its aliases; each group keeps its
 * more specific name (the longer one, ties broken alphabetically) as canonical and lists the
 * rest as aliases. The choice is cosmetic — blis treats the names as interchangeable — but it
 * keeps the label stable (A100-SXM over A100-80). Entries are returned sorted by name.
 */
export function collapseHardwareAliases(hardware: HardwareInfo[]): HardwareInfo[] {
  const seen = new Set<string>()
  const out: HardwareInfo[] = []
  for (const h of hardware) {
    if (seen.has(h.name)) continue
    const group = [h.name, ...(h.aliases ?? [])]
    for (const n of group) seen.add(n)
    // Prefer the longer name (more specific), and among equal lengths the alphabetically
    // first, so the canonical name is deterministic. group always holds h.name, so the
    // fallback only satisfies the type and never triggers.
    const canonical =
      [...group].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? h.name
    out.push({
      name: canonical,
      aliases: group.filter((n) => n !== canonical).sort(),
      spec: h.spec,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** listHardware fetches the catalog. A fetch rejection is "the server is not running"; an
 * HTTP error carries the server's {error} message. fetchImpl is injectable so the call is
 * unit-tested without a server, the same shape as models.listModels. */
export async function listHardware(fetchImpl: typeof fetch = fetch): Promise<HardwareInfo[]> {
  let res: Response
  try {
    res = await fetchImpl('/api/hardware')
  } catch {
    throw new Error(UNREACHABLE)
  }
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `The hardware server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return (parsed as { hardware?: HardwareInfo[] } | null)?.hardware ?? []
}
