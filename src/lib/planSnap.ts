// Where a tapped point of a Grundriss drawing lands on the Gebäude stack (27.10.2026, owner's pick
// on the range.html prototype): a ring and nothing else – no text, no guide lines. Pure, in board
// px of ONE storey; the Plan's draft machine (components/usePlanDraft · snapAt) gathers the targets
// and converts in and out of the stored tile coordinates.
//
// - Wand / Raum: every point after the first runs straight or at a right angle from the last one
//   (horizontal or vertical in tile space), then its free coordinate catches a crossing wall, a
//   collinear wall end or the building outline.
// - Weg: free, onto wall ends, wall segments and the centre of a Durchgang / Treppe.
// - Linie (a Leitung in Punkte mode): onto the centre of a Durchgang / Treppe – that is how a hose
//   is laid through doors and up the stairs. Nothing else pulls it.
// - Wand / Weg / Raum: the last point again finishes, the first point of a Wand / Raum with ≥3
//   points closes it.

/** a board-px point of one storey */
export type Pt = readonly [number, number]
export type Seg = readonly [Pt, Pt]

/** which drawing the point belongs to: a Grundriss preset, or a plain Punkte-Linie */
export type SnapMode = 'wand' | 'weg' | 'raum' | 'line'

/** what can pull a point on this storey */
export interface SnapTargets {
  /** segments of the Wand / Weg / Raum drawings, the open draft's own pieces and the outline */
  segs: readonly Seg[]
  /** their corners and ends */
  ends: readonly Pt[]
  /** centres of the Durchgang / Treppe symbols */
  centres: readonly Pt[]
}

export interface SnapResult {
  p: [number, number]
  /** a target pulled the point – the pink ring; otherwise the grey dot */
  snapped: boolean
  /** the tap was on the draft's last point: finish the drawing */
  finish?: boolean
  /** the tap was on the first point of a Wand / Raum with ≥3 points: close it */
  close?: boolean
}

/** the default pull radius in screen px (= board px: the board's size carries the zoom) */
export const SNAP_RADIUS_PX = 14
/** the last point counts as «tapped again» a little wider than the pull – a finger is no cursor */
const FINISH_FACTOR = 1.7
/** …and the first point closes a Wand / Raum from a little further than the pull too */
const CLOSE_FACTOR = 1.5
/** coordinates closer than this are «the same line» (board px) */
const EPS = 0.5

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

/** a free point's pull: an end first (a corner is what you aim at), then the nearest segment */
const pullFree = (p: Pt, t: SnapTargets, r: number, centres: boolean): SnapResult => {
  if (centres) { const c = nearestPoint(p, t.centres, r); if (c) return { p: [c[0], c[1]], snapped: true } }
  const e = nearestPoint(p, t.ends, r)
  if (e) return { p: [e[0], e[1]], snapped: true }
  let best: { p: [number, number]; d: number } | null = null
  for (const s of t.segs) { const n = nearestOnSeg(p, s); if (n.d < r && (!best || n.d < best.d)) best = n }
  return best ? { p: best.p, snapped: true } : { p: [p[0], p[1]], snapped: false }
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
  const last = draft[draft.length - 1]
  if (mode === 'line') return pullFree(at, { segs: [], ends: [], centres: targets.centres }, radius, true)
  if (last && dist(at, last) < radius * FINISH_FACTOR) return { p: [last[0], last[1]], snapped: true, finish: true }
  const first = draft[0]
  if ((mode === 'wand' || mode === 'raum') && draft.length >= 3 && dist(at, first) < radius * CLOSE_FACTOR) {
    return { p: [first[0], first[1]], snapped: true, close: true }
  }
  if (!last || mode === 'weg') return pullFree(at, targets, radius, mode === 'weg')
  // Wand / Raum: the piece runs along the axis the pointer is further out on (f); the other (g)
  // is the last point's. Along f, the point may still catch something within the pull.
  const f = Math.abs(at[0] - last[0]) >= Math.abs(at[1] - last[1]) ? 0 : 1, g = 1 - f
  const q: [number, number] = f === 0 ? [at[0], last[1]] : [last[0], at[1]]
  // candidates for the free coordinate: where a segment crosses the axis line (an outline need
  // not be axis-aligned), and the ends that stand on that same line
  const vs: number[] = []
  for (const [a, b] of targets.segs) {
    if (Math.abs(a[g] - b[g]) < EPS) continue // parallel to the piece: nothing to cross
    if (q[g] < Math.min(a[g], b[g]) - EPS || q[g] > Math.max(a[g], b[g]) + EPS) continue
    vs.push(a[f] + ((q[g] - a[g]) / (b[g] - a[g])) * (b[f] - a[f]))
  }
  for (const c of targets.ends) if (Math.abs(c[g] - q[g]) < EPS) vs.push(c[f])
  let bestV: number | null = null, bestE = radius
  for (const v of vs) { const e = Math.abs(v - q[f]); if (e < bestE) { bestE = e; bestV = v } }
  if (bestV == null) return { p: q, snapped: false }
  q[f] = bestV
  return { p: q, snapped: true }
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
  // the sine of the turn below ~0.6° – a Wand point is axis-locked, so this is exact in practice
  return scale > 0 && Math.abs(cross) < 0.01 * scale && dot < 0
}

/** the segments of a polyline (a ring when `closed`) */
export function segsOf(pts: readonly Pt[], closed = false): Seg[] {
  const out: Seg[] = []
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]])
  if (closed && pts.length >= 3) out.push([pts[pts.length - 1], pts[0]])
  return out
}
