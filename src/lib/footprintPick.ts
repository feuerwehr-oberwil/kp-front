// Which OSM outline is the building AT the Einsatzort? (08.10.2026)
//
// The Gebäude picker (`OsmOutline`) starts with no building chosen. When the Einsatz has a
// coordinate, it pre-selects the outline this function names, so the operator only confirms
// («Übernehmen (1)») instead of hunting for the right footprint in a field of identical ones.
// Never more than a suggestion: nothing is committed without that tap.
//
// The rule, in this order:
//  (a) the ring that CONTAINS the pin — that building (the smallest one, should outlines nest);
//  (b) otherwise the ring whose EDGE is nearest, if it is within `PICK_NEAR_M` and unambiguous:
//      the runner-up is at least `PICK_CLEAR_RATIO`× as far away, or beyond `PICK_NEAR_M` itself.
//      A geocoded address often lands on the street in front of the house, hence the reach; the
//      guard keeps it from choosing the neighbour across a narrow gap;
//  (c) else nothing — an empty selection is honest, a wrong one is not.
//
// Space: the picker's own — rings and pin in 0..1 of a square ±radiusM metre-bbox, so one unit
// is `sideM` (= 2·radiusM) metres in either direction (see OsmOutline · loadBuildings).

import type { Pt, Ring } from './footprint'

/** how far from the pin an outline's edge may be and still be THE building (metres) */
export const PICK_NEAR_M = 12
/** how much farther the second-nearest outline must be for the nearest one to be unambiguous */
export const PICK_CLEAR_RATIO = 2

/** even-odd ray cast; a point exactly on an edge may land either way (the edge test covers it) */
export function ringContains(ring: Ring, [px, py]: Pt): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** shortest distance from the point to the ring's outline (closing edge included) */
export function ringEdgeDistance(ring: Ring, [px, py]: Pt): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
  }
  return best
}

function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(a) / 2
}

/** The index of the outline at the pin, or null when none is clearly it (rule above).
 *  `sideM` is the metre length of one picker unit — 2·radiusM for the square bbox. */
export function pickAtPin(rings: readonly Ring[], pin: Pt, sideM: number): number | null {
  let hit: number | null = null
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].length >= 3 && ringContains(rings[i], pin) && (hit === null || ringArea(rings[i]) < ringArea(rings[hit]))) hit = i
  }
  if (hit !== null) return hit

  let first = Infinity, second = Infinity, at: number | null = null
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].length < 2) continue
    const d = ringEdgeDistance(rings[i], pin) * sideM
    if (d < first) { second = first; first = d; at = i } else if (d < second) second = d
  }
  if (at === null || first > PICK_NEAR_M) return null
  return second > PICK_NEAR_M || second >= PICK_CLEAR_RATIO * first ? at : null
}
