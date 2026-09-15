/** Zoom arithmetic for the plain PDF reader (components/PdfScroller): 1 = the page fits the
 *  column, up to ZOOM_MAX for a small drawing or a phone screen. Pure, so the gesture wiring
 *  stays testable without pdf.js. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
export const ZOOM_STEP = 1.3

/** ⚠️ iOS Safari draws NOTHING into a canvas above 2^24 device px (pdf.js's own
 *  `maxCanvasPixels` default, for the same reason): the page is simply blank, which on a
 *  tablet read as «the zoom was not registered» (14.09.2026, Modul 6 / Hohestrasse 134). An A4
 *  page at 4096 px wide is already 23.7M px, so the old width-only cap never saved it. */
export const MAX_CANVAS_PX = 16_777_216
export const MAX_CANVAS_SIDE = 8192
/** …and every page canvas stays resident (the reader renders the whole document), so a long
 *  document splits one budget between its pages – 4 bytes a pixel, ~384 MB – or a 30-page PV
 *  documentation at 2× DPR jetsams the tab at the fit already. */
export const DOC_CANVAS_PX = 96_000_000

/** The pixel budget one page of an `n`-page document may spend. */
export const pageCanvasBudget = (pages: number) => Math.min(MAX_CANVAS_PX, DOC_CANVAS_PX / Math.max(1, pages))

/** Backing-store scale (device px per CSS px) for a page shown at cssW × cssH: the device pixel
 *  ratio, lowered until the canvas fits `maxPx` and the side limit. Below the ratio the page is
 *  drawn softer – never blank – and the CSS size stays what the zoom asked for. */
export function canvasScale(cssW: number, cssH: number, dpr: number, maxPx = MAX_CANVAS_PX): number {
  if (!(cssW > 0) || !(cssH > 0)) return dpr
  return Math.min(dpr, MAX_CANVAS_SIDE / cssW, MAX_CANVAS_SIDE / cssH, Math.sqrt(maxPx / (cssW * cssH)))
}

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

// ── keeping the spot under the fingers while the pages re-lay out at a new zoom ─────────────
// The column's padding, gaps and centring do not scale with the pages, so a scroll position
// cannot simply be multiplied (PdfScroller · zoomTo). What scales is a spot ON A PAGE.

/** A spot on one page of the column: which page, and where on it as fractions of its size. */
export interface PageAnchor { index: number; fx: number; fy: number }
/** A box in viewport px – the shape of a DOMRect, kept minimal so tests can build one. */
export interface Box { left: number; top: number; width: number; height: number }

/** The page under `point` (viewport px) and the spot on it – the page nearest vertically when
 *  the point is in a gap or the padding. Null with no pages. */
export function pageAnchorAt(pages: readonly Box[], point: { x: number; y: number }): PageAnchor | null {
  let best: { index: number; gap: number } | null = null
  pages.forEach((p, index) => {
    const gap = point.y < p.top ? p.top - point.y : point.y > p.top + p.height ? point.y - (p.top + p.height) : 0
    if (!best || gap < best.gap) best = { index, gap }
  })
  if (!best) return null
  const { index } = best as { index: number }
  const p = pages[index]
  return { index, fx: (point.x - p.left) / Math.max(1, p.width), fy: (point.y - p.top) / Math.max(1, p.height) }
}

/** The scroll position that puts `anchor` – on `page`, as laid out now – back under `focal`.
 *  `page` and `scroller` are viewport boxes; `scroll` is the scroller's current offset. */
export function anchorScroll(
  scroller: Box, scroll: { left: number; top: number }, page: Box, anchor: PageAnchor, focal: { x: number; y: number },
): { left: number; top: number } {
  const spotX = page.left - scroller.left + scroll.left + anchor.fx * page.width
  const spotY = page.top - scroller.top + scroll.top + anchor.fy * page.height
  return { left: Math.max(0, spotX - focal.x), top: Math.max(0, spotY - focal.y) }
}
