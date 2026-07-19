// Data layer for the kp-front backend: incidents, workspace sync (offline cache +
// debounced last-write-wins save), audit events, media, Divera pool, objects, reference
// data. The workspace blob is opaque here — the App owns its `Saved` structure; we only
// move it to/from the server and the offline cache.

import { ApiError, apiBeacon, apiDelete, apiGet, apiGetRaw, apiPatch, apiPost, apiPut, apiUpload } from './api'
import { idbGet, idbSet } from './idb'
import { mergeWorkspace, type RecordConflict } from './mergeWorkspace'
import { appConfig } from '../config/appConfig'
import type { Person } from '../types'

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
export interface ReferenceDataset {
  id: string
  object_id: string | null
  module: string | null
  kind: string // 'pdf' | 'geojson' | 'symbols'
  title: string | null
  source_type: string
  source_note: string | null
  content_type: string | null
  size_bytes: number | null
  feature_count: number | null
  current_version: number
  updated_at: string
}
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
export type Workspace = Record<string, unknown>

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

export const getWorkspace = (id: string) =>
  apiGet<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`)
export const putWorkspace = (id: string, workspace: Workspace, base_rev: number) =>
  apiPut<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`, {
    workspace,
    base_rev,
  })
/** Fire-and-forget workspace PUT for page teardown — survives the document unloading. */
export const putWorkspaceBeacon = (id: string, workspace: Workspace, base_rev: number) =>
  apiBeacon(`/api/incidents/${id}/workspace`, { workspace, base_rev }, 'PUT')

/** Live-follow poll: 304 → null (unchanged); 200 → the current workspace + rev. */
export async function pollWorkspaceSince(
  id: string,
  sinceRev: number,
): Promise<{ workspace: Workspace | null; workspace_rev: number } | null> {
  const res = await apiGetRaw(`/api/incidents/${id}/workspace?since=${sinceRev}`)
  if (res.status === 304) return null
  if (!res.ok) throw new ApiError(res.status, 'Workspace-Poll fehlgeschlagen')
  return res.json()
}

// --- Audit events -------------------------------------------------------------------
export interface ClientEvent {
  op_type: string
  payload?: Record<string, unknown>
  occurred_at?: string
}
export const ingestEvents = (id: string, events: ClientEvent[]) =>
  apiPost(`/api/incidents/${id}/events`, { events })
/** Fire-and-forget event ingest for page teardown — survives the document unloading. */
export const ingestEventsBeacon = (id: string, events: ClientEvent[]) =>
  apiBeacon(`/api/incidents/${id}/events`, { events })
export const listEvents = (id: string) => apiGet<unknown[]>(`/api/incidents/${id}/events`)
export const verifyChain = (id: string) =>
  apiGet<{ intact: boolean; broken_at_seq: number | null; count: number; head?: string }>(`/api/incidents/${id}/verify`)

// --- Media --------------------------------------------------------------------------
export async function uploadMedia(
  id: string,
  file: Blob,
  kind: 'photo' | 'audio',
  filename = 'upload',
): Promise<{ id: string; url: string; kind: string }> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('kind', kind)
  return apiUpload(`/api/incidents/${id}/media`, form)
}

// --- Divera -------------------------------------------------------------------------
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
export const archiveDiveraAlarm = (diveraId: number) => apiDelete(`/api/divera/pool/${diveraId}`)
/** Attach a pool alarm to an EXISTING incident (split/Nachalarm dispatch) instead of
 *  opening a duplicate: the alarm's Meldung lands in the Verlauf and its GPS milestones
 *  follow to this incident; the incident's own title/location stay untouched. */
export const attachDiveraAlarm = (diveraId: number, incidentId: string) =>
  apiPost<{ ok: boolean; incident_id: string }>(`/api/divera/pool/${diveraId}/attach/${incidentId}`, {})

// --- Personnel (Mannschaft) ---------------------------------------------------------
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

// --- Geocoder (intake address autocomplete) -----------------------------------------
export interface GeoHit { label: string; lat: number; lng: number }
/** Region-biased swisstopo address search → ranked suggestions. Empty list on no match. */
export const geocodeSearch = (q: string, limit = 6) =>
  apiGet<GeoHit[]>(`/api/geocode/search?q=${encodeURIComponent(q)}&limit=${limit}`)

/** Reverse geocode a map-clicked WGS84 point → nearest registered address (or null). */
export const geocodeReverse = (lat: number, lng: number) =>
  apiGet<GeoHit | null>(`/api/geocode/reverse?lat=${lat}&lng=${lng}`)

// --- Objects + reference ------------------------------------------------------------
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
export const listReference = () => apiGet<ReferenceDataset[]>('/api/reference')
/** URL for fetching a reference dataset file (geojson/symbols/pdf), same-origin. */
export const referenceUrl = (id: string) => `/api/reference/${encodeURIComponent(id)}`
export async function uploadReference(id: string, file: Blob, filename: string, sourceNote?: string) {
  const form = new FormData()
  form.append('file', file, filename)
  if (sourceNote) form.append('source_note', sourceNote)
  return apiUpload<ReferenceDataset>(`/api/reference/${encodeURIComponent(id)}`, form, 'PUT')
}

/** A render-config entry for a per-station reference layer (mirrors the backend
 *  ReferenceLayerConfig / admin_geodata manifest — see deploymentConfig.ts). */
export interface ReferenceLayerInput {
  id: string
  group?: string
  label?: string
  icon?: string
  kind?: 'wms' | 'wmts' | 'geojson'
  tiles?: string[]
  geojson?: string
  vectorKind?: 'line' | 'point'
  symbol?: string
  color?: string
  nightColor?: string
  opacity?: number
  attribution?: string
  autoActivate?: string[]
}

/** Add (or replace by id) one reference layer in the deployment config. Read-modify-write
 *  on the full-document `PUT /api/config` (editor-only) — `integrations` is env-derived
 *  and stripped, mirroring ConfigEditor's save. This is the same render config the CLI
 *  `admin_geodata load` writes; it's what `referenceLayersFromConfig` turns into map layers. */
export async function upsertReferenceLayer(layer: ReferenceLayerInput): Promise<void> {
  const cfg = await apiGet<Record<string, unknown>>('/api/config')
  delete cfg.integrations
  const existing = Array.isArray(cfg.referenceLayers) ? (cfg.referenceLayers as ReferenceLayerInput[]) : []
  // Merge over the previous row (not replace): fields the panel doesn't edit — e.g. a
  // CLI-written `autoActivate` — survive a re-upload of the same layer id.
  const prev = existing.find((l) => l?.id === layer.id)
  cfg.referenceLayers = [...existing.filter((l) => l?.id !== layer.id), prev ? { ...prev, ...layer } : layer]
  await apiPut('/api/config', cfg)
}

/** Quick client-side GeoJSON sanity check so the operator gets immediate feedback before the
 *  upload: must be a FeatureCollection in WGS84 [lng, lat] (LV95-looking coords are rejected,
 *  matching the backend guard in admin_geodata). Returns the feature count or an error message. */
export async function inspectGeojson(file: Blob): Promise<{ ok: true; count: number } | { ok: false; msg: string }> {
  let data: unknown
  const copy = appConfig.copy.incidents
  try {
    data = JSON.parse(await file.text())
  } catch {
    return { ok: false, msg: copy.geojsonNotJson }
  }
  const fc = data as { type?: string; features?: unknown }
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return { ok: false, msg: copy.geojsonNotFc }
  }
  const c = firstCoord(fc.features as unknown[])
  if (c && (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
    return { ok: false, msg: copy.geojsonNotWgs84 }
  }
  return { ok: true, count: (fc.features as unknown[]).length }
}

/** First [x, y] pair under any feature geometry (any nesting). */
function firstCoord(features: unknown[]): [number, number] | null {
  const dig = (node: unknown): [number, number] | null => {
    if (Array.isArray(node)) {
      if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') return [node[0], node[1]]
      for (const child of node) { const r = dig(child); if (r) return r }
    }
    return null
  }
  for (const f of features) {
    const geom = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry
    if (geom) { const r = dig(geom.coordinates); if (r) return r }
  }
  return null
}

// External map deep-links (Geoportal/GeoView etc.) are station-supplied via the deployment
// config — see `externalMapLinks()` in ./deploymentConfig (no hardcoded portals here).

// --- Workspace sync: offline cache + debounced save with three-way merge -------------
// `base` is the last server revision we shared with everyone else — the common ancestor a
// conflict merges against (see mergeWorkspace). It rides the cache so an offline edit still
// has an ancestor to merge from on reconnect.
type CacheEntry = {
  workspace: Workspace
  baseRev: number
  dirty: boolean
  lastSyncedAt: number | null
  base?: Workspace
}
const cacheKey = (id: string) => `kp-front-ws-${id}`

function readCache(id: string): Promise<CacheEntry | null> {
  return idbGet<CacheEntry>(cacheKey(id))
}
// Fire-and-forget: the in-memory `entry` is the authoritative session state; this just keeps a
// durable copy for reload/offline. A storage failure is non-fatal (the server is authoritative),
// exactly like the old localStorage write that swallowed quota errors.
function writeCache(id: string, e: CacheEntry) {
  void idbSet(cacheKey(id), e)
}

/** Lifecycle of the per-incident sync, surfaced to the UI so unsynced/offline/error
 *  states are never silent: `synced` = server has our latest; `pending` = local edits
 *  not yet flushed; `offline` = a flush failed on the network (cached locally, will
 *  retry); `error` = a flush failed for another reason (also cached, also retried). */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error'

export interface WorkspaceSyncOptions {
  /** called whenever the synced revision changes (e.g. to update UI badges). */
  onRev?: (rev: number) => void
  /** called with the authoritative workspace when it must replace local state out-of-band
   *  (fallback when no in-place applier is registered — triggers a full remount). */
  onServerWorkspace?: (ws: Workspace, rev: number) => void
  /** called after a 409 was auto-merged, so the app can show a non-blocking notice. */
  onMerged?: () => void
  debounceMs?: number
}

/**
 * Per-incident sync engine. The App calls `save(workspace)` on every edit (replacing the
 * old direct localStorage write); we cache instantly, mark dirty, and flush to the server
 * debounced. `init()` loads from server (falling back to the offline cache).
 */
export class WorkspaceSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  private entry: CacheEntry
  private flushing = false
  private disposed = false
  private saveSeq = 0 // bumped on each save(); lets a flush detect an edit that landed mid-PUT
  private readonly debounceMs: number
  // Automatic retry after a FAILED flush (server 5xx / network drop): without it a dirty
  // workspace on an idle device stays unsynced forever — the live-poll gates on !hasUnsynced,
  // so it stops pulling too — until the operator happens to edit again. Exponential backoff,
  // reset on any successful push.
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  /** Registered by the live view to apply a merged/authoritative workspace IN PLACE (no
   *  remount), so an auto-merged conflict surfaces the other device's edits smoothly. Falls
   *  back to onServerWorkspace (a remount) when unset. */
  onApplyMerged?: (ws: Workspace, rev: number) => void
  /** Registered by the live view to reflect the sync lifecycle in the UI (status badge).
   *  Set after construction (like onApplyMerged); read the initial value via `syncStatus`. */
  onStatus?: (status: SyncStatus) => void
  /** Registered by the live view (useIncidentSync): a three-way merge saw BOTH sides change
   *  the SAME person's attendance to different values (LWW kept) — the caller appends one
   *  Verlauf note per person. Conflicts found before registration (init()'s cold-reopen
   *  merge) buffer until the first registration/drain. */
  onAttendanceConflicts?: (conflicts: RecordConflict[]) => void
  private conflictBuf: RecordConflict[] = []
  private status: SyncStatus

  constructor(
    private readonly incidentId: string,
    private readonly opts: WorkspaceSyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000
    // The cache lives in IndexedDB (async), so it can't be read in the constructor; init()
    // loads it before the first edit. Start empty/synced until then.
    this.entry = { workspace: {}, baseRev: 0, dirty: false, lastSyncedAt: null }
    this.status = 'synced'
  }

  /** Fire onStatus only on a real transition (de-dupes repeated saves while pending). */
  private setStatus(s: SyncStatus) {
    if (this.status === s) return
    this.status = s
    this.onStatus?.(s)
  }

  /** mergeWorkspace with attendance-divergence reporting: collected conflicts go to the
   *  registered listener, or buffer until one registers (init runs before the view mounts). */
  private mergeReporting(base: Workspace, mine: Workspace, theirs: Workspace): Workspace {
    const conflicts: RecordConflict[] = []
    const merged = mergeWorkspace(base, mine, theirs, (c) => conflicts.push(c))
    if (conflicts.length) {
      if (this.onAttendanceConflicts) this.onAttendanceConflicts(conflicts)
      else this.conflictBuf.push(...conflicts)
    }
    return merged
  }

  /** Conflicts reported before a listener registered (init()'s cold-reopen merge) — the
   *  live view drains them once on mount, then follows via onAttendanceConflicts. */
  drainAttendanceConflicts(): RecordConflict[] {
    const buf = this.conflictBuf
    this.conflictBuf = []
    return buf
  }

  /** Load initial state: prefer server; fall back to offline cache when offline. */
  async init(): Promise<{ workspace: Workspace | null; rev: number; fromCache: boolean }> {
    // Read the offline cache once up front and seed entry/status from it, so the sync badge is
    // correct even while the server fetch is in flight (and so a cold offline reopen restores
    // unsynced edits immediately). The server fetch below refines this.
    const cached = await readCache(this.incidentId)
    if (cached) {
      this.entry = cached
      this.setStatus(cached.dirty ? 'pending' : 'synced')
    }
    try {
      const { workspace, workspace_rev } = await getWorkspace(this.incidentId)
      if (cached?.dirty) {
        // Unsynced local edits sit in the offline cache. If they're at the same base the server
        // is at, keep them verbatim. If the server advanced while we were offline (a cold reopen
        // after another device pushed), three-way merge our edits against it using the cached
        // ancestor — the reopen analogue of the live 409 path — so independent edits both survive
        // instead of the local ones being silently dropped. The merge result stays dirty and a
        // later flush pushes it at the new rev.
        if (cached.baseRev === workspace_rev) {
          this.entry = cached
          this.setStatus('pending')
          return { workspace: cached.workspace, rev: workspace_rev, fromCache: true }
        }
        const server = workspace ?? {}
        const merged = this.mergeReporting(cached.base ?? {}, cached.workspace, server)
        this.entry = { workspace: merged, base: server, baseRev: workspace_rev, dirty: true, lastSyncedAt: cached.lastSyncedAt }
        writeCache(this.incidentId, this.entry)
        this.opts.onRev?.(workspace_rev)
        this.setStatus('pending')
        return { workspace: merged, rev: workspace_rev, fromCache: true }
      }
      const ws = workspace ?? {}
      this.entry = { workspace: ws, base: ws, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
      writeCache(this.incidentId, this.entry)
      this.opts.onRev?.(workspace_rev)
      this.setStatus('synced')
      return { workspace, rev: workspace_rev, fromCache: false }
    } catch (e) {
      if (cached) {
        this.entry = cached
        this.setStatus(cached.dirty ? 'pending' : 'synced')
        return { workspace: cached.workspace, rev: cached.baseRev, fromCache: true }
      }
      throw e
    }
  }

  /** Queue a save. Writes the offline cache immediately; flushes to server debounced. */
  save(workspace: Workspace) {
    if (this.disposed) return
    this.saveSeq++
    this.entry = { ...this.entry, workspace, dirty: true }
    writeCache(this.incidentId, this.entry)
    this.setStatus('pending')
    this.armDebounce()
  }

  private armDebounce() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
  }

  /** Force a synchronous-ish flush (tab hide / beforeunload / reconnect / incident switch). */
  async flush(): Promise<void> {
    if (this.flushing || !this.entry.dirty || this.disposed) return
    this.flushing = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      await this.pushCurrent()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await this.resolveConflict()
      } else if (e instanceof ApiError && e.status === 0) {
        this.setStatus('offline') // stay dirty; the `online` event or the backoff retries
      } else {
        this.setStatus('error') // server/other error; stay dirty, retried by the backoff
      }
    } finally {
      this.flushing = false
      // Still dirty with no flush queued (offline / server error / exhausted merge retries)
      // → arm the automatic backoff so an idle device recovers without a manual sync.
      if (this.entry.dirty && !this.timer) this.scheduleRetry()
    }
  }

  /** Exponential-backoff re-flush: 5s · 10s · 20s · 40s · then every 60s while dirty. */
  private scheduleRetry() {
    if (this.disposed) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = Math.min(60_000, 5_000 * 2 ** this.retryCount)
    this.retryCount++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, delay)
  }

  /**
   * Last-ditch flush for page teardown (tab hidden / pagehide). The async flush() above
   * issues a normal fetch that the browser aborts the instant the document unloads — on iOS
   * PWAs (backgrounded / locked / swiped away) that's the usual path, so edits made inside
   * the debounce window reach only this device's cache and are lost on any other device.
   * This fires a `keepalive` PUT the browser completes after teardown. Fire-and-forget: we
   * can't await or merge the response while the page is dying, so dirty/baseRev stay as-is —
   * a same-device reopen still reconciles from the cache, and once the server accepts this
   * push every device's next load (or live-poll) pulls the up-to-date revision. If the push
   * raced a concurrent server edit (409) it's simply dropped server-side; the next real
   * flush() resolves it via the normal three-way merge. No-op when clean. */
  flushKeepalive(): void {
    if (!this.entry.dirty || this.disposed) return
    putWorkspaceBeacon(this.incidentId, this.entry.workspace, this.entry.baseRev)
  }

  // Push the current workspace at the current baseRev. On success, advance baseRev and
  // clear dirty — UNLESS a newer save() landed during the in-flight PUT (detected via
  // saveSeq), in which case the newest content stays dirty and we re-arm a flush so it
  // isn't silently marked synced-but-never-sent. Throws on 409/other for the caller.
  private async pushCurrent(): Promise<void> {
    const seqAtStart = this.saveSeq
    const pushed = this.entry.workspace
    const { workspace_rev } = await putWorkspace(this.incidentId, pushed, this.entry.baseRev)
    this.retryCount = 0 // server accepted a push → backoff starts over on the next failure
    if (this.saveSeq === seqAtStart) {
      // server now holds exactly what we pushed → that becomes the new merge ancestor.
      this.entry = { ...this.entry, base: pushed, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
      this.setStatus('synced')
    } else {
      // a newer edit arrived mid-flush — keep it dirty (rebased) and schedule another flush.
      // The ancestor is still what we just pushed (the part the server has).
      this.entry = { ...this.entry, base: pushed, baseRev: workspace_rev, lastSyncedAt: Date.now() }
      this.setStatus('pending')
      this.armDebounce()
    }
    writeCache(this.incidentId, this.entry)
    this.opts.onRev?.(workspace_rev)
  }

  // The server moved ahead of us (409). Instead of one whole snapshot winning, three-way
  // merge our edits and the server's against their common ancestor (entry.base) and push the
  // union: independent edits both survive, same-object edits are last-writer-wins, deletes
  // beat concurrent edits. We're inside an in-flight flush(), so push DIRECTLY (calling
  // flush() would see flushing===true and no-op). Retry on a fresh 409 by re-merging.
  private async resolveConflict() {
    // The content that 409'd — the common ancestor for any local edit that lands while the
    // merge PUT is in flight (so that newer edit can be re-based onto the merge, not lost).
    const mine0 = this.entry.workspace
    for (let attempt = 0; attempt < 4; attempt++) {
      const server = await getWorkspace(this.incidentId)
      const merged = this.mergeReporting(this.entry.base ?? {}, this.entry.workspace, server.workspace ?? {})
      this.entry = { ...this.entry, workspace: merged, base: server.workspace ?? {}, baseRev: server.workspace_rev, dirty: true }
      writeCache(this.incidentId, this.entry)
      try {
        const seqAtStart = this.saveSeq
        const { workspace_rev } = await putWorkspace(this.incidentId, merged, server.workspace_rev)
        this.opts.onRev?.(workspace_rev)
        this.retryCount = 0 // merge landed → backoff starts over on the next failure
        if (this.saveSeq === seqAtStart) {
          this.entry = { ...this.entry, base: merged, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
          writeCache(this.incidentId, this.entry)
          this.setStatus('synced')
          // Surface the merged union to the live view in place, so the resolver sees the other
          // device's additions without a remount.
          if (this.onApplyMerged) this.onApplyMerged(merged, workspace_rev)
          else this.opts.onServerWorkspace?.(merged, workspace_rev)
        } else {
          // A local edit landed during the merge PUT. It was built on `mine0` (pre-merge), so
          // re-base it onto the merged result — otherwise pushing it blindly next flush would
          // overwrite the remote additions we just merged in. Different objects all survive.
          const remerged = mergeWorkspace(mine0, this.entry.workspace, merged)
          this.entry = { ...this.entry, workspace: remerged, base: merged, baseRev: workspace_rev, dirty: true, lastSyncedAt: Date.now() }
          writeCache(this.incidentId, this.entry)
          this.setStatus('pending')
          this.armDebounce()
        }
        this.opts.onMerged?.()
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) continue // someone else landed too — re-merge
        this.setStatus(e instanceof ApiError && e.status === 0 ? 'offline' : 'error')
        return // offline/other: stay dirty + merged; a later flush retries
      }
    }
    // retries exhausted — leave it dirty for a later flush to pick up
    this.setStatus('error')
  }

  /**
   * Adopt a server revision the app fetched out-of-band (the live-follow poll), rebasing
   * our cache onto it so the NEXT local edit pushes at the right base_rev instead of 409ing.
   * Drops any local dirty state, so callers must only adopt when not dirty — the live-follow
   * poll gates on `!hasUnsynced` for exactly this reason. Keeping every (non-editing) device
   * rebased on the latest rev also means genuine conflicts only arise on truly simultaneous
   * edits, not on a stale base.
   */
  adoptServer(workspace: Workspace, rev: number) {
    if (this.disposed) return
    this.entry = { workspace, base: workspace, baseRev: rev, dirty: false, lastSyncedAt: Date.now() }
    writeCache(this.incidentId, this.entry)
    this.opts.onRev?.(rev)
    this.setStatus('synced')
  }

  get rev(): number {
    return this.entry.baseRev
  }
  get hasUnsynced(): boolean {
    return this.entry.dirty
  }
  get syncStatus(): SyncStatus {
    return this.status
  }
  /** epoch ms of the last successful server sync, or null if never synced this session. */
  get lastSyncedAt(): number | null {
    return this.entry.lastSyncedAt
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }
}

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
