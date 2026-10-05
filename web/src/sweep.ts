import type { FormValues } from './newrun'

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
  'admissionPolicy', 'routingPolicy', 'numSpeculativeTokens', 'speculativeAcceptanceRate',
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
  const bv = baseValue(key, base)
  if (value === bv) return axes // the base value is always present; cannot remove it
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
