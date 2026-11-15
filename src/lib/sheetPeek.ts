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
 * the peek sit in a handful of components on two surfaces (MapView, MapMarkers, EntityMarker,
 * Whiteboard and its hooks, PlanLiveLayer) with no shared owner between them.
 *
 * A drag on an OBJECT (a vertex, a «+» midpoint, Verlängern, a Form's grip, a symbol, a body) also
 * marks `body.geom-dragging`: on the phone the tool bar and the chip row step aside for its length
 * (15-mobile.css, round 15.11.2026 #4, owner: «ensure dragging here also hides the toolbar»). The
 * peeked sheet is 76px tall, so the selection bar riding one gap above it stood ON those bars.
 * Unlike ✥ / ⟳ (lib/transformChrome) the grips stay: the finger is on one. A map pan/pinch is the
 * `view` cause – the sheet peeks, the bars stay.
 *
 * Self-healing on purpose: arming the peek also arms a one-shot window release, so a gesture
 * that ends without its own end-handler running (component unmounted mid-drag, pointer lost
 * to the OS) can never leave the sheet stuck at peek height – nor the bars hidden.
 */

const PEEK_CLASS = 'sheet-peek'
const GEOM_CLASS = 'geom-dragging'

/** what is moving under the sheet: a placed object's geometry, or only the view (pan/pinch) */
export type PeekCause = 'object' | 'view'

let armed = false

const release = () => {
  if (!armed) return
  armed = false
  window.removeEventListener('pointerup', release, true)
  window.removeEventListener('pointercancel', release, true)
  window.removeEventListener('blur', release)
  document.body.classList.remove(PEEK_CLASS, GEOM_CLASS)
}

/** The surface under the sheet started moving — get the sheet out of the way, and for an object
 *  drag the phone's bottom bars too. Idempotent. */
export function beginSheetPeek(cause: PeekCause = 'object') {
  if (cause === 'object') document.body.classList.add(GEOM_CLASS)
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

/** Test seam: are the phone's bottom bars stepped aside for an object drag? */
export function geometryDragging() {
  return document.body.classList.contains(GEOM_CLASS)
}
