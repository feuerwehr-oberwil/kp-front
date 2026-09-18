import type { ReactNode, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Icon } from '../icons'
import { appConfig } from '../../config/appConfig'
import { SheetGrip } from '../../components/SheetGrip'
import { keyboardLift, useKeyboardInset } from '../useKeyboardInset'
import { useDismissGrace } from './dismissGrace'
import { useSwipeDismiss } from './swipeDismiss'
import { popoverOpen } from './popoverGuard'

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
  /**
   * Swipe the phone bottom sheet down to close it (`swipeDismiss`). ON by default — it is what a
   * bottom sheet's shape promises, so it belongs to the primitive and not to a call site. Pass
   * `false` only for a surface that owns the vertical gesture itself.
   */
  swipeToClose?: boolean
  /** Override where focus lands on open (default: Base UI picks the first focusable). */
  initialFocus?: RefObject<HTMLElement | null>
  /**
   * Modality. Default `'trap-focus'`: focus is trapped, but pointer interaction with elements
   * OUTSIDE the popup stays enabled — required because our field pickers (Combo / PersonField,
   * e.g. the Einsatzleiter picker) portal their dropdown menu to <body>, which full `modal`
   * would mark inert (making the options unclickable). Scroll-lock is dropped with it, but the
   * kiosk `body { overflow: hidden }` already prevents background scroll, so that's redundant.
   * Pass `modal` (true) only for a sheet with NO body-portalled child popup.
   */
  modal?: boolean | 'trap-focus'
}

export function Sheet({ open, onClose, title, ariaLabel, children, footer, wide, fit, sheetClassName, grip, swipeToClose = true, initialFocus, modal = 'trap-focus' }: SheetProps) {
  // the on-screen keyboard: a phone sheet lifts by margin, a tablet sheet rides up and caps its
  // height (`is-kb` + `--kb-inset`, see keyboardLift) — without a keyboard neither is rendered
  const kbInset = useKeyboardInset(open)
  const cls = ['ip-sheet', 'ui-dialog', wide && 'ip-wide', fit && 'ip-fit', sheetClassName, kbInset > 0 && 'is-kb'].filter(Boolean).join(' ')
  const isOpeningEcho = useDismissGrace(open)
  // phone bottom sheet: push it back down and it goes away (see swipeDismiss)
  const swipe = useSwipeDismiss({ onClose, enabled: swipeToClose })
  return (
    <Dialog.Root
      open={open}
      modal={modal}
      onOpenChange={(next, details) => {
        if (next) return
        // a touch surface opened from pointerup gets its own synthetic mousedown back as an
        // "outside press" — ignore it (see dismissGrace)
        if (isOpeningEcho(details.reason)) { details.cancel(); return }
        // a dropdown open INSIDE the sheet owns this gesture: the first Esc / the first tap
        // outside it closes the menu, not the sheet the operator is filling in (popoverGuard)
        if ((details.reason === 'outside-press' || details.reason === 'escape-key') && popoverOpen()) {
          details.cancel(); return
        }
        onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className={cls} style={keyboardLift(kbInset)} initialFocus={initialFocus} aria-label={title == null ? ariaLabel : undefined} {...swipe}>
          {grip && <SheetGrip onClose={onClose} />}
          {/* the grab bar — phone-only in CSS, and the same 40×5px pill as the `.ctx` sheets'
              (15-mobile.css · .sheet-grip span), so one shape means one gesture everywhere.
              Decorative: the gesture lives on the whole sheet, and the ✕ is the button. */}
          {!grip && swipeToClose && <div className="ui-sheet-grab" aria-hidden><span /></div>}
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
