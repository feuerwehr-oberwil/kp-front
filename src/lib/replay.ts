// Time-travel reconstruction engine (audit-trail sub-phase B, PLAN-audit-trail §5).
//
// `state_at(T)` rebuilds the workspace `Saved` blob as it stood at any past instant:
//   1. load the nearest workspace snapshot with occurred_at <= T (the fold anchor),
//   2. fold the incident_events with occurred_at in (snapshot, T] forward over it.
//
// The client fetches the snapshot + the full event range ONCE (loadReplay), then folds
// locally per frame while scrubbing (stateAt) — no per-frame server calls.
//
// Reality check on granularity: the captured event payloads are intentionally minimal
// (mostly an id + a kind hint — see App.tsx `emit(...)`). So the SNAPSHOTS carry the
// authoritative full state; the fold refines between them only where the payload is rich
// enough (App now enriches entity.add/move/edit, draw.add, layer.toggle, workspace.save).
// Anything the fold can't apply is harmlessly skipped — the next snapshot corrects it.

import { apiGet } from './api'
import { appConfig } from '../config/appConfig'
import type { Saved } from './workspace'
import type { BoardAnno, BoardDoc, BuildingDoc, Drawing, Entity, LayerId, LngLat, WeatherData } from '../types'

// --- API shapes (mirror backend schemas) --------------------------------------------
export interface ReplayEvent {
  seq: number
  occurred_at: string
  recorded_at?: string
  source?: string
  user_id?: string | null
  op_type: string
  payload_json?: Record<string, unknown> | null
}
interface SnapshotResponse {
  found: boolean
  occurred_at: string | null
  seq_at: number | null
  workspace: Saved | null
}
export interface VehicleSampleRow {
  device_id: number
  ts: string
  lat: number
  lng: number
  course?: number | null
  speed?: number | null
}

// --- API client (kept here so we don't touch lib/incidents.ts) ----------------------
const enc = encodeURIComponent
export const fetchEvents = (id: string) =>
  apiGet<ReplayEvent[]>(`/api/incidents/${id}/events`)
export const fetchSnapshotAt = (id: string, atISO: string) =>
  apiGet<SnapshotResponse>(`/api/incidents/${id}/snapshot?at=${enc(atISO)}`)
export const fetchSamples = (id: string, fromISO?: string, toISO?: string) => {
  const p = new URLSearchParams()
  if (fromISO) p.set('from_', fromISO)
  if (toISO) p.set('to', toISO)
  const qs = p.toString()
  return apiGet<VehicleSampleRow[]>(`/api/incidents/${id}/samples${qs ? `?${qs}` : ''}`)
}

// --- Loaded bundle: everything the local fold needs ---------------------------------
export interface ReplayBundle {
  incidentId: string
  /** all events for the incident, ordered by seq (= occurred ingest order) */
  events: ReplayEvent[]
  /** vehicle GPS samples for the window (empty today — capture job not wired yet) */
  samples: VehicleSampleRow[]
  /** incident window in epoch ms — slider domain */
  startMs: number
  endMs: number
  /** the snapshots we've already fetched, keyed by their occurred_at ms (memo cache) */
  snapshotCache: Map<number, Saved | null>
  /** fetch (and cache) the nearest snapshot <= T; returns its blob + occurredAt */
  loadSnapshotAt: (tMs: number) => Promise<{ workspace: Saved | null; occurredMs: number | null }>
}

const ms = (iso: string) => new Date(iso).getTime()

/** Markers placed on the scrubber track — clickable jump points. */
export interface ReplayMarker {
  ms: number
  seq: number
  kind: 'symbol' | 'draw' | 'status' | 'divera' | 'save' | 'other'
  label: string
}

// op_type → marker kind (stable) + the replay-copy key carrying its label. The label is
// resolved inside deriveMarkers (not here) so the boot-resolved locale applies.
type MarkerLabelKey = 'markerSymbol' | 'markerDraw' | 'markerStatus' | 'markerDivera' | 'markerIncidentOpen' | 'markerSave'
const MARKER_KIND: Record<string, { kind: ReplayMarker['kind']; labelKey: MarkerLabelKey }> = {
  'entity.add': { kind: 'symbol', labelKey: 'markerSymbol' },
  'draw.add': { kind: 'draw', labelKey: 'markerDraw' },
  'status.change': { kind: 'status', labelKey: 'markerStatus' },
  'divera.update': { kind: 'divera', labelKey: 'markerDivera' },
  'incident.create': { kind: 'status', labelKey: 'markerIncidentOpen' },
  'workspace.save': { kind: 'save', labelKey: 'markerSave' },
}

// Structural events that are NOT a content change — they must not stretch the scrub range into
// idle time (incident.create fires at the incident's open, often well before any real work).
const IDLE_OP_TYPES = new Set(['incident.create'])

/** The slider domain: the span where something actually changed — every event except the
 *  structural incident.create, plus vehicle GPS samples. This trims idle head/tail (the app
 *  opened early, or left running long after the work stopped) so the track covers the part
 *  worth scrubbing instead of mostly-empty time. Falls back to the full window when nothing
 *  was recorded. Pure — the fold (`stateAt`) still sees every event regardless of the range. */
export function activeReplayRange(
  events: { occurred_at: string; op_type: string }[],
  samples: { ts: string }[],
  windowStartMs: number,
  windowEndMs: number,
): { startMs: number; endMs: number } {
  const changeMs = [
    ...events.filter((e) => !IDLE_OP_TYPES.has(e.op_type)).map((e) => ms(e.occurred_at)),
    ...samples.map((s) => ms(s.ts)),
  ].filter((t) => Number.isFinite(t))
  if (!changeMs.length) return { startMs: windowStartMs, endMs: windowEndMs }
  return { startMs: Math.min(...changeMs), endMs: Math.max(...changeMs) }
}

/** Pick the events worth showing as track markers (skip noisy move/edit/toggle). */
export function deriveMarkers(events: ReplayEvent[]): ReplayMarker[] {
  const copy = appConfig.copy.replay
  const out: ReplayMarker[] = []
  for (const e of events) {
    const m = MARKER_KIND[e.op_type]
    if (!m) continue
    if (e.op_type === 'workspace.save') continue // too dense to mark; it's the fold anchor
    out.push({ ms: ms(e.occurred_at), seq: e.seq, kind: m.kind, label: copy[m.labelKey] })
  }
  return out
}

/**
 * Load everything needed to scrub an incident locally. One round-trip for the event
 * range (+ samples); snapshots are fetched lazily per anchor and memoised.
 */
export async function loadReplay(
  incidentId: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<ReplayBundle> {
  const [events, samples] = await Promise.all([
    fetchEvents(incidentId).catch(() => [] as ReplayEvent[]),
    fetchSamples(incidentId).catch(() => [] as VehicleSampleRow[]),
  ])
  // The slider spans only the active period (first → last change), not the whole incident
  // start → now, so idle stretches don't eat the track (see activeReplayRange).
  const { startMs, endMs } = activeReplayRange(events, samples, windowStartMs, windowEndMs)

  const snapshotCache = new Map<number, Saved | null>()
  const loadSnapshotAt = async (tMs: number) => {
    const atISO = new Date(tMs).toISOString()
    const res = await fetchSnapshotAt(incidentId, atISO).catch(() => null)
    if (!res || !res.found || res.occurred_at == null) return { workspace: null, occurredMs: null }
    const occurredMs = ms(res.occurred_at)
    snapshotCache.set(occurredMs, res.workspace)
    return { workspace: res.workspace, occurredMs }
  }

  return { incidentId, events, samples, startMs, endMs, snapshotCache, loadSnapshotAt }
}

// --- The fold ----------------------------------------------------------------------

const coordOf = (p: Record<string, unknown> | null | undefined): LngLat | null => {
  const c = p?.coord
  return Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' ? (c as LngLat) : null
}

/**
 * Apply one event onto a working `Saved` shape, in place where the payload allows.
 * Unknown / payload-too-thin ops are no-ops (the snapshot anchor already has them).
 */
function applyEvent(ws: Saved, e: ReplayEvent): void {
  const p = e.payload_json ?? {}
  const id = typeof p.id === 'string' ? p.id : null
  switch (e.op_type) {
    case 'entity.add': {
      // App enriches this with the full entity; fall back to nothing if absent.
      const ent = p.entity as Entity | undefined
      if (ent && !ws.entities.some((x) => x.id === ent.id)) ws.entities = [...ws.entities, ent]
      break
    }
    case 'entity.move': {
      const c = coordOf(p)
      if (id && c) ws.entities = ws.entities.map((x) => (x.id === id ? { ...x, coord: c } : x))
      break
    }
    case 'entity.edit': {
      const patch = p.patch as Partial<Entity> | undefined
      if (id && patch) ws.entities = ws.entities.map((x) => (x.id === id ? { ...x, ...patch } : x))
      break
    }
    case 'entity.delete': {
      if (id) ws.entities = ws.entities.filter((x) => x.id !== id)
      break
    }
    case 'draw.add': {
      const dr = p.drawing as Drawing | undefined
      if (dr && !ws.drawings.some((x) => x.id === dr.id)) ws.drawings = [...ws.drawings, dr]
      break
    }
    case 'draw.edit': {
      const patch = p.patch as Partial<Drawing> | undefined
      if (id && patch) ws.drawings = ws.drawings.map((x) => (x.id === id ? { ...x, ...patch } : x))
      break
    }
    case 'draw.delete': {
      if (id) ws.drawings = ws.drawings.filter((x) => x.id !== id)
      break
    }
    case 'draw.attach':
    case 'draw.detach': {
      const endpoint = p.endpoint === 'start' || p.endpoint === 'end' ? p.endpoint : null
      const fallback = coordOf({ coord: p.fallback })
      if (id && endpoint && fallback) ws.drawings = ws.drawings.map((x) => {
        if (x.id !== id || x.coords.length < 2) return x
        const coords = x.coords.map((c, i) => i === (endpoint === 'start' ? 0 : x.coords.length - 1) ? fallback : c)
        return { ...x, coords, ...(endpoint === 'start' ? { startAttachment: p.attachment } : { endAttachment: p.attachment }) }
      }) as Drawing[]
      break
    }
    case 'board.add': {
      const planId = typeof p.planId === 'string' ? p.planId : null
      const anno = p.anno as BoardAnno | undefined
      if (planId && anno) ws.board = { ...(ws.board ?? {}), [planId]: [...(ws.board?.[planId] ?? []).filter((a) => a.id !== anno.id), anno] }
      break
    }
    case 'board.edit': {
      const planId = typeof p.planId === 'string' ? p.planId : null
      const patch = p.patch as Partial<BoardAnno> | undefined
      if (planId && id && patch) ws.board = { ...(ws.board ?? {}), [planId]: (ws.board?.[planId] ?? []).map((a) => a.id === id ? { ...a, ...patch } : a) }
      break
    }
    case 'board.delete': {
      const planId = typeof p.planId === 'string' ? p.planId : null
      if (planId && id) ws.board = { ...(ws.board ?? {}), [planId]: (ws.board?.[planId] ?? []).filter((a) => a.id !== id) }
      break
    }
    case 'layer.toggle': {
      const lid = (typeof p.id === 'string' ? p.id : null) as LayerId | null
      if (lid && ws.layerState) {
        // mirror App.toggleLayer: base layers are a radio group, overlays just flip
        const target = ws.layerState.find((l) => l.id === lid)
        const visible = typeof p.visible === 'boolean' ? p.visible : !(target?.visible ?? true)
        const isBase = typeof p.base === 'boolean' ? p.base : false
        ws.layerState = ws.layerState.map((l) =>
          isBase ? { ...l, visible: l.id === lid } : l.id === lid ? { ...l, visible } : l,
        )
      }
      break
    }
    // status.change / divera.update / journal.add / undo / redo / workspace.save:
    // no workspace-shape mutation we can faithfully fold from the minimal payload;
    // the snapshot anchor carries their net effect. They still drive markers.
    default:
      break
  }
}

/** The reconstructed-state slices the UI reads when scrubbing. It IS the `Saved` blob:
 *  the map reads `entities`/`drawings`/`layerState`, and the Plan reads `board`/`building`
 *  from the very same shape — so one `stateAt(T)` drives BOTH surfaces in lockstep. The
 *  board/building come straight from the nearest snapshot ≤ T (no fine fold needed — v1). */
export type ReplayState = Saved & { board?: BoardDoc; building?: BuildingDoc | null }

/**
 * Reconstruct the workspace `Saved` shape at instant `tMs`.
 *
 * Anchored on the nearest snapshot <= T, then the events in (snapshotOccurred, T] are
 * folded forward. The snapshot blob already carries `board` (plan annotations) and
 * `building` (the floor-stack), so they ride out alongside the map's entities/drawings/
 * layers — the Plan surface replays in sync with the Lage. Returns null only when there's
 * neither a snapshot nor any events before T (i.e. T precedes the first recorded state).
 */
export async function stateAt(bundle: ReplayBundle, tMs: number): Promise<ReplayState | null> {
  const { workspace, occurredMs } = await bundle.loadSnapshotAt(tMs)
  // Clone the anchor so the fold never mutates the cached blob.
  const base: Saved | null = workspace ? (JSON.parse(JSON.stringify(workspace)) as Saved) : null
  const ws: Saved = base ?? { entities: [], drawings: [], recent: [], layerState: [], timeline: [] }
  ws.entities = ws.entities ?? []
  ws.drawings = ws.drawings ?? []

  const from = occurredMs ?? -Infinity
  for (const e of bundle.events) {
    const t = ms(e.occurred_at)
    if (t <= from) continue // already baked into the snapshot
    if (t > tMs) break // events are seq-ordered ≈ occurred-ordered; past the cursor
    applyEvent(ws, e)
  }
  // Weather rides outside the snapshot fold: a reading is point-in-time, so take the latest
  // `weather.observe` at/before the cursor across ALL events (even before the snapshot anchor),
  // so the wind/condition badge shows the picture as it was at T.
  let weather: WeatherData | null = null
  for (const e of bundle.events) {
    if (ms(e.occurred_at) > tMs) break
    if (e.op_type === 'weather.observe' && e.payload_json?.weather) {
      weather = e.payload_json.weather as WeatherData
    }
  }
  ;(ws as ReplayState).weather = weather
  // If we had neither a snapshot nor a single foldable event before T, there's nothing
  // to show yet (pre-incident). An empty-but-present workspace is a legitimate state.
  if (!base && from === -Infinity && !bundle.events.some((e) => ms(e.occurred_at) <= tMs)) return null
  return ws
}

// --- Vehicle replay (interpolated sample paths) -------------------------------------

/** A vehicle's position at instant T, linearly interpolated between samples. */
export interface VehicleAt {
  deviceId: number
  coord: LngLat
  course: number | null
}

/**
 * Interpolate every device's position at `tMs` from its samples. Empty when the
 * samples table is empty (it is today — the Traccar→samples capture job isn't wired
 * yet, so vehicle replay gracefully degrades to "keine Fahrzeugdaten").
 */
export function vehiclesAt(samples: VehicleSampleRow[], tMs: number): VehicleAt[] {
  if (!samples.length) return []
  const byDevice = new Map<number, VehicleSampleRow[]>()
  for (const s of samples) {
    const arr = byDevice.get(s.device_id) ?? []
    arr.push(s)
    byDevice.set(s.device_id, arr)
  }
  const out: VehicleAt[] = []
  for (const [deviceId, rows] of byDevice) {
    rows.sort((a, b) => ms(a.ts) - ms(b.ts))
    let prev: VehicleSampleRow | null = null
    let next: VehicleSampleRow | null = null
    for (const r of rows) {
      const rt = ms(r.ts)
      if (rt <= tMs) prev = r
      if (rt > tMs) { next = r; break }
    }
    if (!prev) continue // device not yet present at T
    if (!next) {
      out.push({ deviceId, coord: [prev.lng, prev.lat], course: prev.course ?? null })
      continue
    }
    const t0 = ms(prev.ts), t1 = ms(next.ts)
    const f = t1 > t0 ? (tMs - t0) / (t1 - t0) : 0
    out.push({
      deviceId,
      coord: [prev.lng + (next.lng - prev.lng) * f, prev.lat + (next.lat - prev.lat) * f],
      course: prev.course ?? next.course ?? null,
    })
  }
  return out
}
