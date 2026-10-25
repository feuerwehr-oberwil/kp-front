// «Karte & Objekte» — what is selected and what is under the pointer, and the two pure questions
// the surface (components/karte/KarteApp) asks about them: where a selection stands, and which
// station object a point on the map hits (docs/karte-objekte.md · «The viewer»).

import type { LngLat } from '../../types'
import type { StationObject } from '../api/stationReference'
import { objectBuildings, ringAt } from './places'
import { coordOf } from './search'

/** What the panel is about. Karte Haus round 1 (owner, variant A): a tap on one of an object's
 *  buildings opens the object and remembers that building (`hit`, drawn dashed); the panel's switch
 *  then opens just that house — a `building` that knows it is part of the object (`of`), so the
 *  register rule «this address is an object's → open the object» never throws it back. */
export type Sel =
  | { kind: 'object'; id: string; approxAt?: LngLat | null; hit?: { at: LngLat; ring: LngLat[] } }
  | { kind: 'building'; at: LngLat; ring: LngLat[] | null; address: string | null; of?: string }
  | { kind: 'pin'; at: LngLat }

/** what the mouse is over (never touch) or the finger holds: an object's building, a plain
 *  building, or a hydrant (the mouse only) */
export type Hover =
  | { kind: 'object'; id: string; ring: LngLat[] | null }
  | { kind: 'plain'; ring: LngLat[] }
  | { kind: 'hydrant'; id: string }

/** each station object's buildings, by id (places · objectBuildings) */
export type ObjectOutlines = ReadonlyMap<string, NonNullable<ReturnType<typeof objectBuildings>>>

/** the same thing under the mouse as before (rings compare by identity: they come from one set) */
export function sameHover(a: Hover | null, b: Hover | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'hydrant') return b.kind === 'hydrant' && a.id === b.id
  if (a.kind === 'object') return b.kind === 'object' && a.id === b.id && a.ring === b.ring
  return b.kind === 'plain' && a.ring === b.ring
}

/** Where a selection stands: the object's point (else where its address was geocoded to), the
 *  building's or the pin's tap. */
export function selPoint(x: Sel | null, byId: ReadonlyMap<string, StationObject>): LngLat | null {
  if (!x) return null
  if (x.kind !== 'object') return x.at
  const o = byId.get(x.id)
  return (o && coordOf(o)) ?? x.approxAt ?? null
}

/** The station object whose building is under `c`, and that building's ring (null when only an
 *  underground structure of it is); `skip` leaves an object out (its category is hidden). A
 *  building two objects claim (a row of houses named by its addresses, and a house of the row that
 *  is an object of its own) is the one whose point stands in it. */
export function objectAt(outlines: ObjectOutlines, c: LngLat, skip: (id: string) => boolean): { id: string; ring: LngLat[] | null } | null {
  let hit: { id: string; ring: LngLat[] | null } | null = null
  for (const [id, b] of outlines) {
    if (skip(id)) continue
    const ring = ringAt(b.rings, c)
    if (!ring && !ringAt(b.under, c)) continue
    if (b.main && ringAt([b.main], c)) return { id, ring }
    hit ??= { id, ring }
  }
  return hit
}
