import { appConfig } from '../config/appConfig'

// Single source of truth for ANNOTATED-LINE behaviour shared by BOTH drawing surfaces — the Lage
// map (MapLibre line layers) and the Plan whiteboard (SVG polylines). The two render with totally
// different primitives (GL symbol layers vs DOM/SVG), so they can't share the final draw calls; but
// everything ABOVE the renderer — the preset bundles, the repeated-marker spacing math, the vertex-
// handle cap — lives here so the two surfaces can never drift apart in feature or behaviour.
//
// (The dash geometry + the solid/dashed picker live alongside in ./draw; the post-draw style editor
// is the shared <DrawEditor>. Together those three modules ARE the unified line system.)

/** A line preset (Freihand / Messpfeil / Rettungsachse) is a bundle of style fields seeded on a new
 *  line + re-applied from the editor. Each field stays editable afterwards. */
export interface LinePresetFields {
  arrow?: boolean
  marker?: string
  showDistance?: boolean
  dashed?: boolean
  color?: string
}

/** Look up a preset by id (defaults to the first = Freihand if unknown). */
export function getLinePreset(id: string) {
  const presets = appConfig.drawing.linePresets
  return presets.find((p) => p.id === id) ?? presets[0]
}

/** The style patch a preset applies — the SAME bundle on both surfaces (the Plan simply doesn't
 *  RENDER `showDistance`, since a building plan has no metric scale; the flag is still carried so the
 *  data model and preset-inference stay identical). Empty flags coerce to `undefined` so switching
 *  back to Freihand cleanly REMOVES a previous preset's arrow/marker/distance (rather than persisting
 *  `false`/`''` noise into the synced blob); `dashed` falls back to the line's current value when the
 *  preset doesn't own it (Freihand keeps whatever dash the line/dock had). Both surfaces — the map
 *  (useMapDrawing) and the plan (Whiteboard) — apply this ONE bundle, so they can't drift. */
export function resolveLinePreset(id: string, currentDashed?: boolean): LinePresetFields {
  const p = getLinePreset(id).defaults
  return {
    arrow: p.arrow || undefined,
    marker: p.marker || undefined,
    showDistance: p.showDistance || undefined,
    dashed: p.dashed ?? currentDashed,
  }
}

/** Repeated inline marker (e.g. —R— on a Rettungsachse): how far apart, in screen/board px, the
 *  letters are dropped along the polyline. Identical rhythm on both surfaces. */
export const MARKER_SPACING_PX = 46

/** Above this vertex count, per-node edit handles are suppressed (a dense freehand stroke has too
 *  many points to grab) — the stroke is still movable/deletable as a whole. Shared so the map and
 *  the plan cut over at the same size. */
export const MAX_VERTEX_HANDLES = 28

/** Walk a polyline given in PIXEL space and return a parametric position `{seg, t}` every
 *  `spacing` px (seg = segment start index, t = 0..1 along it). The caller lerps its OWN coordinate
 *  list by `{seg, t}` — so the map feeds projected screen px and back-projects to lng/lat, while the
 *  plan feeds board px and lerps normalized board coords. One algorithm, both surfaces. */
export function markerParamsAlong(px: [number, number][], spacing = MARKER_SPACING_PX): { seg: number; t: number }[] {
  const out: { seg: number; t: number }[] = []
  let carry = spacing / 2 // start half a step in, so letters don't pile on the first vertex
  for (let i = 1; i < px.length; i++) {
    const [ax, ay] = px[i - 1], [bx, by] = px[i]
    const segLen = Math.hypot(bx - ax, by - ay)
    if (segLen < 1e-3) continue
    while (carry <= segLen) { out.push({ seg: i - 1, t: carry / segLen }); carry += spacing }
    carry -= segLen
  }
  return out
}

/** Lerp between two same-length coordinate tuples by `t` (used to turn a `{seg, t}` back into a
 *  point in whichever space the caller's coords live in). */
export function lerpPoint<T extends number[]>(a: T, b: T, t: number): T {
  return a.map((v, i) => v + (b[i] - v) * t) as T
}

/** Ramer–Douglas–Peucker: indices of the points to KEEP (always first + last) so the polyline stays
 *  within `epsilon` of the original. Used to thin a raw freehand stroke — which captures one point
 *  per pointer event, piling up clusters wherever the finger paused (typically the start/end) — into
 *  a clean, editable handful of nodes. `pts` + `epsilon` are in the SAME space (feed pixels). */
export function rdpIndices(pts: [number, number][], epsilon: number): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i)
  const keep = new Array(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const [ax, ay] = pts[s], [bx, by] = pts[e]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1e-12
    let maxD = 0, idx = -1
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i]
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > epsilon && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]) }
  }
  const out: number[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i)
  return out
}

/** px tolerance for freehand simplification — how far the thinned line may stray from the raw stroke
 *  (≈ this many screen px). Tuned so a hand-drawn line keeps its shape but lands a editable node count. */
export const FREEHAND_SIMPLIFY_PX = 3.5

/** The point `dist` px back from the END of a pixel polyline — used to derive a STABLE arrowhead
 *  bearing. The final captured segment of a freehand stroke is tiny and jittery, so pointing the
 *  arrow along just the last segment makes it wobble/skew; sampling a fixed distance back gives the
 *  stroke's actual approach direction. Falls back to the first point for a very short line. */
export function lookbackPoint(px: [number, number][], dist: number): [number, number] {
  let acc = 0
  for (let i = px.length - 1; i > 0; i--) {
    const a = px[i], b = px[i - 1]
    const seg = Math.hypot(a[0] - b[0], a[1] - b[1])
    if (acc + seg >= dist) { const t = (dist - acc) / seg; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }
    acc += seg
  }
  return px[0]
}
