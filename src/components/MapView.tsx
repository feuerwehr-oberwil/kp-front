import { forwardRef, Fragment, useEffect, useRef, useState } from 'react'
import Map, { Marker, Source, Layer, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import type { Map as MlMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { CaptionMode, Drawing, Entity, LayerDef, LayerId, LineAttachment, LineEndpoint, LngLat, PreparedMapOverlay, Trupp, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { LINE_DASH_ML } from '../lib/draw'
import { markerParamsAlong, lerpPoint, MAX_VERTEX_HANDLES } from '../lib/lineStyle'
import { EMPTY_STYLE, vis, fc, lineFeat, polyFeat, snapNorth, shapePx, symPx } from '../lib/mapView'
import { TeilstueckFork, EndTag, hasLineDecor } from '../lib/lineDecor'
import { pathLengthM, fmtDistance, hoseLengthHint, circlePolygon } from '../lib/geo'
import { useMapCanvasGestures } from './useMapCanvasGestures'
import { MapMarkers } from './MapMarkers'
import { MapLayers } from './MapLayers'
// long-press to delete a path vertex (touch — desktop right-click kept); the placed-object
// move threshold lives in MapMarkers with the entity-drag logic.
import { useLongPress } from '../lib/useLongPress'
import { QuietAttributionControl } from './MapAttribution'
import { advanceDwell, boundaryPoint, EMPTY_DWELL, forkPortPoint, gpsGuard, incomingAttachments, moveLineBody, nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget, wouldCreateCycle, type AttachableLine, type DwellState, type MagneticTarget } from '../lib/lineAttachments'

// Lock chip on a locked drawing: a SHORT HOLD (not a tap) unlocks it, with a filling ring as
// the progress indicator (Miro-style) so a stray tap never unlocks instantly.
function LockChip({ onUnlock }: { onUnlock: () => void }) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = (e: React.PointerEvent) => {
    e.stopPropagation()
    setHolding(true)
    timer.current = setTimeout(() => { setHolding(false); onUnlock() }, 700)
  }
  const cancel = () => { setHolding(false); if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  return (
    <button className={`draw-lock-chip${holding ? ' holding' : ''}`} title={appConfig.copy.drawingEditor.unlockHold} aria-label={appConfig.copy.drawingEditor.unlockHold}
      onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel} onClick={(e) => e.stopPropagation()}>
      {/* progress sits ABOVE the chip so the fingertip never covers it */}
      {holding && (
        <span className="draw-lock-hint">
          <span className="draw-lock-hint-label">{appConfig.copy.drawingEditor.unlocking}</span>
          <span className="draw-lock-hint-bar"><i /></span>
        </span>
      )}
      <Icon id="lock" />
    </button>
  )
}

// planar shoelace area (deg², relative only) of a clicked feature's outer ring; non-polygon
// (line) features return 0 so they stay the most specific pick when overlapping a fill.
const featArea = (f: { geometry?: { type?: string; coordinates?: unknown } }): number => {
  const g = f.geometry
  if (g?.type !== 'Polygon') return 0
  const ring = (g.coordinates as [number, number][][])?.[0]
  if (!ring || ring.length < 3) return 0
  let s = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % n]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

interface Props {
  entities: Entity[]
  layers: LayerDef[]
  byName: Record<string, string>
  /** global S/M/L symbol-size multiplier (lib/prefs · symbolMul) — scales the symPx band */
  symMul?: number
  /** device default for on-canvas symbol captions (lib/prefs · symbolCaptions) */
  captionMode?: CaptionMode
  initialCenter: LngLat
  initialZoom?: number
  initialBearing?: number
  /** print/static render: fit these points once after load, no geolocation marker */
  fitPoints?: LngLat[]
  staticView?: boolean
  /** bump to take a single GPS fix and fly to it (the "Mein Standort" dot). On demand — no
   *  continuous watch — so the GPS chip isn't powered all shift. 0 = never located yet. */
  locateNonce?: number
  /** the map surface is the active one (Lage mode) — gates map-only chrome like the wind badge */
  mapActive?: boolean
  /** weather reading for the wind badge (live poll, or the folded reading during replay) */
  weather?: WeatherData | null
  /** open the MeteoSwiss details for the incident location */
  onOpenWeather?: () => void
  /** lift the wind badge clear of the replay scrubber while time-travel is active */
  replayActive?: boolean
  preparedOverlays: PreparedMapOverlay[]
  isVisible: (id: LayerId) => boolean
  selectedId: string | null
  onSelect: (e: Entity) => void
  onMapClick: (c: LngLat) => void
  /** map note inline editing (raw text on the marker, like the Plan whiteboard) */
  editNoteId?: string | null
  onNoteText?: (id: string, text: string) => void
  onNoteCommit?: (id: string, text: string) => void
  onNoteEdit?: (id: string) => void
  /** team markers (Trupp tracking on the map) — see MapMarkers */
  trupps?: Trupp[]
  onShowTrupp?: (truppId: string) => void
  onTeamMark?: (id: string) => void
  onTeamClearTrail?: (id: string) => void
  drawings: Drawing[]
  drawingsVisible: boolean
  draft: LngLat[]
  draftKind: 'line' | 'area' | null
  /** a placement tool is active (symbol/shape/note/area/measure) — map clicks should
   *  place/add a point rather than select a drawing under the cursor (e.g. an area fill) */
  placing?: boolean
  /** live editing of the in-progress draft (area/line tool), identical to the measure
   *  path: drag a vertex, click a segment to insert, right-click a vertex to delete */
  onDraftDrag?: (index: number, coord: LngLat) => void
  onDraftInsert?: (index: number, coord: LngLat) => void
  onDraftDelete?: (index: number) => void
  onDraftPointAttachment?: (attachment?: LineAttachment) => void
  draggable: boolean
  onMarkerDragStart: (id: string) => void
  onMarkerMove: (id: string, c: LngLat) => void
  onMarkerDragEnd: (id: string, c: LngLat) => void
  /** rotate a (live vehicle) marker by dragging its on-icon handle */
  onRotate?: (id: string, deg: number) => void
  /** drag-to-transform a placed shape: rotate (top handle) / resize (corner handle).
   *  phase lets the app snapshot once for undo and persist on release. */
  onShapeTransform?: (id: string, patch: { rotation?: number; rotation2?: number; sizeM?: number }, phase: 'start' | 'move' | 'end') => void
  onView: (v: { bearing: number; center: LngLat; zoom: number }) => void
  /** coordinate picker: while aiming the map shows a crosshair, the cursor lng/lat
   *  streams to onCursor, and the next map click locks the point via onPick. */
  picking?: boolean
  onCursor?: (c: LngLat | null) => void
  onPick?: (c: LngLat) => void
  pickedPoint?: LngLat | null
  freehand: boolean
  onFreehand: (coords: LngLat[], attachments?: { startAttachment?: LineAttachment; endAttachment?: LineAttachment }) => void
  drawColor: string
  drawWidth: number
  drawDashed: boolean
  selectedDrawingId: string | null
  onSelectDrawing: (id: string) => void
  /** unlock a locked drawing (tap its centre lock chip) → unlocks + selects it */
  onUnlockDrawing?: (id: string) => void
  onDelete: (id: string) => void
  /** measurement readouts pinned to the live measure path */
  measureLabels?: { coord: LngLat; text: string; strong?: boolean }[]
  /** draggable measurement vertices + the path kind they form (line / area) */
  measurePoints?: LngLat[]
  measureKind?: 'line' | 'area' | null
  onMeasureDrag?: (index: number, coord: LngLat) => void
  /** click on a path segment → insert a vertex at `index` (between its endpoints) */
  onMeasureInsert?: (index: number, coord: LngLat) => void
  /** double-click a vertex → delete it */
  onMeasureDelete?: (index: number) => void
  /** the currently selected drawing — gets on-canvas move/reshape/delete handles */
  selectedDrawing?: Drawing | null
  /** stream new coords for the selected drawing (body move / vertex drag); the phase
   *  folds the whole gesture into one undo step (mirrors onShapeTransform) */
  onDrawingEdit?: (id: string, coords: LngLat[], phase: 'start' | 'move' | 'end') => void
  onDrawingVertexInsert?: (id: string, index: number, coord: LngLat) => void
  onDrawingVertexDelete?: (id: string, index: number) => void
  onDrawingDelete?: (id: string) => void
  /** Commit one armed endpoint attach/retarget/detach gesture. */
  onDrawingAttachment?: (id: string, endpoint: LineEndpoint, attachment: LineAttachment | undefined, fallback: LngLat) => void
  /** drag a line's distance/text label to a GEOREFERENCED anchor (WGS84 [lng,lat]), so it
   *  stays pinned to the ground at every zoom + bearing (the old screen-px offset drifted).
   *  `at` is null on 'start' (just the undo snapshot). Folds the drag into one undo step. */
  onLabelMove?: (id: string, at: LngLat | null, phase: 'start' | 'move' | 'end', which?: 'label' | 'end') => void
  /** marquee multi-select (Select tool): one finger boxes, two fingers pan, Shift+drag on desktop */
  marqueeEnabled?: boolean
  selectedDrawIds?: string[]
  /** the boxed drawings + entities from a lasso gesture */
  onMarquee?: (drawIds: string[], entityIds: string[]) => void
  /** Absperrkreis (circle) tool active — drag centre→edge to set the radius */
  circleEnabled?: boolean
  /** commit a finished circle (centre + radius in metres) */
  onCircle?: (center: LngLat, radiusM: number) => void
  /** entity ids currently in the multi-selection — highlighted like the boxed drawings */
  selectedEntityIds?: string[]
  onGroupMove?: (ids: string[], entIds: string[], dLng: number, dLat: number, phase: 'start' | 'move' | 'end') => void
  onGroupDelete?: (ids: string[], entIds: string[]) => void
}

export const MapView = forwardRef<MapRef, Props>(function MapView(props, ref) {
  const { entities, layers, byName, symMul = 1, captionMode = 'off', initialCenter, initialZoom = 17.6, initialBearing = 0, fitPoints, staticView = false, locateNonce = 0, mapActive = true, weather = null, onOpenWeather, replayActive = false, preparedOverlays, isVisible, selectedId, onSelect, onMapClick, editNoteId = null, onNoteText, onNoteCommit, onNoteEdit, trupps, onShowTrupp, onTeamMark, onTeamClearTrail,
    drawings: storedDrawings, drawingsVisible, draft, draftKind, placing, onDraftDrag, onDraftInsert, onDraftDelete, onDraftPointAttachment, draggable, onMarkerDragStart, onMarkerMove, onMarkerDragEnd, onRotate, onShapeTransform,
    onView, picking, onCursor, onPick, pickedPoint, freehand, onFreehand, drawColor, drawWidth, drawDashed, selectedDrawingId, onSelectDrawing, onUnlockDrawing, onDelete, measureLabels = [], measurePoints = [], measureKind = null, onMeasureDrag, onMeasureInsert, onMeasureDelete,
    selectedDrawing = null, onDrawingEdit, onDrawingVertexInsert, onDrawingVertexDelete, onDrawingDelete, onDrawingAttachment, onLabelMove,
    marqueeEnabled = false, selectedDrawIds = [], onMarquee, onGroupMove, onGroupDelete, selectedEntityIds = [], circleEnabled = false, onCircle } = props
  const [zoom, setZoom] = useState(initialZoom)
  // team-trail visibility (map-session, default on) — the eye toggle in the team action bar
  // flips it; mirrors the plan board's showTrails. The record itself is never touched here.
  const [trailsVisible, setTrailsVisible] = useState(true)
  // current map bearing (deg) — placed symbols are pinned to GEOGRAPHIC orientation, so the
  // glyph CSS rotation is offset by −bearing and re-renders live as the map rotates (a vehicle
  // "facing south" keeps facing south when you spin the map). Streamed on every rotate frame.
  const [bearing, setBearing] = useState(initialBearing)
  const mapInst = useRef<MlMap | null>(null)
  // long-press to delete a path vertex (touch equivalent of the desktop right-click)
  const vertexPress = useLongPress()
  // A long-press vertex-delete fires mid-gesture; the finger's release then lands a map click on
  // the reshaped background, which would deselect and close the editor. This swallows that one
  // click so the line stays selected and more nodes can be deleted in a row.
  const suppressClick = useRef(false)
  const deleteVertexKeepSelection = (id: string, i: number) => { suppressClick.current = true; onDrawingVertexDelete?.(id, i) }
  const [mapReady, setMapReady] = useState(false)
  type EndpointDrag = { id: string; endpoint: LineEndpoint; coord: LngLat; dwell: DwellState; candidate: MagneticTarget | null }
  const [endpointDrag, setEndpointDragState] = useState<EndpointDrag | null>(null)
  const endpointDragRef = useRef<EndpointDrag | null>(null)
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setEndpointDrag = (next: EndpointDrag | null) => { endpointDragRef.current = next; setEndpointDragState(next) }
  type DraftMagnet = { first: LngLat; coord: LngLat; atStart: boolean; dwell: DwellState; candidate: MagneticTarget | null; startAttachment?: LineAttachment; endAttachment?: LineAttachment }
  const [draftMagnetState, setDraftMagnetState] = useState<DraftMagnet | null>(null)
  const draftMagnet = useRef<DraftMagnet | null>(null)
  const draftDwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setDraftMagnet = (next: DraftMagnet | null) => { draftMagnet.current = next; setDraftMagnetState(next) }

  // Resolve magnetic intent late, in the renderer's current screen space. Stored endpoint
  // coordinates stay untouched as fallbacks; every downstream map consumer below sees this
  // single resolved list (ink, hit testing, arrows, labels, bounds and edit handles).
  // The dragged endpoint follows the FINGER, so we feed its live coord into resolution and treat
  // that endpoint as temporarily free (its own attachment ignored) — this makes attached branch
  // lines follow the node live (move + carry) instead of snapping only on release. The other
  // endpoint keeps its attachment.
  const attachmentLines: AttachableLine<LngLat>[] = storedDrawings
    .filter((d) => d.kind === 'line' && d.coords.length >= 2)
    .map((d) => {
      const drag = endpointDrag?.id === d.id ? endpointDrag : null
      if (!drag) return { id: d.id, points: d.coords, teilstueck: d.teilstueck, width: d.width, startAttachment: d.startAttachment, endAttachment: d.endAttachment }
      const idx = drag.endpoint === 'start' ? 0 : d.coords.length - 1
      return {
        id: d.id, points: d.coords.map((p, i) => (i === idx ? drag.coord : p)), teilstueck: d.teilstueck, width: d.width,
        startAttachment: drag.endpoint === 'start' ? undefined : d.startAttachment,
        endAttachment: drag.endpoint === 'end' ? undefined : d.endAttachment,
      }
    })
  const resolvedCoords = new globalThis.Map<string, LngLat[]>()
  const objectPoint = (id: string, toward: LngLat, attachment: import('../types').LineAttachment): LngLat | null => {
    const e = entities.find((x) => x.id === id)
    const map = mapInst.current
    if (!e || !map || !Array.isArray(e.coord)) return attachment.gps?.lastSafe ?? null
    let center = e.coord
    if (attachment.gps) {
      const guarded = gpsGuard(attachment.gps.state, attachment.gps.confirmedAt, attachment.gps.lastSafe, center,
        (a, b) => pathLengthM([a as LngLat, b as LngLat]))
      center = guarded.point as LngLat
    }
    const c = map.project(center), t = map.project(toward)
    const size = e.kind === 'shape' ? shapePx(e.sizeM, e.coord[1], zoom)
      : e.kind === 'team' ? 56 : e.kind === 'note' || e.kind === 'photo' ? 56 : symPx(e.kind, e.coord[1], zoom, symMul)
    const p = boundaryPoint({ shape: 'rect', center: [c.x, c.y], width: size, height: e.kind === 'vehicle' ? size * 0.7 : size, rotation: (e.rotation ?? 0) - bearing }, [t.x, t.y])
    const ll = map.unproject(p)
    return [ll.lng, ll.lat]
  }
  const linePoint = (target: AttachableLine<LngLat>, endpoint: LineEndpoint, attachment: LineAttachment, resolved: LngLat): LngLat => {
    const map = mapInst.current
    if (!map || !(endpoint === 'end' && target.teilstueck) || attachment.port == null || target.points.length < 2) return resolved
    const p = map.project(resolved), q = map.project(target.points[target.points.length - 2])
    const port = forkPortPoint([p.x, p.y], [q.x, q.y], target.width ?? 4, attachment.port)
    const ll = map.unproject(port)
    return [ll.lng, ll.lat]
  }
  for (const l of attachmentLines) resolvedCoords.set(l.id, resolveLinePoints(l, { lines: attachmentLines, objectPoint, linePoint }))
  const relationship = relationshipNetwork(attachmentLines, selectedDrawingId ? [selectedDrawingId] : [], selectedId ? [selectedId] : [])
  // resolvedCoords already carries the dragged endpoint at the finger position (attachmentLines
  // injects it above), so downstream consumers see the live drag without a second override.
  const drawings: Drawing[] = storedDrawings.map((d): Drawing =>
    resolvedCoords.has(d.id) ? { ...d, coords: resolvedCoords.get(d.id)! } : d)
  const resolvedSelectedDrawing = selectedDrawing && resolvedCoords.has(selectedDrawing.id)
    ? { ...selectedDrawing, coords: resolvedCoords.get(selectedDrawing.id)! } : selectedDrawing
  const hiddenAttachmentTargets = selectedDrawing ? [selectedDrawing.startAttachment, selectedDrawing.endAttachment].flatMap((a) => {
    if (a?.target.kind !== 'object') return []
    const e = entities.find((x) => x.id === a.target.id)
    return e && !isVisible(e.layer) ? [e] : []
  }) : []
  const candidatesAt = (sourceId: string, at: LngLat): MagneticTarget[] => {
    const map = mapInst.current
    if (!map) return []
    const pointer = map.project(at)
    const objectTargets: MagneticTarget[] = entities
      .filter((e) => ['symbol', 'vehicle', 'team'].includes(e.kind) && Array.isArray(e.coord))
      .map((e) => {
        const c = map.project(e.coord), size = e.kind === 'team' ? 56 : symPx(e.kind, e.coord[1], zoom, symMul)
        const edge = boundaryPoint({ shape: 'rect', center: [c.x, c.y], width: size, height: e.kind === 'vehicle' ? size * 0.7 : size, rotation: (e.rotation ?? 0) - bearing }, [pointer.x, pointer.y])
        return { key: `object:${e.id}`, target: { kind: 'object', id: e.id, live: !!e.live }, point: edge, defaultRouting: e.kind === 'team' ? 'trace' : 'direct' }
      })
    const lineTargets: MagneticTarget[] = drawings
      .filter((d) => d.kind === 'line' && d.id !== sourceId && d.coords.length >= 2)
      .flatMap((d) => (['start', 'end'] as const).flatMap((endpoint) => {
        const point = endpoint === 'start' ? d.coords[0] : d.coords[d.coords.length - 1]
        const p = map.project(point)
        const capacity = endpoint === 'end' && d.teilstueck ? 3 : 1
        const usedPorts = incomingAttachments(attachmentLines, d.id, endpoint).map((x) => x.attachment.port ?? 0)
        const free = Array.from({ length: capacity }, (_, i) => i).filter((port) => !usedPorts.includes(port))
        const neighbor = map.project(endpoint === 'start' ? d.coords[1] : d.coords[d.coords.length - 2])
        return free.map((port) => {
          // three-port Teilstück ends fan onto the drawn fork prongs; every other endpoint is the bare tip
          const point = capacity === 3 ? forkPortPoint([p.x, p.y], [neighbor.x, neighbor.y], d.width ?? 4, port) : [p.x, p.y] as [number, number]
          return { key: `line:${d.id}:${endpoint}:${port}`, target: { kind: 'line', id: d.id, endpoint }, point, capacity, usedPorts, port, blocked: wouldCreateCycle(attachmentLines, sourceId, d.id), defaultRouting: 'direct' as const }
        })
      }))
    return [...objectTargets, ...lineTargets]
  }
  const beginEndpointDrag = (id: string, endpoint: LineEndpoint, coord: LngLat) => {
    setEndpointDrag({ id, endpoint, coord, dwell: EMPTY_DWELL, candidate: null })
  }
  const moveEndpointDrag = (coord: LngLat) => {
    const st = endpointDragRef.current, map = mapInst.current
    if (!st || !map) return
    const pointer = map.project(coord)
    const targets = candidatesAt(st.id, coord)
    const candidate = stickyMagneticTarget([pointer.x, pointer.y], targets, st.candidate?.key ?? null)
    const dwell = advanceDwell(st.dwell, candidate && !candidate.blocked ? candidate.key : null, Date.now())
    setEndpointDrag({ ...st, coord, candidate, dwell })
    // haptic tick when a fresh target locks (visual fill is CSS-driven); no gating on it
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    if (candidate && !candidate.blocked && !dwell.armed) {
      dwellTimer.current = setTimeout(() => {
        const cur = endpointDragRef.current
        if (!cur || cur.candidate?.key !== candidate.key) return
        setEndpointDrag({ ...cur, dwell: { ...cur.dwell, armed: true } })
        navigator.vibrate?.(12)
      }, Math.max(0, 350 - (Date.now() - dwell.since)))
    }
  }
  const finishEndpointDrag = () => {
    const st = endpointDragRef.current
    if (!st) return
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    const stored = storedDrawings.find((d) => d.id === st.id)
    const existing = st.endpoint === 'start' ? stored?.startAttachment : stored?.endAttachment
    // Move-not-detach: releasing over a valid target attaches / re-targets. Over empty space a FREE
    // endpoint just moves there; an already-attached endpoint snaps back to its target (no change) —
    // detaching is explicit (the × chip beside the node / the Verbindung lösen button), never a
    // side effect of dragging. So attached branch lines can be repositioned without being severed.
    if (st.candidate && !st.candidate.blocked) {
      const target = st.candidate.target
      const entity = target.kind === 'object' ? entities.find((e) => e.id === target.id) : null
      const port = target.kind === 'line' ? st.candidate.port ?? nextFreePort(attachmentLines, target.id, target.endpoint) ?? undefined : undefined
      const attachment: LineAttachment = {
        target, port, routing: st.candidate.defaultRouting ?? 'direct',
        ...(target.kind === 'object' && entity?.live ? { gps: { state: 'guarded' as const, confirmedAt: entity.coord, lastSafe: entity.coord } } : {}),
      }
      onDrawingAttachment?.(st.id, st.endpoint, attachment, st.coord)
    } else if (!existing) onDrawingAttachment?.(st.id, st.endpoint, undefined, st.coord)
    setEndpointDrag(null)
  }

  const attachmentForCandidate = (candidate: MagneticTarget): LineAttachment => {
    const target = candidate.target
    const entity = target.kind === 'object' ? entities.find((e) => e.id === target.id) : null
    return {
      target, routing: candidate.defaultRouting ?? 'direct',
      ...(target.kind === 'line' ? { port: candidate.port ?? nextFreePort(attachmentLines, target.id, target.endpoint) ?? undefined } : {}),
      ...(target.kind === 'object' && entity?.live ? { gps: { state: 'guarded' as const, confirmedAt: entity.coord, lastSafe: entity.coord } } : {}),
    }
  }
  const updateDraftMagnet = (phase: 'start' | 'move' | 'end', coord: LngLat): { startAttachment?: LineAttachment; endAttachment?: LineAttachment } | void => {
    const map = mapInst.current
    if (!map) return
    if (phase === 'start') {
      const targets = candidatesAt('__draft__', coord), pp = map.project(coord)
      const candidate = nearestMagneticTarget([pp.x, pp.y], targets)
      const atStart = draftKind === 'line' && !freehand ? draft.length === 0 : true
      const next: DraftMagnet = { first: coord, coord, atStart, dwell: advanceDwell(EMPTY_DWELL, candidate && !candidate.blocked ? candidate.key : null, Date.now()), candidate }
      setDraftMagnet(next)
      if (candidate && !candidate.blocked) draftDwellTimer.current = setTimeout(() => {
        const now = draftMagnet.current
        if (!now || now.candidate?.key !== candidate.key) return
        const attachment = attachmentForCandidate(candidate)
        setDraftMagnet({ ...now, dwell: { ...now.dwell, armed: true }, ...(now.atStart ? { startAttachment: attachment } : { endAttachment: attachment }) })
        navigator.vibrate?.(12)
      }, 350)
    } else if (phase === 'move') {
      const cur = draftMagnet.current; if (!cur) return
      const a = map.project(cur.first), b = map.project(coord)
      const atStart = Math.hypot(b.x - a.x, b.y - a.y) < 10 && !cur.startAttachment
      const targets = candidatesAt('__draft__', coord)
      const candidate = stickyMagneticTarget([b.x, b.y], targets, cur.candidate?.key ?? null)
      const next = { ...cur, coord, atStart, candidate, dwell: advanceDwell(cur.dwell, candidate && !candidate.blocked ? candidate.key : null, Date.now()) }
      setDraftMagnet(next)
      if (draftDwellTimer.current) clearTimeout(draftDwellTimer.current)
      if (candidate && !candidate.blocked && !next.dwell.armed) draftDwellTimer.current = setTimeout(() => {
        const now = draftMagnet.current
        if (!now || now.candidate?.key !== candidate.key) return
        const attachment = attachmentForCandidate(candidate)
        setDraftMagnet({ ...now, dwell: { ...now.dwell, armed: true }, ...(now.atStart ? { startAttachment: attachment } : { endAttachment: attachment }) })
        navigator.vibrate?.(12)
      }, Math.max(0, 350 - (Date.now() - next.dwell.since)))
    } else {
      const cur = draftMagnet.current
      if (draftDwellTimer.current) clearTimeout(draftDwellTimer.current)
      // Attach on release, no dwell hold needed. Recompute the target at the actual release point
      // (a fast stroke never lingers long enough for 'move' to have locked one) so the END of a
      // freehand line attaches when it finishes on an object or another line's endpoint.
      const rp = map.project(coord)
      const candidate = stickyMagneticTarget([rp.x, rp.y], candidatesAt('__draft__', coord), cur?.candidate && !cur.candidate.blocked ? cur.candidate.key : null)
      const atEnd = !!cur && !cur.atStart
      let start = cur?.startAttachment, end = cur?.endAttachment
      if (candidate && !candidate.blocked) {
        const attachment = attachmentForCandidate(candidate)
        if (cur?.atStart) start = start ?? attachment; else if (atEnd) end = end ?? attachment
      }
      const out = cur ? { startAttachment: start, endAttachment: end } : undefined
      setDraftMagnet(null)
      return out
    }
  }
  const nodeMagnetActive = draftKind === 'line' && !freehand && !!onDraftPointAttachment
  const finishDraftNodeMagnet = (coord: LngLat) => {
    const out = updateDraftMagnet('end', coord)
    onDraftPointAttachment?.(out?.startAttachment ?? out?.endAttachment)
  }
  // own position (GPS) — a quiet blue dot so the crew can see where they stand relative to the
  // Einsatzort. ON DEMAND, not a continuous watch: a permanent high-accuracy watchPosition keeps
  // the GPS chip powered for the whole shift, one of the biggest battery drains — and once you know
  // where you are it rarely needs re-checking. So we take a single fix each time the operator taps
  // "Mein Standort" (locateNonce bumps), then fly to it. Best-effort: silently absent if
  // denied/unavailable. `maximumAge` lets a very recent fix answer instantly without waking the chip.
  const [userPos, setUserPos] = useState<LngLat | null>(null)
  useEffect(() => {
    if (staticView || !locateNonce) return
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const c: LngLat = [p.coords.longitude, p.coords.latitude]
        setUserPos(c)
        const m = mapInst.current
        if (m) m.flyTo({ center: c, zoom: Math.max(m.getZoom(), 16), duration: 600 })
      },
      () => { /* denied / unavailable — leave the last known dot (if any) as is */ },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    )
  }, [locateNonce, staticView])

  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady || !fitPoints?.length) return
    setTimeout(() => {
      try {
        map.resize()
        if (fitPoints.length === 1) {
          map.jumpTo({ center: fitPoints[0], zoom: initialZoom, bearing: initialBearing })
          return
        }
        const lngs = fitPoints.map((p) => p[0])
        const lats = fitPoints.map((p) => p[1])
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
        const minLat = Math.min(...lats), maxLat = Math.max(...lats)
        if (minLng === maxLng && minLat === maxLat) map.jumpTo({ center: [minLng, minLat], zoom: initialZoom, bearing: initialBearing })
        else {
          map.setBearing(initialBearing)
          map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 48, duration: 0, maxZoom: 18 })
        }
      } catch { /* map gone */ }
    }, 0)
  }, [fitPoints, initialBearing, initialZoom, mapReady])

  // Register FireGIS point symbols (hydrant, valve…) as map icons, tinted to the layer
  // colour, so the Leitungskataster point layers can render them via a symbol layer.
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady) return
    for (const l of layers) {
      if (l.vectorKind !== 'point' || !l.symbol) continue
      const raw = byName[l.symbol]
      if (!raw) continue
      // register the day-tinted icon and, when the layer has a nightColor, a brighter
      // night-tinted variant (icon-<id>-night) so dark-map point symbols (hydrant/Schieber)
      // stay legible — MapLayers swaps icon-image to the night variant in night mode
      const variants: { id: string; color: string }[] = [{ id: `icon-${l.id}`, color: l.color ?? '#000' }]
      if (l.nightColor) variants.push({ id: `icon-${l.id}-night`, color: l.nightColor })
      for (const v of variants) {
        if (map.hasImage(v.id)) continue
        const svg = raw.replace(/#000000/gi, v.color).replace('<svg ', '<svg width="64" height="64" ')
        const img = new Image(64, 64)
        img.onload = () => {
          const m = mapInst.current
          if (m && !m.hasImage(v.id)) { m.addImage(v.id, img, { pixelRatio: 2 }); m.triggerRepaint() }
        }
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      }
    }
  }, [mapReady, layers, byName])

  // Keep the base raster(s) pinned BELOW the tactical drawings. react-map-gl appends every layer
  // without a `beforeId` and re-adds late-loading sources on each `styledata`, so a base raster
  // that loads (or re-loads on a day/night swap) AFTER the synchronous draw layers would stack on
  // top and paint over them ("drawings vanish"). On every styledata, move any base layer that has
  // drifted above `l-draw-sel` back beneath it — guarded so we only move when actually needed
  // (a no-op move would itself fire styledata → an event loop).
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady) return
    const keepBaseBelowDrawings = () => {
      if (!map.isStyleLoaded()) return
      const layerList = map.getStyle().layers ?? []
      const drawIdx = layerList.findIndex((l) => l.id === 'l-draw-sel')
      if (drawIdx < 0) return
      for (let i = drawIdx + 1; i < layerList.length; i++) {
        const id = layerList[i].id
        if (id.startsWith('l-base') && map.getLayer(id)) {
          try { map.moveLayer(id, 'l-draw-sel') } catch { /* order already fine */ }
        }
      }
    }
    map.on('styledata', keepBaseBelowDrawings)
    keepBaseBelowDrawings()
    return () => { map.off('styledata', keepBaseBelowDrawings) }
  }, [mapReady])

  // Register a single tintable arrowhead icon (SDF) used by annotated polylines (Messpfeil /
  // Rettungsachse). SDF lets `icon-color` recolour it to the line colour. The glyph points
  // UP (north / bearing 0); the symbol layer rotates it via the feature's `bearing`.
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady) return
    // (re)register the SDF arrowhead. A map style RELOAD (day/night swap, base-layer change) clears
    // all registered images, so the once-on-mount registration left the icon missing afterwards and
    // the arrowheads silently vanished (the Pfeil preset "did nothing"). Re-add it on every
    // styledata when it's gone, so the tip survives theme/base switches.
    const ensureArrow = () => {
      if (map.hasImage('draw-arrow')) return
      const S = 48 // render at a higher resolution so the arrowhead stays crisp when scaled up
      const cv = document.createElement('canvas'); cv.width = S; cv.height = S
      const ctx = cv.getContext('2d'); if (!ctx) return
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.moveTo(S / 2, 4)            // tip (top)
      ctx.lineTo(S - 6, S - 8)        // bottom-right
      ctx.lineTo(S / 2, S - 16)       // notch
      ctx.lineTo(6, S - 8)            // bottom-left
      ctx.closePath()
      ctx.fill()
      const data = ctx.getImageData(0, 0, S, S)
      map.addImage('draw-arrow', { width: S, height: S, data: data.data }, { sdf: true, pixelRatio: 2 })
      map.triggerRepaint()
    }
    ensureArrow()
    map.on('styledata', ensureArrow)
    return () => { map.off('styledata', ensureArrow) }
  }, [mapReady])

  // canvas-level pointer gestures (freehand drawing + marquee multi-select) live in a
  // dedicated hook; they bind directly to the MapLibre instance and toggle dragPan.
  const { fhPath, marquee, circle } = useMapCanvasGestures({ mapInst, mapReady, freehand, onFreehand, onFreehandPointer: updateDraftMagnet, marqueeEnabled, drawings, entities, onMarquee, circleEnabled, onCircle, circleMinRadiusM: appConfig.drawing.circleMinRadiusM, circleInitialRadiusM: appConfig.drawing.circleInitialRadiusM })

  // a circle drawing as a closed polygon ring (LngLat[]) for rendering / selection outline.
  const circleRing = (d: Drawing): LngLat[] => circlePolygon(d.coords[0], d.radiusM ?? 0)[0] as LngLat[]

  // a point on a circle's edge at a SCREEN direction (0 = top of the screen, 180 = bottom),
  // compensated for the live map `bearing` so the chip stays put relative to the screen as the
  // map rotates. (Was pinned to geographic north, so the radius readout swung off the top edge
  // and ended up at the side/bottom once the operator turned the map.)
  const circleEdgeAtScreen = (center: LngLat, radiusM: number, screenDeg: number): LngLat => {
    const dir = ((bearing + screenDeg) * Math.PI) / 180
    const mPerLon = 111320 * Math.cos((center[1] * Math.PI) / 180)
    return [center[0] + (radiusM * Math.sin(dir)) / mPerLon, center[1] + (radiusM * Math.cos(dir)) / 110540]
  }

  const drawFC = fc(drawings.filter((d) => Array.isArray(d.coords) && d.coords.length > 0).map((d) => {
    const p = { id: d.id, color: d.color || '#1f6feb', width: d.width || 4, dashed: !!d.dashed, arrow: !!d.arrow, marker: d.marker || '', showDistance: !!d.showDistance, label: d.label || '', fillOpacity: d.fillOpacity ?? 0.14, networkDepth: relationship.depth.get(`line:${d.id}`) ?? -1 }
    if (d.kind === 'circle') return polyFeat(circleRing(d), p)
    return d.kind === 'area' && d.coords.length >= 3 ? polyFeat(d.coords, p) : lineFeat(d.coords, p)
  }))

  // arrowheads: a Point per line carrying an `arrow` flag, placed at the LAST coord with
  // a `bearing` (deg, clockwise-from-north) derived from the final segment in a local
  // east/north frame (lng delta scaled by cos(lat)) so the rotation looks geographically
  // correct. Rendered by a symbol layer with a registered arrow icon.
  const arrowFeats = drawings
    .filter((d) => d.kind !== 'area' && d.arrow && Array.isArray(d.coords) && d.coords.length >= 2)
    .map((d) => {
      const n = d.coords.length
      const [aLng, aLat] = d.coords[n - 2]
      const [bLng, bLat] = d.coords[n - 1]
      const cosL = Math.cos((bLat * Math.PI) / 180) || 1e-6
      const dx = (bLng - aLng) * cosL, dy = bLat - aLat
      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI // 0 = north, +clockwise
      return { type: 'Feature', geometry: { type: 'Point', coordinates: d.coords[n - 1] }, properties: { id: d.id, color: d.color || '#1f6feb', bearing } }
    })
  const arrowFC = fc(arrowFeats)

  // distance / free-text overlays pinned to each annotated line's midpoint (reuses the
  // measure-label HTML-marker pattern). Distance uses the SAME geodesic length the Measure
  // tool uses (pathLengthM), and adds the hose-length helper line on Messpfeil lines.
  const drawLabels = drawings
    .filter((d) => (d.showDistance || d.label) && Array.isArray(d.coords) && d.coords.length >= 2)
    .map((d) => {
      // a labelled `area` (= a Sektor/Abschnitt) pins its label at the polygon centroid;
      // a line pins at its midpoint. Distance is line-only (an area has no path length).
      const isArea = d.kind === 'area' && d.coords.length >= 3
      const base: LngLat = isArea
        ? [d.coords.reduce((s, p) => s + p[0], 0) / d.coords.length, d.coords.reduce((s, p) => s + p[1], 0) / d.coords.length]
        : d.coords[Math.floor((d.coords.length - 1) / 2)]
      const lines: string[] = []
      if (d.showDistance && !isArea) { const len = pathLengthM(d.coords); lines.push(`${fmtDistance(len)} · ${hoseLengthHint(len)}`) }
      if (d.label) lines.push(d.label)
      // a dragged label is pinned to its georeferenced anchor; otherwise the midpoint/centroid
      return { id: d.id, coord: d.labelAt ?? base, lines }
    })
    .filter((l) => l.lines.length > 0)
  // inline repeating letter marker (e.g. R on a Rettungsachse) rendered as DOM Markers
  // densely along the WHOLE line — NOT a MapLibre `text-field` symbol layer, which would
  // need a `glyphs` font source the offline-first style intentionally omits. We walk the
  // polyline in projected screen space and drop a letter every ~MARKER_SPACING_PX, so the
  // —R— rhythm reads at any zoom. Falls back to the midpoint until the map is ready.
  // walk the polyline in PROJECTED screen px (shared spacing math), then lerp the ORIGINAL lng/lat by
  // each {seg, t} so the —R— rhythm reads at any zoom. SAME helper the Plan whiteboard uses.
  const markerPointsAlong = (coords: LngLat[]): LngLat[] => {
    const m = mapInst.current
    if (!m) return [coords[Math.floor((coords.length - 1) / 2)]]
    const px = coords.map((c) => { const p = m.project(c as [number, number]); return [p.x, p.y] as [number, number] })
    const out = markerParamsAlong(px).map(({ seg, t }) => lerpPoint(coords[seg], coords[seg + 1], t) as LngLat)
    if (out.length === 0) out.push(coords[Math.floor((coords.length - 1) / 2)])
    return out
  }
  const drawMarkers = drawings
    .filter((d) => d.kind !== 'area' && !!d.marker && Array.isArray(d.coords) && d.coords.length >= 2)
    .flatMap((d) => markerPointsAlong(d.coords).map((coord, i) => ({ id: `${d.id}-${i}`, coord, marker: d.marker!, color: d.color || '#1f6feb' })))
  // committed Absperrkreis circles carry their radius at the SCREEN-TOP edge (not the centre,
  // which is the drag handle) so the size reads without sitting in the middle of the action.
  // The edge point tracks the map bearing so it stays at the top of the screen when rotated.
  const circleLabels = drawings
    .filter((d) => d.kind === 'circle' && (d.radiusM ?? 0) > 0 && Array.isArray(d.coords) && d.coords.length > 0)
    .map((d) => ({ id: d.id, coord: circleEdgeAtScreen(d.coords[0], d.radiusM ?? 0, 0), text: fmtDistance(d.radiusM!) }))
  // locked drawings: skipped by click-selection (click-through) and marked with a lock chip —
  // for a circle (Absperrkreis) the chip sits on the BOTTOM EDGE, not the centre, so it doesn't
  // cover the incident/evacuation point; area uses the centroid, a line its midpoint.
  const lockedIds = new Set(drawings.filter((d) => d.locked).map((d) => d.id))
  const lockChips = drawings
    .filter((d) => d.locked && Array.isArray(d.coords) && d.coords.length > 0)
    .map((d) => {
      const coord: LngLat = d.kind === 'circle'
        ? circleEdgeAtScreen(d.coords[0], d.radiusM ?? 0, 180) // screen-bottom edge of the ring
        : d.kind === 'area'
          ? [d.coords.reduce((s, p) => s + p[0], 0) / d.coords.length, d.coords.reduce((s, p) => s + p[1], 0) / d.coords.length]
          : d.coords[Math.floor((d.coords.length - 1) / 2)]
      return { id: d.id, coord }
    })
  // FKS hose-line decorations (Teilstück fork · content letter · Druckleitung/storey badge).
  // The fork rotates to the line's SCREEN angle (projected last segment) so it stays aligned
  // at any map bearing; the text chips stay upright. Mirrors the Plan whiteboard overlay.
  const lineDecor = drawings
    .filter((d) => d.kind === 'line' && Array.isArray(d.coords) && d.coords.length >= 2 && hasLineDecor(d))
    .map((d) => {
      const n = d.coords.length
      const end = d.coords[n - 1]
      // default tag anchor sits just BEFORE the tip (72% along the last segment), not on it
      const anchor = lerpPoint(d.coords[n - 2], end, 0.72) as LngLat
      const m = mapInst.current
      let angleDeg = 0
      if (m) {
        const pe = m.project(end as [number, number])
        const pr = m.project(d.coords[n - 2] as [number, number])
        angleDeg = (Math.atan2(pe.y - pr.y, pe.x - pr.x) * 180) / Math.PI
      }
      return { d, end, anchor, angleDeg, color: d.color || '#1f6feb', width: d.width || 4 }
    })
  // the draft outline/fill; its vertices render as draggable Markers (not circles) below
  const draftFC = fc(draft.length >= 2 ? [draftKind === 'area' && draft.length >= 3 ? polyFeat(draft) : lineFeat(draft)] : [])
  // measure path: line / polygon only — the vertices are draggable Markers, not circles
  const measureFC = fc(measurePoints.length >= 2
    ? [measureKind === 'area' && measurePoints.length >= 3 ? polyFeat(measurePoints) : lineFeat(measurePoints)]
    : [])

  // editing a selected drawing: show draggable vertex handles + a move handle. Vertex
  // handles are hidden for big freehand strokes (too many points to grab) — those can
  // still be moved/deleted as a whole. The fat hit-line lets a click insert a vertex.
  const editDraw = !picking && !freehand && !draftKind && !measureKind && resolvedSelectedDrawing && Array.isArray(resolvedSelectedDrawing.coords) && resolvedSelectedDrawing.coords.length > 0 ? resolvedSelectedDrawing : null
  const editCircle = !!editDraw && editDraw.kind === 'circle'
  const editArea = !!editDraw && editDraw.kind === 'area' && editDraw.coords.length >= 3
  // circle: no per-vertex handles (it's centre + radius, not a polyline) — the centre
  // move-grip relocates it and the DrawEditor sets the radius.
  const editVertices = !!editDraw && !editCircle && editDraw.coords.length <= MAX_VERTEX_HANDLES
  const editFC = fc(editDraw ? [editCircle ? polyFeat(circleRing(editDraw)) : editArea ? polyFeat(editDraw.coords) : lineFeat(editDraw.coords)] : [])
  const editCentroid: LngLat | null = editDraw
    ? [editDraw.coords.reduce((s, c) => s + c[0], 0) / editDraw.coords.length,
       editDraw.coords.reduce((s, c) => s + c[1], 0) / editDraw.coords.length]
    : null
  const moveRef = useRef<{ start: LngLat; coords: LngLat[] } | null>(null)
  // Translate from the geometry snapshotted at drag-start (moveRef.coords), NOT the live doc —
  // 'move' streams into the doc each frame, so reading it back would re-add the full delta and
  // race the line away. Attached endpoints stay pinned (moveLineBody) and re-resolve on render.
  const bodyMovedCoords = (id: string, dx: number, dy: number): LngLat[] => {
    const stored = storedDrawings.find((d) => d.id === id)
    const base = moveRef.current?.coords ?? stored?.coords
    if (!base || !stored) return stored?.coords ?? []
    return moveLineBody({ id, points: base, startAttachment: stored.startAttachment, endAttachment: stored.endAttachment }, [dx, dy])
  }
  // a marquee group (≥2 across drawings + entities): a single move grip + delete at the
  // combined centre; which objects light up as "selected" = the group, else the single edit
  // target. Both boxed drawings AND boxed symbols/entities join the group.
  const groupActive = (selectedDrawIds.length + selectedEntityIds.length) > 1 && !picking && !freehand && !draftKind && !measureKind
  const groupDraws = groupActive ? drawings.filter((d) => selectedDrawIds.includes(d.id) && Array.isArray(d.coords) && d.coords.length > 0) : []
  const groupEnts = groupActive ? entities.filter((e) => selectedEntityIds.includes(e.id) && Array.isArray(e.coord) && !e.live) : []
  const groupCentroid: LngLat | null = (groupDraws.length + groupEnts.length)
    ? (() => { let sx = 0, sy = 0, n = 0; for (const d of groupDraws) for (const [x, y] of d.coords) { sx += x; sy += y; n++ } for (const e of groupEnts) { sx += e.coord[0]; sy += e.coord[1]; n++ } return n ? [sx / n, sy / n] : null })()
    : null
  const groupMoveRef = useRef<{ start: LngLat } | null>(null)
  // dragging a line's distance/text label: the label is anchored at a GEOREFERENCED point
  // (the polyline midpoint, or a dragged `labelAt`). We keep the grab offset between the
  // pointer and that anchor constant, and on each move unproject (pointer − grab) back to a
  // lng/lat — so the label tracks the finger AND stays pinned to the ground at any zoom/bearing.
  const labelDrag = useRef<{ id: string; gx: number; gy: number; which: 'label' | 'end' } | null>(null)
  // pointer → georeferenced [lng,lat], minus the grab offset captured on pointerdown
  const labelAnchorAt = (e: React.PointerEvent): LngLat | null => {
    const m = mapInst.current, st = labelDrag.current; if (!m || !st) return null
    const r = m.getContainer().getBoundingClientRect()
    const p = m.unproject([e.clientX - r.left - st.gx, e.clientY - r.top - st.gy])
    return [p.lng, p.lat]
  }
  const labelDown = (e: React.PointerEvent, id: string, anchor: LngLat, which: 'label' | 'end' = 'label') => {
    e.stopPropagation(); e.preventDefault()
    const m = mapInst.current
    const r = m?.getContainer().getBoundingClientRect()
    const a = m?.project(anchor as [number, number])
    // grab offset = pointer − the anchor's current screen position, so the label doesn't jump under the finger
    labelDrag.current = { id, gx: r && a ? e.clientX - r.left - a.x : 0, gy: r && a ? e.clientY - r.top - a.y : 0, which }
    onLabelMove?.(id, null, 'start', which)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    // The label is a plain (non-draggable) Marker living INSIDE maplibre's canvas container,
    // whose DragPan arms on the native `mousedown`/`touchstart`. React's onPointerDown
    // stopPropagation only stops the pointerdown — the separate native mousedown still bubbles
    // to DragPan and pans the whole map under the finger. Disable the map's pan for the gesture
    // (same toggle-dragPan pattern the canvas-gesture hook uses) and re-enable it on release.
    mapInst.current?.dragPan.disable()
  }
  const labelMove = (e: React.PointerEvent) => {
    const st = labelDrag.current; if (!st) return
    e.stopPropagation()
    const at = labelAnchorAt(e); if (at) onLabelMove?.(st.id, at, 'move', st.which)
  }
  const labelUp = (e: React.PointerEvent) => {
    mapInst.current?.dragPan.enable()
    const st = labelDrag.current; if (!st) return
    e.stopPropagation()
    const at = labelAnchorAt(e); if (at) onLabelMove?.(st.id, at, 'end', st.which)
    labelDrag.current = null
  }
  const selHighlight: (string | number)[] = selectedDrawIds.length ? selectedDrawIds : (selectedDrawingId ? [selectedDrawingId] : ['__none__'])
  // rotate the whole selected drawing around its centroid. The angle is measured in
  // screen space from the centroid; we rotate the coords in a local east/north frame
  // (lng scaled by cos(lat)) so the turn looks rigid, then bake it back into coords.
  const drawRot = useRef<{ cx: number; cy: number; a0: number; coords: LngLat[]; cLng: number; cLat: number } | null>(null)
  const drawRotDown = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    if (!editDraw || !editCentroid) return
    const hub = (e.currentTarget as HTMLElement).closest('.draw-edit-hub') as HTMLElement | null
    if (!hub) return
    const r = hub.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    drawRot.current = { cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), coords: editDraw.coords, cLng: editCentroid[0], cLat: editCentroid[1] }
    onDrawingEdit?.(editDraw.id, editDraw.coords, 'start')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const drawRotMove = (e: React.PointerEvent) => {
    const st = drawRot.current; if (!st || !editDraw) return
    const d = Math.atan2(e.clientY - st.cy, e.clientX - st.cx) - st.a0
    const cosL = Math.cos((st.cLat * Math.PI) / 180) || 1e-6
    const cs = Math.cos(-d), sn = Math.sin(-d) // screen y-down → negate for north-up frame
    const rot = st.coords.map(([lng, lat]): LngLat => {
      const dx = (lng - st.cLng) * cosL, dy = lat - st.cLat
      return [st.cLng + (dx * cs - dy * sn) / cosL, st.cLat + (dx * sn + dy * cs)]
    })
    onDrawingEdit?.(editDraw.id, rot, 'move')
  }
  const drawRotUp = () => { if (drawRot.current && editDraw) onDrawingEdit?.(editDraw.id, editDraw.coords, 'end'); drawRot.current = null }

  // which path segment a click landed on (pixel-space point→segment distance), so a
  // click on the measure line/outline inserts a vertex there instead of appending.
  // Returns the insert index (after the segment's start; closing edge → push at end).
  const segInsertIndex = (points: LngLat[], isArea: boolean, ll: LngLat): number | null => {
    const m = mapInst.current
    if (!m || points.length < 2) return null
    const cp = m.project(ll as [number, number])
    const px = points.map((p) => m.project(p as [number, number]))
    const n = px.length
    const segs = isArea && n >= 3 ? n : n - 1 // area: include closing edge
    let best = -1, bestD = Infinity
    for (let i = 0; i < segs; i++) {
      const a = px[i], b = px[(i + 1) % n]
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy || 1
      const t = Math.max(0, Math.min(1, ((cp.x - a.x) * dx + (cp.y - a.y) * dy) / len2))
      const d = Math.hypot(cp.x - (a.x + t * dx), cp.y - (a.y + t * dy))
      if (d < bestD) { bestD = d; best = i }
    }
    return best < 0 ? null : best + 1
  }

  const handleClick = (e: MapLayerMouseEvent) => {
    // swallow the click that trails a long-press vertex delete (keeps the line selected)
    if (suppressClick.current) { suppressClick.current = false; return }
    // picking takes precedence — lock the clicked coordinate, place nothing
    if (picking) { onPick?.([e.lngLat.lng, e.lngLat.lat]); return }
    const lc: LngLat = [e.lngLat.lng, e.lngLat.lat]
    // clicking the measure path inserts a draggable vertex on that segment
    if (measureKind && onMeasureInsert && e.features?.some((f) => f.layer?.id === 'l-measure-hit')) {
      const idx = segInsertIndex(measurePoints, measureKind === 'area', lc)
      if (idx != null) { onMeasureInsert(idx, lc); return }
    }
    // clicking the selected drawing's outline inserts a vertex there (reshape)
    if (editDraw && editVertices && onDrawingVertexInsert && e.features?.some((f) => f.layer?.id === 'l-draw-edit-hit')) {
      const idx = segInsertIndex(editDraw.coords, editArea, lc)
      if (idx != null) { onDrawingVertexInsert(editDraw.id, idx, lc); return }
    }
    // clicking the in-progress draft's outline inserts a vertex there (same as measure)
    if (draftKind && onDraftInsert && e.features?.some((f) => f.layer?.id === 'l-draft-hit')) {
      const idx = segInsertIndex(draft, draftKind === 'area', lc)
      if (idx != null) { onDraftInsert(idx, lc); return }
    }
    // while a placement tool is active, a click adds/places — don't let a drawing's
    // fill/outline under the cursor swallow it as a selection (so symbols etc. can be
    // dropped INSIDE an area). Selection-by-click only applies in the Select tool.
    if (!placing) {
      // among every drawing under the cursor, pick the SMALLEST shape — so a small Fläche
      // drawn over a big Absperrkreis (radius) wins the click instead of the circle's fill
      // swallowing it (both are polygons in one layer, so render order alone is unreliable).
      // Lines/outlines have ~0 area, keeping thin lines the most specific (selectable) pick.
      // Locked shapes are skipped entirely so they go click-through (unlock via the lock chip).
      const cands = (e.features ?? []).filter((f) => f?.properties?.id != null && !lockedIds.has(f.properties!.id as string))
      if (cands.length) {
        let best = cands[0]
        let bestA = featArea(best)
        for (let i = 1; i < cands.length; i++) {
          const a = featArea(cands[i])
          if (a < bestA) { bestA = a; best = cands[i] }
        }
        onSelectDrawing(best.properties!.id as string); return
      }
    }
    onMapClick(lc)
  }
  const fhFC = fc(fhPath && fhPath.length >= 2 ? [lineFeat(fhPath)] : [])
  // team trails: the dashed line through a Trupp's RECORDED positions (parity with the plan
  // board's ink polyline — the breadcrumb dots + timestamps stay DOM markers in MapMarkers)
  const trailFC = fc(trailsVisible ? entities
    .filter((e) => e.kind === 'team' && isVisible(e.layer) && (e.trail?.length ?? 0) >= 2)
    .map((e) => lineFeat((e.trail ?? []).map((p) => p.coord), { color: e.color || appConfig.drawing.teamColors[0] })) : [])

  return (
   <>
    <Map
      ref={ref}
      initialViewState={{ longitude: initialCenter[0], latitude: initialCenter[1], zoom: initialZoom, bearing: initialBearing }}
      mapStyle={EMPTY_STYLE}
      onClick={handleClick}
      interactiveLayerIds={['l-draw-edit-hit', 'l-measure-hit', 'l-draft-hit', 'l-draw-hit', 'l-draw-line', 'l-draw-line-dash', 'l-draw-fill']}
      onLoad={(e) => {
        const m = e.target as MlMap
        mapInst.current = m
        setMapReady(true)
        // PWA cold start can initialise the map before its container has a real size, leaving a
        // single tile stretched across the view (the "kaleidoscope"). Force a couple of resizes
        // once layout settles so MapLibre re-fetches tiles at the correct size.
        requestAnimationFrame(() => { try { m.resize() } catch { /* map gone */ } })
        setTimeout(() => { try { m.resize() } catch { /* map gone */ } }, 400)
      }}
      onMoveEnd={(e) => { setZoom(e.viewState.zoom); setBearing(e.viewState.bearing); onView({ bearing: e.viewState.bearing, center: [e.viewState.longitude, e.viewState.latitude], zoom: e.viewState.zoom }) }}
      // Keep only the LOCAL bearing live per rotate frame (the tactical glyphs re-render with the
      // −bearing offset so they stay geographically pinned). Deliberately NOT calling onView here:
      // that re-renders all of IncidentWorkspace every frame of a two-finger rotate. onMoveEnd
      // fires at the end of the gesture and updates App's view state then — the App-level compass /
      // coord readout just settle on release instead of tracking every frame.
      onRotate={(e) => setBearing(e.viewState.bearing)}
      // North-snap: a GESTURE (originalEvent set — programmatic easeTo/flyTo carry none, so
      // «Nach Norden», saved views and the snap's own ease never re-trigger it) that releases
      // within a few degrees of north eases back to exactly 0. Accidental rotation from a
      // two-finger zoom self-heals; deliberate rotation past the threshold sticks.
      onRotateEnd={(e) => {
        if (e.originalEvent && snapNorth(e.viewState.bearing) != null) {
          mapInst.current?.easeTo({ bearing: 0, duration: 250 })
        }
      }}
      onMouseDown={nodeMagnetActive ? (e) => updateDraftMagnet('start', [e.lngLat.lng, e.lngLat.lat]) : undefined}
      onMouseMove={(picking || nodeMagnetActive) ? (e) => { if (picking) onCursor?.([e.lngLat.lng, e.lngLat.lat]); if (nodeMagnetActive) updateDraftMagnet('move', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      onMouseUp={nodeMagnetActive ? (e) => finishDraftNodeMagnet([e.lngLat.lng, e.lngLat.lat]) : undefined}
      onMouseOut={picking ? () => onCursor?.(null) : undefined}
      // mousemove never fires on touch — stream the aim coords from the drag as well,
      // so the crosshair readout tracks the finger on iPhone/iPad
      onTouchStart={nodeMagnetActive ? (e) => updateDraftMagnet('start', [e.lngLat.lng, e.lngLat.lat]) : undefined}
      onTouchMove={(picking || nodeMagnetActive) ? (e) => { if (picking) onCursor?.([e.lngLat.lng, e.lngLat.lat]); if (nodeMagnetActive) updateDraftMagnet('move', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      onTouchEnd={nodeMagnetActive ? (e) => finishDraftNodeMagnet([e.lngLat.lng, e.lngLat.lat]) : undefined}
      cursor={picking ? 'crosshair' : undefined}
      attributionControl={false}
      maxPitch={0}
      maxZoom={20}
      // Only the print/report instance needs its GL back-buffer preserved (it captures the canvas
      // via getCanvas().toDataURL() — see ReportPrintView / reportPdf). On the always-live field
      // map keeping the buffer around just raises the per-repaint GPU/memory cost for the whole
      // shift, so gate it to the static instance.
      preserveDrawingBuffer={staticView}
    >
      <QuietAttributionControl />
      <MapLayers layers={layers} preparedOverlays={preparedOverlays} isVisible={isVisible} mapReady={mapReady} />

      {/* committed drawings (per-feature colour/width) — gated by the markup layer toggle */}
      <Source id="s-draw" type="geojson" data={drawFC}>
        <Layer id="l-draw-network" type="line" filter={['>=', ['get', 'networkDepth'], 0] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible) }}
          paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 9], 'line-opacity': ['interpolate', ['linear'], ['get', 'networkDepth'], 0, 0.34, 4, 0.08] } as any} />
        <Layer id="l-draw-sel" type="line" filter={['in', ['get', 'id'], ['literal', selHighlight]] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible) }}
          paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 6], 'line-opacity': 0.5 } as any} />
        <Layer id="l-draw-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} layout={vis(drawingsVisible)} paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.14] } as any} />
        {/* solid + dashed split: line-dasharray can't be data-driven, so dashed lines
            render in their own layer filtered on the feature's `dashed` property */}
        <Layer id="l-draw-line" type="line" filter={['!', ['get', 'dashed']] as any} layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible) }} paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] } as any} />
        <Layer id="l-draw-line-dash" type="line" filter={['get', 'dashed'] as any} layout={{ 'line-cap': 'butt', 'line-join': 'round', ...vis(drawingsVisible) }} paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': LINE_DASH_ML } as any} />
        {/* fat transparent hit line over EVERY drawn line (solid + dashed) so a click on or
            near any line — including thin/styled ones like the Rettungsachse — selects it */}
        <Layer id="l-draw-hit" type="line" filter={['!=', ['geometry-type'], 'Polygon']} layout={{ ...vis(drawingsVisible) }} paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } as any} />
        {/* the inline letter marker (e.g. R on a Rettungsachse) renders as a DOM Marker below
            — a MapLibre text-field symbol would require a `glyphs` font source this
            offline-first style intentionally omits (it would also break offline). */}
      </Source>
      {/* arrowheads at the end of annotated lines (Messpfeil / Rettungsachse) — a tintable
          SDF icon rotated to the final-segment bearing */}
      <Source id="s-draw-arrow" type="geojson" data={arrowFC}>
        <Layer id="l-draw-arrow" type="symbol"
          layout={{ 'icon-image': 'draw-arrow', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-anchor': 'center', 'icon-size': 1.1, ...vis(drawingsVisible) } as any}
          paint={{ 'icon-color': ['get', 'color'] } as any} />
      </Source>
      {/* team trails — dashed path through the recorded positions, in the team's colour
          (same look as the plan board's trail polyline); under the DOM markers by nature */}
      <Source id="s-team-trails" type="geojson" data={trailFC}>
        <Layer id="l-team-trails" type="line" layout={{ 'line-join': 'round' }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2.5, 2.5], 'line-opacity': 0.85 } as any} />
      </Source>
      {/* live draft (area/line tool) — vertices are draggable handles (rendered below),
          so the in-progress shape edits exactly like the measure path */}
      <Source id="s-draft" type="geojson" data={draftFC}>
        <Layer id="l-draft-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} paint={{ 'fill-color': '#1f6feb', 'fill-opacity': 0.08 }} />
        <Layer id="l-draft-line" type="line" paint={{ 'line-color': '#1f6feb', 'line-width': 2, 'line-dasharray': [1.5, 1] }} />
        {/* fat transparent hit line so segment clicks (insert vertex) are easy to land */}
        <Layer id="l-draft-hit" type="line" paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 }} />
      </Source>
      {/* live Absperrkreis preview while dragging centre → edge (the committed circle
          renders through the normal drawings source once released) */}
      {circle && circle.radiusM > 0 && (
        <Source id="s-circle" type="geojson" data={fc([polyFeat(circlePolygon(circle.center, circle.radiusM)[0] as LngLat[])])}>
          <Layer id="l-circle-fill" type="fill" paint={{ 'fill-color': appConfig.drawing.circleColor, 'fill-opacity': appConfig.drawing.circleFillOpacity }} />
          <Layer id="l-circle-line" type="line" paint={{ 'line-color': appConfig.drawing.circleColor, 'line-width': 2, 'line-dasharray': [2, 1.5] }} />
        </Source>
      )}
      {circle && circle.radiusM > 0 && (() => {
        const top = circleEdgeAtScreen(circle.center, circle.radiusM, 0)
        return (
          <Marker longitude={top[0]} latitude={top[1]} anchor="bottom" offset={[0, -4]}>
            <div className="measure-label draw-label">{fmtDistance(circle.radiusM)}</div>
          </Marker>
        )
      })()}

      {/* live freehand path */}
      <Source id="s-fh" type="geojson" data={fhFC}>
        <Layer id="l-fh" type="line" paint={{ 'line-color': drawColor, 'line-width': drawWidth, ...(drawDashed ? { 'line-dasharray': LINE_DASH_ML } : {}) }} layout={{ 'line-cap': drawDashed ? 'butt' : 'round', 'line-join': 'round' }} />
      </Source>

      {/* measurement path (line / polygon) — vertices rendered as draggable handles below */}
      <Source id="s-measure" type="geojson" data={measureFC}>
        <Layer id="l-measure-fill" type="fill" paint={{ 'fill-color': '#1f6feb', 'fill-opacity': 0.1 }} />
        <Layer id="l-measure-line" type="line" paint={{ 'line-color': '#1f6feb', 'line-width': 2.5, 'line-dasharray': [2, 1.2] }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        {/* fat transparent hit line so segment clicks (insert vertex) are easy to land */}
        <Layer id="l-measure-hit" type="line" paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 }} />
      </Source>

      {/* selected drawing being edited: an outline + fat hit-line so a click on the edge
          inserts a vertex. The visible reshape handles are DOM Markers, rendered below. */}
      {editDraw && editVertices && (
        <Source id="s-draw-edit" type="geojson" data={editFC}>
          <Layer id="l-draw-edit-hit" type="line" paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 }} />
        </Source>
      )}

      {/* Einsatzort — a quiet ring marking the incident/object location so it stays
          findable after the map is panned away. Sits below the placed markers. */}
      <Marker longitude={initialCenter[0]} latitude={initialCenter[1]} anchor="center">
        <div className="map-here map-incident" title={appConfig.copy.map.incidentHere} />
      </Marker>

      {/* own live position (GPS) */}
      {userPos && (
        <Marker longitude={userPos[0]} latitude={userPos[1]} anchor="center">
          <div className="map-here map-me" title={appConfig.copy.map.youHere} />
        </Marker>
      )}

      {/* locked coordinate reticle */}
      {pickedPoint && (
        <Marker longitude={pickedPoint[0]} latitude={pickedPoint[1]} anchor="center">
          <div className="pick-reticle" />
        </Marker>
      )}

      {/* draggable draft vertices (area/line tool) — drag to move, right-click to delete,
          identical to the measurement handles so the in-progress shape edits the same way */}
      {draftKind && draft.map((p, i) => (
        <Marker
          key={`dh${i}`}
          longitude={p[0]}
          latitude={p[1]}
          anchor="center"
          draggable
          onDrag={(e) => { vertexPress.cancel(); onDraftDrag?.(i, [e.lngLat.lng, e.lngLat.lat]) }}
          onDragEnd={(e) => onDraftDrag?.(i, [e.lngLat.lng, e.lngLat.lat])}
        >
          <div
            className="measure-handle"
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(() => onDraftDelete?.(i))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); onDraftDelete?.(i) }}
          />
        </Marker>
      ))}

      {/* draggable measurement vertices */}
      {measureKind && measurePoints.map((p, i) => (
        <Marker
          key={`mh${i}`}
          longitude={p[0]}
          latitude={p[1]}
          anchor="center"
          draggable
          onDrag={(e) => { vertexPress.cancel(); onMeasureDrag?.(i, [e.lngLat.lng, e.lngLat.lat]) }}
          onDragEnd={(e) => onMeasureDrag?.(i, [e.lngLat.lng, e.lngLat.lat])}
        >
          <div
            className="measure-handle"
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(() => onMeasureDelete?.(i))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); onMeasureDelete?.(i) }}
          />
        </Marker>
      ))}

      {/* measurement readouts pinned to the path (cumulative distance / area), above the handles */}
      {measureLabels.map((l, i) => (
        <Marker key={`ml${i}`} longitude={l.coord[0]} latitude={l.coord[1]} anchor="bottom" offset={[0, -12]}>
          <div className={`measure-label ${l.strong ? 'strong' : ''}`}>{l.text}</div>
        </Marker>
      ))}

      {/* annotated-line readouts (auto distance + hose-length helper / free-text label),
          pinned to each line's midpoint — reuses the measure-label chrome */}
      {drawingsVisible && drawLabels.map((l) => (
        <Marker key={`dl${l.id}`} longitude={l.coord[0]} latitude={l.coord[1]} anchor="bottom" offset={[0, -10]}>
          {/* draggable: dragging pins the label to a georeferenced anchor (stays put on zoom/rotate) */}
          <div
            className={`measure-label draw-label draggable${l.id === selectedDrawingId ? ' sel' : ''}`}
            style={{ cursor: onLabelMove ? 'move' : undefined }}
            onPointerDown={onLabelMove ? (e) => labelDown(e, l.id, l.coord) : undefined}
            onPointerMove={onLabelMove ? labelMove : undefined}
            onPointerUp={onLabelMove ? labelUp : undefined}
            onPointerCancel={onLabelMove ? labelUp : undefined}
          >
            {l.lines.map((t, j) => <div key={j}>{t}</div>)}
          </div>
        </Marker>
      ))}

      {/* committed Absperrkreis radius readout, pinned just above the circle's top edge */}
      {drawingsVisible && circleLabels.map((c) => (
        <Marker key={`cl${c.id}`} longitude={c.coord[0]} latitude={c.coord[1]} anchor="bottom" offset={[0, -4]}>
          <div className={`measure-label draw-label${c.id === selectedDrawingId ? ' sel' : ''}`}>{c.text}</div>
        </Marker>
      ))}

      {/* lock chip on every locked drawing — the click-through shape's only tap target;
          tapping it unlocks + selects the shape (Figma/Miro-style lock affordance) */}
      {drawingsVisible && onUnlockDrawing && lockChips.map((c) => (
        <Marker key={`lk${c.id}`} longitude={c.coord[0]} latitude={c.coord[1]} anchor="center">
          <LockChip onUnlock={() => onUnlockDrawing(c.id)} />
        </Marker>
      ))}

      {/* FKS hose-line decorations: Teilstück fork + content letter at the tip, Druckleitung/storey badge at the start */}
      {drawingsVisible && lineDecor.map((ld) => (
        <Fragment key={`ld${ld.d.id}`}>
          {ld.d.teilstueck && (
            <Marker longitude={ld.end[0]} latitude={ld.end[1]} anchor="center">
              <TeilstueckFork angleDeg={ld.angleDeg} color={ld.color} width={ld.width} />
            </Marker>
          )}
          {(ld.d.content || ld.d.lineNo != null || ld.d.floorTag != null) && (
            <Marker longitude={(ld.d.endLabelAt ?? ld.anchor)[0]} latitude={(ld.d.endLabelAt ?? ld.anchor)[1]} anchor="center" offset={[0, -14]}>
              {/* the -14 offset lifts the tag clear of the line end; dragging pins it to a georeferenced anchor */}
              <div className={`line-end-tag-wrap draggable${ld.d.id === selectedDrawingId ? ' sel' : ''}`}
                style={{ cursor: onLabelMove ? 'move' : undefined }}
                onPointerDown={onLabelMove ? (e) => labelDown(e, ld.d.id, ld.d.endLabelAt ?? ld.anchor, 'end') : undefined}
                onPointerMove={onLabelMove ? labelMove : undefined}
                onPointerUp={onLabelMove ? labelUp : undefined}
                onPointerCancel={onLabelMove ? labelUp : undefined}>
                <EndTag lineNo={ld.d.lineNo} content={ld.d.content} floorTag={ld.d.floorTag} color={ld.color} />
              </div>
            </Marker>
          )}
        </Fragment>
      ))}

      {/* inline line marker letter (e.g. R on a Rettungsachse), tinted to the line colour */}
      {drawingsVisible && drawMarkers.map((m) => (
        <Marker key={`dm${m.id}`} longitude={m.coord[0]} latitude={m.coord[1]} anchor="center">
          <div className="draw-marker" style={{ color: m.color }}>{m.marker}</div>
        </Marker>
      ))}

      {/* Snap indicator: a ring pinned to the connection point that fills up to solid over ~350ms
          while hovered (keyed to the target so it restarts on a new one). It's a hover flourish —
          the attach commits on release. Cycle-forming targets are silently skipped (never offered),
          so there is no blocked state. No detach × on drag: detach is the explicit chip beside the node. */}
      {endpointDrag?.candidate && mapInst.current && (() => {
        const ll = mapInst.current.unproject(endpointDrag.candidate.point)
        return <Marker key={endpointDrag.candidate.key} longitude={ll.lng} latitude={ll.lat} anchor="center"><span className="magnet-port snap" /></Marker>
      })()}
      {draftMagnetState?.candidate && mapInst.current && (() => {
        const ll = mapInst.current.unproject(draftMagnetState.candidate.point)
        return <Marker key={draftMagnetState.candidate.key} longitude={ll.lng} latitude={ll.lat} anchor="center"><span className="magnet-port snap" /></Marker>
      })()}
      {hiddenAttachmentTargets.map((e) => <Marker key={`hidden-${e.id}`} longitude={e.coord[0]} latitude={e.coord[1]} anchor="center"><span className="hidden-attachment-marker" /></Marker>)}

      {/* selected drawing — on-canvas edit handles: a move grip at the centre, a delete
          ✕ above it, and (for non-huge shapes) a draggable handle on every vertex */}
      {editDraw && editCentroid && (
        <Marker longitude={editCentroid[0]} latitude={editCentroid[1]} anchor="center">
          <div className="draw-edit-hub">
            {onDrawingEdit && !editCircle && (
              <div className="draw-rotor">
                <span className="draw-stem" />
                <button
                  className="draw-rotate"
                  title={appConfig.copy.shapes.rotateHint}
                  aria-label={appConfig.copy.shapes.rotateHint}
                  onPointerDown={drawRotDown}
                  onPointerMove={drawRotMove}
                  onPointerUp={drawRotUp}
                  onPointerCancel={drawRotUp}
                  onClick={(ev) => ev.stopPropagation()}
                ><Icon id="rotate" /></button>
              </div>
            )}
            {onDrawingDelete && (
              <button
                className="draw-del"
                title={appConfig.copy.delete}
                aria-label={appConfig.copy.delete}
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => { ev.stopPropagation(); onDrawingDelete(editDraw.id) }}
              ><Icon id="close" /></button>
            )}
          </div>
        </Marker>
      )}
      {editDraw && editCentroid && onDrawingEdit && (
        <Marker
          longitude={editCentroid[0]}
          latitude={editCentroid[1]}
          anchor="center"
          draggable
          onDragStart={() => { moveRef.current = { start: editCentroid, coords: editDraw.coords }; onDrawingEdit(editDraw.id, editDraw.coords, 'start') }}
          onDrag={(e) => { const m = moveRef.current; if (!m) return; const dx = e.lngLat.lng - m.start[0], dy = e.lngLat.lat - m.start[1]; onDrawingEdit(editDraw.id, bodyMovedCoords(editDraw.id, dx, dy), 'move') }}
          onDragEnd={(e) => { const m = moveRef.current; if (!m) { onDrawingEdit(editDraw.id, editDraw.coords, 'end'); return } const dx = e.lngLat.lng - m.start[0], dy = e.lngLat.lat - m.start[1]; onDrawingEdit(editDraw.id, bodyMovedCoords(editDraw.id, dx, dy), 'end'); moveRef.current = null }}
        >
          <div className="draw-move" title={appConfig.copy.drawingEditor.move} aria-label={appConfig.copy.drawingEditor.move}><Icon id="move" /></div>
        </Marker>
      )}
      {editDraw && editVertices && onDrawingEdit && editDraw.coords.map((p, i) => {
        const endpoint: LineEndpoint | null = editDraw.kind === 'line' && i === 0 ? 'start' : editDraw.kind === 'line' && i === editDraw.coords.length - 1 ? 'end' : null
        return (
        <Marker
          key={`dv${i}`}
          longitude={p[0]}
          latitude={p[1]}
          anchor="center"
          draggable
          onDragStart={() => endpoint && onDrawingAttachment ? beginEndpointDrag(editDraw.id, endpoint, p) : onDrawingEdit(editDraw.id, editDraw.coords, 'start')}
          onDrag={(e) => { vertexPress.cancel(); endpoint && onDrawingAttachment ? moveEndpointDrag([e.lngLat.lng, e.lngLat.lat]) : onDrawingEdit(editDraw.id, editDraw.coords.map((q, j) => (j === i ? [e.lngLat.lng, e.lngLat.lat] : q)), 'move') }}
          onDragEnd={(e) => endpoint && onDrawingAttachment ? (moveEndpointDrag([e.lngLat.lng, e.lngLat.lat]), finishEndpointDrag()) : onDrawingEdit(editDraw.id, editDraw.coords.map((q, j) => (j === i ? [e.lngLat.lng, e.lngLat.lat] : q)), 'end')}
        >
          <div
            className="draw-handle"
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(() => deleteVertexKeepSelection(editDraw.id, i))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); deleteVertexKeepSelection(editDraw.id, i) }}
          />
        </Marker>
        )
      })}
      {/* explicit detach: a × chip beside a connected endpoint of the selected line. Dragging the node
          only moves/re-targets (never severs), so this is how a connection is broken on-canvas. */}
      {editDraw && editDraw.kind === 'line' && onDrawingAttachment && !endpointDrag && (['start', 'end'] as const).map((ep) => {
        const a = ep === 'start' ? selectedDrawing?.startAttachment : selectedDrawing?.endAttachment
        if (!a || editDraw.coords.length < 2) return null
        const pt = ep === 'start' ? editDraw.coords[0] : editDraw.coords[editDraw.coords.length - 1]
        const neighbor = ep === 'start' ? editDraw.coords[1] : editDraw.coords[editDraw.coords.length - 2]
        // On detach, retract the endpoint ~26px toward its own body so it visibly pops off the target.
        const detachAt = (): LngLat => {
          const map = mapInst.current; if (!map) return pt
          const p = map.project(pt), q = map.project(neighbor)
          const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1
          const ll = map.unproject([p.x + (dx / len) * 26, p.y + (dy / len) * 26])
          return [ll.lng, ll.lat]
        }
        return (
          <Marker key={`detach-${ep}`} longitude={pt[0]} latitude={pt[1]} anchor="center" offset={[18, -18]}>
            <span className="line-detach-chip" role="button" title={appConfig.copy.drawingEditor.detachConnection} aria-label={appConfig.copy.drawingEditor.detachConnection}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => { ev.stopPropagation(); onDrawingAttachment(editDraw.id, ep, undefined, detachAt()) }}>×</span>
          </Marker>
        )
      })}

      {/* marquee group (≥2 drawings + entities): one move grip + delete at the combined centre */}
      {groupCentroid && (
        <Marker longitude={groupCentroid[0]} latitude={groupCentroid[1]} anchor="center">
          <div className="draw-edit-hub">
            {onGroupDelete && (
              <button
                className="draw-del"
                title={appConfig.copy.delete}
                aria-label={appConfig.copy.delete}
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => { ev.stopPropagation(); onGroupDelete(selectedDrawIds, selectedEntityIds) }}
              ><Icon id="close" /></button>
            )}
          </div>
        </Marker>
      )}
      {groupCentroid && onGroupMove && (
        <Marker
          longitude={groupCentroid[0]}
          latitude={groupCentroid[1]}
          anchor="center"
          draggable
          onDragStart={() => { groupMoveRef.current = { start: groupCentroid }; onGroupMove(selectedDrawIds, selectedEntityIds, 0, 0, 'start') }}
          onDrag={(e) => { const s = groupMoveRef.current; if (!s) return; onGroupMove(selectedDrawIds, selectedEntityIds, e.lngLat.lng - s.start[0], e.lngLat.lat - s.start[1], 'move') }}
          onDragEnd={(e) => { const s = groupMoveRef.current; if (s) onGroupMove(selectedDrawIds, selectedEntityIds, e.lngLat.lng - s.start[0], e.lngLat.lat - s.start[1], 'end'); groupMoveRef.current = null }}
        >
          <div className="draw-move" title={appConfig.copy.drawingEditor.move} aria-label={appConfig.copy.drawingEditor.move}><Icon id="move" /></div>
        </Marker>
      )}

      {/* entity markers — guard against malformed entities (e.g. a server workspace
          missing a coord) so one bad row can't white-screen the whole map */}
      <MapMarkers
        entities={entities}
        byName={byName}
        isVisible={isVisible}
        selectedId={selectedId}
        groupSelectedIds={groupEnts.length ? selectedEntityIds : []}
        networkEntityIds={[...relationship.objectIds]}
        zoom={zoom}
        bearing={bearing}
        symMul={symMul}
        captionMode={captionMode}
        draggable={draggable}
        project={(c) => mapInst.current?.project(c as [number, number])}
        unproject={(p) => { const m = mapInst.current; if (!m) return undefined; const ll = m.unproject([p.x, p.y]); return [ll.lng, ll.lat] }}
        setDragPan={(on) => { const dp = mapInst.current?.dragPan; if (!dp) return; if (on) dp.enable(); else dp.disable() }}
        onSelect={onSelect}
        onMarkerDragStart={onMarkerDragStart}
        onMarkerMove={onMarkerMove}
        onMarkerDragEnd={onMarkerDragEnd}
        onDelete={onDelete}
        onRotate={onRotate}
        onShapeTransform={onShapeTransform}
        editNoteId={editNoteId}
        onNoteText={onNoteText}
        onNoteCommit={onNoteCommit}
        onNoteEdit={onNoteEdit}
        trupps={trupps}
        onShowTrupp={onShowTrupp}
        onTeamMark={onTeamMark}
        onTeamClearTrail={onTeamClearTrail}
        trailsVisible={trailsVisible}
        onToggleTrails={() => setTrailsVisible((v) => !v)}
      />

    </Map>
    {/* the live wind/temperature readout moved into the TopBar (next to "Eintrag"); the
        floating corner badge is retired so it no longer collides with the right tool rail. */}
    {marquee && (
      <div
        className="marquee-box"
        style={{
          position: 'fixed',
          left: Math.min(marquee.x0, marquee.x1),
          top: Math.min(marquee.y0, marquee.y1),
          width: Math.abs(marquee.x1 - marquee.x0),
          height: Math.abs(marquee.y1 - marquee.y0),
        }}
      />
    )}
   </>
  )
})
