import type { ReactNode, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Icon } from '../icons'
import { appConfig } from '../../config/appConfig'
import { SheetGrip } from '../../components/SheetGrip'

/**
 * The shared modal Sheet — ONE overlay primitive behind every `.ip-sheet`.
 *
 * Wraps Base UI's Dialog (focus trap + restore, scroll-lock, Esc, backdrop-close, full ARIA)
 * and paints it with the app's existing `.ip-*` classes, so migrating a hand-rolled
 * `.ip-ovl`/`.ip-sheet` to it is behavior-only: identical look, but every sheet now gets the
 * a11y guarantees that today only `Palette.tsx` has. Base UI portals the Backdrop and Popup as
 * siblings, so the scrim is `.ui-backdrop` and the centering is `.ip-sheet.ui-dialog` (see app.css).
 *
 * Controlled, matching how the app manages sheet visibility today (parent state → `open`):
 *
 *   <Sheet open={open} onClose={() => setOpen(false)} title="…" footer={…}>
 *     …body…
 *   </Sheet>
 */
export interface SheetProps {
  open: boolean
  onClose: () => void
  /** Standard header title. Omit + pass `ariaLabel` for a sheet with a custom/no visible header. */
  title?: ReactNode
  /** Accessible name when `title` is absent or decorative. */
  ariaLabel?: string
  children: ReactNode
  /** Right-aligned action row (`.ip-actions`). Use <SheetClose> for dismissing buttons. */
  footer?: ReactNode
  /** `.ip-wide` frame. */
  wide?: boolean
  /** `.ip-fit` — hug content instead of the fixed 800px frame. */
  fit?: boolean
  /** Extra class(es) on the popup, e.g. `ap-sheet`, `report-preflight`. */
  sheetClassName?: string
  /** Offer the phone drag-to-resize/dismiss grip (SheetGrip) on this modal. */
  grip?: boolean
  /** Override where focus lands on open (default: Base UI picks the first focusable). */
  initialFocus?: RefObject<HTMLElement | null>
}

export function Sheet({ open, onClose, title, ariaLabel, children, footer, wide, fit, sheetClassName, grip, initialFocus }: SheetProps) {
  const cls = ['ip-sheet', 'ui-dialog', wide && 'ip-wide', fit && 'ip-fit', sheetClassName].filter(Boolean).join(' ')
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className={cls} initialFocus={initialFocus} aria-label={title == null ? ariaLabel : undefined}>
          {grip && <SheetGrip onClose={onClose} />}
          <div className="ip-head">
            {title != null && <Dialog.Title>{title}</Dialog.Title>}
            <Dialog.Close className="ip-x" aria-label={appConfig.copy.closeDialog}><Icon id="close" /></Dialog.Close>
          </div>
          <div className="ip-body">{children}</div>
          {footer && <div className="ip-actions">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A button that closes the containing <Sheet>. Merges onto a native button via `render`. */
export function SheetClose({ children, className = 'ip-btn', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <Dialog.Close className={className} onClick={onClick}>{children}</Dialog.Close>
}
