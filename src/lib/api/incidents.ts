// Incident CRUD + the offline-resilient active list, plus the one-time legacy-workspace
// migration. Other incident subresources live in sibling modules: workspace blob (./workspace),
// audit events (./events), media (./media).
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '../api'
import { idbGet, idbSet } from '../idb'
import { appConfig } from '../../config/appConfig'
import { putWorkspace, type Workspace } from './workspace'

// --- Types (mirror backend schemas) -------------------------------------------------
export interface IncidentMeta {
  id: string
  divera_id: number | null
  title: string
  type: string | null
  priority: string | null // 'HIGH' | 'LOW'
  address: string | null
  lat: number | null
  lng: number | null
  status: string
  source: string // 'divera' | 'manual' | 'migrated' | generic intake slug
  source_ref: string | null // foreign alarm id for generic intake sources
  auto_opened: boolean // created by an alarm without a human (auto-open / generic intake)
  started_at: string
  closed_at: string | null
  is_archived: boolean
  is_exercise: boolean // Übung — stats-excluded, the only kind that may be hard-deleted
  report_done_at: string | null // Abschluss-Assistent completion bookmark (see rapportStatus.ts)
  // Cross-visibility QR ↔ KP (optional: absent on lists cached before the feature shipped) —
  // editor_opened_at latches the first editor open; capture_* count QR capture writes.
  editor_opened_at?: string | null
  capture_writes?: number
  capture_last_at?: string | null
  workspace_rev: number
  created_by: string | null
  created_at: string
  updated_at: string
}
export interface IncidentFull extends IncidentMeta {
  text: string | null
  details_json: Record<string, unknown> | null
  map_workspace_json: Record<string, unknown> | null
}
export interface IncidentCreate {
  title: string
  type?: string | null
  priority?: string | null
  text?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  /** Alarmierungszeit — backdatable so an analog incident can be nachgetragen later */
  started_at?: string | null
  is_exercise?: boolean
  details_json?: Record<string, unknown> | null
}

// --- Incidents ----------------------------------------------------------------------
export const listIncidents = (archived?: boolean, limit?: number) => {
  const params = [
    archived === undefined ? null : `archived=${archived}`,
    limit === undefined ? null : `limit=${limit}`,
  ].filter(Boolean).join('&')
  return apiGet<IncidentMeta[]>(`/api/incidents${params ? `?${params}` : ''}`)
}

// Offline support: cache the active (non-archived) incident list so an installed PWA can
// reopen the last incident with no signal (its workspace blob is already in WorkspaceSync's
// per-incident cache). The list itself is NetworkOnly for the SW, so we cache it here.
const INCIDENT_LIST_CACHE = 'kp-front-incidents'
export async function cacheIncidentList(list: IncidentMeta[]): Promise<void> {
  await idbSet(INCIDENT_LIST_CACHE, list)
}
export async function readCachedIncidentList(): Promise<IncidentMeta[]> {
  return (await idbGet<IncidentMeta[]>(INCIDENT_LIST_CACHE)) ?? []
}
/** Fetch the active list online (and cache it); on a network error fall back to cache. */
export async function listIncidentsResilient(): Promise<{ list: IncidentMeta[]; offline: boolean }> {
  try {
    const list = await listIncidents(false)
    void cacheIncidentList(list)
    return { list, offline: false }
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) return { list: await readCachedIncidentList(), offline: true }
    throw e
  }
}
export const getIncident = (id: string) => apiGet<IncidentFull>(`/api/incidents/${id}`)
export const createIncident = (body: IncidentCreate) => apiPost<IncidentFull>('/api/incidents', body)
// `text` (Meldungstext / Alarmmeldung) is not part of IncidentMeta but the backend PATCH
// accepts it (and started_at) — the Einsatzdaten panel corrects both in place.
export const patchIncident = (id: string, body: Partial<IncidentMeta> & { text?: string | null }) =>
  apiPatch<IncidentFull>(`/api/incidents/${id}`, body)
export const archiveIncident = (id: string) => patchIncident(id, { is_archived: true })
export const reactivateIncident = (id: string) => patchIncident(id, { is_archived: false })
/** Hard delete — the backend only permits this for Übungen (403 otherwise). */
export const deleteIncident = (id: string) => apiDelete(`/api/incidents/${id}`)

/** One-time migration: move the legacy single-workspace localStorage blob into a new
 *  "Migrierter Arbeitsstand" incident. Returns the new incident, or null if nothing to
 *  migrate / already migrated. */
const MIGRATION_FLAG = 'kp-front-migrated-v1'
export async function migrateLegacyWorkspace(
  legacyKeys: string[],
): Promise<IncidentFull | null> {
  if (localStorage.getItem(MIGRATION_FLAG)) return null
  let blob: Workspace | null = null
  for (const k of legacyKeys) {
    try {
      const raw = localStorage.getItem(k)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.entities)) {
          blob = parsed
          break
        }
      }
    } catch {
      /* skip corrupt */
    }
  }
  if (!blob) {
    localStorage.setItem(MIGRATION_FLAG, '1')
    return null
  }
  const inc = await createIncident({ title: appConfig.copy.incidents.migratedTitle })
  await putWorkspace(inc.id, blob, inc.workspace_rev)
  localStorage.setItem(MIGRATION_FLAG, '1')
  return inc
}
