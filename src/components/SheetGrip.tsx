import { useRef } from 'react'
import { appConfig } from '../config/appConfig'

/**
 * Drag/tap handle for the phone bottom-sheet presentation of the shared .ctx editors
 * (ContextPanel / DrawEditor / ShapeEditor). Desktop/tablet: CSS-hidden (the panel floats
 * beside the tool rail, unchanged). Phone: the .ctx is a bottom sheet — tap toggles
 * half ↔ full, drag resizes live and snaps on release, and dragging well below the half
 * height closes the sheet (same dismiss gesture as every phone sheet).
 */
export function SheetGrip({ onClose }: { onClose?: () => void }) {
  const drag = useRef<{ y0: number; h0: number; el: HTMLElement; moved: boolean; full: boolean } | null>(null)

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget.parentElement
    if (!el) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // while the finger is down the sheet must track it 1:1 — .sheet-dragging disables the
    // height transition; releasing re-enables it so the snap to half/full eases smoothly
    el.classList.add('sheet-dragging')
    drag.current = { y0: e.clientY, h0: el.getBoundingClientRect().height, el, moved: false, full: el.classList.contains('sheet-full') }
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
    if (!d.moved) { d.el.classList.toggle('sheet-full'); return } // tap: half ↔ full
    // DIRECTION-based snap — a short pull is enough (no need to drag the whole distance):
    // up ≥40px → full; down ≥40px → half→dismiss, full→half (or dismiss on a deep pull);
    // a smaller drift keeps the current state.
    const delta = h - d.h0
    if (delta > 40) { d.el.classList.add('sheet-full'); return }
    if (delta < -40) {
      if (!d.full || h < window.innerHeight * 0.4) { onClose?.(); return }
      d.el.classList.remove('sheet-full')
    }
  }

  return (
    <button
      className="sheet-grip"
      aria-label={appConfig.copy.sheetGrip}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      // suppress the synthesized click after touchend: the toggle resizes the sheet away
      // from under the finger, so the late click would hit the MAP at the same coords and
      // deselect — closing the sheet the user just meant to resize
      onTouchEnd={(e) => e.preventDefault()}
    >
      <span />
    </button>
  )
}
