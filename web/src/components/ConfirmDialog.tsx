import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  /** When false the dialog renders nothing — the parent owns the open/closed state. */
  open: boolean
  title: string
  /** The warning body: what is about to happen and what survives it. */
  children: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A modal confirmation, in the app's own idiom rather than the browser's window.confirm:
 * a hairline panel on a dimmed scrim, a destructive-styled confirm and a plain cancel. It
 * is used to gate irreversible actions (deleting a saved workload) so a stray click cannot
 * carry one out. Escape and a click on the scrim both cancel — the same two escape hatches
 * a native dialog gives — and the Cancel button takes focus on open, so the safe choice is
 * the one under the keyboard.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Escape cancels, matching the scrim click and a native confirm's Esc.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  // Land focus on the safe choice, not the destructive one.
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  if (!open) return null

  const titleId = 'confirm-dialog-title'
  return (
    <div
      className="modal-scrim"
      // Only a click that starts and ends on the scrim itself (not a drag out of the panel)
      // dismisses, so a text selection inside the dialog does not close it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <div className="modal-body dek">{children}</div>
        <div className="modal-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="danger-solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
