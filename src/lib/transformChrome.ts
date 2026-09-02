/**
 * «Die Griffe treten zur Seite» — while a selection is being MOVED or TURNED from the selection
 * bar, its own geometry chrome is hidden for the length of the gesture.
 *
 * A selected Linie wears a node pad on every vertex, a «+» in every gap, Verlängern on both ends
 * and a detach ring on each attachment; a Form wears its rotate/resize/cage handles. All of that
 * answers «where exactly», and none of it answers «where to» — under a whole-object drag it is a
 * cloud of blue furniture travelling with the object, hiding the very shape the operator is
 * aiming. So the grips go for the transform and come straight back after it: the object reads as
 * one thing while it moves.
 *
 * ARMING ✥ or ⟳ hides them too, for the whole mode and not merely for the drag (02.09.): while a
 * mode is on, every press on the surface belongs to it, so a grip that can no longer be grabbed
 * must not still be offered. Armed reads as a clean object, a mode cursor and a lit button.
 *
 * A body class rather than props, for the same reason `sheetPeek` is one: the grips are rendered
 * by five components across two surfaces with no shared owner, and this changes nothing but what
 * is painted — no unmount, no state, no gesture rewired (the drag already owns the pointer).
 *
 * Self-healing on purpose: a DRAG hold also arms a one-shot window release, so a gesture that
 * ends without its own end-handler running can never leave the grips hidden. (A mode's hold is
 * deliberately not self-healing — it is meant to outlive every pointer release.)
 */

const CLASS = 'sel-transforming'

/**
 * Two independent reasons to hide the grips, and they overlap: ✥ / ⟳ ARMED is a mode that lasts
 * until it is tapped off, while the bar's own grip drag lasts one gesture. Releasing a drag while
 * a mode is armed must not hand the grips back — hence a set rather than a flag.
 */
type ChromeHold = 'armed' | 'drag'

const held = new Set<ChromeHold>()

const sync = () => { document.body.classList.toggle(CLASS, held.size > 0) }

/** the self-heal only ever lets go of the DRAG: a mode outlives every pointer release */
const releaseDrag = () => {
  if (!held.delete('drag')) return
  window.removeEventListener('pointerup', releaseDrag, true)
  window.removeEventListener('pointercancel', releaseDrag, true)
  window.removeEventListener('blur', releaseDrag)
  sync()
}

/** A mode was armed, or a whole-object transform started. */
export function beginTransformChrome(hold: ChromeHold = 'drag') {
  if (held.has(hold)) return
  held.add(hold)
  if (hold === 'drag') {
    window.addEventListener('pointerup', releaseDrag, true)
    window.addEventListener('pointercancel', releaseDrag, true)
    window.addEventListener('blur', releaseDrag)
  }
  sync()
}

/** …and it ended: with nothing else holding, every grip is back exactly as it was. */
export function endTransformChrome(hold: ChromeHold = 'drag') {
  if (hold === 'drag') { releaseDrag(); return }
  held.delete(hold)
  sync()
}

/** Test seam: are the selection's geometry grips currently stepped aside? */
export function transformingChrome() {
  return held.size > 0
}
