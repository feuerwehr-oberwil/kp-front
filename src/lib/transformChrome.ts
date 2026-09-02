/**
 * «Die Griffe treten zur Seite» — while a selection is being MOVED or TURNED from the selection
 * bar, its own geometry chrome is hidden for the length of the gesture.
 *
 * A selected Linie wears a node pad on every vertex, a «+» in every gap, Verlängern on both ends
 * and a detach ring on each attachment; a Form wears its rotate/resize/cage handles. All of that
 * answers «where exactly», and none of it answers «where to» — under a whole-object drag it is a
 * cloud of blue furniture travelling with the object, hiding the very shape the operator is
 * aiming. So the grips go for the drag and come straight back on release: the object reads as one
 * thing while it moves.
 *
 * A body class rather than props, for the same reason `sheetPeek` is one: the grips are rendered
 * by five components across two surfaces with no shared owner, and this changes nothing but what
 * is painted — no unmount, no state, no gesture rewired (the drag already owns the pointer).
 *
 * Self-healing on purpose: arming also arms a one-shot window release, so a gesture that ends
 * without its own end-handler running can never leave the grips hidden.
 */

const CLASS = 'sel-transforming'

let armed = false

const release = () => {
  if (!armed) return
  armed = false
  window.removeEventListener('pointerup', release, true)
  window.removeEventListener('pointercancel', release, true)
  window.removeEventListener('blur', release)
  document.body.classList.remove(CLASS)
}

/** A whole-object transform started (the bar's own grip drag, or an armed drag on the surface). */
export function beginTransformChrome() {
  if (armed) return
  armed = true
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release)
  document.body.classList.add(CLASS)
}

/** …and it ended: every grip is back exactly as it was. */
export function endTransformChrome() {
  release()
}

/** Test seam: are the selection's geometry grips currently stepped aside? */
export function transformingChrome() {
  return armed
}
