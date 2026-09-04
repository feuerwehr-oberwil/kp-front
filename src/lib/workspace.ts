import type { AttendanceState, BoardAnno, BoardDoc, BoardKind, BoardPoint, BuildingDoc, CameraView, DrawKind, Drawing, Entity, EntityKind, GeoTrailPoint, LayerDef, LayerId, LngLat, MittelEntry, ReportAttachment, Shift, ShiftBand, TimelineEvent, TrailPoint, Trupp, TruppReading, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { layers as initialLayers, planDocuments } from '../data/demoIncident'
import { referenceLayersFromConfig } from './deploymentConfig'
import { keyCartoTileTemplates } from './carto'
import type { ChecklistState } from './checklists'
import type { KrokiView } from './report'
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
  /** Kontaktperson on scene (owner / Melder / person in charge) */
  kontaktperson?: string
  /** Kontaktperson's phone number — kept next to the name so the Nachbearbeitung (a callback
   *  about the damage, the owner who has to be reached tomorrow) does not depend on someone
   *  having copied it into the Kurzbericht. Free text as typed; dialing normalizes (telHref). */
  kontaktpersonTelefon?: string
  /** «Entfällt» — the Kontaktperson step ANSWERED rather than left blank.
   *
   *  A Fehlalarm in an empty Altersheim and an Ölspur on a Kantonsstrasse have nobody to name,
   *  and without a way of saying so the step stayed open forever: the rapport could never reach
   *  complete, and every single print opened with «Angaben fehlen noch» — the dialog that has to
   *  mean something on the Einsatz where something really is missing. Same escape
   *  `mittelConfirmedNone` has given the Mittel step all along; «nicht ausgefüllt» and «gibt es
   *  nicht» are two different answers and only one of them was recordable. */
  kontaktpersonNone?: boolean
  /** Einsatzleiter — picked from the Mannschaft roster (free text allowed) */
  einsatzleiter?: string
  /** Alarmierungszeit (prefilled from the Divera alarm / incident start) */
  alarmiertAt?: string
  /** Ausrückzeit — manual for now; future enhancement: derive from first vehicle GPS movement. */
  ausgeruecktAt?: string
  /** contact details of the Partnerorganisationen involved */
  partnerContacts?: PartnerContact[]
  /** Abschluss-Assistent: «keine Mittel verwendet» explicitly confirmed — the Mittel step
   *  counts as complete with zero entries only when someone said so, never by silence. */
  mittelConfirmedNone?: boolean
  /** Alarmierzeit per alarmed Gruppe — ids from config `alarms.groups`; prefilled by
   *  the milestone webhook, `manual: true` entries are the operator's and never
   *  auto-overwritten. Unknown ids render as unmatched lines, never dropped. */
  gruppen?: GruppeZeit[]
  /** Fahrzeug timeline (Ausrückzeit / Vor Ort / Zurück) — ids from config
   *  `fleet.vehicles`; same prefill/manual semantics as `gruppen`. The header
   *  Ausgerückt is DERIVED from these once any exist (deriveAusgerueckt). */
  fahrzeuge?: FahrzeugZeit[]
  /** How the Kroki was framed for the LAST print of this Einsatz — the crop, the moment it
   *  shows, and the page shape. Remembered so a reprint (a correction, a second copy for the
   *  Gemeinde) comes out of the same window instead of being framed from scratch. */
  krokiPrint?: { view?: KrokiView; at?: string; landscape?: boolean }
  /** When a rapport was last PRODUCED from this Einsatz — a PDF downloaded, or a station print
   *  job the relay has reported `done`. It is what lets the Rapport say «der Einsatz ist noch
   *  offen» at the one moment that is actually true — the paper exists, everything is filled in,
   *  and only the bookkeeping is left. In the blob rather than on the device because the Einsatz
   *  is worked on from several of them: whoever opens the Rapport next should see that the paper
   *  has already been made.
   *
   *  ⚠️ A QUEUED job does NOT stamp this (fixed 22.08.). It used to be set the instant the job
   *  left the device — including straight after the confirm that said «Stationsdrucker offline» —
   *  and this stamp alone drives the «Rapport erstellt. Der Einsatz ist noch offen –
   *  abschliessen?» band. So the app offered to close an Einsatz whose rapport did not exist on
   *  any sheet of paper anywhere. See `printJob` for the state in between. */
  reportMadeAt?: string
  /** The station print job this rapport is waiting on: set when it is queued, cleared when the
   *  relay reports a terminal status. «In der Warteschlange» is a state of its own, not a
   *  weaker «gesendet» — so it lives on the blob (visible after a reload and on the next
   *  device) rather than only inside the toast that announced it, which is gone in seconds. */
  printJob?: { id: string; at: string }
  /** Gerettete: people / animals (counts; absent ≠ 0 — absent means not recorded) */
  gerettete?: { personen?: number; tiere?: number }
  /** «Keine» — nobody and nothing was rescued, said out loud (04.09., Rapport-Review).
   *
   *  ⚠️ The whole point is that `gerettete` being absent no longer has to carry four meanings at
   *  once. On the 03.09. Rapport the field was empty, and empty could mean: nobody was rescued ·
   *  it was never looked into · it was rescued but not recorded · it does not apply here. With
   *  this flag, empty means exactly one of them — not recorded — and the other answer has
   *  somewhere to go. Same escape `kontaktpersonNone`, `rueckmeldungNone` and
   *  `mittelConfirmedNone` already are; the word is «Keine» rather than «Entfällt» because a
   *  rescue is a thing that either happened or did not, not a section that can be irrelevant. */
  geretteteNone?: boolean
  /** who recorded via the Erfassung (/e/) — comma-separated, each person once */
  erfasser?: string
  /** Rückmeldung to the ELZ: who reported back, and when */
  rueckmeldungElz?: { name?: string; at?: string }
  /** «Entfällt» for the Rückmeldung ELZ — the same deliberate answer as `kontaktpersonNone`,
   *  for the Einsatz the ELZ was never told about because there was nothing to tell. */
  rueckmeldungNone?: boolean
  /** Which of the station's Rapport-Links (config `report.links`, see lib/reportLinks) have
   *  been dealt with on THIS Einsatz — link id → the instant it was ticked.
   *
   *  ⚠️ The tick is always a person's, never the app's: opening a form tells us nothing about
   *  whether it was submitted, so nothing here is ever set automatically. It lives in the blob
   *  rather than on the device because the Einsatz is worked from several of them — whoever
   *  opens the Rapport next has to see that the Getränke-Formular is already away. */
  linksDone?: Record<string, string>
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
  /** grace period (sec) on top of the interval before the hard überfällig alarm fires */
  contactGraceSec?: number
  /** default Funkkanal a new Atemschutz-Trupp is seeded with (FKS standard: 11) */
  defaultFunkkanal?: number
}

/** The safety values, in the order the Einstellungen sheet asks them. */
export const SAFETY_KEYS = ['contactIntervalMin', 'contactGraceSec', 'defaultFunkkanal'] as const
export type SafetyKey = (typeof SAFETY_KEYS)[number]

/**
 * Which Atemschutz safety value changed, and from what to what.
 *
 * These decide WHEN a Trupp counts as fällig and as überfällig. Moving the interval mid-Einsatz
 * moves every clock on the Atemschutz board at once, and it used to leave no trace of any kind —
 * neither a Verlaufszeile nor an audit event. The reconstruction afterwards could see that a
 * Trupp went overdue but not that the threshold had been moved under it.
 *
 * `defaults` resolves an unset value, so «vom Standard 10 auf 20» reads as a real change rather
 * than as `undefined → 20`. Returns [] when nothing moved, so the caller can stay silent.
 */
export function changedSafetySettings(
  prev: IncidentSettings, next: IncidentSettings, defaults: Record<SafetyKey, number>,
): { key: SafetyKey; from: number; to: number }[] {
  const out: { key: SafetyKey; from: number; to: number }[] = []
  for (const key of SAFETY_KEYS) {
    const from = prev[key] ?? defaults[key]
    const to = next[key] ?? defaults[key]
    if (from !== to) out.push({ key, from, to })
  }
  return out
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
  /** Schichtenplanung: planned availability per person (a PLAN, never the attendance record) */
  shifts?: Shift[]
  /** Schichtenplanung: the named time windows the Schichten grid puts up as columns. Inert —
   *  a band assigns nobody; a shift joins one by carrying its `bandId`. */
  bands?: ShiftBand[]
  /** saved map views (camera bookmarks): position + zoom + rotation, shared with the team */
  cameraViews?: CameraView[]
  /** Einsatzrapport metadata: supplemental bookkeeping text, not tactical state. */
  reportMeta?: ReportMeta
  /** Beilagen: photos that belong to the Rapport (documents, damage) rather than to the Verlauf */
  attachments?: ReportAttachment[]
  /** per-incident synced operational settings (see IncidentSettings) */
  settings?: IncidentSettings
  /** When the dispatch's guesses (Stichwort, Kategorie, Ort) were confirmed or corrected — the
   *  «Einsatzdaten prüfen» banner's one-shot stamp, see lib/incidentAlerts · needsIntakeReview.
   *
   *  On the blob rather than on the device because the question is asked ONCE of the crew, not
   *  once of every tablet: until 25.08. this was a localStorage set, so the Einsatz that had
   *  already been checked at the desk still nagged the phone, the second tablet and everyone who
   *  joined later. Whoever taps «Passt» stamps it here, and the next poll retires the banner
   *  everywhere. Only an editor can write it; the device set stays as the offline fallback. */
  intakeReviewedAt?: string
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
const hasId = (v: unknown): v is Record<string, unknown> & { id: string } => isObj(v) && typeof v.id === 'string' && v.id.length > 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// --- Shape predicates ---------------------------------------------------------------------
// One malformed OBJECT in a synced collection used to take every device down together: the
// gate below only asked «object with a string id», and the first consumer of a `line` whose
// `coords` was null was a first-render useMemo — so the boundary fired before any surface
// mounted, «Neu laden» re-pulled the same blob, and «Lokale Kopie verwerfen» too (verified
// 25.07.). These predicates ask the question each renderer would otherwise ask by throwing.

/** Every member of a string union as a Set, checked BOTH ways at compile time: each listed value
 *  must be in the union (`readonly T[]`), and every union member must be listed (the intersection
 *  with `Complete` collapses to `never` when one is missing). So a kind added to `types.ts`
 *  without a row here fails `tsc` instead of being silently dropped from every incident. */
type Complete<T extends string, U extends readonly string[]> = Exclude<T, U[number]> extends never ? unknown : never
const kindSet = <T extends string>() => <const U extends readonly T[]>(u: U & Complete<T, U>): ReadonlySet<string> => new Set<string>(u)
const ENTITY_KINDS = kindSet<EntityKind>()(['symbol', 'vehicle', 'note', 'photo', 'shape', 'team', 'person'])
const DRAW_KINDS = kindSet<DrawKind>()(['line', 'area', 'circle'])
const BOARD_KINDS = kindSet<BoardKind>()(['draw', 'area', 'circle', 'text', 'symbol', 'shape', 'resource'])
/** the pre-'resource' board kind, still accepted at the gate because normalizeBoard migrates it */
const LEGACY_BOARD_KINDS: ReadonlySet<string> = new Set([...BOARD_KINDS, 'trupp'])
/** fewest vertices a drawing of each kind can render with (a circle is its centre) */
const MIN_DRAW_PTS: Record<DrawKind, number> = { circle: 1, line: 2, area: 3 }

const lngLat = (v: unknown): v is LngLat =>
  Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90
const boardPt = (v: unknown): v is BoardPoint => Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(num)
const isReading = (v: unknown): v is TruppReading => isObj(v) && typeof v.t === 'string' && num(v.bar) && typeof v.kind === 'string'
const isGeoTrailPt = (v: unknown): v is GeoTrailPoint => isObj(v) && lngLat(v.coord) && typeof v.t === 'string'
const isTrailPt = (v: unknown): v is TrailPoint => isObj(v) && num(v.x) && num(v.y) && typeof v.t === 'string'

/** A map entity the markers can place: known kind and a finite, in-range [lng, lat]. */
export const isEntity = (v: unknown): v is Entity =>
  hasId(v) && typeof v.kind === 'string' && ENTITY_KINDS.has(v.kind) && lngLat(v.coord)
/** A drawing the map can render: known kind, enough finite vertices for it, and a radius for a circle. */
export const isDrawing = (v: unknown): v is Drawing =>
  hasId(v) && typeof v.kind === 'string' && DRAW_KINDS.has(v.kind)
  && Array.isArray(v.coords) && v.coords.length >= MIN_DRAW_PTS[v.kind as DrawKind] && v.coords.every(lngLat)
  && (v.kind !== 'circle' || num(v.radiusM))
/** A plan annotation the Whiteboard can draw: ink needs enough finite vertices, everything else an anchor. */
export const isBoardAnno = (v: unknown): v is BoardAnno =>
  hasId(v) && typeof v.kind === 'string' && LEGACY_BOARD_KINDS.has(v.kind)
  && (v.kind === 'draw' || v.kind === 'area'
    ? Array.isArray(v.pts) && v.pts.length >= (v.kind === 'area' ? 3 : 2) && v.pts.every(boardPt)
    : num(v.x) && num(v.y))
/** A Gebäude doc the floor-stack can open: at least one finite storey and a footprint of some shape. */
export const isBuilding = (v: unknown): v is BuildingDoc =>
  isObj(v) && Array.isArray(v.floors) && v.floors.length > 0 && v.floors.every(num)
  && (Array.isArray(v.rings) || Array.isArray(v.ring) || Array.isArray(v.src))

/**
 * Gate + sanitize a workspace blob BEFORE deriveInitial: a cached (IndexedDB) or server blob
 * can be stale, hand-edited, or written by a different app version, and one malformed entry
 * must never take down a live incident. Version-gate first (a newer blob loads best-effort
 * and is flagged; an older one runs stepwise migrations — none exist yet), then keep every
 * well-formed entry and drop the malformed rest, counting losses so the caller can surface
 * them instead of failing silently. Deliberately predicate-based (the shape predicates above),
 * not a full schema: deep validation belongs to the type system at write time, this is the
 * last-line crash guard at read time.
 *
 * Two verbs, on purpose: geometry that cannot render is DROPPED (the object is unusable), while
 * the string fields the panels `.trim()` / `.localeCompare()` are COERCED to '' — a Trupp without
 * a name is still a crew under air, and losing its clock over a missing label is the wrong trade.
 */
export function sanitizeWorkspace(raw: unknown): WorkspaceGate {
  if (raw == null) return { ws: null, dropped: 0, newerSchema: false }
  if (!isObj(raw)) return { ws: null, dropped: 1, newerSchema: false }
  let dropped = 0
  // `ok` is a plain boolean for the id-only collections (hasId narrows to less than T); the
  // shape-gated ones pass a real predicate and read as T either way
  const arr = <T,>(v: unknown, ok: (x: unknown) => boolean, fix?: (x: T) => T): T[] | undefined => {
    if (v == null) return undefined
    if (!Array.isArray(v)) { dropped++; return undefined }
    const kept = v.filter(ok) as T[]
    dropped += v.length - kept.length
    return fix ? kept.map(fix) : kept
  }
  const rec = <T,>(v: unknown): T | undefined => {
    if (v == null) return undefined
    if (!isObj(v)) { dropped++; return undefined }
    return v as T
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  // Coerce the named string fields on one object to strings; a present wrong-typed value counts
  // as a reset, an absent one is quietly '' (an older writer simply did not know the field).
  const strFields = <T extends object>(o: T, keys: (keyof T & string)[]): T => {
    const r = o as Record<string, unknown>
    if (keys.every((k) => typeof r[k] === 'string')) return o
    const out = { ...r }
    for (const k of keys) if (typeof out[k] !== 'string') { if (out[k] != null) dropped++; out[k] = '' }
    return out as T
  }
  const fixTrupp = (t: Trupp): Trupp => {
    const o = strFields(t, ['name']) as Trupp & { readings?: unknown }
    if (o.readings == null) return o
    const readings = arr<TruppReading>(o.readings, isReading)
    return { ...o, readings }
  }
  // board needs one level more: normalizeBoard maps over each doc's anno ARRAY, so a
  // non-array value (or non-object anno) would crash it — and past that, the Whiteboard
  // derefs `pts` / `x` / `y` per kind
  const board = ((): BoardDoc | undefined => {
    const b = rec<Record<string, unknown>>(raw.board)
    if (!b) return undefined
    const out: BoardDoc = {}
    for (const [k, v] of Object.entries(b)) {
      const annos = arr<BoardAnno>(v, isBoardAnno, (a) => (a.trail == null ? a : { ...a, trail: arr<TrailPoint>(a.trail, isTrailPt) }))
      if (annos) out[k] = annos
    }
    return out
  })()
  // Numeric doctrine overrides: anything that is not a usable number is REMOVED, not kept —
  // `NaN * 60` in the überfällig arithmetic silently disables the alarm, and an absent key
  // falls back to the station doctrine. Only the Nachfrist may be zero (a real setting).
  const settings = ((): IncidentSettings | undefined => {
    const s = rec<Record<string, unknown>>(raw.settings)
    if (!s) return undefined
    const out: IncidentSettings = {}
    for (const key of SAFETY_KEYS) {
      const v = s[key]
      if (v == null) continue
      if (num(v) && (key === 'contactGraceSec' ? v >= 0 : v > 0)) out[key] = v
      else dropped++
    }
    return out
  })()
  const building = ((): BuildingDoc | null | undefined => {
    if (raw.building == null) return raw.building
    if (isBuilding(raw.building)) return raw.building
    dropped++
    return null // deriveInitial reads null as «no Gebäude»; a half doc would crash the Kroki
  })()
  const sv = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined
  // (stepwise migrations for sv < WORKSPACE_SCHEMA_VERSION go here once version 2 exists)
  const ws: Saved = {
    entities: (arr<Entity>(raw.entities, isEntity, (e) => (e.trail == null ? e : { ...e, trail: arr<GeoTrailPoint>(e.trail, isGeoTrailPt) })) ?? []).map(migrateRauchCloud),
    drawings: arr<Drawing>(raw.drawings, isDrawing) ?? [],
    recent: arr<string>(raw.recent, (x) => typeof x === 'string') ?? [],
    layerState: arr<Saved['layerState'][number]>(raw.layerState, (x) => hasId(x) && typeof x.visible === 'boolean') ?? [],
    timeline: arr<TimelineEvent>(raw.timeline, hasId, (e) => strFields(e, ['text', 't'])) ?? [],
    board,
    activePlanId: str(raw.activePlanId),
    activeModule: str(raw.activeModule),
    pickedObjectId: str(raw.pickedObjectId),
    planScale: rec<PlanScales>(raw.planScale),
    building,
    vehicleOverrides: rec<VehicleOverrides>(raw.vehicleOverrides),
    checklists: rec<ChecklistState>(raw.checklists),
    trupps: arr<Trupp>(raw.trupps, hasId, fixTrupp),
    attendance: rec<AttendanceState>(raw.attendance),
    mittel: arr<MittelEntry>(raw.mittel, hasId, (e) => strFields(e, ['label', 'unit'])),
    shifts: arr<Shift>(raw.shifts, hasId),
    bands: arr<ShiftBand>(raw.bands, hasId, (b) => strFields(b, ['label'])),
    cameraViews: arr<CameraView>(raw.cameraViews, hasId),
    reportMeta: rec<ReportMeta>(raw.reportMeta),
    attachments: arr<ReportAttachment>(raw.attachments, hasId),
    settings,
    intakeReviewedAt: str(raw.intakeReviewedAt),
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
  shifts: Shift[]
  bands: ShiftBand[]
  cameraViews: CameraView[]
  attachments: ReportAttachment[]
  planScale: PlanScales
  reportMeta: ReportMeta
  settings: IncidentSettings
  pickedObjectId?: string
  /** shared «Einsatzdaten geprüft» stamp (see Saved.intakeReviewedAt) */
  intakeReviewedAt?: string
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

/** The newest Atemschutz timestamp in a workspace (entry / contact / reading), or null if it has
 *  no Trupp clocks at all. Identifies a demo SEED: the server's 12 h reset writes new stamps, an
 *  operator's own edits move it forward, and everything else leaves it exactly where it was. */
export function latestTruppStamp(ws: Saved): number | null {
  const stamps: number[] = []
  for (const t of ws.trupps ?? []) {
    for (const iso of [t.entryTime, t.lastContactTime]) {
      const ms = iso ? Date.parse(iso) : NaN
      if (!Number.isNaN(ms)) stamps.push(ms)
    }
    for (const r of t.readings ?? []) { const ms = Date.parse(r.t); if (!Number.isNaN(ms)) stamps.push(ms) }
  }
  return stamps.length ? Math.max(...stamps) : null
}

/**
 * The wall-clock instant a demo seed's newest Trupp timestamp is pinned to — REMEMBERED, per tab,
 * for as long as the seed is the same one.
 *
 * Re-deriving it on every load (which is what happened until 2026-08-06) meant a plain browser
 * refresh re-pinned the newest stamp to «now» and every contact clock jumped BACKWARDS — a Trupp
 * at 0:35 came back at 0:08, and differently per Trupp depending on how it sat relative to the
 * newest stamp. On a monitoring surface that is the one direction a clock must never move: it
 * makes the time since the last Funkkontakt look shorter than it is. Anchoring once per (incident,
 * seed) means the demo still opens un-alarmed, and from then on its clocks only run forward.
 *
 * Per TAB (sessionStorage), on purpose: a refresh keeps its anchor, a new visitor in a new tab
 * gets a fresh, un-alarmed scene. A seed the server has since reset carries a different stamp and
 * therefore a new anchor.
 */
export function demoClockAnchor(incidentId: string, seedStamp: number, now: number, store?: Storage): number {
  const key = `kp.demoClock.${incidentId}.${seedStamp}`
  try {
    const s = store ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
    if (!s) return now
    const stored = Number(s.getItem(key))
    if (Number.isFinite(stored) && stored > 0) return stored
    s.setItem(key, String(now))
  } catch { /* private mode / disabled storage: an un-anchored demo is still a working demo */ }
  return now
}

/**
 * Demo only: slide the Atemschutz (SCBA) Trupp clocks so the scene reads as fresh when the visitor
 * ARRIVES instead of at the server's last reset. Otherwise someone landing late in the reset window
 * sees Trupps already überfällig and the alarm fires the moment they get there. Every Trupp
 * timestamp is shifted by one offset so the most-recent contact lands at `at`, preserving the
 * relative timing (who's been in longest, contact gaps).
 *
 * `at` is the ANCHOR, not the current time — see demoClockAnchor: it is fixed on the first open of
 * a seed, so the clocks keep running afterwards instead of resetting on every refresh.
 */
export function rebaseDemoClocks(ws: Saved, at: number): Saved {
  const trupps = ws.trupps
  if (!trupps?.length) return ws
  const newest = latestTruppStamp(ws)
  if (newest == null) return ws
  const offset = at - newest
  const shift = (iso: string): string => {
    const ms = iso ? Date.parse(iso) : NaN
    return Number.isNaN(ms) ? iso : new Date(ms + offset).toISOString()
  }
  return {
    ...ws,
    trupps: trupps.map((t) => ({
      ...t,
      entryTime: shift(t.entryTime),
      lastContactTime: shift(t.lastContactTime),
      readings: t.readings?.map((r) => ({ ...r, t: shift(r.t) })),
    })),
  }
}

/** The `workspace_rev` a freshly seeded demo incident carries (backend · demo_reset writes 1).
 *  Anything above it means a visitor's own save has landed on the server. */
export const DEMO_SEED_REV = 1

/**
 * Demo only: the fetched workspace with its Atemschutz clocks pinned to this visitor's arrival —
 * but ONLY while the incident is still the untouched server seed.
 *
 * ⚠️ The rev gate is the whole point (field report 02.09.). Demo edits persist and sync like a
 * real station's, so the demo Einsatz is shared: Manuel opened the Atemschutzüberwachung on a
 * phone while it stood open on a PC, and the phone's «seit letztem Kontakt» started again at 0:00
 * against the PC's 4:19 for the same Trupp. The anchor is per tab, so every device that joined
 * re-pinned the newest contact to ITS own arrival — and then pushed those shifted stamps back
 * into the shared record on the next save, dragging everybody else's clocks with it. On the one
 * surface where a clock reading short is a safety failure.
 *
 * With the gate, the rebase does what it was built for — a late visitor lands on a fresh scene
 * rather than a screaming alarm — and stops the moment the incident becomes a worked, shared
 * record: from the first save on, every device reads the same real timestamps.
 */
export function demoSeedRebase(ws: Saved, incidentId: string, rev: number, now: number = Date.now()): Saved {
  if (rev > DEMO_SEED_REV) return ws
  const stamp = latestTruppStamp(ws)
  return stamp == null ? ws : rebaseDemoClocks(ws, demoClockAnchor(incidentId, stamp, now))
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
    .map(keyCartoTileTemplates)
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
    shifts: ws?.shifts ?? [],
    bands: ws?.bands ?? [],
    cameraViews: ws?.cameraViews ?? [],
    attachments: ws?.attachments ?? [],
    planScale: ws?.planScale ?? {},
    reportMeta: ws?.reportMeta ?? {},
    settings: ws?.settings ?? {},
    intakeReviewedAt: ws?.intakeReviewedAt,
    // synced per incident; one-time import of the legacy device-cookie pick for THIS incident so
    // an in-flight manual pick isn't dropped on upgrade (the blob value wins thereafter).
    pickedObjectId: ws?.pickedObjectId
      ?? (prefs.pickedObject?.incidentId === incidentId ? prefs.pickedObject.objectId : undefined),
  }
}
