import type { AttendanceState, BoardAnno, BoardDoc, BuildingDoc, CameraView, Drawing, Entity, LayerDef, LayerId, MittelEntry, TimelineEvent, Trupp, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { layers as initialLayers, planDocuments } from '../data/demoIncident'
import { referenceLayersFromConfig } from './deploymentConfig'
import type { ChecklistState } from './checklists'
import type { PlanScale } from './planScale'
import type { VehicleOverrides } from './useVehicleLayer'

/** Per-plan distance calibration, keyed by PlanDocument id (see lib/planScale). */
export type PlanScales = Record<string, PlanScale>

/** One partner-organisation contact row in the report (Polizei, Sanität, Werkhof …). */
export interface PartnerContact {
  org: string
  name?: string
  phone?: string
  note?: string
}

export interface ReportMeta {
  alarmText?: string
  summary?: string
  startedAt?: string
  endedAt?: string
  remarks?: string
  /** Lehren / Sicherheit — debrief notes (what to learn, safety observations) for the rapport */
  lehren?: string
  /** Kontaktperson vor Ort (Eigentümer / Melder / Verantwortlicher) */
  kontaktperson?: string
  /** Einsatzleiter — picked from the Mannschaft roster (free text allowed) */
  einsatzleiter?: string
  /** Alarmierungszeit (prefilled from the Divera alarm / incident start) */
  alarmiertAt?: string
  /** Ausrückzeit — manual for now; future enhancement: derive from first vehicle GPS movement. */
  ausgeruecktAt?: string
  /** Kontaktdaten der beteiligten Partnerorganisationen */
  partnerContacts?: PartnerContact[]
  /** Abschluss-Assistent: «keine Mittel verwendet» explicitly confirmed — the Mittel step
   *  counts as complete with zero entries only when someone said so, never by silence. */
  mittelConfirmedNone?: boolean
  /** Alarmierzeit je alarmierter Gruppe — ids from config `alarms.groups`; prefilled by
   *  the milestone webhook, `manual: true` entries are the operator's and never
   *  auto-overwritten. Unknown ids render as unmatched lines, never dropped. */
  gruppen?: GruppeZeit[]
  /** Fahrzeug-Zeitachse (Ausrückzeit / Vor Ort / Zurück) — ids from config
   *  `fleet.vehicles`; same prefill/manual semantics as `gruppen`. The header
   *  Ausgerückt is DERIVED from these once any exist (deriveAusgerueckt). */
  fahrzeuge?: FahrzeugZeit[]
  /** Gerettete Personen / Tiere (counts; absent ≠ 0 — absent means not recorded) */
  gerettete?: { personen?: number; tiere?: number }
  /** Wer über die Erfassung (/e/) erfasst hat — kommagetrennt, jede Person einmal */
  erfasser?: string
  /** Rückmeldung an die ELZ: wer hat wann zurückgemeldet */
  rueckmeldungElz?: { name?: string; at?: string }
}

export interface GruppeZeit {
  id: string
  alarmedAt?: string
  /** set by an operator edit — the milestone webhook keeps its hands off */
  manual?: boolean
}

export interface FahrzeugZeit {
  id: string
  ausgerueckt?: string
  vorOrt?: string
  zurueck?: string
  manual?: boolean
}

/** Per-incident, SYNCED operational settings — part of the workspace blob, so they
 *  apply identically on every device monitoring this incident (unlike device prefs
 *  like theme/symbol-size which live in the cookie). Absent fields fall back to the
 *  appConfig doctrine defaults. */
export interface IncidentSettings {
  /** Atemschutz Funkkontakt-Intervall (min): contact fällig (amber) from this mark.
   *  Safety-critical, so it MUST be shared across devices — hence synced, not a pref. */
  contactIntervalMin?: number
  /** Nachfrist (sec) on top of the interval before the hard überfällig alarm fires */
  contactGraceSec?: number
  /** default Funkkanal a new Atemschutz-Trupp is seeded with (FKS-Standard: 11) */
  defaultFunkkanal?: number
}

// The persisted-workspace model, extracted from App's god component: the `Saved` blob
// shape, the editable `Doc`, and the pure functions that normalize/derive App's initial
// state from a blob. No React here — kept separate so hooks/components can share it.

export type Doc = { entities: Entity[]; drawings: Drawing[] }

/** The persisted workspace blob — opaque to the backend; the frontend owns its shape. */
export interface Saved {
  entities: Entity[]; drawings: Drawing[]; recent: string[]
  layerState: { id: LayerId; visible: boolean; opacity?: number }[]; timeline: TimelineEvent[]
  board?: BoardDoc; activePlanId?: string; activeModule?: string
  /** the manually-picked Einsatzobjekt (PlanPicker «anderes Objekt»), synced per incident so it
   *  survives switching incidents AND shows the same plans on every device. Undefined → the
   *  auto-surfaced nearest object. (Was a single global device cookie; now lives in the blob.) */
  pickedObjectId?: string
  /** per-plan distance calibration (planId → scale factor); lets the Plan whiteboard show
   *  real metres once a printed reference is measured. See lib/planScale. */
  planScale?: PlanScales
  /** selected building promoted into the floor-stack ("Gebäude" doc) */
  building?: BuildingDoc | null
  /** manual position/orientation overrides for live GPS vehicles, keyed by entity id */
  vehicleOverrides?: VehicleOverrides
  /** per-incident checklist tick state (templateId → ticks + chosen branches) */
  checklists?: ChecklistState
  /** Atemschutzüberwachung: monitored breathing-apparatus teams */
  trupps?: Trupp[]
  /** per-incident attendance (who is physically present), keyed by Person id */
  attendance?: AttendanceState
  /** per-incident Mittel (material-use) — append-only event log; current state derived */
  mittel?: MittelEntry[]
  /** saved map views (camera bookmarks): position + zoom + rotation, shared with the team */
  cameraViews?: CameraView[]
  /** Einsatzrapport metadata: supplemental bookkeeping text, not tactical state. */
  reportMeta?: ReportMeta
  /** per-incident synced operational settings (see IncidentSettings) */
  settings?: IncidentSettings
  /** weather reading at the reconstructed instant — populated only by the replay fold
   *  (from `weather.observe` events), never persisted in live saves. */
  weather?: WeatherData | null
  schemaVersion?: number
}

type LegacyBoardAnno = Omit<BoardAnno, 'kind'> & { kind: BoardAnno['kind'] | 'trupp' }
const TEAM_COLORS = appConfig.drawing.colors

// Rauch used to be a `kind:'shape'` cloud; it is now the real «VKF Rauch» symbol (detail modal
// + Entwicklung/spread, both surfaces). Idempotently convert any already-placed cloud — map
// entity OR plan anno — so it gains the symbol behaviour: keep id/coord (or x,y,floor)/rotation,
// drop the shape-only sizing (symbols are fixed-scale; extent is expressed via spread). A no-op
// once no clouds remain, so it can run on every load without a schema-version bump.
export const RAUCH_SYMBOL = 'VKF Rauch'
export function migrateRauchCloud<T extends { kind?: string }>(a: T): T {
  const o = a as Record<string, unknown>
  if (o.kind !== 'shape' || o.shape !== 'cloud') return a
  const next: Record<string, unknown> = { ...o, kind: 'symbol', symbol: RAUCH_SYMBOL, label: 'Rauch' }
  delete next.shape; delete next.sizeM; delete next.sizeN; delete next.color
  return next as unknown as T
}

// Per-plan normalization: migrate the old 'trupp' kind to 'resource', and give every team
// an accent colour (cycled from the palette) so older saved docs — which predate per-team
// colours — still get distinguishable trails.
export const normalizeBoard = (board?: BoardDoc): BoardDoc => {
  if (!board) return {}
  return Object.fromEntries(Object.entries(board).map(([id, annos]) => {
    let teamIdx = 0
    return [id, annos.map((anno) => {
      const legacy = anno as LegacyBoardAnno
      const a = migrateRauchCloud(legacy.kind === 'trupp' ? { ...legacy, kind: 'resource' as const } : { ...anno })
      if (a.kind === 'resource') a.color = a.color ?? TEAM_COLORS[teamIdx++ % TEAM_COLORS.length]
      return a
    })]
  }))
}

/** Version stamped into every saved blob (App's buildPayload). Bump on a breaking shape
 *  change and add a stepwise migration in `sanitizeWorkspace` for the older versions. */
export const WORKSPACE_SCHEMA_VERSION = 1

/** Result of the load gate: the sanitized blob plus an honest account of what happened. */
export interface WorkspaceGate {
  ws: Saved | null
  /** malformed entries dropped (from collections) or wrong-typed fields reset */
  dropped: number
  /** blob was stamped by a NEWER app version — loaded best-effort, caller should warn */
  newerSchema: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hasId = (v: unknown): boolean => isObj(v) && typeof v.id === 'string' && v.id.length > 0

/**
 * Gate + sanitize a workspace blob BEFORE deriveInitial: a cached (IndexedDB) or server blob
 * can be stale, hand-edited, or written by a different app version, and one malformed entry
 * must never take down a live incident. Version-gate first (a newer blob loads best-effort
 * and is flagged; an older one runs stepwise migrations — none exist yet), then keep every
 * well-formed entry and drop the malformed rest, counting losses so the caller can surface
 * them instead of failing silently. Deliberately predicate-based (id/shape checks), not a
 * full schema: deep validation belongs to the type system at write time, this is the
 * last-line crash guard at read time.
 */
export function sanitizeWorkspace(raw: unknown): WorkspaceGate {
  if (raw == null) return { ws: null, dropped: 0, newerSchema: false }
  if (!isObj(raw)) return { ws: null, dropped: 1, newerSchema: false }
  let dropped = 0
  const arr = <T,>(v: unknown, ok: (x: unknown) => boolean): T[] | undefined => {
    if (v == null) return undefined
    if (!Array.isArray(v)) { dropped++; return undefined }
    const kept = v.filter(ok)
    dropped += v.length - kept.length
    return kept as T[]
  }
  const rec = <T,>(v: unknown): T | undefined => {
    if (v == null) return undefined
    if (!isObj(v)) { dropped++; return undefined }
    return v as T
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  // board needs one level more: normalizeBoard maps over each doc's anno ARRAY, so a
  // non-array value (or non-object anno) would crash it
  const board = ((): BoardDoc | undefined => {
    const b = rec<Record<string, unknown>>(raw.board)
    if (!b) return undefined
    const out: BoardDoc = {}
    for (const [k, v] of Object.entries(b)) {
      if (!Array.isArray(v)) { dropped++; continue }
      const kept = v.filter(isObj)
      dropped += v.length - kept.length
      out[k] = kept as unknown as BoardDoc[string]
    }
    return out
  })()
  const sv = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined
  // (stepwise migrations for sv < WORKSPACE_SCHEMA_VERSION go here once version 2 exists)
  const ws: Saved = {
    entities: (arr<Entity>(raw.entities, hasId) ?? []).map(migrateRauchCloud),
    drawings: arr<Drawing>(raw.drawings, hasId) ?? [],
    recent: arr<string>(raw.recent, (x) => typeof x === 'string') ?? [],
    layerState: arr<Saved['layerState'][number]>(raw.layerState, (x) => hasId(x) && typeof (x as { visible?: unknown }).visible === 'boolean') ?? [],
    timeline: arr<TimelineEvent>(raw.timeline, hasId) ?? [],
    board,
    activePlanId: str(raw.activePlanId),
    activeModule: str(raw.activeModule),
    pickedObjectId: str(raw.pickedObjectId),
    planScale: rec<PlanScales>(raw.planScale),
    building: raw.building === null ? null : rec<BuildingDoc>(raw.building),
    vehicleOverrides: rec<VehicleOverrides>(raw.vehicleOverrides),
    checklists: rec<ChecklistState>(raw.checklists),
    trupps: arr<Trupp>(raw.trupps, hasId),
    attendance: rec<AttendanceState>(raw.attendance),
    mittel: arr<MittelEntry>(raw.mittel, hasId),
    cameraViews: arr<CameraView>(raw.cameraViews, hasId),
    reportMeta: rec<ReportMeta>(raw.reportMeta),
    settings: rec<IncidentSettings>(raw.settings),
    schemaVersion: sv,
  }
  return { ws, dropped, newerSchema: sv != null && sv > WORKSPACE_SCHEMA_VERSION }
}

export interface InitialState {
  doc: Doc; layers: LayerDef[]; timeline: TimelineEvent[]; recent: string[]
  board: BoardDoc; building: BuildingDoc | null; vehicleOverrides: VehicleOverrides; activePlanId: string
  checklists: ChecklistState
  trupps: Trupp[]
  attendance: AttendanceState
  mittel: MittelEntry[]
  cameraViews: CameraView[]
  planScale: PlanScales
  reportMeta: ReportMeta
  settings: IncidentSettings
  pickedObjectId?: string
}

// the plan a fresh emergency opens on: Modul 1 (the Übersicht), falling back to the first
// document only if that slot is ever removed from the catalogue
const defaultPlanId = planDocuments.find((p) => p.id === 'modul1')?.id ?? planDocuments[0].id

/**
 * Switch ON every layer whose `autoActivate` names the incident's category (the German
 * `kategorien` value, e.g. "Brandbekämpfung" → hydrants). Additive only — it never hides a
 * layer, and layers already visible pass through unchanged (same array identity when
 * nothing matches, so it's safe in setState updaters).
 */
export function autoActivateLayers(layers: LayerDef[], kategorie: string | null | undefined): LayerDef[] {
  if (!kategorie) return layers
  const hit = layers.some((l) => !l.visible && l.autoActivate?.includes(kategorie))
  if (!hit) return layers
  return layers.map((l) => (!l.visible && l.autoActivate?.includes(kategorie) ? { ...l, visible: true } : l))
}

/**
 * Derive App's initial state slices from an incident's workspace blob (or empty for a
 * brand-new incident — no demo seed; a fresh incident starts blank). `prefs` carries the
 * remembered surface/plan so reopening the SAME incident honours it. `incidentType` (the
 * Einsatz category) pre-activates matching reference layers — but only on a workspace that
 * has never persisted layer state, so a deliberate hide is never overridden on reopen.
 */
export function deriveInitial(
  ws: Saved | null,
  incidentId: string,
  prefs: { incidentId?: string; activePlanId?: string; pickedObject?: { incidentId: string; objectId: string } },
  incidentType?: string | null,
): InitialState {
  const entities = ws?.entities ?? []
  const drawings = ws?.drawings ?? []
  // Built-in app layers (base maps + operational Lage layers) + the station's reference layers
  // from the deployment config. Append config layers only when their id is new, so the same
  // layer can never appear twice during a transition where a def lives in both places.
  const seen = new Set(initialLayers.map((l) => l.id))
  const allLayers = [...initialLayers, ...referenceLayersFromConfig().filter((l) => !seen.has(l.id))]
  let layers = ws?.layerState
    ? allLayers.map((l) => { const s = ws.layerState!.find((x) => x.id === l.id); return s ? { ...l, visible: s.visible, opacity: s.opacity } : l })
    : allLayers
  // A workspace whose selected base map no longer exists (base defs were trimmed) would
  // otherwise render NO background — fall back to the first base (Carto, the default).
  if (!layers.some((l) => l.base && l.visible)) {
    const fallbackId = layers.find((l) => l.base)?.id
    if (fallbackId) layers = layers.map((l) => (l.id === fallbackId ? { ...l, visible: true } : l))
  }
  // Category-driven pre-activation (hydrants for a fire, …) — fresh workspaces only:
  // once layerState has been persisted, the operator's own toggles are authoritative.
  if (!ws?.layerState) layers = autoActivateLayers(layers, incidentType)
  const ids = new Set(entities.map((e) => e.id))
  const timeline = (ws?.timeline ?? []).map((e) => (e.entityId && !ids.has(e.entityId) ? { ...e, entityId: undefined } : e))
  return {
    doc: { entities, drawings }, layers, timeline,
    recent: ws?.recent ?? [], board: normalizeBoard(ws?.board),
    building: ws?.building ?? null, vehicleOverrides: ws?.vehicleOverrides ?? {},
    // honour the remembered plan only when reopening the SAME incident — a new emergency
    // starts on Modul 1, not on whatever plan the last incident left in the cookie
    activePlanId: (prefs.incidentId === incidentId ? prefs.activePlanId : undefined)
      ?? ws?.activePlanId ?? ws?.activeModule ?? defaultPlanId,
    checklists: ws?.checklists ?? {},
    trupps: ws?.trupps ?? [],
    attendance: ws?.attendance ?? {},
    mittel: ws?.mittel ?? [],
    cameraViews: ws?.cameraViews ?? [],
    planScale: ws?.planScale ?? {},
    reportMeta: ws?.reportMeta ?? {},
    settings: ws?.settings ?? {},
    // synced per incident; one-time import of the legacy device-cookie pick for THIS incident so
    // an in-flight manual pick isn't dropped on upgrade (the blob value wins thereafter).
    pickedObjectId: ws?.pickedObjectId
      ?? (prefs.pickedObject?.incidentId === incidentId ? prefs.pickedObject.objectId : undefined),
  }
}
