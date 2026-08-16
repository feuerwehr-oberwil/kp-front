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

/** Result of a CSV import. `imported` is `created + updated` — people touched, not rows read. */
export interface RosterImportResult {
  imported: number
  created: number
  updated: number
  skipped: number
  errors: string[]
  /** rank keys this import wrote into the station's roster.ranks */
  adopted_ranks: string[]
}

/** One rank the station's list knows — an option in the mapping picker. */
export interface RosterRankOption {
  key: string
  label: string
  abbr: string | null
}

/** One rank VALUE the file uses and the station's list does not know.
 *  ⚠️ Per value, not per row: three people spelled «Sdt» are ONE of these. */
export interface RosterUnknownRank {
  value: string
  count: number
  people: string[]
  suggestion: string | null
}

/** What an import WOULD do — the backend writes nothing to answer this. */
export interface RosterImportPreview {
  /** rows carrying a usable name (a file may name one person twice → `creates + updates` is lower) */
  total: number
  /** people this file adds */
  creates: number
  /** people it updates in place instead of adding a second time */
  updates: number
  skipped: number
  errors: string[]
  unknown_ranks: RosterUnknownRank[]
  known_ranks: RosterRankOption[]
  /** false while the station is still running on the shipped Swiss default rank list */
  has_own_ranks: boolean
}

/** What to do with one unknown value: put it on a known rank, adopt it as a new rank of the
 *  station, or import those people without a Dienstgrad. */
export type RosterRankDecision =
  | { value: string; action: 'map'; rank: string }
  | { value: string; action: 'adopt' }
  | { value: string; action: 'skip' }

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

/** Read-only: what this file would import, and which rank values need a decision first. */
export function previewRosterCsv(file: File): Promise<RosterImportPreview> {
  const form = new FormData()
  form.append('file', file)
  return apiUpload<RosterImportPreview>('/api/personnel/import-csv/preview', form)
}

/** Apply the import. ⚠️ Every unknown rank value must carry a decision — otherwise the server
 *  refuses the whole file (409) and writes nothing at all, people included. */
export function importRosterCsv(file: File, decisions: RosterRankDecision[] = []): Promise<RosterImportResult> {
  const form = new FormData()
  form.append('file', file)
  if (decisions.length) form.append('decisions', JSON.stringify(decisions))
  return apiUpload<RosterImportResult>('/api/personnel/import-csv', form)
}
