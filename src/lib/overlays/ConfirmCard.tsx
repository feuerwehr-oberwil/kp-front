import { useRef } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'

/**
 * The confirm/alert card behind the imperative `confirmDialog()` (src/lib/ui.tsx). Built on Base
 * UI's AlertDialog so it gets focus trap + restore, scroll-lock and inert siblings — keeping the
 * existing `.confirm-*` look and the `role="alertdialog"` semantics.
 *
 * Behaviour note vs. the old hand-rolled confirm: an alert dialog is deliberately NOT
 * pointer-dismissible, so clicking the backdrop no longer cancels — you choose Cancel or press
 * Esc. That's the safer default for a destructive confirmation (no accidental dismissal).
 */
export function ConfirmCard({ open, title, message, confirmLabel, cancelLabel, danger, onResolve }: {
  open: boolean
  title?: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  onResolve: (confirmed: boolean) => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) onResolve(false) }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop confirm-backdrop" />
        <AlertDialog.Popup className="confirm-card ui-dialog" initialFocus={confirmRef} aria-label={title ?? message}>
          {title && <AlertDialog.Title className="confirm-title" render={<h3 />}>{title}</AlertDialog.Title>}
          <p className="confirm-msg">{message}</p>
          <div className="confirm-actions">
            <button className="btn" onClick={() => onResolve(false)}>{cancelLabel}</button>
            <button ref={confirmRef} className={`btn ${danger ? 'warn-solid' : 'primary'}`} onClick={() => onResolve(true)}>{confirmLabel}</button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
