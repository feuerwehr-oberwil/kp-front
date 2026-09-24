/**
 * The pointer maths of the on-object turn and size grips, once, for both surfaces (23.09.2026).
 *
 * The Karte (components/MapMarkers · rotMove / shapeMove) and the Plan (components/Whiteboard ·
 * rotMove) each carried the same four formulas inline: a grip's bearing from the pointer, a
 * Rotation end pulled back along its run, that run's bearing, and the pointer's offset turned
 * into a Form's own frame. Everything around them — the units (ground metres vs. sheet
 * fractions), the clamps, the magnet — stays with its surface.
 *
 * ⚠️ The Karte stores GEOGRAPHIC angles (+ the map bearing, rendered as −bearing); the Plan has no
 * bearing, and its default of 0 adds nothing. The addition order is the original one on both
 * surfaces — offset first, then bearing — so a stored angle is the same number to the last bit.
 */

type Pt = { x: number; y: number }

/** Any angle in degrees, folded into [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360

/** Screen bearing of `ptr` seen from `c`, in degrees (0° = pointing right, clockwise). */
export const pointerDeg = (ptr: Pt, c: Pt): number => (Math.atan2(ptr.y - c.y, ptr.x - c.x) * 180) / Math.PI

/** Which way a rotor grip reads the pointer: the body knob sits at the TOP of the glyph (+90), a
 *  composite's part knob at the BOTTOM (−90) — opposite sides, easy to grab apart — and an
 *  `aim` grip IS the direction it sets (the Hubretter cage, the Karte's plain rotor). */
export type RotorMode = 'rotate' | 'rotate2' | 'aim'
const ROTOR_OFFSET: Record<RotorMode, number> = { rotate: 90, rotate2: -90, aim: 0 }

/** The stored angle a rotor grip at `ptr` sets on a glyph centred at `c`, whole degrees. */
export const rotorDeg = (ptr: Pt, c: Pt, mode: RotorMode, bearing = 0): number =>
  Math.round(norm360(pointerDeg(ptr, c) + ROTOR_OFFSET[mode] + bearing))

/** A Rotation's dragged END: the grip floats `gripOffPx` past the cap, so the end is the pointer
 *  pulled back along the run towards the `fixed` far end (lib/shapes · rotationGripOffPx). */
export function rotationEnd(ptr: Pt, fixed: Pt, gripOffPx: number): Pt {
  const d = Math.hypot(ptr.x - fixed.x, ptr.y - fixed.y) || 1
  const ux = (ptr.x - fixed.x) / d, uy = (ptr.y - fixed.y) / d
  return { x: ptr.x - ux * gripOffPx, y: ptr.y - uy * gripOffPx }
}

/** …and the run's stored bearing: it points fixed → dragged when the far end is A (so the grip is
 *  B), and the other way when the grip is A. */
export const rotationEndDeg = (grip: 'endA' | 'endB', fixed: Pt, end: Pt, bearing = 0): number =>
  Math.round(norm360((grip === 'endB' ? pointerDeg(end, fixed) : pointerDeg(fixed, end)) + bearing))

/** The pointer's offset from a Form's centre, turned into the Form's own frame (`rotDeg` is its
 *  stored rotation): `lx` runs along its length, `ly` across it. A free-aspect corner reads both. */
export function freeResizeLocal(ptr: Pt, c: Pt, rotDeg: number): { lx: number; ly: number } {
  const rad = (-rotDeg * Math.PI) / 180
  const dx = ptr.x - c.x, dy = ptr.y - c.y
  return { lx: dx * Math.cos(rad) - dy * Math.sin(rad), ly: dx * Math.sin(rad) + dy * Math.cos(rad) }
}
