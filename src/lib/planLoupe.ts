/**
 * The plan magnifier's crop (GeorefMode · PlanLoupe): which part of which on-screen picture of
 * the sheet lands where in the loupe.
 *
 * ⚠️ The sheet is not ONE bitmap. A revision with a tile pyramid is drawn by PlanTileLayer as a
 * few dozen `<img>` tiles (an underlay level, the current level, the retained one); only a plan
 * without tiles is a pdf.js canvas pair (a base blit + a sharper refine crop). The loupe used to
 * read «the first `<canvas>` of the board» – on a tiled plan there is none, so the circle stayed
 * empty (black on the night theme) on every phone, 27.10.2026. Now it copies whatever pictures
 * the sheet is made of, in paint order, each through its own on-screen box, so a later (sharper)
 * layer lands on top of the soft one exactly as on the glass.
 *
 * Pure: boxes in, draw calls out – the component does the DOM reads and the `drawImage`.
 */

/** One picture of the sheet as it stands on screen: its client box and its own pixel size. */
export interface LoupeSource { left: number; top: number; width: number; height: number; pxW: number; pxH: number }

/** A `drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)` for the source at `index`. */
export interface LoupeDraw { index: number; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }

/**
 * The draw calls that fill a loupe of `size` CSS px (backing store `size × dpr`) with the
 * sheet around the client point `aim`, magnified `mul`× over what the screen shows.
 * Sources that do not touch the crop, or have no pixels yet, draw nothing.
 */
export function planLoupeDraws(
  aim: { x: number; y: number },
  size: { w: number; h: number },
  mul: number,
  dpr: number,
  sources: readonly LoupeSource[],
): LoupeDraw[] {
  // the crop, in client px: the loupe's own size shrunk by the magnification, centred on the aim
  const cw = size.w / mul, ch = size.h / mul
  const cx = aim.x - cw / 2, cy = aim.y - ch / 2
  const k = mul * dpr // client px of the crop → backing-store px of the loupe
  const draws: LoupeDraw[] = []
  sources.forEach((s, index) => {
    if (!s.width || !s.height || !s.pxW || !s.pxH) return
    const x0 = Math.max(cx, s.left), x1 = Math.min(cx + cw, s.left + s.width)
    const y0 = Math.max(cy, s.top), y1 = Math.min(cy + ch, s.top + s.height)
    if (x1 <= x0 || y1 <= y0) return
    const fx = s.pxW / s.width, fy = s.pxH / s.height
    draws.push({
      index,
      sx: (x0 - s.left) * fx, sy: (y0 - s.top) * fy, sw: (x1 - x0) * fx, sh: (y1 - y0) * fy,
      dx: (x0 - cx) * k, dy: (y0 - cy) * k, dw: (x1 - x0) * k, dh: (y1 - y0) * k,
    })
  })
  return draws
}
