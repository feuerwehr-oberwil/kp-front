/*
 * **A finger slides through a menu** (sweep 30.10.2026, owner: «hovering the finger over the
 * labels should ideally highlight the one below the finger and not just the one where the finger
 * is first placed»). The iOS menu gesture, on every `Menu`: a touch that travels highlights the
 * row under it, lifting on a row presses that row (a checkbox row toggles and the menu stays
 * open, as on a tap), lifting anywhere else does nothing. A plain tap is left to the browser.
 *
 * ⚠️ A menu whose content SCROLLS keeps native scrolling — a slide there is a scroll, so the
 * gesture is not taken (decided at `touchstart`). Combo lists (`ComboMenu`) scroll and are not
 * menus; they don't wear this.
 *
 * Touch events rather than pointer events on purpose: after `pointerdown` the browser may claim
 * the touch for panning and send `pointercancel`; a non-passive `touchmove` that calls
 * `preventDefault` keeps it, and `preventDefault` on `touchend` swallows the click the browser
 * would otherwise synthesize on the row the finger STARTED on.
 */

const ROW = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'

/** Finger travel (px) beyond which a touch is a slide, not a tap. */
const SLOP = 8

/** The pressable menu row of `popup` at the element `hit` (from `elementFromPoint`), or null. */
export function slideRow(hit: Element | null, popup: Element): HTMLElement | null {
  const row = hit?.closest<HTMLElement>(ROW)
  if (!row || !popup.contains(row)) return null
  if (row.getAttribute('aria-disabled') === 'true' || row.hasAttribute('data-disabled')) return null
  return row
}

/**
 * Attach the slide gesture to a menu popup; returns the detach. The highlight is Base UI's own:
 * its rows take the highlight from `focus` (the same path a keyboard ↑/↓ takes), so focusing the
 * row under the finger lights it with the one `[data-highlighted]` wash the app already draws.
 */
export function attachMenuSlide(popup: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null
  let sliding = false
  const rowAt = (t: { clientX: number; clientY: number }) => slideRow(document.elementFromPoint(t.clientX, t.clientY), popup)

  const onStart = (e: TouchEvent) => {
    sliding = false
    const t = e.touches[0]
    const scrolls = popup.scrollHeight > popup.clientHeight + 1
    start = e.touches.length === 1 && !scrolls ? { x: t.clientX, y: t.clientY } : null
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    const t = e.touches[0]
    if (!sliding && Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP) return
    sliding = true
    e.preventDefault()
    const row = rowAt(t)
    if (row && document.activeElement !== row) row.focus({ preventScroll: true })
  }
  const onEnd = (e: TouchEvent) => {
    if (!start) return
    const slid = sliding
    start = null
    sliding = false
    if (!slid) return
    e.preventDefault()
    rowAt(e.changedTouches[0])?.click()
  }
  const onCancel = () => { start = null; sliding = false }

  popup.addEventListener('touchstart', onStart, { passive: true })
  popup.addEventListener('touchmove', onMove, { passive: false })
  popup.addEventListener('touchend', onEnd, { passive: false })
  popup.addEventListener('touchcancel', onCancel)
  return () => {
    popup.removeEventListener('touchstart', onStart)
    popup.removeEventListener('touchmove', onMove)
    popup.removeEventListener('touchend', onEnd)
    popup.removeEventListener('touchcancel', onCancel)
  }
}
