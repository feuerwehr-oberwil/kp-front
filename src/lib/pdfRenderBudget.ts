/**
 * ONE pixel ceiling for every pdf.js rasterisation in the app.
 *
 * A PDF page has no size of its own that a renderer must honour — it is drawn at whatever scale
 * the caller asks for, and every one of our four render sites asked for «as crisp as the screen
 * can show». On an A1 Geschossplan (1684 × 2384 pt) at 4× zoom and a dpr of 3 that is a
 * 15 000 × 21 000 px canvas — 1.2 GB — and the Gebäude floor-stack asks for one PER STOREY. iOS
 * answered the way it always does: «A problem repeatedly occurred» (jetsam, 15.09.2026, an A1
 * Modul 6 and a five-storey floor pack, both on prod).
 *
 * So the scale is not the caller's to choose any more. Every site states the page's size, the
 * zoom it wants and the device ratio, and `renderScale` hands back the scale that fits the
 * budget. Past it the CSS size stays what the zoom asked for and the bitmap is upscaled: a
 * slightly soft plan is readable at 3am, a killed tab is not.
 *
 * ⚠️ Two hard limits sit under the budget and are not negotiable. iOS Safari draws NOTHING into
 * a canvas above 2^24 device px — not an error, a blank page, which reads in the field as «the
 * zoom did not register» — and no engine accepts a side past 8192.
 */

/** No engine accepts a canvas side beyond this. */
export const CANVAS_MAX_SIDE = 8192
/** 2^24 — above it iOS Safari silently draws nothing at all. */
export const MAX_CANVAS_PX = 16_777_216
/** What ONE document's resident page canvases may spend together (4 bytes a pixel → ~384 MB). */
export const DOC_CANVAS_PX = 96_000_000

/** …and the same two numbers for a phone/tablet-class device: 6 M px is 24 MB a page, and a
 *  five-storey floor pack then costs 64 MB of bitmaps instead of 475 MB. */
export const SMALL_DEVICE_PX = 6_000_000
export const SMALL_DEVICE_DOC_PX = 16_000_000

/**
 * Is this a device whose tab gets reclaimed rather than swapped?
 *
 * `navigator.deviceMemory` answers on Chromium; iOS/iPadOS ships neither it nor a distinguishing
 * user agent (an iPad says «Macintosh»), so the touch-point count is what separates an iPad from
 * a Mac there — the same heuristic the media pipeline already uses.
 */
export function smallMemoryDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (typeof mem === 'number' && mem > 0) return mem <= 4
  const ua = navigator.userAgent ?? ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/**
 * The pixel budget ONE page of an `pages`-page document may spend — the per-page ceiling, or the
 * document's share of it, whichever is smaller. Read live (never captured at module load), so a
 * test and a device answer for themselves.
 */
export function pageCanvasBudget(pages = 1): number {
  const small = smallMemoryDevice()
  return Math.min(small ? SMALL_DEVICE_PX : MAX_CANVAS_PX, (small ? SMALL_DEVICE_DOC_PX : DOC_CANVAS_PX) / Math.max(1, pages))
}

/**
 * The pdf.js scale to render one page at: `zoom × dpr` device px per point, lowered until the
 * canvas fits the budget and the side limit. Pure — the page's size in points, the zoom, the
 * device ratio and the budget are everything it needs, so the cap is testable without pdf.js.
 */
export function renderScale(
  pageWidthPt: number,
  pageHeightPt: number,
  zoom: number,
  dpr: number,
  budgetPx: number = pageCanvasBudget(),
): number {
  const want = Math.max(0.01, zoom * dpr)
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0)) return want
  return Math.min(
    want,
    Math.sqrt(budgetPx / (pageWidthPt * pageHeightPt)),
    CANVAS_MAX_SIDE / pageWidthPt,
    CANVAS_MAX_SIDE / pageHeightPt,
  )
}

/** The same cap said in CSS pixels: the backing-store ratio for a page laid out at cssW × cssH.
 *  Below `dpr` the page is drawn softer — never blank — and the CSS size stays the zoom's. */
export function canvasScale(cssW: number, cssH: number, dpr: number, maxPx: number = pageCanvasBudget()): number {
  return renderScale(cssW, cssH, 1, dpr, maxPx)
}

/** The long side one raster of a page with this aspect (height / width) may have. Used where the
 *  caller bakes a bitmap once and lets CSS scale it (the Gebäude floor tiles). */
export function rasterSide(aspect: number, budgetPx: number = pageCanvasBudget()): number {
  const a = aspect > 0 ? aspect : 1
  const w = Math.sqrt(budgetPx / a) // the width whose w × w·a area is exactly the budget
  return Math.min(CANVAS_MAX_SIDE, Math.round(w * Math.max(1, a)))
}

/** The long side one storey's Geschossplan raster may have on the Gebäude floor-stack.
 *
 *  A ceiling first — 2048 px is ~2× a storey tile on a phone at the 4× zoom and about 1:1 on a
 *  tablet, which is what «not mush at 2×» asked for — and under it the device's own budget
 *  divided by the storeys, because a stack holds one of these PER FLOOR at the same time.
 *  ⚠️ It must not depend on the zoom: the tile grows with it, and asking in tile pixels minted
 *  a fresh bake, JPEG and decoded image at every tick of a pinch (15.09.2026). */
export const FLOOR_PAGE_SIDE = 2048
export const floorPageSide = (floors: number): number =>
  Math.min(FLOOR_PAGE_SIDE, rasterSide(Math.SQRT2, pageCanvasBudget(Math.max(1, floors))))
