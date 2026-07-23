// Personnel (Mannschaft) roster + the editor-only Divera sync preview/execute.
import { apiGet, apiPost } from '../api'
import type { Person } from '../../types'

interface PersonnelWire {
  id: string
  divera_id: number | null
  external_identities: { provider: string; external_id: string; synced_at: string }[]
  display_name: string
  first_name: string | null
  last_name: string | null
  rank: string | null
  is_active: boolean
  updated_at: string
}
const toPerson = (p: PersonnelWire): Person => ({
  id: p.id,
  externalIdentities: (p.external_identities ?? []).map((i) => ({ provider: i.provider, externalId: i.external_id, syncedAt: i.synced_at })),
  diveraId: p.divera_id ?? undefined,
  displayName: p.display_name,
  firstName: p.first_name ?? undefined,
  lastName: p.last_name ?? undefined,
  rank: p.rank ?? undefined,
  active: p.is_active,
  updatedAt: p.updated_at,
})
export const listPersonnel = (includeInactive = false) =>
  apiGet<PersonnelWire[]>(`/api/personnel${includeInactive ? '?include_inactive=true' : ''}`).then((rows) => rows.map(toPerson))
/** editor-only: read-only diff of Divera members vs the roster (no writes). */
export interface PersonnelSyncPreview {
  new: { divera_id: number; name: string }[]
  updated: { id: string; divera_id: number; name: string; was_inactive: boolean }[]
  unchanged: { id: string; divera_id: number; name: string }[]
  stale: { id: string; name: string }[]
}
export interface PersonnelSyncResult {
  created: number; updated: number; reactivated: number; unchanged: number; deactivated: number; stale: number
}
export const personnelSyncPreview = () => apiPost<PersonnelSyncPreview>('/api/personnel/sync/preview', {})
export const personnelSyncExecute = (deactivateStale: boolean) =>
  apiPost<PersonnelSyncResult>('/api/personnel/sync/execute', { deactivate_stale: deactivateStale })
