import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardAnno, BoardTool, BuildingDoc, CaptionMode, PlanDocument, ShapeKind, Trupp } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import { Icon } from '../lib/icons'
import { Palette } from './Palette'
import { PdfViewport, prewarmPlans } from './PdfViewport'
import { PdfScroller } from './PdfScroller'
import { OsmOutline } from './OsmOutline'
import { appConfig } from '../config/appConfig'
import { linePresetPatch, markerParamsAlong, lerpPoint, lookbackPoint, simplifyFreehand, MAX_VERTEX_HANDLES } from '../lib/lineStyle'
import { TeilstueckFork, EndTag, hasLineDecor } from '../lib/lineDecor'
import { fillTemplate, formatSymbolName, formatTime } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { panelNudgeBox, panelNudgeBoxUp, isBottomSheet } from '../lib/panelNudge'
import { TacticalSymbol, GROSSLUEFTER, GROSSLUEFTER_BODY, GROSSLUEFTER_FAN, FAN_OVERLAY_SCALE } from '../lib/symbolRender'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { placardSvgForSymbol } from '../lib/placard'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys, symbolCaptionText, ROTATABLE } from '../lib/symbols'
import { ContextPanel } from './ContextPanel'
import { DrawEditor } from './DrawEditor'
import { ShapeEditor } from './ShapeEditor'
import { ShapeGlyph, SHAPE_DEFS } from '../lib/shapes'
import { planUrl, TILE_AR, TOP_INSET, STACK_VPAD, clamp01, floorLabel, floorGeometry } from '../lib/whiteboard'
import { calibrate, pathMetres, polyAreaM2, isStale, type PlanScale } from '../lib/planScale'
import { MeasurePanel } from './MeasurePanel'
import type { PlanScales } from '../lib/workspace'
import { fmtDistance, fmtArea, hoseLengthHint } from '../lib/geo'
import { useLongPress } from '../lib/useLongPress'
import { buildView, northVec, remapPoint, type Ring } from '../lib/footprint'
import { useBoardView } from './useBoardView'
import { useBoardDoc } from './useBoardDoc'
import { useBoardGestures } from './useBoardGestures'
import { WbToolDocks, WbInkLayer, WbVertexHandles } from './WbControls'
import { ToolRail } from './ToolRail'

const COLORS = appConfig.drawing.colors
const TEAM_COLORS = appConfig.drawing.teamColors // distinct accent per team (cycled)
// parity with the Lage map: directional symbols that support drag-to-rotate (set
// derived from the symbol presets, lib/symbols · ROTATABLE), and the generic
// vehicle whose typed name is baked into the glyph (text stays upright).
const isRotatableSym = (a: BoardAnno) => a.kind === 'symbol' && !!a.symbol && ROTATABLE.has(a.symbol)
const isVehicleSym = (a: BoardAnno) => a.kind === 'symbol' && a.symbol === appConfig.symbols.vehicleName
// the composite Grosslüfter (vehicle body + fan): a two-handle rotor + two-layer render, like the map
const isGrossluefter = (a: BoardAnno) => a.kind === 'symbol' && a.symbol === GROSSLUEFTER

interface Props {
  plans: PlanDocument[]
  activeId: string
  annos: BoardAnno[]
  /** global S/M/L symbol-size multiplier (lib/prefs · symbolMul) — scales the plan symbol base */
  symMul?: number
  /** device default for on-canvas symbol captions (lib/prefs · symbolCaptions). The Plan has no
   *  zoom, so captions show whenever the mode is on (no zoom gate, unlike the Lage map). */
  captionMode?: CaptionMode
  onChange: (next: BoardAnno[]) => void
  building: BuildingDoc | null
  onSelectBuilding: (src: [number, number][][], orientDeg: number) => void
  onAddFloor: (dir: 1 | -1) => void
  onRemoveFloor: (floor: number) => void
  /** flip the Gebäudeview between oriented + "Norden oben": persists the re-oriented
   *  building (annotations are re-glued via this component's own commit/undo path). */
  onReorient?: (next: BuildingDoc) => void
  /** viewers can pan/inspect but not mutate plan structure (floors, building) */
  readOnly?: boolean
  sym: SymbolsApi
  /** active Mannschaft names feeding the symbol detail comboboxes (Einsatzleiter / Fahrer …) */
  rosterNames?: string[]
  /** name → rank key, for the officer-first sort + "nur Offiziere" filter on leadership symbols */
  rosterRank?: Record<string, string | undefined>
  onRecent: (name: string) => void
  /** append to the unified journal with plan context (team link, plan coords). */
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  /** symbol placed → App may offer logging it as Mittel (same hook as the Lage map) */
  onSymbolPlaced?: (name: string) => void
  /** record a plan mutation in the hash-chained audit trail (board.* ops). No-op
   *  default keeps the component usable standalone / in tests. */
  emit?: (op: string, payload?: Record<string, unknown>) => void
  /** expose this plan's per-document undo/redo so the GLOBAL TopBar control can drive
   *  it while the Plan is the active surface (App routes undo/redo by surface). */
  historyRef?: React.MutableRefObject<{ undo: () => void; redo: () => void } | null>
  /** report this plan's can-undo/redo flags up so the TopBar buttons enable correctly. */
  onHistoryState?: (s: { canUndo: boolean; canRedo: boolean }) => void
  /** expose fit-to-view so the phone top bar can offer Fit instead of a floating cluster. */
  fitRef?: React.MutableRefObject<(() => void) | null>
  /** a Verlauf row asked to revisit a plan point — center + select on arrival. */
  focus: { x: number; y: number; floor: number; annoId?: string; nonce: number } | null
  /** report the current plan-view centre (tile-local) so a journal pin can anchor to it. */
  onView: (c: { x: number; y: number; floor: number }) => void
  /** currently monitored Atemschutz Trupps — offered when placing a team chip on the plan. */
  trupps?: Trupp[]
  /** link a placed chip to a tracked Trupp (chip ↔ Trupp; sets the Trupp's annoId/planId). */
  onLinkTrupp?: (annoId: string, truppId: string) => void
  /** jump to the Atemschutz board for a linked Trupp ("show the trupp"). */
  onShowTrupp?: (truppId: string) => void
  /** per-plan distance calibration (planId → factor). A plan has no inherent scale; the user
   *  calibrates against a printed scale bar so line lengths read in metres. See lib/planScale. */
  planScale?: PlanScales
  /** persist a plan's calibration (null clears it). Rides the workspace blob via App. */
  onCalibrate?: (planId: string, scale: PlanScale | null) => void
}

/** extra context a Whiteboard action attaches to its journal line. */
export interface PlanLogExtra { kind?: 'symbol' | 'team' | 'history'; annoId?: string; x?: number; y?: number; floor?: number }

// Whiteboard / Tafel — pick a plan document as the background, then
// annotate it with draw / text / symbols and place resource chips whose
// timestamp updates each time they are moved. All annotation coordinates are
// normalized 0..1 in plan-image space so they stick across zoom/pan.
export function Whiteboard({ plans, activeId, annos, symMul = 1, captionMode = 'off', onChange, building, onSelectBuilding, onReorient, onAddFloor, onRemoveFloor, readOnly: readOnlyProp = false, sym, rosterNames = [], rosterRank, onRecent, log, onSymbolPlaced, emit = () => {}, historyRef, onHistoryState, fitRef, focus, onView, trupps = [], onLinkTrupp, onShowTrupp, planScale = {}, onCalibrate }: Props) {
  const active = plans.find((p) => p.id === activeId) ?? plans[0]
  // A viewer-only plan (e.g. PV/documentation PDF) is read-only regardless of role: plain
  // pan/zoom, no drawing tools or annotation surface. Folds into the existing readOnly gates.
  const readOnly = readOnlyProp || active?.viewer === true

  const [tool, setTool] = useState<BoardTool>('pan')
  const [pending, setPending] = useState<string | null>(null)
  // a generic shape (Pfeil / Rauch / Rechteck) armed from the palette — mirror of the map's pendingShape
  const [pendingShape, setPendingShape] = useState<ShapeKind | null>(null)
  // place one symbol at a time by default (drop to pan + select it after each), or
  // hold the lock to keep placing several — identical to the Lage map placement model.
  const [placeLock, setPlaceLock] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  // marquee (Mehrfach/lasso) group selection — parity with the Lage map. A separate
  // set from the single selId (which still drives the symbol editor / team actions).
  const [selIds, setSelIds] = useState<string[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  // a pending team placement awaiting a Trupp pick (x/y/floor of the tapped point)
  const [truppPick, setTruppPick] = useState<{ x: number; y: number; floor: number } | null>(null)
  const [color, setColor] = useState<string>(appConfig.drawing.defaultColor)
  const [width, setWidth] = useState(5)
  const [dashed, setDashed] = useState(false)
  const [draft, setDraft] = useState<[number, number][] | null>(null)
  // the single Linie tool's input mode: Freihand (drag) ↔ Punkte (tap each vertex), like the Lage map
  const [lineMode, setLineMode] = useState<'freehand' | 'nodes'>('freehand')
  // sticky line preset (Freihand / Messpfeil / Rettungsachse) baked into a new line + editable after,
  // mirroring the Lage map. Chosen in the post-draw editor now, not the dock.
  const [linePreset, setLinePreset] = useState<string>(appConfig.drawing.linePresets[0].id)
  // last node-tap (time + point) to detect a double-tap that finishes the shape
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const [aspect, setAspect] = useState(1.414) // h/w, A4 default until image loads
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const [showTrails, setShowTrails] = useState(true) // global team-trail visibility
  // Plan-Maßstab calibration: the reference is captured by tapping its TWO endpoints (nodes), then
  // a popover asks for its real length. last-used length is pre-filled (plans share similar bars).
  const [calNodes, setCalNodes] = useState<[number, number][]>([])
  const [calPrompt, setCalPrompt] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const [lastRefM, setLastRefM] = useState<number>(appConfig.drawing.planScaleDefaultM)
  const [refMInput, setRefMInput] = useState<string>('')
  // Messen (measure): node-based distance / area, ephemeral (never saved). Each mode keeps its own
  // points, exactly like the Lage map's useMeasure. Metrics come from the plan calibration.
  const [measMode, setMeasMode] = useState<'line' | 'area'>('line')
  const [measLine, setMeasLine] = useState<[number, number][]>([])
  const [measArea, setMeasArea] = useState<[number, number][]>([])

  const canvasRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // rail tool buttons, so a tool's option dock can be top-aligned to its button
  const toolBtn = useRef<Record<string, HTMLButtonElement | null>>({})
  const chipDrag = useRef<{ id: string; moved: boolean } | null>(null)
  // drag a single selected freehand stroke (its original board-space vertices + the start point)
  const drawDrag = useRef<{ id: string; floor: number; sx: number; sy: number; bpts: [number, number][]; moved: boolean } | null>(null)
  // drag a single VERTEX of a selected line/area (shared by both — they're both pts-based)
  const vertDrag = useRef<{ id: string; idx: number; floor: number; moved: boolean } | null>(null)
  // drag a Messen vertex (ephemeral measurement path; mirrors vertDrag but never persisted)
  const measDrag = useRef<{ idx: number; moved: boolean } | null>(null)
  // which text note is mid-edit (so we checkpoint undo once per edit session, then stream
  // each keystroke live into the anno — like the Lage note title)
  const textEditId = useRef<string | null>(null)
  // drag-to-rotate a selected directional symbol — mirrors the map's rotor handle
  const rotate = useRef<{ id: string; cx: number; cy: number; moved: boolean; mode: 'rotate' | 'rotate2' | 'resize' } | null>(null)
  // the group-move drag origin (start client point and the original board-space geometry of
  // every selected anno). Pan/pinch/marquee refs live in useBoardGestures.
  const groupMove = useRef<{ sx: number; sy: number } | null>(null)
  type GrpOrig = { id: string; floor: number; bx?: number; by?: number; bpts?: [number, number][] }
  const groupOrig = useRef<GrpOrig[]>([])
  // zoom/pan view state (layout-based zoom + focal wheel-zoom) lives in a hook
  const { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom } = useBoardView(canvasRef)

  const osm = active.osm
  // floor-stack: a vertical stack of footprint sheets (top = highest storey)
  const stack = !!(active.floorStack && building && building.floors.length)
  const floorsTTB = useMemo(() => (stack ? [...building!.floors].sort((a, b) => b - a) : []), [stack, building])
  const N = floorsTTB.length || 1
  const blank = !active.imageUrl && !osm && !stack

  // Active footprint view: buildings picked since auto-orientation carry `src`, so the
  // rendered rings/aspect are derived for the current orientation (oriented by default,
  // or north-up when toggled). Older docs fall back to their stored rings (north-up only).
  const orientDeg = building?.orientDeg ?? 0
  const viewAngle = building?.northUp ? 0 : orientDeg
  const fpView = useMemo(() => {
    if (!building) return null
    if (building.src?.length) return buildView(building.src, viewAngle)
    return { rings: building.rings ?? [building.ring], aspect: building.ringAspect }
  }, [building, viewAngle])
  // the align-longest-axis compass only makes sense on the Gebäude floor-stack (whose storeys are
  // drawn from the building footprint). On a module/PDF plan the page is already aligned, so even
  // though a building may be selected at the incident level, the compass must NOT appear there.
  const canOrient = stack && !!building?.src?.length && Math.abs(orientDeg) > 0.001

  const draftFloor = useRef(0)
  // two-finger pinch tracking ON the create-tool ink overlay, so the user can pinch-zoom the
  // plan WITHOUT leaving the active draw/measure tool (the overlay otherwise swallows pointers)
  const inkPtrs = useRef<Map<number, { x: number; y: number }>>(new Map())
  const inkPinch = useRef<number | null>(null)
  // single-finger node-placement gesture (Maßstab / Messen / node-draw): like the Lage map, a DRAG
  // pans the board and only a genuine TAP drops a node. Placement is deferred to pointer-up so the
  // movement since pointer-down can be measured; px/py is the pan origin the drag offsets from.
  const inkTap = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const inkPinchPts = () => {
    const [a, b] = [...inkPtrs.current.values()]
    if (!a || !b) return null
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }
  // floor-stack ↔ board-normalized y maps for the current document (see lib/whiteboard)
  const { mapY, localY, floorAt } = floorGeometry(stack, floorsTTB, N)

  // reset view + transient state when switching document; seed an aspect from the
  // orientation (image docs refine it on load, blank sheets keep it)
  useEffect(() => {
    applyView(1, { x: 0, y: 0 }); setSelId(null); setSelIds([]); setEditId(null); setDraft(null); setPending(null)
    setMeasLine([]); setMeasArea([]); setCalNodes([]); setCalPrompt(null) // ephemeral measure/calibrate state
    if (tool === 'symbol') setTool('pan')
    setAspect(active.orientation === 'portrait' ? 1.414 : 1 / 1.414)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // drop any in-progress node draft when the tool changes (e.g. leaving Linie/Fläche mid-shape);
  // a half-laid Messen path / Maßstab tap is ephemeral too, so clear them when leaving those tools
  useEffect(() => {
    setDraft(null); lastTap.current = null
    if (tool !== 'measure') { setMeasLine([]); setMeasArea([]) }
    if (tool !== 'scale') setCalNodes([])
  }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps
  // Esc cancels an in-progress node shape, else clears the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (draft) { setDraft(null); lastTap.current = null }
      else if (selId) setSelId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, selId])

  // Stable ref callback that focuses a freshly-mounted text/resource input. The focus is
  // DEFERRED past the current placement tap: focusing synchronously on mount gets immediately
  // undone by the tap's pointerup/click blurring the input (→ onBlur clears edit mode before
  // you can type). A 0ms timeout runs after the gesture settles, so the input keeps focus.
  // Focus synchronously when the input mounts — a deferred (setTimeout) focus drops out of the
  // tap's gesture context, so iPadOS refuses to open the on-screen keyboard for a freshly
  // placed Notiz. Focusing in the ref callback keeps it as close to the gesture as React allows.
  const focusOnce = useCallback((el: HTMLInputElement | null) => {
    if (!el) return
    el.focus(); el.select?.()
  }, [])

  // measure viewport so the board can be sized to "contain" the plan exactly
  useEffect(() => {
    const el = canvasRef.current; if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // warm every plan's bitmap in the background once the viewport is measured, so
  // switching documents is an instant blit rather than a fresh rasterization
  useEffect(() => {
    if (!vp.w || !vp.h) return
    prewarmPlans(plans.filter((p) => p.imageUrl).map((p) => planUrl(p.imageUrl)), vp.w, vp.h)
  }, [plans, vp.w, vp.h])

  // in stack mode the board's aspect is driven by the floor count, not the doc
  const effAspect = stack ? N * TILE_AR : aspect
  // "contain" the plan in the area below the top bar: full width, but the usable
  // height excludes TOP_INSET so the fitted plan never sits behind the bar. In the
  // floor-stack we also reserve STACK_VPAD top & bottom so the +OG / −UG pills (which
  // straddle the stack edges) stay fully visible at the default fit.
  const fit = useMemo(() => {
    const w = vp.w, h = Math.max(0, vp.h - TOP_INSET - (stack ? 2 * STACK_VPAD : 0)); if (!w || !h) return { w: 0, h: 0 }
    const byW = { w, h: w * effAspect }
    return byW.h <= h ? byW : { w: h / effAspect, h }
  }, [vp, effAspect, stack])
  // Zoom by LAYOUT, not by a CSS scale transform: the board's real pixel size is
  // fit × scale. This re-rasterizes the PDF + SVG symbols + text crisply at the
  // actual zoom instead of bitmap-scaling a 100% texture (which pixelates them).
  const sW = fit.w * scale, sH = fit.h * scale

  // client point → normalized 0..1 in plan space (board rect reflects the transform)
  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const r = boardRef.current?.getBoundingClientRect(); if (!r || !r.width) return null
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height]
  }

  // --- Plan-Maßstab: derived calibration state for the active plan ---
  // Measurement is aspect-corrected: a normalized segment's true length depends on the plan's
  // aspect ratio (width / height). On a single sheet that's 1/aspect; on a floor-stack each storey
  // TILE is measured in its own space (1/TILE_AR), so one calibration covers every floor of the
  // same drawing. The reference drag and stored line `pts` live in this same space.
  const measureAR = stack ? 1 / TILE_AR : 1 / aspect
  const activeScale: PlanScale | undefined = planScale[activeId]
  const scaleStale = !!activeScale && isStale(activeScale, measureAR)
  const calibrated = !!activeScale && !scaleStale
  // metres of a stored polyline (tile-local pts already, for a floor-stack) under the calibration
  const planMetres = (pts: [number, number][]): number | null =>
    calibrated && activeScale ? pathMetres(pts, activeScale.mPerU, measureAR) : null
  // convert a board-normalized point into the measurement space (tile-local y on a floor-stack)
  const toMeasurePt = (n: [number, number]): [number, number] => stack ? [n[0], localY(n[1], floorAt(n[1]))] : n

  // --- Messen: the active path + calibrated metrics for the panel (line OR area, per mode) ---
  const measPath = measMode === 'line' ? measLine : measArea
  const setMeasPath = (fn: (pts: [number, number][]) => [number, number][]) => (measMode === 'line' ? setMeasLine(fn) : setMeasArea(fn))
  const measMpts = measPath.map(toMeasurePt)
  const measLenM = calibrated && activeScale ? pathMetres(measMpts, activeScale.mPerU, measureAR) : 0
  const measAreaM2 = calibrated && activeScale ? polyAreaM2(measMpts, activeScale.mPerU, measureAR) : 0
  const measPerimM = calibrated && activeScale && measMpts.length >= 3 ? pathMetres([...measMpts, measMpts[0]], activeScale.mPerU, measureAR) : 0
  const measReset = () => { setMeasLine([]); setMeasArea([]) }

  // Annotation document + per-plan undo/redo (the keyed history map, the set/commit mutation
  // funnel, audit-emitting CRUD, and the global-TopBar history wiring) live in useBoardDoc; the
  // gesture handlers and render below call the returned mutators exactly as before.
  const { pushPast, set, commit, add, patch, patchCommit, remove, removeAnno } = useBoardDoc({
    annos, onChange, emit, activeId, log, selId, setSelId, editId, setEditId, historyRef, onHistoryState,
  })
  // expose fit-to-view (the phone top bar's Fit button calls it; desktop uses the rail footer)
  useEffect(() => { if (fitRef) fitRef.current = () => applyView(1, { x: 0, y: 0 }); return () => { if (fitRef) fitRef.current = null } })

  // every tap-to-place tool needs the .wb-ink capture overlay mounted — INCLUDING 'shape'
  // (the palette's Rauch/Rechteck/Pfeil forms). Omitting 'shape' left its overlay off the
  // Plan, so arming a shape froze the surface: the tap placed nothing and, with no overlay,
  // the board couldn't pan either. placeNode already handles 'shape'.
  const creating = tool === 'line' || tool === 'area' || tool === 'text' || tool === 'symbol' || tool === 'shape' || tool === 'resource' || tool === 'scale' || tool === 'measure'
  // node-based (tap each vertex, then finish): the area tool, and the Linie tool in Punkte mode.
  // In Freihand mode the Linie tool drags a stroke instead (handled below).
  const noding = tool === 'area' || (tool === 'line' && lineMode === 'nodes')
  // the in-progress node draft is committable: an area needs ≥3 pts, a Punkte-mode line ≥2 (gates ✓)
  const draftActive = (tool === 'area' && (draft?.length ?? 0) >= 3) || (tool === 'line' && lineMode === 'nodes' && (draft?.length ?? 0) >= 2)
  // symbols/notes are sized smaller on the Gebäude floor-stack (small storey tiles) than on the
  // full-page module plans, so they don't dwarf the building outline — closer to the Lage map feel
  // Symbol/note size: on a PDF plan, scale it to the board WIDTH (= one page's width, since stitched
  // multi-page plans stack pages vertically at the same width). A fixed px size looked right on a
  // single page but went gigantic on a tall multi-page stitch (where the board is narrow); this keeps
  // a symbol ~the same fraction of a page whether the plan is 1 page or 6. The Gebäude floor-stack
  // keeps its own tuned sizes. (~0.085·fit.w ≈ 42 on a typical single A4 portrait.)
  const symBase = (stack ? 28 : Math.max(16, Math.min(52, fit.w * 0.085))) * symMul
  const txtBase = stack ? 10 : Math.max(7, Math.min(16, fit.w * 0.026))

  // --- create-tool interactions (on the ink overlay) ---
  // every created anno carries its storey (floor) and tile-local coords; on a
  // single-sheet doc that's floor 0 and coords == board-normalized.
  const inkDown = (e: React.PointerEvent) => {
    inkPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (inkPtrs.current.size >= 2) {
      // a second finger means "pinch-zoom", not "place another point": abort an in-progress
      // freehand stroke (node/area drafts keep their tapped vertices) and start the pinch
      e.stopPropagation()
      if (tool === 'line' && lineMode === 'freehand') setDraft(null)
      inkTap.current = null // a second finger → pinch-zoom, not a node tap
      inkPinch.current = inkPinchPts()?.dist ?? null
      return
    }
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    e.stopPropagation() // placement owns this pointer — don't let the stage ALSO start a board pan
    const floor = stack ? floorAt(n[1]) : 0
    const x = n[0], y = localY(n[1], floor)
    if (tool === 'line' && lineMode === 'freehand') {
      // Freehand is the one create tool whose gesture IS the drag — the stroke follows the finger,
      // so it can't double as a pan. Every OTHER create tool places on a single tap (placeNode/inkUp).
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      draftFloor.current = floor
      setDraft([[x, y]])
      return
    }
    // All tap-to-place tools — Maßstab, Messen, node-draw (Linie/Fläche), Text, Symbol, Trupp —
    // mirror the Lage map: a DRAG pans the board, only a genuine tap drops/places. Defer to
    // pointer-up so a pan never leaves a stray node/symbol/chip behind; capture so the drag tracks
    // past the overlay edge.
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    inkTap.current = { x: e.clientX, y: e.clientY, px: posRef.current.x, py: posRef.current.y, moved: false }
  }
  // create a resource chip — linked to a tracked Trupp when one is picked, else a generic team
  const placeTeamChip = (x: number, y: number, floor: number, trupp?: Trupp) => {
    const teams = annos.filter((a) => a.kind === 'resource').length
    const id = `r${Date.now()}`
    const name = trupp ? trupp.name : `${appConfig.copy.whiteboard.team} ${teams + 1}`
    const color = TEAM_COLORS[teams % TEAM_COLORS.length]
    add({ id, kind: 'resource', x, y, floor, text: name, t: formatTime(new Date()), color, trail: [], truppId: trupp?.id })
    if (trupp) onLinkTrupp?.(id, trupp.id)
    setSelId(id); log('flag', fillTemplate(appConfig.copy.whiteboard.placeTeam, { name }))
  }
  // deferred placement for the node tools: run on a genuine tap (pointer-up without a pan). Mirrors
  // the bodies the Lage map runs on click — Maßstab/Messen nodes, node-draw vertices, Text, Symbol,
  // Trupp. Freehand is the exception (it draws on the drag itself), so it never routes through here.
  const placeNode = (e: React.PointerEvent) => {
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    const floor = stack ? floorAt(n[1]) : 0
    const x = n[0], y = localY(n[1], floor)
    if (tool === 'scale') {
      // Maßstab: tap the TWO endpoints of the printed scale bar; the second tap opens the
      // metre-entry popover. Coords stay board-normalized (converted to measure space on confirm).
      const next: [number, number][] = [...calNodes, n]
      if (next.length >= 2) { setCalNodes([]); setCalPrompt({ a: next[0], b: next[1] }); setRefMInput(String(lastRefM)) }
      else setCalNodes(next)
      return
    }
    if (tool === 'measure') {
      // Messen: each tap drops a measurement node (mirrors the Lage map's measure tool). But on an
      // UNCALIBRATED plan the first segment IS the calibration — the two reference taps open the
      // metre popover directly, so the user never has to find a separate Maßstab step first.
      if (!calibrated) {
        const next: [number, number][] = [...measPath, n]
        if (next.length >= 2) { setCalPrompt({ a: next[0], b: next[1] }); setRefMInput(String(lastRefM)); setMeasLine([]); setMeasArea([]) }
        else setMeasPath(() => next)
        return
      }
      setMeasPath((p) => [...p, n])
      return
    }
    if (noding) {
      // node-based Linie / Fläche: each tap drops a vertex; a double-tap (or the «Fertig» button)
      // closes the shape. The whole shape lives on the FIRST vertex's storey.
      const now = e.timeStamp
      const lt = lastTap.current
      const dbl = !!(lt && now - lt.t < 350 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 24)
      lastTap.current = { t: now, x: e.clientX, y: e.clientY }
      if (dbl) { finishShape(); return }
      if (!draft) draftFloor.current = floor
      const ly = localY(n[1], draftFloor.current)
      setDraft((d) => (d ? [...d, [n[0], ly]] : [[n[0], ly]]))
      return
    }
    if (tool === 'text') {
      const id = `t${Date.now()}`
      add({ id, kind: 'text', x, y, floor, text: '' })
      setSelId(id); setEditId(id); setTool('pan'); log('type', appConfig.copy.whiteboard.placeText)
      return
    }
    if (tool === 'symbol') {
      if (!pending) { setPaletteOpen(true); return }
      const id = `s${Date.now()}`; const s = pending
      // shared seeding (label / subtitle / fields) — identical to the Lage placement
      // path, so a plan symbol now carries the same editable structure as a map one
      add({ id, kind: 'symbol', x, y, floor, ...seedSymbolProps(s, sym.symbols) })
      onRecent(s); log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name: formatSymbolName(s) }))
      onSymbolPlaced?.(s)
      // unlocked: place once, then drop to pan with the new symbol selected so its
      // editor + rotor are immediately usable. locked: stay armed (no selection) to
      // drop several in a row. Same one-at-a-time / lock model as the Lage map.
      if (placeLock) setSelId(null)
      else { setPending(null); setTool('pan'); setSelId(id) }
      return
    }
    if (tool === 'shape') {
      if (!pendingShape) { setPaletteOpen(true); return }
      const id = `sh${Date.now()}`; const k = pendingShape
      const def = SHAPE_DEFS[k]
      const name = appConfig.copy.shapes.names[k] ?? appConfig.copy.shapes.kindLabel
      // same defaults + naming as the Lage placement path; size is normalized to the plan width
      add({ id, kind: 'shape', x, y, floor, shape: k, color: def.defaultColor, sizeN: def.defaultSizeN, rotation: 0, label: name })
      log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name }))
      // unlocked: place once → pan with the shape selected (rotor/resize usable); locked: keep placing
      if (placeLock) setSelId(null)
      else { setPendingShape(null); setTool('pan'); setSelId(id) }
      return
    }
    if (tool === 'resource') {
      // if any Atemschutz Trupps are being tracked, ask WHICH one this chip is (listing the
      // names); otherwise drop a generic Team N. Placed trupps are listed too so the names
      // always appear once a Trupp is tracked.
      const active = trupps.filter((t) => t.status !== 'raus')
      if (active.length) { setTruppPick({ x, y, floor }); setTool('pan') }
      else { placeTeamChip(x, y, floor); setTool('pan') }
    }
  }
  const inkMove = (e: React.PointerEvent) => {
    if (inkPtrs.current.has(e.pointerId)) inkPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (inkPinch.current != null) {
      const m = inkPinchPts(); const el = canvasRef.current
      if (m && el && inkPinch.current > 0 && m.dist > 0) {
        const r = el.getBoundingClientRect(); zoomTo(m.dist / inkPinch.current, m.mx - r.left, m.my - r.top)
      }
      if (m) inkPinch.current = m.dist
      return
    }
    if (inkTap.current) {
      // node tool: drag pans the board (and disqualifies the tap). 8px of slop tolerates finger
      // jitter so a still tap still places. Pan from the recorded origin, like useBoardGestures.
      const st = inkTap.current, dx = e.clientX - st.x, dy = e.clientY - st.y
      if (!st.moved && Math.hypot(dx, dy) > 8) st.moved = true
      if (st.moved) applyView(scaleRef.current, { x: st.px + dx, y: st.py + dy })
      return
    }
    if (!(tool === 'line' && lineMode === 'freehand') || !draft) return
    const n = toNorm(e.clientX, e.clientY); if (n) setDraft((d) => (d ? [...d, [n[0], localY(n[1], draftFloor.current)]] : [[n[0], localY(n[1], draftFloor.current)]]))
  }
  const inkUp = (e?: React.PointerEvent) => {
    if (e) inkPtrs.current.delete(e.pointerId)
    if (inkPtrs.current.size < 2) inkPinch.current = null
    if (inkTap.current) {
      const st = inkTap.current; inkTap.current = null
      // a clean pointer-up that never panned is a tap → drop the node; a drag (moved) or a
      // pointer-cancel just leaves the panned view as-is, with no stray node placed.
      if (e && e.type === 'pointerup' && !st.moved) placeNode(e)
      return
    }
    if (tool === 'line' && lineMode === 'freehand' && draft) {
      // thin the raw stroke into a clean, editable polyline (drops the point clusters a slow finger
      // dumps at the start/end). Node-mode lines keep their explicit taps (finishShape doesn't thin).
      if (draft.length >= 2) addLine(simplifyFreehand(draft, sW, sH))
      setDraft(null)
    }
  }
  // close the metre-entry popover, returning to where calibration was started from: stay in
  // Messen (the auto-calibrate-on-first-measure flow), otherwise drop to pan (the Maßstab chip).
  const closeCalPrompt = () => { setCalPrompt(null); setTool(tool === 'measure' ? 'measure' : 'pan') }
  // commit the metre-entry popover: derive + persist the calibration factor for this plan
  const commitCalibration = (refM: number) => {
    if (!calPrompt) return
    const a = toMeasurePt(calPrompt.a), b = toMeasurePt(calPrompt.b)
    const sc = calibrate(a, b, refM, measureAR)
    closeCalPrompt()
    if (!sc) return
    setLastRefM(refM)
    onCalibrate?.(activeId, sc)
    log('measure', fillTemplate(appConfig.copy.whiteboard.scale.saved, { m: String(refM) }))
    toast(fillTemplate(appConfig.copy.whiteboard.scale.saved, { m: String(refM) }))
  }
  // create a Linie from a finished path (a freehand drag OR a node-tapped draft), baking the sticky
  // preset's arrow/marker/dash — then one-shot to pan with the new line selected so its style editor
  // opens right away. Mirrors the Lage map's createLine, so both surfaces behave identically.
  const addLine = (pts: [number, number][]) => {
    const p = linePresetPatch(linePreset) // SAME preset bundle the Lage map bakes (lib/lineStyle)
    const id = `l${Date.now()}`
    add({ id, kind: 'draw', pts, floor: draftFloor.current, color, width,
      dashed: p.dashed ?? dashed, arrow: p.arrow || undefined, marker: p.marker || undefined, showDistance: p.showDistance || undefined })
    log('pen', appConfig.copy.whiteboard.placeLine)
    setSelId(id); setTool('pan')
  }
  // commit the in-progress node shape: a Linie (≥2 pts) or a Fläche (≥3 pts, closed + filled).
  // Then drop to pan so it's immediately selectable.
  const finishShape = () => {
    const d = draft
    if (tool === 'line' && d && d.length >= 2) {
      setDraft(null); lastTap.current = null
      addLine(d)
      return
    }
    if (tool === 'area' && d && d.length >= 3) {
      const id = `a${Date.now()}`
      add({ id, kind: 'area', pts: d, floor: draftFloor.current, color, width, dashed })
      log('area', appConfig.copy.whiteboard.placeArea)
      // select the new area + drop to pan so its draggable vertex handles are immediately usable
      // (matches the Lage map, where a finished area auto-selects for reshaping)
      setDraft(null); lastTap.current = null; setSelId(id); setTool('pan')
      return
    }
    setDraft(null); lastTap.current = null; setTool('pan')
  }
  const cancelShape = () => { setDraft(null); lastTap.current = null }

  // --- single freehand-stroke select + drag (tap the fat hit-line in WbInkLayer, pan mode) ---
  const drawDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan' || readOnly) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    setSelId(id); setSelIds([])
    const a = annos.find((x) => x.id === id); if (!a || (a.kind !== 'draw' && a.kind !== 'area')) return
    // snapshot the vertices in board-space (y mapped to the stacked board), so the delta is always
    // applied to the original geometry — no drift across re-renders (mirrors the group-move math)
    drawDrag.current = { id, floor: a.floor ?? 0, sx: e.clientX, sy: e.clientY,
      bpts: (a.pts ?? []).map(([x, y]) => [x, mapY(a.floor, y)] as [number, number]), moved: false }
  }
  const drawMove = (e: React.PointerEvent) => {
    const st = drawDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    // tap-vs-drag threshold: a finger never lands perfectly still, so without this a plain TAP on
    // a selected area/line nudged it (and stamped an undo step). Below ~6px it's a tap → no move,
    // so tapping just keeps the selection (and tapping empty space still deselects via the stage).
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 6) return
      pushPast(); st.moved = true // one checkpoint per drag
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    patch(st.id, { pts: st.bpts.map(([x, by]) => [x + ndx, localY(by + ndy, st.floor)] as [number, number]) })
  }
  const drawUp = () => {
    const st = drawDrag.current; drawDrag.current = null
    if (st?.moved) emit('board.move', { id: st.id, planId: activeId })
  }

  // --- drag a Linie's free-text label to a per-line offset (normalized board fractions, so it
  // tracks under zoom), mirroring the Lage map's moveLabel. Folds into one undo step like the
  // stroke move: snapshot on first move, stream, emit on release. ---
  const labelDrag = useRef<{ id: string; sx: number; sy: number; dx0: number; dy0: number; moved: boolean; which: 'label' | 'end' } | null>(null)
  const labelDown = (e: React.PointerEvent, id: string, dx0: number, dy0: number, which: 'label' | 'end' = 'label') => {
    if (tool !== 'pan' || readOnly) return
    e.stopPropagation()
    // capture on the STABLE handler element (the label span), NOT e.target (an inner text <div>
    // that re-renders as the label moves) — a lost capture sent the moves to the stage, which
    // panned the board and made the label jump unpredictably
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setSelId(id)
    labelDrag.current = { id, sx: e.clientX, sy: e.clientY, dx0, dy0, moved: false, which }
  }
  const labelMove = (e: React.PointerEvent) => {
    const st = labelDrag.current; if (!st) return
    // setPointerCapture retargets but does NOT stop bubbling — without this stop, every label
    // move ALSO bubbles to the canvas stageMove → manipMove and drives any live area/vertex drag,
    // so dragging the label "moved everything". Stop it here (after the ours-check, before the
    // threshold return so sub-threshold frames don't leak to the stage either).
    e.stopPropagation()
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 6) return // tap, not a drag
      pushPast(); st.moved = true
    }
    const ndx = st.dx0 + (e.clientX - st.sx) / rect.width
    const ndy = st.dy0 + (e.clientY - st.sy) / rect.height
    patch(st.id, st.which === 'end' ? { endDx: ndx, endDy: ndy } : { labelDx: ndx, labelDy: ndy })
  }
  const labelUp = (e: React.PointerEvent) => {
    if (!labelDrag.current) return
    e.stopPropagation()
    const st = labelDrag.current; labelDrag.current = null
    if (st?.moved) emit('board.edit', { id: st.id, planId: activeId })
  }

  // --- vertex editing of a selected line/area (drag a node, insert on a segment, delete a node).
  // Identical for both kinds — they're both just `pts`, so one code path serves Linie and Fläche. ---
  const vertDown = (idx: number, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const a = annos.find((x) => x.id === selId); if (!a?.pts) return
    vertDrag.current = { id: a.id, idx, floor: a.floor ?? 0, moved: false }
  }
  const vertMove = (e: React.PointerEvent) => {
    const st = vertDrag.current; if (!st) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    if (!st.moved) { pushPast(); st.moved = true }
    patch(st.id, { pts: (annos.find((a) => a.id === st.id)?.pts ?? []).map((p, i) => (i === st.idx ? [n[0], localY(n[1], st.floor)] : p)) })
  }
  const vertUp = () => {
    const st = vertDrag.current; vertDrag.current = null
    if (st?.moved) emit('board.edit', { id: st.id, planId: activeId })
  }
  // insert a node on the segment after vertex `idx` (at its midpoint), then commit
  const insertVertex = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    const a = annos.find((x) => x.id === selId); const pts = a?.pts; if (!a || !pts) return
    const next = pts[(idx + 1) % pts.length] // wraps for the closing edge of an area
    const mid: [number, number] = [(pts[idx][0] + next[0]) / 2, (pts[idx][1] + next[1]) / 2]
    patchCommit(a.id, { pts: [...pts.slice(0, idx + 1), mid, ...pts.slice(idx + 1)] })
  }
  // delete vertex `idx`, keeping a valid shape (≥2 for a line, ≥3 for an area)
  const deleteVertex = (idx: number) => {
    const a = annos.find((x) => x.id === selId); const pts = a?.pts; if (!a || !pts) return
    if (pts.length <= (a.kind === 'area' ? 3 : 2)) return
    // a long-press delete fires mid-pointer-session — drop the pending drag so further
    // finger movement can't reshape whichever point inherited this index
    vertDrag.current = null
    patchCommit(a.id, { pts: pts.filter((_, i) => i !== idx) })
  }

  // --- Messen node editing (ephemeral; mirrors the vertex handlers but on the measure path) ---
  const measNodeDown = (idx: number, e: React.PointerEvent) => {
    if (tool !== 'measure') return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    measDrag.current = { idx, moved: false }
  }
  const measMove = (e: React.PointerEvent) => {
    const st = measDrag.current; if (!st) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    st.moved = true
    setMeasPath((p) => p.map((q, i) => (i === st.idx ? n : q)))
  }
  const measUp = () => { measDrag.current = null }
  const measInsert = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    setMeasPath((p) => { const b = p[(idx + 1) % p.length]; const mid: [number, number] = [(p[idx][0] + b[0]) / 2, (p[idx][1] + b[1]) / 2]; return [...p.slice(0, idx + 1), mid, ...p.slice(idx + 1)] })
  }
  const measDelete = (idx: number) => { measDrag.current = null; setMeasPath((p) => p.filter((_, i) => i !== idx)) }
  // touch path for node delete — double-tap rarely synthesizes dblclick on iOS
  const measPress = useLongPress()

  // --- chip dragging (resource / symbol / text in pan mode) ---
  const chipDown = (e: React.PointerEvent, id: string) => {
    if (tool !== 'pan') return
    if (readOnly) {
      // view-only (viewer / replay / EL view): a tap still SELECTS — so the read-only
      // detail panel can open, parity with the Lage map — but never arms a drag
      e.stopPropagation()
      setSelId(id); setSelIds([])
      return
    }
    e.stopPropagation()
    chipDrag.current = { id, moved: false }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setSelId(id); setSelIds([])
  }
  const chipMove = (e: React.PointerEvent) => {
    if (!chipDrag.current) return
    const a = annos.find((x) => x.id === chipDrag.current!.id); if (!a) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    if (!chipDrag.current.moved) pushPast() // one checkpoint per drag, before the first move
    chipDrag.current.moved = true
    // on the floor-stack the chip drags FREELY across storeys: the floor follows the cursor,
    // y is re-localised into whichever storey the pointer is over. Single-sheet docs unchanged.
    const f = stack ? floorAt(n[1]) : a.floor
    patch(chipDrag.current.id, { x: n[0], y: localY(n[1], f ?? 0), ...(stack ? { floor: f } : {}) })
  }
  const chipUp = () => {
    const d = chipDrag.current; chipDrag.current = null
    if (!d || !d.moved) return
    // moving just relocates the team's live position — it does NOT record a
    // breadcrumb. Positions are logged only via markPosition (explicit), so the
    // rule is unambiguous: a dot exists exactly where you chose to log one.
    const a = annos.find((x) => x.id === d.id)
    if (a?.kind === 'resource') patch(d.id, { t: formatTime(new Date()) })
    // record the relocation in the audit trail (the drag itself was silent patches)
    if (a) emit('board.move', { id: d.id, x: a.x, y: a.y, floor: a.floor, planId: activeId })
  }

  // object-manipulation hand-off for the stage dispatcher in useBoardGestures: when no
  // pan/pinch/marquee gesture owns the pointer, route move/up to the active chip/draw/vertex
  // drag (each no-ops if its ref is null — same fall-through the inline dispatcher had).
  const manipMove = (e: React.PointerEvent) => {
    if (chipDrag.current) chipMove(e)
    else if (drawDrag.current) drawMove(e)
    else if (vertDrag.current) vertMove(e)
    else if (measDrag.current) measMove(e)
  }
  const manipUp = () => { chipUp(); drawUp(); vertUp(); measUp() }

  // pan / pinch-zoom / marquee multi-select + the shared stage pointer dispatcher live in
  // useBoardGestures; object manipulation is reached through manipMove/manipUp above.
  const { marquee, stageDown, stageMove, stageUp } = useBoardGestures({
    tool, annos, setSelId, setSelIds, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp,
  })

  // --- drag-to-rotate a selected directional symbol (rotor handle) ---
  // angle from the glyph centre to the pointer becomes the rotation (+90° so the
  // top knob leads); the whole gesture is one undo step (checkpoint on first move).
  const rotDown = (e: React.PointerEvent, id: string, mode: 'rotate' | 'rotate2' | 'resize' = 'rotate') => {
    if (tool !== 'pan' || readOnly) return
    e.stopPropagation()
    const anno = (e.currentTarget as HTMLElement).closest('.wb-anno')
    const glyph = (anno?.querySelector('.ts, .shape-glyph') ?? anno) as HTMLElement | null
    if (!glyph) return
    const r = glyph.getBoundingClientRect()
    rotate.current = { id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false, mode }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const rotMove = (e: React.PointerEvent) => {
    const st = rotate.current; if (!st) return
    if (!st.moved) { pushPast(); st.moved = true } // one checkpoint per rotate/resize gesture
    if (st.mode === 'resize') {
      // corner grip = half-diagonal from the glyph centre → full width, normalized to the
      // (scaled) plan width — same maths as the map's shape resize, in plan space
      const dist = Math.hypot(e.clientX - st.cx, e.clientY - st.cy)
      patch(st.id, { sizeN: Math.max(0.03, Math.min(0.9, (dist * Math.SQRT2) / sW)) })
      return
    }
    const deg = (Math.atan2(e.clientY - st.cy, e.clientX - st.cx) * 180) / Math.PI
    // body knob at the top (+90), fan knob at the BOTTOM (−90) — opposite sides, easy to grab apart
    const val = Math.round((((deg + (st.mode === 'rotate2' ? -90 : 90)) % 360) + 360) % 360)
    patch(st.id, st.mode === 'rotate2' ? { rotation2: val } : { rotation: val })
  }
  const rotUp = () => {
    const st = rotate.current; rotate.current = null
    if (!st?.moved) return
    const a = annos.find((x) => x.id === st.id)
    if (!a) return
    const patchOut = st.mode === 'resize' ? { sizeN: a.sizeN } : st.mode === 'rotate2' ? { rotation2: a.rotation2 } : { rotation: a.rotation }
    emit('board.edit', { id: st.id, patch: patchOut, planId: activeId })
  }

  // the ONLY way a position is recorded: stamp the current spot + time into the trail
  const markPosition = () => {
    const a = annos.find((x) => x.id === selId)
    if (!a || a.kind !== 'resource') return
    const now = formatTime(new Date())
    patchCommit(a.id, { t: now, trail: [...(a.trail ?? []), { x: a.x ?? 0, y: a.y ?? 0, floor: a.floor ?? 0, t: now }] })
    log('flag', fillTemplate(appConfig.copy.whiteboard.positionMarked, { name: a.text ?? '' }), { kind: 'team', annoId: a.id, x: a.x, y: a.y, floor: a.floor ?? 0 })
    toast(fillTemplate(appConfig.copy.whiteboard.positionMarked, { name: a.text ?? '' }))
  }
  const clearTrail = async () => {
    const a = annos.find((x) => x.id === selId)
    if (!a || a.kind !== 'resource' || !a.trail?.length) return
    // confirm first — one mis-tap must not silently wipe the recorded Truppverfolgung (Lage parity)
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.clearTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: a.text ?? '', n: a.trail.length }),
      confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    patchCommit(a.id, { trail: [] })
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: a.text ?? '' }))
  }
  const recolorTeam = (c: string) => { if (selId) patchCommit(selId, { color: c }) }

  // a team that carries recorded positions is protected from deletion — its trail
  // is part of the incident record, so it must be cleared deliberately first
  const teamLocked = (a: BoardAnno) => a.kind === 'resource' && (a.trail?.length ?? 0) > 0

  // --- marquee group: a single move grip + delete at the combined centre (≥2 selected),
  // mirroring the Lage map's group handles. Both point annos and freehand drawings join. ---
  // centroid in board-normalized space (point anchors + every draw vertex)
  const groupCentroid = (() => {
    if (selIds.length < 2) return null
    let sx = 0, sy = 0, n = 0
    for (const a of annos) {
      if (!selIds.includes(a.id)) continue
      if (a.kind === 'draw') { for (const [x, y] of a.pts ?? []) { sx += x; sy += mapY(a.floor, y); n++ } }
      else { sx += a.x ?? 0; sy += mapY(a.floor, a.y ?? 0); n++ }
    }
    return n ? { x: sx / n, y: sy / n } : null
  })()
  const grpDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    groupMove.current = { sx: e.clientX, sy: e.clientY }
    pushPast() // one checkpoint for the whole group drag
    // snapshot every selected anno's ORIGINAL geometry in board-normalized space, so the
    // delta is always applied to the start position (no drift across re-renders)
    groupOrig.current = annos.filter((a) => selIds.includes(a.id)).map((a) =>
      a.kind === 'draw'
        ? { id: a.id, floor: a.floor ?? 0, bpts: (a.pts ?? []).map(([x, y]) => [x, mapY(a.floor, y)] as [number, number]) }
        : { id: a.id, floor: a.floor ?? 0, bx: a.x ?? 0, by: mapY(a.floor, a.y ?? 0) },
    )
  }
  const grpMove = (e: React.PointerEvent) => {
    const st = groupMove.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    // move within each anno's own storey (floor unchanged), consistent with the flat map group-move
    set(annos.map((a) => {
      const o = groupOrig.current.find((g) => g.id === a.id); if (!o) return a
      if (o.bpts) return { ...a, pts: o.bpts.map(([x, by]) => [x + ndx, localY(by + ndy, o.floor)] as [number, number]) }
      return { ...a, x: (o.bx ?? 0) + ndx, y: localY((o.by ?? 0) + ndy, o.floor) }
    }))
  }
  const grpUp = () => {
    if (!groupMove.current) return
    groupMove.current = null
    annos.filter((a) => selIds.includes(a.id)).forEach((a) => emit('board.move', { id: a.id, x: a.x, y: a.y, floor: a.floor, planId: activeId }))
  }
  // group delete — removes the selection, but trail-carrying teams are protected (their
  // recorded trail is part of the incident record); those stay selected.
  const deleteGroup = () => {
    const removable = selIds.filter((id) => { const a = annos.find((x) => x.id === id); return !!a && !teamLocked(a) })
    if (!removable.length) return
    commit(annos.filter((a) => !removable.includes(a.id)))
    removable.forEach((id) => emit('board.delete', { id, planId: activeId }))
    setSelIds((ids) => ids.filter((id) => !removable.includes(id)))
    setSelId(null)
    log('close', appConfig.copy.whiteboard.groupDeleted)
  }

  // pan (no zoom change) so a normalized plan point lands at the viewport centre
  const centerOnPoint = (x: number, y: number, floor: number) => {
    const s = scaleRef.current, w = fit.w * s, h = fit.h * s
    if (!w || !h) return
    const my = mapY(floor, y)
    applyView(s, { x: -(x * w - w / 2), y: -(my * h - h / 2) })
  }

  // keep the tapped object visible: the shared .ctx editor overlay covers the right band of
  // the stage — same minimal nudge as the Lage map (parity), see lib/panelNudge. Keyed on the
  // selection id only so moving the chip/symbol never re-triggers a pan; the rAF lets the
  // panel mount so its real rect is measured. boardRef's rect already reflects the layout
  // zoom, so an anno's viewport point is a plain lerp over it.
  useEffect(() => {
    if (!selId) return
    const raf = requestAnimationFrame(() => {
      const a = annos.find((x) => x.id === selId)
      const rect = boardRef.current?.getBoundingClientRect()
      const panelEl = document.querySelector('.ctx')
      if (!a || !rect?.width || !panelEl) return
      const r = panelEl.getBoundingClientRect()
      if (!r.width) return // panel present but CSS-hidden — nothing occludes
      // anchored annos (symbol/text/resource) give one point; a draw/area gives its whole
      // vertex set — the box nudge clears the full extent (map parity), capped so an
      // extent wider than the open area never slides fully off the stage.
      const norm: [number, number][] = a.pts?.length ? a.pts : a.x != null && a.y != null ? [[a.x, a.y]] : []
      if (!norm.length) return
      const pts = norm.map(([px, py]) => ({ x: rect.left + px * rect.width, y: rect.top + mapY(a.floor, py) * rect.height }))
      const box = {
        minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
      }
      // phone bottom sheet → nudge up; desktop/tablet side panel → nudge left
      const nudge = isBottomSheet(r.width, window.innerWidth)
        ? panelNudgeBoxUp(box, { top: r.top })
        : panelNudgeBox(box, { left: r.left, top: r.top, bottom: r.bottom })
      if (nudge) applyView(scaleRef.current, { x: posRef.current.x - nudge[0], y: posRef.current.y - nudge[1] })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId])

  // report the current view centre (tile-local x/y + floor) upward so the journal
  // composer can pin an entry to "here" on the plan. Cheap — just a ref write.
  useEffect(() => {
    if (!fit.w || !fit.h) return
    const s = scaleRef.current, w = fit.w * s, h = fit.h * s
    const nx = clamp01((w / 2 - pos.x) / w), ny = clamp01((h / 2 - pos.y) / h)
    const floor = stack ? floorAt(ny) : 0
    onView({ x: nx, y: stack ? localY(ny, floor) : ny, floor })
  }, [pos, scale, fit.w, fit.h, activeId, stack, N]) // eslint-disable-line react-hooks/exhaustive-deps

  // a Verlauf row asked to revisit a plan point. Apply once per request (tracked
  // by nonce); if it arrives mid mode-switch before the stage is measured, the
  // fit deps re-run this once fit lands. Declared after the activeId reset effect
  // so it wins when both fire in the same render.
  const appliedFocus = useRef(0)
  useEffect(() => {
    if (!focus || focus.nonce === appliedFocus.current || !fit.w || !fit.h) return
    setTool('pan'); if (focus.annoId) setSelId(focus.annoId)
    centerOnPoint(focus.x, focus.y, focus.floor)
    appliedFocus.current = focus.nonce
  }, [focus, fit.w, fit.h]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSymbol = (name: string) => { setPending(name); setPendingShape(null); setTool('symbol'); setPaletteOpen(false); onRecent(name) }
  const pickShape = (kind: ShapeKind) => { setPendingShape(kind); setPending(null); setTool('shape'); setPaletteOpen(false) }
  const selResource = annos.find((a) => a.id === selId && a.kind === 'resource')
  // a selected plan symbol gets the SAME editor as the map (label / fields / notes /
  // count / rotation) — floor is omitted because on the plan it's the tile, not a badge
  const selSymbol = annos.find((a) => a.id === selId && a.kind === 'symbol')
  // a selected stroke / Linie / Fläche — drives the shared DrawEditor (style + presets) panel
  const selDraw = annos.find((a) => a.id === selId && (a.kind === 'draw' || a.kind === 'area'))
  // a selected generic shape — colour via the same ShapeEditor sheet as the Lage map
  const selShape = annos.find((a) => a.id === selId && a.kind === 'shape')


  // removing a storey is frictionless when empty, but a floor that carries any
  // annotation (even a single team trace) must be confirmed before it's dropped
  const removeFloor = async (f: number) => {
    if (readOnly) return
    const hasContent = annos.some((a) => (a.floor ?? 0) === f)
    if (hasContent) {
      const ok = await confirmDialog({
        title: appConfig.copy.whiteboard.removeFloor,
        message: fillTemplate(appConfig.copy.whiteboard.removeFloorConfirm, { floor: floorLabel(f) }),
        confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
      })
      if (!ok) return
    }
    onRemoveFloor(f)
  }

  // footprint draw box per floor tile: fill most of the tile, preserving the
  // building's true aspect (the SVG inside stretches the 0..1 ring to this box).
  // Mirror of lib/footprint · fpBoxFrac (kept here in px for layout).
  const fpBox = (() => {
    if (!stack || !fpView) return null
    const tileH = sH / N
    const availW = sW * 0.9, availH = tileH * 0.82
    let w = availW, hgt = availW * fpView.aspect
    if (hgt > availH) { hgt = availH; w = availH / fpView.aspect }
    return { w, h: hgt }
  })()

  // Flip the Gebäudeview orientation (oriented ⇄ north-up). Re-derives the footprint
  // view and re-glues every floor-stack annotation (x/y, freehand pts, team trails) so
  // they stay on the same real-world spot — see lib/footprint · remapPoint.
  const reorient = () => {
    if (!building?.src?.length || !onReorient || readOnly || !sW || !sH) return
    const fromDeg = viewAngle
    const nextNorthUp = !building.northUp
    const toDeg = nextNorthUp ? 0 : orientDeg
    const view = buildView(building.src, toDeg)
    const layout = { boardW: sW, boardH: sH, floors: N }
    const src = building.src as Ring[]
    const mv = (p: [number, number]): [number, number] => remapPoint(src, fromDeg, toDeg, layout, p)
    const remapped = annos.map((a) => {
      const next: BoardAnno = { ...a }
      if (a.x != null && a.y != null) { const [x, y] = mv([a.x, a.y]); next.x = x; next.y = y }
      if (a.pts) next.pts = a.pts.map(mv)
      if (a.trail) next.trail = a.trail.map((tp) => { const [x, y] = mv([tp.x, tp.y]); return { ...tp, x, y } })
      return next
    })
    commit(remapped) // re-glued annotations go through undo/redo + sync
    onReorient({ ...building, northUp: nextNorthUp, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect })
    emit('building.reorient', { northUp: nextNorthUp, planId: activeId })
  }

  // Viewer-only plan (e.g. PV / documentation PDF): bypass the annotation board entirely and
  // show a plain, natively-scrolling multi-page PDF viewer — no tools, no stitched pan/zoom board.
  if (active?.viewer && active.imageUrl) {
    // .whiteboard is already `position:absolute; inset:0` (a containing block for the
    // absolutely-positioned scroller) — don't override it, or the container collapses to 0 height.
    return (
      <div className="whiteboard">
        <PdfScroller key={active.id} url={planUrl(active.imageUrl)} />
      </div>
    )
  }

  return (
    <div className="whiteboard">
      {/* document + object switching now lives in the global left NavRail; the
          Whiteboard is just the stage + tools */}
      {/* plan canvas + annotation layer */}
      <div className="wb-stage" ref={stageRef}>
        <div
          ref={canvasRef}
          className={`wb-canvas tool-${tool} ${pending || pendingShape ? 'placing' : ''}`}
          onPointerDown={stageDown}
          onPointerMove={stageMove}
          onPointerUp={stageUp}
          onPointerCancel={stageUp}
        >
          <div
            ref={boardRef}
            className={`wb-board ${blank ? 'wb-board-blank' : ''}`}
            style={{ width: sW || undefined, height: sH || undefined, transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y + TOP_INSET / 2}px)` }}
          >
            {stack && building ? (
              floorsTTB.map((f, idx) => (
                <div key={f} className="wb-floor" style={{ top: (idx / N) * sH, height: sH / N, width: sW }}>
                  <div className="wb-floor-label">
                    <span>{floorLabel(f)}</span>
                    {f !== 0 && !readOnly && (
                      <button className="wb-floor-x" title={appConfig.copy.whiteboard.removeFloor} aria-label={appConfig.copy.whiteboard.removeFloor}
                        onPointerDown={(e) => e.stopPropagation()} onClick={() => removeFloor(f)}><Icon id="close" /></button>
                    )}
                  </div>
                  {/* north arrow — drawn on the topmost storey, top-right (mirrors the
                      label); the needle + N point at true north for the auto-rotated footprint */}
                  {idx === 0 && fpView && (
                    <svg viewBox="-6 -8 52 60" className="wb-north-dial" aria-hidden>
                      <title>{appConfig.copy.whiteboard.northTitle}</title>
                      <circle cx="20" cy="24" r="15" className="wb-north-ring" />
                      <g style={{ transform: `rotate(${viewAngle}deg)`, transformOrigin: '20px 24px' }}>
                        <path d="M20 11 L25 26 L20 22 L15 26 Z" className="wb-north-needle" />
                        <text x="20" y="7" className="wb-north-n">{appConfig.copy.whiteboard.northLabel}</text>
                      </g>
                    </svg>
                  )}
                  <div className="wb-floor-fp" style={{ width: fpBox?.w, height: fpBox?.h }}>
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="wb-floor-svg">
                      {(fpView?.rings ?? building.rings ?? [building.ring]).map((ring, ri) => (
                        <polygon key={ri} points={ring.map((p) => `${p[0]},${p[1]}`).join(' ')} vectorEffect="non-scaling-stroke" />
                      ))}
                    </svg>
                  </div>
                </div>
              ))
            ) : osm ? (
              <OsmOutline key={active.id} center={osm.center} radiusM={osm.radiusM} onAspect={setAspect}
                interactive={tool === 'pan' && !readOnly} onPick={onSelectBuilding} />
            ) : blank ? (
              annos.length === 0 && <div className="wb-blank-hint">{appConfig.copy.whiteboard.blankHint}</div>
            ) : (
              <PdfViewport
                key={active.id}
                url={planUrl(active.imageUrl)}
                fitW={fit.w}
                fitH={fit.h}
                scale={scale}
                pos={pos}
                vw={vp.w}
                vh={vp.h}
                onAspect={setAspect}
              />
            )}

            {/* committed drawings */}
            <WbInkLayer annos={annos} draft={draft} draftFloor={draftFloor.current} draftClosed={tool === 'area'} color={color} width={width} dashed={dashed} showTrails={showTrails} mapY={mapY}
              selId={selId} onPickDraw={tool === 'pan' ? drawDown : undefined} />

            {/* line arrowheads · repeated marker letters · free-text label + distance — rendered in
                board px (the ink SVG is stretched 1×1 and would distort them). Same feature set +
                spacing math as the Lage map (markerParamsAlong / —R— rhythm); the metric distance
                read-out now works too, once the plan is calibrated (lib/planScale). One per Linie. */}
            {annos.filter((a) => a.kind === 'draw' && (a.arrow || a.marker || a.label || a.showDistance || hasLineDecor(a)) && (a.pts?.length ?? 0) >= 2).map((a) => {
              const p = a.pts!
              const bpx = p.map(([x, y]) => [x * sW, mapY(a.floor, y) * sH] as [number, number])
              const end = bpx[bpx.length - 1]
              const mid = bpx[Math.floor((bpx.length - 1) / 2)]
              const color = a.color || COLORS[0]
              // arrowhead sized to the line weight (tip at 0,0 = the end point), like a real spitze
              const ahw = Math.max(7, (a.width ?? 5) * 1.7) // half-width
              const ahl = ahw * 2.1 // length back from the tip
              // bearing from a point sampled back along the stroke (stable; the last freehand
              // segment is tiny + jittery), so the head points the way the line actually travels
              const ref = lookbackPoint(bpx, Math.max(ahl, 16))
              const dxr = end[0] - ref[0], dyr = end[1] - ref[1]
              const dlen = Math.hypot(dxr, dyr) || 1
              const ang = Math.atan2(dyr, dxr) * 180 / Math.PI
              // push the tip a little PAST the line's visual end: clear the round cap (~half the
              // stroke width beyond the last vertex), then a few px more so the spitze leads the line
              const fwd = (a.width ?? 5) * 0.6 + 6
              const last: [number, number] = [end[0] + (dxr / dlen) * fwd, end[1] + (dyr / dlen) * fwd]
              const markerPts: [number, number][] = a.marker
                ? (() => { const ps = markerParamsAlong(bpx).map(({ seg, t }) => lerpPoint(bpx[seg], bpx[seg + 1], t)); return ps.length ? ps : [mid] })()
                : []
              // distance read-out (calibrated plans only); falls back to a "calibrate first" nudge
              const distM = a.showDistance ? planMetres(a.pts!) : null
              const labelLines: string[] = []
              if (distM != null) labelLines.push(`${fmtDistance(distM)} · ${hoseLengthHint(distM)}`)
              else if (a.showDistance) labelLines.push(appConfig.copy.whiteboard.scale.needsCalibration)
              if (a.label) labelLines.push(a.label)
              return (
                <Fragment key={`am-${a.id}`}>
                  {a.arrow && (
                    // SVG centred on the end point (viewBox origin (0,0) = svg centre = the path tip).
                    // Centring uses the same translate-pair the markers use (reliable); the head is
                    // rotated by an SVG `transform` on the path about (0,0), so the TIP stays pinned to
                    // the end point at every angle — doing the rotation in CSS on the <svg> instead
                    // would pivot about the box and skew the tip off the line. Tinted to the line colour.
                    <svg className="wb-arrowhead" width="80" height="80" viewBox="-40 -40 80 80" aria-hidden
                      style={{ left: 0, top: 0, color, transform: `translate(${last[0]}px, ${last[1]}px) translate(-50%, -50%)` }}>
                      <path transform={`rotate(${ang})`} d={`M0,0 L${-ahl},${-ahw} L${-ahl},${ahw} Z`} fill="currentColor" />
                    </svg>
                  )}
                  {/* FKS Teilstück fork at the tip (rotated to the line's screen angle) */}
                  {a.teilstueck && (
                    <span className="wb-line-deco" style={{ transform: `translate(${end[0]}px, ${end[1]}px) translate(-50%, -50%)` }}>
                      <TeilstueckFork angleDeg={ang} color={color} width={a.width ?? 5} />
                    </span>
                  )}
                  {/* one combined FKS tag (Leitung-Nr · content · Stockwerk) — anchored just before
                      the tip and draggable (endDx/endDy, normalized) to clear other symbols */}
                  {(a.content || a.lineNo != null || a.floorTag != null) && (() => {
                    const pe = bpx[bpx.length - 1]
                    const pp = bpx[bpx.length - 2] ?? pe
                    const ax = pp[0] + (pe[0] - pp[0]) * 0.72 + (a.endDx ?? 0) * sW
                    const ay = pp[1] + (pe[1] - pp[1]) * 0.72 + (a.endDy ?? -0.02) * sH
                    return (
                      <span className="wb-line-deco draggable" style={{ transform: `translate(${ax}px, ${ay}px) translate(-50%, -50%)`, cursor: tool === 'pan' ? 'move' : undefined }}
                        onPointerDown={tool === 'pan' ? (e) => labelDown(e, a.id, a.endDx ?? 0, a.endDy ?? -0.02, 'end') : undefined}
                        onPointerMove={tool === 'pan' ? labelMove : undefined}
                        onPointerUp={tool === 'pan' ? labelUp : undefined}
                        onPointerCancel={tool === 'pan' ? labelUp : undefined}>
                        <EndTag lineNo={a.lineNo} content={a.content} floorTag={a.floorTag} color={color} />
                      </span>
                    )
                  })()}
                  {markerPts.map((mp, i) => (
                    <span key={`mk-${i}`} className="wb-line-marker" style={{ left: 0, top: 0, color, transform: `translate(${mp[0]}px, ${mp[1]}px) translate(-50%, -50%)` }}>{a.marker}</span>
                  ))}
                  {labelLines.length > 0 && (
                    <span className="wb-line-label" style={{ left: 0, top: 0, transform: `translate(${mid[0] + (a.labelDx ?? 0) * sW}px, ${mid[1] + (a.labelDy ?? 0) * sH}px) translate(-50%, -100%)`, cursor: tool === 'pan' ? 'move' : undefined }}
                      onPointerDown={tool === 'pan' ? (e) => labelDown(e, a.id, a.labelDx ?? 0, a.labelDy ?? 0) : undefined}
                      onPointerMove={tool === 'pan' ? labelMove : undefined}
                      onPointerUp={tool === 'pan' ? labelUp : undefined}
                      onPointerCancel={tool === 'pan' ? labelUp : undefined}>{labelLines.map((t, j) => <div key={j}>{t}</div>)}</span>
                  )}
                </Fragment>
              )
            })}

            {/* area (Sektor/Abschnitt) labels — a labelled area renders its free text at the polygon
                centroid in board px (the 1×1 ink SVG would distort text). Draggable like a line label. */}
            {annos.filter((a) => a.kind === 'area' && a.label && (a.pts?.length ?? 0) >= 3).map((a) => {
              const bpx = a.pts!.map(([x, y]) => [x * sW, mapY(a.floor, y) * sH] as [number, number])
              const cx = bpx.reduce((s, q) => s + q[0], 0) / bpx.length
              const cy = bpx.reduce((s, q) => s + q[1], 0) / bpx.length
              return (
                <span key={`al-${a.id}`} className="wb-line-label wb-area-label"
                  style={{ left: 0, top: 0, transform: `translate(${cx + (a.labelDx ?? 0) * sW}px, ${cy + (a.labelDy ?? 0) * sH}px) translate(-50%, -50%)`, cursor: tool === 'pan' ? 'move' : undefined }}
                  onPointerDown={tool === 'pan' ? (e) => labelDown(e, a.id, a.labelDx ?? 0, a.labelDy ?? 0) : undefined}
                  onPointerMove={tool === 'pan' ? labelMove : undefined}
                  onPointerUp={tool === 'pan' ? labelUp : undefined}
                  onPointerCancel={tool === 'pan' ? labelUp : undefined}>{a.label}</span>
              )
            })}

            {/* Maßstab: node preview (board px) — the tapped reference endpoint(s) + segment */}
            {tool === 'scale' && (calNodes.length > 0 || calPrompt) && (() => {
              const pair = calPrompt ? [calPrompt.a, calPrompt.b] : calNodes
              return (
                <svg className="wb-cal-line" width={sW} height={sH} style={{ left: 0, top: 0 }} aria-hidden>
                  {pair.length >= 2 && <line x1={pair[0][0] * sW} y1={pair[0][1] * sH} x2={pair[1][0] * sW} y2={pair[1][1] * sH} />}
                  {pair.map((p, i) => <circle key={i} cx={p[0] * sW} cy={p[1] * sH} r={6} />)}
                </svg>
              )
            })()}

            {/* Messen: the measurement polyline / area (board px) + draggable nodes + cumulative
                labels — the Plan twin of the Lage map's measure tool, scaled by the calibration. */}
            {tool === 'measure' && measPath.length > 0 && (
              <>
                <svg className="wb-meas-svg" width={sW} height={sH} style={{ left: 0, top: 0 }} aria-hidden>
                  {measMode === 'area' && measPath.length >= 3
                    ? <polygon points={measPath.map((p) => `${p[0] * sW},${p[1] * sH}`).join(' ')} className="wb-meas-fill" />
                    : measPath.length >= 2 && <polyline points={measPath.map((p) => `${p[0] * sW},${p[1] * sH}`).join(' ')} className="wb-meas-stroke" fill="none" />}
                </svg>
                {/* insert "+" at each segment midpoint */}
                {measPath.length >= 2 && measPath.map((p, i) => {
                  if (measMode === 'line' && i === measPath.length - 1) return null
                  const b = measPath[(i + 1) % measPath.length]
                  return (
                    <button key={`mi-${i}`} className="wb-vins" title={appConfig.copy.whiteboard.insertVertex} aria-label={appConfig.copy.whiteboard.insertVertex}
                      style={{ left: 0, top: 0, transform: `translate(${((p[0] + b[0]) / 2) * sW}px, ${((p[1] + b[1]) / 2) * sH}px) translate(-50%, -50%)` }}
                      onPointerDown={(e) => measInsert(i, e)}><Icon id="plus" /></button>
                  )
                })}
                {/* draggable nodes (double-tap to delete) + cumulative-distance labels */}
                {measPath.map((p, i) => {
                  const cum = calibrated && i > 0 ? pathMetres(measMpts.slice(0, i + 1), activeScale!.mPerU, measureAR) : null
                  return (
                    <Fragment key={`mn-${i}`}>
                      {/* positioning wrapper so the handle's :active scale never clobbers the
                          board-px placement (mirrors how the map nests the handle in a Marker) */}
                      <div className="wb-meas-node" style={{ left: 0, top: 0, transform: `translate(${p[0] * sW}px, ${p[1] * sH}px) translate(-50%, -50%)` }}>
                        <button className="measure-handle" title={appConfig.copy.measure.deleteNode} aria-label={appConfig.copy.measure.deleteNode}
                          onPointerDown={(e) => { measPress.press(() => measDelete(i)).onPointerDown(e); measNodeDown(i, e) }}
                          onDoubleClick={(e) => { e.stopPropagation(); measDelete(i) }} />
                      </div>
                      {measMode === 'line' && cum != null && (
                        <span className="wb-line-label wb-meas-label" style={{ left: 0, top: 0, transform: `translate(${p[0] * sW}px, ${p[1] * sH}px) translate(-50%, -150%)` }}>{fmtDistance(cum)}</span>
                      )}
                    </Fragment>
                  )
                })}
                {/* area: total at the centroid */}
                {measMode === 'area' && calibrated && measPath.length >= 3 && (() => {
                  const cx = measPath.reduce((s, q) => s + q[0], 0) / measPath.length
                  const cy = measPath.reduce((s, q) => s + q[1], 0) / measPath.length
                  return <span className="wb-line-label wb-meas-label" style={{ left: 0, top: 0, transform: `translate(${cx * sW}px, ${cy * sH}px) translate(-50%, -50%)` }}>{fmtArea(measAreaM2)}</span>
                })()}
              </>
            )}

            {/* vertex editing for a selected line/area — node drag / insert / delete (one shared
                code path for Linie + Fläche). Skipped for a many-point freehand stroke, where
                per-node handles would be unusable (mirrors the map's vertex-handle cap). */}
            {selDraw && tool === 'pan' && (selDraw.kind === 'area' || (selDraw.pts?.length ?? 99) <= MAX_VERTEX_HANDLES) && (
              <WbVertexHandles anno={selDraw} sW={sW} sH={sH} mapY={mapY}
                onVertexDown={vertDown} onInsert={insertVertex} onDeleteVertex={deleteVertex} />
            )}

            {/* point annotations: symbol / text / resource */}
            {annos.filter((a) => a.kind !== 'draw').map((a) => (
              <div
                key={a.id}
                className={`wb-anno wb-${a.kind} ${selId === a.id || selIds.includes(a.id) ? 'sel' : ''}`}
                // transform positions the anchor at the (scaled) plan point. Symbols
                // and text scale WITH the plan via numeric sizing below (crisp, since
                // the board is layout-scaled); team pills stay a constant size.
                style={{ left: 0, top: 0, transform: `translate(${(a.x ?? 0) * sW}px, ${mapY(a.floor, a.y ?? 0) * sH}px) translate(-50%, -50%)`, ['--gpx' as string]: `${a.kind === 'shape' ? (a.sizeN ?? 0.1) * sW : symBase * scale}px` }}
                onPointerDown={(e) => chipDown(e, a.id)}
                onDoubleClick={(e) => { if ((a.kind === 'text' || a.kind === 'resource') && tool === 'pan') { e.stopPropagation(); setEditId(a.id); setSelId(a.id) } }}
              >
                {/* selection halo — the same accent ring the Lage map draws, so a selected
                    symbol/shape reads identically on the plan (teams keep their own team-colour ring) */}
                {(selId === a.id || selIds.includes(a.id)) && (a.kind === 'symbol' || a.kind === 'shape') && <div className="sel-halo" />}
                {a.kind === 'symbol' && (() => {
                  // same renderer as the Lage map — so the plan symbol gets the white
                  // legibility chip, rotation, and count badge identically. (Floor is
                  // encoded by the tile here, so no floor badge is passed.)
                  // the generic vehicle bakes its name + heading into the glyph (text
                  // stays upright), so its body rotation is in the SVG, not the chip.
                  const veh = isVehicleSym(a)
                  const gross = isGrossluefter(a)
                  const svg = veh ? vehicleSymbolSvg(a.label ?? '', a.rotation ?? 0)
                    : gross ? (sym.byName[GROSSLUEFTER_BODY] ?? '')
                    : (placardSvgForSymbol(a.symbol, a.fields) ?? (a.symbol ? sym.byName[a.symbol] ?? '' : ''))
                  // the Grosslüfter stacks the fan as a separately-rotatable overlay (airflow direction)
                  const overlay = gross ? { svg: sym.byName[GROSSLUEFTER_FAN] ?? '', rotation: a.rotation2 ?? 0, scale: FAN_OVERLAY_SCALE } : undefined
                  return (
                    <TacticalSymbol
                      svg={svg}
                      sizePx={symBase * scale}
                      rotation={veh ? 0 : (a.rotation ?? 0)}
                      overlay={overlay}
                      floorFrom={a.floorFrom}
                      floorTo={a.floorTo}
                      spread={a.spread}
                      count={a.count}
                      // vehicles bake their name into the glyph already, so they get no caption
                      caption={!veh ? symbolCaptionText(a, captionMode) : null}
                      className="ts-plan"
                    />
                  )
                })()}
                {a.kind === 'shape' && (
                  // same glyphs + sizing model as the map: the silhouette scales with the
                  // plan (sizeN × plan width) and rotates as a whole
                  <div className="shape-glyph" style={{ width: (a.sizeN ?? 0.1) * sW, height: (a.sizeN ?? 0.1) * sW, transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    <ShapeGlyph kind={a.shape ?? 'square'} color={a.color ?? '#1f6feb'} />
                  </div>
                )}
                {a.kind === 'text' && (
                  editId === a.id
                    ? <input className="wb-text-input" ref={focusOnce} value={a.text} placeholder={appConfig.copy.whiteboard.textPlaceholder} style={{ fontSize: txtBase * scale }}
                        onPointerDown={(e) => e.stopPropagation()}
                        // stream each keystroke live into the note (silent — checkpoint once on the
                        // first edit), so the text shows as you type and the note never vanishes
                        onChange={(e) => { if (textEditId.current !== a.id) { textEditId.current = a.id; pushPast() } patch(a.id, { text: e.target.value }) }}
                        // finalise on blur: keep the note even if empty (a placed note must persist,
                        // mirroring the Lage map) and record one audit edit for the whole session
                        onBlur={(e) => { setEditId(null); if (textEditId.current === a.id) { textEditId.current = null; emit('board.edit', { id: a.id, patch: { text: e.target.value }, planId: activeId }) } }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                    : <span className="wb-text-label" style={{ fontSize: txtBase * scale }}>{a.text || appConfig.copy.whiteboard.text}</span>
                )}
                {a.kind === 'resource' && (() => {
                  // a chip linked to a Trupp that's been marked «raus» (Atemschutz board)
                  // dims + strikes through, so the plan reflects that the team is out.
                  const isRaus = !!a.truppId && trupps.some((t) => t.id === a.truppId && t.status === 'raus')
                  return (
                  <span className={`wb-resource-pill ${isRaus ? 'raus' : ''}`} style={{ '--team': a.color || TEAM_COLORS[0] } as React.CSSProperties}>
                    <span className="wb-resource-cap" />
                    {editId === a.id
                      ? <input className="wb-resource-input" ref={focusOnce} defaultValue={a.text}
                          onPointerDown={(e) => e.stopPropagation()}
                          onBlur={(e) => { patchCommit(a.id, { text: e.target.value || a.text }); setEditId(null) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                      : <b>{a.text}</b>}
                    {isRaus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
                    <i className="wb-resource-time">{a.t}</i>
                  </span>
                  )
                })()}
                {/* selected team — one tidy action bar under the pill instead of two
                    corner orbs. Delete is locked once the team has a recorded trail. */}
                {a.kind === 'resource' && selId === a.id && tool === 'pan' && !readOnly && (
                  <div className="wb-pill-acts" onPointerDown={(e) => e.stopPropagation()}>
                    {/* rename — the touch path (double-tap→dblclick is unreliable on iOS) */}
                    <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit} onClick={() => setEditId(a.id)}><Icon id="pen" /></button>
                    {a.truppId && onShowTrupp && (
                      <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp} onClick={() => onShowTrupp(a.truppId!)}><Icon id="warn" /></button>
                    )}
                    <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition} onClick={markPosition}><Icon id="flag" /></button>
                    {/* trail visibility toggle (mirrors the rail's Spuren eye) — deletion of the
                        record itself lives behind the lock's confirmed clear, never one tap */}
                    {(a.trail?.length ?? 0) > 0 && (
                      <button className="wb-pa" title={showTrails ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
                        aria-label={appConfig.copy.whiteboard.trails} aria-pressed={showTrails} onClick={() => setShowTrails((v) => !v)}>
                        <Icon id={showTrails ? 'eye' : 'eyeoff'} />
                      </button>
                    )}
                    {teamLocked(a)
                      ? <button className="wb-pa wb-pa-lock" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked} onClick={() => void clearTrail()}><Icon id="lock" /></button>
                      : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={() => remove(a.id)}><Icon id="trash" /></button>}
                  </div>
                )}
                {a.kind !== 'resource' && selId === a.id && tool === 'pan' && !readOnly && (
                  <button className="wb-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onPointerDown={(e) => e.stopPropagation()} onClick={() => removeAnno(a)}><Icon id="close" /></button>
                )}
                {/* selected text note: explicit edit handle so touch can re-enter editing */}
                {a.kind === 'text' && editId !== a.id && selId === a.id && tool === 'pan' && !readOnly && (
                  <button className="wb-edit" title={appConfig.copy.edit} aria-label={appConfig.copy.edit} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setEditId(a.id) }}><Icon id="pen" /></button>
                )}
                {/* generic shape: tethered rotor knob + corner resize grip, identical to the
                    Lage map — both rotate with the shape so the handles stay attached */}
                {a.kind === 'shape' && selId === a.id && tool === 'pan' && !readOnly && (
                  <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    <span className="shape-stem" />
                    <button className="handle shape-rotate" title={appConfig.copy.shapes.rotateHint} aria-label={appConfig.copy.shapes.rotateHint}
                      onPointerDown={(e) => rotDown(e, a.id)} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                      <Icon id="rotate" />
                    </button>
                    <button className="handle shape-resize" title={appConfig.copy.shapes.resizeHint} aria-label={appConfig.copy.shapes.resizeHint}
                      onPointerDown={(e) => rotDown(e, a.id, 'resize')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                      <Icon id="resize" />
                    </button>
                  </div>
                )}
                {/* directional symbol: tethered rotor knob (rotate-only), identical to
                    the Lage map — rotates with the symbol so the handle stays attached */}
                {isRotatableSym(a) && !isGrossluefter(a) && selId === a.id && tool === 'pan' && !readOnly && (
                  <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    <span className="shape-stem" />
                    <button
                      className="handle shape-rotate"
                      title={appConfig.copy.shapes.rotateHint}
                      aria-label={appConfig.copy.shapes.rotateHint}
                      onPointerDown={(e) => rotDown(e, a.id)}
                      onPointerMove={rotMove}
                      onPointerUp={rotUp}
                      onPointerCancel={rotUp}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Icon id="rotate" />
                    </button>
                  </div>
                )}
                {/* composite Grosslüfter: two rotors — blue body knob (short) + amber fan knob (long) */}
                {isGrossluefter(a) && selId === a.id && tool === 'pan' && !readOnly && (
                  <>
                    <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                      <span className="shape-stem" />
                      <button className="handle shape-rotate" title={appConfig.copy.contextPanel.rotationVehicle} aria-label={appConfig.copy.contextPanel.rotationVehicle}
                        onPointerDown={(e) => rotDown(e, a.id, 'rotate')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="rotate" />
                      </button>
                    </div>
                    <div className="shape-rotor shape-rotor-fan" style={{ transform: `rotate(${a.rotation2 ?? 0}deg)` }}>
                      <span className="shape-stem" />
                      <button className="handle shape-rotate shape-rotate-fan" title={appConfig.copy.contextPanel.rotationFan} aria-label={appConfig.copy.contextPanel.rotationFan}
                        onPointerDown={(e) => rotDown(e, a.id, 'rotate2')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="rotate" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* trail breadcrumbs — a constant-size dot + timestamp at each RECORDED
                position, so the trail reads as a time-stamped log at a glance */}
            {showTrails && annos.filter((a) => a.kind === 'resource').flatMap((a) =>
              (a.trail ?? []).map((p, i) => (
                <div
                  key={`dot-${a.id}-${i}`}
                  className={`wb-trail-dot ${selId === a.id ? 'sel' : ''}`}
                  style={{ transform: `translate(${p.x * sW}px, ${mapY(p.floor ?? a.floor, p.y) * sH}px) translate(-50%, -50%)` }}
                >
                  <span className="wb-trail-mark" style={{ background: a.color || COLORS[0] }} />
                  <i>{p.t}</i>
                </div>
              )),
            )}

            {/* marquee group (≥2): one move grip + delete at the combined centre — parity
                with the Lage map. Works while either Auswahl or Mehrfach is active. */}
            {groupCentroid && (tool === 'pan' || tool === 'lasso') && (
              <div className="wb-group-acts" style={{ transform: `translate(${groupCentroid.x * sW}px, ${groupCentroid.y * sH}px) translate(-50%, -50%)` }} onPointerDown={(e) => e.stopPropagation()}>
                <button className="wb-pa wb-pa-move" title={appConfig.copy.drawingEditor.move} aria-label={appConfig.copy.drawingEditor.move}
                  onPointerDown={grpDown} onPointerMove={grpMove} onPointerUp={grpUp} onPointerCancel={grpUp} onClick={(e) => e.stopPropagation()}><Icon id="move" /></button>
                <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={deleteGroup}><Icon id="trash" /></button>
              </div>
            )}

            {/* create-tool capture layer */}
            {creating && (
              <div className="wb-ink" onPointerDown={inkDown} onPointerMove={inkMove} onPointerUp={inkUp} onPointerCancel={inkUp} />
            )}
            {/* add a storey above (OG) / below (UG) — attached to the stack itself, just above
                the top floor and below the bottom floor, like a real building section */}
            {stack && !readOnly && (
              <>
                <button className="wb-floor-add wb-floor-add-up" onPointerDown={(e) => e.stopPropagation()} onClick={() => onAddFloor(1)} title={appConfig.copy.whiteboard.addFloorUp}><Icon id="plus" />OG</button>
                <button className="wb-floor-add wb-floor-add-down" onPointerDown={(e) => e.stopPropagation()} onClick={() => onAddFloor(-1)} title={appConfig.copy.whiteboard.addFloorDown}><Icon id="plus" />UG</button>
              </>
            )}
          </div>

          {/* floating zoom — only when the tool rail is hidden (viewers / phone); with the
              rail present, zoom/fit lives in its pinned footer (mirrors the map's ToolRail) */}
          {readOnly && (
            <div className="wb-zoom wb-zoom-float" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => zoom(1 / 1.3)} disabled={scale <= 1} title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut}><Icon id="minus" /></button>
              <span>{Math.round(scale * 100)}%</span>
              <button onClick={() => zoom(1.3)} disabled={scale >= 6} title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn}><Icon id="plus" /></button>
              <button className="wb-fit" onClick={() => applyView(1, { x: 0, y: 0 })} disabled={scale === 1 && pos.x === 0 && pos.y === 0} title={appConfig.copy.nav.fit}>{appConfig.copy.whiteboard.fit}</button>
            </div>
          )}

        </div>

        {!readOnly && <WbToolDocks
          tool={tool}
          lineMode={lineMode}
          color={color}
          width={width}
          dashed={dashed}
          draftActive={draftActive}
          selResource={selResource}
          setTool={setTool}
          setLineMode={setLineMode}
          setColor={setColor}
          setWidth={setWidth}
          setDashed={setDashed}
          onFinish={finishShape}
          onCancelDraft={cancelShape}
          recolorTeam={recolorTeam}
          trailsShown={showTrails}
          onToggleTrails={() => setShowTrails((v) => !v)}
          measMode={measMode}
          setMeasMode={setMeasMode}
          measCount={measPath.length}
          onMeasClear={() => setMeasPath(() => [])}
          onMeasClose={() => { measReset(); setTool('pan') }}
        />}
      </div>

      {/* in-progress marquee box (client coords → fixed positioning) */}
      {marquee && (
        <div
          className="wb-marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {/* tool rail — the SAME shared <ToolRail> the Lage map renders; hidden for viewers
          and on phones (read-only plan view), mirroring the map's gating. Undo/redo and
          Leeren are gone: history is global (TopBar), bulk-remove is Mehrfach + delete. */}
      {!readOnly && (
        <ToolRail
          className="wb-tools"
          primary={{ id: 'symbol', icon: appConfig.copy.primarySymbol.icon, label: appConfig.copy.whiteboard.symbol }}
          tools={appConfig.copy.planTools}
          active={tool}
          toolRefs={toolBtn}
          onPick={(id) => {
            if (id === 'symbol') { setTool('symbol'); setPaletteOpen(true); return }
            setTool(tool === id ? 'pan' : (id as BoardTool)); setPending(null)
          }}
          extras={
            <button className={`vrail-tool ${showTrails ? 'on' : ''}`} title={showTrails ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
              aria-label={appConfig.copy.whiteboard.trails} aria-pressed={showTrails}
              onClick={() => setShowTrails((v) => !v)}>
              <span className="vrail-glyph"><Icon id={showTrails ? 'eye' : 'eyeoff'} /></span><span className="vrail-label">{appConfig.copy.whiteboard.trails}</span>
            </button>
          }
          footer={
            <>
              <button className="vrail-nbtn" title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut} disabled={scale <= 1} onClick={() => zoom(1 / 1.3)}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomOut}</span></button>
              <button className="vrail-nbtn" title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn} disabled={scale >= 6} onClick={() => zoom(1.3)}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomIn}</span></button>
              <button className="vrail-nbtn" title={appConfig.copy.nav.fit} aria-label={appConfig.copy.nav.fit} disabled={scale === 1 && pos.x === 0 && pos.y === 0} onClick={() => applyView(1, { x: 0, y: 0 })}><span className="vrail-glyph"><Icon id="cross" /></span><span className="vrail-label">{appConfig.copy.nav.fit}</span></button>
              {/* Gebäude orientation toggle — only on a floor-stack that was auto-rotated */}
              {canOrient && (
                <>
                  <div className="vrail-sep vrail-sep-foot" />
                  <button
                    className={`vrail-nbtn ${building?.northUp ? 'on' : ''}`}
                    title={building?.northUp ? appConfig.copy.whiteboard.orientLongAxis : appConfig.copy.whiteboard.orientNorthUp}
                    aria-label={building?.northUp ? appConfig.copy.whiteboard.orientLongAxis : appConfig.copy.whiteboard.orientNorthUp}
                    aria-pressed={!!building?.northUp}
                    onClick={reorient}
                  ><span className="vrail-glyph"><Icon id="compass" /></span><span className="vrail-label">{building?.northUp ? appConfig.copy.whiteboard.orientLongAxis : appConfig.copy.whiteboard.orientNorthUp}</span></button>
                </>
              )}
              <div className="vrail-zoom-pct">{Math.round(scale * 100)}%</div>
            </>
          }
        />
      )}

      {pending && tool === 'symbol' && (
        <div className="wb-hint">{fillTemplate(appConfig.copy.whiteboard.placeSymbolHint, { name: formatSymbolName(pending) })}
          <button className={`wb-hint-tog ${placeLock ? 'on' : ''}`} aria-pressed={placeLock} title={appConfig.copy.keepPlacing} aria-label={appConfig.copy.keepPlacing} onClick={() => setPlaceLock((v) => !v)}><Icon id="lock" /></button>
          <button onClick={() => { setPending(null); setTool('pan') }}>{appConfig.copy.cancel}</button>
        </div>
      )}

      {pendingShape && tool === 'shape' && (
        <div className="wb-hint">{fillTemplate(appConfig.copy.whiteboard.placeSymbolHint, { name: appConfig.copy.shapes.names[pendingShape] ?? appConfig.copy.shapes.kindLabel })}
          <button className={`wb-hint-tog ${placeLock ? 'on' : ''}`} aria-pressed={placeLock} title={appConfig.copy.keepPlacing} aria-label={appConfig.copy.keepPlacing} onClick={() => setPlaceLock((v) => !v)}><Icon id="lock" /></button>
          <button onClick={() => { setPendingShape(null); setTool('pan') }}>{appConfig.copy.cancel}</button>
        </div>
      )}



      {/* selected-symbol editor — the SAME ContextPanel the Lage map uses, so a plan
          symbol now exposes label / fields / notes / count / rotation identically */}
      {/* rendered in read-only too (viewer / EL view): tapping a plan symbol shows its
          details; the readOnly prop strips every edit affordance inside the panel. */}
      {selSymbol && tool === 'pan' && (
        <ContextPanel
          key={selSymbol.id}
          entity={selSymbol}
          readOnly={readOnly}
          svg={selSymbol.symbol ? sym.byName[selSymbol.symbol] ?? '' : ''}
          onClose={() => setSelId(null)}
          onTitle={(v) => patchCommit(selSymbol.id, { label: v })}
          onFields={(fields) => patchCommit(selSymbol.id, { fields })}
          onNotes={(v) => patchCommit(selSymbol.id, { notes: v || undefined })}
          onFloorFrom={(f) => patchCommit(selSymbol.id, { floorFrom: f ?? undefined })}
          onFloorTo={(f) => patchCommit(selSymbol.id, { floorTo: f ?? undefined })}
          onSpread={(s) => patchCommit(selSymbol.id, { spread: s ?? undefined })}
          onCount={(n) => patchCommit(selSymbol.id, { count: n && n > 1 ? n : undefined })}
          onRotate={(deg) => patchCommit(selSymbol.id, { rotation: deg ?? undefined })}
          onRotate2={(deg) => patchCommit(selSymbol.id, { rotation2: deg ?? undefined })}
          onCaption={(m) => patchCommit(selSymbol.id, { caption: m ?? undefined })}
          controls={symbolControls(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
          titleOptions={symbolTitleOptions(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
          fieldOptions={symbolFieldOptions(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat, rosterNames)}
          rosterRank={rosterRank}
          protectedKeys={new Set(symbolPresetFieldKeys(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat))}
          onDelete={() => remove(selSymbol.id)}
        />
      )}

      {/* selected stroke / Linie / Fläche editor — the SAME shared DrawEditor the Lage map uses, so a
          plan line/area exposes the line presets (Freihand/Messpfeil/Rettungsachse) + colour / width /
          style / label / marker / arrow identically. Distance is omitted (a plan has no metric scale). */}
      {!readOnly && selDraw && tool === 'pan' && (
        <DrawEditor
          key={selDraw.id}
          drawing={{ kind: selDraw.kind as 'draw' | 'area', color: selDraw.color, width: selDraw.width, dashed: selDraw.dashed, label: selDraw.label, marker: selDraw.marker, arrow: selDraw.arrow, showDistance: selDraw.showDistance, fillOpacity: selDraw.fillOpacity, teilstueck: selDraw.teilstueck, content: selDraw.content, lineNo: selDraw.lineNo, floorTag: selDraw.floorTag }}
          pointCount={selDraw.pts?.length ?? 0}
          /* the distance toggle appears once the plan is calibrated against its printed scale bar */
          supportsDistance={calibrated}
          onPreset={(presetId) => {
            setLinePreset(presetId)
            const p = linePresetPatch(presetId) // identical bundle + field-mapping to the Lage map
            patchCommit(selDraw.id, { arrow: p.arrow || undefined, marker: p.marker || undefined, showDistance: p.showDistance || undefined, dashed: p.dashed ?? selDraw.dashed })
          }}
          onColor={(c) => patchCommit(selDraw.id, { color: c })}
          onWidth={(w) => patchCommit(selDraw.id, { width: w })}
          onDashed={(d) => patchCommit(selDraw.id, { dashed: d })}
          onLabel={(label) => patchCommit(selDraw.id, { label: label || undefined })}
          onMarker={(marker) => patchCommit(selDraw.id, { marker: marker || undefined })}
          onArrow={(arrow) => patchCommit(selDraw.id, { arrow: arrow || undefined })}
          onEnding={(ending) => patchCommit(selDraw.id, { arrow: ending === 'arrow' || undefined, teilstueck: ending === 'teilstueck' || undefined })}
          onContent={(content) => patchCommit(selDraw.id, { content })}
          onLineNo={(lineNo) => patchCommit(selDraw.id, { lineNo })}
          onFloorTag={(floorTag) => patchCommit(selDraw.id, { floorTag })}
          onShowDistance={(showDistance) => patchCommit(selDraw.id, { showDistance: showDistance || undefined })}
          onRadius={() => {}}
          onFillOpacity={(fillOpacity) => patchCommit(selDraw.id, { fillOpacity })}
          onDelete={() => removeAnno(selDraw)}
          onClose={() => setSelId(null)}
        />
      )}

      {/* selected-shape editor — the SAME colour sheet as the Lage map (size + rotation
          live on the canvas handles). Read-only surfaces just show the selection halo. */}
      {!readOnly && selShape && tool === 'pan' && (
        <ShapeEditor
          key={selShape.id}
          entity={selShape}
          onColor={(c) => patchCommit(selShape.id, { color: c })}
          onScale={(f) => patchCommit(selShape.id, { sizeN: Math.max(0.03, Math.min(0.9, (selShape.sizeN ?? SHAPE_DEFS[selShape.shape ?? 'square'].defaultSizeN) * f)) })}
          onDelete={() => removeAnno(selShape)}
          onClose={() => setSelId(null)}
        />
      )}

      {paletteOpen && sym.ready && (
        <Palette sym={sym} onPick={pickSymbol} onPickShape={pickShape} onClose={() => { setPaletteOpen(false); if (!pending && !pendingShape) setTool('pan') }} />
      )}

      {truppPick && (
        <div className="wb-trupp-scrim" onPointerDown={() => setTruppPick(null)}>
          <div className="wb-trupp-pick" onPointerDown={(e) => e.stopPropagation()}>
            <div className="wb-trupp-pick-head">{appConfig.copy.whiteboard.selectTrupp}</div>
            {trupps.filter((t) => t.status !== 'raus').map((t) => (
              <button
                key={t.id} className="wb-trupp-opt"
                onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor, t); setTruppPick(null) }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {t.lineNumber && <i>Ltg {t.lineNumber}</i>}
              </button>
            ))}
            <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor); setTruppPick(null) }}>
              <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
            </button>
          </div>
        </div>
      )}

      {/* Messen — the SAME panel the Lage map uses (bottom-centred); metrics come from the plan
          calibration (no elevation profile), and it nudges to calibrate until a scale is set. */}
      {tool === 'measure' && (
        <MeasurePanel
          mode={measMode}
          coords={measPath}
          profile={null}
          profileLoading={false}
          showProfile={false}
          metrics={{ lengthM: measLenM, areaM2: measAreaM2, perimeterM: measPerimM }}
          blocked={!calibrated}
          hint={appConfig.copy.whiteboard.scale.needsCalibration}
          onCalibrate={() => setTool('scale')}
          calibrateLabel={appConfig.copy.whiteboard.scale.calibrate}
          recalibrateLabel={appConfig.copy.whiteboard.scale.recalibrate}
        />
      )}

      {/* Maßstab — metre-entry popover after the two reference taps: a clean −/+ stepper */}
      {calPrompt && (() => {
        const step = appConfig.drawing.planScaleStepM
        const val = parseFloat(refMInput) || 0
        const bump = (d: number) => setRefMInput(String(Math.max(0, Math.round((val + d) * 100) / 100)))
        return (
        <div className="wb-trupp-scrim" onPointerDown={closeCalPrompt}>
          <div className="wb-cal-pop" onPointerDown={(e) => e.stopPropagation()}>
            <div className="wb-cal-title">{appConfig.copy.whiteboard.scale.promptTitle}</div>
            <div className="wb-cal-body">{appConfig.copy.whiteboard.scale.promptBody}</div>
            <div className="wb-cal-chips">
              {appConfig.drawing.planScaleDefaultsM.map((m) => (
                <button key={m} className={`wb-cal-chip ${val === m ? 'on' : ''}`} onClick={() => setRefMInput(String(m))}>{m} m</button>
              ))}
            </div>
            <div className="wb-cal-stepper">
              <button className="wb-cal-step" aria-label="−" disabled={val <= 0} onClick={() => bump(-step)}>−</button>
              <div className="wb-cal-num">
                <input className="wb-cal-input" type="number" inputMode="decimal" min={0} step="any" autoFocus value={refMInput}
                  onChange={(e) => setRefMInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitCalibration(val) }} />
                <span className="wb-cal-unit">{appConfig.copy.whiteboard.scale.unit}</span>
              </div>
              <button className="wb-cal-step" aria-label="+" onClick={() => bump(step)}>+</button>
            </div>
            <div className="wb-cal-actions">
              <button className="btn ghost" onClick={closeCalPrompt}>{appConfig.copy.whiteboard.scale.cancel}</button>
              <button className="btn primary" disabled={!(val > 0)} onClick={() => commitCalibration(val)}>{appConfig.copy.whiteboard.scale.confirm}</button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Maßstab — trust chip: shows whether the active plan is calibrated; tap to (re)calibrate.
          Never a hidden assumption — a plan with no scale says so. Hidden for the OSM live outline /
          blank sheet (no printed reference to measure against) and for read-only viewers. */}
      {!readOnly && !osm && !blank && (
        <button
          className={`wb-scale-chip ${calibrated ? 'on' : ''} ${scaleStale ? 'stale' : ''} ${tool === 'scale' ? 'arm' : ''}`}
          title={appConfig.copy.whiteboard.scale.recalibrate}
          onClick={() => setTool(tool === 'scale' ? 'pan' : 'scale')}
        >
          <Icon id="measure" />
          <span>{
            tool === 'scale' ? appConfig.copy.whiteboard.scale.calibrateHint
              : scaleStale ? appConfig.copy.whiteboard.scale.stale
              : calibrated ? fillTemplate(appConfig.copy.whiteboard.scale.chipCalibrated, { m: String(activeScale!.refM) })
              : appConfig.copy.whiteboard.scale.chipUncalibrated
          }</span>
        </button>
      )}
    </div>
  )
}
