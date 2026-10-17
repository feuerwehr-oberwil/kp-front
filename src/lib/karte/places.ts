// «Karte & Objekte» — the rules about PLACES (docs/karte-objekte.md): which object a building is,
// what is near a point, what a dropped pin is called, and the addresses the viewer links to.
//
// ⚠️ Two rules that are easy to break and expensive at 3am:
//   · a building is an object ONLY on an exact street + number match (`objectAtAddress`), when
//     the object's own coordinate lies INSIDE its outline (`outlineFor`), or when official data
//     puts it on the object's own use area / parcel (`objectBuildings`, derived server-side) —
//     never by proximity alone, because a neighbour's gas valve reads exactly like this one's;
//   · «In der Nähe» is distance and nothing else (`nearbyObjects`): the panel lists it under its
//     own heading with the sentence that it does not belong to the selected building.

import type { LngLat } from '../../types'
import { haversineM } from '../geo'
import { ringContains } from '../footprintPick'
import type { StationObject } from '../api/stationReference'
import { coordOf } from './search'

/** An address label as its two lines: «Hauptstrasse 10, 4104 Oberwil», the geocoder's
 *  «Hauptstrasse 10 4104 Oberwil» and «Schloss # 6246 Altishofen» all → [street, place]. */
export function splitAddress(label: string | null | undefined): [string, string] {
  const t = (label ?? '').trim()
  const cut = /[,#]/.exec(t)
  if (cut) return [t.slice(0, cut.index).trim(), t.slice(cut.index + 1).trim()]
  const m = /^(.*?\S)\s+(\d{4}\s+\S.*)$/.exec(t)
  return m ? [m[1], m[2]] : [t, '']
}

/** «Hauptstrasse 10, 4104 Oberwil» → «hauptstrasse10» — street and number, folded, without the
 *  place; the same key the backend matches on (building_facts · _street_of). */
export function streetKey(address: string | null | undefined): string {
  const head = splitAddress(address)[0]
  return head.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The label as «street, place» — the shape the server's own addresses have. */
export function normAddress(label: string | null | undefined): string {
  const [a, b] = splitAddress(label)
  return b ? `${a}, ${b}` : a
}

/**
 * The catalogue object whose address IS this address — exact street + number, never «close».
 * A key box at the same door is not the building: it is left out, so tapping a house opens the
 * house's Einsatzobjekt and not the Schlüsseldepot beside its entrance. Two candidates → the one
 * with plans, then by name.
 */
export function objectAtAddress(objects: readonly StationObject[], address: string | null | undefined): StationObject | null {
  const key = streetKey(address)
  if (!key) return null
  const hits = objects.filter((o) => o.kind !== 'depot' && streetKey(o.address) === key)
  hits.sort((a, b) => Number(b.plans.length > 0) - Number(a.plans.length > 0) || a.name.localeCompare(b.name, 'de'))
  return hits[0] ?? null
}

/** How far «In der Nähe» reaches, and how many of each kind it lists. */
export const NEARBY_RADIUS_M = 160
export const NEARBY_OBJECTS = 3
export const NEARBY_POINTS = 2

export interface Near<T> { item: T; distanceM: number }

/** Station objects within `radiusM` of `at`, nearest first — by distance ONLY. */
export function nearbyObjects(objects: readonly StationObject[], at: LngLat, opts: { exceptId?: string | null; radiusM?: number; max?: number } = {}): Near<StationObject>[] {
  const radius = opts.radiusM ?? NEARBY_RADIUS_M
  const out: Near<StationObject>[] = []
  for (const o of objects) {
    if (o.id === opts.exceptId) continue
    const c = coordOf(o)
    if (!c) continue
    const d = haversineM(at, c)
    if (d <= radius) out.push({ item: o, distanceM: d })
  }
  out.sort((a, b) => a.distanceM - b.distanceM)
  return out.slice(0, opts.max ?? NEARBY_OBJECTS)
}

export interface NamedPoint { id: string; label: string; coord: LngLat }

/** The `n` nearest points (hydrants) to `at`, whatever their distance — a hydrant 180 m away is
 *  still the nearest one, and the metres say how far. */
export function nearestPoints(points: readonly NamedPoint[], at: LngLat, n = NEARBY_POINTS): Near<NamedPoint>[] {
  return points.map((p) => ({ item: p, distanceM: haversineM(at, p.coord) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n)
}

/** Point features of a GeoJSON FeatureCollection as named points (a hydrant layer). The label is
 *  whatever the feature calls itself (`name`, `nr`, `id`, …), else its index. */
export function pointsFromGeoJson(fc: unknown, prefix = 'p'): NamedPoint[] {
  const feats = (fc as { features?: unknown[] } | null)?.features
  if (!Array.isArray(feats)) return []
  const out: NamedPoint[] = []
  feats.forEach((f, i) => {
    const g = (f as { geometry?: { type?: string; coordinates?: unknown } })?.geometry
    if (g?.type !== 'Point' || !Array.isArray(g.coordinates)) return
    const [lng, lat] = g.coordinates as number[]
    if (typeof lng !== 'number' || typeof lat !== 'number') return
    const props = ((f as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>
    const raw = ['name', 'Name', 'nr', 'Nr', 'nummer', 'Nummer', 'bezeichnung', 'Bezeichnung', 'id', 'ID']
      .map((k) => props[k]).find((v) => typeof v === 'string' || typeof v === 'number')
    out.push({ id: `${prefix}${i}`, label: raw != null ? String(raw) : String(i + 1), coord: [lng, lat] })
  })
  return out
}

/** How far a pin may be from an address and still be named after it («bei …»). */
export const PIN_ADDRESS_M = 60

/** A pin's name: the nearest register address when it is close enough to be the way to describe
 *  the spot, never the address OF the spot (that would be an object it is not). The reverse
 *  geocoder answers with the ASKED point (app/geocode · reverse, a ~40 m search radius), so a hit
 *  at the pin itself has no known distance (`null`) — it is near by construction. */
export function pinNear(hit: { label: string; lat: number; lng: number } | null, at: LngLat): { label: string; distanceM: number | null } | null {
  if (!hit) return null
  const d = haversineM(at, [hit.lng, hit.lat])
  if (d > PIN_ADDRESS_M) return null
  return { label: splitAddress(hit.label)[0], distanceM: d < 1 ? null : d }
}

/**
 * Every building that IS an object, and the one its point lies in (`main`, where the tag hangs).
 *
 * First the server's set (`footprint`, backend app/object_footprints, review 17.10.2026): every
 * building on the object's official use area (a school campus) or parcel, derived from the
 * cadastral survey — never a neighbour's, never by distance. Without one (not derived yet, the
 * sources off, nothing official at the point) the OSM outline the point lies in, as before
 * (`outlineFor`). Null = no building known: the map shows the object at its point.
 */
export function objectBuildings(obj: Pick<StationObject, 'lat' | 'lng' | 'kind' | 'footprint' | 'outline'>, rings: readonly LngLat[][]): { rings: LngLat[][]; main: LngLat[] | null } | null {
  const at = coordOf(obj)
  // the station said «no outline» (/admin · Lage korrigieren): not even the OSM fallback
  if (!at || obj.kind === 'depot' || obj.outline === 'none') return null
  const own = footprintRings(obj.footprint)
  if (own.length) return { rings: own, main: ringAt(own, at) }
  const r = outlineFor(obj, rings)
  return r ? { rings: [r], main: r } : null
}

/** A GeoJSON Polygon / MultiPolygon as outer rings in [lng, lat], without the closing vertex.
 *  Anything else (null, a point, garbage) is no rings. */
export function footprintRings(g: unknown): LngLat[][] {
  const geo = g as { type?: string; coordinates?: unknown } | null
  const polys = geo?.type === 'Polygon' ? [geo.coordinates] : geo?.type === 'MultiPolygon' && Array.isArray(geo.coordinates) ? geo.coordinates : []
  const out: LngLat[][] = []
  for (const p of polys as unknown[]) {
    const outer = Array.isArray(p) ? p[0] : null
    if (!Array.isArray(outer)) continue
    const ring = outer.filter((c): c is [number, number] => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number').map((c) => [c[0], c[1]] as LngLat)
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop()
    if (ring.length >= 3) out.push(ring)
  }
  return out
}

/**
 * The OSM outline that IS an object's building: the smallest ring containing the object's own
 * coordinate. No ring contains it → no outline (the map then shows a tag at the point). A ring that
 * merely lies close is NOT taken — that is exactly the guess this rule exists to forbid.
 */
export function outlineFor(obj: Pick<StationObject, 'lat' | 'lng' | 'kind'>, rings: readonly LngLat[][]): LngLat[] | null {
  const at = coordOf(obj)
  if (!at || obj.kind === 'depot') return null
  return ringAt(rings, at)
}

/** The smallest ring that contains `at` (outlines can nest: a courtyard house in a block). */
export function ringAt(rings: readonly LngLat[][], at: LngLat): LngLat[] | null {
  let best: LngLat[] | null = null
  let bestArea = Infinity
  for (const r of rings) {
    if (r.length < 3 || !ringContains(r, at)) continue
    const a = ringAreaDeg(r)
    if (a < bestArea) { best = r; bestArea = a }
  }
  return best
}

function ringAreaDeg(r: readonly LngLat[]): number {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return Math.abs(s) / 2
}

/** Overpass' JSON (as `/api/overpass/buildings` passes it through) → outlines in [lng, lat]. A
 *  relation contributes its outer member ways. */
export function ringsFromOverpass(data: unknown): LngLat[][] {
  type Node = { lat: number; lon: number }
  type El = { type?: string; geometry?: Node[]; members?: { type?: string; role?: string; geometry?: Node[] }[] }
  const rings: LngLat[][] = []
  const add = (g?: Node[]) => {
    if (g && g.length >= 3) rings.push(g.map((n) => [n.lon, n.lat] as LngLat))
  }
  for (const el of ((data as { elements?: El[] } | null)?.elements ?? [])) {
    if (el.type === 'way') add(el.geometry)
    else if (el.type === 'relation') for (const m of el.members ?? []) if (m.type === 'way' && (m.role === 'outer' || !m.role)) add(m.geometry)
  }
  return rings
}

// --- addresses the viewer links to (contract C1) -----------------------------------------------

/** A new Objektbesuch at a catalogue object, coming from the viewer. */
export function objectVisitHref(objectId: string): string {
  return `/besuche/neu?${new URLSearchParams({ object: objectId, from: 'karte' })}`
}

/** A new Objektbesuch / Meldung at a place without an object (C1). `address` only when known. */
export function placeVisitHref(p: { at: LngLat; label: string; address?: string | null }): string {
  const q = new URLSearchParams({ lat: p.at[1].toFixed(6), lng: p.at[0].toFixed(6), label: p.label })
  if (p.address?.trim()) q.set('address', p.address.trim())
  q.set('from', 'karte')
  return `/besuche/neu?${q}`
}
