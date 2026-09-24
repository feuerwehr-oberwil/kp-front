/**
 * The Gebäude stack's storey SECTION, and what a stroke looks like cut to it (24.09.2026).
 *
 * A storey tile shows its Geschossplan through a window: each drawing's own region on its page
 * (components/FloorPage · the region clip), inside the footprint box the tile's SVG clips at. The
 * ink was drawn in ONE layer across the whole board, so a stroke that left that window carried on
 * through the blank band between the storeys and into the neighbouring tile — a Karte hose from
 * the street, projected onto the 1. OG, ended inside the EG's plan (field report 24.09.2026).
 *
 * The rule: what lies outside the section is not drawn, and where a stroke crosses the section's
 * edge an EDGE MARK stands on the crossing — a white disc, ringed in the stroke's colour, with an
 * arrowhead pointing the way the stroke leaves. The disc is map furniture, so it is round
 * (AGENTS.md · buttons); it wears the stroke's colour because it is part of that line, not chrome,
 * and the stair mark's white plate because it says the same kind of thing: «goes on elsewhere».
 *
 * A section is a UNION of convex polygons: a storey drawn as two wings is two windows, and a
 * stroke passing from one wing into the other across their shared edge does NOT leave the
 * section there (the spans merge). A storey without a plan is its whole tile.
 *
 * Everything here is pure geometry in whatever frame the caller hands in; screen callers use
 * board px, the printed stack uses the page in isotropic units. Directions are only meaningful
 * in an isotropic frame, so a caller working in normalized page space scales first.
 */

export type Pt = [number, number]
/** convex polygons whose union is the visible section */
export type Section = Pt[][]

/** A stroke leaving (or entering) the section: where it crosses the edge, and the unit vector
 *  along the stroke that points OUT of the section at that spot. */
export interface EdgeMark {
  at: Pt
  dir: Pt
}

export interface ClippedStroke {
  /** the parts of the stroke inside the section, in order */
  runs: Pt[][]
  /** one per crossing of the section's edge */
  marks: EdgeMark[]
  /** true when anything at all was cut away */
  cut: boolean
}

const EPS = 1e-9
const T_EPS = 1e-7

export const rectPoly = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const unit = (dx: number, dy: number): Pt => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] }

/** +1 for a counter-clockwise polygon in a y-up frame (clockwise on screen), −1 the other way,
 *  0 for a degenerate one — the clip tests below are orientation-agnostic through it */
function orientation(poly: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) < EPS ? 0 : Math.sign(s)
}

/**
 * Sutherland–Hodgman: `subject` (any simple polygon) cut to the CONVEX `clip`. Empty when
 * nothing of it is left. A concave subject may come back with a zero-width seam where two of
 * its lobes meet the edge — harmless for a fill and for a centroid.
 */
export function clipConvex(subject: readonly Pt[], clip: readonly Pt[]): Pt[] {
  const s = orientation(clip)
  if (!s || subject.length < 3) return []
  let out: Pt[] = [...subject]
  for (let i = 0; i < clip.length && out.length; i++) {
    const c1 = clip[i], c2 = clip[(i + 1) % clip.length]
    const inside = (p: Pt) => s * cross(c1, c2, p) >= -EPS
    const hit = (p: Pt, q: Pt): Pt => {
      const dp = s * cross(c1, c2, p), dq = s * cross(c1, c2, q)
      return lerp(p, q, dp / (dp - dq))
    }
    const input = out
    out = []
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(hit(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(hit(prev, cur))
    }
  }
  return out.length >= 3 ? out : []
}

/** Cyrus–Beck: the parameter span [t0, t1] of a→b that lies inside the convex `poly`, or null.
 *  A segment that only touches the polygon (a single point) is outside. */
export function segmentSpan(a: Pt, b: Pt, poly: readonly Pt[]): [number, number] | null {
  const s = orientation(poly)
  if (!s) return null
  const d: Pt = [b[0] - a[0], b[1] - a[1]]
  let t0 = 0, t1 = 1
  for (let i = 0; i < poly.length; i++) {
    const c1 = poly[i], c2 = poly[(i + 1) % poly.length]
    // inside ⇔ s · cross(c1, c2, a + t·d) ≥ 0, which is linear in t
    const num = s * cross(c1, c2, a)
    const den = s * ((c2[0] - c1[0]) * d[1] - (c2[1] - c1[1]) * d[0])
    if (Math.abs(den) < EPS) {
      if (num < -EPS) return null // parallel to this edge and outside it
      continue
    }
    const t = -num / den
    if (den > 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return null
  }
  return t1 - t0 > T_EPS ? [t0, t1] : null
}

/** Is `p` inside the section (edges included)? */
export function inSection(p: Pt, section: Section): boolean {
  return section.some((poly) => {
    const s = orientation(poly)
    if (!s) return false
    for (let i = 0; i < poly.length; i++) if (s * cross(poly[i], poly[(i + 1) % poly.length], p) < -EPS) return false
    return true
  })
}

/** the spans of a→b inside the union, sorted and merged — two wings sharing an edge are one */
function unionSpans(a: Pt, b: Pt, section: Section): [number, number][] {
  const spans = section.flatMap((poly) => { const s = segmentSpan(a, b, poly); return s ? [s] : [] }).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s[0] <= last[1] + T_EPS) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/**
 * A stroke cut to the section: the visible runs, and an edge mark at every crossing.
 *
 * `closed` treats the points as a ring (a Fläche's outline, an Absperrkreis sampled as a
 * polygon): the closing segment is walked too, and a run that wraps past the first vertex is
 * joined into one.
 */
export function clipStroke(pts: readonly Pt[], section: Section, closed = false): ClippedStroke {
  if (!pts.length) return { runs: [], marks: [], cut: false }
  if (pts.length === 1) {
    const inside = inSection(pts[0], section)
    return { runs: inside ? [[pts[0]]] : [], marks: [], cut: !inside }
  }
  const P = closed ? [...pts, pts[0]] : [...pts]
  const runs: Pt[][] = []
  const marks: EdgeMark[] = []
  let cur: Pt[] | null = null
  let cut = false
  let startsInside = false
  // the start of the last segment that had a length — where «back along the stroke» points
  let prev: Pt | null = null
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1]
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) continue
    const fwd = unit(b[0] - a[0], b[1] - a[1])
    const spans = unionSpans(a, b, section)
    if (!(spans.length === 1 && spans[0][0] <= T_EPS && spans[0][1] >= 1 - T_EPS)) cut = true
    // inside up to this vertex, and the stroke leaves right AT it
    if (cur && (!spans.length || spans[0][0] > T_EPS)) {
      runs.push(cur); cur = null
      marks.push({ at: a, dir: fwd })
    }
    for (const [t0, t1] of spans) {
      if (!cur) {
        const p0 = lerp(a, b, t0)
        cur = [p0]
        if (t0 > T_EPS) marks.push({ at: p0, dir: [-fwd[0], -fwd[1]] })
        else if (prev) marks.push({ at: a, dir: unit(prev[0] - a[0], prev[1] - a[1]) }) // re-entry exactly at a vertex
        else startsInside = true
      }
      if (t1 < 1 - T_EPS) {
        const p1 = lerp(a, b, t1)
        cur.push(p1); runs.push(cur); cur = null
        marks.push({ at: p1, dir: fwd })
      } else cur.push(b)
    }
    prev = a
  }
  if (cur) runs.push(cur)
  // a ring that starts inside and ends inside is ONE run across its first vertex
  if (closed && startsInside && runs.length > 1) {
    const last = runs[runs.length - 1], first = runs[0]
    const end = last[last.length - 1]
    if (Math.hypot(end[0] - P[0][0], end[1] - P[0][1]) < 1e-6) {
      runs[0] = [...last, ...first.slice(1)]
      runs.pop()
    }
  }
  return { runs, marks, cut }
}

/**
 * Where a Fläche's label stands once the Fläche is cut: its own centre where that is on the
 * section, else the middle of the largest piece that is left — null when nothing of it shows.
 */
export function visibleCentre(pts: readonly Pt[], section: Section): Pt | null {
  if (!pts.length) return null
  const c: Pt = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
  if (inSection(c, section)) return c
  let best: Pt[] | null = null, bestArea = 0
  for (const poly of section) {
    const piece = clipConvex(pts, poly)
    let a = 0
    for (let i = 0; i < piece.length; i++) { const p = piece[i], q = piece[(i + 1) % piece.length]; a += p[0] * q[1] - q[0] * p[1] }
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = piece }
  }
  if (!best || bestArea < EPS) return null
  return [best.reduce((s, p) => s + p[0], 0) / best.length, best.reduce((s, p) => s + p[1], 0) / best.length]
}

/** Drop marks standing within `minGap` of one already kept — a freehand stroke that wanders
 *  along the edge would otherwise wear a row of discs. */
export function thinMarks(marks: readonly EdgeMark[], minGap: number): EdgeMark[] {
  const kept: EdgeMark[] = []
  for (const m of marks) if (!kept.some((k) => Math.hypot(k.at[0] - m.at[0], k.at[1] - m.at[1]) < minGap)) kept.push(m)
  return kept
}

/** An Absperrkreis's ring as a polygon, for the crossings (never for drawing — the SVG circle is
 *  the drawing, clipped by the section). */
export function circleRing(cx: number, cy: number, r: number, n = 72): Pt[] {
  return Array.from({ length: n }, (_, i): Pt => {
    const t = (i / n) * Math.PI * 2
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r]
  })
}

/** the screen angle of a mark's direction, in degrees (0 = right, 90 = down) */
export const markDeg = (m: EdgeMark): number => (Math.atan2(m.dir[1], m.dir[0]) * 180) / Math.PI

/** The mark's head — a filled arrowhead pointing +x inside a disc of radius `r`, centred on the
 *  crossing. ONE geometry for the screen (components/WbControls · EdgeMarks) and the paper. */
export const edgeMarkHead = (r: number): string =>
  `M${(-r * 0.32).toFixed(2)},${(-r * 0.5).toFixed(2)} L${(r * 0.56).toFixed(2)},0 L${(-r * 0.32).toFixed(2)},${(r * 0.5).toFixed(2)} Z`

/** The same mark as a standalone SVG for the printed Gebäude (lib/reportPdfDirect · floorStackPages),
 *  already turned — the server places a glyph, it never has to know which way it points. White
 *  disc, ring and head in the stroke's colour, as on the screen. */
export function edgeMarkSvg(color: string, deg: number): string {
  const c = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#1f6feb'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 24 24" width="24" height="24">`
    + `<g transform="rotate(${deg.toFixed(1)})"><circle r="10" fill="#fff" stroke="${c}" stroke-width="2"/>`
    + `<path d="${edgeMarkHead(10)}" fill="${c}" stroke="${c}" stroke-width="1" stroke-linejoin="round"/></g></svg>`
}

/**
 * Each DRAWN storey's section on the board, in board px.
 *
 * `box` is the footprint box every tile centres (Whiteboard · fpBox), and `drawings(f)` the
 * storey's drawings as the tile lays them — each the region's (0,0), (1,0), (0,1) in the box's
 * own 0..1 space (lib/stackFit · regionCorners). A drawing is its quad cut to the box, because
 * the tile's SVG clips at the box too. A storey with no drawing — no Geschossplan, or a footprint
 * stack without a pack — is its whole tile, which is exactly where its ink could always go.
 */
export function storeySections(opts: {
  floorsTTB: readonly number[]
  sW: number
  sH: number
  box: { w: number; h: number } | null
  drawings: (floor: number) => readonly (readonly [Pt, Pt, Pt])[]
}): Map<number, Section> {
  const { floorsTTB, sW, sH, box } = opts
  const out = new Map<number, Section>()
  const N = floorsTTB.length
  if (!N || !(sW > 0) || !(sH > 0)) return out
  const tileH = sH / N
  floorsTTB.forEach((f, idx) => {
    const top = idx * tileH
    const tile = rectPoly(0, top, sW, top + tileH)
    const parts = box && box.w > 0 && box.h > 0 ? opts.drawings(f) : []
    if (!box || !parts.length) { out.set(f, [tile]); return }
    const bx = (sW - box.w) / 2, by = top + (tileH - box.h) / 2
    const px = ([u, v]: Pt): Pt => [bx + u * box.w, by + v * box.h]
    const boxPoly = rectPoly(bx, by, bx + box.w, by + box.h)
    const polys = parts.flatMap(([o, x, y]) => {
      const far: Pt = [x[0] + y[0] - o[0], x[1] + y[1] - o[1]]
      const quad: Pt[] = [o, x, far, y].map((p) => px([p[0], p[1]]))
      const cutQuad = clipConvex(quad, boxPoly)
      return cutQuad.length ? [cutQuad] : []
    })
    out.set(f, polys.length ? polys : [tile])
  })
  return out
}
