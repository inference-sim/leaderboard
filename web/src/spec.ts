/**
 * The WorkloadSpec model that backs the two-pane editor: a parsed blis WorkloadSpec
 * (spec v2, see ../../inference-sim/workload-spec-schema.md) as a plain object, plus the
 * parse/serialize and path accessors the form binds to.
 *
 * The object is the single source of truth the form reads and writes; the YAML pane is
 * a serialization of it. A form edit reserializes the whole object, so keys the form
 * does not know about (extra clients, cohorts, multimodal, lifecycle, …) round-trip
 * untouched — the form covers the common single-client case, the YAML covers everything
 * else. Comments do not survive a form edit: parse drops them, so a rewrite loses them.
 *
 * blis owns validation. This module never decides whether a spec is runnable — the
 * server hands the spec to blis for that. It only reads and writes fields.
 */

import { parse, stringify } from 'yaml'

export type SpecObject = Record<string, unknown>
export type Path = (string | number)[]

// The value registries, mirrored from spec.go:236-249 (via workload-spec-schema.md). An
// empty string is the "unset" option where blis allows it (category, slo_class).
export const ARRIVAL_PROCESSES = ['poisson', 'gamma', 'weibull', 'constant'] as const
export const DIST_TYPES = [
  'gaussian',
  'exponential',
  'pareto_lognormal',
  'lognormal',
  'empirical',
  'constant',
] as const
export const CATEGORIES = ['', 'language', 'multimodal', 'reasoning'] as const
export const SLO_CLASSES = ['', 'critical', 'standard', 'sheddable', 'batch', 'background'] as const

/**
 * The parameters blis requires for each distribution type, mirrored from
 * sim/workload/distribution.go (NewLengthSampler). The form renders one numeric field
 * per name; a type not listed here (empirical) takes a file or inline PDF bins the form
 * does not build — those are edited in the YAML. Getting these right matters: blis
 * rejects a spec whose distribution is missing a required parameter (e.g. lognormal
 * without "mu").
 */
export const DIST_PARAMS: Record<string, string[]> = {
  gaussian: ['mean', 'std_dev', 'min', 'max'],
  exponential: ['mean'],
  lognormal: ['mu', 'sigma'],
  pareto_lognormal: ['alpha', 'xm', 'mu', 'sigma', 'mix_weight'],
  constant: ['value'],
  empirical: [],
}

/** Sensible starting values for each type's parameters — used for the default spec and
 * when the reader switches a distribution's type in the form. */
export const DIST_DEFAULTS: Record<string, Record<string, number>> = {
  gaussian: { mean: 512, std_dev: 128, min: 1, max: 2048 },
  exponential: { mean: 512 },
  lognormal: { mu: 6.2, sigma: 0.5 },
  pareto_lognormal: { alpha: 1.5, xm: 10, mu: 6.2, sigma: 0.5, mix_weight: 0.5 },
  constant: { value: 512 },
  empirical: {},
}

/**
 * defaultSpec is the WorkloadSpec a new workload opens on: one rate-based client at a
 * lognormal token distribution, runnable as authored. Model-free — the model is chosen
 * at run time, and a model pinned in a client is rejected by the server (P6). seed and
 * horizon are group-side knobs carried by the profile, not the spec, so they are absent
 * here.
 */
export function defaultSpec(): SpecObject {
  return {
    version: '2',
    category: 'language',
    aggregate_rate: 10,
    num_requests: 500,
    clients: [newClient('c0')],
  }
}

/** newClient is a fresh rate-based client at blis's lognormal token defaults — the shape
 * the "Add client" button appends and the default spec's sole client. lognormal takes
 * mu (log-space mean) and sigma, per blis; mu 6.2 ≈ 500 tokens in, 4.85 ≈ 128 out. */
export function newClient(id: string): SpecObject {
  return {
    id,
    rate_fraction: 1,
    arrival: { process: 'poisson' },
    input_distribution: { type: 'lognormal', params: { mu: 6.2, sigma: 0.5 } },
    output_distribution: { type: 'lognormal', params: { mu: 4.85, sigma: 0.5 } },
    prefix_length: 50,
    streaming: false,
  }
}

/**
 * parseSpec turns the YAML buffer into the object the form reads. A blank buffer, a
 * parse error, or a non-mapping top level all yield a null object and a message the
 * editor shows in place of the form — the form cannot bind to a spec it cannot read.
 */
export function parseSpec(text: string): { obj: SpecObject | null; error: string | null } {
  if (!text.trim()) return { obj: null, error: 'The spec is empty — build it in the form or paste YAML.' }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    return { obj: null, error: e instanceof Error ? e.message : 'The spec is not valid YAML.' }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { obj: null, error: 'The top level of a WorkloadSpec must be a mapping.' }
  }
  return { obj: doc as SpecObject, error: null }
}

/** serializeSpec renders the object back to YAML for the pane. lineWidth 0 disables
 * line wrapping, so long values stay on one line. */
export function serializeSpec(obj: SpecObject): string {
  return stringify(obj, { lineWidth: 0 })
}

// --- Path accessors ---------------------------------------------------------------
// The form addresses fields by path, e.g. ['clients', 0, 'arrival', 'process']. Reads
// return '' / false for an absent field so inputs stay controlled; writes clone the
// object (never mutate the one React holds) and drop the key when the value is cleared,
// keeping the YAML free of empty strings.

export function getPath(root: SpecObject, path: Path): unknown {
  let node: unknown = root
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[key]
  }
  return node
}

export function setPath(root: SpecObject, path: Path, value: unknown): SpecObject {
  if (path.length === 0) return root
  const clone = structuredClone(root)
  let node = clone as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    const child = node[key]
    if (child == null || typeof child !== 'object') {
      node[key] = typeof path[i + 1] === 'number' ? [] : {}
    }
    node = node[key] as Record<string | number, unknown>
  }
  const last = path[path.length - 1]!
  if (value === undefined) delete node[last]
  else node[last] = value
  return clone
}

/** removeAt splices one element out of the array at `path`, returning a new object; a
 * no-op when the path is not an array. Used to remove a client from clients[]. */
export function removeAt(root: SpecObject, path: Path, index: number): SpecObject {
  const clone = structuredClone(root)
  const arr = getPath(clone, path)
  if (Array.isArray(arr)) arr.splice(index, 1)
  return clone
}

/** appendClient adds a fresh client to clients[], with an id that does not collide with
 * an existing one (c0, c1, …). */
export function appendClient(root: SpecObject): SpecObject {
  const clients = Array.isArray(root.clients) ? (root.clients as SpecObject[]) : []
  const ids = new Set(clients.map((c) => getStr(c, ['id'])))
  let n = clients.length
  while (ids.has(`c${n}`)) n++
  return setPath(root, ['clients', clients.length], newClient(`c${n}`))
}

/**
 * changeDistType switches the distribution at `distPath` to `type`, resetting its params
 * to that type's required set. Parameters the old and new type share (e.g. mu/sigma when
 * going lognormal → pareto_lognormal) keep their values; the rest take the type's
 * defaults. This keeps the spec valid for blis, which requires an exact parameter set.
 */
export function changeDistType(root: SpecObject, distPath: Path, type: string): SpecObject {
  const old = (getPath(root, [...distPath, 'params']) as Record<string, unknown>) ?? {}
  const params: Record<string, number> = { ...(DIST_DEFAULTS[type] ?? {}) }
  for (const k of DIST_PARAMS[type] ?? []) {
    if (typeof old[k] === 'number') params[k] = old[k] as number
  }
  const withType = setPath(root, [...distPath, 'type'], type)
  return setPath(withType, [...distPath, 'params'], params)
}

/** getStr reads a string field ('' when absent or not a string). */
export function getStr(root: SpecObject, path: Path): string {
  const v = getPath(root, path)
  return typeof v === 'string' ? v : ''
}

/** getNum reads a numeric field as the text an <input> shows ('' when absent). */
export function getNum(root: SpecObject, path: Path): string {
  const v = getPath(root, path)
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

export function getBool(root: SpecObject, path: Path): boolean {
  return getPath(root, path) === true
}

/** setStr writes a string, dropping the key when text is empty. */
export function setStr(root: SpecObject, path: Path, text: string): SpecObject {
  return setPath(root, path, text === '' ? undefined : text)
}

/** setNum writes a number parsed from input text, dropping the key when text is empty
 * and leaving the spec unchanged when the text is not a number (a half-typed value like
 * "-" or "1." does not clobber the field). */
export function setNum(root: SpecObject, path: Path, text: string): SpecObject {
  if (text.trim() === '') return setPath(root, path, undefined)
  const n = Number(text)
  if (!Number.isFinite(n)) return root
  return setPath(root, path, n)
}

export function setBool(root: SpecObject, path: Path, on: boolean): SpecObject {
  return setPath(root, path, on)
}

/** firstClientPath returns the path prefix of clients[0] when the spec has a mapping
 * there, else null — the form's client section binds to it and steps aside otherwise
 * (a cohort-only or clients-less spec is edited in the YAML pane). */
export function firstClientPath(root: SpecObject): Path | null {
  const clients = getPath(root, ['clients'])
  if (Array.isArray(clients) && clients.length > 0 && clients[0] != null && typeof clients[0] === 'object') {
    return ['clients', 0]
  }
  return null
}

/**
 * summarizeSpec is the one-line work summary for the catalog, mirroring the server's
 * summarize: a spec is named by its aggregate rate when it declares a positive one,
 * else simply spec-backed. It never invents numbers a spec does not state.
 */
export function summarizeSpec(obj: SpecObject | null): string {
  if (obj) {
    const rate = getPath(obj, ['aggregate_rate'])
    if (typeof rate === 'number' && rate > 0) {
      return `spec-backed workload at ${String(rate)} req/s aggregate`
    }
  }
  return 'spec-backed workload'
}

/**
 * The sole client of a spec, when there is exactly one and no cohorts — the case the
 * flat readout can describe (a preset, or a form-authored single-client profile). Returns
 * null for a multi-client or cohort/trace spec, whose per-client shape belongs in the full
 * spec, not a flat field.
 */
export function singleClient(spec: SpecObject | null): SpecObject | null {
  if (!spec) return null
  if (getPath(spec, ['cohorts']) != null) return null
  const clients = getPath(spec, ['clients'])
  if (Array.isArray(clients) && clients.length === 1 && clients[0] && typeof clients[0] === 'object') {
    return clients[0] as SpecObject
  }
  return null
}

/**
 * A distribution object in short, readable terms: a gaussian as "mean ±std" with its
 * clamp as detail, any other family by its name with its parameters as detail. `text` is
 * the headline (a token grid cell or caption term); `detail` is the small print. Mirrors
 * DIST_PARAMS so the parameters shown are the ones blis reads.
 */
export function distTerms(dist: SpecObject | null): { text: string; detail?: string } {
  if (!dist || typeof dist !== 'object') return { text: 'in spec' }
  const type = getStr(dist, ['type'])
  const params = (getPath(dist, ['params']) as Record<string, unknown>) ?? {}
  const n = (k: string) => (typeof params[k] === 'number' ? (params[k] as number) : undefined)
  const fmt = (v: number) => v.toLocaleString('en-US')
  if (type === 'gaussian') {
    const mean = n('mean')
    const std = n('std_dev')
    const min = n('min')
    const max = n('max')
    const text = mean == null ? 'gaussian' : `${fmt(mean)} ±${std == null ? '?' : fmt(std)}`
    const detail = min != null && max != null ? `[${fmt(min)}–${fmt(max)}]` : undefined
    return { text, detail }
  }
  const shown = (DIST_PARAMS[type] ?? [])
    .filter((k) => n(k) != null)
    .map((k) => `${k} ${fmt(n(k)!)}`)
    .join(', ')
  return { text: type || 'distribution', detail: shown || undefined }
}
