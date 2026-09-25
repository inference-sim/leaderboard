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

/** A model's architecture at a glance, derived server-side from the same config.json blis
 * reads (mirrors internal/modelcatalog.Spec). Every field is optional: config.json may omit
 * one, and the server drops absent fields (`omitempty`), so the card omits that row rather
 * than showing a fabricated number. */
export interface ModelSpec {
  arch?: string
  modelType?: string
  context?: number
  layers?: number
  hidden?: number
  heads?: number
  kvHeads?: number
  dtype?: string
  experts?: number
  active?: number
  vocab?: number
}

/** One offered model: its canonical org-prefixed name, whether blis treats it as MoE, and
 * the architecture spec the Catalog cards show. Mirrors internal/modelcatalog.Model. */
export interface ModelInfo {
  name: string
  moe: boolean
  spec?: ModelSpec
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

// ---------- Presentation helpers ----------
//
// Kept here rather than in the component so the grouping, formatting, and derivation the
// Catalog's model cards depend on are unit-testable without rendering, the same way the
// fetch functions above are.

/** The model families the Catalog groups cards under. The key is a model name's leading
 * lowercase run (see familyKey); the value is its display label. A key absent here is
 * title-cased as a fallback, so a newly added family still groups and reads sensibly. */
const FAMILY_LABELS: Record<string, string> = {
  llama: 'Llama',
  codellama: 'Code Llama',
  qwen: 'Qwen',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  glm: 'GLM',
  nemotron: 'Nemotron',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  inkling: 'Inkling',
  yi: 'Yi',
}

/** orgOf splits the org half off a canonical `org/model` name — the card's kicker. */
export function orgOf(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? '' : name.slice(0, slash)
}

/** modelOf is the model half of a canonical `org/model` name — the card's title. */
export function modelOf(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

/** familyKey groups a model by the leading lowercase run of its name's model half, so
 * `redhatai/llama-4-scout-…` and `meta-llama/llama-3.1-8b` land together under Llama rather
 * than being split by their differing orgs. Grouping this way needs no hand-kept table. */
export function familyKey(name: string): string {
  const match = modelOf(name).match(/^[a-z]+/)
  return match ? match[0] : 'other'
}

/** familyLabel is the display name for a family key. */
export function familyLabel(key: string): string {
  return FAMILY_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

/** One family's models, with its key and display label. */
export interface ModelFamily {
  key: string
  label: string
  models: ModelInfo[]
}

/** groupByFamily buckets models by family, biggest family first so multi-model families
 * fill the card grid and single-model families fall to the end; ties break alphabetically
 * by label. Order within a family is preserved (the catalog's own name sort). */
export function groupByFamily(models: ModelInfo[]): ModelFamily[] {
  const byKey = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const key = familyKey(m.name)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(m)
    else byKey.set(key, [m])
  }
  return [...byKey.entries()]
    .map(([key, ms]) => ({ key, label: familyLabel(key), models: ms }))
    .sort((a, b) => b.models.length - a.models.length || a.label.localeCompare(b.label))
}

/** Which models the Catalog toolbar's dense/MoE control shows. */
export type ModelKind = 'all' | 'dense' | 'moe'

/** filterModels applies the toolbar controls: a free-text query matched against the
 * canonical name, family label, and model_type, and a dense/MoE kind. A blank query and
 * 'all' leave the list unchanged. */
export function filterModels(models: ModelInfo[], query: string, kind: ModelKind): ModelInfo[] {
  const q = query.trim().toLowerCase()
  return models.filter((m) => {
    if (kind === 'moe' && !m.moe) return false
    if (kind === 'dense' && m.moe) return false
    if (q) {
      const hay = `${m.name} ${familyLabel(familyKey(m.name))} ${m.spec?.modelType ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// The context-window range the card meter spans, in tokens: the smallest and largest offered
// across the catalog today (Llama-2's 4K to Llama-4-Scout's 10M). The scale is logarithmic
// because that range covers three orders of magnitude.
const CTX_MIN_LOG = Math.log2(4096)
const CTX_MAX_LOG = Math.log2(10485760)

/** formatContext renders a context length as a compact token count (32768 → "32K",
 * 1048576 → "1M"), or null when the config stated none. */
export function formatContext(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null
  if (tokens >= 1048576) return `${+(tokens / 1048576).toFixed(1)}M`
  if (tokens >= 1024) return `${+(tokens / 1024).toFixed(1)}K`
  return String(tokens)
}

/** contextMeterFraction maps a context length onto 0..1 along the catalog's log scale, for
 * the card meter. An unstated or tiny value is 0, a value at or past the top is 1. */
export function contextMeterFraction(tokens: number | undefined): number {
  if (!tokens || tokens <= 0) return 0
  const f = (Math.log2(tokens) - CTX_MIN_LOG) / (CTX_MAX_LOG - CTX_MIN_LOG)
  return Math.max(0, Math.min(1, f))
}

/** precision returns a model's weight-precision label and whether it was read from
 * config.json or derived from the name. torch_dtype wins when present (BF16 / FP16);
 * otherwise the name's quantization suffix (nvfp4, fp8, bf16) is used and marked derived,
 * since several configs omit torch_dtype at the top level. Null when neither states it. */
export function precision(model: ModelInfo): { label: string; derived: boolean } | null {
  const dtype = model.spec?.dtype
  if (dtype) {
    const label =
      dtype === 'bfloat16' ? 'BF16' : dtype === 'float16' ? 'FP16' : dtype.toUpperCase()
    return { label, derived: false }
  }
  const n = model.name.toLowerCase()
  if (n.includes('nvfp4')) return { label: 'NVFP4', derived: true }
  if (n.includes('fp8')) return { label: 'FP8', derived: true }
  if (n.includes('bf16')) return { label: 'BF16', derived: true }
  return null
}
