import { useRef } from 'react'
// Dialog, not AlertDialog. The two differ in exactly two things: the role, and whether a click
// outside closes — and AlertDialog does not merely default the latter off, it `Omit`s
// `disablePointerDismissal` from its props so it cannot be turned on. Dialog with the alert role
// spelled out is the same component with the behaviour we want, rather than one fought against.
import { Dialog } from '@base-ui/react/dialog'

/**
 * The confirm/alert card behind the imperative `confirmDialog()` (src/lib/ui.tsx). Built on Base
 * UI's AlertDialog so it gets focus trap + restore, scroll-lock and inert siblings — keeping the
 * existing `.confirm-*` look and the `role="alertdialog"` semantics.
 *
 * The backdrop CANCELS (2026-08-07). It used to do nothing at all — Base UI's alert dialog is
 * deliberately not pointer-dismissible, on the reasoning that a destructive confirmation should
 * not be dismissable by accident. But the only thing a backdrop click can do here is resolve
 * `false`: it can never confirm, so the worst case it buys is pressing the button again, while
 * the cost of the old behaviour was a dialog that ignores the gesture every other overlay in this
 * app answers to. A modal that does not respond to a tap beside it reads as a frozen app, and
 * that is the wrong thing to be wondering about with an Einsatz open.
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
    // every route out of here — backdrop, Esc, ✕-less cancel — resolves FALSE. There is no path
    // by which not answering counts as yes.
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onResolve(false) }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop confirm-backdrop" />
        <Dialog.Popup role="alertdialog" className="confirm-card ui-dialog" initialFocus={confirmRef} aria-label={title ?? message}>
          {title && <Dialog.Title className="confirm-title" render={<h3 />}>{title}</Dialog.Title>}
          <p className="confirm-msg">{message}</p>
          <div className="confirm-actions">
            <button className="btn" onClick={() => onResolve(false)}>{cancelLabel}</button>
            <button ref={confirmRef} className={`btn ${danger ? 'warn-solid' : 'primary'}`} onClick={() => onResolve(true)}>{confirmLabel}</button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
