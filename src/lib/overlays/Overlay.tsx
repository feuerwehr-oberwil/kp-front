import type { CSSProperties, ReactNode, Ref, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { keyboardLift, useKeyboardInset } from '../useKeyboardInset'
import { useDismissGrace } from './dismissGrace'

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
  /**
   * Modality; default `'trap-focus'` for the same reason as <Sheet>: these overlays host field
   * pickers (Combo / PersonField, e.g. Einsatzleiter) that portal their menu to <body>, which
   * full `modal` would mark inert. See Sheet's `modal` doc.
   */
  modal?: boolean | 'trap-focus'
  /**
   * Let Base UI close the dialog on Escape. Default `true`. Pass `false` when the surface owns
   * Escape itself (e.g. AudioPlayerSheet, where Esc-in-a-field blurs the field rather than closing,
   * plus Space/←/→/↑/↓ transport) — then its own keydown handler calls `onClose` when appropriate.
   */
  dismissEscape?: boolean
  /** Inline style for the popup frame. Merged OVER the keyboard lift every Overlay applies
   *  (keyboardLift · `is-kb`), so a surface with its own keyboard answer (the composer) wins. */
  style?: CSSProperties
  /**
   * The popup element itself, for a surface that has to MEASURE its own frame (the journal
   * composer weighs its height against the room it has). Without it the only way in is a
   * `display: contents` wrapper inside the popup — which is a box the layout does not have, so
   * every `> *` rule on the frame silently addresses the wrapper instead of the rows. That cost
   * the composer its «nothing shrinks» rule for weeks (see 10-journal.css).
   */
  popupRef?: Ref<HTMLDivElement>
  children: ReactNode
}

export function Overlay({ open, onClose, className, backdropClassName = 'ui-backdrop', ariaLabel, initialFocus, modal = 'trap-focus', dismissEscape = true, style, popupRef, children }: OverlayProps) {
  const isOpeningEcho = useDismissGrace(open)
  // the on-screen keyboard, the same way <Sheet> answers it; only an `.ip-sheet` frame has the
  // CSS for `is-kb`, a bespoke frame gets the margin (its bottom-sheet case) and the variable
  const lift = keyboardLift(useKeyboardInset(open))
  const cls = lift && !className.split(' ').includes('is-kb') ? `${className} is-kb` : className
  return (
    <Dialog.Root
      open={open}
      modal={modal}
      onOpenChange={(next, details) => {
        if (next) return
        // the caller owns Escape → veto Base UI's escape-driven close (it still closes via `open`)
        if (!dismissEscape && details.reason === 'escape-key') { details.cancel(); return }
        // a touch surface opened from pointerup gets its own synthetic mousedown back as an
        // "outside press" — ignore it (see dismissGrace)
        if (isOpeningEcho(details.reason)) { details.cancel(); return }
        onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClassName} />
        <Dialog.Popup ref={popupRef} className={cls} style={lift ? { ...lift, ...style } : style} aria-label={ariaLabel} initialFocus={initialFocus}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
