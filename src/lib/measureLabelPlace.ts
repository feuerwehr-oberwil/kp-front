import type { LngLat } from '../types'

// Where a measure readout stands relative to the node it belongs to.
//
// The cumulative labels («18 m») are pinned to their VERTEX, and until review round 7 every one of
// them stood straight above it. With the nodes close together — a hose run measured in short
// hops — the chip above node n landed under node n−1's 24px handle and the number was gone
// (owner, 20.10.2026: «the distances between the nodes can be clipped by the nodes themselves»).
//
// So the chip steps off the LINE instead of off the node: perpendicular to the segment it ends,
// always on that segment's left in screen space, so a row of close nodes gets one readable column
// of numbers beside the path rather than a pile on it. Because the chip is anchored by the EDGE
// that faces the node, its own width runs sideways AWAY from the path — a segment shorter than the
// label can no longer push it over the neighbouring node either.
//
// Pure (and so unit-tested without a map): the map's `bearing` turns the geographic direction into
// the screen one, which is all the projection detail that matters for a direction.

/** The measure handle's radius (24px circle, 11-measure.css) plus air. */
export const LABEL_CLEAR_PX = 16

/** Which edge of the chip sits on the anchor point — the react-map-gl `Marker` anchors we use. */
export type LabelAnchor = 'top' | 'bottom' | 'left' | 'right'
export interface LabelPlacement { anchor: LabelAnchor; offset: [number, number] }

/** Straight above the point: the area centroid, and any segment too short to have a side. */
export const LABEL_ABOVE: LabelPlacement = { anchor: 'bottom', offset: [0, -LABEL_CLEAR_PX] }

/** A segment this short in degrees has no readable direction (two nodes on one spot). */
const EPS = 1e-12

/**
 * The placement of the readout for the segment `from → to`, pinned at `to`.
 *
 * `bearingDeg` is the live map bearing (compass direction shown up the screen), so the chip keeps
 * its side of the line while the map is rotated.
 */
export function measureLabelPlacement(from: LngLat, to: LngLat, bearingDeg: number, clearPx: number = LABEL_CLEAR_PX): LabelPlacement {
  const lat = ((from[1] + to[1]) / 2) * (Math.PI / 180)
  const east = (to[0] - from[0]) * Math.cos(lat)
  const north = to[1] - from[1]
  const b = (bearingDeg * Math.PI) / 180
  // geographic (east, north) → screen (x right, y down) at this bearing
  const x = east * Math.cos(b) - north * Math.sin(b)
  const y = -(east * Math.sin(b) + north * Math.cos(b))
  const len = Math.hypot(x, y)
  if (len < EPS) return LABEL_ABOVE
  // the segment's left in screen space (y points down, so left of (x, y) is (y, −x))
  const px = (y / len) * clearPx
  const py = (-x / len) * clearPx
  const anchor: LabelAnchor = Math.abs(px) >= Math.abs(py) ? (px > 0 ? 'left' : 'right') : py > 0 ? 'top' : 'bottom'
  // `|| 0`: Math.round(-0.2) is −0, and a marker offset of −0 reads as a different number in
  // every snapshot and comparison it ever lands in
  return { anchor, offset: [Math.round(px) || 0, Math.round(py) || 0] }
}
