import { useEffect, useRef } from 'react'

interface Props {
  /** The workload just written to the catalog, named in the confirmation. */
  workloadName: string
  /** Jump to the Workloads catalog and highlight the new row. Omitted when the reader is
   * already in the catalog (an in-tab Save), where the row is highlighted in place. */
  onView?: () => void
  /** Dismiss the toast. */
  onDismiss: () => void
  /** How long the toast stays up before it dismisses itself. Overridable for tests. */
  dismissAfterMs?: number
}

/**
 * A small, non-blocking confirmation that a workload was saved to the catalog, floated in
 * the corner over whatever view the submit landed on (the board, by then). It is not a
 * modal: it never takes focus or blocks the page, and it clears itself after a few seconds.
 * `aria-live="polite"` announces it to a screen reader without stealing focus, matching the
 * live-run banner. Hovering or focusing the toast pauses the auto-dismiss, so the "View in
 * catalog" action cannot slip away mid-reach; leaving restarts the full countdown.
 *
 * All copy avoids em dashes, per the project's UI-copy rule.
 */
export function Toast({ workloadName, onView, onDismiss, dismissAfterMs = 6000 }: Props) {
  // The live dismiss callback, held in a ref so the auto-dismiss effect can run once (not
  // reset on every parent re-render that hands a fresh onDismiss closure).
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  // Paused is a ref, not state: pausing on hover must not restart the countdown by
  // re-running the effect, only hold the timer that is already pending.
  const paused = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      timer = setTimeout(() => {
        if (paused.current) {
          arm() // still hovered: check again a tick later rather than dismiss under the cursor
          return
        }
        dismiss.current()
      }, dismissAfterMs)
    }
    arm()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [dismissAfterMs])

  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
    >
      <span className="toast-mark" aria-hidden="true">
        ✓
      </span>
      <div className="toast-body">
        <p className="toast-head">Added to the catalog</p>
        <p className="toast-sub">
          Workload <code>{workloadName}</code> is saved and ready to reuse.
        </p>
      </div>
      {onView && (
        <div className="toast-actions">
          <button type="button" className="toast-view" onClick={onView}>
            View in catalog
          </button>
        </div>
      )}
      <button
        type="button"
        className="toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss this notice"
        title="Dismiss"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}
