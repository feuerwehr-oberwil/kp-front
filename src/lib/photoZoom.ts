/**
 * Zoom/pan arithmetic for the full-size picture viewer (lib/ui · PhotoZoom). Pure, so the gesture
 * wiring stays testable without a DOM.
 *
 * The model: the <img> fills its frame (`object-fit: contain`, so the PICTURE is the contained
 * rectangle inside it) and is drawn with `translate(x, y) scale(k)` about its centre — which is
 * the frame's centre. Every point here is in px relative to that centre. A spot `q` of the picture
 * at k = 1 lands at `x + k·q` on screen.
 */
export interface Zoom { k: number; x: number; y: number }
export interface Size { w: number; h: number }
export interface Pt { x: number; y: number }

export const ZOOM_FIT: Zoom = { k: 1, x: 0, y: 0 }
/** A detail on a phone photo (a Kennzeichen, a UN-Nummer) is readable well before 8×. */
export const PHOTO_ZOOM_MAX = 8
/** Double tap / click: in this far, about the tapped spot. */
export const TAP_ZOOM = 3
/** Below this the picture snaps back to the fit, so «fit» is a state and not a rounding residue. */
const FIT_SNAP = 1.02
const clampK = (k: number) => Math.min(PHOTO_ZOOM_MAX, Math.max(1, k))

/** The picture's drawn size at k = 1: the natural size scaled to fit the frame (contain). Without a
 *  natural size yet (still loading) the picture is taken to fill the frame. */
export function containSize(frame: Size, natural: Size | null): Size {
  if (!natural || !(natural.w > 0) || !(natural.h > 0)) return frame
  const s = Math.min(frame.w / natural.w, frame.h / natural.h)
  return { w: natural.w * s, h: natural.h * s }
}

/** Keep k in [1, MAX] and the picture over the frame: zoomed in, an edge may come up to the frame's
 *  edge but never leave a gap there (a picture panned off-screen is lost with no way back); a side
 *  that is still narrower than the frame stays centred. */
export function clampZoom(z: Zoom, frame: Size, pic: Size): Zoom {
  const k = clampK(z.k)
  if (k < FIT_SNAP) return ZOOM_FIT
  const mx = Math.max(0, (pic.w * k - frame.w) / 2)
  const my = Math.max(0, (pic.h * k - frame.h) / 2)
  return { k, x: Math.min(mx, Math.max(-mx, z.x)), y: Math.min(my, Math.max(-my, z.y)) }
}

/** Scale to `k` (held to [1, MAX] first, so the anchor does not drift at the limits) about point
 *  `at`, so the spot under the cursor/finger stays under it. The pan is left to clampZoom. */
export function zoomAbout(z: Zoom, nk: number, at: Pt): Zoom {
  const k = clampK(nk)
  const r = k / z.k
  return { k, x: at.x - (at.x - z.x) * r, y: at.y - (at.y - z.y) * r }
}

/** Two-finger gesture from its start: the scale follows the finger spread, and the spot that was
 *  under the fingers' midpoint follows the midpoint — so a pinch zooms AND pans, the way a photo
 *  moves under two fingers everywhere else. k is held to [1, MAX]; the pan is left to clampZoom. */
export function pinchTo(start: Zoom, mid0: Pt, dist0: number, mid1: Pt, dist1: number): Zoom {
  if (!(dist0 > 0) || !(dist1 > 0)) return start
  const k = clampK(start.k * (dist1 / dist0))
  const r = k / start.k
  return { k, x: mid1.x - (mid0.x - start.x) * r, y: mid1.y - (mid0.y - start.y) * r }
}

/** Double tap: back to the fit when zoomed in, else in to TAP_ZOOM about the tapped spot. */
export function toggleZoomAt(z: Zoom, at: Pt): Zoom {
  return z.k > 1 ? ZOOM_FIT : zoomAbout(z, TAP_ZOOM, at)
}

/** Is `at` over the picture itself, or over the dark letterbox around it (where a tap closes)? */
export function onPicture(z: Zoom, pic: Size, at: Pt): boolean {
  return Math.abs(at.x - z.x) <= (pic.w * z.k) / 2 && Math.abs(at.y - z.y) <= (pic.h * z.k) / 2
}
