// Objects (Feuerwehrpläne / Einsatzobjekte) + their plan datasets, with offline-resilient
// per-incident listing so switching incidents with no signal keeps the plans.
import { ApiError, apiGet } from '../api'
import { idbGet, idbSet } from '../idb'
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
// are runtime-cached by the SW, but the listing that points at them isn't. Cache the metadata in
// IDB on every successful fetch and fall back to it on a network error, the same shape as
// listIncidentsResilient. Metadata only (object + dataset refs), so it stays small.
const OBJECTS_NEAR_CACHE = (id: string) => `kp-front-objects-${id}`
export async function objectsNearIncidentResilient(id: string): Promise<ObjectWithPlans[]> {
  try {
    const objs = await objectsNearIncident(id)
    void idbSet(OBJECTS_NEAR_CACHE(id), objs)
    return objs
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) return (await idbGet<ObjectWithPlans[]>(OBJECTS_NEAR_CACHE(id))) ?? []
    throw e
  }
}
const OBJECT_CACHE = (id: string) => `kp-front-object-${id}`
export async function getObjectResilient(id: string): Promise<ObjectWithPlans> {
  try {
    const obj = await getObject(id)
    void idbSet(OBJECT_CACHE(id), obj)
    return obj
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      const cached = await idbGet<ObjectWithPlans>(OBJECT_CACHE(id))
      if (cached) return cached
    }
    throw e
  }
}
