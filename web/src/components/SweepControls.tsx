import type { ReactNode } from 'react'
import {
  ADMISSION_POLICIES,
  KV_CACHE_DTYPES,
  KV_OFFLOAD_EVICTION_POLICIES,
  MOE_COMM_BACKENDS,
  PD_DECIDERS,
  PREEMPTION_POLICIES,
  ROUTING_POLICIES,
  SCHEDULERS,
  SPECULATIVE_METHODS,
  TP_CHOICES,
} from '../catalog'
import type { FormValues } from '../newrun'
import {
  addAxisValue,
  axisValues,
  axisVaries,
  removeAxisValue,
  toggleAxisValue,
} from '../sweep'
import type { SweepableKey, SweepAxes } from '../sweep'

interface Props {
  /** The single-run form values. Each swept field's own value is this axis's non-removable
   *  base; the controls below add candidate values beside it. */
  base: FormValues
  /** The per-field chosen value sets (base value first). Absent or length-1 means fixed. */
  axes: SweepAxes
  /** The offered-load levels this sweep varies over, as strings. Managed directly here (there
   *  is no sweep.ts axis for load); add/remove rebuild the list through onLoadValuesChange. */
  loadValues: string[]
  /** Replaces the sweep axes after a toggle/add/remove through a sweep.ts helper. */
  onAxesChange: (axes: SweepAxes) => void
  /** Replaces the load-level list. */
  onLoadValuesChange: (values: string[]) => void
  /** The live accelerator names (from NewRun's catalog fetch). When present and non-empty,
   *  hardware renders as a multi-toggle over these names; otherwise it falls back to the
   *  free-text chip input, since there is no committed set to toggle over. */
  hardwareNames?: string[]
}

/** The three control shapes a swept field takes: a multi-toggle over a closed set (segmented
 *  in the single form), a chip multi-select over a closed set (a dropdown in the single form),
 *  and a chip input for a free number (or the live-catalog hardware name). */
type FieldSpec =
  | { key: SweepableKey; label: string; kind: 'toggle'; options: readonly (string | number)[] }
  | { key: SweepableKey; label: string; kind: 'select'; options: readonly string[] }
  | { key: SweepableKey; label: string; kind: 'number' }
  | { key: SweepableKey; label: string; kind: 'text' }

interface Group {
  title: string
  defaultOpen: boolean
  fields: FieldSpec[]
}

const OFF_ON = ['off', 'on'] as const

// The swept fields in the same grouping and order the single-run form uses (NewRun's
// flagGroup sections), so a reader finds each field where they left it. Model is excluded
// (it is a candidate dimension the sweep never varies); hardware is declared as a text field
// here but renders as a multi-toggle when NewRun passes the live catalog names, falling back
// to a free chip input otherwise (its choices come from the live catalog, not a committed set).
const GROUPS: Group[] = [
  {
    title: 'Model & sharding',
    defaultOpen: true,
    fields: [
      { key: 'hardware', label: 'Accelerator', kind: 'text' },
      { key: 'tp', label: 'Tensor parallel', kind: 'toggle', options: TP_CHOICES },
      { key: 'dp', label: 'Data parallel', kind: 'number' },
      { key: 'enableExpertParallel', label: 'Expert parallel', kind: 'toggle', options: OFF_ON },
      { key: 'moeCommBackend', label: 'MoE comm backend', kind: 'select', options: MOE_COMM_BACKENDS },
      { key: 'maxModelLen', label: 'Max model length', kind: 'number' },
    ],
  },
  {
    title: 'Scheduling & batching',
    defaultOpen: true,
    fields: [
      { key: 'scheduler', label: 'Scheduler', kind: 'select', options: SCHEDULERS },
      { key: 'preemptionPolicy', label: 'Preemption policy', kind: 'select', options: PREEMPTION_POLICIES },
      { key: 'maxNumSeqs', label: 'Max sequences', kind: 'number' },
      { key: 'maxNumBatchedTokens', label: 'Max batched tokens', kind: 'number' },
      { key: 'longPrefillTokenThreshold', label: 'Long-prefill token threshold', kind: 'number' },
    ],
  },
  {
    title: 'KV cache',
    defaultOpen: true,
    fields: [
      { key: 'kvCacheDtype', label: 'KV cache dtype', kind: 'select', options: KV_CACHE_DTYPES },
      { key: 'blockSize', label: 'KV block size (tokens)', kind: 'number' },
      { key: 'gpuMemoryUtilization', label: 'GPU memory utilization', kind: 'number' },
      { key: 'totalKvBlocks', label: 'Total KV blocks', kind: 'number' },
      { key: 'kvCpuOffload', label: 'CPU offloading', kind: 'toggle', options: OFF_ON },
      { key: 'cpuBytesToUse', label: 'CPU offload budget (bytes)', kind: 'number' },
      { key: 'offloadBlockSize', label: 'Offload block size (tokens)', kind: 'number' },
      { key: 'blocksPerChunk', label: 'Blocks per chunk', kind: 'number' },
      { key: 'tokensPerHash', label: 'Tokens per hash', kind: 'number' },
      { key: 'evictionPolicy', label: 'Eviction policy', kind: 'toggle', options: KV_OFFLOAD_EVICTION_POLICIES },
      { key: 'offloadPromptOnly', label: 'Offload prompt only', kind: 'toggle', options: OFF_ON },
      { key: 'selfDescribingKvEvents', label: 'Self-describing KV events', kind: 'toggle', options: OFF_ON },
    ],
  },
  {
    title: 'Cluster',
    defaultOpen: true,
    fields: [{ key: 'numInstances', label: 'Instances', kind: 'number' }],
  },
  {
    title: 'Prefill/decode split',
    defaultOpen: false,
    fields: [
      { key: 'prefillInstances', label: 'Prefill instances', kind: 'number' },
      { key: 'decodeInstances', label: 'Decode instances', kind: 'number' },
      { key: 'prefillDecodeInstances', label: 'Shared (prefill+decode) instances', kind: 'number' },
      { key: 'pdDecider', label: 'Decider', kind: 'toggle', options: PD_DECIDERS },
      { key: 'pdPrefixThreshold', label: 'Prefix threshold (tokens)', kind: 'number' },
      { key: 'pdTransferBandwidth', label: 'Transfer bandwidth (GB/s)', kind: 'number' },
      { key: 'pdTransferBaseLatency', label: 'Transfer base latency (ms)', kind: 'number' },
      { key: 'pdTransferContention', label: 'Transfer contention', kind: 'toggle', options: OFF_ON },
    ],
  },
  {
    title: 'Admission & routing',
    defaultOpen: false,
    fields: [
      { key: 'admissionPolicy', label: 'Admission policy', kind: 'select', options: ADMISSION_POLICIES },
      { key: 'routingPolicy', label: 'Routing policy', kind: 'toggle', options: ROUTING_POLICIES },
    ],
  },
  {
    title: 'Speculative decoding',
    defaultOpen: false,
    fields: [
      { key: 'numSpeculativeTokens', label: 'Draft tokens', kind: 'number' },
      { key: 'speculativeAcceptanceRate', label: 'Acceptance rate', kind: 'number' },
      { key: 'speculativeMethod', label: 'Method', kind: 'select', options: SPECULATIVE_METHODS },
    ],
  },
]

/** The small count badge shown beside a label (and on a folded group's summary) once a field
 *  carries more than one value. Exported so the preview and tests can reuse the exact text. */
export function variesBadge(n: number): ReactNode {
  return <span className="varies">varies ({n})</span>
}

/** A closed value shown in a chip or option, with the empty string rendered as (none). */
function display(value: string): string {
  return value === '' ? '(none)' : value
}

/** Split a typed or pasted string into candidate tokens (whitespace or comma separated). */
function tokens(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((t) => t !== '')
}

export function SweepControls({ base, axes, loadValues, onAxesChange, onLoadValuesChange, hardwareNames }: Props) {
  // Fold several typed/pasted tokens onto the axes in one update, so a paste of "1 2 4" adds
  // three values at once. Each step is a pure addAxisValue call; the base is left untouched.
  const addMany = (key: SweepableKey, raw: string) => {
    let next = axes
    for (const t of tokens(raw)) next = addAxisValue(next, key, t, base)
    if (next !== axes) onAxesChange(next)
  }

  // The removable-chip row shared by number, select and text axes. axisValues returns the base
  // value first and it can never be removed (removeAxisValue guards it), so chip 0 shows no x.
  const chips = (key: SweepableKey) => {
    const values = axisValues(key, base, axes)
    return values.map((v, i) => (
      <span className="chip" key={v}>
        {display(v)}
        {i > 0 && (
          <button
            type="button"
            aria-label={`Remove ${display(v)}`}
            onClick={() => onAxesChange(removeAxisValue(axes, key, v, base))}
          >
            ×
          </button>
        )}
      </span>
    ))
  }

  const labelWith = (key: SweepableKey, label: string) => (
    <span className="nrlabel">
      {label}
      {axisVaries(key, base, axes) && variesBadge(axisValues(key, base, axes).length)}
    </span>
  )

  // The segmented multi-toggle shared by closed-set toggle fields and (when names are
  // supplied) hardware: one lit/unlit pill per option, each toggled onto its axis.
  const renderToggle = (
    key: SweepableKey,
    label: string,
    options: readonly (string | number)[],
  ): ReactNode => {
    const selected = new Set(axisValues(key, base, axes))
    return (
      <div className="nrrow" key={key}>
        {labelWith(key, label)}
        <div className="tagrow" role="group" aria-label={label}>
          {options.map((opt) => {
            const value = String(opt)
            return (
              <button
                type="button"
                className="tag"
                key={value}
                aria-pressed={selected.has(value)}
                onClick={() => onAxesChange(toggleAxisValue(axes, key, value, base))}
              >
                {display(value)}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const renderField = (field: FieldSpec): ReactNode => {
    // Hardware's choices come from the live catalog, so it is a free-text chip input by
    // default; when NewRun passes the fetched names, render it as a multi-toggle over them.
    if (field.key === 'hardware' && hardwareNames && hardwareNames.length > 0) {
      return renderToggle(field.key, field.label, hardwareNames)
    }

    if (field.kind === 'toggle') {
      return renderToggle(field.key, field.label, field.options)
    }

    if (field.kind === 'select') {
      const chosen = axisValues(field.key, base, axes)
      const remaining = field.options.filter((o) => !chosen.includes(o))
      return (
        <div className="nrrow" key={field.key}>
          {labelWith(field.key, field.label)}
          <div className="chiprow">
            {chips(field.key)}
            <select
              className="chipinput"
              aria-label={`Add ${field.label}`}
              value=""
              onChange={(e) => {
                if (e.target.value !== '') onAxesChange(addAxisValue(axes, field.key, e.target.value, base))
              }}
            >
              <option value="">add a value</option>
              {remaining.map((o) => (
                <option value={o} key={o}>
                  {display(o)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )
    }

    // number and text axes: removable chips plus a free input (Enter or paste adds; split on
    // whitespace or commas). text is only hardware, whose choices are the live catalog.
    return (
      <div className="nrrow" key={field.key}>
        {labelWith(field.key, field.label)}
        <div className="chiprow">
          {chips(field.key)}
          <input
            className="chipinput"
            type="text"
            inputMode={field.kind === 'number' ? 'decimal' : 'text'}
            placeholder="add a value"
            aria-label={`Add ${field.label}`}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addMany(field.key, e.currentTarget.value)
                e.currentTarget.value = ''
              }
            }}
            onPaste={(e) => {
              e.preventDefault()
              addMany(field.key, e.clipboardData.getData('text'))
            }}
          />
        </div>
      </div>
    )
  }

  // Load levels: the same removable-chip pattern over loadValues, managed directly (no sweep.ts
  // axis). The first level is the base (the single run's own load) and is non-removable, like
  // the deployment-axis base chip; the rest are removable, and the sweep runs over whatever
  // levels remain.
  const addLoads = (raw: string) => {
    const next = [...loadValues]
    for (const t of tokens(raw)) if (!next.includes(t)) next.push(t)
    if (next.length !== loadValues.length) onLoadValuesChange(next)
  }

  return (
    <div className="sweepcontrols">
      <div className="nrrow">
        <span className="nrlabel">
          Load levels
          {loadValues.length > 1 && variesBadge(loadValues.length)}
        </span>
        <div className="chiprow">
          {loadValues.map((v, i) => (
            <span className="chip" key={v}>
              {v}
              {i > 0 && (
                <button
                  type="button"
                  aria-label={`Remove load ${v}`}
                  onClick={() => onLoadValuesChange(loadValues.filter((x) => x !== v))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <input
            className="chipinput"
            type="text"
            inputMode="decimal"
            placeholder="add a level"
            aria-label="Add a load level"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addLoads(e.currentTarget.value)
                e.currentTarget.value = ''
              }
            }}
            onPaste={(e) => {
              e.preventDefault()
              addLoads(e.clipboardData.getData('text'))
            }}
          />
        </div>
      </div>

      {GROUPS.map((group) => {
        const variedCount = group.fields.filter((f) => axisVaries(f.key, base, axes)).length
        return (
          <details className="nrflaggroup" open={group.defaultOpen} key={group.title}>
            <summary>
              {group.title}
              {variedCount > 0 && variesBadge(variedCount)}
            </summary>
            {group.fields.map(renderField)}
          </details>
        )
      })}
    </div>
  )
}
