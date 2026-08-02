// Divera alarm pool: the mirrored dispatch feed. Most alarms never appear here for long —
// they open their own Einsatz on arrival — but the split-dispatch guard parks an alarm that
// lands while another Einsatz is running, and that one is the EL's call: open it, or attach
// it to the Einsatz already on the map.
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
/** Open a pooled alarm as-is. Corrections are made afterwards, in the incident view — the
 *  endpoint still accepts them as a body for other clients, this one has nothing to send. */
export const takeDiveraAlarm = (diveraId: number) =>
  apiPost<IncidentFull>(`/api/divera/pool/${diveraId}/take`, {})
/** Attach a pool alarm to an EXISTING incident (split/Nachalarm dispatch) instead of
 *  opening a duplicate: the alarm's Meldung lands in the Verlauf and its GPS milestones
 *  follow to this incident; the incident's own title/location stay untouched. */
export const attachDiveraAlarm = (diveraId: number, incidentId: string) =>
  apiPost<{ ok: boolean; incident_id: string }>(`/api/divera/pool/${diveraId}/attach/${incidentId}`, {})
