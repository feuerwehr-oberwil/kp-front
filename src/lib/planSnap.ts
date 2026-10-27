// Where a point of a Grundriss drawing lands on the Gebäude stack (27.10.2026, owner's pick on the
// range.html prototype): a ring and nothing else – no text, no guide lines. Pure, in board px of
// ONE storey; the Plan's draft machine (components/usePlanDraft · snapAt, snapWallVertex) gathers
// the targets and converts in and out of the stored tile coordinates.
//
// - Wand: a point lands on what is near it – a corner or end first, then the nearest edge of a
//   Wand, a Fläche or the building outline. A target always wins over the angle. With nothing in
//   reach, a point near a right angle from its neighbour (horizontal / vertical, along or across
//   the piece before it, within ANGLE_TOL_DEG) locks onto it, and where that line crosses an edge
//   in reach it lands on the crossing. Otherwise it stays where it was tapped (owner, round 2:
//   «prefer 90° and snapping, but allow other angles»).
// - Linie (a Leitung in Punkte mode): onto the centre of a Durchgang / Treppe – that is how a hose
//   is laid through doors and up the stairs. Nothing else pulls it.
// - Wand: the last point again finishes, the first point of a Wand with ≥3 points closes it.
// - Dragging a Wand's corner (open or finished) lands by the same rule, against both of its
//   neighbours (snapWall with two anchors).
// - Moving Wände whole shifts the move rigidly so their nearest corner lands on a target (snapMove).

/** a board-px point of one storey */
export type Pt = readonly [number, number]
export type Seg = readonly [Pt, Pt]

/** which drawing the point belongs to: a Wand, or a plain Punkte-Linie */
export type SnapMode = 'wand' | 'line'

/** what can pull a point on this storey */
export interface SnapTargets {
  /** edges of the Wände and Flächen, the open draft's own pieces and the outline */
  segs: readonly Seg[]
  /** their corners and ends */
  ends: readonly Pt[]
  /** centres of the Durchgang / Treppe symbols */
  centres: readonly Pt[]
}

export interface SnapResult {
  p: [number, number]
  /** a target pulled the point – the pink ring; otherwise the grey dot (an angle lock alone too) */
  snapped: boolean
  /** the tap was on the draft's last point: finish the drawing */
  finish?: boolean
  /** the tap was on the first point of a Wand with ≥3 points: close it */
  close?: boolean
}

/** A neighbour a Wand point is laid from: the point itself, and the one before it on that side
 *  (which gives the piece whose direction counts as «straight on» and «across»). */
export interface Anchor { from: Pt; before?: Pt }

/** the default pull radius in screen px (= board px: the board's size carries the zoom) */
export const SNAP_RADIUS_PX = 14
/** how close to a right angle a Wand piece has to run to lock onto it (owner: ≈ 8–10°) */
export const ANGLE_TOL_DEG = 9
/** the last point counts as «tapped again» a little wider than the pull – a finger is no cursor */
const FINISH_FACTOR = 1.7
/** …and the first point closes a Wand from a little further than the pull too */
const CLOSE_FACTOR = 1.5
/** below this a piece has no direction to measure an angle from (board px) */
const MIN_RUN = 4

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** the nearest point on segment a–b */
export function nearestOnSeg(p: Pt, [a, b]: Seg): { p: [number, number]; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  const q: [number, number] = [a[0] + t * dx, a[1] + t * dy]
  return { p: q, d: dist(p, q) }
}

/** the nearest of `pts` within `r`, or null */
const nearestPoint = (p: Pt, pts: readonly Pt[], r: number): Pt | null => {
  let best: Pt | null = null, bd = r
  for (const c of pts) { const d = dist(p, c); if (d < bd) { bd = d; best = c } }
  return best
}

/** an end within `r`, else the nearest point on a segment within `r`, else null */
const pullTarget = (p: Pt, t: SnapTargets, r: number): [number, number] | null => {
  const e = nearestPoint(p, t.ends, r)
  if (e) return [e[0], e[1]]
  let best: { p: [number, number]; d: number } | null = null
  for (const s of t.segs) { const n = nearestOnSeg(p, s); if (n.d < r && (!best || n.d < best.d)) best = n }
  return best ? best.p : null
}

/** a line through `o` along the unit vector `u` */
interface Ray { o: Pt; u: readonly [number, number] }

/** The right-angle line from `a` that `at` runs along within ANGLE_TOL_DEG – horizontal,
 *  vertical, or along / across the piece before it – with how far off it is (radians), or null. */
const angleLine = (at: Pt, a: Anchor): (Ray & { err: number }) | null => {
  if (dist(at, a.from) < MIN_RUN) return null
  const phi = Math.atan2(at[1] - a.from[1], at[0] - a.from[0])
  const bases = [0]
  if (a.before && dist(a.before, a.from) >= MIN_RUN) bases.push(Math.atan2(a.from[1] - a.before[1], a.from[0] - a.before[0]))
  let best: (Ray & { err: number }) | null = null
  for (const base of bases) {
    for (const k of [0, 1]) {
      const th = base + (k * Math.PI) / 2
      // a line has no direction: compare modulo 180°
      let d = (phi - th) % Math.PI
      if (d > Math.PI / 2) d -= Math.PI
      if (d < -Math.PI / 2) d += Math.PI
      const err = Math.abs(d)
      if (err <= (ANGLE_TOL_DEG * Math.PI) / 180 && (!best || err < best.err)) best = { o: a.from, u: [Math.cos(th), Math.sin(th)], err }
    }
  }
  return best
}

/** `p` projected onto the ray's line */
const onRay = (p: Pt, { o, u }: Ray): [number, number] => {
  const t = (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1]
  return [o[0] + t * u[0], o[1] + t * u[1]]
}

/** where the ray's line crosses segment a–b, or null (parallel, or past its ends) */
const crossSeg = ({ o, u }: Ray, [a, b]: Seg): [number, number] | null => {
  const ex = b[0] - a[0], ey = b[1] - a[1]
  const den = ex * u[1] - ey * u[0]
  if (Math.abs(den) < 1e-9) return null
  const s = ((o[0] - a[0]) * u[1] - (o[1] - a[1]) * u[0]) / den
  if (s < -1e-9 || s > 1 + 1e-9) return null
  return [a[0] + s * ex, a[1] + s * ey]
}

/** where two rays' lines meet, or null when they run parallel */
const crossRays = (r1: Ray, r2: Ray): [number, number] | null => {
  const den = r1.u[0] * r2.u[1] - r1.u[1] * r2.u[0]
  if (Math.abs(den) < 1e-9) return null
  const t = ((r2.o[0] - r1.o[0]) * r2.u[1] - (r2.o[1] - r1.o[1]) * r2.u[0]) / den
  return [r1.o[0] + t * r1.u[0], r1.o[1] + t * r1.u[1]]
}

/**
 * Where a Wand point at `at` lands, laid from `anchors` (none for a first point, one while
 * drawing, two for a corner dragged between its neighbours): see the file header for the order.
 */
export function snapWall(at: Pt, { anchors, targets, radius = SNAP_RADIUS_PX }: {
  anchors: readonly Anchor[]
  targets: SnapTargets
  radius?: number
}): { p: [number, number]; snapped: boolean } {
  const e = nearestPoint(at, targets.ends, radius)
  if (e) return { p: [e[0], e[1]], snapped: true }
  const lines = anchors.map((a) => angleLine(at, a)).filter((l) => l != null).sort((a, b) => a.err - b.err)
  // the right angle AND an edge: where the locked line crosses an edge within the pull
  let cross: [number, number] | null = null, cd = radius
  for (const l of lines) {
    for (const s of targets.segs) {
      const c = crossSeg(l, s)
      if (c && dist(c, at) < cd) { cd = dist(c, at); cross = c }
    }
  }
  if (cross) return { p: cross, snapped: true }
  const t = pullTarget(at, { ...targets, ends: [] }, radius)
  if (t) return { p: t, snapped: true }
  if (!lines.length) return { p: [at[0], at[1]], snapped: false }
  // a corner between two neighbours that both lock: where their lines meet, if it is near
  if (lines.length > 1 && lines[0].o !== lines[1].o) {
    const c = crossRays(lines[0], lines[1])
    if (c && dist(c, at) < radius) return { p: c, snapped: false }
  }
  return { p: onRay(at, lines[0]), snapped: false }
}

/**
 * Where a tap at `at` lands. `draft` is the open drawing's points on this storey (board px), in
 * order; `radius` the pull in board px.
 */
export function snapPoint(at: Pt, { mode, draft, targets, radius = SNAP_RADIUS_PX }: {
  mode: SnapMode
  draft: readonly Pt[]
  targets: SnapTargets
  radius?: number
}): SnapResult {
  if (mode === 'line') {
    const c = nearestPoint(at, targets.centres, radius)
    return c ? { p: [c[0], c[1]], snapped: true } : { p: [at[0], at[1]], snapped: false }
  }
  const last = draft[draft.length - 1]
  if (last && dist(at, last) < radius * FINISH_FACTOR) return { p: [last[0], last[1]], snapped: true, finish: true }
  const first = draft[0]
  if (draft.length >= 3 && dist(at, first) < radius * CLOSE_FACTOR) return { p: [first[0], first[1]], snapped: true, close: true }
  return snapWall(at, { anchors: last ? [{ from: last, before: draft[draft.length - 2] }] : [], targets, radius })
}

/**
 * `c` goes straight back along the piece a → b. Drawing it would lay the wall over itself, so the
 * Wand ends that piece and starts the next one at `c` instead (owner, 27.10.2026: «ugly
 * overlapping dashes»).
 */
export function backtracks(a: Pt, b: Pt, c: Pt): boolean {
  const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
  const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
  const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])
  // the sine of the turn below ~0.6° – a point locked onto the piece's own line is exact
  return scale > 0 && Math.abs(cross) < 0.01 * scale && dot < 0
}

/** the segments of a polyline (a ring when `closed`) */
export function segsOf(pts: readonly Pt[], closed = false): Seg[] {
  const out: Seg[] = []
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]])
  if (closed && pts.length >= 3) out.push([pts[pts.length - 1], pts[0]])
  return out
}

/**
 * A rigid move of Wände (round 3, 27.10.2026: «I can't just move it somewhere else and it doesn't
 * snap back»): `moved` are the moved Wand corners and ends where the move would put them. The
 * shift that lands one of them exactly on a target – a corner or end first, else an edge, the
 * closest of either kind, as a drawn point lands – and that target point (the ring), or null when
 * nothing is in reach. The caller adds the shift to the whole move (components/useWbBodyDrag,
 * useWbSelectionBar via usePlanDraft · snapMove).
 */
export function snapMove(moved: readonly Pt[], targets: Pick<SnapTargets, 'segs' | 'ends'>, radius = SNAP_RADIUS_PX): { d: [number, number]; at: [number, number] } | null {
  let end: { from: Pt; to: Pt; d: number } | null = null
  let edge: { from: Pt; to: Pt; d: number } | null = null
  for (const p of moved) {
    for (const c of targets.ends) { const d = dist(p, c); if (d < radius && (!end || d < end.d)) end = { from: p, to: c, d } }
    if (end) continue // an end anywhere beats every edge, so stop measuring edges
    for (const s of targets.segs) { const n = nearestOnSeg(p, s); if (n.d < radius && (!edge || n.d < edge.d)) edge = { from: p, to: n.p, d: n.d } }
  }
  const hit = end ?? edge
  return hit ? { d: [hit.to[0] - hit.from[0], hit.to[1] - hit.from[1]], at: [hit.to[0], hit.to[1]] } : null
}
