// Objects (Feuerwehrpläne / Einsatzobjekte) + their plan datasets, with offline-resilient
// per-incident listing so switching incidents with no signal keeps the plans.
import { apiGet } from '../api'
import { readThrough } from '../idb'
import type { ReferenceDataset } from './reference'

export interface ObjectWithPlans {
  id: string
  name: string
  address: string | null
  lat: number | null
  lng: number | null
  source_note: string | null
  updated_at: string
  plans: ReferenceDataset[]
  distance_m: number | null
}

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
