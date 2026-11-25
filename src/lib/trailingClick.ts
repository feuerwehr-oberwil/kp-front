/**
 * Swallows the ONE click that trails a gesture which already acted – the map's hold-delete on a
 * node (MapView · handleClick). The hold fires mid-gesture; the release may then land a map click
 * on the reshaped background, which would deselect the line or put a fresh point back.
 *
 *   const guard = trailingClickGuard()
 *   onHoldFired: guard.arm()
 *   onMapClick:  if (guard.take()) return
 *
 * ⚠️ Only the click of THAT gesture. A touch long-press often leaves no click at all, nor does
 * the right-click delete, and a flag that waited for one ate the next real tap (Üben round 4,
 * 24.11.2026). The next pointerdown starts a new gesture, so it drops the flag.
 */
export function trailingClickGuard() {
  let armed = false
  const drop = () => { armed = false }
  return {
    arm() {
      armed = true
      window.addEventListener('pointerdown', drop, { capture: true, once: true })
    },
    /** true once for the click the armed gesture left; the caller ignores that click */
    take(): boolean {
      const was = armed
      armed = false
      return was
    },
    /** the trailing click was used up elsewhere (a node pad's own click) */
    drop,
  }
}
