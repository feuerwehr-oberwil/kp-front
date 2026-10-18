// A visit at a PLACE (16.10.2026, docs/object-visits.md · «The target»): a pin or an address the
// station has no catalogue object for — «Fehlermeldung bei Talholzstrasse 15». The document says
// so with `target: {kind: 'location', label, address, lat, lng}` and `object: null`; a document
// without `target` is at its `object` (every visit before this date). Pure.
//
// ⚠️ A place has no object id, so whatever keyed a visit by its object keys it differently:
// - the open draft a launch link resumes: `draftKeyOf` — the place rounded to ~1 m, so a reload of
//   the link never makes a second draft;
// - the visits «at this stop» (the read view's cards, «erfasst» in the chooser): `stopKeyOf` — a
//   place visit is a stop of its OWN. Two reports that happen to sit on the same pin are two
//   independent reports and never one stop (lead review of #368, 16.10.2026).
// Never put either key where an object id is sent to the server.

import type { ChecklistTemplate } from '../lib/checklists'
import type { PlaceTarget, VisitSummary, VisitTarget } from './types'

/** The two keys of a document this module reads (an object needs no more than its id here). */
export interface Targeted { object?: { id: string } | null; target?: VisitTarget }

/** What the document says the visit is at (an older document: its object). */
export function targetOf(doc: Targeted): VisitTarget {
  if (doc.target && (doc.target.kind === 'object' || doc.target.kind === 'location')) return doc.target
  return { kind: 'object', objectId: doc.object?.id ?? '' }
}

/** The place of a visit at a place; null for a visit at an object. */
export function placeOf(doc: Targeted): PlaceTarget | null {
  const t = targetOf(doc)
  return t.kind === 'location' ? t : null
}

const PLACE_PREFIX = 'ort:'

/** A place as a key: rounded to 5 decimals (~1 m), so the same pin is the same stop. */
export function placeKey(p: { lat: number; lng: number }): string {
  return `${PLACE_PREFIX}${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
}

export const isPlaceKey = (key: string): boolean => key.startsWith(PLACE_PREFIX)

/** Which open draft a launch resumes: its object's id, or its place's key (~1 m). */
export function draftKeyOf(doc: Targeted): string {
  const t = targetOf(doc)
  return t.kind === 'location' ? placeKey(t) : t.objectId || doc.object?.id || ''
}

const OWN_PREFIX = 'besuch:'

/** The «stop» a visit belongs to: its object's id — or, a visit at a place, the visit itself. */
export function stopKeyOf(doc: Targeted & { id: string }): string {
  return targetOf(doc).kind === 'location' ? `${OWN_PREFIX}${doc.id}` : draftKeyOf(doc)
}

/** The same key for a row of the server's list (an older server sends no `target_kind`). */
export function summaryStopKey(v: Pick<VisitSummary, 'id' | 'objectId' | 'target_kind'>): string {
  return v.target_kind === 'location' ? `${OWN_PREFIX}${v.id}` : v.objectId ?? ''
}

/** Was the place picked as an ADDRESS (its label is the address's first part) or dropped as a
 *  pin? The «Adresse»/«Pin» badge — the server's report uses the same rule (object_visit_report ·
 *  place_kind). */
export function placeKind(t: Pick<PlaceTarget, 'label' | 'address'>): 'address' | 'pin' {
  const norm = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase()
  const label = norm(t.label)
  const first = norm((t.address ?? '').split(',')[0])
  return label && first && label === first ? 'address' : 'pin'
}

/** Where a checklist may be used (`targets`; absent = at an object only). */
export function templateTargets(t: Pick<ChecklistTemplate, 'targets'>): ('object' | 'location')[] {
  const list = Array.isArray(t.targets) ? t.targets.filter((x) => x === 'object' || x === 'location') : []
  return list.length ? list : ['object']
}

/** The checklists a visit at this kind of target may use. */
export function templatesFor<T extends Pick<ChecklistTemplate, 'targets'>>(templates: T[], kind: VisitTarget['kind']): T[] {
  return templates.filter((t) => templateTargets(t).includes(kind))
}

/** The place a launch link names (`/besuche/neu?lat=&lng=&label=[&address=]`) — or null when it
 *  names no usable position. A missing label is a pin without a name; the page supplies one. */
export interface PlaceQuery {
  lat: number
  lng: number
  label: string
  address: string | null
}

export function parsePlace(q: URLSearchParams): PlaceQuery | null {
  const num = (k: string) => {
    const raw = q.get(k)
    if (raw == null || raw.trim() === '') return NaN
    return Number(raw)
  }
  const lat = num('lat'), lng = num('lng')
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  const label = (q.get('label') ?? '').trim().slice(0, 200)
  const address = (q.get('address') ?? '').trim().slice(0, 300) || null
  return { lat, lng, label, address }
}

/** The document's target for a launch link's place (`fallbackLabel` when it carried none). */
export function placeTarget(p: PlaceQuery, fallbackLabel: string): PlaceTarget {
  return { kind: 'location', label: p.label || fallbackLabel, address: p.address, lat: p.lat, lng: p.lng }
}

// ─── the small map on the «Ort» card ──────────────────────────────────────────────────────────

const TILE = 256

export interface PlaceTile { key: string; url: string; left: number; top: number }

/**
 * The raster tiles that cover a `w`×`h` box centred on a place at zoom `z`, each positioned in
 * that box (px). Plain `<img>`s, no map library: the card has to open in a cellar too, where a
 * tile the device never saw simply does not load and the card keeps the label and LV95.
 * Positions are box-relative — never world pixels, which a CSS transform clamps at 2²⁵.
 */
export function placeTiles(tpl: string, lat: number, lng: number, z: number, w: number, h: number): PlaceTile[] {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const px = ((lng + 180) / 360) * n * TILE
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE
  const left = px - w / 2, top = py - h / 2
  const x0 = Math.floor(left / TILE), x1 = Math.floor((left + w - 1) / TILE)
  const y0 = Math.floor(top / TILE), y1 = Math.floor((top + h - 1) / TILE)
  const out: PlaceTile[] = []
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue
      const wx = ((tx % n) + n) % n
      const url = tpl.replace('{s}', 'a').replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(ty)).replace('{r}', '')
      out.push({ key: `${tx}/${ty}`, url, left: Math.round(tx * TILE - left), top: Math.round(ty * TILE - top) })
    }
  }
  return out
}
