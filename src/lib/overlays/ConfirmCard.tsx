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
export function ConfirmCard({ open, title, message, items, note, confirmLabel, cancelLabel, danger, onResolve }: {
  open: boolean
  title?: string
  message: string
  /** open points as a list — see ui.tsx · ConfirmReq.items */
  items?: string[]
  note?: string
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
          {/* An empty message renders NOTHING, not an empty paragraph with its own margin: some
              confirms are a title and two buttons («Stationsdrucker offline» — the title already
              is the whole statement, and the paragraph under it was an explanation nobody needed
              to read twice). */}
          {message && <p className="confirm-msg">{message}</p>}
          {/* the open points as a LIST, not as a comma-separated run-on — this is the part
              somebody has to act on, item by item, and a paragraph is read to the end by
              nobody at 3am */}
          {!!items?.length && (
            <ul className="confirm-list">
              {items.map((it) => <li key={it}>{it}</li>)}
            </ul>
          )}
          {note && <p className="confirm-note">{note}</p>}
          <div className="confirm-actions">
            <button className="ip-btn" onClick={() => onResolve(false)}>{cancelLabel}</button>
            {/* the OUTLINE danger, not a solid red fill: the same treatment every other destructive
                action in the app wears (Anwesenheit, Verlauf, BandGrid), and this confirm is also
                what «Einsatz abschliessen» goes through — which is not destructive at all. */}
            <button ref={confirmRef} className={`ip-btn ${danger ? 'ip-btn-danger' : 'primary'}`} onClick={() => onResolve(true)}>{confirmLabel}</button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
