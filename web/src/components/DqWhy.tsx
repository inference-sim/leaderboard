import type { RunRecord } from '../load'
import { formatCount, formatMs, formatNumber } from '../format'
import { Derived } from './Derived'

/** Mean output tokens per served request, or null when nothing completed. */
function outputPerRequest(r: RunRecord): number | null {
  const done = r.metrics.completed_requests
  return done > 0 ? r.metrics.total_output_tokens / done : null
}

/**
 * The "why" for one disqualified run, shown inside its expanded row above the blis command.
 * A disqualified run is shown, never hidden (CLAUDE.md); this is where the reader learns why
 * its numbers describe a different job from the one that was declared — the reason codes and
 * their detail, the served fraction, and the size-bias tell (the served subset is easier, not
 * merely smaller). It makes no ranking claim: disqualified rows are never ranked beside the
 * complete rows, so there is no "would-be rank" to state.
 */
export function DqWhy({
  record,
  completePerReqMean = null,
}: {
  record: RunRecord
  /** Mean output tokens per served request across the group's complete runs, for the size-bias
   *  comparison; null when the table holds no complete run to compare against. */
  completePerReqMean?: number | null
}) {
  const m = record.metrics
  const reasons = record.status.disqualifications
  const perReq = outputPerRequest(record)
  return (
    <div className="dqwhybox">
      <div className="dqtop">
        {reasons.map((r) => (
          <span key={r.code} className={`chip ${r.class === 'altered' ? 'alt' : 'crit'}`}>
            {r.code}
            <small> · {r.class}</small>
          </span>
        ))}
      </div>
      <p className="dqwhy">{reasons.map((r) => r.detail).join(' · ')}.</p>
      <dl className="dqnums">
        <div>
          <dt>served</dt>
          <dd>
            <Derived
              formula={`completed_requests ÷ injected_requests = ${m.completed_requests} ÷ ${m.injected_requests}`}
            >
              {formatCount(m.completed_requests)} / {formatCount(m.injected_requests)}
            </Derived>
          </dd>
        </div>
        <div className="tell">
          <dt>output tokens per served request</dt>
          <dd>
            <Derived formula="total_output_tokens ÷ completed_requests. Dropping and shedding are size-biased: the requests that did not fit are the ones removed, so the served subset is systematically easier, not merely smaller.">
              {perReq == null ? '—' : formatNumber(perReq, 1)}
            </Derived>
            {perReq != null && completePerReqMean != null && (
              <small> vs {formatNumber(completePerReqMean, 1)} across the complete runs</small>
            )}
          </dd>
        </div>
        <div>
          <dt>tokens/s</dt>
          <dd>{formatNumber(m.tokens_per_sec, 1)}</dd>
        </div>
        <div>
          <dt>TTFT p99</dt>
          <dd>{formatMs(m.ttft_p99_ms)}</dd>
        </div>
        {(m.still_running > 0 || m.still_queued > 0) && (
          <div>
            <dt>unfinished at the window</dt>
            <dd>
              {formatCount(m.still_running)} running, {formatCount(m.still_queued)} queued
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}
