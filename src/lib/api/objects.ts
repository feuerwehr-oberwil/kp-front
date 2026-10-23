// Objects (Feuerwehrpläne / Einsatzobjekte) + their plan datasets, with offline-resilient
// per-incident listing so switching incidents with no signal keeps the plans.
import { apiGet } from '../api'
import { readThrough } from '../idb'
import type { CachedWithout, Out } from './wire'

/** One object with its plan datasets. `source_key` is the station's key for it, read-only (set
 *  by `admin_objects` and the plan pipelines, never by this app): its absence is the object's
 *  provenance — «in der Maske getippt» — and the scheduled Planspeicher-Abgleich matches on
 *  nothing else. `measures`/`remarks` are the Sofortmassnahmen / Bemerkungen off the Modul-1
 *  sheet, one per line, and `measures_source` where they came from (the Gebäude card).
 *  `locality` is the town when it is not the home town. `position_source` is `'station'` once
 *  the station corrected the position in /admin («Lage korrigieren») — no import, push or pull
 *  overwrites it then. `outline` is the station's outline choice: null = automatic, `building`,
 *  `none` (the server types it a plain string; those three are all its one writer stores).
 *  `address_match` (objects-near-incident only): true = the incident's address matched, false =
 *  surfaced by proximity alone (the plan rail warns then). The optional fields are absent from
 *  a payload cached before they existed. */
export type ObjectWithPlans = CachedWithout<Omit<Out<'ObjectWithPlans'>, 'outline'> & { outline: 'building' | 'none' | null },
  'source_key' | 'measures' | 'remarks' | 'measures_source' | 'locality' | 'position_source' | 'position_set_at' | 'outline' | 'address_match'>

export const listObjects = (q?: string, near?: string) => {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (near) p.set('near', near)
  const qs = p.toString()
  return apiGet<ObjectWithPlans[]>(`/api/objects${qs ? `?${qs}` : ''}`)
}
export const objectsNearIncident = (id: string) =>
  apiGet<ObjectWithPlans[]>(`/api/incidents/${id}/objects`)
/** One object with its plans (used to restore a manually-picked object after a reload). */
export const getObject = (id: string) =>
  apiGet<ObjectWithPlans>(`/api/objects/${encodeURIComponent(id)}`)

// Offline: the per-incident object+plan listing (which Objektplan tiles belong to an incident) is a
// live call, so switching incidents with no signal would otherwise drop the plans — the plan PDFs
// are runtime-cached by the SW, but the listing that points at them isn't. `readThrough` caches the
// metadata in IDB on every successful fetch and falls back to it whenever the server could not be
// ASKED — offline, our own timeout, or a 502/503/504 from the proxy in front of a restarting
// server. (Until 02.09. these two inlined `status === 0`, so a Railway restart dropped the plans
// while the incident list, which already asked `isUnverifiable`, survived it.) Metadata only
// (object + dataset refs), so it stays small.
const OBJECTS_NEAR_CACHE = (id: string) => `kp-front-objects-${id}`
export async function objectsNearIncidentResilient(id: string): Promise<ObjectWithPlans[]> {
  const { value } = await readThrough<ObjectWithPlans[]>(OBJECTS_NEAR_CACHE(id), () => objectsNearIncident(id), {
    validate: (v): v is ObjectWithPlans[] => Array.isArray(v),
    fallback: () => [],
  })
  return value
}
const OBJECT_CACHE = (id: string) => `kp-front-object-${id}`
export async function getObjectResilient(id: string): Promise<ObjectWithPlans> {
  // No fallback: with neither network nor cache the caller must learn the object is unknown.
  const { value } = await readThrough<ObjectWithPlans>(OBJECT_CACHE(id), () => getObject(id))
  return value
}
