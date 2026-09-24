/**
 * The Workloads tab's logic, kept out of the components so every claim it makes is
 * testable — the same split as newrun.ts.
 *
 * A workload profile is the work offered minus model (the topology spec's workloadKey),
 * with a name. The editor authors one; `leaderboard serve` persists it to workloads.yaml
 * and validates it — handing a raw WorkloadSpec to blis itself, so the browser never
 * needs a YAML parser or blis's rules. The variant a profile is stored as is mechanical,
 * not a choice: the guided form is a distribution, the raw-spec mode is spec-backed.
 */

import type { RunRecord, WorkloadGroup } from './load'
import { workloadKey, workloadTitle } from './load'
import { defaultSpec, parseSpec, serializeSpec, setPath, summarizeSpec, type SpecObject } from './spec'

type Group = RunRecord['group']
type SchemaWorkload = Group['workload']

/** The wire shape of one profile — mirrors the server's profileBody (cmd/leaderboard). */
export interface WorkloadBody {
  type: 'distribution' | 'workload-spec'
  num_requests?: number
  load?: { kind: 'rate' | 'concurrency'; value: number }
  prompt_tokens?: number
  prompt_tokens_stdev?: number
  output_tokens?: number
  output_tokens_stdev?: number
  spec_sha256?: string | null
  /** The raw WorkloadSpec as YAML text; the server parses it. */
  spec_yaml?: string
  spec?: Record<string, unknown>
}

export interface ProfileBody {
  name: string
  seed: number
  horizon_ticks: number | null
  request_timeout_s: number
  workload: WorkloadBody
  /** True for a shipped preset (§11): read-only in the catalog. Output-only; the server
   * ignores it on input. */
  builtin?: boolean
}

/** The server's validate verdict: runnable?, variant, one-line summary, twin, reasons. */
export interface ValidateResponse {
  ok: boolean
  variant: string
  summary: string
  twin: string | null
  issues: string[]
}

/**
 * The editor's form state. The workload itself is authored as a WorkloadSpec, held as
 * the YAML buffer `specYaml` — the single carrier the form and the YAML pane both edit.
 * name/seed/horizon/timeout are the profile's group-side knobs, kept beside the spec.
 */
export interface FormValues {
  name: string
  seed: number
  horizonTicks: number | null
  requestTimeoutS: number
  specYaml: string
}

export interface Issue {
  field: string
  message: string
}

export interface Interpretation {
  issues: Issue[]
  body: ProfileBody | null
}

/** Mirrors internal/catalog.workloadNamePattern: lower-case letters, digits, dash,
 * underscore or dot, and non-empty. */
export const NAME_PATTERN = /^[a-z0-9._-]+$/

/** The form a New workload opens with: blis's own single-client spec defaults, so it is
 * runnable as authored. */
export function initialForm(): FormValues {
  return {
    name: '',
    seed: 42,
    horizonTicks: null,
    requestTimeoutS: 300,
    specYaml: serializeSpec(defaultSpec()),
  }
}

/** bodyToForm fills the editor from a saved profile, so Edit opens on its real values.
 * A spec profile opens on its YAML; a legacy distribution profile is lifted into an
 * equivalent WorkloadSpec so it too can be edited in the one editor. */
export function bodyToForm(body: ProfileBody): FormValues {
  const base = initialForm()
  const w = body.workload
  const specYaml =
    w.type === 'workload-spec'
      ? w.spec_yaml ?? (w.spec ? serializeSpec(w.spec as SpecObject) : '')
      : serializeSpec(distributionToSpec(w))
  return {
    ...base,
    name: body.name,
    seed: body.seed,
    horizonTicks: body.horizon_ticks,
    requestTimeoutS: body.request_timeout_s,
    specYaml,
  }
}

/** One token distribution's gaussian statistics, as the custom card and the converter
 * both express them: a mean and spread with a clamp. */
export interface TokenStat {
  mean: number
  std_dev: number
  min: number
  max: number
}

/** deriveMax is the clamp ceiling used when a mean/stdev pair carries no explicit max:
 * four standard deviations above the mean covers all but a negligible tail, so the
 * gaussian is not silently truncated. Shared so the card's default and the legacy
 * converter agree. */
export function deriveMax(mean: number, stdev: number): number {
  return Math.max(1, Math.round(mean + 4 * stdev))
}

/** gaussianSpec builds a single-client WorkloadSpec with gaussian input and output
 * distributions from explicit token statistics. Both the custom card (explicit min/max
 * from the user) and distributionToSpec (bounds derived for a legacy distribution) build
 * on it, so the two produce the same shape and the custom card is simply a guided front
 * end for a one-client spec. */
export function gaussianSpec(opts: {
  numRequests: number
  load: { kind: 'rate' | 'concurrency'; value: number }
  input: TokenStat
  output: TokenStat
}): SpecObject {
  const dist = (s: TokenStat) => ({
    type: 'gaussian',
    params: { mean: s.mean, std_dev: s.std_dev, min: s.min, max: s.max },
  })
  const client: SpecObject = {
    id: 'c0',
    arrival: { process: 'poisson' },
    input_distribution: dist(opts.input),
    output_distribution: dist(opts.output),
  }
  let spec: SpecObject = { version: '2', num_requests: opts.numRequests, clients: [client] }
  if (opts.load.kind === 'concurrency') {
    spec = setPath(spec, ['clients', 0, 'concurrency'], opts.load.value)
  } else {
    spec = setPath(spec, ['aggregate_rate'], opts.load.value)
    spec = setPath(spec, ['clients', 0, 'rate_fraction'], 1)
  }
  return spec
}

/** distributionToSpec lifts a legacy distribution workload into the equivalent
 * WorkloadSpec, so an existing profile opens in the spec editor rather than breaking. The
 * mean/stdev pair maps onto a blis gaussian, and the bounds are derived from the mean and
 * spread so the result validates. */
function distributionToSpec(w: WorkloadBody): SpecObject {
  const pMean = w.prompt_tokens ?? 0
  const pStd = w.prompt_tokens_stdev ?? 0
  const oMean = w.output_tokens ?? 0
  const oStd = w.output_tokens_stdev ?? 0
  return gaussianSpec({
    numRequests: w.num_requests ?? 0,
    load: w.load ?? { kind: 'rate', value: 0 },
    input: { mean: pMean, std_dev: pStd, min: 1, max: deriveMax(pMean, pStd) },
    output: { mean: oMean, std_dev: oStd, min: 1, max: deriveMax(oMean, oStd) },
  })
}

/** The variant every profile authored here is stored as: the editor is spec-first, so a
 * save is always a WorkloadSpec (the distribution variant is legacy, read on Edit only). */
export function variantOf(_v: FormValues): 'workload-spec' {
  return 'workload-spec'
}

/**
 * interpret validates the profile the way internal/catalog.Validate does for the checks
 * that do not need blis — the name and the group-side knobs — and confirms the spec is
 * parseable YAML, then builds the body to save. An unrunnable form yields a null body
 * (nothing unrunnable is offered); blis's own semantic checks are the server's to add.
 */
export function interpret(v: FormValues): Interpretation {
  const issues: Issue[] = []
  const push = (field: string, message: string) => issues.push({ field, message })

  if (!v.name.trim()) push('name', 'A name is required.')
  else if (!NAME_PATTERN.test(v.name))
    push('name', 'Use lower-case letters, digits, dash, underscore or dot.')
  if (!Number.isInteger(v.seed) || v.seed < 0) push('seed', 'The seed must be a non-negative integer.')
  if (v.requestTimeoutS === 0)
    push(
      'requestTimeoutS',
      '0 is rejected by blis; use a positive deadline, or a negative value to disable it.',
    )
  if (v.horizonTicks !== null && v.horizonTicks <= 0)
    push('horizonTicks', 'The horizon must be greater than 0, or empty for unbounded.')

  const { error } = parseSpec(v.specYaml)
  if (error) push('specYaml', error)

  const workload: WorkloadBody = { type: 'workload-spec', spec_yaml: v.specYaml }
  const body: ProfileBody = {
    name: v.name,
    seed: v.seed,
    horizon_ticks: v.horizonTicks,
    request_timeout_s: v.requestTimeoutS,
    workload,
  }
  return { issues, body: issues.length > 0 ? null : body }
}

/**
 * profileToGroup resolves a profile into the record-shape comparability group, mirroring
 * internal/catalog's resolution so a profile's key lines up with the records already on
 * the board. The group carries no model (E1): model is a candidate supplied per row. A
 * spec profile carries the not-applicable placeholders the record schema uses.
 */
export function profileToGroup(body: ProfileBody): Group {
  const w = body.workload
  let workload: SchemaWorkload
  if (w.type === 'workload-spec') {
    workload = {
      type: 'workload-spec',
      arrival_process: 'constant',
      num_requests: 0,
      load: { kind: 'rate', value: 0 },
      prompt_tokens: 0,
      prompt_tokens_stdev: 0,
      output_tokens: 0,
      output_tokens_stdev: 0,
      spec_file: null,
      spec_sha256: w.spec_sha256 ?? null,
      spec: w.spec,
    } as SchemaWorkload
  } else {
    workload = {
      type: 'distribution',
      arrival_process: w.load!.kind === 'concurrency' ? 'closed-loop' : 'constant',
      num_requests: w.num_requests!,
      load: w.load!,
      prompt_tokens: w.prompt_tokens!,
      prompt_tokens_stdev: w.prompt_tokens_stdev!,
      output_tokens: w.output_tokens!,
      output_tokens_stdev: w.output_tokens_stdev!,
      spec_file: null,
      spec_sha256: null,
    }
  }
  return {
    seed: body.seed,
    horizon_ticks: body.horizon_ticks,
    request_timeout_s: body.request_timeout_s,
    workload,
  }
}

/**
 * profileSummary is the one-line work summary for the catalog browser. A spec profile is
 * summarized by its aggregate rate the way the server's summarize does — never by numbers
 * the spec does not state; a legacy distribution profile reuses workloadTitle so its
 * phrasing cannot drift from the board.
 */
export function profileSummary(body: ProfileBody): string {
  const w = body.workload
  if (w.type === 'workload-spec') {
    const obj = w.spec ? (w.spec as SpecObject) : parseSpec(w.spec_yaml ?? '').obj
    return summarizeSpec(obj)
  }
  return workloadTitle(profileToGroup(body))
}

/**
 * specText is the complete WorkloadSpec of a spec-backed profile, as YAML — the text the
 * catalog's detail panel shows and offers to copy. It prefers the server's own YAML
 * rendering (spec_yaml) and falls back to serializing the spec object, so a profile built
 * client-side (a test, a fresh save) still resolves. A distribution profile has no spec,
 * so this is null and the detail panel shows its flat fields instead.
 */
export function specText(body: ProfileBody): string | null {
  const w = body.workload
  if (w.type !== 'workload-spec') return null
  if (w.spec_yaml && w.spec_yaml.trim()) return w.spec_yaml
  if (w.spec) return serializeSpec(w.spec as SpecObject)
  return null
}

/**
 * profileKnobs is the one-line group-side summary shown above a profile's spec: the seed,
 * the observation window, and the request timeout — the fields that decide whether the
 * declared work can complete, and so are part of the comparability group (CLAUDE.md).
 */
export function profileKnobs(body: ProfileBody): string {
  const horizon = body.horizon_ticks == null ? 'no horizon cap' : `horizon ${body.horizon_ticks} ticks`
  const timeout = body.request_timeout_s < 0 ? 'timeout disabled' : `timeout ${body.request_timeout_s}s`
  return `seed ${body.seed} · ${horizon} · ${timeout}`
}

export interface CrossRef {
  models: number
  runs: number
}

/**
 * crossRef reports how many models and runs already exist on the board under this
 * profile's workload, matched by workloadKey (the topology spec's grouping). Both
 * variants are matched. A spec profile — including the presets — carries the spec and the
 * spec_sha256 the server emits, so profileToGroup rebuilds the same group the runs
 * declared from it were filed under, and its key lines up with theirs. (Before the
 * Declare-a-run flow landed no spec-backed records existed, so this used to short-circuit
 * to zero for a spec profile; that left every preset reading "no runs yet".) A profile the
 * server has not resolved to a spec object yet has no key to match and falls through to
 * zero.
 */
export function crossRef(body: ProfileBody, workloads: WorkloadGroup[]): CrossRef {
  const key = workloadKey(profileToGroup(body))
  const match = workloads.find((w) => w.workloadKey === key)
  return match ? { models: match.models.length, runs: match.records.length } : { models: 0, runs: 0 }
}

// --- API client ------------------------------------------------------------------
// Same shape as newrun.postRun: a fetch rejection is "the server is not running", an
// HTTP error carries the server's {error} message, and fetchImpl is injectable so the
// calls are unit-tested without a server.

const UNREACHABLE =
  'Could not reach the workload server. Start it with `make build && ./bin/leaderboard serve`, then try again.'

async function readOrThrow(res: Response): Promise<unknown> {
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
        : `The workload server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return parsed
}

export async function listWorkloads(fetchImpl: typeof fetch = fetch): Promise<ProfileBody[]> {
  let res: Response
  try {
    res = await fetchImpl('/api/workloads')
  } catch {
    throw new Error(UNREACHABLE)
  }
  const parsed = (await readOrThrow(res)) as { workloads?: ProfileBody[] } | null
  return parsed?.workloads ?? []
}

export async function validateWorkload(
  body: ProfileBody,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResponse> {
  let res: Response
  try {
    res = await fetchImpl('/api/workloads/validate', jsonPost('POST', body))
  } catch {
    throw new Error(UNREACHABLE)
  }
  return (await readOrThrow(res)) as ValidateResponse
}

/**
 * saveWorkload creates the profile (POST) when originalName is null, or edits/renames
 * the profile at originalName (PUT) otherwise.
 */
export async function saveWorkload(
  body: ProfileBody,
  originalName: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ProfileBody> {
  const url = originalName == null ? '/api/workloads' : `/api/workloads/${encodeURIComponent(originalName)}`
  const method = originalName == null ? 'POST' : 'PUT'
  let res: Response
  try {
    res = await fetchImpl(url, jsonPost(method, body))
  } catch {
    throw new Error(UNREACHABLE)
  }
  return (await readOrThrow(res)) as ProfileBody
}

export async function deleteWorkload(name: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response
  try {
    res = await fetchImpl(`/api/workloads/${encodeURIComponent(name)}`, { method: 'DELETE' })
  } catch {
    throw new Error(UNREACHABLE)
  }
  await readOrThrow(res)
}

function jsonPost(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
