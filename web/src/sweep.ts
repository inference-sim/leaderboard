import type { Output, Issue } from './newrun'
import { interpret } from './newrun'
import type { FormValues } from './newrun'
import type { RunGroup } from './load'
import { workloadKey, configKey } from './load'
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
