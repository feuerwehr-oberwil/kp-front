/*
 * **A finger slides through a menu** (sweep 30.10.2026, owner: «hovering the finger over the
 * labels should ideally highlight the one below the finger and not just the one where the finger
 * is first placed»; round 18.11.2026: «…everywhere»). The iOS menu gesture: a touch that travels
 * highlights the row under it, lifting on a row presses that row (a checkbox row toggles and the
 * menu stays open, as on a tap), lifting anywhere else does nothing. A plain tap is left to the
 * browser. A row's own confirm (a destructive row) still runs: the lift is the row's click.
 *
 * Where it is worn: every `Menu`, the app menu (the Einsatz menu and home's «Einsätze ▾»,
 * `appMenuSlide`), the Ansichten dock and the `ComboMenu` lists. The row under the finger wears
 * `data-slide-on`, which 02-base.css draws in the menu row's `--blue-8` wash – on a Base UI row
 * too: its own `[data-highlighted]` follows focus and ignores a touch leaving a row, so a finger
 * slid off the rows would leave the last one lit. The pressed row's `:active` wash goes the moment
 * the finger leaves it (lib/pressRelease), so only the row under the finger is lit.
 *
 * ⚠️ A list that SCROLLS keeps native scrolling — a slide there is a scroll, so the gesture is
 * not taken (decided at `touchstart`), and the scroll clears the press (lib/pressRelease). Nor is
 * a touch that starts in a text field (a Combo's search): its drag selects text.
 *
 * Touch events rather than pointer events on purpose: after `pointerdown` the browser may claim
 * the touch for panning and send `pointercancel`; a non-passive `touchmove` that calls
 * `preventDefault` keeps it, and `preventDefault` on `touchend` swallows the click the browser
 * would otherwise synthesize on the row the finger STARTED on.
 */

/** Base UI's menu rows (`Menu`). */
const MENU_ROWS = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'

/** The attribute a plain (non-Base-UI) row wears while the finger is on it. */
const SLIDE_ON_ATTR = 'data-slide-on'

/** Finger travel (px) beyond which a touch is a slide, not a tap. */
const SLOP = 8

/** The pressable row (`rows`) of `popup` at the element `hit` (from `elementFromPoint`), or null. */
export function slideRow(hit: Element | null, popup: Element, rows: string = MENU_ROWS): HTMLElement | null {
  const row = hit?.closest<HTMLElement>(rows)
  if (!row || !popup.contains(row)) return null
  if (row.getAttribute('aria-disabled') === 'true' || row.hasAttribute('data-disabled') || row.matches(':disabled')) return null
  return row
}

/** Attach the slide gesture to a popup whose `rows` are its pressable rows; returns the detach. */
export function attachMenuSlide(popup: HTMLElement, rows: string = MENU_ROWS): () => void {
  let start: { x: number; y: number } | null = null
  let sliding = false
  let lit: HTMLElement | null = null
  const rowAt = (t: { clientX: number; clientY: number }) => slideRow(document.elementFromPoint(t.clientX, t.clientY), popup, rows)
  const light = (row: HTMLElement | null) => {
    if (row === lit) return
    lit?.removeAttribute(SLIDE_ON_ATTR)
    lit = row
    row?.setAttribute(SLIDE_ON_ATTR, '')
  }
  const stop = () => { start = null; sliding = false; light(null) }

  const onStart = (e: TouchEvent) => {
    stop()
    const t = e.touches[0]
    const scrolls = popup.scrollHeight > popup.clientHeight + 1
    const inField = e.target instanceof Element && !!e.target.closest('input, textarea, [contenteditable="true"]')
    start = e.touches.length === 1 && !scrolls && !inField ? { x: t.clientX, y: t.clientY } : null
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    const t = e.touches[0]
    if (!sliding && Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP) return
    sliding = true
    e.preventDefault()
    light(rowAt(t))
  }
  const onEnd = (e: TouchEvent) => {
    if (!start) return
    const slid = sliding
    stop()
    if (!slid) return
    e.preventDefault()
    rowAt(e.changedTouches[0])?.click()
  }

  popup.addEventListener('touchstart', onStart, { passive: true })
  popup.addEventListener('touchmove', onMove, { passive: false })
  popup.addEventListener('touchend', onEnd, { passive: false })
  popup.addEventListener('touchcancel', stop)
  return () => {
    stop()
    popup.removeEventListener('touchstart', onStart)
    popup.removeEventListener('touchmove', onMove)
    popup.removeEventListener('touchend', onEnd)
    popup.removeEventListener('touchcancel', stop)
  }
}

/** The callback ref for the app menu's frame (IncidentSwitcher's `.ip-menu`, KarteApp's
 *  `.ip-einsaetze`): its rows are panels/AppMenuRows' – the Einsätze, the doors, the «App» group;
 *  the Einsatz card's tiles and the identity row's buttons are not rows. React 19 runs the returned
 *  detach on unmount. A module-level constant on purpose: a fresh ref per render would detach and
 *  re-attach on every render – mid-gesture too. */
export const appMenuSlide = (el: HTMLElement | null) => (el ? attachMenuSlide(el, '.ip-menu-row,.ip-menu-act') : undefined)
