import { useState } from 'react'
import type { RunGroup, RunRecord } from '../load'
import { formatCount, formatMs, formatNumber } from '../format'
import { rowId } from '../liverun'
import { distinctModels, dqSummary } from '../model'
import { Derived } from './Derived'
import { ReproPanel } from './ReproPanel'

/**
 * The reproduce disclosure for a disqualified card: a labelled toggle and, when open,
 * the run's exact blis command below it. A disqualified run is often the one a reader
 * most wants to re-run — to see the shedding for themselves — so it gets the same
 * command the ranked rows do. The card carries prose the reader may want to select, so
 * unlike a table row this is an explicit control, not a click anywhere on the card.
 */
function DqRepro({ record }: { record: RunRecord }) {
  const [open, setOpen] = useState(false)
  const panelId = `repro-${record.group_id}-${record.run_id}`
  return (
    <div className="dqrepro">
      <button
        type="button"
        className="reprotoggle dq"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? 'Hide' : 'Show'} the blis command for ${record.run_id}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Reproduce this run
      </button>
      {open && (
        <div id={panelId}>
          <ReproPanel record={record} />
        </div>
      )}
    </div>
  )
}

/**
 * Disqualified runs, shown rather than filtered. Each was offered the same workload but
 * did not complete it, so its percentiles describe a smaller, easier job and cannot be
 * ranked beside a complete run. The would-be rank is kept and scoped to the offered work,
 * not the model (§5.1): every run in the table shares the workload, so "would place #N of
 * M on E2E p99" is a claim about the work the run shed, which the whole table shares — it
 * is not a per-model claim. Model is labelled per card when the table spans more than one.
 */
export function DqBand({ group }: { group: RunGroup }) {
  const entries = dqSummary(group)
  if (entries.length === 0) return null

  const showModel = distinctModels(group.records).length > 1
  const declared = group.group.workload.num_requests

  return (
    <section className="dqband" aria-label="Disqualified runs">
      <h3>
        Disqualified — {entries.length} of {group.records.length}{' '}
        {entries.length === 1 ? 'run' : 'runs'}
      </h3>
      <p className="dqintro">
        Shown, not hidden. Each was offered the same {formatCount(declared)} requests but did
        not complete them, so its percentiles describe a smaller, easier job and cannot be
        ranked beside a complete run.
      </p>

      {entries.map((e) => {
        const record = group.disqualified.find((r) => r.run_id === e.runId)!
        return (
          <article key={e.runId} id={rowId(record)} className="dqrow">
            <div className="dqtop">
              {showModel && <span className="model">{e.model}</span>}
              <span className="nm">
                {e.hardware} tp{e.tp}
              </span>
              {e.chips.map((chip) => (
                <span key={chip.label} className={chip.extra ? 'knob extra' : 'knob'}>
                  {chip.label}
                </span>
              ))}
              {e.reasons.map((r) => (
                <span key={r.code} className={`chip ${r.class === 'altered' ? 'alt' : 'crit'}`}>
                  {r.code}
                  <small> · {r.class}</small>
                </span>
              ))}
            </div>

            <p className="dqwhy">
              {e.reasons.map((r) => r.detail).join(' · ')}. Its E2E p99 of{' '}
              <b>{formatMs(e.e2eP99Ms)}</b> would place it{' '}
              <b>
                #{e.wouldBeRank.rank} of {e.wouldBeRank.of}
              </b>{' '}
              on latency
              {e.wouldBeRank.rank === 1 && e.wouldBeRank.of > 1 && ' (first place)'}, by virtue
              of the work it never did.
            </p>

            <dl className="dqnums">
              <div>
                <dt>served</dt>
                <dd>
                  <Derived
                    formula={`completed_requests ÷ injected_requests = ${e.servedCompleted} ÷ ${e.servedInjected}`}
                  >
                    {formatCount(e.servedCompleted)} / {formatCount(e.servedInjected)}
                  </Derived>
                </dd>
              </div>
              <div className="tell">
                <dt>output tokens per served request</dt>
                <dd>
                  <Derived formula="total_output_tokens ÷ completed_requests. Dropping is size-biased: the requests that did not fit are the ones removed, so the served subset is systematically easier, not merely smaller.">
                    {formatNumber(e.outputTokensPerRequest, 1)}
                  </Derived>
                  {e.completeOutputTokensPerRequest != null && (
                    <small>
                      {' '}
                      vs {formatNumber(e.completeOutputTokensPerRequest, 1)} across the complete
                      runs
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>tokens/s</dt>
                <dd>{formatNumber(e.tokensPerSec, 1)}</dd>
              </div>
              <div>
                <dt>TTFT p99</dt>
                <dd>{formatMs(e.ttftP99Ms)}</dd>
              </div>
              {(e.stillRunning > 0 || e.stillQueued > 0) && (
                <div>
                  <dt>unfinished at the window</dt>
                  <dd>
                    {formatCount(e.stillRunning)} running, {formatCount(e.stillQueued)} queued
                  </dd>
                </div>
              )}
            </dl>

            <DqRepro record={record} />
          </article>
        )
      })}
    </section>
  )
}
