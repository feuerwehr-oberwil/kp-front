/** Zoom arithmetic for the plain PDF reader (components/PdfScroller): 1 = the page fits the
 *  column, up to ZOOM_MAX for a small drawing or a phone screen. Pure, so the gesture wiring
 *  stays testable without pdf.js. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
export const ZOOM_STEP = 1.3

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** One button press or wheel notch: multiply, snap back to exactly 1 near the floor so «fit» is
 *  a state you can reach and not a rounding residue. */
export function stepZoom(current: number, factor: number): number {
  const next = clampZoom(current * factor)
  return Math.abs(next - 1) < 0.02 ? 1 : Math.round(next * 100) / 100
}

/** Pinch: the zoom at the gesture's start times the ratio of the finger distances. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return startZoom
  return clampZoom(startZoom * (distance / startDistance))
}

/** Double tap: in at 2× from anything ≤ 1.05, otherwise back to the fit. */
export const toggleZoom = (current: number) => (current <= 1.05 ? 2 : 1)

/** Keep the point under the fingers (or the cursor) where it was after the column re-scales:
 *  the scroll offsets grow with the zoom, minus the focal point's own share. */
export function scrollAfterZoom(scroll: { left: number; top: number }, focal: { x: number; y: number }, ratio: number): { left: number; top: number } {
  return {
    left: Math.max(0, (scroll.left + focal.x) * ratio - focal.x),
    top: Math.max(0, (scroll.top + focal.y) * ratio - focal.y),
  }
}
