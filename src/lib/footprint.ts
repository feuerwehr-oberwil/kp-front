// Building-footprint orientation maths for the Gebäude floor-stack. Pure (no React,
// no DOM) so it's unit-testable. The Gebäudeview auto-rotates a picked footprint so
// its longest axis runs horizontal (best fit to the page), shows a north arrow for the
// applied rotation, and offers a reversible "Norden oben" toggle that re-orients the
// building AND re-glues its annotations.
//
// Coordinate spaces:
//  - `src`  : the combined footprint(s) in ISOTROPIC 0..1 board space (true proportions
//             preserved — produced from OSM's square metre-bbox). The single source of truth.
//  - a "view" (buildView): src rotated by some angle, then anisotropically normalized to
//             0..1 of the rotated bbox — exactly what the floor-tile SVG (viewBox 0 0 1 1,
//             preserveAspectRatio="none") draws, with `aspect` (= h/w) restoring proportions.
//  - tile space: an annotation's stored x/y (0..1 within its storey tile). The footprint
//             box is centred in the tile, so tile<->footprint-local is a centred affine.

export type Ring = [number, number][]
export type Pt = [number, number]

const TAU = Math.PI * 2

// ---- basic geometry ----------------------------------------------------------------

function rotate([x, y]: Pt, a: number, [cx, cy]: Pt): Pt {
  const dx = x - cx, dy = y - cy, c = Math.cos(a), s = Math.sin(a)
  return [cx + dx * c - dy * s, cy + dx * s + dy * c]
}

function bbox(rings: Ring[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

// Andrew's monotone-chain convex hull (returns the hull in CCW order, no repeat).
function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop(); upper.pop()
  return lower.concat(upper)
}

// ---- principal-axis orientation ----------------------------------------------------

/** Snap-to-north threshold: a footprint already within this many degrees of north-up is left
 *  alone (no pointless rotation). */
const SNAP_DEG = 3
/** How much of the total wall length has to run in ONE direction before the footprint is turned
 *  to it, and how far off that direction a wall may be and still count towards it. */
const DOMINANT_SHARE = 0.5
const WALL_TOL_DEG = 6
/** Above this short/long ratio the two candidate rotations are equally good — see the tie-break
 *  in principalAngleDeg. */
const SQUARE_TIE = 0.95

/**
 * The share of this footprint's total wall length that runs in its dominant direction.
 *
 * ⚠️ Directions are taken mod 90°, because the four walls of any rectangular building are ONE
 * family: a wall at 21° and a wall at 111° are the two sides of the same corner.
 */
function dominantWallShare(rings: Ring[]): number {
  const walls: { deg: number; len: number }[] = []
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
      const len = Math.hypot(x2 - x1, y2 - y1)
      if (len < 1e-9) continue
      walls.push({ deg: (((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 90 + 90) % 90, len })
    }
  }
  const total = walls.reduce((s, w) => s + w.len, 0)
  if (!total) return 0
  const near = (a: number, b: number) => {
    const d = Math.abs(a - b) % 90
    return Math.min(d, 90 - d) <= WALL_TOL_DEG
  }
  let best = 0
  for (const w of walls) {
    const share = walls.reduce((sum, o) => (near(w.deg, o.deg) ? sum + o.len : sum), 0) / total
    if (share > best) best = share
  }
  return best
}

/** Degrees to rotate the footprint so its longest axis runs horizontal (minimum-area
 *  rectangle via rotating calipers over the convex hull). 0 = already north-up / square. */
export function principalAngleDeg(rings: Ring[]): number {
  const pts = rings.flat()
  if (pts.length < 3) return 0
  const hull = convexHull(pts)
  if (hull.length < 3) return 0
  const c = bboxCenter(rings)

  let best = { area: Infinity, angle: 0, w: 0, h: 0 }
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const edge = Math.atan2(b[1] - a[1], b[0] - a[0])
    // rotate the hull so this edge is horizontal, measure the enclosing box
    const rot = hull.map((p) => rotate(p, -edge, c))
    const bb = bbox([rot])
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY
    const area = w * h
    if (area < best.area) best = { area, angle: -edge, w, h }
  }

  // force the LONGER side horizontal
  let angle = best.angle
  if (best.h > best.w) angle -= Math.PI / 2

  let deg = ((angle % TAU) * 180) / Math.PI
  // wrap to (-90, 90] — a footprint has 180° symmetry for "longest axis horizontal",
  // so prefer the smallest-magnitude equivalent rotation
  while (deg > 90) deg -= 180
  while (deg <= -90) deg += 180

  // ⚠️ On a NEARLY SQUARE box the «longer side horizontal» flip above is a coin toss — the two
  // sides are the same length, so both 69° and −21° square the walls equally well. Take the
  // smaller turn: the storey sheets then sit as close to the Lage's own orientation as squaring
  // the walls allows, instead of standing the building on end for no reason.
  const short = Math.min(best.w, best.h), long = Math.max(best.w, best.h)
  if (long > 0 && short / long > SQUARE_TIE) {
    const alt = deg > 0 ? deg - 90 : deg + 90
    if (Math.abs(alt) < Math.abs(deg)) deg = alt
  }

  if (Math.abs(deg) < SNAP_DEG) return 0
  // ⚠️ …and a footprint whose walls do not agree on a direction is left north-up. This used to
  // ask whether the rotated BOUNDING BOX is nearly square — a page-fit question, and the wrong
  // one for an L- or U-shaped building: the Schloss's walls run unambiguously at 21° (72% of its
  // wall length), its min-area box is 0.98 h/w, and the old guard therefore vetoed the one
  // rotation that makes its walls read as walls. A round tank or a scattered outline still has
  // no dominant direction, and still stays north-up.
  if (dominantWallShare(rings) < DOMINANT_SHARE) return 0
  return deg
}

function bboxCenter(rings: Ring[]): Pt {
  const b = bbox(rings)
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
}

/** The building's ACTIVE view angle. An operator-dialled `viewDeg` (A8, 29.08.) wins; absent,
 *  the original binary toggle decides (north-up ⇄ the auto-orientation). One definition,
 *  because the plan surface, the printed floor pages, the board-view signature and the
 *  annotation transfer must all agree on what the operator is looking at. */
export function activeViewDeg(b: { viewDeg?: number; northUp?: boolean; orientDeg?: number }): number {
  return b.viewDeg ?? (b.northUp ? 0 : b.orientDeg ?? 0)
}

// ---- views -------------------------------------------------------------------------

export interface FootprintView {
  /** footprint polygons in this view's normalized 0..1 box (for the tile SVG) */
  rings: Ring[]
  /** box aspect h/w — restores true proportions when the 0..1 box is drawn stretched */
  aspect: number
  /** src isotropic point -> this view's normalized 0..1 */
  toNorm: (p: Pt) => Pt
  /** this view's normalized 0..1 -> src isotropic point */
  fromNorm: (n: Pt) => Pt
}

/** Rotate `src` by `angleDeg` and normalize to 0..1 of the rotated bbox. */
export function buildView(src: Ring[], angleDeg: number): FootprintView {
  const a = (angleDeg * Math.PI) / 180
  const center = bboxCenter(src)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of src) for (const p of ring) {
    const [x, y] = rotate(p, a, center)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const w = maxX - minX || 1, h = maxY - minY || 1
  const toNorm = (p: Pt): Pt => { const [x, y] = rotate(p, a, center); return [(x - minX) / w, (y - minY) / h] }
  const fromNorm = (n: Pt): Pt => rotate([minX + n[0] * w, minY + n[1] * h], -a, center)
  return { rings: src.map((ring) => ring.map(toNorm)), aspect: h / w, toNorm, fromNorm }
}

/** Unit vector pointing to real-world north in a view rotated by `angleDeg`
 *  (board y is down, so north-up = [0,-1]). Drawn in the aspect-correct tile box. */
export function northVec(angleDeg: number): Pt {
  const a = (angleDeg * Math.PI) / 180
  return [Math.sin(a), -Math.cos(a)]
}

// ---- tile <-> footprint-local affine -----------------------------------------------

/** The footprint box fills most of a tile (centred), preserving aspect — mirrors the
 *  `fpBox` math in Whiteboard. Returns the box size as a fraction of the tile (w of the
 *  full board width, h of one storey band). */
export function fpBoxFrac(aspect: number, boardW: number, boardH: number, floors: number): { rw: number; rh: number } {
  const tileH = boardH / floors
  const availW = boardW * 0.9, availH = tileH * 0.82
  let w = availW, h = availW * aspect
  if (h > availH) { h = availH; w = availH / aspect }
  return { rw: w / boardW, rh: h / tileH }
}

/** Derived Massstab for a GEOREFERENCED floor-stack (A7, 29.08.): metres per aspect-corrected
 *  measure unit, from geometry alone — no calibration tap needed. The footprint's rotated bbox
 *  width on the ground is (bbox width in src units) × `spanM`, and `fpBoxFrac` says that box
 *  spans `rw` of the board width; a horizontal segment across it measures `rw · measureAR`
 *  aspect-corrected units (lib/planScale · unitLen), so mPerU = boxWidthM / (rw · measureAR).
 *  `measureAR` is the stack's measure-space aspect (tile width/height = 1/TILE_AR) and is also
 *  the `ar` the resulting PlanScale must carry. Returns null on degenerate input (the caller
 *  keeps the manual calibration path). */
export function stackScaleMPerU(src: Ring[], spanM: number, angleDeg: number, floors: number, measureAR: number): number | null {
  if (!src.length || !(spanM > 0) || !(floors > 0) || !(measureAR > 0)) return null
  const view = buildView(src, angleDeg)
  // rotated bbox width in src units: fromNorm undoes a pure rotation (an isometry), so the
  // normalized box's horizontal edge measures out at exactly the box width
  const [ax, ay] = view.fromNorm([0, 0])
  const [bx, by] = view.fromNorm([1, 0])
  const boxWidthM = Math.hypot(bx - ax, by - ay) * spanM
  // the tile layout only cares about the board's h/w ratio, which for a board of width 1 in
  // measure space is floors · TILE_AR = floors / measureAR
  const { rw } = fpBoxFrac(view.aspect, 1, floors / measureAR, floors)
  if (!(rw > 0) || !(boxWidthM > 0)) return null
  return boxWidthM / (rw * measureAR)
}

// centred box: footprint-local 0..1 maps to the centred fraction [0.5-rw/2, 0.5+rw/2]
const tileToLocal = ([x, y]: Pt, rw: number, rh: number): Pt => [(x - (0.5 - rw / 2)) / rw, (y - (0.5 - rh / 2)) / rh]
const localToTile = ([fx, fy]: Pt, rw: number, rh: number): Pt => [0.5 - rw / 2 + fx * rw, 0.5 - rh / 2 + fy * rh]

export interface StackLayout { boardW: number; boardH: number; floors: number }

/** Remap an annotation point (stored in tile 0..1) when the building is re-oriented
 *  from `fromDeg` to `toDeg`, so it stays glued to the same spot on the footprint. */
export function remapPoint(src: Ring[], fromDeg: number, toDeg: number, layout: StackLayout, p: Pt): Pt {
  const from = buildView(src, fromDeg)
  const to = buildView(src, toDeg)
  const a = fpBoxFrac(from.aspect, layout.boardW, layout.boardH, layout.floors)
  const b = fpBoxFrac(to.aspect, layout.boardW, layout.boardH, layout.floors)
  const local = tileToLocal(p, a.rw, a.rh)        // tile -> footprint-local (old view)
  const srcPt = from.fromNorm(local)              // -> isotropic src
  const local2 = to.toNorm(srcPt)                 // -> footprint-local (new view)
  return localToTile(local2, b.rw, b.rh)          // -> tile (new view)
}
