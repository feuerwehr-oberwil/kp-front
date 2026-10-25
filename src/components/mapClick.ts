import type { LngLat } from '../types'
import { pathSegmentCount } from '../lib/mapView'

/** A rendered feature under a click, as MapLibre reports it (`MapLayerMouseEvent.features`). */
export interface ClickFeature {
  layer?: { id?: string }
  properties?: Record<string, unknown> | null
  geometry?: { type?: string; coordinates?: unknown }
}

/** A path a click may insert a node into — `canInsert` = its writer is wired. */
interface InsertablePath { points: LngLat[]; isArea: boolean; canInsert: boolean }

/** What MapView knows at the moment of a map click (after its pan / hold guards). */
export interface MapClickInput {
  at: LngLat
  /** the click in map-container px */
  point: { x: number; y: number }
  features: readonly ClickFeature[]
  /** «Karte verknüpfen» owns every click (it places on pointer-up instead) */
  georefOn: boolean
  /** the coordinate picker is aiming */
  picking: boolean
  /** the live Messen path, while the tool is armed */
  measure: InsertablePath | null
  /** the SELECTED drawing being reshaped (node pads shown) */
  edit: (InsertablePath & { id: string }) | null
  /** the in-progress draft (area/line tool) */
  draft: InsertablePath | null
  /** a placement tool is armed — a click adds, it does not select */
  placing: boolean
  /** locked drawings are click-through (unlock via their LockChip) */
  lockedIds: ReadonlySet<string>
}

/** What a map click does — MapView runs the matching writer. */
export type MapClick =
  | { kind: 'none' }
  | { kind: 'pick'; at: LngLat }
  | { kind: 'measureInsert'; index: number; at: LngLat }
  | { kind: 'vertexInsert'; id: string; index: number; at: LngLat }
  | { kind: 'draftInsert'; index: number; at: LngLat }
  | { kind: 'selectDrawing'; id: string; at: { x: number; y: number } }
  /** the map's own click (place / add a point / deselect) — `at` before the Rotation magnet */
  | { kind: 'place'; at: LngLat }

/** A node tap this close to the draft's last node lands on that node's own 44px handle pad: it
 *  is the second tap of a double tap, not a corner (UX sweep M4 rework — with a tool armed a double
 *  tap no longer zooms, and its second tap arrives before the first node's handle is there to
 *  catch it, so it laid a zero-length segment). */
const NODE_REPEAT_PX = 22

// planar shoelace area (deg², relative only) of a clicked feature's outer ring; non-polygon
// (line) features return 0 so they stay the most specific pick when overlapping a fill.
export const featArea = (f: ClickFeature): number => {
  const g = f.geometry
  if (g?.type !== 'Polygon') return 0
  const ring = (g.coordinates as [number, number][][])?.[0]
  if (!ring || ring.length < 3) return 0
  let s = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % n]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

// which path segment a click landed on (pixel-space point→segment distance), so a
// click on the measure line/outline inserts a vertex there instead of appending.
// Returns the insert index (after the segment's start; closing edge → push at end).
export function segInsertIndex(project: (c: LngLat) => { x: number; y: number }, points: LngLat[], isArea: boolean, ll: LngLat): number | null {
  if (points.length < 2) return null
  const cp = project(ll)
  const px = points.map((p) => project(p))
  const n = px.length
  const segs = pathSegmentCount(n, isArea) // area: includes the closing edge
  let best = -1, bestD = Infinity
  for (let i = 0; i < segs; i++) {
    const a = px[i], b = px[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((cp.x - a.x) * dx + (cp.y - a.y) * dy) / len2))
    const d = Math.hypot(cp.x - (a.x + t * dx), cp.y - (a.y + t * dy))
    if (d < bestD) { bestD = d; best = i }
  }
  return best < 0 ? null : best + 1
}

/**
 * The Lage's click dispatcher: one map click → one action, first match wins. `project` is the
 * live map's (null before it is up — then nothing is inserted and no node repeat is caught).
 * The ordering rule the Plan mirrors (WbControls · WbCircleLayer) lives here.
 */
export function routeMapClick(c: MapClickInput, project: ((ll: LngLat) => { x: number; y: number }) | null): MapClick {
  // The pairing mode owns every click on the map while it runs — including the ones that come
  // too early. Placing a symbol mid-pairing would be a silent mis-hit on a surface the operator
  // is aiming at for something else entirely.
  // ⚠️ The pairing mode SWALLOWS the click and places nothing here. MapLibre emits `click`
  // whenever the pointer goes down and comes up within 3px of each other — which a pan that
  // returns to its starting point does — so the placement rides on pointer-up with a sticky
  // moved flag instead (see the georef handlers on MapView's <Map>). Swallowing still matters:
  // a mis-aimed reference tap must never drop a symbol on the Lage.
  if (c.georefOn) return { kind: 'none' }
  // picking takes precedence — lock the clicked coordinate, place nothing
  if (c.picking) return { kind: 'pick', at: c.at }
  const lc = c.at
  const hit = (layer: string) => c.features.some((f) => f.layer?.id === layer)
  const insertAt = (path: InsertablePath) => (project ? segInsertIndex(project, path.points, path.isArea, lc) : null)
  // clicking the measure path inserts a draggable vertex on that segment
  if (c.measure?.canInsert && hit('l-measure-hit')) {
    const idx = insertAt(c.measure)
    if (idx != null) return { kind: 'measureInsert', index: idx, at: lc }
  }
  // clicking the selected drawing's outline inserts a vertex there (reshape)
  if (c.edit?.canInsert && hit('l-draw-edit-hit')) {
    const idx = insertAt(c.edit)
    if (idx != null) return { kind: 'vertexInsert', id: c.edit.id, index: idx, at: lc }
  }
  // clicking the in-progress draft's outline inserts a vertex there (same as measure)
  if (c.draft?.canInsert && hit('l-draft-hit')) {
    const idx = insertAt(c.draft)
    if (idx != null) return { kind: 'draftInsert', index: idx, at: lc }
  }
  // while a placement tool is active, a click adds/places — don't let a drawing's
  // fill/outline under the cursor swallow it as a selection (so symbols etc. can be
  // dropped INSIDE an area). Selection-by-click only applies in the Select tool.
  if (!c.placing) {
    // among every drawing under the cursor, pick the SMALLEST shape — so a small Fläche
    // drawn over a big Absperrkreis (radius) wins the click instead of the circle's fill
    // swallowing it (both are polygons in one layer, so render order alone is unreliable).
    // Lines/outlines have ~0 area, keeping thin lines the most specific (selectable) pick.
    // Locked shapes are skipped entirely so they go click-through (unlock via the lock chip).
    // ⚠️ Mirrored plan ink is in the SAME resolution, not in a pass of its own: a projection is
    // the object seen from this side, so a twin drawn over a native Fläche has to win the click
    // by the same smallest-shape rule the two natives would settle it by. A locked source is
    // skipped on either side — its ink is click-through until its LockChip is held.
    const cands = c.features.filter((f) => {
      const p = f?.properties
      if (!p) return false
      if (p.twinKey != null) return !p.locked
      return p.id != null && !c.lockedIds.has(p.id as string)
    })
    if (cands.length) {
      let best = cands[0]
      let bestA = featArea(best)
      for (let i = 1; i < cands.length; i++) {
        const a = featArea(cands[i])
        if (a < bestA) { bestA = a; best = cands[i] }
      }
      return { kind: 'selectDrawing', id: best.properties?.id as string, at: { x: c.point.x, y: c.point.y } }
    }
  }
  const last = c.draft ? c.draft.points[c.draft.points.length - 1] : undefined
  const lastPx = last && project?.(last)
  if (lastPx && Math.hypot(c.point.x - lastPx.x, c.point.y - lastPx.y) < NODE_REPEAT_PX) return { kind: 'none' }
  return { kind: 'place', at: lc }
}
