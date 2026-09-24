/**
 * The model catalog the Declare-a-run form offers, fetched live from the server rather
 * than frozen into the front-end. `leaderboard serve` reads it from the bundled
 * blis-catalog clone (GET /api/models) — the same clone blis resolves configs against —
 * so the list is never a hand-maintained snapshot. Kept out of the components, like
 * workloads.ts, so every claim it makes is testable.
 *
 * There is no committed fallback list: when the catalog cannot be read (no server, or
 * BLIS_CATALOG unset) the picker is empty and the page says so, exactly as the Workloads
 * tab reports an unreachable server.
 */

/** One offered model: its canonical org-prefixed name and whether blis treats it as MoE.
 * Mirrors internal/modelcatalog.Model. */
export interface ModelInfo {
  name: string
  moe: boolean
}

/** A model's provenance from model.yaml, shown as tags. A field absent from model.yaml is an
 * empty string and its tag is omitted. Mirrors internal/modelcatalog.Source. */
export interface ModelSource {
  provider: string
  repo: string
  revision: string
  retrieved: string
}

/** One model's full detail, fetched on demand when a reader opens it in the catalog: the
 * list fields, its provenance (shown as tags), and the config.json blis reads (pretty-printed,
 * or an empty string when the model ships none). Mirrors internal/modelcatalog.Detail. */
export interface ModelDetail {
  name: string
  moe: boolean
  source: ModelSource
  config: string
}

const UNREACHABLE =
  'Could not reach the model server. Start it with `make build && ./bin/leaderboard serve`, then try again.'

/** isMoE reports whether the catalog lists `name` as a MoE model, so the MoE serving knobs
 * apply. A name absent from the list (not yet loaded, or an unknown custom value) is
 * treated as dense — the knobs stay off rather than being offered speculatively. */
export function isMoE(models: ModelInfo[], name: string): boolean {
  return models.some((m) => m.name === name && m.moe)
}

/** listModels fetches the catalog. A fetch rejection is "the server is not running"; an
 * HTTP error carries the server's {error} message. fetchImpl is injectable so the call is
 * unit-tested without a server, the same shape as workloads.listWorkloads. */
export async function listModels(fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  let res: Response
  try {
    res = await fetchImpl('/api/models')
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
        : `The model server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return (parsed as { models?: ModelInfo[] } | null)?.models ?? []
}

/** getModelConfig fetches one model's detail (provenance + config.json), the same shape as
 * listModels' error handling: a fetch rejection means the server is down, an HTTP error
 * carries the server's {error} message (a 404 for an unknown model). fetchImpl is injectable
 * for tests. */
export async function getModelConfig(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelDetail> {
  let res: Response
  try {
    res = await fetchImpl(`/api/models/config?name=${encodeURIComponent(name)}`)
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
        : `The model server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return parsed as ModelDetail
}
