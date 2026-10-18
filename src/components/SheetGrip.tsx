import { useRef, type CSSProperties, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { useKeyboardInset } from '../lib/useKeyboardInset'

/**
 * The drag gesture behind the phone bottom sheet, as handlers any element can wear.
 *
 * ⚠️ Extracted from the grip itself (2026-08-11) so the WHOLE HEADER can be dragged, not just the
 * 44×5px bar. On a phone that bar is the only way to enlarge the detail sheet, and it is both the
 * smallest target on the surface and the one nothing about the layout points at — people push the
 * header, which is what a bottom sheet trains them to do everywhere else, and nothing happens.
 *
 * `tapToggles` separates the two surfaces: the grip is a control and nothing else, so a tap on it
 * flips half ↔ full. The header carries a title and a ✕, so a tap there must stay a tap — it only
 * resizes when the finger actually travels.
 *
 * The `.ctx` editors keep their height as a DOM class (`.sheet-full`, see lib/sheetPeek for why).
 * A sheet whose height is React state instead — the Karte's object sheet (components/karte ·
 * KartePanel, 17.10.2026) — passes `sheet` (the selector of its root), `full` and `onFull`, and
 * the same gesture reports the snap instead of toggling the class. `onTap` is that sheet's
 * header: a tap on its peek opens it, and the late synthesized click is swallowed like the
 * grip's (it would land on whatever the grown sheet left under the finger).
 */
export function useSheetDrag({ onClose, tapToggles, sheet = '.ctx', full, onFull, onTap, closeBelow = 0.4 }: {
  onClose?: () => void
  tapToggles: boolean
  /** the sheet root the drag resizes (default: the `.ctx` editors) */
  sheet?: string
  /** controlled height: the sheet is full now… */
  full?: boolean
  /** …and the gesture asks for this height (instead of toggling `.sheet-full` on the root) */
  onFull?: (full: boolean) => void
  /** a tap that did not travel, on a surface that does not toggle */
  onTap?: () => void
  /** a full sheet pulled below this share of the screen closes at once instead of halving —
   *  lower for a sheet whose small height is a short peek, not a half */
  closeBelow?: number
}) {
  const drag = useRef<{ y0: number; h0: number; el: HTMLElement; moved: boolean; full: boolean } | null>(null)
  const tapped = useRef(false)
  const setFull = (el: HTMLElement, f: boolean) => { if (onFull) onFull(f); else el.classList.toggle('sheet-full', f) }

  const down = (e: React.PointerEvent<HTMLElement>) => {
    tapped.current = false
    // ⚠️ Never start a drag on something that is itself pressable. The header holds the close
    // button (and, on some editors, the colour swatches) — swallowing their pointerdown would
    // trade one broken gesture for another.
    const pressable = (e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')
    if (pressable && pressable !== e.currentTarget) return
    // `closest('.ctx')` rather than parentElement: the handlers now sit on two different
    // children of the sheet, and one of them is not a direct child on every editor.
    const el = e.currentTarget.closest(sheet) as HTMLElement | null
    if (!el) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // while the finger is down the sheet must track it 1:1 — .sheet-dragging disables the
    // height transition; releasing re-enables it so the snap to half/full eases smoothly
    el.classList.add('sheet-dragging')
    drag.current = { y0: e.clientY, h0: el.getBoundingClientRect().height, el, moved: false, full: onFull ? !!full : el.classList.contains('sheet-full') }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = d.y0 - e.clientY
    if (Math.abs(dy) > 4) d.moved = true
    const h = Math.max(110, Math.min(window.innerHeight * 0.92, d.h0 + dy))
    d.el.style.setProperty('--sheet-h', `${h}px`)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    d.el.classList.remove('sheet-dragging')
    const h = parseFloat(d.el.style.getPropertyValue('--sheet-h')) || d.h0
    d.el.style.removeProperty('--sheet-h')
    if (!d.moved) {
      if (tapToggles) setFull(d.el, !d.full) // tap: half ↔ full
      else if (onTap) { tapped.current = true; onTap() }
      return
    }
    // DIRECTION-based snap — a short pull is enough (no need to drag the whole distance):
    // up ≥40px → full; down ≥40px → half→dismiss, full→half (or dismiss on a deep pull);
    // a smaller drift keeps the current state.
    const delta = h - d.h0
    if (delta > 40) { setFull(d.el, true); return }
    if (delta < -40) {
      if (!d.full || h < window.innerHeight * closeBelow) { onClose?.(); return }
      setFull(d.el, false)
    }
  }

  return {
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: up,
    // suppress the synthesized click after touchend: the toggle resizes the sheet away
    // from under the finger, so the late click would hit the MAP at the same coords and
    // deselect — closing the sheet the user just meant to resize
    onTouchEnd: (e: React.TouchEvent) => {
      if (drag.current || tapToggles || tapped.current) e.preventDefault()
      tapped.current = false
    },
  }
}

/**
 * Drag/tap handle for the phone bottom-sheet presentation of the shared .ctx editors
 * (ContextPanel / DrawEditor / ShapeEditor). Desktop/tablet: CSS-hidden (the panel floats
 * beside the tool rail, unchanged). Phone: the .ctx is a bottom sheet — tap toggles
 * half ↔ full, drag resizes live and snaps on release, and dragging well below the half
 * height closes the sheet (same dismiss gesture as every phone sheet).
 *
 * The header beside it carries the same drag (see `useSheetDrag`), so the target is the whole
 * top of the sheet rather than this bar alone.
 */
export function SheetGrip({ onClose }: { onClose?: () => void }) {
  const drag = useSheetDrag({ onClose, tapToggles: true })
  return (
    <button className="sheet-grip" aria-label={appConfig.copy.sheetGrip} {...drag}>
      <span />
    </button>
  )
}

/**
 * The `.ctx` root shared by ContextPanel, DrawEditor and ShapeEditor. It is NOT an `<Overlay>`,
 * so nothing hands it the keyboard the way lib/overlays hands it to every dialog — it has to ask.
 * `.ctx` is `position: absolute` with a max-height measured against 100dvh, and dvh does not
 * shrink for the iOS keyboard (it never has), so on an iPad the bottom of a tall panel sat behind
 * the keys while its own `.ctx-body` scroller was convinced everything already fit. This publishes
 * the measured keyboard height as `--kb-inset`, which 06-contextpanel.css subtracts from `.ctx`'s
 * max-height (same signal `.ip-sheet` answers in 13-incident.css). No margin lift — an absolutely
 * positioned box hung from `top` ignores it.
 *
 * `className` adds each editor's own modifier (DrawEditor/ShapeEditor both add `draw-editor`) —
 * kept a plain string, not a class-list util, because there is only ever the one optional extra.
 */
export function CtxShell({ className, children }: { className?: string; children: ReactNode }) {
  const kbInset = useKeyboardInset()
  return (
    <div className={className ? `ctx ${className}` : 'ctx'}
      style={kbInset > 0 ? ({ '--kb-inset': `${kbInset}px` } as CSSProperties) : undefined}>
      {children}
    </div>
  )
}
