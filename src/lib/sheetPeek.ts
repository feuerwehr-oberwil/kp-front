/**
 * «Peek» the phone detail sheet away while the surface underneath it is being moved — an object
 * dragged across it, or (since 30.08.) the map itself panned/pinched under it.
 *
 * On a phone the shared .ctx editors (ContextPanel / DrawEditor / ShapeEditor) are a bottom
 * sheet at ~46dvh — and a detail-rich symbol (Gefahrstoffe: Geschoss · Entwicklung · Stoff)
 * is routinely dragged full, at 88dvh. That leaves a strip of map barely taller than the
 * symbol itself to MOVE the thing in. So the moment a drag on a placed object clears its
 * deadzone, the sheet shrinks to its grip + header line, and it grows back to whatever
 * height it had the instant the finger comes off. No mode, no button, no state to remember.
 * A map pan reads the same way and gets the same treatment (MapView · onDragStart): the gesture
 * is about what is UNDER the sheet, so the sheet steps aside for the length of it — and steps
 * back. What it must never do is close: the selection survives every map gesture.
 *
 * ⚠️ CSS only, never an unmount: the sheet keeps its DOM, its half↔full class, every
 * in-progress field edit and its body scroll position — all we change is the height the
 * .ctx is painted at (see 15-mobile.css · body.sheet-peek .ctx). This is also why the flag
 * lives on <body> rather than in React state: the sheet's own height state is already a DOM
 * class (.sheet-full / --sheet-h, see SheetGrip · useSheetDrag), and the drags that trigger
 * the peek sit in three different components on two surfaces (MapMarkers, MapView,
 * Whiteboard) with no shared owner between them.
 *
 * Self-healing on purpose: arming the peek also arms a one-shot window release, so a gesture
 * that ends without its own end-handler running (component unmounted mid-drag, pointer lost
 * to the OS) can never leave the sheet stuck at peek height.
 */

const PEEK_CLASS = 'sheet-peek'

let armed = false

const release = () => {
  if (!armed) return
  armed = false
  window.removeEventListener('pointerup', release, true)
  window.removeEventListener('pointercancel', release, true)
  window.removeEventListener('blur', release)
  document.body.classList.remove(PEEK_CLASS)
}

/** The surface under the sheet started moving (an object drag, a map pan/pinch) — get the sheet
 *  out of the way. Idempotent. */
export function beginSheetPeek() {
  if (armed) return
  armed = true
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release)
  document.body.classList.add(PEEK_CLASS)
}

/** The gesture ended (dropped, cancelled, or the map came to rest) — the sheet returns to its
 *  previous height. Idempotent. */
export function endSheetPeek() {
  release()
}

/** Test seam: is the sheet currently peeked away? */
export function sheetPeeked() {
  return armed
}
