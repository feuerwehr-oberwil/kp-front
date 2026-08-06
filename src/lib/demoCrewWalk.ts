// «Standort teilen» on the PUBLIC DEMO — a simulated crew, walked in the browser.
//
// The real feature has phones reporting where their holders are. On a demo that anyone on the
// internet can open, that is the one thing we will not do: a stranger's coordinates, posted
// against a fake Musterdorf name and visible to every other visitor, is a privacy problem with no
// upside. The backend refuses every position route in demo mode for exactly that reason
// (api/person_positions), and that stays true — nothing here posts anything.
//
// What a visitor should see instead is what the feature is FOR: crew dots moving on the Lage,
// ageing, disappearing when someone stops. So the demo walks a handful of synthetic responders
// around the incident, in this browser only. Nothing is fetched, nothing is stored, nothing
// reaches another visitor's screen — the walk exists for as long as the tab is open.
//
// Pure functions + one metre-scale step model, so the movement is testable without a map.

import type { LngLat } from '../types'

/** One simulated responder mid-walk. `heading` is degrees clockwise from north. */
export interface Walker {
  personId: string
  displayName: string
  coord: LngLat
  heading: number
}

/** Walking pace and how far the crew wanders — a working fire ground, not a marathon. */
const SPEED_M_PER_S = 1.3
/** How far a walker may drift from its anchor before it turns back. Deliberately short: the demo
 *  scene is a few hundred metres of synthetic village, and a dot that wanders far enough ends up
 *  standing in the Weiher — which reads as a bug, not as a crew member. */
const LEASH_M = 90
/** degrees of heading wander per second — enough to look alive, little enough to read as walking */
const TURN_DEG_PER_S = 14

const M_PER_DEG_LAT = 110_540
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

/** Metres between two WGS84 points at this scale — a local flat approximation is plenty for a
 *  few hundred metres and keeps this module free of the geo helpers. */
function metresBetween(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mPerDegLng(a[1])
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** Bearing (deg clockwise from north) from `a` to `b`. */
function bearingTo(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mPerDegLng(a[1])
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT
  return (Math.atan2(dx, dy) * 180) / Math.PI
}

/**
 * Place the given people around the incident to start with — spread evenly on a ring rather
 * than randomly, so the demo opens on a picture that reads as «crew deployed around the object»
 * instead of a clump that happens to look like a bug.
 */
export function seedWalkers(center: LngLat, crew: { id: string; displayName: string }[], radiusM = 30): Walker[] {
  return crew.map((p, i) => {
    const angle = (i / Math.max(1, crew.length)) * 2 * Math.PI
    const dx = Math.sin(angle) * radiusM
    const dy = Math.cos(angle) * radiusM
    return {
      personId: p.id,
      displayName: p.displayName,
      coord: [center[0] + dx / mPerDegLng(center[1]), center[1] + dy / M_PER_DEG_LAT],
      // facing outward, so the first steps spread rather than immediately collide in the middle
      heading: (angle * 180) / Math.PI,
    }
  })
}

/**
 * Advance one walker by `dtMs`. It wanders — the heading drifts a little each step — but is on a
 * leash: past `LEASH_M` from the incident it turns back towards it, so nobody walks out of the
 * Lage while the visitor is reading the Verlauf.
 *
 * `rand` is injectable so the tests get a straight line instead of a random one.
 */
export function stepWalker(w: Walker, center: LngLat, dtMs: number, rand: () => number = Math.random): Walker {
  const dtSec = Math.max(0, dtMs) / 1000
  const drift = (rand() - 0.5) * 2 * TURN_DEG_PER_S * dtSec
  const outbound = metresBetween(center, w.coord) > LEASH_M
  // on the leash: steer home rather than snapping there — a dot that teleports back reads as broken
  const heading = outbound ? bearingTo(w.coord, center) : w.heading + drift
  const dist = SPEED_M_PER_S * dtSec
  const rad = (heading * Math.PI) / 180
  return {
    ...w,
    heading,
    coord: [
      w.coord[0] + (Math.sin(rad) * dist) / mPerDegLng(w.coord[1]),
      w.coord[1] + (Math.cos(rad) * dist) / M_PER_DEG_LAT,
    ],
  }
}

/** Advance a whole crew one tick. */
export const stepWalkers = (ws: Walker[], center: LngLat, dtMs: number, rand?: () => number): Walker[] =>
  ws.map((w) => stepWalker(w, center, dtMs, rand))

/**
 * Reconcile the walking crew with who should be walking right now: keep the ones still listed
 * (mid-walk, so they don't jump), seed the newcomers, drop the rest. This is what makes the
 * visitor's own «Standort teilen» appear as one more dot and vanish again on stop, without
 * restarting everybody else's walk.
 */
export function syncWalkers(current: Walker[], crew: { id: string; displayName: string }[], center: LngLat): Walker[] {
  const byId = new Map(current.map((w) => [w.personId, w]))
  const fresh = crew.filter((p) => !byId.has(p.id))
  const seeded = new Map(seedWalkers(center, fresh).map((w) => [w.personId, w]))
  return crew.map((p) => {
    const held = byId.get(p.id)
    // a renamed person keeps walking under the new name (the demo's «ich teile» dot does this)
    return held ? { ...held, displayName: p.displayName } : seeded.get(p.id)!
  })
}
