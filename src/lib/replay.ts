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
  // Folded rather than spread into Math.min/max. V8 throws RangeError somewhere around 100k spread
  // arguments, and NOTHING here bounds these counts — the server does. Vehicle samples are the
  // realistic driver: a handful of vehicles reporting every ~30 s produces tens of thousands a day,
  // so a multi-day Einsatz reaches the limit. That would throw during render of the replay view,
  // driven purely by the incident's own data volume — precisely the crash-loop shape the
  // ErrorBoundary escalation exists for. A loop has no argument limit.
  let startMs = Infinity
  let endMs = -Infinity
  const note = (t: number) => {
    if (!Number.isFinite(t)) return
    if (t < startMs) startMs = t
    if (t > endMs) endMs = t
  }
  for (const e of events) if (!IDLE_OP_TYPES.has(e.op_type)) note(ms(e.occurred_at))
  for (const s of samples) note(ms(s.ts))
  if (startMs === Infinity) return { startMs: windowStartMs, endMs: windowEndMs }
  return { startMs, endMs }
}

/**
 * A stretch of the timeline where nothing was recorded.
 *
 * `fromMs`/`toMs` are the real moments on either side, so the gap is what lies strictly
 * between them — jumping to `toMs` lands on the next thing that actually happened.
 */
export interface ReplayGap {
  fromMs: number
  toMs: number
}

/**
 * How much silence has to pass before playback stops sitting through it.
 *
 * Two minutes is roughly the point where even 32× stops being watchable (3.7 s of staring at
 * an unchanging map), while anything shorter is plausibly a pause in the work rather than a
 * hole in the record — and skipping those would misrepresent the pace of the incident.
 */
export const GAP_SKIP_MS = 120_000

/**
 * Op types that mean somebody DID something, as opposed to the document being written.
 *
 * `workspace.save` is deliberately absent, and that is the whole point. The workspace is one
 * blob of twenty-odd fields (see `Saved`), so a save fires when the layer panel is toggled,
 * when the operator switches from Lage to Plan (`activeModule`), when the recently-used symbol
 * list reorders. Its payload is `{rev: N}` and nothing more, so nothing downstream can tell a
 * tab switch from a symbol being placed. Treating saves as activity painted the replay bar blue
 * across stretches where the operator had done nothing but look around.
 *
 * `meta.change` IS here: editing the Einsatzdaten is a person changing the record, which is
 * activity by any reading. `incident.create` is not — it is structural, and it fires long
 * before the work starts.
 */
const ACTION_OP_TYPES = new Set(['status.change', 'divera.update', 'meta.change'])

/**
 * The timestamps of everything that counts as activity, for gap detection.
 *
 * Journal entries first — the Verlauf is the record of what happened, and it is what an
 * operator means by «da ist etwas passiert». Legacy rows carry only `t` ('HH:MM') with no date;
 * those are skipped rather than guessed onto a calendar day, because a misplaced moment would
 * silently close a gap that is really there.
 *
 * Vehicle samples are deliberately NOT included. GPS ticks whether or not anything is
 * happening: a fleet parked at the depot overnight still reports every ~30 s, so folding
 * samples in would mean no gap is ever detected and the feature quietly does nothing.
 */
export function activityMoments(
  events: { occurred_at: string; op_type: string }[],
  journal: { at?: string }[] = [],
): number[] {
  const out: number[] = []
  for (const j of journal) {
    if (!j.at) continue
    const t = ms(j.at)
    if (Number.isFinite(t)) out.push(t)
  }
  for (const e of events) {
    if (!ACTION_OP_TYPES.has(e.op_type)) continue
    const t = ms(e.occurred_at)
    if (Number.isFinite(t)) out.push(t)
  }
  return out
}

/** A stretch that DOES contain activity — the complement of the gaps, and what the track
 *  renders at real proportion. */
export interface ReplaySegment {
  fromMs: number
  toMs: number
}

/**
 * Invert the gaps into the stretches worth showing.
 *
 * Returns an EMPTY list when the gaps cover everything, and that is deliberate. An earlier
 * version fell back to "the whole range is one segment", which is a contradiction: the same
 * span then existed as both a segment and a gap, and the track drew a full-width blue bar with
 * a stub break tacked onto the end. If nothing happened anywhere, the honest answer is that
 * there are no activity segments — the caller decides what to draw instead.
 */
export function segmentsFromGaps(gaps: ReplayGap[], startMs: number, endMs: number): ReplaySegment[] {
  if (!gaps.length) return endMs > startMs ? [{ fromMs: startMs, toMs: endMs }] : []
  const out: ReplaySegment[] = []
  let cursor = startMs
  for (const g of [...gaps].sort((a, b) => a.fromMs - b.fromMs)) {
    if (g.fromMs > cursor) out.push({ fromMs: cursor, toMs: g.fromMs })
    cursor = Math.max(cursor, g.toMs)
  }
  if (cursor < endMs) out.push({ fromMs: cursor, toMs: endMs })
  return out
}

/** A segment or a break, placed on the track as fractions of its width. */
export interface TrackPiece {
  kind: 'segment' | 'gap'
  fromMs: number
  toMs: number
  leftFrac: number
  widthFrac: number
}

/**
 * Lay the track out: activity segments share the space in proportion to their real duration,
 * every break gets the SAME fixed slice regardless of how long it lasted.
 *
 * This is the trade the whole design rests on. A linear axis is honest and useless — on an
 * incident closed the next morning, the silence is 96 % of the elapsed time and therefore 96 %
 * of the bar, leaving the half hour of actual work as a sliver nobody can hit. Giving breaks a
 * fixed width makes the axis non-linear, which is why the break is drawn as a visible
 * interruption rather than a texture: the distortion has to be obvious, not inferred.
 */
export function layoutTrack(
  segments: ReplaySegment[],
  gaps: ReplayGap[],
  gapFrac: number,
): TrackPiece[] {
  const pieces = [
    ...segments.map((s) => ({ kind: 'segment' as const, ...s })),
    ...gaps.map((g) => ({ kind: 'gap' as const, fromMs: g.fromMs, toMs: g.toMs })),
  ].sort((a, b) => a.fromMs - b.fromMs)

  const gapCount = pieces.filter((p) => p.kind === 'gap').length
  const activeTotal = segments.reduce((n, s) => n + Math.max(0, s.toMs - s.fromMs), 0)
  // With no activity segments there is nothing to make room FOR, so the breaks share the whole
  // width instead of taking their fixed slice each. Without this the track renders a couple of
  // stubs and leaves most of itself blank — a bar that is 86 % nothing.
  const perGap = gapCount ? (segments.length ? Math.min(gapFrac, 0.5 / gapCount) : 1 / gapCount) : 0
  // Breaks never take more than half the bar otherwise: with many short gaps the fixed slices
  // would crowd out the very thing they exist to make room for.
  const activeFrac = 1 - perGap * gapCount

  const out: TrackPiece[] = []
  let left = 0
  for (const p of pieces) {
    const widthFrac = p.kind === 'gap'
      ? perGap
      : activeTotal > 0 ? activeFrac * ((p.toMs - p.fromMs) / activeTotal) : activeFrac
    out.push({ ...p, leftFrac: left, widthFrac })
    left += widthFrac
  }
  return out
}

/** Track fraction → timestamp, honouring the non-linear layout. Inside a break it returns the
 *  break's END: dropping the playhead into a stretch where nothing happened is never what the
 *  operator meant, so a click there lands on the next real moment. */
export function timeAtFraction(pieces: TrackPiece[], f: number): number | null {
  if (!pieces.length) return null
  const clamped = Math.max(0, Math.min(1, f))
  for (const p of pieces) {
    if (clamped > p.leftFrac + p.widthFrac) continue
    if (p.kind === 'gap') return p.toMs
    const within = p.widthFrac > 0 ? (clamped - p.leftFrac) / p.widthFrac : 0
    return p.fromMs + Math.max(0, Math.min(1, within)) * (p.toMs - p.fromMs)
  }
  const last = pieces[pieces.length - 1]
  return last.toMs
}

/** Timestamp → track fraction. A moment inside a break sits at the break's left edge. */
export function fractionAtTime(pieces: TrackPiece[], tMs: number): number {
  if (!pieces.length) return 0
  for (const p of pieces) {
    if (tMs > p.toMs) continue
    if (p.kind === 'gap') return p.leftFrac
    const span = p.toMs - p.fromMs
    const within = span > 0 ? (tMs - p.fromMs) / span : 0
    return p.leftFrac + Math.max(0, Math.min(1, within)) * p.widthFrac
  }
  return 1
}

/**
 * The empty stretches between consecutive moments, plus the head and tail of the range.
 *
 * The tail is the one that matters most in practice: an incident nobody closed leaves hours of
 * nothing between the last real entry and «Jetzt», and that is exactly the stretch an operator
 * should never have to scrub through.
 */
export function findGaps(moments: number[], startMs: number, endMs: number, minGapMs = GAP_SKIP_MS): ReplayGap[] {
  const inRange = moments.filter((t) => Number.isFinite(t) && t >= startMs && t <= endMs).sort((a, b) => a - b)
  const edges = [startMs, ...inRange, endMs]
  const gaps: ReplayGap[] = []
  for (let i = 1; i < edges.length; i++) {
    const fromMs = edges[i - 1]
    const toMs = edges[i]
    if (toMs - fromMs > minGapMs) gaps.push({ fromMs, toMs })
  }
  return gaps
}

/** The gap the playhead is inside, or null. Endpoints are real moments, so they are excluded. */
export function gapAt(gaps: ReplayGap[], tMs: number): ReplayGap | null {
  for (const g of gaps) if (tMs > g.fromMs && tMs < g.toMs) return g
  return null
}

/**
 * The next moment strictly after (`dir: 1`) or before (`dir: -1`) the playhead, or null at
 * either end. This is what the transport buttons step by — «the next thing that happened»
 * rather than a fixed number of seconds, which on a sparse timeline lands on nothing.
 */
export function stepMoment(moments: number[], tMs: number, dir: 1 | -1): number | null {
  let best: number | null = null
  for (const t of moments) {
    if (!Number.isFinite(t)) continue
    if (dir === 1 ? t <= tMs : t >= tMs) continue
    if (best === null || (dir === 1 ? t < best : t > best)) best = t
  }
  return best
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
