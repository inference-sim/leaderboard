/**
 * The New run screen's logic, kept out of the component so every claim it makes is
 * testable.
 *
 * The screen validates a declaration and then runs it: `postRun` POSTs the group,
 * deployment and run_id to `leaderboard serve`, which executes blis from the upstream
 * checkout (a browser cannot — blis resolves its config files relative to cwd) and
 * writes the same results/<group_id>/<run_id>.json the CLI does. The runnable
 * runs.yaml and the argv are still produced, now as the record of what ran rather
 * than instructions for the reader.
 *
 * Two things are duplicated from Go on purpose, and both are pinned by tests:
 *   - `argvFor` mirrors internal/blisrun.Argv, checked against the argv stored in
 *     every committed record (newrun.test.ts).
 *   - `arrivalProcess` mirrors internal/spec.arrivalProcess, which decides a field
 *     of the group block and therefore the group_id.
 */

import type { RunGroup, RunRecord } from './load'
import { SPECULATIVE_METHODS } from './catalog'
import { hardwareAliases } from './hardware'
import type { HardwareInfo } from './hardware'
import { isMoE } from './models'
import type { ModelInfo } from './models'
import { NAME_PATTERN, deriveMax, gaussianSpec, profileToGroup, saveWorkload } from './workloads'
import type { ProfileBody, TokenStat } from './workloads'
import { serializeSpec, type SpecObject } from './spec'
import { numeric } from './format'

export type Group = RunRecord['group']
export type Deployment = RunRecord['deployment']
export type LoadKind = Group['workload']['load']['kind']
export type ArrivalProcess = Group['workload']['arrival_process']

/** Mirrors internal/spec.runIDPattern: a run_id is also a filename. */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * The work and flags used when results/ is empty, so the form is usable on a fresh
 * checkout. Mirrors runs.yaml's `group` and `defaults` blocks; when a group does
 * exist, its own records are the basis instead and this is never read.
 */
export const FALLBACK_GROUP: Group = {
  seed: 42,
  horizon_ticks: null,
  request_timeout_s: 300,
  workload: {
    type: 'distribution',
    arrival_process: 'constant',
    num_requests: 500,
    load: { kind: 'rate', value: 6 },
    prompt_tokens: 512,
    prompt_tokens_stdev: 256,
    output_tokens: 128,
    output_tokens_stdev: 256,
    spec_file: null,
    spec_sha256: null,
  },
}

export const FALLBACK_DEPLOYMENT: Deployment = {
  model: 'qwen/qwen3-14b',
  hardware: 'H100',
  tp: 1,
  dp: 1,
  num_instances: 1,
  max_model_len: 40960,
  block_size_in_tokens: 16,
  max_num_seqs: 256,
  max_num_batched_tokens: 8192,
  long_prefill_token_threshold: 0,
  scheduler: 'fcfs',
  preemption_policy: 'fcfs',
  routing_policy: 'round-robin',
  admission_policy: 'always-admit',
  kv_cache_dtype: 'auto',
  latency_model: 'trained-physics',
  gpu_memory_utilization: 0.9,
  num_speculative_tokens: 0,
  speculative_acceptance_rate: 0,
  speculative_method: '',
  extra_flags: {},
}

/** One weighted-routing scorer as the form holds it: a name from the catalog and a
 * weight that stays as typed until it is interpreted, like the other numeric knobs. */
export interface RoutingScorer {
  name: string
  weight: string
}

/** What the form holds. Numbers stay as typed until they are interpreted. */
export interface FormValues {
  runId: string
  /** The model under test. A candidate dimension now (E1): it varies between rows of the
   * same table like hardware, and changing it no longer changes the table. */
  model: string
  hardware: string
  tp: string
  // --- the rest of the candidate's serving configuration, each a blis flag. They
  // default to blis's own defaults (FALLBACK_DEPLOYMENT) and are written out in full,
  // so the declaration never depends on what blis happens to default to. ---
  dp: string
  /** MoE knobs (--enable-expert-parallel, --moe-comm-backend). Applicable only to a MoE
   * model on trained-physics; the form guards them and clears them for a dense model. */
  enableExpertParallel: boolean
  moeCommBackend: string
  numInstances: string
  // --- prefill/decode disaggregation. Read only when a pool count is > 0; when all are 0
  // the candidate declares no disaggregation block. Mirrors cluster.ValidatePoolTopology. ---
  prefillInstances: string
  decodeInstances: string
  prefillDecodeInstances: string
  pdDecider: string
  pdPrefixThreshold: string
  pdTransferBandwidth: string
  pdTransferBaseLatency: string
  pdTransferContention: boolean
  maxModelLen: string
  blockSize: string
  maxNumSeqs: string
  maxNumBatchedTokens: string
  longPrefillTokenThreshold: string
  scheduler: string
  preemptionPolicy: string
  routingPolicy: string
  /** The weighted policy's scorer profile. Read only when routingPolicy === 'weighted';
   * cleared to [] on any other policy, so a non-weighted candidate declares no profile. */
  routingScorers: RoutingScorer[]
  admissionPolicy: string
  kvCacheDtype: string
  latencyModel: string
  gpuMemoryUtilization: string
  numSpeculativeTokens: string
  speculativeAcceptanceRate: string
  speculativeMethod: string
  /** The selected catalog workload's name, or '' for the custom card. Decides which
   * `group` block the run declares (R1); the model is chosen separately (R6). */
  workloadSel: string
  /** The name a custom (distribution) workload is saved under. Read only when
   * workloadSel === ''. A custom workload is persisted to the catalog on Run so it can be
   * reused, so it needs a name; the two workload types are saved-or-preset (workloadSel)
   * and custom-distribution (this). */
  customName: string
  // --- the custom card (read only when workloadSel === ''): a guided single-client
  // gaussian workload-spec. mean/stdev/min/max per token stream map onto a blis gaussian
  // distribution, so the card is a simplified front end for a one-client spec. ---
  loadKind: LoadKind
  loadValue: string
  numRequests: string
  promptTokens: string
  promptTokensStdev: string
  promptTokensMin: string
  promptTokensMax: string
  outputTokens: string
  outputTokensStdev: string
  outputTokensMin: string
  outputTokensMax: string
  seed: string
  requestTimeoutS: string
}

export interface Issue {
  field: keyof FormValues | 'form'
  message: string
}

/** Where this candidate would land once the CLI has run it. */
export interface Target {
  /** The existing group it joins, or null when the declared work is new. */
  group: RunGroup | null
}

export interface Output {
  group: Group
  deployment: Deployment
  runId: string
  /** The catalog name the workload was chosen by, stored on the record for display. For a
   * chosen workload it is the selected profile; for a custom workload it is the name it is
   * saved under, or the name of the existing profile it reuses (a content twin). */
  workloadName: string
  /** The distribution profile a custom workload should be saved to the catalog as, before
   * the run (auto-save on Run). Null when nothing new is saved: a chosen catalog workload,
   * or a custom workload whose content already exists under some name (reused, not
   * duplicated — P3). */
  saveProfile: ProfileBody | null
  target: Target
  /** A complete, runnable declaration. */
  yamlFile: string
  /** The single `runs:` entry, for pasting into an existing runs.yaml. */
  yamlRow: string
  /** The command line that declaration produces, for reading. */
  argv: string[]
  /** results/<group_id>/<run_id>.json, once the group_id is known. */
  resultPath: string | null
}

export interface Interpretation {
  issues: Issue[]
  /** null while any issue is blocking: an unrunnable declaration is not offered. */
  output: Output | null
  /** The table this candidate would land in, resolved even while the form is blocked, so
   * the "other flags from" selector can offer that table's runs (R7). */
  target: Target
  /** Non-blocking notices about the declaration, shown beside the form. Used to warn that a
   * custom workload matches one already saved and will reuse it rather than save a copy. */
  notes: string[]
}

/**
 * The arrival process blis will actually use. Mirrors internal/spec.arrivalProcess:
 * SynthesizeFromDistribution sets ArrivalSpec{Process: "constant"} in both modes,
 * and concurrency mode is closed-loop, where sessions rather than a clock drive
 * arrival. It is part of the group block, so getting it wrong would put a candidate
 * in the wrong table.
 */
export function arrivalProcess(kind: LoadKind): ArrivalProcess {
  return kind === 'concurrency' ? 'closed-loop' : 'constant'
}

/** The custom-card fields, split out so switching to Custom can prefill them (R5). */
export type CardFields = Pick<
  FormValues,
  | 'loadKind'
  | 'loadValue'
  | 'numRequests'
  | 'promptTokens'
  | 'promptTokensStdev'
  | 'promptTokensMin'
  | 'promptTokensMax'
  | 'outputTokens'
  | 'outputTokensStdev'
  | 'outputTokensMin'
  | 'outputTokensMax'
  | 'seed'
  | 'requestTimeoutS'
>

/** cardTokenFields flattens one token stream's card fields (mean/stdev/min/max) from a
 * TokenStat, so the input and output halves are filled the same way. */
function cardTokenFields(
  kind: 'prompt' | 'output',
  s: TokenStat,
): Pick<CardFields, `${'prompt' | 'output'}Tokens${'' | 'Stdev' | 'Min' | 'Max'}`> {
  return {
    [`${kind}Tokens`]: String(s.mean),
    [`${kind}TokensStdev`]: String(s.std_dev),
    [`${kind}TokensMin`]: String(s.min),
    [`${kind}TokensMax`]: String(s.max),
  } as Pick<CardFields, `${'prompt' | 'output'}Tokens${'' | 'Stdev' | 'Min' | 'Max'}`>
}

/** gaussianStat reads a TokenStat back out of a gaussian distribution object, or null if
 * the object is not a gaussian the card can represent. Used to prefill the card from a
 * saved single-client gaussian spec. */
function gaussianStat(dist: unknown): TokenStat | null {
  if (!dist || typeof dist !== 'object') return null
  const d = dist as { type?: unknown; params?: Record<string, unknown> }
  if (d.type !== 'gaussian' || !d.params) return null
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN)
  const stat = {
    mean: num(d.params.mean),
    std_dev: num(d.params.std_dev),
    min: num(d.params.min),
    max: num(d.params.max),
  }
  return Object.values(stat).every((n) => Number.isFinite(n)) ? stat : null
}

/** cardFromSpec extracts the card's token stats from a spec that is a single gaussian
 * client — the shape the card itself authors — so re-selecting a saved custom workload
 * prefills the card. Returns null for any richer spec the card cannot represent. */
function cardFromSpec(spec: unknown): { input: TokenStat; output: TokenStat } | null {
  if (!spec || typeof spec !== 'object') return null
  const clients = (spec as { clients?: unknown }).clients
  if (!Array.isArray(clients) || clients.length !== 1) return null
  const c = clients[0] as { input_distribution?: unknown; output_distribution?: unknown }
  const input = gaussianStat(c.input_distribution)
  const output = gaussianStat(c.output_distribution)
  return input && output ? { input, output } : null
}

/**
 * The custom card's starting values when the user picks "Custom" (R5). The card is a
 * single-client gaussian spec, so it prefills from a legacy distribution profile (bounds
 * derived), from a saved single-gaussian-client spec (bounds as authored), or — for a
 * richer spec the card cannot represent, or a fresh page — from FALLBACK_GROUP.
 */
export function customFieldsFrom(profile: ProfileBody | null): CardFields {
  if (profile && profile.workload.type === 'distribution') {
    const w = profile.workload
    const pMean = w.prompt_tokens ?? 0
    const pStd = w.prompt_tokens_stdev ?? 0
    const oMean = w.output_tokens ?? 0
    const oStd = w.output_tokens_stdev ?? 0
    return {
      loadKind: (w.load?.kind ?? 'rate') as LoadKind,
      loadValue: numeric(w.load?.value ?? 0),
      numRequests: String(w.num_requests ?? 0),
      ...cardTokenFields('prompt', { mean: pMean, std_dev: pStd, min: 1, max: deriveMax(pMean, pStd) }),
      ...cardTokenFields('output', { mean: oMean, std_dev: oStd, min: 1, max: deriveMax(oMean, oStd) }),
      seed: String(profile.seed),
      requestTimeoutS: String(profile.request_timeout_s),
    }
  }
  const fromSpec = profile?.workload.type === 'workload-spec' ? cardFromSpec(profile.workload.spec) : null
  if (profile && fromSpec) {
    const spec = profile.workload.spec as { num_requests?: unknown; aggregate_rate?: unknown; clients?: unknown[] }
    const client = (spec.clients?.[0] ?? {}) as { concurrency?: unknown }
    const concurrency = typeof client.concurrency === 'number' ? client.concurrency : null
    return {
      loadKind: (concurrency != null ? 'concurrency' : 'rate') as LoadKind,
      loadValue: numeric(concurrency ?? (typeof spec.aggregate_rate === 'number' ? spec.aggregate_rate : 0)),
      numRequests: String(typeof spec.num_requests === 'number' ? spec.num_requests : 0),
      ...cardTokenFields('prompt', fromSpec.input),
      ...cardTokenFields('output', fromSpec.output),
      seed: String(profile.seed),
      requestTimeoutS: String(profile.request_timeout_s),
    }
  }
  const w = FALLBACK_GROUP.workload
  return {
    loadKind: w.load.kind as LoadKind,
    loadValue: numeric(w.load.value),
    numRequests: String(w.num_requests),
    ...cardTokenFields('prompt', {
      mean: w.prompt_tokens,
      std_dev: w.prompt_tokens_stdev,
      min: 1,
      max: deriveMax(w.prompt_tokens, w.prompt_tokens_stdev),
    }),
    ...cardTokenFields('output', {
      mean: w.output_tokens,
      std_dev: w.output_tokens_stdev,
      min: 1,
      max: deriveMax(w.output_tokens, w.output_tokens_stdev),
    }),
    seed: String(FALLBACK_GROUP.seed),
    requestTimeoutS: String(FALLBACK_GROUP.request_timeout_s),
  }
}

/**
 * The basis the "paste this into runs.yaml" row is diffed against: the table's first
 * run, whose deployment stands in for that file's `defaults:` block. A field the
 * candidate shares with it is inherited rather than repeated, so the row spells out
 * only what the author changed. When the work is new (no such table), blis defaults
 * stand and the row spells out everything that differs from them.
 */
function rowBasis(target: RunGroup | null): Deployment {
  if (!target) return FALLBACK_DEPLOYMENT
  return target.records[0]?.deployment ?? FALLBACK_DEPLOYMENT
}

/**
 * The candidate's descriptive run id: `<hardware>-tp<tp>`, lower-cased to a usable
 * filename (mirrors the fixture's own ids, a100-tp1, h100-tp2). Hardware always comes
 * from the accelerator radios, so it is a catalogue name; the guard against a degenerate
 * base is defensive, so the seed is always a valid run_id even mid-edit.
 */
function runIdBase(hardware: string, tp: string): string {
  const hw = hardware.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '')
  const n = Number(tp)
  const tpPart = Number.isInteger(n) && n > 0 ? `tp${n}` : 'tp1'
  const base = hw ? `${hw}-${tpPart}` : `run-${tpPart}`
  return RUN_ID_PATTERN.test(base) ? base : 'run'
}

/**
 * The run id the form seeds and keeps in step with the candidate until the reader edits
 * it: the descriptive base, deduplicated against the table it would join with a -2/-3
 * suffix, so a fresh page is runnable without anyone typing a filename first. The id is
 * a filename, not the comparability key, so a candidate that differs only by model still
 * gets a distinct id via the suffix. It never reads values.runId, so re-suggesting from a
 * form that already holds the suggestion is a fixed point — the sync effect converges.
 */
export function suggestRunId(values: FormValues, groups: RunGroup[], profiles: ProfileBody[]): string {
  const base = runIdBase(values.hardware, values.tp)
  const noop: (field: Issue['field'], message: string) => void = () => {}
  const group =
    values.workloadSel === '' ? customGroup(values, noop, () => {}) : profileGroup(values, profiles, noop)
  const taken = new Set<string>()
  if (group) for (const r of findTarget(group, groups).group?.records ?? []) taken.add(r.run_id)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * The custom card's suggested name: the lowest-numbered `custom-N` (N ≥ 1) that no catalog
 * profile already holds. A custom workload is saved to the catalog on Run (P3), so it needs
 * a name that is both valid and unique, the same reason the run id is deduplicated. This
 * lets the card open on a usable name rather than a blank field, and gives a fresh one for
 * the next custom run once the last is saved. It reads only the catalog, never the current
 * field, so setting the field to its output is a fixed point and the sync effect converges.
 */
export function suggestWorkloadName(profiles: ProfileBody[]): string {
  const taken = new Set(profiles.map((p) => p.name))
  for (let n = 1; ; n++) {
    const candidate = `custom-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Default form state: the custom card, seeded from the fallback. The component upgrades
 * this to the first catalog entry once profiles load (R2); with no server the page stays
 * here, which is exactly today's offline authoring capability (R8). The run id opens on
 * the candidate's descriptive base and the custom name on `custom-1`; the component's sync
 * effects dedupe both against the board and the catalog on mount and keep them current
 * until the reader types their own.
 */
export function initialValues(): FormValues {
  const d = FALLBACK_DEPLOYMENT
  return {
    runId: runIdBase(d.hardware, String(d.tp)),
    model: d.model,
    hardware: d.hardware,
    tp: String(d.tp),
    dp: String(d.dp),
    enableExpertParallel: false,
    moeCommBackend: '',
    numInstances: String(d.num_instances),
    // Disaggregation off by default (all pools 0); the transfer knobs carry blis's defaults
    // so the card opens on them when a pool is set.
    prefillInstances: '0',
    decodeInstances: '0',
    prefillDecodeInstances: '0',
    pdDecider: 'never',
    pdPrefixThreshold: '16',
    pdTransferBandwidth: '25',
    pdTransferBaseLatency: '0.05',
    pdTransferContention: false,
    maxModelLen: String(d.max_model_len),
    blockSize: String(d.block_size_in_tokens),
    maxNumSeqs: String(d.max_num_seqs),
    maxNumBatchedTokens: String(d.max_num_batched_tokens),
    longPrefillTokenThreshold: String(d.long_prefill_token_threshold),
    scheduler: d.scheduler,
    preemptionPolicy: d.preemption_policy,
    routingPolicy: d.routing_policy,
    routingScorers: [],
    admissionPolicy: d.admission_policy,
    kvCacheDtype: d.kv_cache_dtype,
    latencyModel: d.latency_model,
    gpuMemoryUtilization: String(d.gpu_memory_utilization),
    numSpeculativeTokens: String(d.num_speculative_tokens),
    speculativeAcceptanceRate: String(d.speculative_acceptance_rate),
    speculativeMethod: d.speculative_method,
    workloadSel: '',
    customName: suggestWorkloadName([]),
    ...customFieldsFrom(null),
  }
}

/**
 * Validates the form and, when it is runnable, builds everything the screen shows.
 * The checks mirror internal/spec's Load and Check, so a declaration this accepts is
 * one the CLI accepts — the point of validating here is to say why before a
 * simulator run is spent finding out.
 */
export function interpret(
  values: FormValues,
  groups: RunGroup[],
  profiles: ProfileBody[],
  models: ModelInfo[] = [],
  hardware: HardwareInfo[] = [],
): Interpretation {
  const issues: Issue[] = []
  const push = (field: Issue['field'], message: string) => issues.push({ field, message })

  const runId = values.runId.trim()
  if (runId === '') {
    push('runId', 'A run needs an id: it is also its filename.')
  } else if (!RUN_ID_PATTERN.test(runId)) {
    push(
      'runId',
      'Use lower-case letters, digits, dot, dash or underscore, starting with a letter ' +
        'or digit — it becomes results/<group>/<run_id>.json.',
    )
  }

  const tp = Number(values.tp)
  if (!Number.isInteger(tp) || tp <= 0) {
    push('tp', 'Tensor parallelism is a whole number of GPUs, 1 or more.')
  }

  const dp = Number(values.dp)
  if (!Number.isInteger(dp) || dp <= 0) {
    push('dp', 'Data parallelism is a whole number, 1 or more. blis defaults it to 1; it is MoE-only.')
  }
  const numInstances = Number(values.numInstances)
  if (!Number.isInteger(numInstances) || numInstances <= 0) {
    push('numInstances', 'The instance count is a whole number, 1 or more.')
  }
  const maxModelLen = Number(values.maxModelLen)
  if (!Number.isInteger(maxModelLen) || maxModelLen < 0) {
    push(
      'maxModelLen',
      'Max model length is a whole number, 0 or more. 0 lets blis derive it from the model config.',
    )
  }
  const blockSize = Number(values.blockSize)
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    push('blockSize', 'KV block size is a whole number of tokens, 1 or more.')
  }
  const maxNumSeqs = Number(values.maxNumSeqs)
  if (!Number.isInteger(maxNumSeqs) || maxNumSeqs <= 0) {
    push('maxNumSeqs', 'Max sequences in a batch is a whole number, 1 or more.')
  }
  const maxNumBatchedTokens = Number(values.maxNumBatchedTokens)
  if (!Number.isInteger(maxNumBatchedTokens) || maxNumBatchedTokens <= 0) {
    push('maxNumBatchedTokens', 'Max batched tokens is a whole number, 1 or more.')
  }
  const longPrefillTokenThreshold = Number(values.longPrefillTokenThreshold)
  if (!Number.isInteger(longPrefillTokenThreshold) || longPrefillTokenThreshold < 0) {
    push('longPrefillTokenThreshold', 'Long-prefill token threshold is a whole number, 0 or more. 0 turns chunked prefill off.')
  }
  const gpuMemoryUtilization = Number(values.gpuMemoryUtilization)
  if (!Number.isFinite(gpuMemoryUtilization) || gpuMemoryUtilization <= 0 || gpuMemoryUtilization > 1) {
    push('gpuMemoryUtilization', 'GPU memory utilization is a fraction in (0, 1.0]. blis defaults it to 0.9.')
  }
  const numSpeculativeTokens = Number(values.numSpeculativeTokens)
  if (!Number.isInteger(numSpeculativeTokens) || numSpeculativeTokens < 0) {
    push('numSpeculativeTokens', 'Draft tokens is a whole number, 0 or more. 0 turns speculative decoding off.')
  }
  const speculativeAcceptanceRate = Number(values.speculativeAcceptanceRate)
  if (!Number.isFinite(speculativeAcceptanceRate) || speculativeAcceptanceRate < 0 || speculativeAcceptanceRate > 1) {
    push('speculativeAcceptanceRate', 'Acceptance rate is a fraction in [0, 1].')
  }
  if (!SPECULATIVE_METHODS.includes(values.speculativeMethod)) {
    push('speculativeMethod', `Speculative method must be one of ${SPECULATIVE_METHODS.filter((m) => m !== '').join(', ')}, or blank.`)
  }
  // blis rejects a method or a non-zero acceptance rate when the feature is off, so the
  // form says so before a run is spent finding out (mirrors sim/config.go's Validate).
  if (numSpeculativeTokens === 0 && values.speculativeMethod !== '') {
    push('speculativeMethod', 'A speculative method is only valid when draft tokens is greater than 0.')
  }
  if (numSpeculativeTokens === 0 && speculativeAcceptanceRate !== 0) {
    push('speculativeAcceptanceRate', 'An acceptance rate is only valid when draft tokens is greater than 0.')
  }

  // Weighted routing blends a set of named scorers, each with a positive weight
  // (--routing-scorers). The form only offers valid names, so these checks mirror the
  // structural rules of sim.ParseScorerConfigs: at least one scorer, and every weight a
  // finite number > 0. A run with an empty profile under weighted routing would make blis
  // fall back to its own default profile, which the record could not then reproduce, so
  // the profile must be spelled out. Any other policy carries none.
  const weightedRouting = values.routingPolicy === 'weighted'
  const routingScorers = values.routingScorers.map((s) => ({ name: s.name, weight: Number(s.weight) }))
  if (weightedRouting) {
    if (values.routingScorers.length === 0) {
      push(
        'routingScorers',
        'Weighted routing needs at least one scorer. blis would otherwise fall back to its ' +
          'own default profile, which this record could not reproduce.',
      )
    }
    for (const s of values.routingScorers) {
      const w = Number(s.weight)
      if (!Number.isFinite(w) || w <= 0) {
        push('routingScorers', `The weight for ${s.name} must be a finite number greater than 0.`)
        break
      }
    }
  }

  // MoE knobs. blis fatally rejects --enable-expert-parallel on a dense model, and only
  // charges the MoE comm cost for a MoE model on trained-physics with dp>1 or expert
  // parallelism. The form guards all of that before a run is spent (mirrors cmd/root.go).
  const moe = isMoE(models, values.model)
  const trainedPhysics = values.latencyModel === 'trained-physics'
  if (values.enableExpertParallel) {
    if (!moe) push('enableExpertParallel', `Expert parallelism needs a MoE model; ${values.model} is dense.`)
    if (!trainedPhysics) push('enableExpertParallel', 'Expert parallelism needs the trained-physics latency model.')
  }
  if (values.moeCommBackend !== '') {
    if (!moe) push('moeCommBackend', `A MoE comm backend needs a MoE model; ${values.model} is dense.`)
    if (!trainedPhysics) push('moeCommBackend', 'A MoE comm backend needs the trained-physics latency model.')
    if (dp <= 1 && !values.enableExpertParallel) {
      push('moeCommBackend', 'A MoE comm backend is only charged with dp > 1 or expert parallelism on.')
    }
  }

  // Prefill/decode disaggregation. When any pool is set the counts must satisfy
  // cluster.ValidatePoolTopology: prefill and decode are both set unless the shared-role
  // pool is, and their sum fits in num_instances. The transfer physics are validated the
  // way blis does (bandwidth finite > 0, base latency finite >= 0).
  const prefillInstances = Number(values.prefillInstances)
  const decodeInstances = Number(values.decodeInstances)
  const prefillDecodeInstances = Number(values.prefillDecodeInstances)
  const pdPrefixThreshold = Number(values.pdPrefixThreshold)
  const pdTransferBandwidth = Number(values.pdTransferBandwidth)
  const pdTransferBaseLatency = Number(values.pdTransferBaseLatency)
  const pdActive = [prefillInstances, decodeInstances, prefillDecodeInstances].some((n) => n > 0)
  for (const [field, n] of [
    ['prefillInstances', prefillInstances],
    ['decodeInstances', decodeInstances],
    ['prefillDecodeInstances', prefillDecodeInstances],
  ] as const) {
    if (!Number.isInteger(n) || n < 0) push(field, 'Instance count is a whole number, 0 or more.')
  }
  if (pdActive) {
    if (prefillDecodeInstances === 0 && (prefillInstances === 0 || decodeInstances === 0)) {
      push(
        'form',
        'Disaggregation needs both a prefill and a decode pool, unless you use the shared-role ' +
          '(prefill+decode) pool instead.',
      )
    }
    if (prefillInstances + decodeInstances + prefillDecodeInstances > numInstances) {
      push(
        'form',
        `The prefill, decode and shared pools total ${prefillInstances + decodeInstances + prefillDecodeInstances} ` +
          `instances, more than the ${numInstances} in the cluster. Raise Instances or shrink a pool.`,
      )
    }
    if (values.pdDecider === 'prefix-threshold' && (!Number.isInteger(pdPrefixThreshold) || pdPrefixThreshold < 0)) {
      push('pdPrefixThreshold', 'The prefix threshold is a whole number of tokens, 0 or more.')
    }
    if (!Number.isFinite(pdTransferBandwidth) || pdTransferBandwidth <= 0) {
      push('pdTransferBandwidth', 'Transfer bandwidth is a finite number greater than 0 (GB/s).')
    }
    if (!Number.isFinite(pdTransferBaseLatency) || pdTransferBaseLatency < 0) {
      push('pdTransferBaseLatency', 'Transfer base latency is a finite number, 0 or more (ms).')
    }
  }

  // The hardware catalogue is fetched from the server (GET /api/hardware, read from the
  // upstream hardware_config.json), so an empty list means it has not loaded yet or could
  // not be reached: with none in hand the form cannot judge the accelerator and skips the
  // check rather than rejecting every value, exactly as the model check does. Once loaded,
  // an unknown name is rejected — an alias name counts as known, since blis accepts it and
  // the list carries every name upstream defines.
  if (hardware.length > 0 && !hardware.some((hw) => hw.name === values.hardware)) {
    push(
      'hardware',
      `${values.hardware || 'No accelerator'} is not in ../inference-sim/hardware_config.json; ` +
        `the catalogue holds ${hardware.map((hw) => hw.name).join(', ')}.`,
    )
  }

  // The model catalog is fetched from the server (GET /api/models, read from the
  // blis-catalog clone), so an empty list means it has not loaded yet or could not be
  // reached: with no catalog in hand the form cannot judge the model and skips the check
  // rather than rejecting every value. Once loaded, an unknown model is rejected against
  // the fetched names.
  if (models.length > 0 && !models.some((m) => m.name === values.model)) {
    push(
      'model',
      `${values.model || 'No model'} is not in the blis-catalog; ` +
        `the catalogue holds ${models.map((m) => m.name).join(', ')}.`,
    )
  }

  // The work offered: a selected catalog profile, or the custom card. Model is no longer
  // a group field (E1) — it rides on the candidate — so the group is model-free either way.
  // notes collects non-blocking warnings (a clamped custom distribution, a reused twin).
  const notes: string[] = []
  const group =
    values.workloadSel === ''
      ? customGroup(values, push, (m) => notes.push(m))
      : profileGroup(values, profiles, push)

  // The two workload types the page offers: a chosen catalog workload (a preset or saved
  // profile, named by workloadSel), or a custom workload defined below. A custom workload
  // is saved to the catalog on Run so it can be reused, so it carries a name and resolves
  // to either a new profile to save or an existing one to reuse (P3: one name per
  // workload). A chosen workload saves nothing and names the profile it selected.
  let workloadName = values.workloadSel
  let saveProfile: ProfileBody | null = null
  if (values.workloadSel === '' && group) {
    const resolved = resolveCustomWorkload(values.customName, group, profiles, push)
    workloadName = resolved.workloadName
    saveProfile = resolved.saveProfile
    notes.push(...resolved.notes)
  }

  let baseDeployment = FALLBACK_DEPLOYMENT
  let deployment: Deployment = FALLBACK_DEPLOYMENT
  let target: Target = { group: null }
  if (group) {
    target = findTarget(group, groups)
    baseDeployment = rowBasis(target.group)
    deployment = {
      // Model is a candidate field now (E1): it rides on the deployment, not the group.
      model: values.model,
      hardware: values.hardware,
      tp,
      dp,
      // MoE knobs omitted when off (false / ''), so a dense-model candidate is canonically
      // unchanged; they are only present here once the guards above have passed.
      ...(values.enableExpertParallel ? { enable_expert_parallel: true } : {}),
      ...(values.moeCommBackend !== ''
        ? { moe_comm_backend: values.moeCommBackend as Deployment['moe_comm_backend'] }
        : {}),
      num_instances: numInstances,
      // The disaggregation block is present only when a pool is set, so a non-disaggregated
      // candidate omits it and stays canonically identical to a stored record.
      ...(pdActive
        ? {
            disaggregation: {
              prefill_instances: prefillInstances,
              decode_instances: decodeInstances,
              prefill_decode_instances: prefillDecodeInstances,
              decider: values.pdDecider as NonNullable<Deployment['disaggregation']>['decider'],
              prefix_threshold: pdPrefixThreshold,
              transfer_bandwidth: pdTransferBandwidth,
              transfer_base_latency: pdTransferBaseLatency,
              transfer_contention: values.pdTransferContention,
            } as Deployment['disaggregation'],
          }
        : {}),
      max_model_len: maxModelLen,
      block_size_in_tokens: blockSize,
      max_num_seqs: maxNumSeqs,
      max_num_batched_tokens: maxNumBatchedTokens,
      long_prefill_token_threshold: longPrefillTokenThreshold,
      // The dropdowns offer only names from catalog.ts, which are exactly the members of
      // these unions, so the widening cast never lets an out-of-set value through.
      scheduler: values.scheduler as Deployment['scheduler'],
      preemption_policy: values.preemptionPolicy as Deployment['preemption_policy'],
      routing_policy: values.routingPolicy as Deployment['routing_policy'],
      // Omitted unless the policy is weighted with a profile, so a non-weighted candidate's
      // canonical form — and twin-detection against every stored record — is unchanged.
      ...(weightedRouting && routingScorers.length > 0
        ? { routing_scorers: routingScorers as Deployment['routing_scorers'] }
        : {}),
      admission_policy: values.admissionPolicy as Deployment['admission_policy'],
      kv_cache_dtype: values.kvCacheDtype as Deployment['kv_cache_dtype'],
      latency_model: values.latencyModel as Deployment['latency_model'],
      gpu_memory_utilization: gpuMemoryUtilization,
      num_speculative_tokens: numSpeculativeTokens,
      speculative_acceptance_rate: speculativeAcceptanceRate,
      speculative_method: values.speculativeMethod as Deployment['speculative_method'],
      // The form declares a clean candidate; extra_flags is the CLI/runs.yaml escape
      // hatch for a blis flag with no field here, so a form-declared run carries none.
      extra_flags: {},
    }

    // Everything below is a collision with what the target table already holds, so it
    // only applies when this candidate joins an existing one.
    if (target.group) {
      const existing = target.group
      if (runId !== '' && existing.records.some((r) => r.run_id === runId)) {
        push(
          'runId',
          `${existing.groupId} already holds a run called ${runId} — running this would overwrite it.`,
        )
      }
      const twin = existing.records.find((r) => canonical(r.deployment) === canonical(deployment))
      if (twin) {
        push(
          'form',
          `This is the same deployment as ${twin.run_id}, already in ${existing.groupId}. ` +
            'Two rows that differ in nothing differ invisibly, so the CLI rejects the pair — change a knob.',
        )
      }
      for (const alias of hardwareAliases(hardware, values.hardware)) {
        const clash = existing.records.find((r) => r.deployment.hardware === alias)
        if (clash) {
          push(
            'hardware',
            `${values.hardware} and ${alias} are defined with identical specs upstream, and ` +
              `${clash.run_id} already uses ${alias} — this would be a duplicate row, not a rival.`,
          )
        }
      }
    }
  }

  if (issues.length > 0 || group === null) return { issues, output: null, target, notes }

  const specPath = `/tmp/${runId || 'run'}.workload.yaml`
  return {
    issues,
    target,
    notes,
    output: {
      group,
      deployment,
      runId,
      // The name a catalog workload was chosen by, or the name a custom workload is saved
      // under (or the existing profile it reuses when its content already exists).
      workloadName,
      saveProfile,
      target,
      yamlFile: yamlFile(group, deployment, runId),
      yamlRow: yamlRow(deployment, baseDeployment, runId),
      argv: argvFor('./blis', group, deployment, `/tmp/${runId}.json`, specPath),
      resultPath: target.group ? `results/${target.group.groupId}/${runId}.json` : null,
    },
  }
}

/** The group for a selected catalog profile: the profile's work (spec or distribution),
 * model-free (E1 — model rides on the candidate). A name that has since left the catalog
 * is an issue, never a silent fallback — a run must not diverge from the workload it names. */
function profileGroup(
  values: FormValues,
  profiles: ProfileBody[],
  push: (field: Issue['field'], message: string) => void,
): Group | null {
  const profile = profiles.find((p) => p.name === values.workloadSel)
  if (!profile) {
    push(
      'workloadSel',
      `"${values.workloadSel}" is no longer in the catalog — pick another workload, or define a custom one.`,
    )
    return null
  }
  return profileToGroup(profile)
}

/** The group for the custom card: a single-client gaussian workload-spec (R5). The card
 * is a guided front end for a one-client spec, so its numbers are validated against blis's
 * gaussian rules — the sampler clamps every draw to [min, max] and floors it at 1
 * (../inference-sim/sim/workload/distribution_test.go), so the only hard bound error is
 * min > max — and then folded into a WorkloadSpec by gaussianSpec. Unlike the flat
 * synthesize path (root.go:365), a mean outside [min, max] is not rejected; it is a soft
 * warning, because blis accepts it and clamps. */
function customGroup(
  values: FormValues,
  push: (field: Issue['field'], message: string) => void,
  note: (message: string) => void,
): Group {
  const numRequests = Number(values.numRequests)
  if (!Number.isInteger(numRequests) || numRequests <= 0) {
    push('numRequests', 'Request count is a whole number, 1 or more.')
  }
  const loadValue = Number(values.loadValue)
  if (!Number.isFinite(loadValue) || loadValue <= 0) {
    push(
      'loadValue',
      values.loadKind === 'rate'
        ? 'Offered rate is a positive number of requests per second.'
        : 'Concurrency is a positive number of in-flight sessions.',
    )
  }
  // One token stream's gaussian stats, each field validated and the whole checked for a
  // usable clamp. `label` is the reader's word ("Input"/"Output"); the field keys tie the
  // message to the input that is wrong.
  const stream = (
    label: string,
    meanF: 'promptTokens' | 'outputTokens',
    stdevF: 'promptTokensStdev' | 'outputTokensStdev',
    minF: 'promptTokensMin' | 'outputTokensMin',
    maxF: 'promptTokensMax' | 'outputTokensMax',
  ): TokenStat => {
    const mean = Number(values[meanF])
    if (!Number.isInteger(mean) || mean <= 0) {
      push(meanF, `${label} tokens (mean) is a whole number, 1 or more.`)
    }
    const std_dev = Number(values[stdevF])
    if (!Number.isInteger(std_dev) || std_dev < 0) {
      push(stdevF, `${label}-token spread is a whole number, 0 or more.`)
    }
    const min = Number(values[minF])
    if (!Number.isInteger(min) || min < 1) {
      push(minF, `${label} tokens (min) is a whole number, 1 or more.`)
    }
    const max = Number(values[maxF])
    if (!Number.isInteger(max) || max < 1) {
      push(maxF, `${label} tokens (max) is a whole number, 1 or more.`)
    }
    if (Number.isInteger(min) && Number.isInteger(max) && max < min) {
      push(maxF, `${label} tokens (max) must be at least the min (${min}).`)
    } else if (
      Number.isInteger(mean) &&
      Number.isInteger(min) &&
      Number.isInteger(max) &&
      (mean < min || mean > max)
    ) {
      note(`${label} tokens: the mean (${mean}) is outside [${min}, ${max}], so every request clamps to a bound.`)
    }
    return { mean, std_dev, min, max }
  }
  const input = stream('Input', 'promptTokens', 'promptTokensStdev', 'promptTokensMin', 'promptTokensMax')
  const output = stream('Output', 'outputTokens', 'outputTokensStdev', 'outputTokensMin', 'outputTokensMax')
  const seed = Number(values.seed)
  if (!Number.isInteger(seed) || seed < 0) {
    push('seed', 'The seed is a non-negative whole number.')
  }
  const requestTimeoutS = Number(values.requestTimeoutS)
  if (!Number.isInteger(requestTimeoutS) || requestTimeoutS === 0) {
    push(
      'requestTimeoutS',
      'A deadline of 0 is rejected by blis; use a positive number of seconds, or a negative value to disable it.',
    )
  }

  // The card is a one-client spec; gaussianSpec builds it, and the group carries it in the
  // same workload-spec shape profileToGroup produces, so findTarget and the argv/runs.yaml
  // writers treat a custom run exactly like a selected spec workload. The flat
  // distribution fields are the not-applicable placeholder zeros a spec record carries.
  const spec = gaussianSpec({ numRequests, load: { kind: values.loadKind, value: loadValue }, input, output })
  return {
    seed,
    horizon_ticks: null,
    request_timeout_s: requestTimeoutS,
    workload: {
      type: 'workload-spec',
      arrival_process: 'constant',
      num_requests: 0,
      load: { kind: 'rate', value: 0 },
      prompt_tokens: 0,
      prompt_tokens_stdev: 0,
      output_tokens: 0,
      output_tokens_stdev: 0,
      spec_file: null,
      spec_sha256: null,
      spec,
    } as Group['workload'],
  }
}

/**
 * Resolves a custom workload against the catalog: its name, whether it is a new profile to
 * save, and any non-blocking reuse warning. A custom workload is saved on Run so it can be
 * reused (the second workload type), but the catalog keeps one name per workload (P3), so:
 *   - an empty or malformed name blocks (a saved workload must be nameable);
 *   - the same name already holding this exact work reuses it, saving nothing;
 *   - a name taken by a workload with different content blocks (rename to save);
 *   - a content twin under another name reuses that name, saving nothing (no duplicate);
 *   - otherwise it is a new distribution profile to save under the given name.
 * The comparison mirrors the server's content-twin key (internal/catalog.contentKey): the
 * canonical model-free group, which is exactly what profileToGroup and customGroup build.
 * The server is the final authority at save time; a race there surfaces as a run error.
 */
function resolveCustomWorkload(
  rawName: string,
  group: Group,
  profiles: ProfileBody[],
  push: (field: Issue['field'], message: string) => void,
): { workloadName: string; saveProfile: ProfileBody | null; notes: string[] } {
  const name = rawName.trim()
  const notes: string[] = []
  if (name === '') {
    push('customName', 'A custom workload needs a name: it is saved to the catalog so you can reuse it.')
    return { workloadName: name, saveProfile: null, notes }
  }
  if (!NAME_PATTERN.test(name)) {
    push('customName', 'Use lower-case letters, digits, dash, underscore or dot.')
    return { workloadName: name, saveProfile: null, notes }
  }
  const content = workloadContentKey(group)
  const named = profiles.find((p) => p.name === name)
  if (named) {
    if (workloadContentKey(profileToGroup(named)) === content) {
      notes.push(`"${name}" is already saved with this exact work. The run will use it, and nothing new is saved.`)
      return { workloadName: name, saveProfile: null, notes }
    }
    push('customName', `A different workload named "${name}" already exists. Choose another name.`)
    return { workloadName: name, saveProfile: null, notes }
  }
  const twin = profiles.find((p) => workloadContentKey(profileToGroup(p)) === content)
  if (twin) {
    notes.push(`This matches the saved workload "${twin.name}". The run will use it, and nothing new is saved.`)
    return { workloadName: twin.name, saveProfile: null, notes }
  }
  return { workloadName: name, saveProfile: customProfileBody(name, group), notes }
}

/** workloadContentKey is a group's twin-detection key: its canonical form with the derived
 * spec_sha256 dropped. A freshly built custom group has no sha yet (the server computes it)
 * while a saved spec profile carries one, so comparing on the raw canonical would never
 * match identical specs. Dropping the hash compares the spec content that actually decides
 * the work, mirroring the server's content-twin key (internal/catalog.contentKey); the
 * server stays the final authority at save time. */
function workloadContentKey(group: Group): string {
  const w = group.workload as Record<string, unknown>
  const { spec_sha256: _dropped, ...workload } = w
  return canonical({ ...group, workload })
}

/** Builds the workload-spec profile a custom workload is saved to the catalog as: the
 * one-client gaussian spec the card holds and the group-side knobs, under the given name.
 * Mirrors the catalog's workload-spec profile shape (cmd/leaderboard.profileBody), so the
 * server's create path accepts it with no Go change. */
function customProfileBody(name: string, group: Group): ProfileBody {
  // A custom workload is a single-client gaussian spec, so it saves as a workload-spec
  // profile — the same shape the Workloads editor saves. The server parses spec_yaml and
  // computes its spec_sha256, so the browser sends the YAML, not a hash.
  const spec = group.workload.spec as unknown as SpecObject
  return {
    name,
    seed: group.seed,
    horizon_ticks: group.horizon_ticks,
    request_timeout_s: group.request_timeout_s,
    workload: {
      type: 'workload-spec',
      spec_yaml: serializeSpec(spec),
    },
  }
}

/**
 * Whether this declaration joins an existing table or starts a new one. The comparison
 * is on the canonicalised group block minus the derived spec_sha256 (workloadContentKey):
 * that hash is what group_id folds in, but a form-built group has not been hashed yet
 * (the server does it), so a custom run that repeats committed work would otherwise never
 * recognise its own table. Comparing the spec content instead answers the question the
 * same way the CLI will, for either workload variant, without reimplementing the hash.
 * Model no longer decides the table (E1): changing the model keeps the same work, so a run
 * against a new model joins the existing workload's table rather than starting one. Only a
 * change to the work offered starts a new table.
 */
export function findTarget(group: Group, groups: RunGroup[]): Target {
  const key = workloadContentKey(group)
  const match = groups.find((g) => workloadContentKey(g.group) === key)
  return { group: match ?? null }
}

/** The `group.workload` block for a distribution: the flat synthetic fields. */
function distributionWorkloadLines(w: Group['workload']): string[] {
  return [
    '  workload:',
    `    type: ${w.type}`,
    `    num_requests: ${w.num_requests}`,
    '    load:',
    `      kind: ${w.load.kind}`,
    `      value: ${numeric(w.load.value)}`,
    `    prompt_tokens: ${w.prompt_tokens}`,
    `    prompt_tokens_stdev: ${w.prompt_tokens_stdev}`,
    `    output_tokens: ${w.output_tokens}`,
    `    output_tokens_stdev: ${w.output_tokens_stdev}`,
  ]
}

/** The `group.workload` block for a spec: the inline WorkloadSpec, indented under `spec:`. */
function specWorkloadLines(w: Group['workload']): string[] {
  const spec = (w as { spec?: SpecObject }).spec ?? {}
  const specYaml = serializeSpec(spec).replace(/\n$/, '')
  return [
    '  workload:',
    '    type: workload-spec',
    '    spec:',
    ...specYaml.split('\n').map((line) => (line ? `      ${line}` : line)),
  ]
}

/**
 * A complete runs.yaml for this one candidate. Every deployment field is written
 * out, including the ones the form does not expose, so the file reproduces the run
 * without depending on what blis happens to default to.
 */
export function yamlFile(group: Group, deployment: Deployment, runId: string): string {
  const w = group.workload
  const isSpec = w.type === 'workload-spec'
  // The CLI runs.yaml path (internal/spec.Load) only consumes a distribution; it rejects
  // an inline workload-spec. So a spec declaration is written as a record of what ran —
  // reproduced by the Run button, or by blis directly with the argv below — not as a
  // `leaderboard run` input.
  const header = isSpec
    ? [
        '# Written by the leaderboard web app: a record of a workload-spec run.',
        '# `leaderboard run` does not read an inline spec yet — reproduce this with the Run',
        '# button, or by running blis directly with the argv shown below the declaration.',
        'schema_version: 1',
      ]
    : [
        '# Written by the leaderboard web app. Save it, then run:',
        '#   ./bin/leaderboard run -runs runs.new.yaml',
        '# blis is executed with ../inference-sim as its working directory.',
        'schema_version: 1',
      ]
  const workloadLines = isSpec ? specWorkloadLines(w) : distributionWorkloadLines(w)
  const lines: string[] = [
    ...header,
    '',
    '# The work offered. Changing any field here means a different table, not another row.',
    'group:',
    `  seed: ${group.seed}`,
    `  horizon_ticks: ${group.horizon_ticks == null ? 'null' : group.horizon_ticks}`,
    `  request_timeout_s: ${group.request_timeout_s}`,
    ...workloadLines,
    '',
    '# Serving configuration, written in full so the file stands on its own. model is a',
    '# candidate now (E1): a row may override it to put a second model in this table.',
    'defaults:',
    `  model: ${deployment.model}`,
    `  dp: ${deployment.dp}`,
    // MoE and disaggregation are written only when set, matching the record and the argv.
    ...(deployment.enable_expert_parallel ? ['  enable_expert_parallel: true'] : []),
    ...(deployment.moe_comm_backend ? [`  moe_comm_backend: ${deployment.moe_comm_backend}`] : []),
    `  num_instances: ${deployment.num_instances}`,
    ...(deployment.disaggregation
      ? [`  disaggregation: ${disaggregationFlow(deployment.disaggregation)}`]
      : []),
    `  max_model_len: ${deployment.max_model_len}`,
    `  block_size_in_tokens: ${deployment.block_size_in_tokens}`,
    `  max_num_seqs: ${deployment.max_num_seqs}`,
    `  max_num_batched_tokens: ${deployment.max_num_batched_tokens}`,
    `  long_prefill_token_threshold: ${deployment.long_prefill_token_threshold}`,
    `  scheduler: ${deployment.scheduler}`,
    `  preemption_policy: ${deployment.preemption_policy}`,
    `  routing_policy: ${deployment.routing_policy}`,
    // Written only for a weighted profile — the same rule the record and the argv follow.
    ...(deployment.routing_scorers && deployment.routing_scorers.length > 0
      ? [`  routing_scorers: ${scorerFlow(deployment.routing_scorers)}`]
      : []),
    `  admission_policy: ${deployment.admission_policy}`,
    `  kv_cache_dtype: ${deployment.kv_cache_dtype}`,
    `  latency_model: ${deployment.latency_model}`,
    `  gpu_memory_utilization: ${deployment.gpu_memory_utilization}`,
    `  num_speculative_tokens: ${deployment.num_speculative_tokens}`,
    `  speculative_acceptance_rate: ${deployment.speculative_acceptance_rate}`,
    `  speculative_method: ${deployment.speculative_method === '' ? "''" : deployment.speculative_method}`,
  ]
  const extra = Object.entries(deployment.extra_flags ?? {})
  if (extra.length > 0) {
    lines.push('  extra_flags:')
    for (const [flag, value] of extra.sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`    ${flag}: ${value}`)
    }
  }
  lines.push('', 'runs:', `  ${yamlRow(deployment, deployment, runId)}`)
  return lines.join('\n') + '\n'
}

/**
 * The `runs:` entry alone. Fields already carried by the target file's `defaults:`
 * are omitted — anything that differs from the basis run is spelled out, because a
 * row that silently inherits a knob it meant to change is the mistake this repo
 * treats as structural.
 */
export function yamlRow(deployment: Deployment, basis: Deployment, runId: string): string {
  const fields = [`run_id: ${runId || '<run_id>'}`, `hardware: ${deployment.hardware}`, `tp: ${deployment.tp}`]
  const rest = Object.entries(deployment) as [keyof Deployment, unknown][]
  for (const [key, value] of rest) {
    if (key === 'hardware' || key === 'tp' || key === 'extra_flags') continue
    if (JSON.stringify(value) === JSON.stringify(basis[key])) continue
    // routing_scorers is a list of objects, so String() would render "[object Object]";
    // spell it out as the same inline flow the full file uses.
    if (key === 'routing_scorers') {
      fields.push(`routing_scorers: ${scorerFlow(value as NonNullable<Deployment['routing_scorers']>)}`)
      continue
    }
    // disaggregation is an object; String() would render "[object Object]", so spell it out
    // as the inline-flow map the full file uses.
    if (key === 'disaggregation') {
      fields.push(`disaggregation: ${disaggregationFlow(value as NonNullable<Deployment['disaggregation']>)}`)
      continue
    }
    fields.push(`${key}: ${String(value)}`)
  }
  return `- {${fields.join(', ')}}`
}

/** A routing profile as inline-flow YAML: [{name: <n>, weight: <w>}, …]. Valid YAML the
 * spec loader accepts (it decodes runs.yaml through the same JSON round-trip the record
 * uses), and readable in the one-line runs.yaml row. */
function scorerFlow(scorers: NonNullable<Deployment['routing_scorers']>): string {
  const items = scorers.map((s) => `{name: ${s.name}, weight: ${numeric(s.weight)}}`)
  return `[${items.join(', ')}]`
}

/** A disaggregation block as inline-flow YAML, so it fits the full file and the one-line
 * runs.yaml row and round-trips through the spec loader's JSON decode. */
function disaggregationFlow(pd: NonNullable<Deployment['disaggregation']>): string {
  return (
    `{prefill_instances: ${pd.prefill_instances}, decode_instances: ${pd.decode_instances}, ` +
    `prefill_decode_instances: ${pd.prefill_decode_instances}, decider: ${pd.decider}, ` +
    `prefix_threshold: ${pd.prefix_threshold}, transfer_bandwidth: ${numeric(pd.transfer_bandwidth)}, ` +
    `transfer_base_latency: ${numeric(pd.transfer_base_latency)}, transfer_contention: ${pd.transfer_contention}}`
  )
}

/**
 * The blis command line this declaration produces. A port of
 * internal/blisrun.Argv, pinned to it by a test over every committed record's
 * stored argv — the flag order, the omitted --dp and the omitted --max-model-len
 * are all load-bearing there.
 */
export function argvFor(
  binary: string,
  g: Group,
  d: Deployment,
  metricsPath: string,
  specPath = '',
): string[] {
  const a: string[] = [binary, 'run']
  const add = (flag: string, value: string | number) => a.push(flag, String(value))
  const isSpec = g.workload.type === 'workload-spec'

  add('--model', d.model)
  add('--hardware', d.hardware)
  add('--tp', d.tp)
  // --dp is MoE-only upstream and rejects several combinations, so the default is
  // left off rather than asserted.
  if (d.dp > 1) add('--dp', d.dp)
  // The MoE knobs, emitted only when on. --enable-expert-parallel is a valueless bool flag.
  if (d.enable_expert_parallel) a.push('--enable-expert-parallel')
  if (d.moe_comm_backend) add('--moe-comm-backend', d.moe_comm_backend)
  add('--num-instances', d.num_instances)

  // Prefill/decode disaggregation, present only when a pool is set; each flag emitted only
  // at a non-default value. Mirrors internal/blisrun.Argv.
  const pd = d.disaggregation
  if (pd) {
    if (pd.prefill_instances > 0) add('--prefill-instances', pd.prefill_instances)
    if (pd.decode_instances > 0) add('--decode-instances', pd.decode_instances)
    if (pd.prefill_decode_instances > 0) add('--prefill-decode-instances', pd.prefill_decode_instances)
    if (pd.decider && pd.decider !== 'never') add('--pd-decider', pd.decider)
    if (pd.decider === 'prefix-threshold') add('--pd-prefix-threshold', pd.prefix_threshold)
    if (pd.transfer_bandwidth !== 25) add('--pd-transfer-bandwidth', numeric(pd.transfer_bandwidth))
    if (pd.transfer_base_latency !== 0.05) add('--pd-transfer-base-latency', numeric(pd.transfer_base_latency))
    if (pd.transfer_contention) a.push('--pd-transfer-contention')
  }

  // The workload surface: either the synthetic distribution flags, or a spec file that
  // supersedes them (upstream: --workload-spec overrides --workload, and the synthetic
  // --rate/--prompt-tokens/… flags are read only on the synthesize path).
  if (isSpec) {
    add('--workload-spec', specPath)
  } else {
    add('--workload', g.workload.type)
    add('--num-requests', g.workload.num_requests)
    // Exactly one of these: upstream rejects --rate together with --concurrency.
    if (g.workload.load.kind === 'concurrency') add('--concurrency', numeric(g.workload.load.value))
    else add('--rate', numeric(g.workload.load.value))
  }
  // Group-side knobs override the spec's own values, and decide whether the declared
  // work completes, so they are passed in both variants.
  add('--seed', g.seed)
  add('--timeout', g.request_timeout_s)
  if (g.horizon_ticks != null) add('--horizon', g.horizon_ticks)

  if (!isSpec) {
    add('--prompt-tokens', g.workload.prompt_tokens)
    add('--prompt-tokens-stdev', g.workload.prompt_tokens_stdev)
    add('--output-tokens', g.workload.output_tokens)
    add('--output-tokens-stdev', g.workload.output_tokens_stdev)
  }

  if (d.max_model_len > 0) add('--max-model-len', d.max_model_len)
  add('--block-size-in-tokens', d.block_size_in_tokens)
  add('--max-num-seqs', d.max_num_seqs)
  add('--max-num-batched-tokens', d.max_num_batched_tokens)
  add('--long-prefill-token-threshold', d.long_prefill_token_threshold)

  add('--scheduler', d.scheduler)
  add('--preemption-policy', d.preemption_policy)
  add('--routing-policy', d.routing_policy)
  // --routing-scorers is read only for the weighted policy (blis warns and ignores it
  // otherwise), so it is emitted only then and only with a profile — the same "emit when
  // the capability is on" rule as --dp and the speculative trio, keeping a non-weighted
  // record's argv byte-for-byte unchanged. Mirrors internal/blisrun.Argv.
  if (d.routing_policy === 'weighted' && d.routing_scorers && d.routing_scorers.length > 0) {
    add('--routing-scorers', d.routing_scorers.map((s) => `${s.name}:${numeric(s.weight)}`).join(','))
  }
  add('--admission-policy', d.admission_policy)
  add('--kv-cache-dtype', d.kv_cache_dtype)
  add('--latency-model', d.latency_model)

  add('--gpu-memory-utilization', numeric(d.gpu_memory_utilization))

  // The speculative trio follows the --dp precedent: emitted only when the capability is
  // on (K>0), so an off run reproduces from the record's stored defaults.
  if (d.num_speculative_tokens > 0) {
    add('--num-speculative-tokens', d.num_speculative_tokens)
    add('--speculative-acceptance-rate', numeric(d.speculative_acceptance_rate))
    if (d.speculative_method !== '') add('--speculative-method', d.speculative_method)
  }

  for (const flag of Object.keys(d.extra_flags ?? {}).sort()) {
    add(`--${flag}`, (d.extra_flags ?? {})[flag] ?? '')
  }

  add('--metrics-path', metricsPath)
  return a
}

/**
 * Runs a validated declaration through `leaderboard serve` and returns the record it
 * wrote. The server does the work a browser cannot — it owns the upstream checkout —
 * and files the result under results/<group_id>/<run_id>.json exactly as the CLI
 * would. A blis failure comes back as the {error} the endpoint sends; a server that
 * is not running comes back as a fetch rejection, which the caller renders as "start
 * the server" rather than a stack trace.
 */
export async function postRun(output: Output, fetchImpl: typeof fetch = fetch): Promise<RunRecord> {
  let res: Response
  try {
    res = await fetchImpl('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group: output.group,
        deployment: output.deployment,
        run_id: output.runId,
        workload_name: output.workloadName,
      }),
    })
  } catch {
    throw new Error(
      'Could not reach the run server. Start it with `make build && ./bin/leaderboard serve`, ' +
        'then try again — it runs blis from ../inference-sim.',
    )
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
        : `The run server returned HTTP ${res.status}.`
    throw new Error(message)
  }
  return parsed as RunRecord
}

/**
 * Saves a custom workload to the catalog, then runs it — the "custom (distribution)"
 * type is persisted for reuse on Run (auto-save). Nothing is saved for a chosen catalog
 * workload, or a custom one whose content already exists (output.saveProfile is null): the
 * run proceeds straight to postRun. A save failure rejects before the run, so a workload
 * that could not be saved (e.g. a name that raced another save) is never run — App bounces
 * back to Declare with the server's message, the same failure path a rejected run takes.
 * The impls are injectable so the sequencing is unit-tested without a server.
 */
export async function saveThenRun(
  output: Output,
  deps: { save?: typeof saveWorkload; post?: typeof postRun } = {},
): Promise<RunRecord> {
  const save = deps.save ?? saveWorkload
  const post = deps.post ?? postRun
  if (output.saveProfile) await save(output.saveProfile, null)
  return post(output)
}

/** Sorted-key JSON, so two objects describing the same thing compare equal. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
