/**
 * Ink cut to ONE storey tile of the Gebäude, and where it goes on beyond it — pure, no React.
 *
 * Why (field, 24.09.2026): a Leitung drawn on the Karte from the building to the TLF 200 m south
 * projects onto the EG tile at tile-local y ≈ 3 (lib/planProjection · projectOnto keeps a line
 * whose bounding box meets the sheet, vertices and all). The stack laid it through the storey's
 * band, the white gap and the next storey's drawing, down to where the vehicle stands. A storey
 * tile is a window onto ONE storey: what leaves it is cut at the edge, and a small «continues»
 * mark stands where it left.
 *
 * Render-only. The stored and projected geometry is never touched; the Karte, the selection and
 * the document see the whole line. Everything here works in ONE frame the caller picks — board
 * px on screen, page-width units on paper — because the direction of an exit is an angle, and an
 * angle only means something where x and y are the same unit.
 */

export type XY = [number, number]
/** An axis-aligned rectangle, x0 < x1 and y0 < y1 (closed: its edge counts as inside). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Where a line crosses the rectangle's edge on its way OUT, and the unit direction it goes. */
export interface Continuation { at: XY; dir: XY }

export interface ClippedLine {
  /** the visible pieces, each at least two points (or one, for a single-vertex line) */
  runs: XY[][]
  /** one per edge crossing – leaving, or arriving from outside – never one per vertex */
  exits: Continuation[]
}

/** below this a visible piece of a segment is a touch, not a stretch of line */
const EPS = 1e-9

/** A storey tile (board-normalized, whiteboard · floorGeometry · tileOf) in px; null when the
 *  storey is not on the board, undefined off the stack — a single sheet has no tiles to cut to,
 *  the board's own edge is its only clip. */
export const tilePx = (
  tileOf: ((floor: number | undefined) => Rect | null) | undefined, floor: number | undefined, W: number, H: number,
): Rect | null | undefined => {
  if (!tileOf) return undefined
  const r = tileOf(floor)
  return r && { x0: r.x0 * W, y0: r.y0 * H, x1: r.x1 * W, y1: r.y1 * H }
}

/** How deep one «geht weiter» chevron is on screen, in px, for a line of this weight. */
export const chevronPx = (lineWidth: number) => Math.min(13, Math.max(9, lineWidth * 1.3 + 3))

export const insideRect =(p: readonly [number, number], r: Rect): boolean =>
  p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1

const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): XY =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

const unit = (dx: number, dy: number): XY => {
  const l = Math.hypot(dx, dy) || 1
  return [dx / l, dy / l]
}

/**
 * The part of segment a→b inside `r`, as parameters [t0, t1] along it (Liang–Barsky), or null
 * when none of it is.
 */
export function clipSegment(a: readonly [number, number], b: readonly [number, number], r: Rect): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const p = [-dx, dx, -dy, dy]
  const q = [a[0] - r.x0, r.x1 - a[0], a[1] - r.y0, r.y1 - a[1]]
  let t0 = 0, t1 = 1
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null // parallel to this edge and outside it
      continue
    }
    const t = q[k] / p[k]
    if (p[k] < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  return [t0, t1]
}

/**
 * A polyline cut to `r`: the visible runs, and a `Continuation` wherever it crosses the edge.
 *
 * A line that leaves and comes back is two runs and two marks; a line entirely inside comes back
 * as ONE run of its own points and no mark; a line entirely outside as nothing at all.
 */
export function clipPolyline(pts: readonly (readonly [number, number])[], r: Rect): ClippedLine {
  const runs: XY[][] = []
  const exits: Continuation[] = []
  if (pts.length === 1) {
    if (insideRect(pts[0], r)) runs.push([[pts[0][0], pts[0][1]]])
    return { runs, exits }
  }
  let cur: XY[] | null = null
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const c = clipSegment(a, b, r)
    // nothing of this segment is visible, or only the one point where it grazes the edge
    if (!c || (len > 0 && (c[1] - c[0]) * len < EPS)) {
      // …so a run that reached this vertex ON the edge leaves the tile here
      if (cur && len > 0) exits.push({ at: [a[0], a[1]], dir: unit(b[0] - a[0], b[1] - a[1]) })
      cur = null
      continue
    }
    const [t0, t1] = c
    const p0 = lerp(a, b, t0), p1 = lerp(a, b, t1)
    if (t0 > EPS) {
      // arrives from outside, mid-segment: the mark points back the way it came
      exits.push({ at: p0, dir: unit(a[0] - b[0], a[1] - b[1]) })
      cur = null
    } else if (!cur && i > 0) {
      // arrives from outside exactly at a vertex on the edge (the segment before was not visible)
      const prev = pts[i - 1]
      exits.push({ at: p0, dir: unit(prev[0] - a[0], prev[1] - a[1]) })
    }
    if (!cur) { cur = [p0]; runs.push(cur) }
    cur.push(p1)
    if (t1 < 1 - EPS) {
      exits.push({ at: p1, dir: unit(b[0] - a[0], b[1] - a[1]) })
      cur = null
    }
  }
  return { runs, exits }
}

/** A closed polygon cut to `r` (Sutherland–Hodgman) — empty when none of it is inside. */
export function clipPolygon(pts: readonly (readonly [number, number])[], r: Rect): XY[] {
  let out: XY[] = pts.map((p) => [p[0], p[1]])
  const edges: [(p: XY) => boolean, (a: XY, b: XY) => XY][] = [
    [(p) => p[0] >= r.x0, (a, b) => lerp(a, b, (r.x0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= r.x1, (a, b) => lerp(a, b, (r.x1 - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= r.y0, (a, b) => lerp(a, b, (r.y0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= r.y1, (a, b) => lerp(a, b, (r.y1 - a[1]) / (b[1] - a[1]))],
  ]
  for (const [inside, cut] of edges) {
    if (!out.length) break
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur))
        out.push(cur)
      } else if (inside(prev)) {
        out.push(cut(prev, cur))
      }
    }
  }
  return out.length >= 3 ? out : []
}

/** The middle of the longest visible run — where a label goes when its own spot is cut away. */
export function longestRunMid(runs: readonly XY[][]): XY | null {
  let best: XY | null = null, bestLen = -1
  for (const run of runs) {
    const seg = run.slice(1).map((p, i) => Math.hypot(p[0] - run[i][0], p[1] - run[i][1]))
    const total = seg.reduce((s, l) => s + l, 0)
    if (total <= bestLen) continue
    bestLen = total
    let half = total / 2, at: XY = run[0]
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i]) { at = lerp(run[i], run[i + 1], seg[i] ? half / seg[i] : 0); break }
      half -= seg[i]
    }
    best = at
  }
  return best
}

/**
 * The «geht weiter» mark at one exit: TWO open chevrons (»») pointing out of the tile, the
 * outer one's point just inside the edge. As open strokes they cannot be read as the line's
 * own arrowhead (a single FILLED spitze, past the end) — they say «this way, and on», not «here
 * it ends». Returned as polylines of three points each, in the caller's frame; `size` is the
 * chevron's depth in that frame.
 */
export function continuationChevrons(c: Continuation, size: number, within?: Rect): XY[][] {
  const [dx, dy] = c.dir
  const nx = -dy, ny = dx // the perpendicular
  const at = (inset: number): XY[][] => {
    const out: XY[][] = []
    for (let k = 0; k < 2; k++) {
      const back = inset + k * size * 0.9
      const tip: XY = [c.at[0] - dx * back, c.at[1] - dy * back]
      const base: XY = [tip[0] - dx * size, tip[1] - dy * size]
      const half = size * 0.95
      out.push([[base[0] + nx * half, base[1] + ny * half], tip, [base[0] - nx * half, base[1] - ny * half]])
    }
    return out
  }
  // the outer point stays clear of the edge; near a CORNER an arm would still be cut by the other
  // edge, so the pair steps back along the line until it is whole (a few steps at most)
  let inset = size * 0.35
  let marks = at(inset)
  for (let i = 0; within && i < 8 && !marks.every((m) => m.every((p) => insideRect(p, within))); i++) {
    inset += size * 0.5
    marks = at(inset)
  }
  return marks
}
