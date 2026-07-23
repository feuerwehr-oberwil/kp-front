// Divera alarm pool: the mirrored dispatch feed the EL takes/attaches incidents from.
import { apiGet, apiPost } from '../api'
import type { IncidentFull } from './incidents'

export interface DiveraAlarm {
  id: string
  divera_id: number
  divera_number: string | null
  title: string
  text: string | null
  address: string | null
  lat: number | null
  lng: number | null
  received_at: string
  is_taken: boolean
}
export const getDiveraPool = () => apiGet<DiveraAlarm[]>('/api/divera/pool')
export const refreshDiveraPool = () => apiPost<{ new: number }>('/api/divera/pool/refresh')
/** EL corrections from the intake wizard; any field set overrides the mirrored alarm value. */
export interface DiveraTakeOverrides {
  title?: string
  type?: string | null
  priority?: string | null
  text?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
}
export const takeDiveraAlarm = (diveraId: number, overrides?: DiveraTakeOverrides) =>
  apiPost<IncidentFull>(`/api/divera/pool/${diveraId}/take`, overrides ?? {})
/** Attach a pool alarm to an EXISTING incident (split/Nachalarm dispatch) instead of
 *  opening a duplicate: the alarm's Meldung lands in the Verlauf and its GPS milestones
 *  follow to this incident; the incident's own title/location stay untouched. */
export const attachDiveraAlarm = (diveraId: number, incidentId: string) =>
  apiPost<{ ok: boolean; incident_id: string }>(`/api/divera/pool/${diveraId}/attach/${incidentId}`, {})
