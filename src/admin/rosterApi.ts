// Admin-local roster (Mannschaft) API helpers. Deliberately NOT routed through
// src/lib/incidents.ts — the admin surface owns its own thin client over src/lib/api.ts
// so the field app and admin can evolve independently.
import { apiGet, apiPost, apiPatch, apiDelete, apiUpload } from '../lib/api'

/** A crew member as returned by the backend (PersonnelOut). */
export interface RosterPerson {
  id: string
  divera_id: number | null
  external_identities: { provider: string; external_id: string; synced_at: string }[]
  display_name: string
  first_name: string | null
  last_name: string | null
  /** Dienstgrad key (roster.ranks config); imported from Divera/CSV. */
  rank: string | null
  is_active: boolean
  updated_at: string
}

/** Body for manually adding a person (PersonnelCreate). */
export interface RosterCreate {
  display_name: string
  divera_id?: number | null
}

/** Partial edit (PersonnelUpdate) — every field optional. */
export interface RosterUpdate {
  display_name?: string
  first_name?: string | null
  last_name?: string | null
  is_active?: boolean
}

/** Result of a CSV import. */
export interface RosterImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export function listRoster(includeInactive = false): Promise<RosterPerson[]> {
  return apiGet<RosterPerson[]>(`/api/personnel${includeInactive ? '?include_inactive=true' : ''}`)
}

export function createPerson(body: RosterCreate): Promise<RosterPerson> {
  return apiPost<RosterPerson>('/api/personnel', body)
}

export function updatePerson(id: string, body: RosterUpdate): Promise<RosterPerson> {
  return apiPatch<RosterPerson>(`/api/personnel/${id}`, body)
}

export function deactivatePerson(id: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/api/personnel/${id}`)
}

export function importRosterCsv(file: File): Promise<RosterImportResult> {
  const form = new FormData()
  form.append('file', file)
  return apiUpload<RosterImportResult>('/api/personnel/import-csv', form)
}
