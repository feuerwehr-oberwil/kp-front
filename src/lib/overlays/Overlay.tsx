import type { ReactNode, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'

/**
 * Lower-level sibling of <Sheet>: gives an EXISTING bespoke overlay — one with its own
 * head/body/footer markup and classes — the Base UI Dialog behavior (focus trap + restore,
 * scroll-lock, Esc, backdrop-close, ARIA) with a minimal, pixel-identical diff.
 *
 * Use <Sheet> for the standard title + body case. Use <Overlay> when a surface has custom
 * internal structure (ReportPreflight's scroll-ref body, PlanPicker's pp-body, the mp-sheet
 * map pickers) — the caller keeps its own markup and close button (still calls onClose); Base UI
 * only adds Esc + backdrop dismissal and the focus/scroll guarantees.
 *
 *   <Overlay open onClose={close} className="ip-sheet ip-wide report-preflight ui-dialog" ariaLabel={title}>
 *     <div className="ip-head">…</div>
 *     <div className="ip-body …" ref={bodyRef}>…</div>
 *   </Overlay>
 */
export interface OverlayProps {
  open: boolean
  onClose: () => void
  /** Full class list for the popup frame INCLUDING its centering class (e.g. `ui-dialog`). */
  className: string
  /** Scrim class; defaults to the standard `.ui-backdrop`. Pass `mp-backdrop` for the map pickers. */
  backdropClassName?: string
  /** Accessible name for the dialog (the surface keeps its own visible heading). */
  ariaLabel: string
  /** Override where focus lands on open (default: Base UI picks the first focusable). */
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

export function Overlay({ open, onClose, className, backdropClassName = 'ui-backdrop', ariaLabel, initialFocus, children }: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClassName} />
        <Dialog.Popup className={className} aria-label={ariaLabel} initialFocus={initialFocus}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
