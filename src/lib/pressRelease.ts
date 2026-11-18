/*
 * **A press look never stays where the finger has left** (round 18.11.2026, owner: «Hovering and
 * moving the finger should change the highlight everywhere»). iOS keeps `:active` on the control a
 * touch STARTED on for as long as the finger is down – also when it slides on to another row of a
 * menu that does not scroll – so the house press wash stood on «Einsatz eröffnen» while the finger
 * was on «Einstellungen». Hover is not the cause: every `:hover` rule is gated on `(hover: hover)`.
 *
 * The fix is at the root, not per row: ONE listener for the whole app. The moment a touch that
 * began on a control leaves that control's box – or anything scrolls under it – `<html
 * data-press-left>` turns the `--press` token transparent until the finger lifts (02-base.css).
 * Every press wash in the app is drawn from that token, so no row needs a rule of its own. A
 * finger that left a control does not click it either, so the look and the outcome agree.
 *
 * The box is read ONCE, at `touchstart`: a marker dragged with the finger leaves its own old box
 * and drops the wash, and no move pays for a hit test (a forced layout per frame on a map drag).
 * The menus' other half – the highlight FOLLOWING the finger – is `lib/overlays/menuSlide`.
 */

/** What can wear a press wash: the elements a touch may start a press on. */
const PRESSABLE = 'button, a[href], label, summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"]'

/** The attribute on `<html>` while the finger is down but off the control it pressed. */
export const PRESS_LEFT_ATTR = 'data-press-left'

/** Install once at boot (main.tsx); returns the uninstall. */
export function installPressRelease(doc: Document = document): () => void {
  const root = doc.documentElement
  /** the pressed control's box, while the finger is still inside it */
  let box: DOMRect | null = null
  const leave = () => { box = null; root.setAttribute(PRESS_LEFT_ATTR, '') }
  const reset = () => { box = null; root.removeAttribute(PRESS_LEFT_ATTR) }

  const onStart = (e: TouchEvent) => {
    reset()
    const hit = e.touches.length === 1 && e.target instanceof Element ? e.target.closest(PRESSABLE) : null
    box = hit ? hit.getBoundingClientRect() : null
  }
  const onMove = (e: TouchEvent) => {
    if (!box) return
    const { clientX: x, clientY: y } = e.touches[0]
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) leave()
  }
  const onScroll = () => { if (box) leave() }
  const onEnd = (e: TouchEvent) => { if (e.touches.length === 0) reset() }

  const opts = { capture: true, passive: true } as const
  doc.addEventListener('touchstart', onStart, opts)
  doc.addEventListener('touchmove', onMove, opts)
  doc.addEventListener('scroll', onScroll, opts)
  doc.addEventListener('touchend', onEnd, opts)
  doc.addEventListener('touchcancel', onEnd, opts)
  return () => {
    doc.removeEventListener('touchstart', onStart, opts)
    doc.removeEventListener('touchmove', onMove, opts)
    doc.removeEventListener('scroll', onScroll, opts)
    doc.removeEventListener('touchend', onEnd, opts)
    doc.removeEventListener('touchcancel', onEnd, opts)
    reset()
  }
}
