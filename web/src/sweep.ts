import type { Output, Issue } from './newrun'
import { interpret } from './newrun'
import type { FormValues } from './newrun'
import type { RunGroup } from './load'
import { workloadKey, configKey, offeredLoad } from './load'
import type { ProfileBody } from './workloads'
import type { ModelInfo } from './models'
import type { HardwareInfo } from './hardware'
import type { RunRecord } from './load'

/** Deployment-side (plus load-level) fields that a sweep can vary. Everything but the model,
 *  and not the group-side singles (seed, timeout, loadKind, workload selection). The order is
 *  the fixed field order used by both the cartesian product and the run-id suffix. */
export const SWEEPABLE_KEYS = [
  'hardware', 'tp', 'dp', 'enableExpertParallel', 'moeCommBackend', 'numInstances',
  'maxModelLen', 'scheduler', 'preemptionPolicy', 'maxNumSeqs', 'maxNumBatchedTokens',
  'longPrefillTokenThreshold', 'kvCacheDtype', 'blockSize', 'gpuMemoryUtilization',
  'totalKvBlocks', 'kvCpuOffload', 'cpuBytesToUse', 'offloadBlockSize', 'blocksPerChunk',
  'tokensPerHash', 'evictionPolicy', 'offloadPromptOnly', 'selfDescribingKvEvents',
  'prefillInstances', 'decodeInstances', 'prefillDecodeInstances', 'pdDecider',
  'pdPrefixThreshold', 'pdTransferBandwidth', 'pdTransferBaseLatency', 'pdTransferContention',
  'admissionPolicy', 'numSpeculativeTokens', 'speculativeAcceptanceRate',
  'speculativeMethod',
] as const

export type SweepableKey = (typeof SWEEPABLE_KEYS)[number]

/** The only boolean FormValues keys in the sweepable set; their axis values are 'off'/'on'. */
export const BOOL_AXES: readonly SweepableKey[] = ['enableExpertParallel', 'pdTransferContention']

/** The additional selected values per swept field, base value first. Absent or length-1 = fixed. */
export type SweepAxes = Partial<Record<SweepableKey, string[]>>

/** The base's current value for a key, as the string the axis stores. */
function baseValue(key: SweepableKey, base: FormValues): string {
  if (BOOL_AXES.includes(key)) return (base[key] as unknown as boolean) ? 'on' : 'off'
  return String(base[key as keyof FormValues])
}

/** The selected values for a key: the stored axis, or the single base value when fixed. */
export function axisValues(key: SweepableKey, base: FormValues, axes: SweepAxes): string[] {
  return axes[key] ?? [baseValue(key, base)]
}

/** Collapse an axis to fixed (drop the key) when it holds only the base value. */
function normalize(axes: SweepAxes, key: SweepableKey, base: FormValues): SweepAxes {
  const next = { ...axes }
  const list = next[key]
  if (!list || (list.length === 1 && list[0] === baseValue(key, base))) delete next[key]
  else next[key] = list
  return next
}

export function addAxisValue(axes: SweepAxes, key: SweepableKey, value: string, base: FormValues): SweepAxes {
  const current = axisValues(key, base, axes)
  if (value === '' || current.includes(value)) return axes
  return normalize({ ...axes, [key]: [...current, value] }, key, base)
}

export function removeAxisValue(axes: SweepAxes, key: SweepableKey, value: string, base: FormValues): SweepAxes {
  const next = axisValues(key, base, axes).filter((v) => v !== value)
  return normalize({ ...axes, [key]: next }, key, base)
}

export function toggleAxisValue(axes: SweepAxes, key: SweepableKey, value: string, base: FormValues): SweepAxes {
  return axisValues(key, base, axes).includes(value)
    ? removeAxisValue(axes, key, value, base)
    : addAxisValue(axes, key, value, base)
}

export function axisVaries(key: SweepableKey, base: FormValues, axes: SweepAxes): boolean {
  return axisValues(key, base, axes).length > 1
}

/** Overlay a single pick-combo onto the base FormValues, coercing the boolean axes. */
export function applyPicks(base: FormValues, picks: Partial<Record<SweepableKey, string>>): FormValues {
  const out: FormValues = { ...base }
  for (const key of SWEEPABLE_KEYS) {
    const v = picks[key]
    if (v === undefined) continue
    if (BOOL_AXES.includes(key)) (out[key] as unknown as boolean) = v === 'on'
    else (out[key as keyof FormValues] as unknown as string) = v
  }
  return out
}

/** Whether any deployment axis or the load axis holds more than one value. */
export function sweepHasVariation(base: FormValues, axes: SweepAxes, loadValues: string[]): boolean {
  if (loadValues.length > 1) return true
  return SWEEPABLE_KEYS.some((k) => axisVaries(k, base, axes))
}

export function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s === '' ? 'none' : s
}

/** Short token prefix per axis; '' means the value stands alone (hardware). */
export const AXIS_ABBR: Record<SweepableKey, string> = {
  hardware: '', tp: 'tp', dp: 'dp', enableExpertParallel: 'ep', moeCommBackend: 'moe',
  numInstances: 'inst', maxModelLen: 'mml', scheduler: 'sched', preemptionPolicy: 'preempt',
  maxNumSeqs: 'seqs', maxNumBatchedTokens: 'batch', longPrefillTokenThreshold: 'lpt',
  kvCacheDtype: 'kvdt', blockSize: 'blk', gpuMemoryUtilization: 'gmu', totalKvBlocks: 'kvblk',
  kvCpuOffload: 'kvoff', cpuBytesToUse: 'cpub', offloadBlockSize: 'oblk', blocksPerChunk: 'bpc',
  tokensPerHash: 'tph', evictionPolicy: 'evict', offloadPromptOnly: 'opo',
  selfDescribingKvEvents: 'sdke', prefillInstances: 'pfi', decodeInstances: 'dei',
  prefillDecodeInstances: 'pdi', pdDecider: 'dec', pdPrefixThreshold: 'ppt',
  pdTransferBandwidth: 'tbw', pdTransferBaseLatency: 'tbl', pdTransferContention: 'tc',
  admissionPolicy: 'adm', numSpeculativeTokens: 'spec',
  speculativeAcceptanceRate: 'sar', speculativeMethod: 'specm',
}

export function cellToken(key: SweepableKey, value: string): string {
  return AXIS_ABBR[key] + slug(value)
}

export function sweepPrefix(base: FormValues, variedKeys: SweepableKey[]): string {
  return variedKeys.includes('hardware') ? 'sweep' : slug(base.hardware)
}

export interface SweepCell { output: Output; configKey: string }
export interface DroppedCombo { label: string; issues: Issue[] }
export interface SweepExpansion {
  runs: SweepCell[]
  dropped: DroppedCombo[]
  configCount: number
  loadCount: number
  variedDeploymentKeys: SweepableKey[]
  loadValues: number[]
  joins: RunGroup | null
  workloadKey: string | null
}

export function sweepTarget(key: string, groups: RunGroup[]): RunGroup | null {
  return groups.find((g) => workloadKey(g.group) === key) ?? null
}

/** Cartesian product over the per-key value lists, in SWEEPABLE_KEYS order. */
function configCombos(base: FormValues, axes: SweepAxes): Array<Partial<Record<SweepableKey, string>>> {
  let combos: Array<Partial<Record<SweepableKey, string>>> = [{}]
  for (const key of SWEEPABLE_KEYS) {
    const values = axisValues(key, base, axes)
    const next: Array<Partial<Record<SweepableKey, string>>> = []
    for (const combo of combos) for (const v of values) next.push({ ...combo, [key]: v })
    combos = next
  }
  return combos
}

function uniqueId(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) { taken.add(wanted); return wanted }
  for (let n = 2; ; n++) {
    const candidate = `${wanted}-${n}`
    if (!taken.has(candidate)) { taken.add(candidate); return candidate }
  }
}

function comboLabel(combo: Partial<Record<SweepableKey, string>>, varied: SweepableKey[], load: number): string {
  const parts = varied.map((k) => `${k}=${combo[k]}`)
  return `${parts.join(', ') || 'base config'} @ load ${load}`
}

export function expandSweep(
  base: FormValues, axes: SweepAxes, loadValues: string[],
  groups: RunGroup[], profiles: ProfileBody[], models: ModelInfo[], hardware: HardwareInfo[],
): SweepExpansion {
  const varied = SWEEPABLE_KEYS.filter((k) => axisVaries(k, base, axes))
  const loads = loadValues.map((s) => Number(s)).filter((n) => Number.isFinite(n))
  const loadList = [...new Set(loads)].sort((a, b) => a - b)
  const combos = configCombos(base, axes)
  const prefix = sweepPrefix(base, varied)

  // Seed dedup from every stored row in this board table (all load levels share workloadKey).
  // We do not yet know the sweep's workloadKey, so seed lazily after the first valid cell.
  const taken = new Set<string>()
  const idForConfig = new Map<string, string>()
  let seededKey: string | null = null

  const runs: SweepCell[] = []
  const dropped: DroppedCombo[] = []

  for (const combo of combos) {
    // One run id per config (deployment), assigned on first sight and reused across loads.
    for (const load of loadList) {
      const values = applyPicks(base, combo)
      values.loadValue = String(load)
      const interp = interpret(values, groups, profiles, models, hardware)
      if (interp.output === null) {
        dropped.push({ label: comboLabel(combo, varied, load), issues: interp.issues })
        continue
      }
      const cfgKey = configKey(interp.output.deployment)
      if (seededKey === null) {
        seededKey = workloadKey(interp.output.group)
        for (const g of groups) if (workloadKey(g.group) === seededKey) for (const r of g.records) taken.add(r.run_id)
      }
      let id = idForConfig.get(cfgKey)
      if (id === undefined) {
        const suffix = varied.map((k) => cellToken(k, combo[k]!)).join('-')
        id = uniqueId(suffix ? `${prefix}-${suffix}` : prefix, taken)
        idForConfig.set(cfgKey, id)
      }
      const output: Output = { ...interp.output, runId: id }
      runs.push({ output, configKey: cfgKey })
    }
  }

  const workloadKeyOut = seededKey
  return {
    runs, dropped,
    configCount: idForConfig.size,
    loadCount: loadList.length,
    variedDeploymentKeys: varied,
    loadValues: loadList,
    joins: workloadKeyOut ? sweepTarget(workloadKeyOut, groups) : null,
    workloadKey: workloadKeyOut,
  }
}

export interface ConfigGroup { configKey: string; runId: string; cells: SweepCell[] }

/** Group runnable cells by configuration, first-seen order, load levels adjacent. Mirrors
 *  load.ts byConfig so the preview and progress match the board. */
export function groupByConfig(runs: SweepCell[]): ConfigGroup[] {
  const order: string[] = []
  const map = new Map<string, SweepCell[]>()
  for (const c of runs) {
    const g = map.get(c.configKey)
    if (g) g.push(c)
    else { map.set(c.configKey, [c]); order.push(c.configKey) }
  }
  return order.map((k) => {
    const cells = map.get(k)!
    return { configKey: k, runId: cells[0]!.output.runId, cells }
  })
}

export type Guard = 'ok' | 'warn' | 'block'
export const WARN_AT = 32
export const BLOCK_AT = 100
export function guardFor(runCount: number): Guard {
  if (runCount > BLOCK_AT) return 'block'
  if (runCount > WARN_AT) return 'warn'
  return 'ok'
}

export type CellStatus = 'queued' | 'running' | 'done' | 'disqualified' | 'failed'
export interface SweepRunCell {
  runId: string
  configKey: string
  output: Output
  status: CellStatus
  record: RunRecord | null
  message: string | null
}
export interface SweepRun { cells: SweepRunCell[]; stopped: boolean }

export function initSweepRun(runs: SweepCell[]): SweepRun {
  return {
    stopped: false,
    cells: runs.map((c) => ({
      runId: c.output.runId, configKey: c.configKey, output: c.output,
      status: 'queued' as CellStatus, record: null, message: null,
    })),
  }
}

export function classifyRecord(record: RunRecord): 'done' | 'disqualified' {
  return record.status.complete ? 'done' : 'disqualified'
}

export function countsOf(run: SweepRun) {
  const c = { done: 0, disqualified: 0, failed: 0, running: 0, queued: 0, total: run.cells.length }
  for (const cell of run.cells) c[cell.status] += 1
  return c
}

// --- Sweeps as entities: minting an id, and grouping records into sweeps for the By-sweep
// list. A sweep is identified by a top-level sweep_id on each of its records (provenance,
// never part of the comparability key); these helpers mint that id and read it back. ---

/** A short, time-ordered sweep id: `swp-` + base36(now) + a short random suffix. The time
 *  component is lexicographically and numerically sortable, so the By-sweep list can order
 *  newest-first and show a date without a separate timestamp field; the id is otherwise an
 *  opaque grouping key. `now` and `rand` are injectable so the format and uniqueness are
 *  unit-testable. Minted once per "Run sweep" click (a preview that is never run mints none). */
export function mintSweepId(now: number = Date.now(), rand: () => string = randomSuffix): string {
  return `swp-${now.toString(36)}-${rand()}`
}

/** Six base36 characters of randomness, so two sweeps minted in the same millisecond still
 *  differ. Padded so the suffix is always present even on an unlucky short draw. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/** The Date encoded in a sweep id's time component, or null when the id is not one this app
 *  minted (a hand-written value, or a future format). Only the list's sort and date read it;
 *  grouping treats the whole id as opaque. */
export function sweepDate(sweepId: string): Date | null {
  const m = /^swp-([0-9a-z]+)-/.exec(sweepId)
  if (!m) return null
  const ms = parseInt(m[1]!, 36)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null
}

/** One sweep as the By-sweep list shows it: its id, the user's label (or null), the derived
 *  one-line summary shown when unnamed, the workload it targeted, its date and run count, and
 *  its records (the subset the scoped view renders). */
export interface SweepEntry {
  sweepId: string
  label: string | null
  /** What the list shows as the heading: the label when present, else the derived summary. */
  title: string
  /** The workload the sweep targeted, as a short label: its catalog name, else its shape. */
  workload: string
  date: Date | null
  runCount: number
  records: RunRecord[]
}

/** Short, human labels for the deployment fields a sweep commonly varies. A field not listed
 *  falls back to its raw key, so a newly added axis still appears rather than vanishing. */
const DEPLOYMENT_AXIS_LABEL: Record<string, string> = {
  tp: 'tp',
  dp: 'dp',
  num_instances: 'instances',
  enable_expert_parallel: 'expert-parallel',
  moe_comm_backend: 'moe-backend',
  scheduler: 'scheduler',
  preemption_policy: 'preemption',
  max_num_seqs: 'max-seqs',
  max_num_batched_tokens: 'max-batch',
  long_prefill_token_threshold: 'long-prefill',
  kv_cache_dtype: 'kv-dtype',
  block_size_in_tokens: 'block-size',
  gpu_memory_utilization: 'gpu-mem',
  total_kv_blocks: 'kv-blocks',
  max_model_len: 'max-len',
  admission_policy: 'admission',
  routing_policy: 'routing',
  latency_model: 'latency-model',
  num_speculative_tokens: 'draft-tokens',
}

/** Renders a scalar deployment value for the summary. Objects/arrays are not expected here
 *  (callers only render scalar-varying axes) but are stringified defensively. */
function renderAxisValue(v: unknown): string {
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (v === '') return 'none'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** The deployment fields that differ across a sweep's runs, each as "label a/b/c" (model and
 *  hardware render their values alone, since they are the headline of a comparison). A field
 *  whose varying values are non-scalar (a disaggregation block, say) is named without values. */
function variedDeploymentAxes(records: RunRecord[]): string[] {
  const deps = records.map((r) => r.deployment as unknown as Record<string, unknown>)
  const keys = new Set<string>()
  for (const d of deps) for (const k of Object.keys(d)) keys.add(k)
  const out: string[] = []
  for (const k of keys) {
    if (k === 'extra_flags') continue
    const encoded = deps.map((d) => JSON.stringify(d[k] ?? null))
    const distinct = [...new Set(encoded)]
    if (distinct.length <= 1) continue
    const scalar = distinct.every((e) => {
      const p = JSON.parse(e)
      return p === null || typeof p !== 'object'
    })
    if (!scalar) {
      out.push(DEPLOYMENT_AXIS_LABEL[k] ?? k)
      continue
    }
    const values = [...new Set(deps.map((d) => renderAxisValue(d[k])))]
    // model and hardware are the headline of a candidate comparison, so their values stand
    // alone; every other field is prefixed with its short label so the axis is unambiguous.
    if (k === 'model' || k === 'hardware') out.push(values.join('/'))
    else out.push(`${DEPLOYMENT_AXIS_LABEL[k] ?? k} ${values.join('/')}`)
  }
  return out
}

/** The request count a sweep's workload offered, or null when it declares no single scalar
 *  (a trace or a cohort-driven spec). Read from the spec's own num_requests (the flat field is
 *  a placeholder zero for a spec), matching load.ts. */
function sweepRequestCount(group: RunRecord['group']): number | null {
  const w = group.workload as { type: string; num_requests?: number; spec?: { num_requests?: unknown } }
  if (w.type === 'workload-spec' && w.spec && typeof w.spec.num_requests === 'number') {
    return w.spec.num_requests
  }
  return typeof w.num_requests === 'number' && w.num_requests > 0 ? w.num_requests : null
}

/** The sweep's offered-load levels as "kind a/b/c", or '' when it varies no load. */
function sweepLoadLevels(records: RunRecord[]): string {
  const loads = records.map((r) => offeredLoad(r.group))
  const kind = loads[0]?.kind ?? 'rate'
  const values = [...new Set(loads.map((l) => l.value))].filter((v) => v > 0).sort((a, b) => a - b)
  if (values.length <= 1) return ''
  const unit = kind === 'rate' ? ' req/s' : kind === 'concurrency' || kind === 'sessions' ? ' concurrent' : ''
  return `load ${values.join('/')}${unit}`
}

/** The workload a sweep targeted, as a short label for the list: its catalog name when any run
 *  carries one, else its request-count shape, else the workload type. */
function sweepWorkloadLabel(records: RunRecord[]): string {
  for (const r of records) if (r.workload_name) return r.workload_name
  const first = records[0]!
  const n = sweepRequestCount(first.group)
  if (n != null) return `${n.toLocaleString('en-US')} requests`
  return first.group.workload.type === 'trace' ? 'trace replay' : 'workload'
}

/** The one-line summary shown for an unnamed sweep: the varied axes, the load levels, and the
 *  workload shape, joined by a middle dot. It is the fallback for the By-sweep list's heading
 *  when the reader gave the sweep no name, so two sweeps over the same workload still read apart. */
export function deriveSweepSummary(records: RunRecord[]): string {
  const axes = variedDeploymentAxes(records)
  const loads = sweepLoadLevels(records)
  const parts = [...axes]
  if (loads) parts.push(loads)
  const varied = parts.join(', ')
  const workload = sweepWorkloadLabel(records)
  return varied ? `${varied} · ${workload}` : workload
}

/** The same one-line summary, derived from a sweep's preview cells before any run exists, so
 *  the Sweep-name field can show the name an unnamed sweep would take as its placeholder. The
 *  cells carry the group/deployment/workloadName the summary reads, so each is adapted to the
 *  minimal record shape and run through deriveSweepSummary — one source of truth for the text.
 *  Returns '' when there are fewer than two cells (nothing varies, so there is no summary). */
export function deriveSweepSummaryFromCells(cells: SweepCell[]): string {
  if (cells.length < 2) return ''
  const asRecords = cells.map(
    (c) =>
      ({
        group: c.output.group,
        deployment: c.output.deployment,
        workload_name: c.output.workloadName,
      }) as unknown as RunRecord,
  )
  return deriveSweepSummary(asRecords)
}

/** Buckets records into sweeps by their top-level sweep_id (records without one are skipped —
 *  they stay under By workload only), newest-first by the id's time component. Each entry
 *  carries the label when any run has one, else a derived summary. Pure, so the By-sweep list
 *  and its tests read the same grouping. */
export function groupSweeps(records: RunRecord[]): SweepEntry[] {
  const byId = new Map<string, RunRecord[]>()
  for (const r of records) {
    if (!r.sweep_id) continue
    const bucket = byId.get(r.sweep_id)
    if (bucket) bucket.push(r)
    else byId.set(r.sweep_id, [r])
  }
  const entries: SweepEntry[] = []
  for (const [sweepId, recs] of byId) {
    const label = recs.find((r) => r.sweep_label)?.sweep_label ?? null
    entries.push({
      sweepId,
      label,
      title: label ?? deriveSweepSummary(recs),
      workload: sweepWorkloadLabel(recs),
      date: sweepDate(sweepId),
      runCount: recs.length,
      records: recs,
    })
  }
  // Newest sweep first: by the id's embedded time, with a stable id tiebreak so an id with no
  // parseable time (a hand-written value) sorts deterministically rather than jumping around.
  entries.sort((a, b) => {
    const at = a.date?.getTime() ?? 0
    const bt = b.date?.getTime() ?? 0
    return bt - at || (a.sweepId < b.sweepId ? 1 : a.sweepId > b.sweepId ? -1 : 0)
  })
  return entries
}

/** Run cells through a bounded worker pool. The run function is injected (tests stub it; the
 *  app passes a postRun wrapper). A rejected run marks that cell failed and never aborts the
 *  pool. shouldStop halts firing new cells; in-flight cells finish. */
export async function runPool(
  cells: SweepRunCell[],
  runOne: (cell: SweepRunCell) => Promise<RunRecord>,
  opts: { concurrency?: number; onUpdate: (index: number, patch: Partial<SweepRunCell>) => void; shouldStop: () => boolean },
): Promise<void> {
  const concurrency = opts.concurrency ?? 4
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      if (opts.shouldStop()) return
      const index = next++
      if (index >= cells.length) return
      opts.onUpdate(index, { status: 'running' })
      try {
        const record = await runOne(cells[index]!)
        opts.onUpdate(index, { status: classifyRecord(record), record })
      } catch (e) {
        opts.onUpdate(index, { status: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, () => worker()))
}
