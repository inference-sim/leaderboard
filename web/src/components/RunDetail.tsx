import type { RunRecord } from '../load'
import { offeredLoad } from '../load'
import { fieldDisplay, gpuCount } from '../model'
import { metricOptions, type MetricOption } from '../compareplot'
import { formatMs, formatNumber } from '../format'
import { ReproPanel } from './ReproPanel'

/** A metric value for the detail readout: durations in ms/s, percent columns with a %, else the
 *  fixed precision. Mirrors the plot's own formatter so a point and its detail agree. */
function fmtVal(v: number | null, opt: MetricOption): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (opt.unit === 'ms') return formatMs(v)
  const s = formatNumber(v, opt.digits ?? 0)
  return opt.unit === '%' ? `${s}%` : s
}

const GROUP_LABELS: Record<string, string> = {
  latency: 'Latency',
  throughput: 'Throughput',
  health: 'Health',
  kv: 'KV cache',
  candidate: 'Derived',
}

/** The deployment fields for one run, in declaration order, each rendered the way the table
 *  renders it (structured fields as their token list), plus the extra_flags entries. */
function configRows(record: RunRecord): { label: string; value: string }[] {
  const dep = record.deployment as unknown as Record<string, unknown>
  const rows: { label: string; value: string }[] = []
  for (const field of Object.keys(dep)) {
    if (field === 'extra_flags') continue
    const d = fieldDisplay(record, field)
    rows.push({ label: field, value: d.items ? d.items.join(', ') : d.value })
  }
  for (const [flag, val] of Object.entries(record.deployment.extra_flags ?? {})) {
    rows.push({ label: `--${flag}`, value: String(val) })
  }
  return rows
}

/**
 * The full picture of one run, opened by clicking its point: what was offered (the workload),
 * the deployment configuration, the performance BLIS measured, and the exact command that
 * produced it (verbatim from provenance, so it reproduces byte-for-byte). Closed by the ×, a
 * backdrop click, or Escape (handled by the caller).
 */
export function RunDetailModal({ record, onClose }: { record: RunRecord; onClose: () => void }) {
  const load = offeredLoad(record.group)
  const metrics = metricOptions()
  const groups: string[] = ['latency', 'throughput', 'health', 'kv', 'candidate']
  const complete = record.status.complete

  const work: { label: string; value: string }[] = [
    { label: 'workload', value: record.group.workload.type },
    { label: load.kind === 'rate' ? 'arrival rate' : 'concurrency', value: `${formatNumber(load.value, load.kind === 'rate' ? 1 : 0)} ${load.kind === 'rate' ? 'req/s' : 'sessions'}` },
    { label: 'requests', value: formatNumber(record.group.workload.num_requests, 0) },
    { label: 'seed', value: String(record.group.seed) },
  ]
  if (record.group.horizon_ticks != null) work.push({ label: 'horizon', value: `${formatNumber(record.group.horizon_ticks, 0)} ticks` })

  return (
    <div className="plot-modal-backdrop" onClick={onClose}>
      <div className="rundetail" role="dialog" aria-modal="true" aria-label={`Run ${record.run_id}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="plot-modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <header className="rundetail-head">
          <h3 className="mono">{record.run_id}</h3>
          <p>
            {record.deployment.model} · {record.deployment.hardware} · tp{record.deployment.tp} · {gpuCount(record)} GPU
            {!complete && <span className="rundetail-dq">⚠ subset — served {record.metrics.injected_requests ? Math.round((record.metrics.completed_requests / record.metrics.injected_requests) * 100) : 0}%</span>}
          </p>
        </header>

        <div className="rundetail-cols">
          <section className="rundetail-sec">
            <h4>Workload</h4>
            <dl className="rundetail-kv">
              {work.map((r) => (
                <div key={r.label} className="kvrow">
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
            <h4>Configuration</h4>
            <dl className="rundetail-kv">
              {configRows(record).map((r) => (
                <div key={r.label} className="kvrow">
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rundetail-sec">
            <h4>Performance</h4>
            {groups.map((g) => {
              const rows = metrics.filter((m) => m.group === g && m.value(record) != null)
              if (rows.length === 0) return null
              return (
                <div key={g} className="rundetail-metricgroup">
                  <div className="rundetail-grouplabel">{GROUP_LABELS[g] ?? g}</div>
                  <dl className="rundetail-kv">
                    {rows.map((m) => (
                      <div key={m.key} className="kvrow">
                        <dt>
                          {m.label}
                          {m.derived ? <span className="rundetail-star" title={m.derived}> ∗</span> : null}
                        </dt>
                        <dd>
                          {fmtVal(m.value(record), m)}
                          {m.unit && m.unit !== '%' ? <span className="rundetail-unit"> {m.unit}</span> : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )
            })}
          </section>
        </div>

        <ReproPanel record={record} />
      </div>
    </div>
  )
}
