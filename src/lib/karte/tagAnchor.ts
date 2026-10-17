// Where an object's name tag hangs on «Karte & Objekte».
//
// Normally under its building: the middle of the building's south edge, the tag hanging below it
// on the street. ⚠️ Not when that spot is ANOTHER object's building (review round 2, 17.10.2026):
// Migros (Mühlemattstrasse 18) and the Mühlemattcenter (22) stand wall to wall, separated by a
// roofed passage, so the «Migros» tag hung on the Mühlemattcenter's roof — beside its «22», its
// pharmacy and its key box — while the OSM base map writes «Mühlematt Center» on the Migros
// building (the mall polygon). Read together, the two objects looked swapped and joined into one,
// and a tap on the tag over the Mühlemattcenter opened Migros. A tag whose «under» spot lies on
// another object's building therefore sits INSIDE its own building instead.

import { ringContains } from '../footprintPick'
import type { LngLat } from '../../types'

const M_PER_DEG_LAT = 110_540
/** the spots under the south edge a tag covers, in metres: across (± its half width) and down */
const ACROSS_M = [-14, 0, 14]
const DOWN_M = [3, 12, 22]

function bbox(r: readonly LngLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y }
  return [w, s, e, n]
}

/** A point surely inside the ring: its centroid when that is inside, else the middle of the
 *  widest stretch of the ring along the centroid's latitude (an L- or U-shaped building). */
export function interiorPoint(r: LngLat[]): LngLat {
  let a = 0, cx = 0, cy = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]
    a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f
  }
  const c: LngLat = Math.abs(a) < 1e-18
    ? [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]
    : [cx / (3 * a), cy / (3 * a)]
  if (ringContains(r, c)) return c
  const y = c[1]
  const xs: number[] = []
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [x1, y1] = r[j], [x2, y2] = r[i]
    if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
  }
  xs.sort((p, q) => p - q)
  let best: LngLat = c, width = -1
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) { width = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y] }
  }
  return best
}

/**
 * The tag's anchor: `under` = hang below the building (MapLibre anchor «top»), else centred on
 * the point it returns. `others` are the OTHER objects' buildings (never the object's own).
 */
export function tagAnchor(b: { main: LngLat[] | null } | undefined, at: LngLat, others: readonly LngLat[][] = []): { at: LngLat; under: boolean } {
  const r = b?.main
  if (!r) return { at, under: false }
  const south: LngLat = [r.reduce((a, p) => a + p[0], 0) / r.length, Math.min(...r.map((p) => p[1]))]
  const kx = 111_320 * Math.cos((south[1] * Math.PI) / 180)
  const spots: LngLat[] = []
  for (const dx of ACROSS_M) for (const dy of DOWN_M) spots.push([south[0] + dx / kx, south[1] - dy / M_PER_DEG_LAT])
  const [w, s, e, n] = bbox(spots)
  for (const o of others) {
    if (o.length < 3) continue
    const [ow, os, oe, on] = bbox(o)
    if (oe < w || ow > e || on < s || os > n) continue
    if (spots.some((p) => ringContains(o, p))) return { at: interiorPoint(r), under: false }
  }
  return { at: south, under: true }
}
