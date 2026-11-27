import { useRef, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { keyboardLift, useKeyboardInset } from '../useKeyboardInset'
import { useDismissGrace } from './dismissGrace'
import { leaveBottomSheet, useSwipeDismiss } from './swipeDismiss'
import { popoverOpen } from './popoverGuard'
import { useFieldFirst } from './fieldFirst'
import { useBackLayer } from './layer'
import { SheetGrab } from './SheetGrab'
import { useMobileScrollLock } from './useMobileScrollLock'

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
  /**
   * A surface with its OWN inner layers (an open search, an inline editor) answers Escape first:
   * return `true` when it consumed the key (it closed that layer), `false` to let the overlay close.
   * «One gesture closes one thing» at the primitive, instead of a surface vetoing Escape wholesale
   * with `dismissEscape={false}` and then never closing at all — which is what the Verlauf did on
   * the tablet (3am test r4, 26.09.2026).
   */
  onEscape?: () => boolean
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
  /**
   * Swipe the phone bottom sheet down to close it — the same gesture <Sheet> carries, on by
   * default for the same reason (see swipeDismiss).
   */
  swipeToClose?: boolean
  /**
   * Draw the grab bar as the frame's first child — the SAME element <Sheet> draws
   * (`SheetGrab`), phone-only in CSS. Opt-in, because a bespoke frame owns its own layout and a
   * child lands inside its `> *` rules: pass it for every frame that IS a bottom sheet on a
   * phone (20.09.2026 – the composer, the Verlauf and the pickers had the gesture and no sign
   * of it), never for one that is full-screen or centred there.
   */
  grab?: boolean
  /**
   * Where focus goes on close (Base UI's `finalFocus`). Default: back to the opener. A surface
   * whose opener can be gone by then – it lived in a row the overlay's own work replaced – names
   * a target that is still there; return `true` for the default.
   */
  finalFocus?: () => HTMLElement | boolean
  children: ReactNode
}

/** Hand `node` to a ref of either shape — the frame has two readers. */
function setRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}

export function Overlay({ open, onClose, className, backdropClassName = 'ui-backdrop', ariaLabel, initialFocus, modal = 'trap-focus', dismissEscape = true, onEscape, style, popupRef, swipeToClose = true, grab = false, finalFocus, children }: OverlayProps) {
  useMobileScrollLock(open)
  const isOpeningEcho = useDismissGrace(open)
  const ownPopup = useRef<HTMLDivElement | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  // the frame is ours to measure AND the caller's (`popupRef`)
  const setPopup = (node: HTMLDivElement | null) => { setRef(ownPopup, node); setRef(popupRef, node) }
  // every close leaves the way a phone bottom sheet came in — down (swipeDismiss · leaveBottomSheet)
  const close = () => leaveBottomSheet(ownPopup.current, backdropRef.current, onClose)
  const swipe = useSwipeDismiss({ onClose, enabled: swipeToClose, backdrop: backdropRef })
  // the on-screen keyboard, the same way <Sheet> answers it; only an `.ip-sheet` frame has the
  // CSS for `is-kb`, a bespoke frame gets the margin (its bottom-sheet case) and the variable
  const lift = keyboardLift(useKeyboardInset(open))
  const cls = lift && !className.split(' ').includes('is-kb') ? `${className} is-kb` : className
  // the keyboard goes first: with a field focused, the first ✕ (the frame's own `.ip-x`, even one
  // that calls onClose itself — the Trupp form's) or outside tap only blurs it (fieldFirst)
  const { keyboardFirst, ...kbFirst } = useFieldFirst(open)
  // the native back (Android's back, the iOS edge swipe) closes it – one layer per press (overlays/layer)
  useBackLayer(open, close)
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
        // …and a dropdown open inside this overlay closes first, alone — see Sheet/popoverGuard
        if ((details.reason === 'outside-press' || details.reason === 'escape-key') && popoverOpen()) {
          details.cancel(); return
        }
        // …and the surface's own inner layer (search, inline editor) before the surface itself
        if (details.reason === 'escape-key' && onEscape?.()) { details.cancel(); return }
        if (keyboardFirst(details.reason)) { details.cancel(); return }
        close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop ref={backdropRef} className={backdropClassName} />
        <Dialog.Popup ref={setPopup} {...kbFirst} className={cls} style={lift ? { ...lift, ...style } : style} aria-label={ariaLabel} initialFocus={initialFocus} finalFocus={finalFocus} {...swipe}>
          {grab && swipeToClose && <SheetGrab />}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
