import { forwardRef, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Map, { Marker, Source, Layer, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import type { Map as MlMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { CaptionMode, Drawing, Entity, LayerDef, LayerId, LineAttachment, LineEndpoint, LngLat, PreparedMapOverlay, Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { beginSheetPeek, endSheetPeek } from '../lib/sheetPeek'
import { motionDuration } from '../lib/reducedMotion'
import { Icon } from '../lib/icons'
import { LockChip } from './LockChip'
import { LINE_DASH_ML } from '../lib/draw'
import { markerParamsAlong, lerpPoint, vertexHandleIndices, evenIndices, hubOffsetPx, EXTEND_STEP_PX } from '../lib/lineStyle'
import { EMPTY_STYLE, vis, fc, lineFeat, polyFeat, pathSegmentCount, resumeViewState, snapNorth, shapePx, symPx, effectiveLayer } from '../lib/mapView'
import { TeilstueckFork, EndTag, hasLineDecor } from '../lib/lineDecor'
import { floorBadge } from '../lib/symbolRender'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import { cachedLabelSize, LABEL_RANK, MARKER_Z, placeLabels, type LabelBox, type LabelCandidate, type LabelStyle } from '../lib/labelPass'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { pathLengthM, fmtDistance, fmtArea, polygonAreaM2, hoseLengthHint, circlePolygon } from '../lib/geo'
import { noteWPx } from '../lib/notes'
import { useVehicleTrails } from '../lib/useVehicleTrails'
import { useMapCanvasGestures } from './useMapCanvasGestures'
import { MapMarkers } from './MapMarkers'
import { MapLayers } from './MapLayers'
// long-press to delete a path vertex (touch — desktop right-click kept); the placed-object
// move threshold lives in MapMarkers with the entity-drag logic.
import { useNodeHold } from '../lib/nodeHold'
import { ConnectRing, NodeDeleteChip } from './NodeDeleteChip'
import { useGlRecovery } from '../lib/useGlRecovery'
import { useNightTheme } from '../lib/useNightTheme'
import { useIsPhone } from '../lib/useIsPhone'
import { reportClientError } from '../lib/reportError'
import { QuietAttributionControl } from './MapAttribution'
import { GeorefCheckOutline, GeorefMapLoupe, GeorefMapMarks } from './GeorefMapLayer'
import { GeorefTwinsMap } from './GeorefTwinsMap'
import { GeorefContentMap } from './GeorefContentMap'
import type { MapContentTwin, MapTwin } from '../lib/georefTwins'
import { georefDispatch, georefPhoneTargetPoint, georefTapOnMarker, georefWantsMap, registerGeorefPhoneTarget, useGeorefMapTap, useGeorefMode } from '../lib/georefMode'
import { advanceDwell, armDwell, attachInsetPx, boundaryPoint, detachProgress, DETACH_SHOW_PROGRESS, EMPTY_DWELL, forkPortPoint, gpsGuard, incomingAttachments, MAGNET_DWELL_MS, moveLineBody, nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget, wouldCreateCycle, type AttachableLine, type DwellState, type MagneticTarget } from '../lib/lineAttachments'

// ── label-pass geometry: the numbers the stylesheet uses, said once ────────────────────────

// Every edit handle of a SELECTED drawing (node pads, «+» midpoints, grow arrows, the hub, the
// move grip, detach chips — and the marquee group's) rides at MARKER_Z.selected: a react-map-gl
// marker defaults to z-auto, which paints BELOW every resting symbol/team (MARKER_Z 4–8), so the
// very handles a selection exists for disappeared behind the symbols the line ran under — the
// endpoint could not be grabbed to extend it (28.08. field feedback). One stacking table for all
// of it (lib/labelPass), like the end tags directly below.
const handleZ: React.CSSProperties = { zIndex: MARKER_Z.selected }
// The pass measures a label before it exists in the DOM, so the chrome around its text has to
// be mirrored here. When a label's CSS changes, these change with it — each is named for the
// rule it comes from.
const NO_LABELS: ReadonlySet<string> = new Set()
/** `.team-dot i` and its `gap` (09-whiteboard.css) */
const TEAM_DOT_PX = 13
const TEAM_DOT_GAP = 6
/** `.sym-caption { margin-top }` (03-map.css) */
const CAPTION_GAP = 3
/** the end tag's Marker `offset={[0, -14]}` (below) */
const END_TAG_LIFT = 14
/** the line-readout / radius Markers' `anchor="bottom"` offsets (below) */
const READOUT_LIFT = 10
const RADIUS_LIFT = 4
const LABEL_STYLE = {
  /** `.sym-caption` — wraps at compound seams inside 120px; 1px/6px padding, line-height 1.25 */
  caption: { font: '700 11.5px Sora, system-ui, sans-serif', maxTextW: 120, chromeW: 12, chromeH: 2, lineH: 14.4 },
  /** `.team-dot b` — never wraps */
  team: { font: '700 11.5px Sora, system-ui, sans-serif', maxTextW: Infinity, chromeW: 12, chromeH: 2, lineH: 15 },
  /** `.measure-label.draw-label` — mono, never wraps, 2px/7px padding */
  readout: { font: '700 11px "Spline Sans Mono", ui-monospace, monospace', maxTextW: Infinity, chromeW: 14, chromeH: 4, lineH: 13.8 },
  /** `.line-end-tag` — 2px/6px padding plus a 1.5px border; `inline-grid` stacks the Trupp row */
  endTag: { font: '800 11.5px Sora, system-ui, sans-serif', maxTextW: Infinity, chromeW: 15, chromeH: 7, lineH: 11.5 },
} satisfies Record<string, LabelStyle>

/** The end tag's text laid out the way `EndTag` lays it out: the Leitung's own facts on one
 *  row, the Trupp on its own (`inline-grid` gives each text run a row of its own). */
function endTagText(d: Drawing, trupp?: Trupp): string {
  const parts: string[] = []
  if (d.lineNo != null) parts.push(String(d.lineNo))
  if (d.content) parts.push(d.content)
  if (d.floorTag != null) parts.push(floorBadge(d.floorTag))
  const name = trupp ? truppTagText(trupp) : ''
  if (!parts.length && !name) return ''
  return [parts.join(' · '), name].filter(Boolean).join('\n')
}

// The grip that MAKES a node and hands it straight to the finger. Two of them are built on it: the
// "+" at the middle of a measured/selected segment, and the «Verlängern» arrow past an open line
// end. The "+" — the Plan already had one per segment
// (WbControls · Messen), and tapping a thin dashed line to land a point between two others is
// the aim that fails with gloves on. Its listeners are NATIVE, not React's: React delegates at
// the tree root, which is an ANCESTOR of the map container, so maplibre's own listener on the
// canvas container has already fired by then — the same tap would insert here AND append a
// point at the end of the path, which is the opposite of what was asked for.
//
// ⚠️ pointerdown INSERTS and hands the new node straight on to the caller's drag (25.08. field
// exercise): «tap the +, then find the node it left behind, then drag that» is three aims where
// there should be one. A release without movement leaves exactly what the old plain click left —
// one node at the segment's midpoint — so nothing was taken away. `onInsert` is called with the
// pointer event when there is one, and with `null` for a keyboard activation (Enter/Space on the
// focused button reports `detail === 0`), where there is no gesture to hand over.
function NewNodeHandle({ title, onInsert, className = 'measure-insert', icon = 'plus', style }: {
  title: string
  onInsert: (e: PointerEvent | null) => void
  /** the two grips built on this: the «+» midpoint insert (default) and the «Verlängern» arrow */
  className?: string
  icon?: string
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLButtonElement>(null)
  // re-bind each render so the closure sees the current onInsert (one element, one listener)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const swallow = (e: Event) => e.stopPropagation()
    const down = (e: PointerEvent) => { e.stopPropagation(); e.preventDefault(); onInsert(e) }
    const click = (e: Event) => {
      e.stopPropagation(); e.preventDefault()
      if ((e as MouseEvent).detail !== 0) return // a pointer already inserted on its way down
      onInsert(null)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('click', click)
    el.addEventListener('mousedown', swallow)
    el.addEventListener('touchstart', swallow, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('click', click)
      el.removeEventListener('mousedown', swallow)
      el.removeEventListener('touchstart', swallow)
    }
  })
  return <button ref={ref} type="button" className={className} title={title} aria-label={title} style={style}><Icon id={icon} /></button>
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
  /** per-device map symbol-size multiplier (lib/prefs · symbolScales, Einstellungen slider) — scales the symPx band */
  symMul?: number
  /** device default for on-canvas symbol captions (lib/prefs · symbolCaptions) */
  captionMode?: CaptionMode
  /** The Lage label pass is the source of truth for which map captions are actually visible.
   *  Share its suppressed entity ids with plan twins so a hidden «Feuer» does not reappear only
   *  because it is projected onto a Modul. */
  onCaptionSuppressionChange?: (ids: ReadonlySet<string>) => void
  initialCenter: LngLat
  initialZoom?: number
  initialBearing?: number
  /** print/static render: fit these points once after load, no geolocation marker */
  fitPoints?: LngLat[]
  staticView?: boolean
  /** bump to take a single GPS fix and fly to it (the "Mein Standort" dot). On demand — no
   *  continuous watch — so the GPS chip isn't powered all shift. 0 = never located yet. */
  locateNonce?: number
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
  /** open a note's detail panel (the ⚙ handle) — see MapMarkers */
  onNotePanel?: (id: string) => void
  /** drag a note text box's width in screen px — see MapMarkers */
  onNoteWidth?: (id: string, w: number | undefined, phase: 'start' | 'move' | 'end') => void
  /** team markers (Trupp tracking on the map) — see MapMarkers */
  trupps?: Trupp[]
  /** per-Trupp contact-clock tier (see atemschutz · AtemschutzAlarmState.severities) — tints the
   *  end tag + halo of the Leitung that Trupp works on. Passed IN because the 1 Hz clock lives in
   *  the alarm host: the map must not re-render every second (measured battery drain). */
  truppSeverities?: Record<string, 1 | 2>
  onShowTrupp?: (truppId: string) => void
  /** join a team marker to an Atemschutz-Trupp (undefined = let go) — see MapMarkers */
  onTeamTrupp?: (entityId: string, truppId: string | undefined) => void
  onTeamMark?: (id: string) => void
  /** rename an untracked team marker (absent = locked, or a Trupp-bound marker) */
  onTeamRename?: (id: string, name: string) => void
  /** recolour a team marker (null = automatic) — see MapMarkers */
  onTeamColor?: (e: Entity, color: string | null) => void
  onTeamClearTrail?: (id: string) => void
  /** tactical editing is locked (viewer role, Führungsansicht, replay). Everything
   *  stays readable — panning, selecting, the ephemeral Messen path — but no affordance that
   *  would mutate the document is rendered: no vertex/move handles on a selected drawing, no
   *  lock chip, no note edit/delete grips. The app-level callbacks are no-ops in this state,
   *  so a handle here would be a control that responds and changes nothing. */
  readOnly?: boolean
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
  onShapeTransform?: (id: string, patch: { rotation?: number; rotation2?: number; sizeM?: number; reachM?: number }, phase: 'start' | 'move' | 'end') => void
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
  /** «schau hier»: one drawing outlined for a few seconds WITHOUT being selected — no vertex
   *  handles, no editor sheet. What «Leitung zeigen» on an Atemschutz card does: it answers where
   *  the hose is, and nothing on screen becomes draggable by answering it. Cleared by the caller. */
  flashDrawingId?: string | null
  /** `at` = where on the map container the tap landed, so the panel nudge can anchor on the spot
   *  that was aimed at instead of on a screen-spanning line's far edge (lib/panelNudge). */
  onSelectDrawing: (id: string, at?: { x: number; y: number }) => void
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
  /** Georeferenz twins: tactical symbols use the interactive point-twin path below; broader
   *  Modul content travels separately through `georefPlanContent`. Both are derived and empty
   *  during replay or whenever their Ebenen row is off. */
  twins?: MapTwin[]
  /** Non-symbol content from linked plans: lines, areas, notes, shapes and Atemschutz markers. */
  georefPlanContent?: MapContentTwin[]
  /** tap on a twin → open its source-backed editor (components/GeorefTwinPanel) */
  onTwinOpen?: (twin: MapTwin) => void
  /** drag a projection of a plan annotation — writes the SOURCE anno through the twin's own
   *  fit, so every other projection of it follows from that one write (see MapTwin · fit) */
  onTwinMove?: (twin: MapTwin, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  /** tap on a mirrored Trupp chip (plan resource twin): jump to its source chip on the Modul */
  onContentTwinOpen?: (twin: MapContentTwin) => void
  /** drag a mirrored Trupp chip: move its one source chip through the fit */
  onContentTwinMove?: (twin: MapContentTwin, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  selectedTwinKey?: string | null
  /** Opt-in literal plan sheets from Ebenen, already rasterized and projected by their fit. */
  georefPlanRasters?: {
    id: string
    url: string
    opacity: number
    coordinates: [[number, number], [number, number], [number, number], [number, number]]
  }[]
}

export const MapView = forwardRef<MapRef, Props>(function MapView(props, ref) {
  const { entities, layers, byName, symMul = 1, captionMode = 'off', onCaptionSuppressionChange, initialCenter, initialZoom = 17.6, initialBearing = 0, fitPoints, staticView = false, locateNonce = 0, preparedOverlays, isVisible, selectedId, onSelect, onMapClick, editNoteId = null, onNoteText, onNoteCommit, onNoteEdit, onNotePanel, onNoteWidth, trupps, truppSeverities, onShowTrupp, onTeamTrupp, onTeamMark, onTeamRename, onTeamColor, onTeamClearTrail,
    readOnly = false, drawings: storedDrawings, drawingsVisible, draft, draftKind, placing, onDraftDrag, onDraftInsert, onDraftDelete, onDraftPointAttachment, draggable, onMarkerDragStart, onMarkerMove, onMarkerDragEnd, onRotate, onShapeTransform,
    onView, picking, onCursor, onPick, pickedPoint, freehand, onFreehand, drawColor, drawWidth, drawDashed, selectedDrawingId, flashDrawingId, onSelectDrawing, onUnlockDrawing, onDelete, measureLabels = [], measurePoints = [], measureKind = null, onMeasureDrag, onMeasureInsert, onMeasureDelete,
    selectedDrawing = null, onDrawingEdit, onDrawingVertexInsert, onDrawingVertexDelete, onDrawingDelete, onDrawingAttachment, onLabelMove,
    marqueeEnabled = false, selectedDrawIds = [], onMarquee, onGroupMove, onGroupDelete, selectedEntityIds = [], circleEnabled = false, onCircle,
    twins = [], georefPlanContent = [], onTwinOpen, onTwinMove, onContentTwinOpen, onContentTwinMove, selectedTwinKey = null, georefPlanRasters = [] } = props
  const [zoom, setZoom] = useState(initialZoom)
  const isPhone = useIsPhone()
  // per-team trail visibility (map-session, default all shown) — the eye in a selected
  // team's action bar hides only THAT team's trail; mirrors the plan board's per-team
  // hiddenTrails. The record itself is never touched here.
  const [hiddenTrails, setHiddenTrails] = useState<ReadonlySet<string>>(new Set())
  /** measure vertex currently in the hand — while set, the cumulative label under that finger
   *  steps aside and the tool's number stands fixed at the top edge instead (mockup 03-B: a
   *  rapidly changing value is read where it stands still, never under the fingertip) */
  const [measureDragNode, setMeasureDragNode] = useState<number | null>(null)
  const toggleTrail = (id: string) => setHiddenTrails((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  // current map bearing (deg) — placed symbols are pinned to GEOGRAPHIC orientation, so the
  // glyph CSS rotation is offset by −bearing and re-renders live as the map rotates (a vehicle
  // "facing south" keeps facing south when you spin the map). Streamed on every rotate frame.
  const [bearing, setBearing] = useState(initialBearing)
  const mapInst = useRef<MlMap | null>(null)
  // hold a node to delete it — one gesture for draft, Messung and drawing vertices alike, with
  // the chip appearing only after the hold has armed (lib/nodeHold). Desktop right-click stays
  // as the mouse shortcut.
  const vertexPress = useNodeHold()
  // A long-press vertex-delete fires mid-gesture; the finger's release then lands a map click on
  // the reshaped background, which would deselect and close the editor. This swallows that one
  // click so the line stays selected and more nodes can be deleted in a row.
  const suppressClick = useRef(false)
  const deleteVertexKeepSelection = (id: string, i: number) => { suppressClick.current = true; onDrawingVertexDelete?.(id, i) }
  // ⚠️ …and the same for the Messung and the draft. Their delete used to be the ONLY one that
  // did not swallow the release: the finger came up where the node had been, the map read it as
  // a tap, and the Messen/Zeichnen tool put a fresh point back at exactly that spot — so a
  // deleted node reappeared and the hold looked broken (19.08.).
  const deletePointKeepTool = (fn?: (i: number) => void) => (i: number) => { suppressClick.current = true; fn?.(i) }
  const [mapReady, setMapReady] = useState(false)
  // A pure PAN changes no other state in this component, but it moves every label on screen, so
  // the label pass has to run again. One counter bumped on moveend is the whole trigger — pan,
  // zoom and rotate all end there. Deliberately NOT per frame: labels appearing and disappearing
  // under a moving finger read as flicker, so the decision is taken once the map comes to rest.
  const [, bumpLabelFrame] = useState(0)
  // MapLibre paint specs can't read CSS vars, so the two TRANSIENT overlays drawn in the UI blue —
  // the draft shape and the measure path — pick their literal here instead of freezing the day
  // value into the paint spec, where they stayed dark-on-dark over a night basemap. These mirror
  // --blue / --blue's night override in app.css. A drawing's OWN colour is data and never flips:
  // its `d.color || '#1f6feb'` fallbacks below are deliberately left alone.
  const night = useNightTheme()
  const uiBlue = night ? '#5aa0ff' : '#1f6feb'

  // ── «Karte verknüpfen»: the map half of the pairing mode (components/GeorefMapLayer) ────────
  // The mode is a module store, not a prop chain: on a phone the Plan surface is unmounted while
  // this map takes the second half of a pair, so there is nobody left to thread props through.
  const georef = useGeorefMode()
  const georefOn = !!georef.planId
  const georefTurn = georefWantsMap(georef)
  // where the pairing aim sits. Cleared the moment the map's turn is over, so the shared loupe
  // never stays parked over a surface nobody is aiming at.
  // A REF, not state: this is written on every pointer sample of the georef turn, and the only
  // thing that needs it is the loupe (GeorefMapLayer · GeorefMapLoupe), which ticks itself off
  // it. As state it re-rendered this whole component — and with it the full label pass — per
  // sample, which is the very thing the note on `onView` below forbids.
  const georefPoint = useRef<{ lng: number; lat: number } | null>(null)
  // tap-vs-pan for the pairing mode, tracked by hand — MapLibre's `click` fires on a pan that
  // ends where it began (see GeorefMapLayer · useGeorefMapTap)
  const georefTap = useGeorefMapTap()
  /** the one place a map half of a pair is placed — true when it really was, so the touch path
   *  knows whether there is a synthetic click trail to cancel (see the note on onTouchEnd) */
  const placeGeoref = (lngLat: { lng: number; lat: number }): boolean => {
    if (!georefTurn) return false
    georefDispatch({ type: 'mapTap', lngLat: { lng: lngLat.lng, lat: lngLat.lat } })
    georefPoint.current = null
    return true
  }
  const aimGeorefMap = () => {
    if (georefTurn && georef.want !== 'map') georefDispatch({ type: 'goMap' })
  }
  // The phone does not place where a finger happens to lift after a pan. It pans/zooms the one
  // live map beneath the app-level fixed target, and the explicit button asks this resolver for
  // the WGS84 coordinate under that exact screen pixel. Desktop keeps its direct tap workflow.
  useEffect(() => {
    if (!isPhone || !georefOn || !mapReady) return
    return registerGeorefPhoneTarget('map', () => {
      const map = mapInst.current
      if (!map) return null
      const surface = map.getContainer().getBoundingClientRect()
      const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom
      const bottom = document.querySelector<HTMLElement>('[data-georef-controls]')?.getBoundingClientRect().top
      const target = georefPhoneTargetPoint(surface, { top, bottom })
      if (!target) return null
      const ll = map.unproject([target.x - surface.left, target.y - surface.top])
      return { lng: ll.lng, lat: ll.lat }
    })
  }, [georefOn, isPhone, mapReady])
  // ⚠️ The container can now change size WITHOUT the window doing so: «Karte verknüpfen» hands
  // the map the right half of the screen (09-whiteboard.css) and takes it back again. MapLibre
  // only listens to the WINDOW, so without this it keeps rendering at the old width — a
  // stretched, mis-projected picture in which every tap lands metres off. A container observer
  // covers the split, its end, and any future layout that moves this element.
  useEffect(() => {
    const m = mapInst.current; if (!m || !mapReady) return
    const ro = new ResizeObserver(() => { try { m.resize() } catch { /* map gone */ } })
    ro.observe(m.getContainer())
    return () => ro.disconnect()
  }, [mapReady])
  // ⚠️ …and SYNCHRONOUSLY when the georef layout itself flips. The observer above fires a frame
  // late (after paint), so entering/leaving the split or «Deckung prüfen» left every DOM marker
  // projecting through the old transform for a frame or two — a visible jump of all crosses and
  // symbols. The width flip is React-rendered (Whiteboard's wb-georef-split/-check classes come
  // from the same georef store snapshot as this component's state), so a layout effect keyed on
  // that state resizes the map in the same commit, before the browser paints: `map.resize()`
  // reads the container's NEW size and re-places the markers synchronously. The observer stays
  // as the backstop for every other way the container can change size.
  useLayoutEffect(() => {
    const m = mapInst.current; if (!m || !mapReady) return
    try { m.resize() } catch { /* map gone */ }
  }, [georefOn, georef.check, mapReady])
  // WebGL context recovery: iPadOS drops the context under memory pressure / after a long
  // background spell, and MapLibre stays blank without rebuilding. `gl.generation` keys the
  // <Map> below so recovery is a fresh instance; `viewRef` carries the CURRENT view across that
  // remount so the operator doesn't get thrown back to the incident's initial framing.
  const viewRef = useRef<{ center: LngLat; zoom: number; bearing: number } | null>(null)
  const gl = useGlRecovery(() => mapInst.current, mapReady, () => {
    mapInst.current = null
    setMapReady(false)
  })
  // `origin` + `attached` + `detach` are the RELEASE half of the ring language: where the endpoint
  // was plugged in when the drag started, whether it still is, and how full the red ring is.
  type EndpointDrag = { id: string; endpoint: LineEndpoint; coord: LngLat; origin: LngLat; attached: boolean; detach: number; dwell: DwellState; candidate: MagneticTarget | null }
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
  const objectPoint = (id: string, toward: LngLat, attachment: import('../types').LineAttachment, source: AttachableLine<LngLat>): LngLat | null => {
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
    // negative padding = the endpoint lands just INSIDE the glyph, so the stroke disappears
    // under the marker instead of stopping short of it (see attachInsetPx)
    const p = boundaryPoint({ shape: 'rect', center: [c.x, c.y], width: size, height: e.kind === 'vehicle' ? size * 0.7 : size, rotation: (e.rotation ?? 0) - bearing }, [t.x, t.y], -attachInsetPx(source.width))
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
    return e && !isVisible(effectiveLayer(e)) ? [e] : []
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
    const stored = storedDrawings.find((d) => d.id === id)
    const attached = !!(endpoint === 'start' ? stored?.startAttachment : stored?.endAttachment)
    setEndpointDrag({ id, endpoint, coord, origin: coord, attached, detach: 0, dwell: EMPTY_DWELL, candidate: null })
  }
  const moveEndpointDrag = (coord: LngLat) => {
    const st = endpointDragRef.current, map = mapInst.current
    if (!st || !map) return
    const pointer = map.project(coord)
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    // Still hooked up? Then the only thing on offer is letting go, and the red ring at the OLD
    // socket runs on distance: pull past the detach radius and the link is off (the endpoint is
    // free from here on, and can court a new target below); stop short and release, and it
    // springs back exactly where it was. No candidate is offered meanwhile — a blue ring while
    // the line is still connected somewhere else would be two promises at once.
    if (st.attached) {
      const o = map.project(st.origin)
      const detach = detachProgress([o.x, o.y], [pointer.x, pointer.y])
      setEndpointDrag({ ...st, coord, detach, attached: detach < 1, candidate: null, dwell: EMPTY_DWELL })
      if (detach >= 1) navigator.vibrate?.(12)
      return
    }
    const targets = candidatesAt(st.id, coord)
    const candidate = stickyMagneticTarget([pointer.x, pointer.y], targets, st.candidate?.key ?? null)
    const dwell = advanceDwell(st.dwell, candidate?.key ?? null, Date.now())
    setEndpointDrag({ ...st, coord, candidate, dwell })
    // A finger that has found its target STOPS MOVING — and then no pointermove fires, so
    // `advanceDwell` alone would never reach `armed`. This timer is what actually closes the
    // ring (the visible fill is the CSS twin of it) and ticks the haptics.
    if (candidate && !dwell.armed) {
      dwellTimer.current = setTimeout(() => {
        const cur = endpointDragRef.current
        if (!cur || cur.candidate?.key !== candidate.key) return
        setEndpointDrag({ ...cur, dwell: { ...cur.dwell, armed: true } })
        navigator.vibrate?.(12)
      }, Math.max(0, MAGNET_DWELL_MS - (Date.now() - dwell.since)))
    }
  }
  const finishEndpointDrag = () => {
    const st = endpointDragRef.current
    if (!st) return
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    // Ring lädt, dann schnappt es: ONLY a completed dwell attaches. Releasing while the ring is
    // still filling drops the endpoint free, right where the finger left it — that is the whole
    // prevention story, and it needs no mode to leave.
    // The other half is the release ring: an endpoint that is STILL attached (`st.attached`)
    // never got pulled far enough, so nothing is written and the resolver springs it back.
    if (st.dwell.armed && st.candidate) {
      const target = st.candidate.target
      const entity = target.kind === 'object' ? entities.find((e) => e.id === target.id) : null
      const port = target.kind === 'line' ? st.candidate.port ?? nextFreePort(attachmentLines, target.id, target.endpoint) ?? undefined : undefined
      const attachment: LineAttachment = {
        target, port, routing: st.candidate.defaultRouting ?? 'direct',
        ...(target.kind === 'object' && entity?.live ? { gps: { state: 'guarded' as const, confirmedAt: entity.coord, lastSafe: entity.coord } } : {}),
      }
      onDrawingAttachment?.(st.id, st.endpoint, attachment, st.coord)
    } else if (!st.attached) onDrawingAttachment?.(st.id, st.endpoint, undefined, st.coord)
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
      // ── Line-START exception ──────────────────────────────────────────────────────────────
      // A pointerDOWN that already lands inside a target's radius is deliberate aim: the finger
      // was PUT on the Teilstück's prong because that is where the branch begins. There is
      // nothing to hesitate about, so this one arms instantly and its ring is drawn full — the
      // dwell exists to catch targets a moving line PASSES OVER, not the one it was aimed at.
      // (Node-mode taps come through here too, and for the same reason: every tap is aimed.)
      if (draftDwellTimer.current) clearTimeout(draftDwellTimer.current)
      const targets = candidatesAt('__draft__', coord), pp = map.project(coord)
      const candidate = nearestMagneticTarget([pp.x, pp.y], targets)
      const atStart = draftKind === 'line' && !freehand ? draft.length === 0 : true
      const attachment = candidate ? attachmentForCandidate(candidate) : undefined
      setDraftMagnet({
        first: coord, coord, atStart, candidate, dwell: armDwell(candidate?.key ?? null, Date.now()),
        ...(attachment ? (atStart ? { startAttachment: attachment } : { endAttachment: attachment }) : {}),
      })
      if (candidate) navigator.vibrate?.(12)
    } else if (phase === 'move') {
      const cur = draftMagnet.current; if (!cur) return
      const a = map.project(cur.first), b = map.project(coord)
      const atStart = Math.hypot(b.x - a.x, b.y - a.y) < 10 && !cur.startAttachment
      const targets = candidatesAt('__draft__', coord)
      const candidate = stickyMagneticTarget([b.x, b.y], targets, cur.candidate?.key ?? null)
      // Leaving the start point ends the start's claim: from here the FAR end has to earn its own
      // ring, even over the very target the stroke began on. Without this reset the instantly
      // armed start would hand its `armed` straight to the end.
      const base = atStart === cur.atStart ? cur.dwell : EMPTY_DWELL
      const next = { ...cur, coord, atStart, candidate, dwell: advanceDwell(base, candidate?.key ?? null, Date.now()) }
      setDraftMagnet(next)
      if (draftDwellTimer.current) clearTimeout(draftDwellTimer.current)
      // arm on a motionless finger (no pointermove ⇒ no advanceDwell); the attachment itself is
      // only materialised on release, so moving on after arming still lets the end go free.
      if (candidate && !next.dwell.armed) draftDwellTimer.current = setTimeout(() => {
        const now = draftMagnet.current
        if (!now || now.candidate?.key !== candidate.key) return
        setDraftMagnet({ ...now, dwell: { ...now.dwell, armed: true } })
        navigator.vibrate?.(12)
      }, Math.max(0, MAGNET_DWELL_MS - (Date.now() - next.dwell.since)))
    } else {
      const cur = draftMagnet.current
      if (draftDwellTimer.current) clearTimeout(draftDwellTimer.current)
      // Ring lädt, dann schnappt es: the far end attaches only if its ring actually closed. A
      // stroke that FINISHES on a symbol without pausing there lands free — deliberately, and it
      // is the reason the ring is drawn at all. (Until 25.08. this recomputed the target at the
      // release point and attached regardless, which is the invisible coupling from the field.)
      let start = cur?.startAttachment, end = cur?.endAttachment
      if (cur?.dwell.armed && cur.candidate) {
        const attachment = attachmentForCandidate(cur.candidate)
        if (cur.atStart) start = start ?? attachment; else end = end ?? attachment
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
        if (m) m.flyTo({ center: c, zoom: Math.max(m.getZoom(), 16), duration: motionDuration(600) })
      },
      () => { /* denied / unavailable — leave the last known dot (if any) as is */ },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    )
  }, [locateNonce, staticView])

  // Frame the incident's existing content — ONCE per incident, not once per map instance.
  // ⚠️ `didFit`, because `mapReady` is not a one-way flag: a lost WebGL context remounts <Map>
  // under a new key and sets it false→true again (see useGlRecovery). This effect then re-ran and
  // fitted to the whole incident extent a tick AFTER `resumeViewState` had put the operator's own
  // framing back — so every recovery threw away the zoom somebody was working at, and under memory
  // pressure that repeats every 60s (the auto-heal's rate limit). Which reads, from the operator's
  // side, as a map that keeps zooming out by itself.
  // The ref belongs to MapView, which stays mounted across surfaces for the whole incident, so it
  // outlives exactly what it has to: the <Map> instances underneath it.
  const didFit = useRef(false)
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady || !fitPoints?.length || didFit.current) return
    didFit.current = true
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
      if (map.hasImage('draw-arrow') && map.hasImage('draw-arrow-stop')) return
      const S = 48 // render at a higher resolution so the arrowhead stays crisp when scaled up
      const head = (stop: boolean) => {
        const cv = document.createElement('canvas'); cv.width = S; cv.height = S
        const ctx = cv.getContext('2d'); if (!ctx) return null
        ctx.fillStyle = '#fff'
        // the «Stopp» variant carries the Entwicklungsgrenze bar just past the tip — the same
        // statement the fire's bounded spread arrow makes, on a line
        const top = stop ? 10 : 4
        if (stop) ctx.fillRect(8, 0, S - 16, 5)
        ctx.beginPath()
        ctx.moveTo(S / 2, top)          // tip (top)
        ctx.lineTo(S - 6, S - 8)        // bottom-right
        ctx.lineTo(S / 2, S - 16)       // notch
        ctx.lineTo(6, S - 8)            // bottom-left
        ctx.closePath()
        ctx.fill()
        return ctx.getImageData(0, 0, S, S)
      }
      for (const [name, stop] of [['draw-arrow', false], ['draw-arrow-stop', true]] as const) {
        if (map.hasImage(name)) continue
        const data = head(stop)
        if (data) map.addImage(name, { width: S, height: S, data: data.data }, { sdf: true, pixelRatio: 2 })
      }
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
    // `truppTone` drives the Atemschutz halo below: '' unless a Trupp on this Leitung is due
    // or überfällig. Resolved here (not per frame) so the paint expression stays a plain lookup.
    const linked = d.kind === 'line' ? truppForLine(d, trupps ?? []) : undefined
    const tone = linked ? truppLineTone(linked, truppSeverities?.[linked.id] ?? 0) : 'idle'
    const p = { id: d.id, color: d.color || '#1f6feb', width: d.width || 4, dashed: !!d.dashed, arrow: !!d.arrow, marker: d.marker || '', showDistance: !!d.showDistance, label: d.label || '', fillOpacity: d.fillOpacity ?? 0.14, networkDepth: relationship.depth.get(`line:${d.id}`) ?? -1, truppTone: tone === 'warn' || tone === 'crit' ? tone : '' }
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
      return { type: 'Feature', geometry: { type: 'Point', coordinates: d.coords[n - 1] }, properties: { id: d.id, color: d.color || '#1f6feb', bearing, icon: d.arrowStop ? 'draw-arrow-stop' : 'draw-arrow' } }
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
      // A line states its length (plus the hose hint); a Fläche states what it covers. Same
      // toggle, same geodesic maths the Messen tool uses — the area used to be computed for
      // the editor panel only and could never reach the map.
      if (d.showDistance && !isArea) { const len = pathLengthM(d.coords); lines.push(`${fmtDistance(len)} · ${hoseLengthHint(len)}`) }
      if (d.showDistance && isArea) lines.push(fmtArea(polygonAreaM2(d.coords)))
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
      // the Atemschutz-Trupp working this Leitung (anchor or number) + how it is doing right now
      const trupp = truppForLine(d, trupps ?? [])
      const tone = trupp ? truppLineTone(trupp, truppSeverities?.[trupp.id] ?? 0) : 'idle'
      return { d, end, anchor, angleDeg, color: d.color || '#1f6feb', width: d.width || 4, trupp, tone }
    })
  // ── ONE label pass for the whole map ─────────────────────────────────────────────────────
  // Every family above (symbol captions, Trupp names, Leitung end tags, line readouts, radius
  // readouts) used to place its label wherever its own geometry pointed, blind to the others,
  // decluttered only by a global zoom switch and truncated by an ellipsis. Now they all go
  // through lib/labelPass: one rank order, one AABB test, nothing moves, and what does not fit
  // is not drawn — its owner paints a 6px ink dot instead. See labelPass.ts for the why.
  function labelDecisions(): ReadonlySet<string> {
    const m = mapInst.current
    if (!m) return NO_LABELS
    const px = (c: LngLat) => m.project(c as [number, number])
    // ties inside a rank go to whatever is nearer the incident — never to placement order
    const hub = px(initialCenter)
    const near = (p: { x: number; y: number }) => Math.hypot(p.x - hub.x, p.y - hub.y)
    const occupied: LabelBox[] = []
    const cands: LabelCandidate[] = []

    // Seed: every visible glyph. A label may cover empty ground, never another symbol.
    for (const e of entities) {
      if (!Array.isArray(e.coord) || !isVisible(effectiveLayer(e))) continue
      const p = px(e.coord)
      const g = e.kind === 'shape' ? shapePx(e.sizeM, e.coord[1], zoom)
        : e.kind === 'photo' ? 56
        : e.kind === 'note' ? noteWPx(e.noteW)
        : e.kind === 'team' ? TEAM_DOT_PX
        : symPx(e.kind, e.coord[1], zoom, symMul)
      const isSel = e.id === selectedId || selectedEntityIds.includes(e.id)
      if (e.kind === 'team') {
        // a resting Trupp marker is `[dot][gap][name]` centred on the coord, so the dot is NOT
        // at the coordinate — the two boxes have to be derived from the whole strip's width
        const label = e.label ?? ''
        const s = cachedLabelSize(label, LABEL_STYLE.team)
        const strip = TEAM_DOT_PX + TEAM_DOT_GAP + (label ? s.w : 0)
        const left = p.x - strip / 2
        occupied.push({ x: left, y: p.y - TEAM_DOT_PX / 2, w: TEAM_DOT_PX, h: TEAM_DOT_PX })
        // the selected Trupp shows its full pill instead of the bare name — not a candidate,
        // but its footprint still has to push everything else away
        if (label && !isSel) {
          cands.push({ key: `team:${e.id}`, rank: LABEL_RANK.team, dist: near(p),
            box: { x: left + TEAM_DOT_PX + TEAM_DOT_GAP, y: p.y - s.h / 2, w: s.w, h: s.h } })
        }
        continue
      }
      occupied.push({ x: p.x - g / 2, y: p.y - g / 2, w: g, h: g })
      // only the glyph branch prints a caption (MapMarkers) — a note's own text is its body,
      // not a caption, and asking symbolCaptionText for one would invent a phantom box
      if (e.kind === 'shape' || e.kind === 'note' || e.kind === 'photo') continue
      const cap = symbolCaptionText(e, captionMode)
      if (!cap) continue
      const s = cachedLabelSize(softHyphenateText(cap), LABEL_STYLE.caption)
      cands.push({ key: `cap:${e.id}`, rank: isSel ? LABEL_RANK.selected : LABEL_RANK.caption, dist: near(p),
        box: { x: p.x - s.w / 2, y: p.y + g / 2 + CAPTION_GAP, w: s.w, h: s.h } })
    }

    if (drawingsVisible) {
      // Leitung end tags. A tag whose Atemschutz-Trupp is due or overdue outranks everything
      // except the selection — that is the one label on the map somebody's air depends on.
      for (const ld of lineDecor) {
        const text = endTagText(ld.d, ld.trupp)
        if (!text) continue
        const p = px(ld.d.endLabelAt ?? ld.anchor)
        const s = cachedLabelSize(text, LABEL_STYLE.endTag)
        cands.push({
          key: `tag:${ld.d.id}`,
          rank: ld.d.id === selectedDrawingId ? LABEL_RANK.selected
            : ld.tone === 'crit' || ld.tone === 'warn' ? LABEL_RANK.criticalTag : LABEL_RANK.tag,
          pinned: !!ld.d.endLabelAt,
          dist: near(p),
          box: { x: p.x - s.w / 2, y: p.y - END_TAG_LIFT - s.h / 2, w: s.w, h: s.h },
        })
      }
      for (const l of drawLabels) {
        const p = px(l.coord)
        const s = cachedLabelSize(l.lines.join('\n'), LABEL_STYLE.readout)
        cands.push({ key: `dl:${l.id}`, rank: l.id === selectedDrawingId ? LABEL_RANK.selected : LABEL_RANK.readout,
          pinned: storedDrawings.some((d) => d.id === l.id && !!d.labelAt), dist: near(p),
          box: { x: p.x - s.w / 2, y: p.y - READOUT_LIFT - s.h, w: s.w, h: s.h } })
      }
      for (const c of circleLabels) {
        const p = px(c.coord)
        const s = cachedLabelSize(c.text, LABEL_STYLE.readout)
        cands.push({ key: `cl:${c.id}`, rank: c.id === selectedDrawingId ? LABEL_RANK.selected : LABEL_RANK.radius, dist: near(p),
          box: { x: p.x - s.w / 2, y: p.y - RADIUS_LIFT - s.h, w: s.w, h: s.h } })
      }
    }
    // The live Messen readouts deliberately stay OUT of the pass: they belong to a tool the
    // operator is holding right now, they change on every vertex drag, and a measurement that
    // blinks out because a caption got there first would be unusable.
    return placeLabels(cands, occupied)
  }
  const suppressedLabels = labelDecisions()
  const suppressedCaptionKey = [...suppressedLabels]
    .filter((key) => key.startsWith('cap:'))
    .map((key) => key.slice(4))
    .sort()
    .join('\u0000')
  useEffect(() => {
    onCaptionSuppressionChange?.(new Set(suppressedCaptionKey ? suppressedCaptionKey.split('\u0000') : []))
  }, [onCaptionSuppressionChange, suppressedCaptionKey])

  // the draft outline/fill; its vertices render as draggable Markers (not circles) below
  const draftFC = fc(draft.length >= 2 ? [draftKind === 'area' && draft.length >= 3 ? polyFeat(draft) : lineFeat(draft)] : [])
  // measure path: line / polygon only — the vertices are draggable Markers, not circles
  const measureFC = fc(measurePoints.length >= 2
    ? [measureKind === 'area' && measurePoints.length >= 3 ? polyFeat(measurePoints) : lineFeat(measurePoints)]
    : [])

  // editing a selected drawing: show draggable vertex handles + a move handle.
  // read-only never gets handles: the app's edit callbacks are no-ops there, so grabbable-looking
  // vertices would move under the finger and snap back — the worst kind of 3am lie.
  const editDraw = !readOnly && !picking && !freehand && !draftKind && !measureKind && resolvedSelectedDrawing && Array.isArray(resolvedSelectedDrawing.coords) && resolvedSelectedDrawing.coords.length > 0 ? resolvedSelectedDrawing : null
  const editCircle = !!editDraw && editDraw.kind === 'circle'
  const editArea = !!editDraw && editDraw.kind === 'area' && editDraw.coords.length >= 3
  // circle: no per-vertex handles (it's centre + radius, not a polyline) — the centre
  // move-grip relocates it and the DrawEditor sets the radius.
  const editNodes = !!editDraw && !editCircle
  // Which of those vertices actually get a pad. A dense freehand stroke used to get NONE (the
  // old `coords.length <= MAX_VERTEX_HANDLES` gate) — it now gets an evenly spread subset that
  // densifies as the operator zooms in, since the thinning is measured in projected px. Recomputed
  // on every render; the map bumps a render on moveend (see bumpLabelFrame), so a pinch-zoom lands
  // the new spread when the fingers come off.
  const editHandleIdx = editNodes && editDraw
    ? mapInst.current
      ? vertexHandleIndices(editDraw.coords.map((c) => { const p = mapInst.current!.project(c as [number, number]); return [p.x, p.y] as [number, number] }))
      : evenIndices(editDraw.coords.length)
    : []
  // every node is on screen ⇒ the «+» midpoint handles are honest. On a thinned line they are not:
  // the midpoint between two SHOWN nodes is nowhere near the path when real vertices sit between
  // them, so inserting there would yank the line straight. Tapping the fat hit-line still inserts
  // at the right segment (segInsertIndex walks all points), which is the affordance that survives.
  const editAllNodes = editNodes && !!editDraw && editHandleIdx.length === editDraw.coords.length
  const editFC = fc(editDraw ? [editCircle ? polyFeat(circleRing(editDraw)) : editArea ? polyFeat(editDraw.coords) : lineFeat(editDraw.coords)] : [])
  const editCentroid: LngLat | null = editDraw
    ? [editDraw.coords.reduce((s, c) => s + c[0], 0) / editDraw.coords.length,
       editDraw.coords.reduce((s, c) => s + c[1], 0) / editDraw.coords.length]
    : null
  // Where the action hub (move grip · rotate knob · delete ✕) actually hangs. For an area or a
  // circle that is the centroid; for a LINE the centroid lies on the path, so the hub is lifted
  // perpendicular off it (lib/lineStyle · hubOffsetPx) — otherwise the move grip parks on top of a
  // vertex node and the node can neither be seen nor grabbed.
  const editHubAt: LngLat | null = (() => {
    const map = mapInst.current
    if (!editCentroid || !editDraw) return null
    if (!map || editDraw.kind !== 'line' || editDraw.coords.length < 2) return editCentroid
    const px = editDraw.coords.map((c) => { const q = map.project(c as [number, number]); return [q.x, q.y] as [number, number] })
    const c = map.project(editCentroid as [number, number])
    const [dx, dy] = hubOffsetPx(px, [c.x, c.y])
    const ll = map.unproject([c.x + dx, c.y + dy])
    return [ll.lng, ll.lat]
  })()
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
  const flashHighlight: (string | number)[] = flashDrawingId ? [flashDrawingId] : ['__none__']
  // rotate the whole selected drawing around its centroid. The angle is measured in
  // screen space from the centroid; we rotate the coords in a local east/north frame
  // (lng scaled by cos(lat)) so the turn looks rigid, then bake it back into coords.
  const drawRot = useRef<{ cx: number; cy: number; a0: number; coords: LngLat[]; cLng: number; cLat: number } | null>(null)
  const drawRotDown = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    if (!editDraw || !editCentroid) return
    // ⚠️ The pivot is the projected CENTROID, not the hub's own rect: since the hub is offset off
    // a line's path (editHubAt), those two are no longer the same point, and turning the shape
    // about a knob that sits beside it would swing the line away instead of rotating it in place.
    const map = mapInst.current
    if (!map) return
    const r = map.getContainer().getBoundingClientRect()
    const c = map.project(editCentroid as [number, number])
    const cx = r.left + c.x, cy = r.top + c.y
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

  /**
   * Continue a gesture that started on a «+» as a drag of the node it just inserted — the second
   * half of NewNodeHandle's one-gesture insert. Listens on `window` in the capture phase for
   * the same reason nodeHold does: the pointer session began on a button inside a react-map-gl
   * Marker, which is not the element the rest of the gesture is delivered to.
   *
   * `NUDGE_PX` of slop first, so a plain tap on the «+» stays a plain tap and never writes a
   * reshape (or a Verlauf row) for a node that did not move.
   */
  const handOffNodeDrag = (ev: PointerEvent, apply: (at: LngLat | null, phase: 'start' | 'move' | 'end') => void) => {
    const m = mapInst.current
    if (!m) return
    const NUDGE_PX = 4
    const sx = ev.clientX, sy = ev.clientY
    let moved = false
    const at = (e: PointerEvent): LngLat | null => {
      const r = m.getContainer().getBoundingClientRect()
      const p = m.unproject([e.clientX - r.left, e.clientY - r.top])
      return [p.lng, p.lat]
    }
    const move = (e: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < NUDGE_PX) return
        moved = true
        beginSheetPeek() // the inserted node is now travelling — let the phone sheet peek away
        apply(null, 'start')
      }
      apply(at(e), 'move')
    }
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      endSheetPeek()
      if (moved) apply(at(e), 'end')
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
  }

  // which path segment a click landed on (pixel-space point→segment distance), so a
  // click on the measure line/outline inserts a vertex there instead of appending.
  // Returns the insert index (after the segment's start; closing edge → push at end).
  const segInsertIndex = (points: LngLat[], isArea: boolean, ll: LngLat): number | null => {
    const m = mapInst.current
    if (!m || points.length < 2) return null
    const cp = m.project(ll as [number, number])
    const px = points.map((p) => m.project(p as [number, number]))
    const n = px.length
    const segs = pathSegmentCount(n, isArea) // area: includes the closing edge
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
    // The pairing mode owns every click on the map while it runs — including the ones that come
    // too early. Placing a symbol mid-pairing would be a silent mis-hit on a surface the operator
    // is aiming at for something else entirely.
    // ⚠️ The pairing mode SWALLOWS the click and places nothing here. MapLibre emits `click`
    // whenever the pointer goes down and comes up within 3px of each other — which a pan that
    // returns to its starting point does — so the placement rides on pointer-up with a sticky
    // moved flag instead (see the georef handlers on <Map> below). Swallowing still matters:
    // a mis-aimed reference tap must never drop a symbol on the Lage.
    if (georefOn) return
    // picking takes precedence — lock the clicked coordinate, place nothing
    if (picking) { onPick?.([e.lngLat.lng, e.lngLat.lat]); return }
    const lc: LngLat = [e.lngLat.lng, e.lngLat.lat]
    // clicking the measure path inserts a draggable vertex on that segment
    if (measureKind && onMeasureInsert && e.features?.some((f) => f.layer?.id === 'l-measure-hit')) {
      const idx = segInsertIndex(measurePoints, measureKind === 'area', lc)
      if (idx != null) { onMeasureInsert(idx, lc); return }
    }
    // clicking the selected drawing's outline inserts a vertex there (reshape)
    if (editDraw && editNodes && onDrawingVertexInsert && e.features?.some((f) => f.layer?.id === 'l-draw-edit-hit')) {
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
        onSelectDrawing(best.properties!.id as string, { x: e.point.x, y: e.point.y }); return
      }
    }
    onMapClick(lc)
  }
  const fhFC = fc(fhPath && fhPath.length >= 2 ? [lineFeat(fhPath)] : [])
  // team trails: the dashed line through a Trupp's RECORDED positions (parity with the plan
  // board's ink polyline — the breadcrumb dots + timestamps stay DOM markers in MapMarkers)
  const trailFC = fc(entities
    .filter((e) => e.kind === 'team' && isVisible(effectiveLayer(e)) && (e.trail?.length ?? 0) >= 2 && !hiddenTrails.has(e.id))
    .map((e) => lineFeat((e.trail ?? []).map((p) => p.coord), { color: e.color || appConfig.drawing.teamColors[0] })))
  // Vehicle tracks from Traccar — their own layer, off by default, and only polled while it is
  // switched on. Distinct from the Trupp trails above: those are positions the operator recorded
  // by hand, these are recorded by the vehicles themselves.
  const vehicleTrailFC = useVehicleTrails(isVisible(appConfig.gps.trailsLayerId))

  return (
   <>
    <Map
      // A changed key rebuilds the whole map — the ONLY way back from a lost WebGL context.
      key={gl.generation}
      ref={ref}
      // Reading a ref during render is exactly right here and nowhere else: `initialViewState`
      // is consumed ONCE per map instance (on mount), so on a context-loss remount it must see
      // the view as it stood a moment ago — resuming the operator's framing instead of snapping
      // back to the incident's initial one. Putting the live view in state would re-render the
      // map on every pan.
      // eslint-disable-next-line react-hooks/refs
      initialViewState={resumeViewState(viewRef.current, initialCenter, initialZoom, initialBearing)}
      mapStyle={EMPTY_STYLE}
      // Map/style/tile errors were only console.error'd by react-map-gl's default handler, so a
      // field failure was invisible to the deployer. Report, but never rethrow: a failed tile
      // must not take the incident down.
      onError={(e) => reportClientError(e.error ?? new Error('map error'), { kind: 'error' })}
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
      onMoveEnd={(e) => {
        setZoom(e.viewState.zoom); setBearing(e.viewState.bearing); bumpLabelFrame((n) => n + 1)
        viewRef.current = { center: [e.viewState.longitude, e.viewState.latitude], zoom: e.viewState.zoom, bearing: e.viewState.bearing }
        onView({ bearing: e.viewState.bearing, center: [e.viewState.longitude, e.viewState.latitude], zoom: e.viewState.zoom })
      }}
      // Keep only the LOCAL bearing live per rotate frame (the tactical glyphs re-render with the
      // −bearing offset so they stay geographically pinned). Deliberately NOT calling onView here:
      // that re-renders all of IncidentWorkspace every frame of a two-finger rotate. onMoveEnd
      // fires at the end of the gesture and updates App's view state then — the App-level compass /
      // coord readout just settle on release instead of tracking every frame.
      onRotate={(e) => setBearing(e.viewState.bearing)}
      // MapLibre says a genuine pan began: that settles the gesture as a drag whatever the raw
      // travel looked like, so an armed mode never turns a pan into a reference point.
      // ⚠️ MOUSE gestures only. MapLibre arms its touch drag-pan after ~3px, which every finger
      // tap exceeds by pure wobble — with this unconditional, a tablet could not place a map
      // reference point AT ALL: each tap «began a pan» and died. Touch keeps the tap/pan
      // distinction from its own travel instead (trackTap · GEOREF_TAP_SLOP_PX): a real pan
      // moves far past the slop before release, a tap does not.
      onDragStart={georefOn ? (e) => { if (!(e.originalEvent && 'touches' in e.originalEvent)) georefTap.panned() } : undefined}
      // North-snap: a GESTURE (originalEvent set — programmatic easeTo/flyTo carry none, so
      // «Nach Norden», saved views and the snap's own ease never re-trigger it) that releases
      // within a few degrees of north eases back to exactly 0. Accidental rotation from a
      // two-finger zoom self-heals; deliberate rotation past the threshold sticks.
      onRotateEnd={(e) => {
        if (e.originalEvent && snapNorth(e.viewState.bearing) != null) {
          mapInst.current?.easeTo({ bearing: 0, duration: motionDuration(250) })
        }
      }}
      // ⚠️ A press that begins on a CROSS never starts a placement gesture: the cross's own
      // handlers (pick / drag) own it, but their native events still bubble to this container —
      // without the filter, clicking a pending cross also dropped a stray point underneath it.
      onMouseDown={(nodeMagnetActive || georefOn) ? (e) => { if (georefOn && !georefTapOnMarker(e.originalEvent?.target)) { aimGeorefMap(); georefTap.start(e.point) } if (nodeMagnetActive) updateDraftMagnet('start', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      onMouseMove={(picking || nodeMagnetActive || georefOn) ? (e) => { if (picking) onCursor?.([e.lngLat.lng, e.lngLat.lat]); if (georefOn) georefTap.track(e.point); if (georefTurn) { aimGeorefMap(); georefPoint.current = { lng: e.lngLat.lng, lat: e.lngLat.lat } } if (nodeMagnetActive) updateDraftMagnet('move', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      onMouseUp={(nodeMagnetActive || georefOn) ? (e) => { if (georefOn) { const tapped = georefTap.end(); if (!isPhone && tapped) placeGeoref(e.lngLat) } if (nodeMagnetActive) finishDraftNodeMagnet([e.lngLat.lng, e.lngLat.lat]) } : undefined}
      // ⚠️ The pairing aim is deliberately NOT cleared here. The loupe is up for the whole of the
      // map's turn and keeps showing the last thing aimed at — clearing it on mouse-out closed
      // the magnifier every time the hand crossed the seam back to the plan.
      onMouseOut={picking ? () => onCursor?.(null) : undefined}
      // mousemove never fires on touch — stream the aim coords from the drag as well,
      // so the crosshair readout tracks the finger on iPhone/iPad
      // same cross filter as onMouseDown — a finger on a cross is a pick, never a placement
      onTouchStart={(nodeMagnetActive || georefOn) ? (e) => { if (georefOn && !georefTapOnMarker(e.originalEvent?.target)) { aimGeorefMap(); georefTap.start(e.point, e.points.length > 1) } if (nodeMagnetActive) updateDraftMagnet('start', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      // mousemove never fires on touch — the loupe follows the drag instead, which is exactly the
      // gesture the mock asks for («halten und schieben»)
      onTouchMove={(picking || nodeMagnetActive || georefOn) ? (e) => { if (picking) onCursor?.([e.lngLat.lng, e.lngLat.lat]); if (georefOn) georefTap.track(e.point, e.points.length > 1); if (georefTurn) { aimGeorefMap(); georefPoint.current = { lng: e.lngLat.lng, lat: e.lngLat.lat } } if (nodeMagnetActive) updateDraftMagnet('move', [e.lngLat.lng, e.lngLat.lat]) } : undefined}
      // ⚠️ A placing tap CANCELS its touchend. The browser follows an uncancelled tap with a
      // synthesized mousedown/mouseup/click at the same position: the mouse pair re-ran this
      // very machine (one duplicate point per tap), and the click landed on the cross that had
      // JUST mounted under the finger — picking it up, so the next tap silently re-placed that
      // point instead of setting the next one. That loop, not finger wobble, is what made
      // tablet placement «very unreliable». MapLibre registers touchend non-passively, so
      // preventDefault here is honoured and stops the whole synthetic trail. Pans, pinches and
      // non-placing taps stay untouched — crosses keep receiving their real taps.
      onTouchEnd={(nodeMagnetActive || georefOn) ? (e) => { if (georefOn) { const tapped = georefTap.end(); if (!isPhone && tapped && placeGeoref(e.lngLat)) e.originalEvent?.preventDefault() } if (nodeMagnetActive) finishDraftNodeMagnet([e.lngLat.lng, e.lngLat.lat]) } : undefined}
      cursor={picking || georefTurn ? 'crosshair' : undefined}
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

      {/* Literal georeferenced Modul sheets are separate from their symbol projections. Ebenen
          owns visibility + transparency; they sit above the basemap and below every tactical
          object, exactly like a reference raster rather than like an editable surface. */}
      {!georefOn && georefPlanRasters.map((p, i) => (
        <Source key={p.id} id={`s-georef-plan-${i}`} type="image" url={p.url} coordinates={p.coordinates}>
          <Layer id={`l-georef-plan-${i}`} type="raster"
            paint={{ 'raster-opacity': p.opacity, 'raster-fade-duration': 0 }} />
        </Source>
      ))}

      {!georefOn && georefPlanContent.length > 0 && (
        <GeorefContentMap twins={georefPlanContent} zoom={zoom} bearing={bearing}
          trupps={trupps} truppSeverities={truppSeverities}
          interactive={!placing} onOpenResource={onContentTwinOpen}
          onMoveResource={readOnly ? undefined : onContentTwinMove}
          project={(c) => mapInst.current?.project(c as [number, number])}
          unproject={(p) => { const m = mapInst.current; if (!m) return undefined; const ll = m.unproject([p.x, p.y]); return [ll.lng, ll.lat] }}
          setDragPan={(on) => { const dp = mapInst.current?.dragPan; if (!dp) return; if (on) dp.enable(); else dp.disable() }} />
      )}

      {/* «Karte verknüpfen»: the numbered reference crosses, drag-to-fine-tune, tap-to-re-place */}
      {!georef.check && <GeorefMapMarks mode={georef} map={mapInst.current} />}
      {/* …and the one-shot «Deckung prüfen»: the sheet's outline, where the fit puts it */}
      <GeorefCheckOutline mode={georef} map={mapInst.current} />

      {/* …and what the finished reference produces: the plans' own symbols, mirrored onto the
          map as quieter twins. Drawn UNDER everything the operator can actually edit (the
          drawings, the markers below) — a projection must never sit on top of the real thing
          and swallow the tap meant for it. */}
      {twins.length > 0 && onTwinOpen && !georefOn && (
        <GeorefTwinsMap twins={twins} byName={byName} zoom={zoom} bearing={bearing} symMul={symMul} captionMode={captionMode}
          interactive={!placing} selectedKey={selectedTwinKey} onOpen={onTwinOpen}
          onMove={readOnly ? undefined : onTwinMove} />
      )}

      {/* committed drawings (per-feature colour/width) — gated by the markup layer toggle */}
      <Source id="s-draw" type="geojson" data={drawFC}>
        {/* Atemschutz halo: the Leitung a due/überfällig Trupp works on keeps its own colour and
            gains a soft outline in the alarm tone — the picture says WHERE those people are,
            while the Atemschutz board stays the surface that actually alarms. */}
        <Layer id="l-draw-atemschutz" type="line" filter={['!=', ['get', 'truppTone'], ''] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }}
          paint={{
            'line-color': ['match', ['get', 'truppTone'], 'crit', appConfig.drawing.atemschutzTone.crit, appConfig.drawing.atemschutzTone.warn],
            'line-width': ['+', ['get', 'width'], 8],
            'line-opacity': 0.45,
          } as any} />
        <Layer id="l-draw-network" type="line" filter={['>=', ['get', 'networkDepth'], 0] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }}
          paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 9], 'line-opacity': ['interpolate', ['linear'], ['get', 'networkDepth'], 0, 0.34, 4, 0.08] } as any} />
        {/* «zeigen» outline: wider and softer than the selection halo, and it goes away by itself.
            Deliberately NOT animated — a pulsing hose was tried and rejected on the Lage; the
            camera has just moved here, so a steady ring is enough to say which line. */}
        <Layer id="l-draw-flash" type="line" filter={['in', ['get', 'id'], ['literal', flashHighlight]] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }}
          paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 14], 'line-opacity': 0.3 } as any} />
        <Layer id="l-draw-sel" type="line" filter={['in', ['get', 'id'], ['literal', selHighlight]] as any}
          layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }}
          paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 6], 'line-opacity': 0.5 } as any} />
        <Layer id="l-draw-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} layout={vis(drawingsVisible && !georefOn)} paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.14] } as any} />
        {/* solid + dashed split: line-dasharray can't be data-driven, so dashed lines
            render in their own layer filtered on the feature's `dashed` property */}
        <Layer id="l-draw-line" type="line" filter={['!', ['get', 'dashed']] as any} layout={{ 'line-cap': 'round', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }} paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] } as any} />
        <Layer id="l-draw-line-dash" type="line" filter={['get', 'dashed'] as any} layout={{ 'line-cap': 'butt', 'line-join': 'round', ...vis(drawingsVisible && !georefOn) }} paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': LINE_DASH_ML } as any} />
        {/* fat transparent hit line over EVERY drawn line (solid + dashed) so a click on or
            near any line — including thin/styled ones like the Rettungsachse — selects it */}
        <Layer id="l-draw-hit" type="line" filter={['!=', ['geometry-type'], 'Polygon']} layout={{ ...vis(drawingsVisible && !georefOn) }} paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } as any} />
        {/* the inline letter marker (e.g. R on a Rettungsachse) renders as a DOM Marker below
            — a MapLibre text-field symbol would require a `glyphs` font source this
            offline-first style intentionally omits (it would also break offline). */}
      </Source>
      {/* arrowheads at the end of annotated lines (Messpfeil / Rettungsachse) — a tintable
          SDF icon rotated to the final-segment bearing */}
      <Source id="s-draw-arrow" type="geojson" data={arrowFC}>
        <Layer id="l-draw-arrow" type="symbol"
          layout={{ 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-anchor': 'center', 'icon-size': 1.1, ...vis(drawingsVisible && !georefOn) } as any}
          paint={{ 'icon-color': ['get', 'color'] } as any} />
      </Source>
      {/* team trails — dashed path through the recorded positions, in the team's colour
          (same look as the plan board's trail polyline); under the DOM markers by nature.
          Hidden while «Karte verknüpfen» borrows the map, like every drawing layer above —
          a dashed breadcrumb reads exactly like a landmark-worthy path during calibration. */}
      <Source id="s-team-trails" type="geojson" data={trailFC}>
        <Layer id="l-team-trails" type="line" layout={{ 'line-join': 'round', ...vis(!georefOn) }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2.5, 2.5], 'line-opacity': 0.85 } as any} />
      </Source>
      {/* vehicle tracks (Traccar) — solid, thin and deliberately quiet: this is context behind
          the fleet, not a tactical statement, so it must not read like a drawn hose line. The
          hook returns an empty collection whenever the layer is off, so this costs nothing then. */}
      <Source id="s-vehicle-trails" type="geojson" data={vehicleTrailFC}>
        <Layer id="l-vehicle-trails" type="line" layout={{ 'line-join': 'round', 'line-cap': 'round', ...vis(!georefOn) }}
          paint={{ 'line-color': '#00a0ff', 'line-width': 2, 'line-opacity': 0.5 }} />
      </Source>
      {/* live draft (area/line tool) — vertices are draggable handles (rendered below),
          so the in-progress shape edits exactly like the measure path */}
      <Source id="s-draft" type="geojson" data={draftFC}>
        <Layer id="l-draft-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} paint={{ 'fill-color': uiBlue, 'fill-opacity': 0.08 }} />
        <Layer id="l-draft-line" type="line" paint={{ 'line-color': uiBlue, 'line-width': 2, 'line-dasharray': [1.5, 1] }} />
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
        {/* Polygon only. A fill layer closes a LineString into a ring and shades it, so a measured
            Strecke that bends back on itself came out tinted like an area — the same guard the
            draft layer has carried all along. */}
        <Layer id="l-measure-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} paint={{ 'fill-color': uiBlue, 'fill-opacity': 0.1 }} />
        <Layer id="l-measure-line" type="line" paint={{ 'line-color': uiBlue, 'line-width': 2.5, 'line-dasharray': [2, 1.2] }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        {/* fat transparent hit line so segment clicks (insert vertex) are easy to land */}
        <Layer id="l-measure-hit" type="line" paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 }} />
      </Source>

      {/* selected drawing being edited: an outline + fat hit-line so a click on the edge
          inserts a vertex. The visible reshape handles are DOM Markers, rendered below. */}
      {editDraw && editNodes && (
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
          style={handleZ}
          draggable
          onDrag={(e) => { vertexPress.cancel(); onDraftDrag?.(i, [e.lngLat.lng, e.lngLat.lat]) }}
          onDragEnd={(e) => onDraftDrag?.(i, [e.lngLat.lng, e.lngLat.lat])}
        >
          <div
            className={`measure-handle ${vertexPress.armed?.key === `draft:${i}` ? 'doomed' : ''}`}
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(`draft:${i}`, () => deletePointKeepTool(onDraftDelete)(i))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); onDraftDelete?.(i) }}
          >{vertexPress.armed?.key === `draft:${i}` && <NodeDeleteChip progress={vertexPress.armed.progress} />}</div>
        </Marker>
      ))}

      {/* a "+" at each segment's midpoint — the same segments segInsertIndex() recognises when the
          line itself is tapped (the area's closing edge included), so both routes insert the same
          node at the same index. Rendered before the vertices so a handle wins where they overlap. */}
      {measureKind && onMeasureInsert && measurePoints.length >= 2 && (() => {
        const n = measurePoints.length
        return Array.from({ length: pathSegmentCount(n, measureKind === 'area') }, (_, i) => {
          const a = measurePoints[i], b = measurePoints[(i + 1) % n]
          const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
          return (
            <Marker key={`mi${i}`} longitude={mid[0]} latitude={mid[1]} anchor="center" style={handleZ}>
              <NewNodeHandle title={appConfig.copy.measure.insertPoint}
                onInsert={(ev) => {
                  onMeasureInsert(i + 1, mid)
                  // …and the same press keeps dragging the point it just made (see NewNodeHandle)
                  if (ev && onMeasureDrag) handOffNodeDrag(ev, (ll, phase) => {
                    if (phase === 'start') setMeasureDragNode(i + 1)
                    if (phase === 'end') setMeasureDragNode(null)
                    if (ll) onMeasureDrag(i + 1, ll)
                  })
                }} />
            </Marker>
          )
        })
      })()}

      {/* draggable measurement vertices */}
      {measureKind && measurePoints.map((p, i) => (
        <Marker
          key={`mh${i}`}
          longitude={p[0]}
          latitude={p[1]}
          anchor="center"
          style={handleZ}
          draggable
          onDragStart={() => setMeasureDragNode(i)}
          onDrag={(e) => { vertexPress.cancel(); onMeasureDrag?.(i, [e.lngLat.lng, e.lngLat.lat]) }}
          onDragEnd={(e) => { setMeasureDragNode(null); onMeasureDrag?.(i, [e.lngLat.lng, e.lngLat.lat]) }}
        >
          <div
            className={`measure-handle ${vertexPress.armed?.key === `measure:${i}` ? 'doomed' : ''}`}
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(`measure:${i}`, () => deletePointKeepTool(onMeasureDelete)(i), measurePoints.length > (measureKind === 'area' ? 3 : 2))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); onMeasureDelete?.(i) }}
          >{vertexPress.armed?.key === `measure:${i}` && <NodeDeleteChip progress={vertexPress.armed.progress} />}</div>
        </Marker>
      ))}

      {/* measurement readouts pinned to the path (cumulative distance / area), above the handles.
          While a vertex is in the hand its own label is 12px under the fingertip — that one is
          suppressed (decided BEFORE the <Marker>, per the null-child trap below) and the fixed
          .measure-readout at the top edge carries the number instead. */}
      {measureLabels.map((l, i) => (
        (measureDragNode != null && measureKind === 'line' && i === measureDragNode - 1) ? null : (
        <Marker key={`ml${i}`} longitude={l.coord[0]} latitude={l.coord[1]} anchor="bottom" offset={[0, -12]}>
          <div className={`measure-label ${l.strong ? 'strong' : ''}`}>{l.text}</div>
        </Marker>
        )
      ))}

      {/* annotated-line readouts (auto distance + hose-length helper / free-text label),
          pinned to each line's midpoint — reuses the measure-label chrome */}
      {/* ⚠️ The suppression is decided BEFORE the <Marker>, never as a null child inside one.
          react-map-gl reads «has children?» once, in a useMemo([]) at mount, and a marker that
          mounts with nothing in it gets MapLibre's own default pin — the stock teal drop —
          which it then keeps for good, label or no label. That is exactly what the field saw:
          teal pins scattered over the Lage next to perfectly readable labels. Filtering here
          means a suppressed label has no marker at all, and gets a fresh one when it fits again. */}
      {drawingsVisible && drawLabels.filter((l) => !suppressedLabels.has(`dl:${l.id}`)).map((l) => (
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
      {/* suppressed ⇒ no marker (see the dl labels above: an empty <Marker> becomes a default pin) */}
      {drawingsVisible && circleLabels.filter((c) => !suppressedLabels.has(`cl:${c.id}`)).map((c) => (
        <Marker key={`cl${c.id}`} longitude={c.coord[0]} latitude={c.coord[1]} anchor="bottom" offset={[0, -4]}>
          <div className={`measure-label draw-label${c.id === selectedDrawingId ? ' sel' : ''}`}>{c.text}</div>
        </Marker>
      ))}

      {/* lock chip on every locked drawing — the click-through shape's only tap target;
          tapping it unlocks + selects the shape (Figma/Miro-style lock affordance). Its only
          job is unlocking, so it stays away when editing is locked anyway. */}
      {drawingsVisible && !readOnly && onUnlockDrawing && lockChips.map((c) => (
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
          {/* ⚠️ zIndex ABOVE the line's other decorations. Every MapLibre marker is its own
              stacking context (it carries a transform), so a z-index inside the tag cannot
              lift it past a SIBLING marker — it has to sit on the marker container. Without
              it the decorations of a line that runs under its own tag paint straight through
              the text, and the tag is the one thing on a Leitung that has to stay readable.
              Both levels come from the one stacking table (lib/labelPass · MARKER_Z). */}
          {/* …and suppressed ⇒ no marker at all, never an empty one (see the dl labels above) */}
          {(ld.d.content || ld.d.lineNo != null || ld.d.floorTag != null || ld.trupp) && !suppressedLabels.has(`tag:${ld.d.id}`) && (
            <Marker longitude={(ld.d.endLabelAt ?? ld.anchor)[0]} latitude={(ld.d.endLabelAt ?? ld.anchor)[1]} anchor="center" offset={[0, -14]}
              // …and ABOVE the resting tactical symbols (MARKER_Z.note…team, 4–8) once its own
              // line is selected. At rest the tag stays under the symbols, so it can neither cover
              // nor steal the tap of a Trupp. Selected means «I am working on this Leitung» — then
              // its handle has to be the thing on top, or it cannot be grabbed where it matters:
              // right at the incident point, which is exactly where lines and symbols pile up.
              // A SELECTED symbol still clears it (MARKER_Z.selected) — only one of the two can
              // be the current selection, and the tapped object is the one that must be visible.
              style={{ zIndex: ld.d.id === selectedDrawingId ? MARKER_Z.tagSelected : MARKER_Z.tag }}>
              {/* the -14 offset lifts the tag clear of the line end; dragging pins it to a georeferenced anchor */}
              <div className={`line-end-tag-wrap draggable${ld.d.id === selectedDrawingId ? ' sel' : ''}`}
                style={{ cursor: onLabelMove ? 'move' : undefined }}
                onPointerDown={onLabelMove ? (e) => labelDown(e, ld.d.id, ld.d.endLabelAt ?? ld.anchor, 'end') : undefined}
                onPointerMove={onLabelMove ? labelMove : undefined}
                onPointerUp={onLabelMove ? labelUp : undefined}
                onPointerCancel={onLabelMove ? labelUp : undefined}>
                <EndTag
                  lineNo={ld.d.lineNo} content={ld.d.content} floorTag={ld.d.floorTag}
                  trupp={ld.trupp ? truppTagText(ld.trupp) : undefined} tone={ld.tone}
                  color={ld.color}
                />
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

      {/* «Ring lädt, dann schnappt es» — the ONE picture of attachment on this surface (the plan
          draws the identical pair). The blue chip hangs BESIDE the target, never under the finger,
          and its ring is the remaining dwell; a full ring is the only thing that attaches
          (lib/lineAttachments · DwellState). The key carries `since`, so re-entering the same
          target restarts the CSS fill instead of silently continuing an old one.
          Cycle-forming targets are filtered out of the candidate list, so there is no blocked
          state to draw. The red twin below is the release ring. */}
      {endpointDrag?.candidate && mapInst.current && (() => {
        const ll = mapInst.current.unproject(endpointDrag.candidate.point)
        return (
          <Marker key={`${endpointDrag.candidate.key}:${endpointDrag.dwell.since}`} longitude={ll.lng} latitude={ll.lat} anchor="center">
            <span className="magnet-anchor"><ConnectRing since={endpointDrag.dwell.since} armed={endpointDrag.dwell.armed} /></span>
          </Marker>
        )
      })()}
      {/* release: same chip, red, at the socket the endpoint is leaving — its ring fills with the
          DISTANCE pulled out, and a full one is what actually unhooks it. The explicit
          «Verbindung lösen» chip on a selected endpoint stays; this is the in-drag twin. */}
      {endpointDrag?.attached && endpointDrag.detach > DETACH_SHOW_PROGRESS && (
        <Marker longitude={endpointDrag.origin[0]} latitude={endpointDrag.origin[1]} anchor="center">
          <span className="magnet-anchor"><NodeDeleteChip tone="release" progress={endpointDrag.detach} /></span>
        </Marker>
      )}
      {draftMagnetState?.candidate && mapInst.current && (() => {
        const ll = mapInst.current.unproject(draftMagnetState.candidate.point)
        return (
          <Marker key={`${draftMagnetState.candidate.key}:${draftMagnetState.dwell.since}`} longitude={ll.lng} latitude={ll.lat} anchor="center">
            <span className="magnet-anchor"><ConnectRing since={draftMagnetState.dwell.since} armed={draftMagnetState.dwell.armed} /></span>
          </Marker>
        )
      })()}
      {hiddenAttachmentTargets.map((e) => <Marker key={`hidden-${e.id}`} longitude={e.coord[0]} latitude={e.coord[1]} anchor="center"><span className="hidden-attachment-marker" /></Marker>)}

      {/* selected drawing — on-canvas edit handles: a move grip at the centre, a delete
          ✕ above it, and (for non-huge shapes) a draggable handle on every vertex */}
      {editDraw && editHubAt && (
        <Marker longitude={editHubAt[0]} latitude={editHubAt[1]} anchor="center" style={handleZ}>
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
      {editDraw && editHubAt && onDrawingEdit && (
        <Marker
          longitude={editHubAt[0]}
          latitude={editHubAt[1]}
          anchor="center"
          style={handleZ}
          draggable
          onDragStart={() => { beginSheetPeek(); moveRef.current = { start: editHubAt, coords: editDraw.coords }; onDrawingEdit(editDraw.id, editDraw.coords, 'start') }}
          onDrag={(e) => { const m = moveRef.current; if (!m) return; const dx = e.lngLat.lng - m.start[0], dy = e.lngLat.lat - m.start[1]; onDrawingEdit(editDraw.id, bodyMovedCoords(editDraw.id, dx, dy), 'move') }}
          onDragEnd={(e) => { endSheetPeek(); const m = moveRef.current; if (!m) { onDrawingEdit(editDraw.id, editDraw.coords, 'end'); return } const dx = e.lngLat.lng - m.start[0], dy = e.lngLat.lat - m.start[1]; onDrawingEdit(editDraw.id, bodyMovedCoords(editDraw.id, dx, dy), 'end'); moveRef.current = null }}
        >
          <div className="draw-move" title={appConfig.copy.drawingEditor.move} aria-label={appConfig.copy.drawingEditor.move}><Icon id="move" /></div>
        </Marker>
      )}
      {/* «+» at each segment's midpoint of the SELECTED drawing — the same affordance the Messung
          has always had, and the Plan too. On the map inserting a node used to mean hitting the
          line's invisible 18px hit-band with no sign that this was possible at all (19.08.).
          Rendered BEFORE the vertices so a node handle wins wherever the two overlap. */}
      {editDraw && editAllNodes && onDrawingVertexInsert && editDraw.coords.length >= 2 && (() => {
        const n = editDraw.coords.length
        return Array.from({ length: pathSegmentCount(n, editArea) }, (_, i) => {
          const a = editDraw.coords[i], b = editDraw.coords[(i + 1) % n]
          const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
          return (
            <Marker key={`di${i}`} longitude={mid[0]} latitude={mid[1]} anchor="center" style={handleZ}>
              <NewNodeHandle title={appConfig.copy.measure.insertPoint}
                onInsert={(ev) => {
                  onDrawingVertexInsert(editDraw.id, i + 1, mid)
                  // the geometry is snapshotted WITH the new node (same reason the body-move grip
                  // snapshots: 'move' streams into the doc, so reading it back races the shape away)
                  if (!ev || !onDrawingEdit) return
                  const grown = [...editDraw.coords.slice(0, i + 1), mid, ...editDraw.coords.slice(i + 1)]
                  handOffNodeDrag(ev, (ll, phase) => onDrawingEdit(editDraw.id,
                    ll ? grown.map((q, j) => (j === i + 1 ? ll : q)) : grown, phase))
                }} />
            </Marker>
          )
        })
      })()}

      {/* the node pads. On a dense stroke this is a SUBSET of the vertices (vertexHandleIndices) —
          `i` stays the real index into `coords`, so a drag/delete still hits the point it points at. */}
      {editDraw && onDrawingEdit && editHandleIdx.map((i) => {
        const p = editDraw.coords[i]
        const endpoint: LineEndpoint | null = editDraw.kind === 'line' && i === 0 ? 'start' : editDraw.kind === 'line' && i === editDraw.coords.length - 1 ? 'end' : null
        return (
        <Marker
          key={`dv${i}`}
          longitude={p[0]}
          latitude={p[1]}
          anchor="center"
          style={handleZ}
          draggable
          onDragStart={() => { beginSheetPeek(); endpoint && onDrawingAttachment ? beginEndpointDrag(editDraw.id, endpoint, p) : onDrawingEdit(editDraw.id, editDraw.coords, 'start') }}
          onDrag={(e) => { vertexPress.cancel(); endpoint && onDrawingAttachment ? moveEndpointDrag([e.lngLat.lng, e.lngLat.lat]) : onDrawingEdit(editDraw.id, editDraw.coords.map((q, j) => (j === i ? [e.lngLat.lng, e.lngLat.lat] : q)), 'move') }}
          onDragEnd={(e) => {
            endSheetPeek()
            if (endpoint && onDrawingAttachment) { moveEndpointDrag([e.lngLat.lng, e.lngLat.lat]); finishEndpointDrag() }
            else onDrawingEdit(editDraw.id, editDraw.coords.map((q, j) => (j === i ? [e.lngLat.lng, e.lngLat.lat] : q)), 'end')
          }}
        >
          <div
            className={`draw-handle ${vertexPress.armed?.key === `draw:${i}` ? 'doomed' : ''}`}
            title={appConfig.copy.measure.deleteNode}
            {...vertexPress.press(`draw:${i}`, () => deleteVertexKeepSelection(editDraw.id, i), editDraw.coords.length > (editArea ? 3 : 2))}
            onContextMenu={(ev) => { ev.stopPropagation(); ev.preventDefault(); deleteVertexKeepSelection(editDraw.id, i) }}
          >{vertexPress.armed?.key === `draw:${i}` && <NodeDeleteChip progress={vertexPress.armed.progress} />}</div>
        </Marker>
        )
      })}
      {/* ── Verlängern ─────────────────────────────────────────────────────────────────────────
          The arrow tip sitting `EXTEND_STEP_PX` PAST each open end of a selected line, pointing the
          way the line runs. Until now the only way to lengthen a line was to draw a second one and
          magnet it on, which produces a second Leitung with its own number and its own Trupp link
          (19.08.).
          ⚠️ A TAP is the whole gesture (26.08. field test). The grip used to be drag-only, so
          tapping the arrow — which is what an arrow tip invites — did nothing at all and the line
          just sat there. Now pointerdown appends one node AT the arrow, one fixed step further out,
          and hands the same press over to that node's drag: let go without moving and the line grew
          by one step; keep moving and it follows the finger. Exactly what the «+» does one segment
          back, and exactly what the Plan's grip already did (Whiteboard · extendLine) — the two
          surfaces now grow a line the same way.
          ⚠️ Offset OUTWARD, never on the endpoint itself: the endpoint already carries the node
          handle and, when attached, the detach chip. A grip on top of those would be a third
          thing competing for the same pixel.
          Lines only — an area has no end to grow from, and a circle is centre + radius. */}
      {editDraw && editDraw.kind === 'line' && editNodes && onDrawingEdit && onDrawingVertexInsert && editDraw.coords.length >= 2
        && (['start', 'end'] as const).map((ep) => {
        const coords = editDraw.coords
        const i = ep === 'start' ? 0 : coords.length - 1
        const pt = coords[i], neighbor = ep === 'start' ? coords[1] : coords[coords.length - 2]
        const map = mapInst.current
        let at: LngLat = pt
        let deg = 0
        if (map) {
          const p = map.project(pt), q = map.project(neighbor)
          const dx = p.x - q.x, dy = p.y - q.y, len = Math.hypot(dx, dy) || 1
          const ll = map.unproject([p.x + (dx / len) * EXTEND_STEP_PX, p.y + (dy / len) * EXTEND_STEP_PX])
          at = [ll.lng, ll.lat]
          deg = (Math.atan2(dy, dx) * 180) / Math.PI
        }
        // where the new node lands in `coords`, and the geometry it lands in — SNAPSHOTTED here,
        // never read back from the live drawing while the drag streams ('move' writes into the doc
        // each frame, so reading it back appends one point per pointermove: a single drag across
        // the screen turned an 8-point hose into a 21-point one, 19.08.).
        const idx = ep === 'start' ? 0 : coords.length
        const grown = ep === 'start' ? [at, ...coords] : [...coords, at]
        return (
          <Marker key={`grow-${ep}`} longitude={at[0]} latitude={at[1]} anchor="center" style={handleZ}>
            <NewNodeHandle
              className="draw-grow" icon="arrow"
              title={appConfig.copy.measure.extendLine}
              style={{ ['--grow-deg' as string]: `${deg}deg` } as React.CSSProperties}
              onInsert={(ev) => {
                onDrawingVertexInsert(editDraw.id, idx, at)
                if (!ev) return
                handOffNodeDrag(ev, (ll, phase) => onDrawingEdit(editDraw.id,
                  ll ? grown.map((q, j) => (j === idx ? ll : q)) : grown, phase))
              }} />
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
          <Marker key={`detach-${ep}`} longitude={pt[0]} latitude={pt[1]} anchor="center" offset={[18, -18]} style={handleZ}>
            <span className="line-detach-chip" role="button" title={appConfig.copy.drawingEditor.detachConnection} aria-label={appConfig.copy.drawingEditor.detachConnection}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => { ev.stopPropagation(); onDrawingAttachment(editDraw.id, ep, undefined, detachAt()) }}><Icon id="close" /></span>
          </Marker>
        )
      })}

      {/* marquee group (≥2 drawings + entities): one move grip + delete at the combined centre */}
      {groupCentroid && (
        <Marker longitude={groupCentroid[0]} latitude={groupCentroid[1]} anchor="center" style={handleZ}>
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
          style={handleZ}
          draggable
          onDragStart={() => { beginSheetPeek(); groupMoveRef.current = { start: groupCentroid }; onGroupMove(selectedDrawIds, selectedEntityIds, 0, 0, 'start') }}
          onDrag={(e) => { const s = groupMoveRef.current; if (!s) return; onGroupMove(selectedDrawIds, selectedEntityIds, e.lngLat.lng - s.start[0], e.lngLat.lat - s.start[1], 'move') }}
          onDragEnd={(e) => { endSheetPeek(); const s = groupMoveRef.current; if (s) onGroupMove(selectedDrawIds, selectedEntityIds, e.lngLat.lng - s.start[0], e.lngLat.lat - s.start[1], 'end'); groupMoveRef.current = null }}
        >
          <div className="draw-move" title={appConfig.copy.drawingEditor.move} aria-label={appConfig.copy.drawingEditor.move}><Icon id="move" /></div>
        </Marker>
      )}

      {/* entity markers — guard against malformed entities (e.g. a server workspace
          missing a coord) so one bad row can't white-screen the whole map */}
      <MapMarkers
        // ⚠️ NOTHING of the Lage is drawn while «Karte verknüpfen» is armed — see the plan half
        // (09-whiteboard.css · .wb-georef-armed) for the reason, which is the same on both
        // surfaces: the landmark you are aiming at is exactly where the symbols sit. The
        // entities themselves are untouched; they are back the moment the mode ends.
        entities={georefOn ? [] : entities}
        byName={byName}
        isVisible={isVisible}
        selectedId={selectedId}
        groupSelectedIds={groupEnts.length ? selectedEntityIds : []}
        networkEntityIds={[...relationship.objectIds]}
        zoom={zoom}
        bearing={bearing}
        symMul={symMul}
        captionMode={captionMode}
        suppressedLabels={suppressedLabels}
        readOnly={readOnly}
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
        onNotePanel={onNotePanel}
        onNoteWidth={onNoteWidth}
        trupps={trupps}
        onShowTrupp={onShowTrupp}
        onTeamTrupp={onTeamTrupp}
        onTeamMark={onTeamMark}
        onTeamRename={onTeamRename}
        onTeamColor={onTeamColor}
        onTeamClearTrail={onTeamClearTrail}
        hiddenTrails={hiddenTrails}
        onToggleTrail={toggleTrail}
      />

    </Map>
    {/* the tool's number, fixed at the top edge while a measure vertex is being dragged — the
        per-vertex label sits under the very fingertip that changes it (the .node-del chip is
        offset for the same reason), so during the drag the total/area is read where nothing
        moves: the georef corner-loupe answer. Display-only; gone the moment the finger lifts. */}
    {measureDragNode != null && measureLabels.length > 0 && (
      <div className="measure-readout" aria-hidden>{measureLabels[measureLabels.length - 1].text}</div>
    )}
    {/* the pairing mode's magnifier — base-map tiles, no second GL context (GeorefMapLayer).
        ⚠️ On a phone TOO, since it moved into the corner: what made the old centred one wrong
        there was that it sat under the finger, and an inset does not. Without it the map half
        of a pair is placed blind, which is the half where blind hurts most — a house corner on
        a basemap at phone zoom is a few pixels of grey. */}
    {!georef.check && georefTurn && georef.want === 'map' && (
      <GeorefMapLoupe map={mapInst.current} layers={layers} isVisible={isVisible} night={night}
        atRef={georefPoint} />
    )}
    {/* WebGL context lost and auto-healing has already been tried: without this the map is just
        a blank rectangle surrounded by working chrome, with no hint and no action — a full app
        restart was the only cure. Deliberately NOT a toast: it must stay until acted on. */}
    {gl.lost && (
      <div className="map-gl-lost" role="alert">
        <div className="map-gl-lost-title">{appConfig.copy.map.glLost}</div>
        <p className="map-gl-lost-hint">{appConfig.copy.map.glLostHint}</p>
        <button type="button" className="ip-btn primary" onClick={gl.recover}>
          {appConfig.copy.map.glLostAction}
        </button>
      </div>
    )}
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
