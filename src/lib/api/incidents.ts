// Incident CRUD + the offline-resilient active list, plus the one-time legacy-workspace
// migration. Other incident subresources live in sibling modules: workspace blob (./workspace),
// audit events (./events), media (./media).
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import { idbGet, idbSet, readThrough } from '../idb'
import { appConfig } from '../../config/appConfig'
import { putWorkspace, type Workspace } from './workspace'

// --- Types (mirror backend schemas) -------------------------------------------------
/** `Incident.status` values that mean the Einsatz is RUNNING — mirrors the backend's
 *  `INCIDENT_ACTIVE_STATUSES`. "offen" is what every intake writes; "in_arbeit" is what an
 *  editor sets once somebody is working it (shown as «In Arbeit» in the Einsatz list). */
export const INCIDENT_ACTIVE_STATUSES = ['offen', 'in_arbeit']

/** Is this Einsatz still running? The client-side twin of the backend's `Incident.is_open`,
 *  and the one place to ask — a hand-written copy that drifts from the server's answer shows
 *  affordances the API then refuses (or hides ones it would allow).
 *
 *  `closed_at` is deliberately NOT consulted: it is the first Einsatzende as a TIMESTAMP, kept
 *  across a reopen so later rows read as Nachträge (see lib/reminders, lib/report). Treating it
 *  as a liveness flag left a reactivated Einsatz half-dead. `is_archived` is the state. */
export function isIncidentRunning(i: Pick<IncidentMeta, 'is_archived' | 'status'>): boolean {
  return !i.is_archived && INCIDENT_ACTIVE_STATUSES.includes(i.status)
}

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
/** A cache entry that is not a list at all is no list. The launcher filters this on every
 *  offline boot, so a corrupt entry used to throw at the root boundary on every launch, with
 *  no incident open to escape from. */
const isIncidentList = (v: unknown): v is IncidentMeta[] => Array.isArray(v)
export async function cacheIncidentList(list: IncidentMeta[]): Promise<void> {
  await idbSet(INCIDENT_LIST_CACHE, list)
}
/** The cached list, or [] — see `isIncidentList`. */
export async function readCachedIncidentList(): Promise<IncidentMeta[]> {
  const cached = await idbGet<unknown>(INCIDENT_LIST_CACHE)
  return isIncidentList(cached) ? cached : []
}
/** Fetch the active list online (and cache it); when the server could not be asked (offline,
 *  timeout, or a gateway in front of a restarting server — api · isUnverifiable) fall back to
 *  the cache. A real refusal (401, 500, …) still throws: that is an answer, not silence. */
export async function listIncidentsResilient(): Promise<{ list: IncidentMeta[]; offline: boolean }> {
  const { source, value } = await readThrough<IncidentMeta[]>(INCIDENT_LIST_CACHE, () => listIncidents(false), {
    validate: isIncidentList,
    fallback: () => [],
  })
  return { list: value, offline: source !== 'network' }
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
