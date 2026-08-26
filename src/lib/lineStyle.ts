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

/** How far past an open end the «Verlängern» arrow tip sits — and therefore how far ONE tap on it
 *  grows the line. Screen px on the map, board px on the plan; both surfaces read this one number. */
export const EXTEND_STEP_PX = 46

/** How many node handles a shape may show AT ONCE. Not a limit on how many points a line may
 *  have — a 66-point freehand stroke keeps all 66 — but on how many pads are on screen competing
 *  for the same finger. Shared so the map and the plan cut over at the same size. */
export const MAX_VERTEX_HANDLES = 28

/** Minimum screen (map) / board (plan) px between two shown handles. Two pads closer than this
 *  cannot be told apart with a glove on, so the denser one is not offered. */
export const HANDLE_MIN_SPACING_PX = 26

/** `count` indices spread evenly over `n` points, both ends always included. The fallback for
 *  when there is no pixel geometry to measure against yet (the map still initialising). */
export function evenIndices(n: number, count = MAX_VERTEX_HANDLES): number[] {
  if (n <= 0) return []
  if (n <= count || count < 2) return Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  for (let k = 0; k < count; k++) {
    const i = Math.round((k * (n - 1)) / (count - 1))
    if (out[out.length - 1] !== i) out.push(i)
  }
  return out
}

/**
 * Which vertices of a polyline get an on-canvas edit handle, given the path in PIXEL space
 * (projected screen px on the map, board px on the plan).
 *
 * ⚠️ Until 25.08. a line above `MAX_VERTEX_HANDLES` points showed NO handles at all — a 66-point
 * freehand «Zeichnung» could be moved, rotated and deleted, but not reshaped, and nothing on
 * screen said why. That is the wrong end of the trade: the cap exists because pads pile up on
 * each other, not because the operator stopped needing the line.
 *
 * So the cap degrades instead of switching off. Handles are thinned by SCREEN distance — a node
 * closer than `minSpacingPx` to the last one shown is skipped — and the survivors are capped at
 * `budget`. Both ends always keep a handle. Because the spacing is measured in the CURRENT
 * projection, zooming in spreads the nodes apart and more of them earn a pad, until at close
 * range every point is grabbable again; zooming out collapses them back. That is the same
 * bargain the map already makes with labels: show what can be aimed at, here and now.
 *
 * Returns indices into `px`, ascending. `px.length <= budget` short-circuits to all of them, so
 * an ordinary node line is untouched by any of this.
 */
export function vertexHandleIndices(px: [number, number][], budget = MAX_VERTEX_HANDLES, minSpacingPx = HANDLE_MIN_SPACING_PX): number[] {
  const n = px.length
  if (n <= budget || budget < 2) return Array.from({ length: n }, (_, i) => i)
  const keep: number[] = [0]
  for (let i = 1; i < n - 1; i++) {
    const [ax, ay] = px[keep[keep.length - 1]]
    if (Math.hypot(px[i][0] - ax, px[i][1] - ay) >= minSpacingPx) keep.push(i)
  }
  keep.push(n - 1)
  if (keep.length <= budget) return keep
  // still too dense (a long line at low zoom): thin the survivors evenly, ends included
  return evenIndices(keep.length, budget).map((k) => keep[k])
}

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

/**
 * ── Abheben ist der Rückzieher ────────────────────────────────────────────────────────────────
 * How far a freehand stroke must actually travel from where it started, in screen (map) / board
 * (plan) px, before it counts as a LINE rather than a tap.
 *
 * ⚠️ This is the ONLY way out of a stroke that began on a target. Since the snapping model of
 * 25.08. a pointerdown inside a target's radius arms the start attachment INSTANTLY (the aim is
 * deliberate — see lineAttachments · armDwell), and from there any movement draws. So lifting off
 * has to be the cancel, and it has to leave nothing at all behind: no line, no attachment, no
 * Verlauf row. 12 px sits just above the 8–10 px the two surfaces already treat as «did not move».
 */
export const MIN_STROKE_PX = 12

/** Was that a tap rather than a stroke? Measured as the greatest distance the path ever reached
 *  from its own first point — a finger that wobbled in place has travelled some total distance but
 *  has been nowhere. `px` is the RAW stroke in pixel space. */
export function isTapStroke(px: [number, number][], minPx = MIN_STROKE_PX): boolean {
  if (px.length < 2) return true
  const [x0, y0] = px[0]
  for (let i = 1; i < px.length; i++) if (Math.hypot(px[i][0] - x0, px[i][1] - y0) >= minPx) return false
  return true
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

/**
 * How far the action hub of a SELECTED line sits OFF its own path, in screen (map) / board (plan)
 * px. 42 = the move grip's hit pad (40px ⇒ 20) plus a node handle's (44px ⇒ 22): at exactly this
 * distance the two stop competing for the same finger.
 */
export const HUB_OFFSET_PX = 42

/**
 * Screen-px offset `[dx, dy]` that lifts a selected line's action hub — the move grip, the rotate
 * knob above it and the red ✕ beside it — clear of the path it belongs to.
 *
 * ⚠️ The hub used to sit exactly ON the centroid (25.08.), which for a line is a point on or beside
 * the line itself: the move grip covered a vertex node, so the node under it could neither be seen
 * nor grabbed. An area or a circle has an interior and needs none of this — only a line does.
 *
 * The offset is PERPENDICULAR to the segment nearest `at`, on whichever side points up the screen
 * (a tie — a vertical line — goes right). Up, because the hub's own furniture already grows upward
 * (stem + knob) and to the upper right (✕): pushing the cluster the way it already leans keeps it
 * one shape instead of two.
 */
export function hubOffsetPx(px: [number, number][], at: [number, number], distPx = HUB_OFFSET_PX): [number, number] {
  if (px.length < 2) return [0, -distPx]
  let best = 0, bestD = Infinity
  for (let i = 1; i < px.length; i++) {
    const [ax, ay] = px[i - 1], [bx, by] = px[i]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1e-12
    const t = Math.max(0, Math.min(1, ((at[0] - ax) * dx + (at[1] - ay) * dy) / len2))
    const d = Math.hypot(at[0] - (ax + t * dx), at[1] - (ay + t * dy))
    if (d < bestD) { bestD = d; best = i }
  }
  const [ax, ay] = px[best - 1], [bx, by] = px[best]
  const len = Math.hypot(bx - ax, by - ay) || 1
  // the two unit normals of that segment; take the one that points up the screen (y grows down)
  const nx = (by - ay) / len, ny = -(bx - ax) / len
  const up = ny < 0 || (ny === 0 && nx > 0) ? [nx, ny] : [-nx, -ny]
  return [up[0] * distPx, up[1] * distPx]
}
