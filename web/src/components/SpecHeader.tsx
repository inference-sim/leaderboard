import type { WorkloadGroup } from '../load'
import { formatCount, formatNumber } from '../format'
import { distTerms, getPath, getStr, serializeSpec, singleClient, type SpecObject } from '../spec'
import { Derived } from './Derived'
import { CopyBlock } from './CopyBlock'

const HORIZON_NOTE =
  'blis --horizon: simulated time is measured in ticks, and the run stops observing once ' +
  'it reaches this many. "unbounded" runs until every request has been injected and had ' +
  'its chance to finish. A too-short window cuts a run off early, which disqualifies it.'

/**
 * The work every row in a workload section was offered (W1). It sits above the table
 * because changing any field here makes a different workload rather than another row.
 * This card describes the work alone; the models run against it are not listed here —
 * they are the candidates, carried by each row's Model column and the section's filter.
 *
 * The title is the catalog name when the runs carry one (else the shape); the variant and
 * "preset" tags are not repeated here, since the workload picker card above already carries
 * them. Both variants get a full field grid: a distribution's fields are authoritative; a
 * workload-spec's are read from its single client where it has one, with the full spec
 * always one click away for anything richer (multi-client, cohorts, non-gaussian).
 */
export function WorkloadHeader({ workload }: { workload: WorkloadGroup }) {
  const g = workload.groups[0]!.group // one comparability group per workload now (E1)
  const isSpec = g.workload.type === 'workload-spec'

  return (
    <header className="spec">
      <h2>{workload.title}</h2>

      {isSpec ? <SpecFields workload={workload} /> : <DistributionFields workload={workload} />}
    </header>
  )
}

/** The flat field grid for a distribution workload — every field is authoritative. The
 * variant is the title-row tag now, so the grid leads with the arrival process (which the
 * tag cannot carry) rather than repeating the type. */
function DistributionFields({ workload }: { workload: WorkloadGroup }) {
  const g = workload.groups[0]!.group
  const w = g.workload
  const loadLabel = w.load.kind === 'rate' ? 'Offered rate' : 'Concurrency'
  const loadUnit = w.load.kind === 'rate' ? 'req/s' : 'users'
  return (
    <dl className="spec-grid">
      <div>
        <dt>Arrival</dt>
        <dd>
          <Derived formula="arrival process is not reported by blis: SynthesizeFromDistribution sets ArrivalSpec{Process: 'constant'} for rate mode (sim/workload/synthesis.go:33)">
            {w.arrival_process}
          </Derived>
        </dd>
      </div>
      <div>
        <dt>Requests</dt>
        <dd>{formatCount(w.num_requests)}</dd>
      </div>
      <div>
        <dt>{loadLabel}</dt>
        <dd>
          {formatNumber(w.load.value, 1)} <small>{loadUnit}</small>
        </dd>
      </div>
      <div>
        <dt>Prompt tokens</dt>
        <dd>
          {formatCount(w.prompt_tokens)} <small>±{formatCount(w.prompt_tokens_stdev)}</small>
        </dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd>
          {formatCount(w.output_tokens)} <small>±{formatCount(w.output_tokens_stdev)}</small>
        </dd>
      </div>
      <GroupKnobs workload={workload} />
    </dl>
  )
}

/**
 * A workload-spec's readout, brought to parity with the distribution grid where the spec
 * has a single client: arrival, request count, aggregate rate, and the input/output token
 * distributions. A multi-client or cohort spec shows what it can (the client count and the
 * top-level load) and leaves the per-client shape to the full spec, one click away.
 */
function SpecFields({ workload }: { workload: WorkloadGroup }) {
  const g = workload.groups[0]!.group
  const spec = (g.workload.spec ?? null) as SpecObject | null
  const specText = spec ? serializeSpec(spec) : ''
  const requests = spec ? getPath(spec, ['num_requests']) : undefined
  const rate = spec ? getPath(spec, ['aggregate_rate']) : undefined
  const clients = spec ? getPath(spec, ['clients']) : undefined
  const client = singleClient(spec)
  const arrival = client ? getStr(client, ['arrival', 'process']) : ''
  const input = client ? distTerms(getPath(client, ['input_distribution']) as SpecObject | null) : null
  const output = client ? distTerms(getPath(client, ['output_distribution']) as SpecObject | null) : null
  return (
    <>
      <dl className="spec-grid">
        {arrival && (
          <div>
            <dt>Arrival</dt>
            <dd>{arrival}</dd>
          </div>
        )}
        {!client && Array.isArray(clients) && (
          <div>
            <dt>Clients</dt>
            <dd>{clients.length}</dd>
          </div>
        )}
        {typeof requests === 'number' && (
          <div>
            <dt>Requests</dt>
            <dd>{formatCount(requests)}</dd>
          </div>
        )}
        {typeof rate === 'number' && (
          <div>
            <dt>Offered rate</dt>
            <dd>
              {formatNumber(rate, 1)} <small>req/s</small>
            </dd>
          </div>
        )}
        {input && (
          <div>
            <dt>Prompt tokens</dt>
            <dd>
              {input.text} {input.detail && <small>{input.detail}</small>}
            </dd>
          </div>
        )}
        {output && (
          <div>
            <dt>Output tokens</dt>
            <dd>
              {output.text} {output.detail && <small>{output.detail}</small>}
            </dd>
          </div>
        )}
        <GroupKnobs workload={workload} />
      </dl>
      {specText && (
        <details className="spec-details">
          <summary>Full workload spec</summary>
          <CopyBlock
            label="WorkloadSpec"
            hint="The complete blis WorkloadSpec this workload runs. The model is injected at run time and is not part of it."
            text={specText}
          />
        </details>
      )}
    </>
  )
}

/** Seed, request deadline, and observation window: group-side knobs that apply to both
 * variants, so both readouts share them and cannot drift. */
function GroupKnobs({ workload }: { workload: WorkloadGroup }) {
  const g = workload.groups[0]!.group
  return (
    <>
      <div>
        <dt>Seed</dt>
        <dd>{g.seed}</dd>
      </div>
      <div>
        <dt>Request deadline</dt>
        <dd>{g.request_timeout_s < 0 ? 'disabled' : `${formatCount(g.request_timeout_s)}s`}</dd>
      </div>
      <div>
        <dt>
          Observation window
          <span
            className="info"
            tabIndex={0}
            role="note"
            data-tip={HORIZON_NOTE}
            aria-label={HORIZON_NOTE}
          >
            i
          </span>
        </dt>
        <dd>
          {g.horizon_ticks == null ? (
            'unbounded'
          ) : (
            <>
              {formatCount(g.horizon_ticks)} <small>ticks</small>
            </>
          )}
        </dd>
      </div>
    </>
  )
}
