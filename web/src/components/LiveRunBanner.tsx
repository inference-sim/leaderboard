import type { LiveRun } from '../liverun'
import type { RunRecord } from '../load'

interface Props {
  /** Only the running and done states render a banner; an error shows on Declare (§8). */
  liveRun: Extract<LiveRun, { status: 'running' | 'done' }>
  /** Dismiss the banner. It persists until dismissed or replaced by a new run. */
  onDismiss: () => void
  /** Select the run's table, scroll to its row, and highlight it (§7). */
  onReveal: (record: RunRecord) => void
}

/**
 * The board widget that reports the one run in flight, then offers to reveal it when it
 * lands. It is rendered by App directly above the Leaderboard, only while a run is running
 * or done; a run that fails shows its error back on Declare instead (§8). `aria-live`
 * announces the running -> done transition to a screen reader without stealing focus.
 *
 * All copy avoids em dashes, per the project's UI-copy rule.
 */
export function LiveRunBanner({ liveRun, onDismiss, onReveal }: Props) {
  const { decl } = liveRun
  return (
    <div className="liverun" role="status" aria-live="polite">
      {liveRun.status === 'running' ? (
        <>
          <span className="liverun-spin" aria-hidden="true" />
          <div className="liverun-body">
            <p className="liverun-head">
              Running blis for <code>{decl.runId}</code>
            </p>
            <p className="liverun-sub">
              {decl.model} · {decl.workloadTitle}
            </p>
            <p className="liverun-note">It takes a few seconds of CPU. This page waits for it.</p>
          </div>
        </>
      ) : (
        <>
          <span className="liverun-mark" aria-hidden="true">
            ✓
          </span>
          <div className="liverun-body">
            <p className="liverun-head">
              <code>{decl.runId}</code> is in.
            </p>
            <p className="liverun-sub">
              {decl.model} · {decl.workloadTitle}
            </p>
          </div>
          <div className="liverun-actions">
            <button type="button" className="liverun-view" onClick={() => onReveal(liveRun.record)}>
              View the run
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        className="liverun-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss this run notice"
        title="Dismiss"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}
