// The rubber-band multi-select ("Mehrfach"/lasso) hit-test, shared by BOTH drawing surfaces —
// the Lage map (useMapCanvasGestures) and the Plan whiteboard (useBoardGestures). The gesture
// grammar (drag a box, a short drag counts as a tap) and the box math are identical; only how a
// surface point PROJECTS into client-pixel space differs (MapLibre map.project vs scaling
// normalized board coords by the rect), so that stays a caller-supplied callback. Keeping the
// threshold + bounds test here stops the two surfaces from drifting apart.

/** The drag box in raw CLIENT (pointer) coordinates. */
export interface MarqueeRect { x0: number; y0: number; x1: number; y1: number }

/** Below this drag distance (px on each axis) the box is treated as a tap, not a selection —
 *  so a plain click still falls through to single-select. */
export const MARQUEE_TAP_PX = 6

export function isMarqueeTap(r: MarqueeRect): boolean {
  return Math.abs(r.x1 - r.x0) < MARQUEE_TAP_PX && Math.abs(r.y1 - r.y0) < MARQUEE_TAP_PX
}

/** Build the "is this point inside the finished box?" predicate. `project` maps a surface point
 *  into the SAME client space the rect lives in (map: back-project lng/lat via map.project +
 *  container offset; plan: rect.left + x*rect.width, etc.). A point is in when its projection
 *  lands within the box bounds. */
export function marqueeContains<P>(
  r: MarqueeRect,
  project: (pt: P) => { cx: number; cy: number },
): (pt: P) => boolean {
  const minX = Math.min(r.x0, r.x1), maxX = Math.max(r.x0, r.x1)
  const minY = Math.min(r.y0, r.y1), maxY = Math.max(r.y0, r.y1)
  return (pt) => {
    const { cx, cy } = project(pt)
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY
  }
}
