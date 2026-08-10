import { useEffect, useRef, useState } from 'react'

/**
 * Height (px) the on-screen keyboard currently occupies, via the VisualViewport API.
 * 0 when no keyboard is shown. Lets a bottom sheet lift its content above the iOS/Android
 * keyboard instead of hiding behind it.
 *
 * ⚠️ It measures the KEYBOARD only — `innerHeight - visualViewport.height` — and deliberately
 * NOT `visualViewport.offsetTop`. offsetTop is how far the visual viewport has been scrolled
 * inside the layout viewport, and iOS moves it continuously while it scrolls a focused field
 * into view. Subtracting it fed that motion straight back into the sheet's margin: the sheet
 * moved, iOS re-scrolled to keep the caret visible, which moved the sheet again. On a phone
 * with a photo attached — where the composer is already at its max height — that loop is the
 * «typing in the Verlauf glitches out» report from the 09.08. Einsatz.
 *
 * Two more guards against the same class of jitter:
 *   · updates are coalesced into one animation frame, so a burst of scroll events costs one
 *     re-render rather than a dozen;
 *   · a change under `MIN_STEP` px is ignored, so the address bar sliding or a one-line field
 *     growing never moves the sheet. A keyboard opening or closing is always far larger.
 */
/** px below which a viewport change is not a keyboard appearing or disappearing */
const MIN_STEP = 40

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  // the last value we COMMITTED, read inside the listener without re-subscribing it
  const committed = useRef(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let frame = 0
    const measure = () => {
      frame = 0
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height))
      // treat anything below the step as «no change» — including the way back to 0, which is
      // never a small step when a keyboard actually closes
      if (Math.abs(kb - committed.current) < MIN_STEP) return
      committed.current = kb
      setInset(kb)
    }
    const update = () => { if (!frame) frame = requestAnimationFrame(measure) }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}
