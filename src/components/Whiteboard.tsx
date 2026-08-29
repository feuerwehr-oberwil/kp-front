import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConnectRing, NodeDeleteChip } from './NodeDeleteChip'
import type { BoardAnno, BoardPoint, BoardTool, BuildingDoc, CaptionMode, Drawing, Entity, LineAttachment, LineEndpoint, LngLat, NoteSize, PlanDocument, ShapeKind, SrcGeoref, Trupp } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import type { RailLabels } from '../lib/prefs'
import { Icon } from '../lib/icons'
import { Palette } from './Palette'
import { PdfViewport, prewarmPlans } from './PdfViewport'
import { PdfScroller } from './PdfScroller'
import { OsmOutline } from './OsmOutline'
import { appConfig } from '../config/appConfig'
import { resolveLinePreset, markerParamsAlong, lerpPoint, lookbackPoint, rdpIndices, isTapStroke, FREEHAND_SIMPLIFY_PX } from '../lib/lineStyle'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { beginSheetPeek, endSheetPeek } from '../lib/sheetPeek'
import { TeilstueckFork, EndTag, hasLineDecor, lineLabel } from '../lib/lineDecor'
import { truppForLine, truppIsOut, truppLineTone, truppTagText } from '../lib/truppLines'
import { nextTeamName } from '../lib/placedTrupps'
import { fillTemplate, formatSymbolName, formatTime } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { Menu, Overlay } from '../lib/overlays'
import { isBottomSheet, nudgePointIntoRect, nudgeSelectionIntoRect, rectCenter, visibleWorkRect, type NudgeBox } from '../lib/panelNudge'
import { TacticalSymbol, compositeSpec, compositePartGlyph, luefterVariant, isHubretter, HubretterBoom } from '../lib/symbolRender'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { placardSvgForSymbol } from '../lib/placard'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys, symbolCaptionText, ROTATABLE } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import { ContextPanel } from './ContextPanel'
import { DrawEditor } from './DrawEditor'
import { ShapeEditor } from './ShapeEditor'
import { MenuPick } from './MenuPick'
import { LockChip } from './LockChip'
import { ShapeGlyph, SHAPE_DEFS, SHAPE_FREE_ASPECT, shapeAspect } from '../lib/shapes'
import { noteScale, autoNoteWN, clampNoteWN, noteWN } from '../lib/notes'
import { planUrl, TILE_AR, TOP_INSET, STACK_VPAD, sideInsets, clamp01, floorLabel, floorGeometry } from '../lib/whiteboard'
import { advanceDwell, applyRouting, armDwell, attachInsetPx, boundaryPoint, detachProgress, DETACH_SHOW_PROGRESS, EMPTY_DWELL, flipLine, forkPortPoint, incomingAttachments, MAGNET_DWELL_MS, nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget, wouldCreateCycle, type AttachableLine, type DwellState, type MagneticTarget } from '../lib/lineAttachments'
import { polyAreaM2, type PlanScale } from '../lib/planScale'
import { slimTools, PLAN_READONLY_TOOLS } from '../lib/readOnlyTools'
import { isSelectOnlySurface } from '../lib/useObjectPlans'
import { useIsPhone } from '../lib/useIsPhone'
import type { PlanScales } from '../lib/workspace'
import { fmtDistance, fmtArea, hoseLengthHint } from '../lib/geo'
import { buildView, remapPoint, type Ring } from '../lib/footprint'
import { usePlanMeasure } from './usePlanMeasure'
import { PlanScalePrompt, PlanScalePersist } from './PlanScalePrompts'
import { GeorefBoardLayer, GeorefInstrument, GeorefSplitSeam, type PlanViewApi } from './GeorefMode'
import { GeorefQuality } from './GeorefQuality'
import { GeorefTransfer, type GeorefTransferTarget } from './GeorefTransfer'
import { fitSimilarity } from '../lib/georef'
import { georefForPlan, refreshStationPlanScales } from '../lib/stationPlanScale'
import { georefChip, georefDispatch, resetGeorefPlan, setGeorefSaveErrorHandler, startGeorefMode, transferGeorefPlan, useGeorefMode, useGeorefStorage } from '../lib/georefMode'
import { boardDrawingTwins, boardEntityTwins, boardTwins, type BoardTwin } from '../lib/georefTwins'
import { GeorefTwinsBoard } from './GeorefTwinsBoard'
import { GeorefContentBoard } from './GeorefContentBoard'
import { GeorefTwinPanel } from './GeorefTwinPanel'
import { glyphFor, twinName } from '../lib/twinGlyph'
import { MAX_SCALE, MIN_SCALE, boardViewSignature, useBoardView, type BoardViews } from './useBoardView'
import { pushBoardPast, useBoardDoc, type BoardHistory } from './useBoardDoc'
import { useBoardGestures } from './useBoardGestures'
import { WbToolDocks, WbInkLayer, WbVertexHandles, WbDraftHandles } from './WbControls'
import { ToolDock } from './ToolDock'
import { ToolRail } from './ToolRail'

const COLORS = appConfig.drawing.colors

/** Size a note's textarea to its content, so the editable box is exactly as tall as the note it
 *  replaces (no scrollbar, no jump between "editing" and "done"). Height must be reset first —
 *  scrollHeight never shrinks while an explicit height is still set.
 *
 *  The `> 0` guard is load-bearing: at mount the element has not been laid out yet and
 *  scrollHeight reads 0. Writing `height: 0px` collapses the textarea, and a collapsed element
 *  DROPS FOCUS — which showed up as "the note is placed but I can't type into it", with the
 *  keystrokes falling through to the global hotkeys instead. */
function autoGrow(el: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!el || el.tagName !== 'TEXTAREA') return
  el.style.height = 'auto'
  const h = el.scrollHeight
  if (h > 0) el.style.height = `${h}px`
  else el.style.removeProperty('height')
  // Width comes from React (wN) — every note carries one.
}
const TEAM_COLORS = appConfig.drawing.teamColors // distinct accent per team (cycled)
// parity with the Lage map: directional symbols that support drag-to-rotate (set
// derived from the symbol presets, lib/symbols · ROTATABLE), and the generic
// vehicle whose typed name is baked into the glyph (text stays upright).
const isRotatableSym = (a: BoardAnno) => a.kind === 'symbol' && !!a.symbol && ROTATABLE.has(a.symbol)
const isVehicleSym = (a: BoardAnno) => a.kind === 'symbol' && a.symbol === appConfig.symbols.vehicleName
// a composite symbol (Grosslüfter vehicle+fan, Drehleiter/Hubretter body+ladder/boom): a two-handle
// rotor + two-layer render, like the map. Returns the spec (base/part/scale/label) or undefined.
const annoComposite = (a: BoardAnno) => (a.kind === 'symbol' ? compositeSpec(a.symbol) : undefined)

interface Props {
  plans: PlanDocument[]
  activeId: string
  annos: BoardAnno[]
  /** effective per-device symbol-size multiplier selected by the app shell: Modul for a
   *  standalone sheet, Karte once the sheet is georeferenced (lib/prefs · planSymbolScale) */
  symMul?: number
  /** device default for on-canvas symbol captions (lib/prefs · symbolCaptions). The Plan has no
   *  zoom, so captions show whenever the mode is on; the Lage map runs them through its label
   *  pass instead (neither surface zoom-gates them any more). */
  captionMode?: CaptionMode
  /** Entity ids whose captions the source Lage map currently suppresses in its shared label
   *  pass. Their Modul twins must stay captionless too. */
  mapSuppressedCaptions?: ReadonlySet<string>
  onChange: (next: BoardAnno[]) => void
  building: BuildingDoc | null
  /** the picked footprints, their auto-orientation angle, and WHERE that footprint box sits on
   *  the ground — the third is what lets the workspace carry the floor stack across the change
   *  instead of clearing it (lib/buildingTransfer · amendBuilding). */
  onSelectBuilding: (src: [number, number][][], orientDeg: number, geo: SrcGeoref) => void
  /** Step between the two faces of the ONE «Gebäude» rail tile: the live OSM outline picker
   *  (`'pick'`) and the floor stack (`'stack'`). Changing the building is a chip down in the
   *  bottom-left row, beside «Kein Objekt» and «Ref. N m» — not a second rail tile and not a
   *  hidden gesture, because it is a once-an-Einsatz act on a surface whose width IS the plan.
   *  Omitted ⇒ the chip is hidden (nothing to step to). */
  onBuildingFace?: (face: 'pick' | 'stack') => void
  onAddFloor: (dir: 1 | -1) => void
  onRemoveFloor: (floor: number) => void
  /** flip the Gebäudeview between oriented + "Norden oben": persists the re-oriented
   *  building (annotations are re-glued via this component's own commit/undo path). */
  onReorient?: (next: BuildingDoc) => void
  /** viewers can pan/inspect but not mutate plan structure (floors, building) */
  readOnly?: boolean
  /** while read-only, still render the slim tool rail (Auswahl · Messen) — the tools that
   *  change nothing. Off for replay (its scrubber owns the bottom band) and for the phone's
   *  Verlauf sheet, where the plan is parked behind a full-width overlay. */
  slimTools?: boolean
  /** device pref «Leisten-Beschriftung» (lib/prefs · railLabels) — the word under each glyph.
   *  The setting says «in den beiden Leisten», so the plan's rail has to be handed it too. */
  railLabels?: RailLabels
  sym: SymbolsApi
  /** active Mannschaft names feeding the symbol detail comboboxes (Einsatzleiter / Fahrer …) */
  rosterNames?: string[]
  /** name → rank key, for the officer-first sort + "nur Offiziere" filter on leadership symbols */
  rosterRank?: Record<string, string | undefined>
  /** a roster field on a plan symbol («Fahrer», «Name») names somebody who is standing there —
   *  same rule as on the Lage, so the Anwesenheit learns about it from either surface */
  onRosterField?: (symbol: string | undefined, label: string | undefined, key: string, name: string) => void
  /** What is already known about a roster NAME — «unter Atemschutz», «Magazin», «gegangen» —
   *  shown ON the dropdown entry (lib/roleAssignment · personStatusHint). Handed to the plan for
   *  the same reason it is handed to the map: the picker is the moment you learn that the person
   *  you are about to name as Fahrer is under PA, and it read the same on both surfaces or on
   *  neither. Omitted ⇒ plain names. */
  personStatus?: (name: string) => { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined
  /** …and the contradiction a FILLED roster field already carries, per field key (lib/roleAssignment
   *  · roleConflictHint) — printed under the field itself. Same call the Lage makes, just from a
   *  BoardAnno's parts, since a plan symbol is not an Entity. */
  fieldHints?: (symbol: string | undefined, label: string | undefined, fields: Record<string, string> | undefined) => Record<string, string | undefined> | undefined
  onRecent: (name: string) => void
  /** append to the unified journal with plan context (team link, plan coords). */
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  /** symbol placed → App may offer logging it as Mittel (same hook as the Lage map) */
  /** record a plan mutation in the hash-chained audit trail (board.* ops). No-op
   *  default keeps the component usable standalone / in tests. */
  emit?: (op: string, payload?: Record<string, unknown>) => void
  /** expose this plan's per-document undo/redo so the GLOBAL TopBar control can drive
   *  it while the Plan is the active surface (App routes undo/redo by surface). */
  historyRef?: React.MutableRefObject<{ undo: () => void; redo: () => void } | null>
  /** report this plan's can-undo/redo flags up so the TopBar buttons enable correctly. */
  onHistoryState?: (s: { canUndo: boolean; canRedo: boolean }) => void
  /** ⚠️ The plan undo/redo STACKS, held by the caller: this component unmounts on every surface
   *  switch, so history kept in its own state was thrown away the moment you glanced at the
   *  Verlauf. Keyed by plan id, so it stays per-plan-document. See useBoardDoc · BoardHistory. */
  hist: BoardHistory
  setHist: React.Dispatch<React.SetStateAction<BoardHistory>>
  /** ⚠️ The per-plan zoom/pan memory, also held by the caller and for the same reason as `hist`:
   *  a glance at the Lage unmounts this component, and a board that reset to «eingepasst» every
   *  time you looked away is a board you have to re-find your way around on every return. A REF,
   *  not state — the Lage map keeps its live view out of state too, so panning re-renders the
   *  board and nothing above it. Omitted ⇒ every plan opens fitted (see useBoardView · memory). */
  views?: React.MutableRefObject<BoardViews>
  /** expose fit-to-view so the phone top bar can offer Fit instead of a floating cluster. */
  fitRef?: React.MutableRefObject<(() => void) | null>
  /** expose tool-pick + zoom so the global keyboard-shortcut layer (App) can drive the Plan
   *  surface, keeping Lage↔Plan shortcut parity. Semantic tool ids map to Plan tools inside. */
  keysRef?: React.MutableRefObject<{ pickTool: (tool: string) => void; zoom: (f: number) => void } | null>
  /** a Verlauf row asked to revisit a plan point — center + select on arrival. */
  /** `flash` shows the anno (a few-second outline) instead of selecting it — see the focus effect */
  focus: { x: number; y: number; floor: number; annoId?: string; twinEntityId?: string; flash?: boolean; nonce: number } | null
  /** report the current plan-view centre (tile-local). Optional and currently unused: it existed
   *  for the composer's «an der Planmitte anheften», which went away on 14.08. — the Wiedergabe
   *  answers «wie sah es da aus» by scrubbing the whole picture instead of storing a point. */
  onView?: (c: { x: number; y: number; floor: number }) => void
  /** currently monitored Atemschutz Trupps — offered when placing a team chip on the plan. */
  trupps?: Trupp[]
  /** link a placed chip to a tracked Trupp (chip ↔ Trupp; sets the Trupp's annoId/planId). */
  onLinkTrupp?: (annoId: string, truppId: string) => void
  /** jump to the Atemschutz board for a linked Trupp ("show the trupp"). */
  onShowTrupp?: (truppId: string) => void
  /** join this CHIP to an Atemschutz-Trupp — `undefined` lets go of the one it has. The plan twin
   *  of the map marker's «Atemschutz-Trupp» menu (MapMarkers · onTeamTrupp) and routed through the
   *  same action, so the takeover confirm and the «einrücken?» ask exist exactly once
   *  (useTruppActions · adoptTruppMarker / releaseTruppMarker). A chip dropped before anybody was
   *  registered finds its Trupp afterwards, instead of having to be deleted and re-placed — which
   *  on a plan chip would throw away its recorded trail. Absent ⇒ no picker (read-only / locked). */
  onTeamTrupp?: (annoId: string, truppId: string | undefined) => void
  /** recolouring a linked team chip writes the TRUPP's colour (see recolorTeam) */
  onTruppColor?: (truppId: string, color: string) => void
  /** «Leitung wählen» is armed: the next tap on a drawn line reports it here (and links it to the
   *  waiting Trupp) instead of selecting it. Undefined = normal selection. */
  onPickLine?: (annoId: string) => void
  /** «Gehört zu Trupp …» in the line editor — undefined truppId unlinks. Omitted ⇒ row hidden. */
  onLinkLineTrupp?: (annoId: string, truppId: string | undefined) => void
  /** a hose line got a NEW number: the Trupp anchored to it carries a copy of the number (the
   *  AS chip prints it), so the renumber must reach the Trupp too (useTruppActions ·
   *  syncLineNoToTrupp). Fires AFTER the drawing itself was patched. */
  onLineRenumber?: (annoId: string, lineNo: number | undefined) => void
  /** per-Trupp contact-clock tier (atemschutz · AtemschutzAlarmState.severities) — tints the tag
   *  and halo of the Leitung that Trupp works on. Passed in so the 1 Hz clock never reaches this
   *  component (see AtemschutzAlarmHost). */
  truppSeverities?: Record<string, 1 | 2>
  /** the loaded Einsatzobjekt (manual pick or auto-surfaced nearest) — named on the surface,
   *  because it is what decides which plans these are. Null = none resolved yet. */
  objectName?: string | null
  /** the object's street address — what the chip over the plans reads (see objectChip) */
  objectAddress?: string | null
  /** open the PlanPicker. Omitted (an Einsatz-Link, which is bound to one object's plans)
   *  hides the whole control — a read-out nobody may act on is chrome. */
  onObjectSwitch?: () => void
  /** per-plan distance calibration (planId → factor). A plan has no inherent scale; the user
   *  calibrates against a printed scale bar so line lengths read in metres. See lib/planScale. */
  planScale?: PlanScales
  /** persist a plan's calibration (null clears it). Rides the workspace blob via App. */
  onCalibrate?: (planId: string, scale: PlanScale | null) => void
  /** Georeferenz twins — what the Karte lends a georeferenced sheet (lib/georefTwins). Lists are
   *  already filtered by their Ebenen visibility; projection + clipping happen here against the
   *  sheet's measured fit, so content never disagrees with the reference crosses beside it. */
  mapTwins?: { vehicles: Entity[]; symbols: Entity[]; content: Entity[]; drawings: Drawing[] }
  /** tap on a twin → show its source-backed editor */
  onTwinJump?: (entity: Entity) => void
  /** Move the map-owned source onto this plan, preserving its id and offering one-step undo. */
  onTwinTransferHere?: (entity: Entity, planId: string, pt: { x: number; y: number }) => void
  /** Show a plan-owned source at its projected position on the Lage map. */
  onPlanProjection?: (planId: string, annoId: string, coord: LngLat) => void
  /**
   * A projection of a Karte object was dragged on this sheet — move the SOURCE entity there.
   *
   * The coordinate has already been folded back through this sheet's own fit, so the caller
   * writes an ordinary map move: one source of truth, one undo step, one audit event, and
   * trace-routed Leitungen follow exactly as they do when the marker is dragged on the Karte.
   * `phase` mirrors the map's own drag (start ⇒ snapshot for undo, end ⇒ log + emit).
   */
  onTwinMove?: (entityId: string, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  /** Edit the one Karte-owned source through its projection. `live` streams title keystrokes
   *  inside one undo step; `commit` finalises it or applies an ordinary discrete patch. */
  onTwinEdit?: (entityId: string, patch: Partial<Entity>, phase?: 'live' | 'commit') => void
  /** Delete the Karte-owned source through its projection, using the map's normal safeguards. */
  onTwinDelete?: (entityId: string) => boolean | Promise<boolean>
  /** the Ebenen panel is open (it lives in the app shell; the plan only owns the button) */
  layersOn?: boolean
  /** Ebenen button in the rail footer — omitted ⇒ no button, which is the state of every sheet
   *  that has nothing to switch (no georeference ⇒ nothing is lent to it) */
  onToggleLayers?: () => void
}

/**
 * Extra context a Whiteboard action attaches to its journal line — and the ONLY thing that makes
 * the row's chevron able to jump back.
 *
 * ⚠️ Every placement passes `annoId` + `x`/`y` + `floor`. Without them the row carried nothing but
 * the plan document, so «Symbol "Löschleitung" auf Plan gesetzt» opened the Gebäude at whatever
 * floor happened to be showing and selected nothing — the Lage's equivalents have always carried
 * their `entityId` and flown to it, and the Plan's simply did not. Rows written before 23.08. have
 * none of this and degrade to exactly that older behaviour (see IncidentWorkspace · focusEvent).
 */
export interface PlanLogExtra { kind?: 'symbol' | 'team' | 'history'; annoId?: string; x?: number; y?: number; floor?: number }

// Whiteboard / Tafel — pick a plan document as the background, then
// annotate it with draw / text / symbols and place resource chips whose
// timestamp updates each time they are moved. All annotation coordinates are
// normalized 0..1 in plan-image space so they stick across zoom/pan.
export function Whiteboard({ plans, activeId, annos, symMul = 1, captionMode = 'off', mapSuppressedCaptions, onChange, building, onSelectBuilding, onBuildingFace, onReorient, onAddFloor, onRemoveFloor, readOnly: readOnlyProp = false, sym, rosterNames = [], rosterRank, onRosterField, personStatus, fieldHints, onRecent, log, emit = () => {}, historyRef, onHistoryState, hist, setHist, views, fitRef, keysRef, focus, onView, trupps = [], onLinkTrupp, onShowTrupp, onTeamTrupp, onTruppColor, onPickLine, onLinkLineTrupp, onLineRenumber, truppSeverities, objectName, objectAddress, onObjectSwitch, planScale = {}, onCalibrate, mapTwins, onTwinJump, onTwinTransferHere, onPlanProjection, onTwinMove, onTwinEdit, onTwinDelete, layersOn = false, onToggleLayers, slimTools: slimToolsProp = false, railLabels }: Props) {
  const active = plans.find((p) => p.id === activeId) ?? plans[0]
  // The live OSM outline sheet is a SELECTION surface: it exists to pick the building that becomes
  // the Gebäude view, and nothing else — it is the picking FACE of the one «Gebäude» rail tile
  // (lib/useObjectPlans · railPlanTiles). So it carries no drawing apparatus at all —
  // no tool rail, no armable tool, no dock, no draw-on-tap; the footprint tap is the one thing
  // that happens here. See lib/useObjectPlans · isSelectOnlySurface for why it is keyed on the
  // catalog's `osm` property rather than on the tile's name.
  // ⚠️ A DELIBERATE exception to Lage↔Plan tool parity, not drift: a surface that cannot be drawn
  // on must not offer tools that quietly do nothing. Don't "fix" the rail back in.
  // Anything already drawn here before this rule still RENDERS (read-only, no handles) — the
  // board is a synced document and nothing may silently disappear from it.
  const selectOnly = isSelectOnlySurface(active)
  // A viewer-only plan (e.g. PV/documentation PDF) is read-only regardless of role: plain
  // pan/zoom, no drawing tools or annotation surface. Folds into the existing readOnly gates.
  const readOnly = readOnlyProp || active?.viewer === true || selectOnly
  // The slim read-only rail (Auswahl) — never on a viewer-only or selection-only
  // document, which has no tool rail for ANYONE, so a locked editor and a viewer keep seeing the
  // same surface.
  const slimRail = readOnly && slimToolsProp && active?.viewer !== true && !selectOnly
  // ⚠️ Messen is filtered OUT of the Plan rail — a DELIBERATE Lage↔Plan divergence, decided
  // 29.08., not drift: on a plan, a distance worth keeping is a drawn Linie/Fläche, which reads
  // its metres through the Maßstab calibration (usePlanMeasure) in the DrawEditor's Messung
  // section and the on-canvas distance labels; the ephemeral measure path only duplicated the
  // drawing tools with state a tap-away destroyed. The Maßstab chip and its calibration flow
  // stay untouched. `sep-measure` goes with it so the rail never ends on a stray divider, and
  // the read-only slim rail loses Messen with it (leaving Auswahl — a viewer still inspects).
  const planTools = useMemo(() => appConfig.copy.planTools.filter((t) => t.id !== 'measure' && t.id !== 'sep-measure'), [])
  const slimPlanTools = useMemo(() => slimTools(planTools, PLAN_READONLY_TOOLS), [planTools])
  const isPhone = useIsPhone()

  // ⚠️ `tool` is DERIVED, not raw state. The armed tool survives a plan switch (this component
  // does not remount between documents), so a Linie armed on the Tafel would arrive still armed
  // on the selection-only Umrisse sheet — with no rail left to disarm it. Forcing the rest tool
  // there closes every create path at once (they all gate on `tool`) instead of gating each.
  const [armedTool, setTool] = useState<BoardTool>('pan')
  const tool: BoardTool = selectOnly ? 'pan' : armedTool
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
  // which note has its detail panel open. Since 29.08. TAPPING a note opens it (chipDown) —
  // the same grammar as a symbol, unified across Karte and Plan. Still separate from selId:
  // a freshly PLACED note goes straight into typing (editId) and must not mount the panel
  // over the keyboard, so placement selects without opening this.
  const [notePanelId, setNotePanelId] = useState<string | null>(null)
  // style the NEXT note carries, chosen in the armed-tool dock before anything is placed
  const [noteDefaults, setNoteDefaults] = useState<{ size: NoteSize; plain: boolean; color: string }>(
    { size: 'm', plain: false, color: '' },
  )
  // which Georeferenz twin has its source-backed editor open — the Karte's object, mirrored onto
  // this sheet. Its open panel gives the projection the source object's normal selection halo.
  const [twinView, setTwinView] = useState<BoardTwin | null>(null)
  // a pending team placement awaiting a Trupp pick (x/y/floor of the tapped point)
  const [truppPick, setTruppPick] = useState<{ x: number; y: number; floor: number } | null>(null)
  const [color, setColor] = useState<string>(appConfig.drawing.defaultColor)
  const [width, setWidth] = useState(5)
  const [dashed, setDashed] = useState(false)
  const [draft, setDraft] = useState<BoardPoint[] | null>(null)
  const draftAttachments = useRef<{ startAttachment?: LineAttachment; endAttachment?: LineAttachment }>({})
  // the single Linie tool's input mode: Freihand (drag) ↔ Punkte (tap each vertex), like the Lage map
  const [lineMode, setLineMode] = useState<'freehand' | 'nodes'>('freehand')
  /** Where the selected anno was TAPPED (client px), paired with its id so a selection that
   *  arrived some other way can't borrow a stale point. Read only by the panel nudge. */
  const [annoTap, setAnnoTap] = useState<{ id: string; x: number; y: number } | null>(null)
  // sticky line preset (Freihand / Messpfeil / Rettungsachse) baked into a new line + editable after,
  // mirroring the Lage map. Chosen in the post-draw editor now, not the dock.
  const [linePreset, setLinePreset] = useState<string>(appConfig.drawing.linePresets[0].id)
  // last node-tap (time + point) to detect a double-tap that finishes the shape
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const [aspect, setAspect] = useState(1.414) // h/w, A4 default until image loads
  const [vp, setVp] = useState({ w: 0, h: 0 })
  // per-team trail visibility (anno ids hidden this session) — the eye on a selected team
  // hides only THAT team's trail; there is no global Spuren toggle anymore
  const [hiddenTrails, setHiddenTrails] = useState<ReadonlySet<string>>(new Set())
  const toggleTrail = (id: string) => setHiddenTrails((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  // Plan-Maßstab (calibration) + Messen (ephemeral distance/area) own their state end to end in
  // usePlanMeasure — see the hook call below, which needs toNorm/floorAt and so cannot sit here.

  const canvasRef = useRef<HTMLDivElement | null>(null)
  // The canvas element as STATE, so effects that attach observers/listeners re-run when it
  // (re)mounts. The viewer-only early return renders WITHOUT the canvas — if the Whiteboard
  // first mounts on a viewer plan, a mount-once ([]) effect sees canvasRef.current === null
  // and never recovers: vp stays 0×0, every later board doc renders collapsed (empty
  // Gebäude, PDFs stuck on «wird geladen»). Stable callback — an inline ref would detach/
  // re-attach every render and loop through setState.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null)
  const setCanvas = useCallback((el: HTMLDivElement | null) => { canvasRef.current = el; setCanvasEl(el) }, [])
  const boardRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // rail tool buttons, so a tool's option dock can be top-aligned to its button
  const toolBtn = useRef<Record<string, HTMLButtonElement | null>>({})
  const chipDrag = useRef<{ id: string; moved: boolean; sx: number; sy: number } | null>(null)
  // drag a single selected freehand stroke (its original board-space vertices + the start point)
  const drawDrag = useRef<{ id: string; floor: number; sx: number; sy: number; bpts: BoardPoint[]; moved: boolean } | null>(null)
  // drag a single VERTEX of a selected line/area (shared by both — they're both pts-based)
  const vertDrag = useRef<{ id: string; idx: number; floor: number; moved: boolean } | null>(null)
  // `origin` + `attached` + `detach` are the RELEASE half of the ring language (see the Lage map's
  // EndpointDrag — same shape, board coords instead of lng/lat).
  type PlanEndpointDrag = { id: string; endpoint: LineEndpoint; point: BoardPoint; origin: BoardPoint; attached: boolean; detach: number; dwell: DwellState; candidate: MagneticTarget | null }
  const [planEndpointDragState, setPlanEndpointDragState] = useState<PlanEndpointDrag | null>(null)
  const planEndpointDrag = useRef<PlanEndpointDrag | null>(null)
  const planDwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPlanEndpointDrag = (next: PlanEndpointDrag | null) => { planEndpointDrag.current = next; setPlanEndpointDragState(next) }
  type PlanDraftMagnet = { atStart: boolean; point: BoardPoint; dwell: DwellState; candidate: MagneticTarget | null }
  const [planDraftMagnetState, setPlanDraftMagnetState] = useState<PlanDraftMagnet | null>(null)
  const planDraftMagnet = useRef<PlanDraftMagnet | null>(null)
  const planDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPlanDraftMagnet = (next: PlanDraftMagnet | null) => { planDraftMagnet.current = next; setPlanDraftMagnetState(next) }
  // which text note is mid-edit (so we checkpoint undo once per edit session, then stream
  // each keystroke live into the anno — like the Lage note title)
  const textEditId = useRef<string | null>(null)
  // drag-to-rotate a selected directional symbol — mirrors the map's rotor handle
  // `rot` = the shape's rotation at grab time and `free` = per-axis resize allowed — captured
  // on pointer-down so a corner drag can be resolved in the shape's own rotated frame
  const rotate = useRef<{ id: string; cx: number; cy: number; moved: boolean; mode: 'rotate' | 'rotate2' | 'resize' | 'cage' | 'width'; rot: number; free: boolean } | null>(null)
  // the group-move drag origin (start client point and the original board-space geometry of
  // every selected anno). Pan/pinch/marquee refs live in useBoardGestures.
  const groupMove = useRef<{ sx: number; sy: number } | null>(null)
  type GrpOrig = { id: string; floor: number; bx?: number; by?: number; bpts?: BoardPoint[] }
  const groupOrig = useRef<GrpOrig[]>([])
  // zoom/pan view state (layout-based zoom + focal wheel-zoom) lives in a hook, which also
  // remembers it per plan across a surface switch — `signature` says when a remembered view has
  // gone stale (the plan's image / floor stack / calibration changed under it).
  const viewMemory = views
    ? { views, planId: activeId, signature: boardViewSignature(active, building, planScale[activeId]) }
    : undefined
  const { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom } = useBoardView(canvasRef, canvasEl, viewMemory)

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
  // single-finger node-placement gesture (Maßstab / node-draw): like the Lage map, a DRAG
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

  // Leaving Linie/Fläche mid-shape no longer silently drops the draft (A6, 29.08.): the
  // tool-change release lives BELOW, next to the commit machinery it needs (see releaseDraft).
  // The half-laid Maßstab tap is ephemeral and usePlanMeasure clears it itself.
  // `releaseRef` also serves the DOCUMENT-leave release: an effect cleanup's closure is stale
  // (from the render its effect last ran in), while this ref — re-pointed by an every-commit
  // effect — still holds the OLD document's closure when the cleanups of the next commit run.
  const releaseRef = useRef<(from: BoardTool) => void>(() => {})
  // the tool the live draft was laid under (the release must classify by the tool being LEFT)
  const prevTool = useRef<BoardTool>('pan')
  // Arriving on the selection-only sheet also DISARMS what was carried over: its dock went with
  // the rail, so a still-pending symbol would be an invisible armed state that fires on the next
  // document opened.
  useEffect(() => {
    if (!selectOnly) return
    setTool('pan'); setPending(null); setPendingShape(null); setPaletteOpen(false); setDraft(null)
  }, [selectOnly])
  // WHICH plan the Passung is open for, not merely whether it is open: switching documents then
  // closes it by derivation instead of by an effect that fires after the wrong panel has already
  // been painted over the new sheet.
  const [qualityFor, setQualityFor] = useState<string | null>(null)
  // Esc cancels an in-progress node shape, else clears the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // typing in a field? Escape leaves the FIELD and nothing more, so one key press never
      // both finishes the text and drops the selection (which would take the handles with it).
      // Read the event TARGET, not activeElement: the field's own handler has already blurred
      // by the time this bubbles up, so activeElement is <body> and the guard would miss.
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      // …and a MODAL on top of the board owns Escape outright: it closes, the board does not
      // also drop the draft/selection behind it. Focus is trapped inside the dialog, so the
      // target is enough to tell (covers the Trupp picker, the Maßstab entry, every overlay).
      if (el?.closest('[role="dialog"], [role="alertdialog"]')) return
      // ⚠️ Escape stays an EXPLICIT discard — deliberately NOT routed through releaseDraft
      // (A6, 29.08.): tap-away loses a draft by ACCIDENT, so it auto-commits; Escape is the
      // one gesture whose whole meaning is «weg damit», and auto-saving it would leave no
      // way to throw a half-laid shape away.
      if (draft) { setDraft(null); draftAttachments.current = {}; lastTap.current = null }
      // the note panel closes BEFORE the selection does — Escape backs out one layer at a time
      else if (twinView) setTwinView(null)
      // …then the Passung dock. It is deliberately not an Overlay (it must not trap the board
      // behind a scrim while a fit is being judged), so it has no Escape of its own and would
      // otherwise be the ONE panel on this surface that the key cannot dismiss.
      else if (qualityFor) setQualityFor(null)
      else if (notePanelId) setNotePanelId(null)
      else if (selId) setSelId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, twinView, qualityFor, selId, notePanelId])

  // Stable ref callback that focuses a freshly-mounted text/resource input. The focus is
  // DEFERRED past the current placement tap: focusing synchronously on mount gets immediately
  // undone by the tap's pointerup/click blurring the input (→ onBlur clears edit mode before
  // you can type). A 0ms timeout runs after the gesture settles, so the input keeps focus.
  // Focus synchronously when the input mounts — a deferred (setTimeout) focus drops out of the
  // tap's gesture context, so iPadOS refuses to open the on-screen keyboard for a freshly
  // placed Notiz. Focusing in the ref callback keeps it as close to the gesture as React allows.
  const focusOnce = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!el) return
    // caret AFTER the text, not a full selection: re-opening a note is almost always "add a
    // line", and selecting everything means the next keystroke silently wipes what was written
    el.focus(); el.setSelectionRange?.(el.value.length, el.value.length)
    // size AFTER layout — at ref time scrollHeight is still 0 (see autoGrow). Focus stays
    // synchronous above for the iPadOS keyboard, as the comment block above explains.
    requestAnimationFrame(() => autoGrow(el))
  }, [])

  // measure viewport so the board can be sized to "contain" the plan exactly — keyed to the
  // canvas ELEMENT, not mount, so it attaches when the canvas appears after a viewer-only doc
  useEffect(() => {
    const el = canvasEl; if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [canvasEl])

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
  // …and the rails: the WINDOW decides whether they are floating side rails or bottom bars, not
  // the canvas width — during the «Karte verknüpfen» split the canvas is half a screen wide with
  // both rails still in place (lib/whiteboard · sideInsets).
  const side = useMemo(() => sideInsets(vp.w, isPhone), [vp.w, isPhone])
  const fit = useMemo(() => {
    const w = Math.max(0, vp.w - side.l - side.r)
    const h = Math.max(0, vp.h - TOP_INSET - (stack ? 2 * STACK_VPAD : 0)); if (!w || !h) return { w: 0, h: 0 }
    const byW = { w, h: w * effAspect }
    return byW.h <= h ? byW : { w: h / effAspect, h }
  }, [vp, effAspect, stack, side])
  // Zoom by LAYOUT, not by a CSS scale transform: the board's real pixel size is
  // fit × scale. This re-rasterizes the PDF + SVG symbols + text crisply at the
  // actual zoom instead of bitmap-scaling a 100% texture (which pixelates them).
  const sW = fit.w * scale, sH = fit.h * scale

  // client point → normalized 0..1 in plan space (board rect reflects the transform)
  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const r = boardRef.current?.getBoundingClientRect(); if (!r || !r.width) return null
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height]
  }

  // --- Plan-Maßstab + Messen (calibration and ephemeral measurement) ---
  // One hook, because both halves share the measurement space: a calibration is only meaningful
  // in the space its reference was drawn in, and a measured path has to be converted into that
  // same space before it can become metres. Nothing here is ever written to the board document.
  // The alignment and the ruler solve the same physical factor. Resolve the live/stored fit
  // before the measuring hook so a linked sheet measures immediately and says «Ref. auto»;
  // there is no second persisted calibration that could drift away from the reference points.
  const georef = useGeorefMode()
  useGeorefStorage()
  const georefArmed = georef.planId === activeId
  const activeGeorefKey = active?.georefKey ?? activeId
  // Opening a sheet is the moment its station data has to be current: the Massstab and the
  // Georeferenz are set by whoever happens to be holding a device, and every OTHER device only
  // read the document once, at boot. Re-reads on plan switch (and on focus, from main.tsx);
  // an unchanged answer notifies nobody, so this costs a render only when something really moved.
  useEffect(() => { void refreshStationPlanScales() }, [activeGeorefKey])
  const canGeoref = !osm && !blank && !stack && active?.viewer !== true
  const measureARForGeoref = stack ? 1 / TILE_AR : 1 / aspect
  const georefPairs = georefArmed ? georef.pairs : georefForPlan(activeGeorefKey)?.pairs ?? []
  const georefFit = canGeoref ? fitSimilarity(georefPairs, measureARForGeoref) : null
  const autoScale: PlanScale | undefined = georefFit
    ? { mPerU: georefFit.scaleMPerU, refM: 0, ar: measureARForGeoref }
    : undefined
  const {
    calNodes, setCalNodes, calPrompt, setCalPrompt, lastRefM, refMInput, setRefMInput, savePrompt, setSavePrompt,
    measureAR, activeScale, scaleAuto, scaleStale, calibrated, planMetres, resetEphemeral,
    closeCalPrompt, commitCalibration,
  } = usePlanMeasure({ activeId, stack, aspect, planScale, localY, floorAt, tool, setTool, log, onCalibrate, autoScale })

  // --- Karte verknüpfen (Georeferenz) --------------------------------------------------------
  // The pairing mode itself lives in lib/georefMode — outside React, because on a phone this
  // component is unmounted between the plan tap and the map tap (see that file's header).
  // Which surfaces can carry a georeference at all: a printed sheet can. The Tafel has no
  // geometry to tie down, the OSM picking face IS the map, a viewer-only PDF is not annotated,
  // and the Gebäude floor stack is a COLUMN of copies of one footprint — one similarity
  // transform cannot mean anything across it (georef.ts · «tile-locally», not built here).
  // Armed ⇒ the live pairs; otherwise what is stored. Deliberately NOT memoised: both sides are
  // a reference to an array somebody else owns (the mode store, or the station document), so the
  // identity is already stable between renders and a memo would only add a dependency the linter
  // cannot see. `useGeorefStorage()` above is what makes the stored read re-run.
  // measureAR is the plan's width/height — exactly the `planAspect` the fit is taken at. Solved
  // per render rather than memoised: it is a closed-form fit over at most a handful of points,
  // and a memo here would depend on an array identity the linter cannot reason about.
  const georefState = georefChip(georefFit, georef, activeId)
  /** The real plan bitmap for «Deckung prüfen». The PDF viewport already rendered it into its
   *  first canvas, so taking a same-origin snapshot is both cheaper and more faithful than
   *  rendering the PDF a second time on the map side. It rides in the cross-surface mode store,
   *  which also keeps it alive while the Whiteboard is unmounted on a phone. */
  const georefPreviewUrl = () => {
    const canvas = boardRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas?.width || !canvas.height) return null
    try { return canvas.toDataURL('image/jpeg', 0.82) } catch { return null }
  }
  const beginGeoref = (opts?: { check?: boolean; returnToQuality?: boolean }) => startGeorefMode(activeId, measureAR, {
    storageKey: activeGeorefKey,
    check: opts?.check,
    returnToQuality: opts?.returnToQuality,
    previewUrl: georefPreviewUrl(),
  })
  const georefQuality = qualityFor === activeId
  const [georefTransferOpen, setGeorefTransferOpen] = useState(false)
  const georefPanelPlan = useRef(activeId)
  // These overlays describe one concrete document. A real document switch closes them for good;
  // merely hiding them and reopening the old state when the operator later returns is dangerous
  // because transfer would then act on a source they are no longer looking at.
  useEffect(() => {
    if (georefPanelPlan.current === activeId) return
    georefPanelPlan.current = activeId
    setQualityFor(null)
    setGeorefTransferOpen(false)
  }, [activeId])
  // A coverage check opened from Passung keeps its mode alive just long enough for the phone to
  // navigate back from Karte and mount this surface again. Restore the panel, then retire that
  // temporary mode; on desktop the same transition is immediate and produces identical UI.
  useEffect(() => {
    if (!georefArmed || georef.check || georef.checkReturn !== 'quality') return
    setQualityFor(activeId)
    georefDispatch({ type: 'dismiss' })
  }, [activeId, georefArmed, georef.check, georef.checkReturn])
  // Only object-specific Modul sheets receive a `georefKey`; this excludes Tafel, OSM and
  // generic PDFs without guessing from their labels. Sibling Modules describe the same object
  // area, which is exactly the case where copying a fit is meaningful.
  const georefTransferTargets: GeorefTransferTarget[] = active?.georefKey
    ? plans
      .filter((p) => p.id !== activeId && !!p.georefKey && p.viewer !== true && !!p.imageUrl && !p.osm && !p.floorStack)
      .map((plan) => ({ plan, linked: !!georefForPlan(plan.georefKey!)?.pairs.length }))
    : []
  const transferGeoref = async (target: GeorefTransferTarget) => {
    const C = appConfig.copy.whiteboard.georef
    const targetKey = target.plan.georefKey
    if (!targetKey) return false
    if (target.linked) {
      const replace = await confirmDialog({
        title: fillTemplate(C.transferReplaceTitle, { target: target.plan.code }),
        message: fillTemplate(C.transferReplaceBody, { target: target.plan.code, source: active?.code ?? activeId }),
        confirmLabel: C.transfer,
        cancelLabel: C.cancel,
      })
      if (!replace) return false
    }
    try {
      const copied = await transferGeorefPlan(activeGeorefKey, targetKey)
      if (!copied) return false
      toast(fillTemplate(C.transferDone, { target: target.plan.code }))
      return true
    } catch {
      toast(C.saveFailed, { icon: 'warn', tone: 'warn' })
      return false
    }
  }
  // an offline PUT must not lose the pairs: they stay in the store and the next save writes the
  // whole list again (saveGeoref replaces the document), so the retry needs no queue of its own
  useEffect(() => {
    setGeorefSaveErrorHandler(() => toast(appConfig.copy.whiteboard.georef.saveFailed, { icon: 'warn', tone: 'warn' }))
    return () => setGeorefSaveErrorHandler(null)
  }, [])
  // switching to another plan document ends the mode — the references belong to ONE sheet, and
  // a half-placed pair carried onto a different one would be nonsense
  useEffect(() => {
    if (georef.planId && georef.planId !== activeId) georefDispatch({ type: 'dismiss' })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps
  // ⚠️ ONE mode at a time — the same clean slate a document switch makes (see the reset above).
  // Arming hides the tool rail, and until 26.08. that was ALL it did: the tool stayed armed
  // underneath, so a Messen path kept its handles, a create tool kept its `.wb-ink` layer and a
  // selected object kept its vertex grips — every one of them drawn ABOVE the pairing layer
  // (z 7/8 vs the capture's z 6). A tap meant for a reference point then dragged a node or
  // extended a line, and a hold armed a node delete. The rail being gone is exactly why this has
  // to be a real reset and not a visual one: there is no way back to «Auswahl» while the mode runs.
  useEffect(() => {
    if (!georefArmed) return
    // …but arming the mode is a tap-away like any other: a committable node draft is
    // auto-committed (with its undo toast) instead of silently discarded — A6, 29.08.
    releaseRef.current(tool)
    setSelId(null); setSelIds([]); setEditId(null); setPending(null); setPendingShape(null)
    setPaletteOpen(false); setTruppPick(null)
    resetEphemeral() // the calibration nodes usePlanMeasure owns
    setTool('pan')
  }, [georefArmed]) // eslint-disable-line react-hooks/exhaustive-deps
  const georefView: PlanViewApi = { toNorm, applyView, zoomTo, scaleRef, posRef, canvasEl, boardRef }

  // --- Zwillinge: what the Karte lends this sheet ---------------------------------------------
  // Projected HERE, against this sheet's own `georefFit`, so a twin can never disagree with the
  // reference crosses drawn beside it — the app shell resolves a plan's aspect from its stored
  // calibration, while this surface has actually measured the bitmap (usePlanMeasure · measureAR).
  //
  // ⚠️ Separate memos on purpose. Vehicle/person feeds, tactical entities and drawings change on
  // different clocks; joining them would re-project the whole Lage every time one source moves.
  // `fit` is a fresh object each render, so deps name its INPUTS instead — the pairs identity and
  // the aspect it is solved at.
  const twinVehicles = useMemo(
    () => (georefFit && mapTwins?.vehicles.length ? boardTwins(mapTwins.vehicles, georefFit, 'vehicle') : []),
    [mapTwins?.vehicles, georefPairs, measureAR], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const twinSymbols = useMemo(
    () => (georefFit && mapTwins?.symbols.length ? boardTwins(mapTwins.symbols, georefFit, 'symbol') : []),
    [mapTwins?.symbols, georefPairs, measureAR], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const twinContent = useMemo(
    () => (georefFit && mapTwins?.content.length ? boardEntityTwins(mapTwins.content, georefFit) : []),
    [mapTwins?.content, georefPairs, measureAR], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const twinDrawings = useMemo(
    () => (georefFit && mapTwins?.drawings.length ? boardDrawingTwins(mapTwins.drawings, georefFit) : []),
    [mapTwins?.drawings, georefPairs, measureAR], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // ⚠️ Joined ONCE, not in the JSX. `GeorefTwinsBoard` is `memo()`d and its own comment promises
  // it "re-renders only when that list actually moves" — a `[...a, ...b]` literal in the prop is
  // a fresh array identity every render, so the memo could never bail and every twin re-ran its
  // glyph/caption work. This board re-renders on every pan frame (`applyView` is state), while
  // the twins' board-space positions do not move at all during a pan.
  const twins = useMemo(() => [...twinVehicles, ...twinSymbols], [twinVehicles, twinSymbols])
  // State keeps the stable selection key; the object itself is re-derived so edits made through
  // the mirrored panel are reflected immediately instead of leaving that panel on its old snapshot.
  const viewedTwin = twinView ? twins.find((t) => t.key === twinView.key) ?? twinView : null
  // …and the handler with it. Empty deps are correct and not a shortcut: every call here is a
  // `useState` setter, and those identities are stable for the life of the component.
  /**
   * Drag a mirrored Karte object on this sheet.
   *
   * ⚠️ The write goes to the MAP entity, never to a copy on this board — a twin is a projection,
   * and a projection that could be moved independently would be a second position for one object.
   * `georefFit.toMap` is the exact inverse of the projection that drew it, so the mark lands
   * where it was dropped; what the fit's residual costs is how well that plan point matches the
   * real ground, which is the same error the twin was already drawn with.
   *
   * Gated on `readOnly`: a viewer or a locked surface may open a twin's details and nothing more.
   */
  const moveBoardTwin = useCallback((twin: BoardTwin, pt: { x: number; y: number }, phase: 'start' | 'move' | 'end') => {
    if (readOnly || !georefFit || !onTwinMove) return
    const c = georefFit.toMap(pt)
    onTwinMove(twin.entityId, [c.lng, c.lat], phase)
  }, [readOnly, georefFit, onTwinMove])
  // …and the mirrored Trupp chips take the same road: the write lands on the one map entity.
  const moveContentTeam = useCallback((entity: Entity, pt: { x: number; y: number }, phase: 'start' | 'move' | 'end') => {
    if (readOnly || !georefFit || !onTwinMove) return
    const c = georefFit.toMap(pt)
    onTwinMove(entity.id, [c.lng, c.lat], phase)
  }, [readOnly, georefFit, onTwinMove])
  const openBoardTwin = useCallback((twin: BoardTwin) => {
    setSelId(null); setSelIds([]); setNotePanelId(null); setEditId(null); setAnnoTap(null)
    setTwinView(twin)
  }, [])

  // reset transient state when switching document; seed an aspect from the
  // orientation (image docs refine it on load, blank sheets keep it). Sits BELOW the hook
  // because it clears the state the hook owns — above it, resetEphemeral is not yet declared.
  // ⚠️ The VIEW is no longer reset here: useBoardView restores the plan's remembered zoom/pan
  // (falling back to fit on a first visit), and a reset here would run after it and undo it.
  useEffect(() => {
    setSelId(null); setSelIds([]); setEditId(null); setDraft(null); setPending(null)
    resetEphemeral() // the calibrate state usePlanMeasure owns
    if (tool === 'symbol') setTool('pan')
    setAspect(active.orientation === 'portrait' ? 1.414 : 1 / 1.414)
    // Leaving the DOCUMENT (plan switch, or unmounting the whole surface) is a tap-away too
    // (A6, 29.08.). Through releaseRef, because this cleanup's own closure is from the render
    // the document was OPENED in, when the draft did not exist yet — the ref, re-pointed every
    // commit and read before any new effect runs, still holds the old document's closure, so
    // the auto-commit lands on the sheet the shape was actually drawn on.
    return () => releaseRef.current(prevTool.current)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Annotation document + per-plan undo/redo (the set/commit mutation funnel, audit-emitting CRUD,
  // and the global-TopBar history wiring) live in useBoardDoc; the gesture handlers and render
  // below call the returned mutators exactly as before. The keyed history MAP itself is passed
  // through from the caller — it has to outlive this component's unmount (see Props · hist).
  // which drawing's label is being typed right now (one undo step per edit, not per keystroke)
  const labelLive = useRef<string | null>(null)
  // …and the same for a symbol's / note's TITLE in the detail panel: the panel streams every
  // keystroke (ContextPanel · onTitleLive) so the glyph's label updates under the finger, exactly
  // as it does on the Lage. Checkpoint once when typing starts, emit once on blur — otherwise
  // «Sicherung» is nine undo steps and nine audit rows.
  const titleLive = useRef<string | null>(null)
  const { pushPast, set, commit, add, patch, patchCommit, removeAnno } = useBoardDoc({
    annos, onChange, emit, activeId, log, selId, setSelId, editId, setEditId, historyRef, onHistoryState, hist, setHist,
  })
  // expose fit-to-view (the phone top bar's Fit button calls it; desktop uses the rail footer)
  useEffect(() => { if (fitRef) fitRef.current = () => applyView(1, { x: 0, y: 0 }); return () => { if (fitRef) fitRef.current = null } })
  // expose tool-pick + zoom to the keyboard-shortcut layer. Semantic ids (from App) → Plan tools;
  // the rest tool is 'pan' (the plan pans on empty canvas), 'note'→'text', 'team'→'resource'.
  // No dep array (mirrors fitRef) so the toggle always closes over the current tool.
  useEffect(() => {
    if (!keysRef) return
    // no 'measure' entry: the Messen tool left the Plan on 29.08. (see the rail filter above),
    // so the shared shortcut simply does nothing while the Plan is the active surface
    const MAP: Record<string, BoardTool> = { select: 'pan', lasso: 'lasso', line: 'line', area: 'area', note: 'text', team: 'resource' }
    keysRef.current = {
      pickTool: (cmd) => {
        if (selectOnly) return // the Umrisse sheet arms nothing — by keyboard either (see selectOnly)
        if (cmd === 'symbol') { setTool('symbol'); setPaletteOpen(true); return }
        const id = MAP[cmd]; if (!id) return // e.g. 'circle' has no Plan equivalent
        setTool(tool === id ? 'pan' : id); setPending(null)
      },
      zoom: (f) => zoom(f),
    }
    return () => { if (keysRef) keysRef.current = null }
  })

  // every tap-to-place tool needs the .wb-ink capture overlay mounted — INCLUDING 'shape'
  // (the palette's Rauch/Rechteck/Pfeil forms). Omitting 'shape' left its overlay off the
  // Plan, so arming a shape froze the surface: the tap placed nothing and, with no overlay,
  // the board couldn't pan either. placeNode already handles 'shape'.
  const creating = tool === 'line' || tool === 'area' || tool === 'text' || tool === 'symbol' || tool === 'shape' || tool === 'resource' || tool === 'scale'
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

  // Resolve every magnetic Plan line once in stacked-board screen space. The optional floor on
  // each point lets one polyline cross storeys while legacy two-tuples inherit anno.floor.
  // The dragged endpoint follows the FINGER, fed into resolution with its own attachment ignored, so
  // attached branch lines follow the node live (move + carry) rather than snapping only on release.
  const attachmentLines: AttachableLine<BoardPoint>[] = annos
    .filter((a) => a.kind === 'draw' && (a.pts?.length ?? 0) >= 2)
    .map((a) => {
      const drag = planEndpointDragState?.id === a.id ? planEndpointDragState : null
      if (!drag) return { id: a.id, points: a.pts!, teilstueck: a.teilstueck, width: a.width, startAttachment: a.startAttachment, endAttachment: a.endAttachment }
      const idx = drag.endpoint === 'start' ? 0 : a.pts!.length - 1
      return {
        id: a.id, points: a.pts!.map((p, i) => (i === idx ? drag.point : p)), teilstueck: a.teilstueck, width: a.width,
        startAttachment: drag.endpoint === 'start' ? undefined : a.startAttachment,
        endAttachment: drag.endpoint === 'end' ? undefined : a.endAttachment,
      }
    })
  // Which drawn Leitungen carry a Trupp whose contact clock has run out — the halo map for the ink
  // layer. Keyed by anno id; only warn/crit appear, so a quiet plan builds an empty object.
  const truppTones = useMemo(() => {
    const out: Record<string, 'warn' | 'crit'> = {}
    for (const a of annos) {
      if (a.kind !== 'draw') continue
      const tr = truppForLine(a, trupps)
      if (!tr) continue
      const tone = truppLineTone(tr, truppSeverities?.[tr.id] ?? 0)
      if (tone === 'warn' || tone === 'crit') out[a.id] = tone
    }
    return out
  }, [annos, trupps, truppSeverities])

  const resolvedPts = new Map<string, BoardPoint[]>()
  const objectPoint = (id: string, toward: BoardPoint, _a: LineAttachment, source: AttachableLine<BoardPoint>): BoardPoint | null => {
    const target = annos.find((a) => a.id === id && (a.kind === 'symbol' || a.kind === 'resource'))
    if (!target || target.x == null || target.y == null || !sW || !sH) return null
    const floor = target.floor ?? 0
    const center: [number, number] = [target.x * sW, mapY(floor, target.y) * sH]
    const tp: [number, number] = [toward[0] * sW, mapY(toward[2] ?? floor, toward[1]) * sH]
    // negative padding = the endpoint lands just INSIDE the glyph, so the stroke disappears
    // under the symbol instead of stopping short of it (see attachInsetPx)
    const p = boundaryPoint({ shape: 'rect', center, width: target.kind === 'resource' ? 76 : symBase, height: target.kind === 'resource' ? 44 : symBase, rotation: target.rotation }, tp, -attachInsetPx(source.width))
    return [p[0] / sW, localY(p[1] / sH, floor), floor]
  }
  const linePoint = (target: AttachableLine<BoardPoint>, endpoint: LineEndpoint, attachment: LineAttachment, resolved: BoardPoint): BoardPoint => {
    if (!(endpoint === 'end' && target.teilstueck) || attachment.port == null || target.points.length < 2) return resolved
    const q = target.points[target.points.length - 2], floor = resolved[2] ?? q[2] ?? 0
    const ppx: [number, number] = [resolved[0] * sW, mapY(resolved[2], resolved[1]) * sH], qpx: [number, number] = [q[0] * sW, mapY(q[2], q[1]) * sH]
    const port = forkPortPoint(ppx, qpx, target.width ?? 4, attachment.port)
    return [port[0] / sW, localY(port[1] / sH, floor), floor]
  }
  for (const l of attachmentLines) resolvedPts.set(l.id, resolveLinePoints(l, { lines: attachmentLines, objectPoint, linePoint }))
  const relationship = relationshipNetwork(attachmentLines, selId && attachmentLines.some((l) => l.id === selId) ? [selId] : [], selId && annos.some((a) => a.id === selId && (a.kind === 'symbol' || a.kind === 'resource')) ? [selId] : [])
  // resolvedPts already carries the dragged endpoint at the finger position (attachmentLines injects
  // it above), so the anno list needs no second override.
  const renderAnnos = annos.map((a) => (resolvedPts.has(a.id) ? { ...a, pts: resolvedPts.get(a.id)! } : a))

  const planCandidatesAt = (sourceId: string, pointer: [number, number]): MagneticTarget[] => {
    const objects: MagneticTarget[] = annos
      .filter((a) => (a.kind === 'symbol' || a.kind === 'resource') && a.x != null && a.y != null)
      .map((a) => {
        const center: [number, number] = [a.x! * sW, mapY(a.floor, a.y!) * sH]
        const edge = boundaryPoint({ shape: 'rect', center, width: a.kind === 'resource' ? 76 : symBase, height: a.kind === 'resource' ? 44 : symBase, rotation: a.rotation }, pointer)
        return { key: `object:${a.id}`, target: { kind: 'object', id: a.id }, point: edge, defaultRouting: a.kind === 'resource' ? 'trace' : 'direct' }
      })
    const lines: MagneticTarget[] = renderAnnos
      .filter((a) => a.kind === 'draw' && a.id !== sourceId && (a.pts?.length ?? 0) >= 2)
      .flatMap((a) => (['start', 'end'] as const).flatMap((endpoint) => {
        const p = endpoint === 'start' ? a.pts![0] : a.pts![a.pts!.length - 1]
        const capacity = endpoint === 'end' && a.teilstueck ? 3 : 1
        const usedPorts = incomingAttachments(attachmentLines, a.id, endpoint).map((x) => x.attachment.port ?? 0)
        const free = Array.from({ length: capacity }, (_, i) => i).filter((port) => !usedPorts.includes(port))
        const q = endpoint === 'start' ? a.pts![1] : a.pts![a.pts!.length - 2]
        const pp: [number, number] = [p[0] * sW, mapY(p[2] ?? a.floor, p[1]) * sH]
        const qp: [number, number] = [q[0] * sW, mapY(q[2] ?? a.floor, q[1]) * sH]
        return free.map((port) => {
          // three-port Teilstück ends fan onto the drawn fork prongs; every other endpoint is the bare tip
          const point = capacity === 3 ? forkPortPoint(pp, qp, a.width ?? 4, port) : pp
          return { key: `line:${a.id}:${endpoint}:${port}`, target: { kind: 'line', id: a.id, endpoint }, point, capacity, usedPorts, port, blocked: wouldCreateCycle(attachmentLines, sourceId, a.id), defaultRouting: 'direct' as const }
        })
      }))
    return [...objects, ...lines]
  }
  const planAttachmentFor = (c: MagneticTarget): LineAttachment => ({
    target: c.target, routing: c.defaultRouting ?? 'direct',
    ...(c.target.kind === 'line' ? { port: c.port ?? nextFreePort(attachmentLines, c.target.id, c.target.endpoint) ?? undefined } : {}),
  })
  /** Same «Ring lädt, dann schnappt es» machine as the Lage map's `updateDraftMagnet`, in board px.
   *  `phase` is the whole difference between the two behaviours: a pointerDOWN that lands on a
   *  target is deliberate aim and arms at once (the line-START exception — you put your finger on
   *  the Teilstück's prong because that is where the branch begins); everything acquired later in
   *  the same stroke has to hold still for `MAGNET_DWELL_MS` first. */
  const updatePlanDraftMagnet = (point: BoardPoint, atStart: boolean, phase: 'start' | 'move') => {
    const pointer: [number, number] = [point[0] * sW, mapY(point[2], point[1]) * sH]
    const cur = planDraftMagnet.current
    const targets = planCandidatesAt('__draft__', pointer)
    if (planDraftTimer.current) clearTimeout(planDraftTimer.current)
    if (phase === 'start') {
      const candidate = nearestMagneticTarget(pointer, targets)
      setPlanDraftMagnet({ point, atStart, candidate, dwell: armDwell(candidate?.key ?? null, Date.now()) })
      if (candidate) {
        draftAttachments.current = { ...draftAttachments.current, [atStart ? 'startAttachment' : 'endAttachment']: planAttachmentFor(candidate) }
        navigator.vibrate?.(12)
      }
      return
    }
    const candidate = stickyMagneticTarget(pointer, targets, cur?.candidate?.key ?? null)
    // leaving the start point ends the start's claim — the far end earns its own ring
    const base = cur && atStart === cur.atStart ? cur.dwell : EMPTY_DWELL
    const next: PlanDraftMagnet = { point, atStart, candidate, dwell: advanceDwell(base, candidate?.key ?? null, Date.now()) }
    setPlanDraftMagnet(next)
    // arm on a motionless finger (no pointermove ⇒ no advanceDwell); the attachment itself is
    // only written on release, so moving on after arming still lets the end go free.
    if (candidate && !next.dwell.armed) planDraftTimer.current = setTimeout(() => {
      const now = planDraftMagnet.current
      if (!now || now.candidate?.key !== candidate.key) return
      setPlanDraftMagnet({ ...now, dwell: { ...now.dwell, armed: true } }); navigator.vibrate?.(12)
    }, Math.max(0, MAGNET_DWELL_MS - (Date.now() - next.dwell.since)))
  }
  const finishPlanDraftMagnet = () => {
    if (planDraftTimer.current) clearTimeout(planDraftTimer.current)
    // Ring lädt, dann schnappt es: only a CLOSED ring attaches. A stroke that ends on a symbol
    // without pausing there lands free — until 25.08. it silently coupled instead, which is the
    // invisible attachment reported from the field.
    const now = planDraftMagnet.current, c = now?.candidate
    if (now?.dwell.armed && c) {
      const key = now.atStart ? 'startAttachment' : 'endAttachment'
      if (!draftAttachments.current[key]) draftAttachments.current = { ...draftAttachments.current, [key]: planAttachmentFor(c) }
    }
    setPlanDraftMagnet(null)
  }

  // --- create-tool interactions (on the ink overlay) ---
  // every created anno carries its storey (floor) and tile-local coords; on a
  // single-sheet doc that's floor 0 and coords == board-normalized.
  const inkDown = (e: React.PointerEvent) => {
    inkPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (inkPtrs.current.size >= 2) {
      // a second finger means "pinch-zoom", not "place another point": abort an in-progress
      // freehand stroke (node/area drafts keep their tapped vertices) and start the pinch
      e.stopPropagation()
      // an aborted stroke leaves no line, so it may leave no attachment either — the start one
      // armed on pointerdown would otherwise ride along into the next line (see inkUp)
      if (tool === 'line' && lineMode === 'freehand') { setDraft(null); finishPlanDraftMagnet(); draftAttachments.current = {} }
      inkTap.current = null // a second finger → pinch-zoom, not a node tap
      inkPinch.current = inkPinchPts()?.dist ?? null
      return
    }
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    e.stopPropagation() // placement owns this pointer — don't let the stage ALSO start a board pan
    const floor = stack ? floorAt(n[1]) : 0
    const x = n[0], y = localY(n[1], floor)
    if (tool === 'line') {
      const atStart = !draft?.length
      if (atStart) draftAttachments.current = {}
      else draftAttachments.current = { ...draftAttachments.current, endAttachment: undefined }
      updatePlanDraftMagnet([x, y, floor], atStart, 'start')
    }
    if (tool === 'line' && lineMode === 'freehand') {
      // Freehand is the one create tool whose gesture IS the drag — the stroke follows the finger,
      // so it can't double as a pan. Every OTHER create tool places on a single tap (placeNode/inkUp).
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      draftFloor.current = floor
      setDraft([[x, y, floor]])
      return
    }
    // All tap-to-place tools — Maßstab, node-draw (Linie/Fläche), Text, Symbol, Trupp —
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
    // generic chips are numbered across BOTH pictures once the sheet is linked — the map's
    // «Team 1» is mirrored right here, and a second «Team 1» read as one duplicated Trupp
    const name = trupp ? trupp.name : nextTeamName([
      ...annos.filter((a) => a.kind === 'resource').map((a) => a.text),
      ...(georefFit ? (mapTwins?.content ?? []).filter((e) => e.kind === 'team').map((e) => e.label) : []),
    ])
    const color = TEAM_COLORS[teams % TEAM_COLORS.length]
    add({ id, kind: 'resource', x, y, floor, text: name, t: formatTime(new Date()), color, trail: [], truppId: trupp?.id })
    if (trupp) onLinkTrupp?.(id, trupp.id)
    setSelId(id); log('flag', fillTemplate(appConfig.copy.whiteboard.placeTeam, { name }), { annoId: id, x, y, floor })
  }
  // deferred placement for the node tools: run on a genuine tap (pointer-up without a pan). Mirrors
  // the bodies the Lage map runs on click — Maßstab nodes, node-draw vertices, Text, Symbol,
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
    if (noding) {
      // node-based Linie / Fläche: each tap drops a vertex; a double-tap (or the «Fertig» button)
      // closes the shape. Lines retain the floor below each pointer; areas stay on the first floor.
      const now = e.timeStamp
      const lt = lastTap.current
      const dbl = !!(lt && now - lt.t < 350 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 24)
      lastTap.current = { t: now, x: e.clientX, y: e.clientY }
      if (dbl) { finishShape(); return }
      if (!draft) draftFloor.current = floor
      const pointFloor = tool === 'line' ? floor : draftFloor.current
      const ly = localY(n[1], pointFloor)
      setDraft((d) => (d ? [...d, [n[0], ly, pointFloor]] : [[n[0], ly, pointFloor]]))
      return
    }
    if (tool === 'text') {
      const id = `t${Date.now()}`
      // carries whatever was chosen in the armed dock; the 'm'/off/no-colour defaults stay
      // ABSENT rather than written out, so an untouched note is byte-identical to a legacy one
      add({
        id, kind: 'text', x, y, floor, text: '',
        // a fresh note follows what gets typed into it (lib/notes · autoNoteWN); dragging the
        // width grip later ends that and the dragged width stands
        wN: autoNoteWN('', txtBase * scale * noteScale(noteDefaults.size), sW), noteAutoW: true,
        noteSize: noteDefaults.size === 'm' ? undefined : noteDefaults.size,
        notePlain: noteDefaults.plain || undefined,
        color: noteDefaults.color || undefined,
      })
      // straight into typing on the surface; the detail panel waits for the ⚙
      setSelId(id); setEditId(id); setTool('pan'); log('type', appConfig.copy.whiteboard.placeText, { annoId: id, x, y, floor })
      return
    }
    if (tool === 'symbol') {
      if (!pending) { setPaletteOpen(true); return }
      const id = `s${Date.now()}`; const s = pending
      // shared seeding (label / subtitle / fields) — identical to the Lage placement
      // path, so a plan symbol now carries the same editable structure as a map one
      add({ id, kind: 'symbol', x, y, floor, ...seedSymbolProps(s, sym.symbols) })
      onRecent(s); log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name: formatSymbolName(s) }), { annoId: id, x, y, floor })
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
      log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name }), { annoId: id, x, y, floor })
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
      if (tool === 'line') {
        const n = toNorm(e.clientX, e.clientY)
        if (n) { const floor = stack ? floorAt(n[1]) : draftFloor.current; updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], !draft?.length, 'move') }
      }
      // node tool: drag pans the board (and disqualifies the tap). 8px of slop tolerates finger
      // jitter so a still tap still places. Pan from the recorded origin, like useBoardGestures.
      const st = inkTap.current, dx = e.clientX - st.x, dy = e.clientY - st.y
      if (!st.moved && Math.hypot(dx, dy) > 8) st.moved = true
      if (st.moved) applyView(scaleRef.current, { x: st.px + dx, y: st.py + dy })
      return
    }
    if (!(tool === 'line' && lineMode === 'freehand') || !draft) return
    const n = toNorm(e.clientX, e.clientY); if (n) {
      const floor = stack ? floorAt(n[1]) : draftFloor.current
      updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], false, 'move')
      setDraft((d) => (d ? [...d, [n[0], localY(n[1], floor), floor]] : [[n[0], localY(n[1], floor), floor]]))
    }
  }
  const inkUp = (e?: React.PointerEvent) => {
    if (e) inkPtrs.current.delete(e.pointerId)
    if (inkPtrs.current.size < 2) inkPinch.current = null
    if (inkTap.current) {
      const st = inkTap.current; inkTap.current = null
      // a clean pointer-up that never panned is a tap → drop the node; a drag (moved) or a
      // pointer-cancel just leaves the panned view as-is, with no stray node placed.
      if (e && e.type === 'pointerup' && !st.moved) placeNode(e)
      finishPlanDraftMagnet()
      return
    }
    if (tool === 'line' && lineMode === 'freehand' && draft) {
      // ⚠️ The magnet is settled BEFORE the line is built. `finishPlanDraftMagnet` is what writes an
      // armed END attachment into `draftAttachments`, and `addLine` is what consumes that ref and
      // empties it — in the other order the end attachment missed its own line and was left lying
      // in the ref for whatever got drawn next.
      finishPlanDraftMagnet()
      // thin the raw stroke into a clean, editable polyline (drops the point clusters a slow finger
      // dumps at the start/end). Node-mode lines keep their explicit taps (finishShape doesn't thin).
      const px = draft.map(([x, y, floor]): [number, number] => [x * sW, mapY(floor ?? draftFloor.current, y) * sH])
      if (!isTapStroke(px)) {
        const idx = rdpIndices(px, FREEHAND_SIMPLIFY_PX)
        addLine(idx.map((i) => draft[i]))
      } else {
        // ── Abheben ist der Rückzieher ──────────────────────────────────────────────────────
        // The stroke went nowhere, so nothing may be left behind — least of all the start
        // attachment that armed the instant the finger landed on a target (lineAttachments ·
        // armDwell). Without this the next line drawn anywhere on the plan inherited it.
        draftAttachments.current = {}
      }
      setDraft(null)
    }
  }
  // create a Linie from a finished path (a freehand drag OR a node-tapped draft), baking the sticky
  // preset's arrow/marker/dash. Mirrors the Lage map's createLine, so both surfaces behave
  // identically. Returns the anno so the tap-away auto-commit (releaseDraft) can offer its undo;
  // addLine below is the interactive wrapper (select + drop to pan so the style editor opens).
  const commitLine = (pts: BoardPoint[]): BoardAnno => {
    const id = `l${Date.now()}`
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'draw', pts, floor, color, width, ...draftAttachments.current,
      ...resolveLinePreset(linePreset, dashed) } // SAME preset bundle the Lage map bakes (lib/lineStyle)
    add(anno)
    // the jump-back aims at the line's FIRST node: a Leitung can run across two floors, and the
    // end it was started from is the end the operator was standing at when the row was written
    log('pen', appConfig.copy.whiteboard.placeLine, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
    draftAttachments.current = {}
    return anno
  }
  const addLine = (pts: BoardPoint[]) => { const { id } = commitLine(pts); setSelId(id); setTool('pan') }
  // create a Fläche from a finished ring — the twin of commitLine/addLine: addArea selects it +
  // drops to pan so its draggable vertex handles are immediately usable (matches the Lage map,
  // where a finished area auto-selects for reshaping).
  // ⚠️ an area lives on ONE storey: the caller pins every vertex to the same floor.
  const commitArea = (pts: BoardPoint[]): BoardAnno => {
    const id = `a${Date.now()}`
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'area', pts, floor, color, width, dashed }
    add(anno)
    log('area', appConfig.copy.whiteboard.placeArea, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
    return anno
  }
  const addArea = (pts: BoardPoint[]) => { const { id } = commitArea(pts); setSelId(id); setTool('pan') }
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
      setDraft(null); lastTap.current = null
      addArea(d)
      return
    }
    setDraft(null); lastTap.current = null; setTool('pan')
  }
  const cancelShape = () => { setDraft(null); draftAttachments.current = {}; lastTap.current = null }

  // --- A6 (29.08.): tap-away must not silently discard a node draft -------------------------
  // live mirrors for the auto-commit toast's «Rückgängig», which fires seconds later from outside
  // any render: the same-sheet undo must act on the annos/document of NOW, not of commit time.
  const annosRef = useRef(annos); const activeIdRef = useRef(activeId); const onChangeRef = useRef(onChange)
  useEffect(() => { annosRef.current = annos; activeIdRef.current = activeId; onChangeRef.current = onChange })
  /**
   * Whatever disarms a create tool with a draft still in the hand — picking another tool, arming
   * the Georeferenz, switching the document, leaving the surface — lands here (A6, 29.08.; the
   * Lage map implements the identical contract). A committable draft (Punkte-Linie ≥2, Fläche ≥3)
   * auto-commits through the same commitLine/commitArea path the ✓ takes, with a toast whose
   * «Rückgängig» does more than delete: it hands the SHAPE back as the draft and re-arms its tool
   * — decided: undo returns the shape to the hand. A fragment below the minimum has nothing worth
   * keeping and says so in an action-less toast. Escape is deliberately NOT routed through here —
   * it is the one EXPLICIT discard (see the key handler above).
   */
  const releaseDraft = (from: BoardTool) => {
    const d = draft
    if (!d?.length) return
    // classify by the tool being LEFT. A draft under any other `from` is not this release's to
    // touch: the undo below restores a draft WHILE re-arming its tool, and that arming must not
    // read as a tap-away that eats the very shape it just handed back. The one exception is a
    // mid-stroke Freihand remnant (a keyboard tool switch during the stroke), which dies with
    // its tool exactly as before.
    const kind = from === 'area' ? 'area' : from === 'line' && lineMode === 'nodes' ? 'line' : null
    if (!kind) {
      if (from === 'line') { setDraft(null); draftAttachments.current = {}; lastTap.current = null }
      return
    }
    setDraft(null); lastTap.current = null
    if (d.length < (kind === 'area' ? 3 : 2)) {
      draftAttachments.current = {}
      toast(appConfig.copy.toolDock.draftDiscarded)
      return
    }
    const att = { ...draftAttachments.current } // commitLine consumes the ref — kept for the undo
    const planId = activeId
    const anno = kind === 'line' ? commitLine(d) : commitArea(d)
    toast(fillTemplate(appConfig.copy.toolDock.autoCommitted, { name: kind === 'line' ? appConfig.copy.drawingEditor.line : appConfig.copy.drawingEditor.area }), {
      action: {
        label: appConfig.copy.toolDock.autoCommitUndo,
        onClick: () => {
          if (activeIdRef.current === planId) {
            // still on this sheet: take the anno back and put the shape in the hand again
            setHist((m) => pushBoardPast(m, planId, annosRef.current))
            onChangeRef.current(annosRef.current.filter((a) => a.id !== anno.id))
            emit('board.delete', { id: anno.id, planId })
            draftAttachments.current = att
            draftFloor.current = d[0]?.[2] ?? 0
            setDraft(d)
            if (kind === 'line') setLineMode('nodes')
            // pre-set the release's memory so re-arming the tool is not itself a tap-away
            prevTool.current = kind === 'line' ? 'line' : 'area'
            setTool(kind === 'line' ? 'line' : 'area')
          } else {
            // the document was left mid-toast: the anno still comes off its own sheet (through
            // this closure, which still points there), but a draft cannot be handed back onto a
            // document that is no longer open
            setHist((m) => pushBoardPast(m, planId, [...annos, anno]))
            onChange(annos)
            emit('board.delete', { id: anno.id, planId })
          }
        },
      },
    })
  }
  // re-point the leave-document release every commit (see releaseRef above for why a ref), and
  // release on a TOOL change — declared here, below the commit machinery the release needs.
  useEffect(() => { releaseRef.current = releaseDraft })
  useEffect(() => {
    const from = prevTool.current
    prevTool.current = tool
    if (from !== tool) releaseDraft(from)
    lastTap.current = null
  }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- single freehand-stroke select + drag (tap the fat hit-line in WbInkLayer, pan mode) ---
  const drawDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan' || readOnly) return
    // locked (BoardAnno.locked): the ink is click-through, so a big Sektor-Fläche stops swallowing
    // the taps meant for the work on top of it. NOT stopPropagation'd — the tap goes on to the
    // stage and does what an empty-canvas tap does, which is the map's behaviour too. The lock
    // chip over it is the only tap target it still has.
    if (annos.find((x) => x.id === id)?.locked) return
    e.stopPropagation()
    // «Leitung wählen» is armed on the Atemschutz board: this tap assigns the line to that Trupp
    // instead of selecting it. Read-only surfaces never get here (the guard above), so a viewer
    // can't link anything.
    if (onPickLine) { onPickLine(id); return }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for a stroke
    // too big for its bounds to mean anything (lib/panelNudge · panelNudgeSelection). Client px,
    // the same space the nudge's box is built in.
    setAnnoTap({ id, x: e.clientX, y: e.clientY })
    setSelId(id); setSelIds([])
    const a = annos.find((x) => x.id === id); if (!a || (a.kind !== 'draw' && a.kind !== 'area')) return
    // snapshot the vertices in board-space (y mapped to the stacked board), so the delta is always
    // applied to the original geometry — no drift across re-renders (mirrors the group-move math)
    drawDrag.current = { id, floor: a.floor ?? 0, sx: e.clientX, sy: e.clientY,
      bpts: (a.pts ?? []).map(([x, y, floor]): BoardPoint => [x, mapY(floor ?? a.floor, y), floor ?? a.floor ?? 0]), moved: false }
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
    const a = annos.find((x) => x.id === st.id)
    patch(st.id, { pts: st.bpts.map(([x, by, floor], i): BoardPoint => {
      if ((i === 0 && a?.startAttachment) || (i === st.bpts.length - 1 && a?.endAttachment)) return a?.pts?.[i] ?? [x, localY(by, floor ?? st.floor), floor ?? st.floor]
      const pf = floor ?? st.floor
      return [x + ndx, localY(by + ndy, pf), pf]
    }) })
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
    const endpoint: LineEndpoint | null = a.kind === 'draw' && idx === 0 ? 'start' : a.kind === 'draw' && idx === a.pts.length - 1 ? 'end' : null
    if (endpoint) {
      const resolved = resolvedPts.get(a.id) ?? a.pts
      const attached = !!(endpoint === 'start' ? a.startAttachment : a.endAttachment)
      setPlanEndpointDrag({ id: a.id, endpoint, point: resolved[idx], origin: resolved[idx], attached, detach: 0, dwell: EMPTY_DWELL, candidate: null })
    }
    vertDrag.current = { id: a.id, idx, floor: a.floor ?? 0, moved: false }
  }
  const vertMove = (e: React.PointerEvent) => {
    const st = vertDrag.current; if (!st) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    const magnetic = planEndpointDrag.current
    if (magnetic) {
      const floor = stack ? floorAt(n[1]) : st.floor
      const point: BoardPoint = [n[0], localY(n[1], floor), floor]
      const pointer: [number, number] = [n[0] * sW, n[1] * sH]
      if (planDwellTimer.current) clearTimeout(planDwellTimer.current)
      st.moved = true
      // Still hooked up? Then the only thing on offer is letting go, and the red ring at the OLD
      // socket runs on distance: pull past the detach radius and the link is off; stop short and
      // release, and it springs back. Mirrors the Lage map's moveEndpointDrag exactly.
      if (magnetic.attached) {
        const o = magnetic.origin
        const detach = detachProgress([o[0] * sW, mapY(o[2] ?? 0, o[1]) * sH], pointer)
        setPlanEndpointDrag({ ...magnetic, point, detach, attached: detach < 1, candidate: null, dwell: EMPTY_DWELL })
        if (detach >= 1) navigator.vibrate?.(12)
        return
      }
      const targets = planCandidatesAt(st.id, pointer)
      const candidate = stickyMagneticTarget(pointer, targets, magnetic.candidate?.key ?? null)
      const dwell = advanceDwell(magnetic.dwell, candidate?.key ?? null, Date.now())
      setPlanEndpointDrag({ ...magnetic, point, candidate, dwell })
      // a finger that has found its target stops moving — and then nothing but this timer can
      // close the ring (the visible fill is its CSS twin)
      if (candidate && !dwell.armed) planDwellTimer.current = setTimeout(() => {
        const cur = planEndpointDrag.current
        if (!cur || cur.candidate?.key !== candidate.key) return
        setPlanEndpointDrag({ ...cur, dwell: { ...cur.dwell, armed: true } }); navigator.vibrate?.(12)
      }, Math.max(0, MAGNET_DWELL_MS - (Date.now() - dwell.since)))
      return
    }
    if (!st.moved) { pushPast(); st.moved = true }
    const floor = stack ? floorAt(n[1]) : st.floor
    patch(st.id, { pts: (annos.find((a) => a.id === st.id)?.pts ?? []).map((p, i): BoardPoint => (i === st.idx ? [n[0], localY(n[1], floor), floor] : p)) })
  }
  const vertUp = () => {
    const st = vertDrag.current; vertDrag.current = null
    const magnetic = planEndpointDrag.current
    if (magnetic && st?.moved) {
      if (planDwellTimer.current) clearTimeout(planDwellTimer.current)
      const a = annos.find((x) => x.id === magnetic.id)
      if (a?.pts) {
        // Ring lädt, dann schnappt es: ONLY a closed ring attaches, and only a closed RELEASE ring
        // (`attached` already flipped false mid-drag) frees an endpoint that had a link. Anything
        // in between — let go while either ring was still filling — leaves the endpoint where the
        // finger dropped it, or springs it back to the socket it never left.
        const floor = magnetic.point[2] ?? 0
        let attachment: LineAttachment | undefined
        let endPt = magnetic.point
        if (magnetic.dwell.armed && magnetic.candidate) {
          const target = magnetic.candidate.target
          attachment = { target, routing: magnetic.candidate.defaultRouting ?? 'direct', ...(target.kind === 'line' ? { port: magnetic.candidate.port ?? nextFreePort(attachmentLines, target.id, target.endpoint) ?? undefined } : {}) }
          if (sW && sH) endPt = [magnetic.candidate.point[0] / sW, localY(magnetic.candidate.point[1] / sH, floor), floor]
        } else if (magnetic.attached) { setPlanEndpointDrag(null); return }  // ring never closed → snap back, no change
        const pts = a.pts.map((p, i): BoardPoint => i === (magnetic.endpoint === 'start' ? 0 : a.pts!.length - 1) ? endPt : p)
        patchCommit(a.id, { pts, ...(magnetic.endpoint === 'start' ? { startAttachment: attachment } : { endAttachment: attachment }) })
      }
      setPlanEndpointDrag(null)
      return
    }
    setPlanEndpointDrag(null)
    if (st?.moved) emit('board.edit', { id: st.id, planId: activeId })
  }
  /**
   * Grow the line past one of its open ends: append a point where the finger is, then hand the
   * gesture straight over to the ordinary vertex drag so the new point follows until release.
   * One undo step (pushPast once, at the start) — the same shape a reshape has.
   */
  const extendLine = (end: 'start' | 'end', e: React.PointerEvent) => {
    if (tool !== 'pan') return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const a = annos.find((x) => x.id === selId); const pts = a?.pts; if (!a || !pts) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    const floor = a.kind === 'draw' && stack ? floorAt(n[1]) : (a.floor ?? 0)
    const point: BoardPoint = [n[0], localY(n[1], floor), floor]
    pushPast()
    const next = end === 'start' ? [point, ...pts] : [...pts, point]
    patch(a.id, { pts: next })
    // …and from here it IS a vertex drag: `moved` is already true, so vertMove streams and
    // vertUp commits exactly as if the node had always been there.
    vertDrag.current = { id: a.id, idx: end === 'start' ? 0 : next.length - 1, floor, moved: true }
  }

  /**
   * Insert a node on the segment after vertex `idx` (at its midpoint) — and then hand the SAME
   * press over to the ordinary vertex drag, exactly as `extendLine` does, so the new node follows
   * the finger until it lifts. Letting go without moving leaves the node at the midpoint, which is
   * what a plain tap on the «+» always left. One undo step (pushPast once, at the start).
   */
  const insertVertex = (idx: number, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    e.stopPropagation()
    const a = annos.find((x) => x.id === selId); const pts = a?.pts; if (!a || !pts) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const n = toNorm(e.clientX, e.clientY)
    const floor = a.kind === 'draw' && n && stack ? floorAt(n[1]) : (a.floor ?? 0)
    const next = pts[(idx + 1) % pts.length] // wraps for the closing edge of an area
    const mid: BoardPoint = n ? [n[0], localY(n[1], floor), floor] : [(pts[idx][0] + next[0]) / 2, (pts[idx][1] + next[1]) / 2, floor]
    pushPast()
    patch(a.id, { pts: [...pts.slice(0, idx + 1), mid, ...pts.slice(idx + 1)] })
    // …and from here it IS a vertex drag: `moved` is already true, so vertMove streams and vertUp
    // commits — the new node never gets a chance to look like something you have to find again.
    vertDrag.current = { id: a.id, idx: idx + 1, floor, moved: true }
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

  // --- vertex editing of the IN-PROGRESS node draft (A3, 29.08.) — the same grip/insert/hold
  // vocabulary a finished shape gets (WbDraftHandles), wired straight into the draft points and
  // never into the document: the draft is still ephemeral state until it commits. ---
  const draftVert = useRef<{ idx: number } | null>(null)
  const draftVertDown = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    draftVert.current = { idx }
  }
  const draftVertMove = (e: React.PointerEvent) => {
    const st = draftVert.current; if (!st) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    // a Linie's node follows the pointer's storey (a Leitung may cross floors); a Fläche stays
    // on the floor its ring was started on — the same rule placeNode applies to a fresh tap
    const floor = tool === 'line' && stack ? floorAt(n[1]) : draftFloor.current
    setDraft((d) => d?.map((p, i): BoardPoint => (i === st.idx ? [n[0], localY(n[1], floor), floor] : p)) ?? d)
  }
  const draftVertUp = () => { draftVert.current = null }
  /** Insert a node on draft segment `idx` and keep the SAME press dragging it — the twin of
   *  insertVertex on a committed shape (releasing without moving leaves it where it appeared). */
  const draftInsert = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const n = toNorm(e.clientX, e.clientY)
    const floor = tool === 'line' && n && stack ? floorAt(n[1]) : draftFloor.current
    setDraft((d) => {
      if (!d) return d
      const b = d[(idx + 1) % d.length] // wraps for the closing edge of an area draft
      const mid: BoardPoint = n ? [n[0], localY(n[1], floor), floor] : [(d[idx][0] + b[0]) / 2, (d[idx][1] + b[1]) / 2, floor]
      return [...d.slice(0, idx + 1), mid, ...d.slice(idx + 1)]
    })
    draftVert.current = { idx: idx + 1 }
  }
  // hold-to-delete a draft node — allowed all the way down: deleting the last node leaves no
  // draft at all, the same empty hand Escape leaves
  const draftDeleteVertex = (idx: number) => {
    draftVert.current = null
    setDraft((d) => { const next = d?.filter((_, i) => i !== idx) ?? null; return next?.length ? next : null })
  }

  // --- chip dragging (resource / symbol / text in pan mode) ---
  const chipDown = (e: React.PointerEvent, id: string) => {
    if (tool !== 'pan') return
    // Notiz-Grammatik (29.08., unified with symbols across Karte AND Plan): tapping a note opens
    // its detail panel, exactly as tapping a symbol opens its ContextPanel — the ⚙ grip that used
    // to be the panel's only door is gone. Not while the note is mid-edit (its textarea owns the
    // taps then), and never on placement: placeNode arms editId, not this.
    const isNote = annos.find((x) => x.id === id)?.kind === 'text'
    if (readOnly) {
      // view-only (viewer / replay / EL view): a tap still SELECTS — so the read-only
      // detail panel can open, parity with the Lage map — but never arms a drag
      e.stopPropagation()
      setSelId(id); setSelIds([])
      if (isNote) setNotePanelId(id)
      return
    }
    e.stopPropagation()
    chipDrag.current = { id, moved: false, sx: e.clientX, sy: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setSelId(id); setSelIds([])
    if (isNote && editId !== id) setNotePanelId(id)
  }
  const chipMove = (e: React.PointerEvent) => {
    if (!chipDrag.current) return
    const a = annos.find((x) => x.id === chipDrag.current!.id); if (!a) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    // deadzone (shared with the Lage map's hold-to-drag): don't move until the pointer travels
    // past DRAG_DEADZONE_PX, so a tap-to-select can't nudge a placed chip a pixel.
    if (!chipDrag.current.moved && Math.hypot(e.clientX - chipDrag.current.sx, e.clientY - chipDrag.current.sy) < DRAG_DEADZONE_PX) return
    if (!chipDrag.current.moved) pushPast() // one checkpoint per drag, before the first move
    chipDrag.current.moved = true
    // on the floor-stack the chip drags FREELY across storeys: the floor follows the cursor,
    // y is re-localised into whichever storey the pointer is over. Single-sheet docs unchanged.
    const f = stack ? floorAt(n[1]) : a.floor
    const point: BoardPoint = [n[0], localY(n[1], f ?? 0), f ?? 0]
    set(annos.map((anno) => {
      if (anno.id === chipDrag.current!.id) return { ...anno, x: point[0], y: point[1], ...(stack ? { floor: point[2] } : {}) }
      if (anno.kind !== 'draw' || !anno.pts?.length) return anno
      let next = anno
      for (const endpoint of ['start', 'end'] as const) {
        const rel = endpoint === 'start' ? next.startAttachment : next.endAttachment
        if (rel?.target.kind === 'object' && rel.target.id === a.id && rel.routing === 'trace') next = { ...next, pts: applyRouting(next.pts!, endpoint, point, 'trace', 0.002) }
      }
      return next
    }))
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
    annos.filter((line) => [line.startAttachment, line.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === d.id && rel.routing === 'trace'))
      .forEach((line) => emit('board.edit', { id: line.id, patch: { pts: line.pts }, planId: activeId }))
  }

  // object-manipulation hand-off for the stage dispatcher in useBoardGestures: when no
  // pan/pinch/marquee gesture owns the pointer, route move/up to the active chip/draw/vertex
  // drag (each no-ops if its ref is null — same fall-through the inline dispatcher had).
  const manipMove = (e: React.PointerEvent) => {
    if (chipDrag.current) chipMove(e)
    else if (drawDrag.current) drawMove(e)
    else if (vertDrag.current) vertMove(e)
    else if (draftVert.current) draftVertMove(e)
    // once an object is really travelling (past the shared deadzone), the phone detail sheet
    // peeks down to its grip line so the board isn't reduced to a strip — lib/sheetPeek
    if (chipDrag.current?.moved || drawDrag.current?.moved || vertDrag.current?.moved) beginSheetPeek()
  }
  const manipUp = () => { endSheetPeek(); chipUp(); drawUp(); vertUp(); draftVertUp() }

  // pan / pinch-zoom / marquee multi-select + the shared stage pointer dispatcher live in
  // useBoardGestures; object manipulation is reached through manipMove/manipUp above.
  const { marquee, stageDown, stageMove, stageUp, trackDown, trackUp } = useBoardGestures({
    tool, annos, setSelId, setSelIds, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp,
  })

  // --- drag-to-rotate a selected directional symbol (rotor handle) ---
  // angle from the glyph centre to the pointer becomes the rotation (+90° so the
  // top knob leads); the whole gesture is one undo step (checkpoint on first move).
  const rotDown = (e: React.PointerEvent, id: string, mode: 'rotate' | 'rotate2' | 'resize' | 'cage' | 'width' = 'rotate') => {
    if (tool !== 'pan' || readOnly) return
    e.stopPropagation()
    const anno = (e.currentTarget as HTMLElement).closest('.wb-anno')
    const glyph = (anno?.querySelector('.ts, .shape-glyph') ?? anno) as HTMLElement | null
    if (!glyph) return
    const r = glyph.getBoundingClientRect()
    const a = annos.find((x) => x.id === id)
    rotate.current = {
      id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false, mode,
      rot: a?.rotation ?? 0,
      free: mode === 'resize' && a?.kind === 'shape' && SHAPE_FREE_ASPECT[a.shape ?? 'square'],
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const rotMove = (e: React.PointerEvent) => {
    const st = rotate.current; if (!st) return
    if (!st.moved) { pushPast(); st.moved = true } // one checkpoint per rotate/resize gesture
    if (st.mode === 'resize') {
      if (st.free) {
        // free-aspect corner drag (Rechteck / Rauch): the pointer offset, rotated into the
        // shape's own frame, sets width from |dx| and height from |dy| independently —
        // identical maths to the map's resize (MapMarkers · shapeMove), in plan space
        const rad = (-st.rot * Math.PI) / 180
        const dx = e.clientX - st.cx, dy = e.clientY - st.cy
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
        const wN = Math.max(0.03, Math.min(0.9, (2 * Math.abs(lx)) / sW))
        const hN = Math.max(0.03, Math.min(0.9, (2 * Math.abs(ly)) / sW))
        patch(st.id, { sizeN: wN, aspect: Math.max(0.2, Math.min(5, Math.round((hN / wN) * 100) / 100)) })
        return
      }
      // corner grip = half-diagonal from the glyph centre → full width, normalized to the
      // (scaled) plan width — same maths as the map's shape resize, in plan space
      const dist = Math.hypot(e.clientX - st.cx, e.clientY - st.cy)
      patch(st.id, { sizeN: Math.max(0.03, Math.min(0.9, (dist * Math.SQRT2) / sW)) })
      return
    }
    if (st.mode === 'width') {
      // note text box: the grip sits on the RIGHT edge of a centre-anchored box, so the pointer
      // distance from the centre is half the width. Normalized against the (scaled) plan width
      // so the box keeps its proportion at every zoom — and prints at that same proportion.
      patch(st.id, { wN: clampNoteWN((2 * Math.abs(e.clientX - st.cx)) / sW), noteAutoW: undefined })
      return
    }
    if (st.mode === 'cage') {
      // Hubretter cage tip: one handle sets the boom bearing (rotation2, no offset — the handle IS the
      // tip) AND the reach as a fraction of the (scaled) plan width — the plan analogue of reachM.
      const deg = (Math.atan2(e.clientY - st.cy, e.clientX - st.cx) * 180) / Math.PI
      const dist = Math.hypot(e.clientX - st.cx, e.clientY - st.cy)
      patch(st.id, { rotation2: Math.round(((deg % 360) + 360) % 360), reachN: Math.max(0.03, Math.min(0.6, dist / sW)) })
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
    const patchOut = st.mode === 'resize' ? { sizeN: a.sizeN, aspect: a.aspect }
      : st.mode === 'width' ? { wN: a.wN }
      : st.mode === 'cage' ? { rotation2: a.rotation2, reachN: a.reachN }
      : st.mode === 'rotate2' ? { rotation2: a.rotation2 } : { rotation: a.rotation }
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
  // Recolouring a team chip recolours the TRUPP, not just this chip: colour is the Trupp's
  // identity (board card, Lage marker, plan chip all read it), so writing only the chip would
  // leave two disagreeing answers to «which one is this?» — and the next re-placement would
  // silently undo the change. onTruppColor is absent on surfaces with no Atemschutz board.
  const recolorTeam = (c: string) => {
    if (!selId) return
    patchCommit(selId, { color: c })
    const truppId = annos.find((a) => a.id === selId)?.truppId
    if (truppId) onTruppColor?.(truppId, c)
  }

  // a team that carries recorded positions is protected from deletion — its trail
  // is part of the incident record, so it must be cleared deliberately first
  const teamLocked = (a: BoardAnno) => a.kind === 'resource' && (a.trail?.length ?? 0) > 0

  const removeWithConnections = async (target: BoardAnno) => {
    if (teamLocked(target)) { toast(appConfig.copy.whiteboard.deleteLocked, { icon: 'warn', tone: 'warn' }); return }
    const affected = annos.flatMap((a) => (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && ((rel.target.kind === 'object' && rel.target.id === target.id) || (rel.target.kind === 'line' && rel.target.id === target.id)) ? [{ a, endpoint, rel }] : []
    }))
    if (!affected.length) { await removeAnno(target); return }
    const ok = await confirmDialog({
      title: fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: target.label ?? target.text ?? appConfig.copy.drawingEditor.drawing }),
      message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }),
      confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    const changed = new Set(affected.map((x) => x.a.id))
    commit(annos.filter((a) => a.id !== target.id).map((a) => {
      let next = a
      for (const endpoint of ['start', 'end'] as const) {
        const rel = endpoint === 'start' ? next.startAttachment : next.endAttachment
        if (!rel || rel.target.id !== target.id || !next.pts?.length) continue
        const resolvedSource = renderAnnos.find((x) => x.id === next.id)?.pts
        const fallback: BoardPoint = resolvedSource?.[endpoint === 'start' ? 0 : resolvedSource.length - 1] ?? next.pts[endpoint === 'start' ? 0 : next.pts.length - 1]
        const pts = next.pts.map((p, i): BoardPoint => i === (endpoint === 'start' ? 0 : next.pts!.length - 1) ? fallback : p)
        next = { ...next, pts, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      return next
    }))
    emit('board.delete', { id: target.id, planId: activeId })
    changed.forEach((id) => {
      const source = annos.find((a) => a.id === id)
      if (!source?.pts) return
      let next = source
      for (const { endpoint } of affected.filter((x) => x.a.id === id)) {
        const resolvedSource = renderAnnos.find((x) => x.id === next.id)?.pts
        const fallback: BoardPoint = resolvedSource?.[endpoint === 'start' ? 0 : resolvedSource.length - 1] ?? next.pts![endpoint === 'start' ? 0 : next.pts!.length - 1]
        next = { ...next, pts: next.pts!.map((p, i): BoardPoint => i === (endpoint === 'start' ? 0 : next.pts!.length - 1) ? fallback : p), ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      emit('board.edit', { id, patch: { pts: next.pts, startAttachment: next.startAttachment, endAttachment: next.endAttachment }, planId: activeId })
    })
    if (selId === target.id) setSelId(null)
  }

  // --- marquee group: a single move grip + delete at the combined centre (≥2 selected),
  // mirroring the Lage map's group handles. Both point annos and freehand drawings join. ---
  // centroid in board-normalized space (point anchors + every draw vertex)
  const groupCentroid = (() => {
    if (selIds.length < 2) return null
    let sx = 0, sy = 0, n = 0
    for (const a of annos) {
      if (!selIds.includes(a.id)) continue
      if (a.kind === 'draw') { for (const [x, y, floor] of a.pts ?? []) { sx += x; sy += mapY(floor ?? a.floor, y); n++ } }
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
        ? { id: a.id, floor: a.floor ?? 0, bpts: (a.pts ?? []).map(([x, y, floor]): BoardPoint => [x, mapY(floor ?? a.floor, y), floor ?? a.floor ?? 0]) }
        : { id: a.id, floor: a.floor ?? 0, bx: a.x ?? 0, by: mapY(a.floor, a.y ?? 0) },
    )
  }
  const grpMove = (e: React.PointerEvent) => {
    const st = groupMove.current; if (!st) return
    beginSheetPeek()
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    // move within each anno's own storey (floor unchanged), consistent with the flat map group-move
    set(annos.map((a) => {
      const o = groupOrig.current.find((g) => g.id === a.id); if (!o) return a
      if (o.bpts) return { ...a, pts: o.bpts.map(([x, by, floor], i): BoardPoint => {
        if ((i === 0 && a.startAttachment) || (i === o.bpts!.length - 1 && a.endAttachment)) return a.pts?.[i] ?? [x, localY(by, floor ?? o.floor), floor ?? o.floor]
        const pf = floor ?? o.floor
        return [x + ndx, localY(by + ndy, pf), pf]
      }) }
      return { ...a, x: (o.bx ?? 0) + ndx, y: localY((o.by ?? 0) + ndy, o.floor) }
    }))
  }
  const grpUp = () => {
    endSheetPeek()
    if (!groupMove.current) return
    groupMove.current = null
    annos.filter((a) => selIds.includes(a.id)).forEach((a) => emit('board.move', { id: a.id, x: a.x, y: a.y, floor: a.floor, planId: activeId }))
  }
  // group delete — removes the selection, but trail-carrying teams are protected (their
  // recorded trail is part of the incident record); those stay selected.
  const deleteGroup = async () => {
    const removable = selIds.filter((id) => { const a = annos.find((x) => x.id === id); return !!a && !teamLocked(a) })
    if (!removable.length) return
    const affected = annos.flatMap((a) => removable.includes(a.id) ? [] : (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && removable.includes(rel.target.id) ? [{ a, endpoint, rel }] : []
    }))
    if (affected.length) {
      const ok = await confirmDialog({ title: appConfig.copy.whiteboard.groupDeleteTitle, message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    commit(annos.filter((a) => !removable.includes(a.id)).map((a) => {
      let next = a
      for (const endpoint of ['start', 'end'] as const) {
        const rel = endpoint === 'start' ? next.startAttachment : next.endAttachment
        if (!rel || !removable.includes(rel.target.id) || !next.pts?.length) continue
        const resolvedSource = renderAnnos.find((x) => x.id === next.id)?.pts
        const fallback: BoardPoint = resolvedSource?.[endpoint === 'start' ? 0 : resolvedSource.length - 1] ?? next.pts[endpoint === 'start' ? 0 : next.pts.length - 1]
        const pts = next.pts.map((p, i): BoardPoint => i === (endpoint === 'start' ? 0 : next.pts!.length - 1) ? fallback : p)
        next = { ...next, pts, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      return next
    }))
    removable.forEach((id) => emit('board.delete', { id, planId: activeId }))
    setSelIds((ids) => ids.filter((id) => !removable.includes(id)))
    setSelId(null)
    log('close', removable.length > 1
      ? fillTemplate(appConfig.copy.whiteboard.groupDeletedN, { n: removable.length })
      : appConfig.copy.whiteboard.groupDeleted)
  }

  const planWorkRect = (canvas: DOMRect, panelEl?: Element | null): NudgeBox => {
    // The default fitted view already reserves these permanent lanes; use the same geometry for
    // focus so “centre” never means underneath a rail or the floating top bar.
    const surface = {
      minX: canvas.left + side.l, maxX: canvas.right - side.r,
      minY: canvas.top + TOP_INSET, maxY: canvas.bottom,
    }
    if (!panelEl) return visibleWorkRect(surface, null, false)
    const panel = panelEl.getBoundingClientRect()
    if (!panel.width) return visibleWorkRect(surface, null, false)
    const obstruction = { minX: panel.left, maxX: panel.right, minY: panel.top, maxY: panel.bottom }
    return visibleWorkRect(surface, obstruction, isBottomSheet(panel.width, canvas.width))
  }

  // pan (no zoom change) so a normalized plan point lands at the centre of the unobscured work area
  const centerOnPoint = (x: number, y: number, floor: number) => {
    const s = scaleRef.current, w = fit.w * s, h = fit.h * s
    const canvas = canvasRef.current?.getBoundingClientRect()
    if (!w || !h || !canvas) return
    const my = mapY(floor, y)
    const target = rectCenter(planWorkRect(canvas, document.querySelector('.ctx')))
    const baseX = canvas.left + canvas.width / 2 + (side.l - side.r) / 2
    const baseY = canvas.top + canvas.height / 2 + TOP_INSET / 2
    applyView(s, {
      x: target.x - baseX - (x - 0.5) * w,
      y: target.y - baseY - (my - 0.5) * h,
    })
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
      const canvas = canvasRef.current?.getBoundingClientRect()
      const panelEl = document.querySelector('.ctx')
      if (!a || !rect?.width || !canvas || !panelEl) return
      const work = planWorkRect(canvas, panelEl)
      // anchored annos (symbol/text/resource) give one point; a draw/area gives its whole
      // vertex set — the box nudge clears the full extent (map parity), capped so an
      // extent wider than the open area never slides fully off the stage.
      const norm: BoardPoint[] = a.pts?.length ? a.pts : a.x != null && a.y != null ? [[a.x, a.y]] : []
      if (!norm.length) return
      const pts = norm.map(([px, py, pf]) => ({ x: rect.left + px * rect.width, y: rect.top + mapY(pf ?? a.floor, py) * rect.height }))
      const box = {
        minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
      }
      // a note text box is anchored at its CENTRE but occupies a real width — nudging on the
      // anchor alone would leave the long half of a wide note sitting under the panel
      if (a.kind === 'text') {
        const half = (noteWN(a.wN) * rect.width) / 2
        box.minX -= half; box.maxX += half
      }
      const tap = annoTap?.id === selId ? { x: annoTap.x, y: annoTap.y } : null
      const nudge = nudgeSelectionIntoRect(box, tap, work)
      if (nudge) applyView(scaleRef.current, { x: posRef.current.x - nudge[0], y: posRef.current.y - nudge[1] })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, notePanelId])

  // A map-owned twin's editor occupies the same .ctx space as a real annotation. Keep the
  // projected glyph itself inside the padded work area when it opens.
  useEffect(() => {
    if (!viewedTwin) return
    const raf = requestAnimationFrame(() => {
      const rect = boardRef.current?.getBoundingClientRect()
      const canvas = canvasRef.current?.getBoundingClientRect()
      const panelEl = document.querySelector('.ctx')
      if (!rect?.width || !canvas || !panelEl) return
      const point = { x: rect.left + viewedTwin.pt.x * rect.width, y: rect.top + viewedTwin.pt.y * rect.height }
      const nudge = nudgePointIntoRect(point, planWorkRect(canvas, panelEl))
      if (nudge) applyView(scaleRef.current, { x: posRef.current.x - nudge[0], y: posRef.current.y - nudge[1] })
    })
    return () => cancelAnimationFrame(raf)
  }, [viewedTwin?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // report the current view centre (tile-local x/y + floor) upward so the journal
  // composer can pin an entry to "here" on the plan. Cheap — just a ref write.
  useEffect(() => {
    if (!fit.w || !fit.h) return
    const s = scaleRef.current, w = fit.w * s, h = fit.h * s
    const nx = clamp01((w / 2 - pos.x) / w), ny = clamp01((h / 2 - pos.y) / h)
    const floor = stack ? floorAt(ny) : 0
    onView?.({ x: nx, y: stack ? localY(ny, floor) : ny, floor })
  }, [pos, scale, fit.w, fit.h, activeId, stack, N]) // eslint-disable-line react-hooks/exhaustive-deps

  // a Verlauf row asked to revisit a plan point. Apply once per request (tracked
  // by nonce); if it arrives mid mode-switch before the stage is measured, the
  // fit deps re-run this once fit lands. Declared after the activeId reset effect
  // so it wins when both fire in the same render.
  const appliedFocus = useRef(0)
  // `focus.flash` asks to SHOW an anno rather than open it: outlined for a few seconds, nothing
  // selected. «Leitung zeigen» on an Atemschutz card uses it — the operator wants to know where
  // the hose is, not to edit it, and a selected line puts draggable nodes under their finger.
  const [flashId, setFlashId] = useState<string | null>(null)
  useEffect(() => {
    if (!focus || focus.nonce === appliedFocus.current || !fit.w || !fit.h) return
    setTool('pan')
    if (focus.annoId && focus.flash) setFlashId(focus.annoId)
    else if (focus.annoId) setSelId(focus.annoId)
    if (focus.twinEntityId) {
      const twin = [...twinVehicles, ...twinSymbols].find((t) => t.entityId === focus.twinEntityId)
      if (twin) setTwinView(twin)
    }
    // Selection mounts its panel as state settles. Measure on the next frame so an explicit
    // “show” centres in the space that remains visible, not under the newly opened panel.
    requestAnimationFrame(() => centerOnPoint(focus.x, focus.y, focus.floor))
    appliedFocus.current = focus.nonce
  }, [focus, fit.w, fit.h]) // eslint-disable-line react-hooks/exhaustive-deps
  // the outline fades out on its own — it is a pointing gesture, not a state
  useEffect(() => {
    if (!flashId) return
    const t = setTimeout(() => setFlashId(null), appConfig.drawing.flashMs)
    return () => clearTimeout(t)
  }, [flashId])

  const pickSymbol = (name: string) => { setPending(name); setPendingShape(null); setTool('symbol'); setPaletteOpen(false); onRecent(name) }
  const pickShape = (kind: ShapeKind) => { setPendingShape(kind); setPending(null); setTool('shape'); setPaletteOpen(false) }
  const selResource = annos.find((a) => a.id === selId && a.kind === 'resource')
  /**
   * A Plan may show Ebenen BESIDE its selected object's details on tablet/desktop. That is useful
   * here in a way it is not on the Lage: the layer list explains which Karte/Plan projection the
   * selected object belongs to. 06-contextpanel.css gives the pair separate horizontal slots.
   *
   * A phone cannot fit two bottom sheets. There the old one-slot rule remains: Ebenen temporarily
   * hides the detail panel without dropping `selId` / `twinView`, so closing it restores the same
   * selected object and halo. `tool === 'pan'` remains the long-standing selection-only gate.
   */
  const detailPanelVisible = !layersOn || !isPhone
  const editorSlotFree = !twinView && detailPanelVisible && tool === 'pan'
  // a selected plan symbol gets the SAME editor as the map (label / fields / notes /
  // count / rotation) — floor is omitted because on the plan it's the tile, not a badge
  const selSymbol = annos.find((a) => a.id === selId && a.kind === 'symbol')
  // A note reaches the SAME ContextPanel, and since 29.08. a TAP opens it (chipDown) — the
  // symbol grammar, on both surfaces. `notePanelId` stays separate from `selId` for the one
  // exception: a freshly PLACED note goes straight into typing without the panel in the way.
  const selNote = annos.find((a) => a.id === notePanelId && a.kind === 'text')
  // the panel belongs to the SELECTED note: deselecting (empty canvas, Esc, picking something
  // else) closes it too, so a stray panel can never outlive the thing it describes
  useEffect(() => { if (notePanelId && selId !== notePanelId) setNotePanelId(null) }, [selId, notePanelId])
  // reaching for a tool means you are done reading this note — the panel should not sit there
  // while you place the next thing (selection alone doesn't change until that thing lands)
  useEffect(() => { if (tool !== 'pan') setNotePanelId(null) }, [tool])
  // …and the same for a Zwilling's details, plus one more reason: the twin is a projection of
  // ANOTHER sheet's fit, so switching plan or arming the pairing mode makes the panel describe
  // something that is no longer on screen.
  useEffect(() => { setTwinView(null) }, [tool, activeId, georefArmed])
  // a selected stroke / Linie / Fläche — drives the shared DrawEditor (style + presets) panel
  const selDraw = annos.find((a) => a.id === selId && (a.kind === 'draw' || a.kind === 'area'))
  // Explicit detach for a plan line endpoint (the × chip on the canvas + the Verbindung lösen button
  // in the editor both call this) — materialize the endpoint at its resolved point, drop the link.
  const detachPlanEndpoint = (endpoint: LineEndpoint) => {
    if (!selDraw?.pts?.length) return
    const a = endpoint === 'start' ? selDraw.startAttachment : selDraw.endAttachment
    if (!a) return
    // resolved endpoint (where it visually sits, on the target)
    const resolved = renderAnnos.find((x) => x.id === selDraw.id)?.pts ?? selDraw.pts
    const idx = endpoint === 'start' ? 0 : selDraw.pts.length - 1
    const here = resolved[idx] ?? selDraw.pts[idx]
    const nb = resolved[endpoint === 'start' ? 1 : resolved.length - 2] ?? here
    // retract ~0.02 board units toward its own body so it visibly pops off the target
    const dx = nb[0] - here[0], dy = nb[1] - here[1], len = Math.hypot(dx, dy) || 1
    const off: BoardPoint = [here[0] + (dx / len) * 0.02, here[1] + (dy / len) * 0.02, here[2] ?? selDraw.floor ?? 0]
    const pts = selDraw.pts.map((p, i): BoardPoint => (i === idx ? off : p))
    patchCommit(selDraw.id, { pts, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) })
  }
  // a selected generic shape — colour via the same ShapeEditor sheet as the Lage map
  const selShape = annos.find((a) => a.id === selId && a.kind === 'shape')

  /**
   * «Richtung umkehren» on the plan — the twin of the Lage's useMapDrawing · reverseDrawing, built
   * on the SAME rule (lib/lineAttachments · flipLine): the point order turns around so the
   * Abschluss and the end tag move to the other end, the drawn line stays exactly where it is, and
   * every attachment — this line's own two AND every other line hooked to one of its ends — keeps
   * the coordinate it was sitting on. One `commit` = one undo step for all of it.
   * (The end tag's own nudge, `endDx`/`endDy`, is a RELATIVE offset from wherever the tag belongs,
   * so unlike the Lage's absolute `endLabelAt` it survives the flip unchanged.)
   */
  const reverseAnno = () => {
    if (!selDraw?.pts || selDraw.pts.length < 2 || selDraw.kind !== 'draw') return
    const lines = annos.filter((a) => a.kind === 'draw' && (a.pts?.length ?? 0) >= 2)
      .map((a) => ({ id: a.id, points: a.pts!, startAttachment: a.startAttachment, endAttachment: a.endAttachment }))
    const flip = flipLine({ id: selDraw.id, points: selDraw.pts, startAttachment: selDraw.startAttachment, endAttachment: selDraw.endAttachment }, lines)
    commit(annos.map((a) => {
      if (a.id === selDraw.id) return { ...a, pts: flip.points, startAttachment: flip.startAttachment, endAttachment: flip.endAttachment }
      const mine = flip.incoming.filter((i) => i.lineId === a.id)
      return mine.reduce((acc, i) => ({ ...acc, [i.endpoint === 'start' ? 'startAttachment' : 'endAttachment']: i.attachment }), a)
    }))
    emit('board.edit', { id: selDraw.id, patch: { pts: flip.points, startAttachment: flip.startAttachment, endAttachment: flip.endAttachment }, planId: activeId })
    flip.incoming.forEach((i) => emit('board.edit', { id: i.lineId, patch: { [i.endpoint === 'start' ? 'startAttachment' : 'endAttachment']: i.attachment }, planId: activeId }))
  }

  const changePlanEnding = async (ending: 'none' | 'arrow' | 'arrowStop' | 'teilstueck') => {
    if (!selDraw) return
    const incoming = selDraw.teilstueck && ending !== 'teilstueck' ? annos.flatMap((a) => (['start', 'end'] as const).filter((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel?.target.kind === 'line' && rel.target.id === selDraw.id && rel.target.endpoint === 'end'
    }).map((endpoint) => ({ id: a.id, endpoint }))) : []
    if (incoming.length) {
      const ok = await confirmDialog({ title: appConfig.copy.drawingEditor.endingTeilstueck, message: fillTemplate(appConfig.copy.drawingEditor.removeEMessage, { n: incoming.length }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    const resolved = renderAnnos.find((a) => a.id === selDraw.id)?.pts
    const fallback = resolved?.[resolved.length - 1] ?? selDraw.pts?.[selDraw.pts.length - 1]
    commit(annos.map((a) => {
      if (a.id === selDraw.id) return { ...a, arrow: ending === 'arrow' || ending === 'arrowStop' || undefined, arrowStop: ending === 'arrowStop' || undefined, teilstueck: ending === 'teilstueck' || undefined }
      let next = a
      for (const endpoint of ['start', 'end'] as const) {
        if (!fallback || !incoming.some((x) => x.id === a.id && x.endpoint === endpoint) || !next.pts?.length) continue
        const pts = next.pts.map((p, i): BoardPoint => i === (endpoint === 'start' ? 0 : next.pts!.length - 1) ? fallback : p)
        next = { ...next, pts, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      return next
    }))
    emit('board.edit', { id: selDraw.id, patch: { arrow: ending === 'arrow' || ending === 'arrowStop' || undefined, arrowStop: ending === 'arrowStop' || undefined, teilstueck: ending === 'teilstueck' || undefined }, planId: activeId })
    incoming.forEach(({ id, endpoint }) => {
      const line = annos.find((a) => a.id === id)
      if (!line?.pts || !fallback) return
      const pts = line.pts.map((p, i): BoardPoint => i === (endpoint === 'start' ? 0 : line.pts!.length - 1) ? fallback : p)
      emit('board.edit', { id, patch: { pts, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }, planId: activeId })
    })
  }


  // removing a storey is frictionless when empty, but a floor that carries any
  // annotation (even a single team trace) must be confirmed before it's dropped
  const removeFloor = async (f: number) => {
    if (readOnly) return
    const hasContent = annos.some((a) => (a.floor ?? 0) === f || a.pts?.some((p) => (p[2] ?? a.floor ?? 0) === f) || a.trail?.some((p) => (p.floor ?? a.floor ?? 0) === f))
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
      if (a.pts) next.pts = a.pts.map((p): BoardPoint => { const [x, y] = mv([p[0], p[1]]); return p[2] == null ? [x, y] : [x, y, p[2]] })
      if (a.trail) next.trail = a.trail.map((tp) => { const [x, y] = mv([tp.x, tp.y]); return { ...tp, x, y } })
      return next
    })
    commit(remapped) // re-glued annotations go through undo/redo + sync
    onReorient({ ...building, northUp: nextNorthUp, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect })
    emit('building.reorient', { northUp: nextNorthUp, planId: activeId })
  }

  // WHICH object's plans these are, on the surface the plans are used — the one thing about a
  // plan set that cannot be read off any of its pages. It sits at the top-left of the stage,
  // beside the module tabs in the rail, so the tab strip and the name of what it lists are one
  // glance apart; it opens the same PlanPicker the [[O]] shortcut does. It is a floating chip
  // rather than a header row because the stage is deliberately full-bleed (the plan pans up
  // behind the top bar), and a solid bar would take that away from every plan to state
  // something that changes once an Einsatz.
  // It sits in the stage's BOTTOM-LEFT pill row beside the Maßstab and wears that pill, so the
  // two read-outs about «what am I looking at» share one corner — it used to be a hero-elevated
  // card in the TOP-left, stating from the corner of the plan that is actually looked at a thing
  // that changes once an Einsatz.
  // ⚠️ The READ-OUT and the SWITCH are two different things, and gating both on `onObjectSwitch`
  // meant the one session that is bound to a single object — a link-scoped viewer — was the only
  // one never told which object it is looking at. It reads either way; it is only tappable when
  // there is somewhere to tap to.
  // the ADDRESS, not the name: «Mühlemattstrasse 8» is shorter than «Schloss Bottmingen» and is
  // what the Einsatz is called by. The name is still what the picker and its toast say, because
  // that is where an object is searched for. Name is the fallback when there is no address.
  const objectChipName = objectAddress ?? objectName ?? appConfig.copy.whiteboard.objectNone
  // The chip is dropped whole on exactly two surfaces. The Gebäude tile (both faces — outline
  // picker and floor stack) already answers «welches Gebäude» with the chip right beside it,
  // which walks to the picker that changes it; the object read-out only repeated that in a
  // second pill nobody could act on. The blank Tafel has no plan for it to be about at all.
  // Everywhere else it stays: on a plan page nothing else names the object the sheet belongs to.
  // Field feedback 25.08.
  const objectChipHidden = osm || !!active.floorStack || active.id === 'tafel'
  const objectChip = objectChipHidden ? null : (
    <button
      type="button"
      className="wb-scale-chip wb-object"
      // «Objekt» named the field, which is the one thing the value already says — a plan set
      // belongs to an Einsatzobjekt and nothing else in this corner is a place name. The chevron
      // went with it: everywhere else in this app it opens a popover under the control, and here
      // it opened a full modal with a search field and a map. What is left is the fact itself.
      // The verb lives in the label a screen reader reads, where it was missing entirely.
      aria-label={onObjectSwitch
        ? fillTemplate(appConfig.copy.whiteboard.objectSwitch, { name: objectChipName })
        : fillTemplate(appConfig.copy.whiteboard.objectIs, { name: objectChipName })}
      title={onObjectSwitch ? appConfig.copy.whiteboard.objectSwitchShort : undefined}
      disabled={!onObjectSwitch}
      onClick={onObjectSwitch}
    >
      <Icon id="footprint" />
      <span>{objectChipName}</span>
    </button>
  )

  // ── The way between the two faces of the ONE «Gebäude» tile ────────────────────────────────
  // The rail lists one entry for the outline picker and the floor stack (lib/useObjectPlans ·
  // railPlanTiles), so «ich will ein anderes Gebäude» needs a door — and it belongs HERE, in the
  // row that already answers «was schaue ich an» (Objekt · Maßstab), not as a second rail tile
  // that would put the mechanism back in the navigation it was just taken out of.
  // Only ever shown on the two surfaces it is about, and only once there is somewhere to go:
  // on the stack it opens the picker, on the picker (with a stack behind it) it goes back.
  // ⚠️ Pure navigation, so a viewer/locked session gets it too — it changes nothing. Replacing
  // the building is still the picker's own act, with its confirm-and-undo (IncidentWorkspace ·
  // onSelectBuilding); this chip only walks there.
  const buildingChip = onBuildingFace && (stack || (osm && building)) ? (
    <button
      type="button"
      className="wb-scale-chip wb-building"
      aria-label={stack ? appConfig.copy.whiteboard.replaceBuilding : appConfig.copy.whiteboard.backToBuilding}
      title={stack ? appConfig.copy.whiteboard.replaceBuilding : appConfig.copy.whiteboard.backToBuilding}
      onClick={() => onBuildingFace(stack ? 'pick' : 'stack')}
    >
      <Icon id={stack ? 'footprint' : 'floors'} />
      <span>{stack ? appConfig.copy.whiteboard.replaceBuilding : appConfig.copy.whiteboard.backToBuilding}</span>
    </button>
  ) : null

  // Viewer-only plan (e.g. PV / documentation PDF): bypass the annotation board entirely and
  // show a plain, natively-scrolling multi-page PDF viewer — no tools, no stitched pan/zoom board.
  if (active?.viewer && active.imageUrl) {
    // .whiteboard is already `position:absolute; inset:0` (a containing block for the
    // absolutely-positioned scroller) — don't override it, or the container collapses to 0 height.
    return (
      <div className="whiteboard">
        {/* a viewer-only document is still one of THIS object's plans — the chip belongs on it
            too, or the read-out would blink out on exactly the plans nobody can annotate. No
            Maßstab beside it here: there is nothing to calibrate on a document. */}
        <div className="wb-botleft">{objectChip}</div>
        <PdfScroller key={active.id} url={planUrl(active.imageUrl)} />
      </div>
    )
  }

  return (
    // ⚠️ `wb-georef-split` is what the app's ONE live map keys off (09-whiteboard.css): the board
    // gives up the right half and the map that was hidden behind it becomes visible again. No
    // second map instance — this one already carries every layer, every symbol and the operator's
    // own framing. Not on a phone: there the surfaces take turns instead (lib/georefMode).
    <div className={`whiteboard${georefArmed ? ' wb-georef-armed' : ''}${georefArmed && georef.check ? ' wb-georef-check' : ''}${georefArmed && !georef.check && !isPhone ? ' wb-georef-split' : ''}`}>
      {/* the plan DOCUMENTS are picked in the global left NavRail (it is pure navigation); the
          object they all belong to is named on the chip in the bottom-left corner */}
      {/* plan canvas + annotation layer */}
      <div className="wb-stage" ref={stageRef}>
        <div
          ref={setCanvas}
          className={`wb-canvas tool-${tool} ${pending || pendingShape ? 'placing' : ''}`}
          // capture-phase bookkeeping FIRST — it sees the fingers a chip's own handler
          // swallows, which is what makes the two-finger gesture work on a busy board.
          // ⚠️ The twin-panel dismissal must NOT fire for a press on a twin mark itself: capture
          // runs before TwinMark can stop anything, so an unguarded setTwinView(null) here
          // deselected the twin at the exact pointerdown that was meant to DRAG it — the halo
          // vanished, `onMove` was withdrawn mid-gesture, and «twins cannot be moved» was the
          // whole visible story. A press starting on the mark keeps the selection; any other
          // press still dismisses (that is what makes tapping empty paper close the panel).
          onPointerDownCapture={(e) => { if (!(e.target as HTMLElement | null)?.closest?.('[data-twin]')) setTwinView(null); trackDown(e) }}
          onPointerUpCapture={trackUp}
          onPointerCancelCapture={trackUp}
          onPointerDown={(e) => { if (!(e.target as HTMLElement | null)?.closest?.('[data-twin]')) setTwinView(null); stageDown(e) }}
          onPointerMove={stageMove}
          onPointerUp={stageUp}
          onPointerCancel={stageUp}
        >
          <div
            ref={boardRef}
            className={`wb-board ${blank ? 'wb-board-blank' : ''}`}
            // the reserved lanes are not symmetric (the rails differ), so the centre shifts by half
            // their difference — exactly what TOP_INSET / 2 already does for the top bar
            style={{ width: sW || undefined, height: sH || undefined, transform: `translate(-50%, -50%) translate(${pos.x + (side.l - side.r) / 2}px, ${pos.y + TOP_INSET / 2}px)` }}
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
                      label); the needle + N point at true north for the auto-rotated footprint.
                      ⚠️ Geometry copied from the printed dial (backend · kroki · north_dial_svg):
                      the screen and the two printed pages carried three different north marks.
                      The N sits INSIDE the ring and the needle is a dart in ink, which is the
                      one that survived print review. */}
                  {/* …and the dial IS the orientation toggle where one exists: the compass is
                      what the eye consults about the building's rotation, so it is where the
                      finger goes to change it. The rail-footer button stays — two doors, one
                      room. Read-only / unrotated footprints keep the plain read-out. */}
                  {idx === 0 && fpView && (() => {
                    const dial = (
                      <svg viewBox="-25 -25 50 50" className={canOrient && !readOnly ? undefined : 'wb-north-dial'} aria-hidden>
                        <title>{appConfig.copy.whiteboard.northTitle}</title>
                        <circle r="24" className="wb-north-ring" />
                        <g style={{ transform: `rotate(${viewAngle}deg)`, transformOrigin: '0px 0px' }}>
                          <text y="-13" className="wb-north-n">{appConfig.copy.whiteboard.northLabel}</text>
                          <path d="M0 -8 L10 16 L0 7 L-10 16 Z" className="wb-north-needle" />
                        </g>
                      </svg>
                    )
                    if (!(canOrient && !readOnly)) return dial
                    const label = building?.northUp ? appConfig.copy.whiteboard.orientLongAxis : appConfig.copy.whiteboard.orientNorthUp
                    return (
                      <button type="button" className="wb-north-dial wb-north-btn" title={label} aria-label={label}
                        aria-pressed={!!building?.northUp}
                        onPointerDown={(e) => e.stopPropagation()} onClick={reorient}>
                        {dial}
                      </button>
                    )
                  })()}
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
              /* the ONE interaction this surface has. Gated on the ROLE's read-only (viewer / EL /
                 locked / replay) — NOT on `readOnly`, which is true here for everybody by design
                 (see selectOnly above); picking a building is the whole point of the sheet. */
              // the building already in the stack is handed down so the picker can find it among the
              // live footprints and start it SELECTED — «Anderes Gebäude wählen» is almost always
              // «ergänzen». A building saved without a georeference has nothing to match on and
              // still starts empty, which `replacing` then says out loud.
              <OsmOutline key={active.id} center={osm.center} radiusM={osm.radiusM} onAspect={setAspect}
                interactive={!readOnlyProp} replacing={!!building}
                preselectSrc={building?.geo ? building.src : undefined} preselectGeo={building?.geo}
                onPick={onSelectBuilding} />
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
            <WbInkLayer annos={renderAnnos} draft={draft} draftFloor={draftFloor.current} draftClosed={tool === 'area'} color={color} width={width} dashed={dashed} hiddenTrails={hiddenTrails} mapY={mapY}
              selId={selId} flashId={flashId} networkIds={[...relationship.lineIds]} onPickDraw={tool === 'pan' ? drawDown : undefined}
              truppTones={truppTones} />
            {/* «Ring lädt, dann schnappt es» — the identical pair the Lage map draws: a blue chip
                BESIDE the target whose ring is the remaining dwell (only a full one attaches), and
                its red twin at the socket an attached endpoint is being pulled out of (only a full
                one releases). The key carries `since`, so re-entering the same target restarts the
                CSS fill. Cycle-forming targets never make the candidate list, so no blocked state.
                The explicit «Verbindung lösen» chip on a selected endpoint stays as it was. */}
            {planEndpointDragState?.candidate && (
              <span key={`${planEndpointDragState.candidate.key}:${planEndpointDragState.dwell.since}`} className="magnet-anchor wb-magnet"
                style={{ left: planEndpointDragState.candidate.point[0], top: planEndpointDragState.candidate.point[1] }}>
                <ConnectRing since={planEndpointDragState.dwell.since} armed={planEndpointDragState.dwell.armed} />
              </span>
            )}
            {planEndpointDragState?.attached && planEndpointDragState.detach > DETACH_SHOW_PROGRESS && (
              <span className="magnet-anchor wb-magnet"
                style={{ left: planEndpointDragState.origin[0] * sW, top: mapY(planEndpointDragState.origin[2] ?? 0, planEndpointDragState.origin[1]) * sH }}>
                <NodeDeleteChip tone="release" progress={planEndpointDragState.detach} />
              </span>
            )}
            {planDraftMagnetState?.candidate && (
              <span key={`${planDraftMagnetState.candidate.key}:${planDraftMagnetState.dwell.since}`} className="magnet-anchor wb-magnet"
                style={{ left: planDraftMagnetState.candidate.point[0], top: planDraftMagnetState.candidate.point[1] }}>
                <ConnectRing since={planDraftMagnetState.dwell.since} armed={planDraftMagnetState.dwell.armed} />
              </span>
            )}

            {/* line arrowheads · repeated marker letters · free-text label + distance — rendered in
                board px (the ink SVG is stretched 1×1 and would distort them). Same feature set +
                spacing math as the Lage map (markerParamsAlong / —R— rhythm); the metric distance
                read-out now works too, once the plan is calibrated (lib/planScale). One per Linie. */}
            {renderAnnos.filter((a) => a.kind === 'draw' && (a.arrow || a.marker || a.label || a.showDistance || hasLineDecor(a)) && (a.pts?.length ?? 0) >= 2).map((a) => {
              const p = a.pts!
              const bpx = p.map(([x, y, floor]) => [x * sW, mapY(floor ?? a.floor, y) * sH] as [number, number])
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
              // the Atemschutz-Trupp on this Leitung (anchor or number) and how it is doing
              const lineTrupp = truppForLine(a, trupps)
              const lineTone = lineTrupp ? truppLineTone(lineTrupp, truppSeverities?.[lineTrupp.id] ?? 0) : 'idle'
              const distM = a.showDistance ? planMetres(a.pts!.map(([x, y]) => [x, y])) : null
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
                      {/* the «Stopp»: the Entwicklungsgrenze bar just past the tip, like the fire's */}
                      {a.arrowStop && <path transform={`rotate(${ang})`} d={`M4,${-ahw * 1.3} L4,${ahw * 1.3}`} stroke="currentColor" strokeWidth={Math.max(3, (a.width ?? 5) * 0.9)} strokeLinecap="round" fill="none" />}
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
                  {(a.content || a.lineNo != null || a.floorTag != null || lineTrupp) && (() => {
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
                        <EndTag
                          lineNo={a.lineNo} content={a.content} floorTag={a.floorTag}
                          trupp={lineTrupp ? truppTagText(lineTrupp) : undefined} tone={lineTone}
                          color={color}
                        />
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
                centroid in board px (the 1×1 ink SVG would distort text). Draggable like a line label.
                «Auf Karte zeigen» prints the Fläche above it, exactly as the line label above prints
                its Länge — the switch existed for a plan area but nothing rendered what it turned on. */}
            {renderAnnos.filter((a) => a.kind === 'area' && (a.label || a.showDistance) && (a.pts?.length ?? 0) >= 3).map((a) => {
              const bpx = a.pts!.map(([x, y, floor]) => [x * sW, mapY(floor ?? a.floor, y) * sH] as [number, number])
              const cx = bpx.reduce((s, q) => s + q[0], 0) / bpx.length
              const cy = bpx.reduce((s, q) => s + q[1], 0) / bpx.length
              const areaLines: string[] = []
              if (a.showDistance) {
                const m2 = calibrated && activeScale ? polyAreaM2(a.pts!.map(([x, y]) => [x, y]), activeScale.mPerU, measureAR) : null
                areaLines.push(m2 != null ? fmtArea(m2) : appConfig.copy.whiteboard.scale.needsCalibration)
              }
              if (a.label) areaLines.push(a.label)
              return (
                <span key={`al-${a.id}`} className="wb-line-label wb-area-label"
                  style={{ left: 0, top: 0, transform: `translate(${cx + (a.labelDx ?? 0) * sW}px, ${cy + (a.labelDy ?? 0) * sH}px) translate(-50%, -50%)`, cursor: tool === 'pan' ? 'move' : undefined }}
                  onPointerDown={tool === 'pan' ? (e) => labelDown(e, a.id, a.labelDx ?? 0, a.labelDy ?? 0) : undefined}
                  onPointerMove={tool === 'pan' ? labelMove : undefined}
                  onPointerUp={tool === 'pan' ? labelUp : undefined}
                  onPointerCancel={tool === 'pan' ? labelUp : undefined}>{areaLines.map((t, j) => <div key={j}>{t}</div>)}</span>
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

            {/* ⚠️ No Messen overlay any more — the Messen TOOL left the Plan on 29.08.
                (deliberate Lage↔Plan divergence; see the rail filter above and usePlanMeasure).
                The Maßstab preview above and every calibrated read-out below stay. */}

            {/* vertex editing for a selected line/area — node drag / insert / delete (one shared
                code path for Linie + Fläche). A many-point freehand stroke used to be skipped here
                entirely and so could not be reshaped at all; WbVertexHandles now thins its own
                grips instead (mirrors the map's cap). */}
            {selDraw && tool === 'pan' && (
              <WbVertexHandles anno={renderAnnos.find((a) => a.id === selDraw.id) ?? selDraw} sW={sW} sH={sH} mapY={mapY}
                onVertexDown={vertDown} onInsert={insertVertex} onDeleteVertex={deleteVertex} onExtend={extendLine} />
            )}
            {/* unlock chip on every locked line/area — the click-through ink's only tap target,
                a SHORT HOLD to unlock + select (the Lage's twin, MapView · LockChip). Its only job
                is unlocking, so it stays away where editing is locked anyway. Position mirrors the
                map: an area is chipped at its centroid, a line at its middle vertex. */}
            {!readOnly && tool === 'pan' && renderAnnos.filter((a) => a.locked && (a.kind === 'draw' || a.kind === 'area') && a.pts?.length).map((a) => {
              const pts = a.pts!
              const p = a.kind === 'area'
                ? [pts.reduce((t, q) => t + q[0], 0) / pts.length, pts.reduce((t, q) => t + mapY(q[2] ?? a.floor, q[1]), 0) / pts.length] as const
                : [pts[Math.floor((pts.length - 1) / 2)][0], mapY(pts[Math.floor((pts.length - 1) / 2)][2] ?? a.floor, pts[Math.floor((pts.length - 1) / 2)][1])] as const
              return (
                <span key={`lk${a.id}`} className="wb-lock-anchor" style={{ left: p[0] * sW, top: p[1] * sH }}>
                  <LockChip onUnlock={() => { patchCommit(a.id, { locked: undefined }); setSelId(a.id) }} />
                </span>
              )
            })}
            {/* explicit detach: a × chip beside a connected endpoint of the selected line — dragging
                the node only moves/re-targets (never severs), so this is how a link is broken. */}
            {selDraw?.kind === 'draw' && tool === 'pan' && !planEndpointDragState && (['start', 'end'] as const).map((ep) => {
              const rel = ep === 'start' ? selDraw.startAttachment : selDraw.endAttachment
              const pts = renderAnnos.find((a) => a.id === selDraw.id)?.pts ?? selDraw.pts
              if (!rel || !pts || pts.length < 2) return null
              const p = ep === 'start' ? pts[0] : pts[pts.length - 1]
              return (
                <span key={`detach-${ep}`} className="line-detach-chip wb-magnet" role="button"
                  title={appConfig.copy.drawingEditor.detachConnection} aria-label={appConfig.copy.drawingEditor.detachConnection}
                  style={{ left: p[0] * sW + 16, top: mapY(p[2] ?? selDraw.floor, p[1]) * sH - 16 }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); detachPlanEndpoint(ep) }}><Icon id="close" /></span>
              )
            })}

            {/* point annotations: symbol / text / resource */}
            {annos.filter((a) => a.kind !== 'draw').map((a) => (
              <div
                key={a.id}
                className={`wb-anno wb-${a.kind}${relationship.objectIds.has(a.id) ? ' network' : ''} ${selId === a.id || selIds.includes(a.id) ? 'sel' : ''}`}
                // transform positions the anchor at the (scaled) plan point. Symbols
                // and text scale WITH the plan via numeric sizing below (crisp, since
                // the board is layout-scaled); team pills stay a constant size.
                // a shape's --gpx (→ halo/handle anchor --hbox) takes the LARGER box side so the
                // selection ring always encloses a stretched rectangle (width × width·aspect)
                style={{ left: 0, top: 0, transform: `translate(${(a.x ?? 0) * sW}px, ${mapY(a.floor, a.y ?? 0) * sH}px) translate(-50%, -50%)`, ['--gpx' as string]: `${a.kind === 'shape' ? (a.sizeN ?? 0.1) * sW * Math.max(1, shapeAspect(a.shape ?? 'square', a.aspect)) : symBase * scale}px` }}
                onPointerDown={(e) => chipDown(e, a.id)}
                // double-tap still opens the on-surface textarea; the panel steps aside so the
                // two editors for one text never stream keystrokes side by side
                onDoubleClick={(e) => { if ((a.kind === 'text' || a.kind === 'resource') && tool === 'pan') { e.stopPropagation(); setEditId(a.id); setSelId(a.id); if (a.kind === 'text') setNotePanelId(null) } }}
              >
                {relationship.objectIds.has(a.id) && selId !== a.id && <span className="network-halo" />}
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
                  const comp = annoComposite(a)
                  const hub = isHubretter(a.symbol)
                  const svg = veh ? vehicleSymbolSvg(a.label ?? '', a.rotation ?? 0)
                    : comp ? (sym.byName[comp.base] ?? '')
                    : hub ? (sym.byName[appConfig.symbols.vehicleName] ?? '')   // plain body; the boom is drawn separately
                    : (placardSvgForSymbol(a.symbol, a.fields) ?? (a.symbol ? sym.byName[luefterVariant(a.symbol, a.extract)!] ?? sym.byName[a.symbol] ?? '' : ''))
                  // a composite stacks its part (fan / ladder) as a separately-rotatable overlay aimed
                  // by rotation2; the Lüfter's extract (Absaugen) swaps to the reversed-arrow fan.
                  const overlay = comp ? { svg: sym.byName[compositePartGlyph(comp, a.extract)] ?? sym.byName[comp.part] ?? '', rotation: a.rotation2 ?? 0, scale: comp.scale } : undefined
                  // Hubretter boom: variable-reach articulated arm mounted on the turntable (drawn ON
                  // TOP of the body), sized as a fraction of the plan width (reachN), aimed by rotation2.
                  const boomPx = hub ? Math.max(12, (a.reachN ?? 0.12) * sW) : 0
                  return (
                    <>
                      <TacticalSymbol
                        svg={svg}
                        sizePx={symBase * scale}
                        rotation={veh ? 0 : (a.rotation ?? 0)}
                        overlay={overlay}
                        // the signed Stockwerk badge, same slot and same glyph as on the Lage.
                        // `storey`, never `floor` — that one is the stack's tile index.
                        floor={a.storey}
                        floorFrom={a.floorFrom}
                        floorTo={a.floorTo}
                        spread={a.spread}
                        count={a.count}
                        // a vehicle's NAME is already in the glyph — symbolCaptionText drops it and
                        // keeps the rest (Fahrer, eigene Felder, Notizen), which only 'Alle' prints
                        // …and the seams come with it: .sym-caption wraps on both surfaces now,
                        // and German breaks by syllable unless the curated table is asked first.
                        caption={(() => { const c = symbolCaptionText(a, captionMode); return c ? softHyphenateText(c) : c })()}
                        className="ts-plan"
                      />
                      {/* boom AFTER the body → paints on top (mounted on the turntable / roof) */}
                      {hub && <HubretterBoom lengthPx={boomPx} deg={a.rotation2 ?? 0} />}
                    </>
                  )
                })()}
                {a.kind === 'shape' && (
                  // same glyphs + sizing model as the map: the silhouette scales with the
                  // plan (width = sizeN × plan width, height = width × aspect) and rotates as a whole
                  <div className="shape-glyph" style={{ width: (a.sizeN ?? 0.1) * sW, height: (a.sizeN ?? 0.1) * sW * shapeAspect(a.shape ?? 'square', a.aspect), transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    <ShapeGlyph kind={a.shape ?? 'square'} color={a.color ?? '#1f6feb'} stop={a.stop} />
                  </div>
                )}
                {a.kind === 'text' && (() => {
                  // every note is a wrapping box; a stored note with no width falls back to the
                  // default. Font size = plan-scaled base × the size-slider step.
                  // colour applies in both looks — see the twin in MapMarkers for why it did not
                  const tinted = !a.notePlain && !!a.color
                  const cls = (base: string) => `${base} box${a.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}`
                  const style = {
                    fontSize: txtBase * scale * noteScale(a.noteSize), width: noteWN(a.wN) * sW,
                    ...(a.color ? (a.notePlain ? { color: a.color } : { '--note-tint': a.color }) : null),
                  } as React.CSSProperties
                  return editId === a.id
                    ? <textarea className={cls('wb-text-input')} ref={focusOnce} value={a.text} placeholder={appConfig.copy.whiteboard.textPlaceholder} rows={1} style={style}
                        onPointerDown={(e) => e.stopPropagation()}
                        // stream each keystroke live into the note (silent — checkpoint once on the
                        // first edit), so the text shows as you type and the note never vanishes
                        onChange={(e) => {
                          if (textEditId.current !== a.id) { textEditId.current = a.id; pushPast() }
                          const v = e.target.value
                          patch(a.id, { text: v, ...(a.noteAutoW ? { wN: autoNoteWN(v, txtBase * scale * noteScale(a.noteSize), sW) } : null) })
                          autoGrow(e.currentTarget)
                        }}
                        // finalise on blur: keep the note even if empty (a placed note must persist,
                        // mirroring the Lage map) and record one audit edit for the whole session
                        onBlur={(e) => {
                          setEditId(null)
                          if (textEditId.current !== a.id) return
                          textEditId.current = null
                          emit('board.edit', { id: a.id, patch: { text: e.target.value }, planId: activeId })
                          // …and the Verlauf gets what it SAYS, not that a note exists (parity with
                          // the Lage's map notes, lib/entityEdit). Once per editing session, on the
                          // way out — a row per keystroke would be a wall.
                          const v = e.target.value.replace(/\s+/g, ' ').trim()
                          const was = (a.text ?? '').replace(/\s+/g, ' ').trim()
                          if (v !== was) {
                            log('type', v
                              ? fillTemplate(appConfig.copy.log.noteWritten, { value: v })
                              : appConfig.copy.log.notesCleared)
                          }
                        }}
                        // Enter makes a new line — the ✓, Esc and tapping away are the way out
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
                    : <span className={cls('wb-text-label')} style={style}>{a.text || appConfig.copy.whiteboard.text}</span>
                })()}
                {/* ✓ Fertig — Enter makes a new line, so a gloved hand needs a visible way out
                    (tap-away works but isn't discoverable) */}
                {a.kind === 'text' && editId === a.id && (
                  <button className="note-done" title={appConfig.copy.notes.done} aria-label={appConfig.copy.notes.done}
                    // pointerdown (not click): the textarea's blur would unmount this button first
                    onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); setEditId(null) }}><Icon id="check" /></button>
                )}
                {a.kind === 'resource' && (() => {
                  // a chip linked to a Trupp that's been marked «raus» (Atemschutz board)
                  // dims + strikes through, so the plan reflects that the team is out.
                  const isRaus = !!a.truppId && trupps.some((t) => t.id === a.truppId && t.status === 'raus')
                  const teamCol = a.color || TEAM_COLORS[0]
                  // parity with the Lage map: a compact dot + name at rest, expanding to the full
                  // pill (cap · rename · time badge) only when the team is selected.
                  if (selId !== a.id) {
                    return (
                      <span className={`team-dot ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                        <i /><b>{a.text}</b>
                      </span>
                    )
                  }
                  return (
                  <span className={`wb-resource-pill ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as React.CSSProperties}>
                    <span className="wb-resource-cap" />
                    <span className="wb-resource-body">
                      <span className="wb-resource-name">
                        {editId === a.id
                          ? <input className="wb-resource-input" ref={focusOnce} defaultValue={a.text}
                              onPointerDown={(e) => e.stopPropagation()}
                              onBlur={(e) => { patchCommit(a.id, { text: e.target.value || a.text }); setEditId(null) }}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                          : <b>{a.text}</b>}
                        {isRaus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
                      </span>
                      <i className="wb-resource-time">{a.t}</i>
                    </span>
                  </span>
                  )
                })()}
                {/* selected team — one tidy action bar under the pill instead of two
                    corner orbs. Delete is locked once the team has a recorded trail. */}
                {a.kind === 'resource' && selId === a.id && tool === 'pan' && !readOnly && (
                  <div className="wb-pill-acts" onPointerDown={(e) => e.stopPropagation()}>
                    {/* rename — the touch path (double-tap→dblclick is unreliable on iOS). A
                        Trupp-bound chip gets no pen, the same rule the map marker follows: its name
                        is the TRUPP's, written on the Atemschutz board, and renaming it here would
                        fork the two apart. Now that the chip can be joined to a Trupp from its own
                        menu (above), that state is reachable from here too. */}
                    {!a.truppId && (
                      <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit} onClick={() => setEditId(a.id)}><Icon id="pen" /></button>
                    )}
                    {a.truppId && onShowTrupp && (
                      <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp} onClick={() => onShowTrupp(a.truppId!)}><Icon id="warn" /></button>
                    )}
                    {/* «Atemschutz-Trupp» — the chip's half of the join, the exact twin of the map
                        marker's menu (MapMarkers) and of the line editor's «Gehört zu Trupp …»:
                        the app's own menu, never a native <select>. Until this existed, a chip put
                        down on Modul 1 before anybody was registered could only be joined from the
                        AT card — and joining it from the picture, where you are looking, meant
                        deleting the chip and re-placing it, which threw its recorded trail away.
                        Takeover of somebody else's chip asks first, in the ONE place that ask lives
                        (useTruppActions · adoptTruppMarker). ⚠️ A Trupp that is already out is
                        offered only when it is the one standing here — it is the record of who was,
                        not somebody to send. */}
                    {onTeamTrupp && (!!a.truppId || trupps.some((t) => !t.removedAt && t.status !== 'raus')) && (
                      <Menu
                        popupClassName="de-menu-pop"
                        itemClassName={() => 'de-menu-item'}
                        trigger={
                          <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
                            <Icon id="people" />
                          </button>
                        }
                        items={[
                          { label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={!a.truppId} />, onClick: () => onTeamTrupp(a.id, undefined) },
                          ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === a.truppId)).map((t) => ({
                            label: <MenuPick label={t.name} on={t.id === a.truppId} />,
                            onClick: () => onTeamTrupp(a.id, t.id),
                          })),
                        ]}
                      />
                    )}
                    <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition} onClick={markPosition}><Icon id="flag" /></button>
                    {/* per-team trail visibility toggle — deletion of the record itself
                        lives behind the lock's confirmed clear, never one tap */}
                    {(a.trail?.length ?? 0) > 0 && (() => {
                      const shown = !hiddenTrails.has(a.id)
                      return (
                        <button className="wb-pa" title={shown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
                          aria-label={appConfig.copy.whiteboard.trails} aria-pressed={shown} onClick={() => toggleTrail(a.id)}>
                          <Icon id={shown ? 'eye' : 'eyeoff'} />
                        </button>
                      )
                    })()}
                    {teamLocked(a)
                      ? <button className="wb-pa wb-pa-del-off" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked} onClick={() => void clearTrail()}><Icon id="trash" /></button>
                      : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={() => void removeWithConnections(a)}><Icon id="trash" /></button>}
                  </div>
                )}
                {a.kind === 'resource' && selId === a.id && tool === 'pan' && (() => {
                  const connected = annos.filter((line) => [line.startAttachment, line.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === a.id))
                  return connected.length > 0 ? <div className="wb-resource-connections ctx-connections" onPointerDown={(e) => e.stopPropagation()}>
                    <span className="ctx-section-label">{appConfig.copy.drawingEditor.connectedLines.replace('{n}', String(connected.length))}</span>
                    {connected.map((line) => <button key={line.id} onClick={() => setSelId(line.id)}><span>{lineLabel(line)}</span><span className="ctx-conn-go" aria-hidden>›</span></button>)}
                  </div> : null
                })()}
                {/* ⚠️ No floating ✕ on a selected symbol/shape and no grips row on a selected
                    note any more (D2 + Notiz-Grammatik, 29.08.): a tap opens the detail panel,
                    and Löschen lives there — one delete per object, behind one door, instead of
                    a bare ✕ hovering a mis-tap away from the thing it destroys. The team pill's
                    trash and the multi-select group trash stay (decided): both are guarded
                    (trail lock / connection confirm) and have no panel of their own. */}
                {/* right-edge width grip — a text box only. A one-line note has nothing to drag:
                    its width IS its text, and the box shape is what «Zu Textfeld» hands out. */}
                {a.kind === 'text' && selId === a.id && tool === 'pan' && !readOnly && (
                  <button className="note-wgrip" title={appConfig.copy.notes.resizeHint} aria-label={appConfig.copy.notes.resizeHint}
                    onPointerDown={(e) => rotDown(e, a.id, 'width')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp}
                    onClick={(e) => e.stopPropagation()}><Icon id="resize" /></button>
                )}
                {/* generic shape: tethered rotor knob + corner resize grip, identical to the
                    Lage map — both rotate with the shape so the handles stay attached */}
                {a.kind === 'shape' && selId === a.id && tool === 'pan' && !readOnly && (() => {
                  // CSS anchors the knob/grip off a SQUARE --hbox; a stretched shape overrides
                  // them inline so the knob rides the real top edge and the grip the real
                  // corner (identical to the Lage map — MapMarkers' shape rotor)
                  const hbW = Math.max((a.sizeN ?? 0.1) * sW, 56)
                  const hbH = Math.max((a.sizeN ?? 0.1) * sW * shapeAspect(a.shape ?? 'square', a.aspect), 56)
                  return (
                  <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    <span className="shape-stem" style={{ top: `calc(50% - ${hbH / 2 + 18}px)` }} />
                    <button className="handle shape-rotate" style={{ top: `calc(50% - ${hbH / 2 + 18}px)` }} title={appConfig.copy.shapes.rotateHint} aria-label={appConfig.copy.shapes.rotateHint}
                      onPointerDown={(e) => rotDown(e, a.id)} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                      <Icon id="rotate" />
                    </button>
                    <button className="handle shape-resize" style={{ left: `calc(50% + ${hbW / 2 + 3}px)`, top: `calc(50% + ${hbH / 2 + 3}px)` }} title={appConfig.copy.shapes.resizeHint} aria-label={appConfig.copy.shapes.resizeHint}
                      onPointerDown={(e) => rotDown(e, a.id, 'resize')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                      <Icon id="resize" />
                    </button>
                  </div>
                  )
                })()}
                {/* directional symbol: tethered rotor knob (rotate-only), identical to
                    the Lage map — rotates with the symbol so the handle stays attached */}
                {isRotatableSym(a) && !annoComposite(a) && selId === a.id && tool === 'pan' && !readOnly && (
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
                {/* composite (Grosslüfter / Drehleiter / Hubretter): two rotors — blue body knob (short)
                    + amber part knob (long), the part = fan / ladder / boom aimed on rotation2 */}
                {annoComposite(a) && selId === a.id && tool === 'pan' && !readOnly && (
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
                      <button className="handle shape-rotate shape-rotate-fan" title={appConfig.copy.contextPanel[annoComposite(a)!.partLabel]} aria-label={appConfig.copy.contextPanel[annoComposite(a)!.partLabel]}
                        onPointerDown={(e) => rotDown(e, a.id, 'rotate2')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="rotate" />
                      </button>
                    </div>
                  </>
                )}
                {/* Hubretter cage tip: ONE amber handle at the boom end (same as the Lage map). Dragging
                    it sets the boom bearing (rotation2) + reach (reachN); positioned at the tip. */}
                {isHubretter(a.symbol) && selId === a.id && tool === 'pan' && !readOnly && (() => {
                  const rad = ((a.rotation2 ?? 0) * Math.PI) / 180
                  const len = Math.max(12, (a.reachN ?? 0.12) * sW)
                  return (
                    <div className="cage-handle" style={{ left: `calc(50% + ${(Math.cos(rad) * len).toFixed(1)}px)`, top: `calc(50% + ${(Math.sin(rad) * len).toFixed(1)}px)` }}>
                      <button className="handle shape-cage" title={appConfig.copy.shapes.moveHint} aria-label={appConfig.copy.shapes.moveHint}
                        onPointerDown={(e) => rotDown(e, a.id, 'cage')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="move" />
                      </button>
                    </div>
                  )
                })()}
              </div>
            ))}

            {/* trail breadcrumbs — a constant-size dot + timestamp at each RECORDED
                position, so the trail reads as a time-stamped log at a glance */}
            {annos.filter((a) => a.kind === 'resource' && !hiddenTrails.has(a.id)).flatMap((a) =>
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
                <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete} onClick={() => void deleteGroup()}><Icon id="trash" /></button>
              </div>
            )}

            {/* create-tool capture layer */}
            {creating && (
              <div className="wb-ink" onPointerDown={inkDown} onPointerMove={inkMove} onPointerUp={inkUp} onPointerCancel={inkUp} />
            )}
            {/* the in-progress node draft is reshapeable IN PLACE (A3, 29.08.): the same vertex
                grips and «+» midpoint inserts a finished shape gets, sitting above the .wb-ink
                capture layer (their z-indices already beat it) so they stay tappable while the
                tool is armed — a tap beside them still lays the next point as before. */}
            {noding && !!draft?.length && (
              <WbDraftHandles pts={draft} closed={tool === 'area'} draftFloor={draftFloor.current}
                sW={sW} sH={sH} mapY={mapY}
                onVertexDown={draftVertDown} onInsert={draftInsert} onDeleteVertex={draftDeleteVertex} />
            )}
            {/* «Karte verknüpfen»: the numbered crosses live IN the board so they pan and zoom
                with the sheet. Shown while the mode is armed, and while the Passung is open —
                otherwise a reference set in June could not be found again in November. */}
            {canGeoref && (georefArmed || georefQuality) && (
              <GeorefBoardLayer pairs={georefPairs} mode={georef} armed={georefArmed} sW={sW} sH={sH} view={georefView} />
            )}
            {!georefArmed && georefFit && (twinContent.length > 0 || twinDrawings.length > 0) && (
              <GeorefContentBoard entities={twinContent} drawings={twinDrawings} fit={georefFit}
                planAspect={measureAR} sW={sW} sH={sH} byName={sym.byName}
                trupps={trupps} truppSeverities={truppSeverities}
                interactive={tool === 'pan'} onOpenTeam={onTwinJump}
                onMoveTeam={readOnly ? undefined : moveContentTeam} />
            )}
            {/* …and the Karte's own objects, mirrored ONTO this sheet. In the board so they pan
                and zoom with it, and clipped to the sheet (lib/georefTwins · onSheet) so a
                vehicle two kilometres away is simply absent rather than smeared along the edge.
                Not while the pairing mode is armed: the sheet then belongs to the mode, and a
                twin under the aim would be one more thing to mis-tap. */}
            {!georefArmed && onTwinJump && (twinVehicles.length > 0 || twinSymbols.length > 0) && (
              <GeorefTwinsBoard
                twins={twins}
                byName={sym.byName}
                sW={sW}
                sH={sH}
                sizePx={symBase * scale}
                captionMode={captionMode}
                sourceSuppressedCaptions={mapSuppressedCaptions}
                interactive={tool === 'pan'}
                selectedKey={twinView?.key}
                onOpen={openBoardTwin}
                // undefined (not a no-op) on a locked surface, so the mark shows no grab
                // cursor and no drag affordance it would refuse to honour
                onMove={readOnly ? undefined : moveBoardTwin}
              />
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

          {/* floating zoom — only when the tool rail is hidden (viewer-only documents, replay);
              with the rail present, zoom/fit lives in its pinned footer (mirrors the map's
              ToolRail). The phone keeps it either way: there the rail is a bottom bar whose
              footer cluster is CSS-hidden, so this is the plan's only zoom control. */}
          {readOnly && (!slimRail || isPhone) && (
            <div className="wb-zoom wb-zoom-float" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => zoom(1 / 1.3)} disabled={scale <= MIN_SCALE} title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut}><Icon id="minus" /></button>
              <button onClick={() => zoom(1.3)} disabled={scale >= MAX_SCALE} title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn}><Icon id="plus" /></button>
              <button className="wb-fit" onClick={() => applyView(1, { x: 0, y: 0 })} disabled={scale === 1 && pos.x === 0 && pos.y === 0} title={appConfig.copy.nav.fit}>{appConfig.copy.whiteboard.fit}</button>
            </div>
          )}

        </div>

        {/* every dock arms a create/edit tool, so a locked surface renders none — since the
            Messen tool left the Plan (29.08.) there is no read-only dock left to carve out */}
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
          resourceBound={!!selResource?.truppId && trupps.some((t) => t.id === selResource.truppId && !t.removedAt)}
          trailsShown={!!selResource && !hiddenTrails.has(selResource.id)}
          onToggleTrails={() => { if (selResource) toggleTrail(selResource.id) }}
          noteDefaults={noteDefaults}
          setNoteDefaults={(p) => setNoteDefaults((d) => ({ ...d, ...p }))}
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

      {/* tool rail — the SAME shared <ToolRail> the Lage map renders, and the same rule: a
          locked surface keeps the rail with the slim tool set instead of losing it. Undo/redo
          and Leeren are gone: history is global (TopBar), bulk-remove is Mehrfach + delete.
          The one surface with NO rail at all is the selection-only Umrisse sheet (and a
          viewer-only PDF): there is nothing there a tool could do. */}
      {(!readOnly || slimRail) && (
        <ToolRail
          className="wb-tools"
          // ⚠️ the SAME device pref the Lage rail honours. It was missing here, so «Beschriftung
          // · Wörter» lit up the words on the map's rail and silently did nothing on the plan's —
          // one setting, two rails, and only one of them listening.
          labels={railLabels}
          primary={{ id: 'symbol', icon: appConfig.copy.primarySymbol.icon, label: appConfig.copy.whiteboard.symbol }}
          tools={readOnly ? slimPlanTools : planTools}
          active={tool}
          toolRefs={toolBtn}
          onPick={(id) => {
            if (id === 'symbol') { setTool('symbol'); setPaletteOpen(true); return }
            setTool(tool === id ? 'pan' : (id as BoardTool)); setPending(null)
          }}
          footer={
            <>
              {/* ⚠️ THE MAP RAIL'S ORDER, top to bottom: Ebenen · the view control · zoom ±.
                  It used to run the other way round here (zoom, Einpassen, Ebenen), so the two
                  rails put Ebenen at opposite ends of the same footer and the hand had to look
                  for it on whichever surface it happened to be on. Same footer, same order.
                  Ebenen appears only once this sheet is linked to the map: before that the map
                  lends it nothing and the panel would be an empty room. */}
              {onToggleLayers && (
                <button className={`vrail-nbtn vrail-layers ${layersOn ? 'on' : ''}`} title={appConfig.copy.panels.layers} aria-label={appConfig.copy.panels.layers} aria-pressed={layersOn} onClick={onToggleLayers}><span className="vrail-glyph"><Icon id="layers" /></span><span className="vrail-label">{appConfig.copy.panels.layers}</span></button>
              )}
              {/* «Einpassen» — where the map rail carries its compass / views button: the one
                  control that puts the whole surface back in front of you. */}
              <button className="vrail-nbtn vrail-fit" title={appConfig.copy.nav.fit} aria-label={appConfig.copy.nav.fit} disabled={scale === 1 && pos.x === 0 && pos.y === 0} onClick={() => applyView(1, { x: 0, y: 0 })}><span className="vrail-glyph"><Icon id="cross" /></span><span className="vrail-label">{appConfig.copy.nav.fit}</span></button>
              {/* zoom ±: desktop only (.vrail-zoom is hidden under 1024px) — the plan pinches
                  on every touch form factor, and «Einpassen» above covers the one state that
                  matters. */}
              <button className="vrail-nbtn vrail-zoom" title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut} disabled={scale <= MIN_SCALE} onClick={() => zoom(1 / 1.3)}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomOut}</span></button>
              <button className="vrail-nbtn vrail-zoom" title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn} disabled={scale >= MAX_SCALE} onClick={() => zoom(1.3)}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomIn}</span></button>
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
            </>
          }
        />
      )}

      {/* symbol/shape placement — the SAME shared ToolDock the Lage map uses (close + keep-placing
          lock + info hint), so placing on the plan feels identical to placing on the map. Rest tool
          is 'pan' here (the plan pans on empty canvas) vs the map's 'select'. */}
      {pending && tool === 'symbol' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setPending(null); setTool('pan') } }],
          [{ type: 'toggle', icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }],
          [{ type: 'info', text: appConfig.copy.dockHints.symbol }],
        ]} />
      )}

      {pendingShape && tool === 'shape' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setPendingShape(null); setTool('pan') } }],
          [{ type: 'glyph', node: <ShapeGlyph kind={pendingShape} color="#fff" /> }],
          [{ type: 'toggle', icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }],
          [{ type: 'info', text: appConfig.copy.dockHints.shape }],
        ]} />
      )}



      {/* selected-symbol editor — the SAME ContextPanel the Lage map uses, so a plan
          symbol now exposes label / fields / notes / count / rotation identically */}
      {/* rendered in read-only too (viewer / EL view): tapping a plan symbol shows its
          details; the readOnly prop strips every edit affordance inside the panel. */}
      {editorSlotFree && selSymbol && (
        <ContextPanel
          key={selSymbol.id}
          // ⚠️ `floor` is remapped, not spread through: on a BoardAnno that name is the
          // floor-stack TILE INDEX, while the panel's `floor` is the signed Stockwerk badge
          // (see types · BoardAnno.storey). Handing the tile index to the stepper would have
          // shown «+3» for the third sheet and moved the symbol to another storey on a tap.
          entity={{ ...selSymbol, floor: selSymbol.storey }}
          readOnly={readOnly}
          svg={selSymbol.symbol ? sym.byName[selSymbol.symbol] ?? '' : ''}
          onClose={() => setSelId(null)}
          onProjection={georefFit && onPlanProjection && selSymbol.x != null && selSymbol.y != null
            ? () => { const c = georefFit.toMap({ x: selSymbol.x!, y: selSymbol.y! }); onPlanProjection(activeId, selSymbol.id, [c.lng, c.lat]) }
            : undefined}
          projectionLabel={appConfig.copy.contextPanel.showOnMap}
          // ⚠️ Live while typing, one step on blur — the same split the Lage's symbol panel has
          // (IncidentWorkspace · titleLiveRef) and the same one the plan's LINE label already had.
          // Committing only on blur meant the glyph on the board still read «Fahrzeug» while the
          // panel already said «TLF 1»: on the Lage the caption follows the keystrokes, on the plan
          // it did not, and the surface you were looking at decided which.
          onTitleLive={(v) => {
            if (titleLive.current !== selSymbol.id) { titleLive.current = selSymbol.id; pushPast() }
            patch(selSymbol.id, { label: v })
          }}
          onTitle={(v) => {
            const live = titleLive.current === selSymbol.id
            titleLive.current = null
            if (live) emit('board.edit', { id: selSymbol.id, patch: { label: v }, planId: activeId })
            else patchCommit(selSymbol.id, { label: v })
          }}
          onFields={(fields) => {
            const before = selSymbol.fields ?? {}
            patchCommit(selSymbol.id, { fields })
            for (const [k, v] of Object.entries(fields)) {
              if (v.trim() && before[k] !== v) onRosterField?.(selSymbol.symbol, selSymbol.label, k, v)
            }
          }}
          onNotes={(v) => patchCommit(selSymbol.id, { notes: v || undefined })}
          // Stockwerk — the Lage has always offered it, the Modul boards never did, so a Brand
          // drawn on «Modul 2» could not say which storey it was on. Absent on the Gebäude
          // floor-stack ALONE: there the sheet the symbol sits on IS the storey.
          onFloor={stack ? undefined : (f) => patchCommit(selSymbol.id, { storey: f ?? undefined })}
          onFloorFrom={(f) => patchCommit(selSymbol.id, { floorFrom: f ?? undefined })}
          onFloorTo={(f) => patchCommit(selSymbol.id, { floorTo: f ?? undefined })}
          onSpread={(s) => patchCommit(selSymbol.id, { spread: s ?? undefined })}
          onCount={(n) => patchCommit(selSymbol.id, { count: n && n > 1 ? n : undefined })}
          onRotate={(deg) => patchCommit(selSymbol.id, { rotation: deg ?? undefined })}
          onRotate2={(deg) => patchCommit(selSymbol.id, { rotation2: deg ?? undefined })}
          onCaption={(m) => patchCommit(selSymbol.id, { caption: m })}
          captionDefault={captionMode}
          onAirflow={(extract) => patchCommit(selSymbol.id, { extract: extract || undefined })}
          controls={symbolControls(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
          titleOptions={symbolTitleOptions(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
          fieldOptions={symbolFieldOptions(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat, rosterNames)}
          rosterRank={rosterRank}
          // who that name already is, on the entry itself + under the filled field — the Lage has
          // shown both since the roster pickers existed, the plan showed neither, so naming a
          // Fahrer who is under Atemschutz was silent on exactly the surface a Zugführer works on
          personStatus={personStatus}
          fieldHints={fieldHints?.(selSymbol.symbol, selSymbol.label, selSymbol.fields)}
          // Symbol→Mittel, identical to the map: a placed TLF books onto the Material sheet from
          // here too. Only where the station mapped material to symbols (the prop is absent
          // otherwise), and never read-only.
          protectedKeys={new Set(symbolPresetFieldKeys(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat))}
          connectedLines={annos.filter((a) => [a.startAttachment, a.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === selSymbol.id)).map((a) => ({ id: a.id, label: lineLabel(a) }))}
          onFocusLine={(id) => setSelId(id)}
          onDelete={() => void removeWithConnections(selSymbol)}
        />
      )}

      {/* note detail panel — the same ContextPanel, opened from the ⚙ handle rather than by
          selecting (see notePanelId). The note's TEXT is its title, so the panel's title field
          edits the note itself; `noteWidth` drives the Form row + the "Zu Textfeld" default. */}
      {editorSlotFree && selNote && (
        <ContextPanel
          key={selNote.id}
          entity={{ ...selNote, label: selNote.text, subtitle: appConfig.copy.notes.section }}
          readOnly={readOnly}
          onClose={() => setNotePanelId(null)}
          // one checkpoint when typing starts, one audit row on blur — the live `patch` writes
          // without a checkpoint, so committing again on blur used to snapshot the ALREADY typed
          // text and «Rückgängig» after renaming a note did nothing at all.
          onTitleLive={(v) => {
            if (titleLive.current !== selNote.id) { titleLive.current = selNote.id; pushPast() }
            patch(selNote.id, { text: v })
          }}
          onTitle={(v) => {
            const live = titleLive.current === selNote.id
            titleLive.current = null
            if (live) emit('board.edit', { id: selNote.id, patch: { text: v }, planId: activeId })
            else patchCommit(selNote.id, { text: v })
          }}
          onFields={(fields) => patchCommit(selNote.id, { fields })}
          onNotes={(v) => patchCommit(selNote.id, { notes: v || undefined })}
          // a width set by hand ends the auto-fit; the size-slider step keeps it and re-measures
          onNoteWidth={(w) => patchCommit(selNote.id, { wN: w ?? undefined, noteAutoW: undefined })}
          onNoteSize={(s) => patchCommit(selNote.id, selNote.noteAutoW
            ? { noteSize: s, wN: autoNoteWN(selNote.text ?? '', txtBase * scale * noteScale(s), sW) }
            : { noteSize: s })}
          onNotePlain={(p) => patchCommit(selNote.id, { notePlain: p || undefined })}
          onColor={(c) => patchCommit(selNote.id, { color: c || undefined })}
          onDelete={() => { setNotePanelId(null); void removeWithConnections(selNote) }}
        />
      )}

      {/* A Karte-owned source edited through its projection. The subtitle keeps ownership clear;
          every mutation below is routed upward to the one map entity. */}
      {detailPanelVisible && viewedTwin && onTwinJump && (
        <GeorefTwinPanel
          entity={viewedTwin.entity}
          svg={viewedTwin.kind === 'vehicle' || viewedTwin.entity.symbol === appConfig.symbols.vehicleName
            ? vehicleSymbolSvg(twinName(viewedTwin.entity), viewedTwin.entity.rotation ?? 0, viewedTwin.entity.directed ?? true)
            : glyphFor(viewedTwin.entity, sym.byName)}
          subtitle={appConfig.copy.whiteboard.georef.twinPanelFromMap}
          readOnly={readOnly || viewedTwin.entity.live || !onTwinEdit}
          onClose={() => setTwinView(null)}
          onCenter={() => centerOnPoint(viewedTwin.pt.x, viewedTwin.pt.y, 0)}
          onOriginal={() => { const e = viewedTwin.entity; setTwinView(null); onTwinJump(e) }}
          originalLabel={appConfig.copy.contextPanel.showOnMap}
          onTransferHere={!readOnly && onTwinTransferHere && viewedTwin.kind === 'symbol' && !viewedTwin.entity.live
            ? () => { const t = viewedTwin; setTwinView(null); onTwinTransferHere(t.entity, activeId, t.pt) }
            : undefined}
          onTitleLive={(v) => onTwinEdit?.(viewedTwin.entityId, { label: v }, 'live')}
          onTitle={(v) => onTwinEdit?.(viewedTwin.entityId, { label: v }, 'commit')}
          onFields={(fields) => onTwinEdit?.(viewedTwin.entityId, { fields })}
          onNotes={(v) => onTwinEdit?.(viewedTwin.entityId, { notes: v || undefined })}
          onFloor={(f) => onTwinEdit?.(viewedTwin.entityId, { floor: f ?? undefined })}
          onFloorFrom={(f) => onTwinEdit?.(viewedTwin.entityId, { floorFrom: f ?? undefined })}
          onFloorTo={(f) => onTwinEdit?.(viewedTwin.entityId, { floorTo: f ?? undefined })}
          onSpread={(spread) => onTwinEdit?.(viewedTwin.entityId, { spread: spread ?? undefined })}
          onCount={(count) => onTwinEdit?.(viewedTwin.entityId, { count: count && count > 1 ? count : undefined })}
          onRotate={(rotation) => onTwinEdit?.(viewedTwin.entityId, { rotation: rotation ?? undefined })}
          onRotate2={(rotation2) => onTwinEdit?.(viewedTwin.entityId, { rotation2: rotation2 ?? undefined })}
          onCaption={(caption) => onTwinEdit?.(viewedTwin.entityId, { caption })}
          captionDefault={captionMode}
          onAirflow={(extract) => onTwinEdit?.(viewedTwin.entityId, { extract: extract || undefined })}
          controls={symbolControls(viewedTwin.entity.symbol, sym.symbols.find((x) => x.name === viewedTwin.entity.symbol)?.cat)}
          titleOptions={symbolTitleOptions(viewedTwin.entity.symbol, sym.symbols.find((x) => x.name === viewedTwin.entity.symbol)?.cat)}
          fieldOptions={symbolFieldOptions(viewedTwin.entity.symbol, sym.symbols.find((x) => x.name === viewedTwin.entity.symbol)?.cat, rosterNames)}
          rosterRank={rosterRank}
          personStatus={personStatus}
          fieldHints={fieldHints?.(viewedTwin.entity.symbol, viewedTwin.entity.label, viewedTwin.entity.fields)}
          protectedKeys={new Set(symbolPresetFieldKeys(viewedTwin.entity.symbol, sym.symbols.find((x) => x.name === viewedTwin.entity.symbol)?.cat))}
          onDelete={() => { void Promise.resolve(onTwinDelete?.(viewedTwin.entityId) ?? false).then((deleted) => { if (deleted) setTwinView(null) }) }}
        />
      )}

      {/* selected stroke / Linie / Fläche editor — the SAME shared DrawEditor the Lage map uses, so a
          plan line/area exposes the line presets (Freihand/Messpfeil/Rettungsachse) + colour / width /
          style / label / marker / arrow identically. Distance is omitted (a plan has no metric scale). */}
      {/* …and it opens in read-only too, like the ContextPanel two blocks up and like the Lage's
          own locked DrawEditor: an Einsatzleiter tapping a Leitung on the plan gets its Länge,
          its Leitung-Nr. and the Trupp on it. The panel strips every control that would change
          the shape itself (DrawEditor · readOnly). */}
      {editorSlotFree && selDraw && (
        <DrawEditor
          key={selDraw.id}
          readOnly={readOnly}
          drawing={{ kind: selDraw.kind as 'draw' | 'area', color: selDraw.color, width: selDraw.width, dashed: selDraw.dashed, label: selDraw.label, marker: selDraw.marker, arrow: selDraw.arrow, arrowStop: selDraw.arrowStop, showDistance: selDraw.showDistance, fillOpacity: selDraw.fillOpacity, teilstueck: selDraw.teilstueck, content: selDraw.content, lineNo: selDraw.lineNo, floorTag: selDraw.floorTag, startAttachment: selDraw.startAttachment, endAttachment: selDraw.endAttachment }}
          pointCount={selDraw.pts?.length ?? 0}
          /* the distance toggle appears once the plan is calibrated against its printed scale bar */
          supportsDistance={calibrated}
          /* same Messung section as the Lage, in the plan's calibrated metres — but no
             Höhenprofil: a building plan carries no height data */
          lengthM={selDraw.pts && selDraw.pts.length >= 2 ? planMetres(selDraw.pts.map(([x, y]) => [x, y])) : null}
          /* …and a Fläche measures itself the same way the Lage's does — Fläche + Umfang, in the
             plan's calibrated metres. Without these the Messung section simply never appeared for
             an area on a plan, so a Sektor drawn on Modul 2 could state neither. */
          areaM2={selDraw.kind === 'area' && calibrated && activeScale && (selDraw.pts?.length ?? 0) >= 3
            ? polyAreaM2(selDraw.pts!.map(([x, y]) => [x, y]), activeScale.mPerU, measureAR) : null}
          perimeterM={selDraw.kind === 'area' && (selDraw.pts?.length ?? 0) >= 3
            ? planMetres([...selDraw.pts!, selDraw.pts![0]].map(([x, y]) => [x, y])) : null}
          onPreset={(presetId) => {
            setLinePreset(presetId)
            patchCommit(selDraw.id, resolveLinePreset(presetId, selDraw.dashed)) // ONE bundle, shared with the Lage map (lib/lineStyle)
          }}
          onColor={(c) => patchCommit(selDraw.id, { color: c })}
          onWidth={(w) => patchCommit(selDraw.id, { width: w })}
          onDashed={(d) => patchCommit(selDraw.id, { dashed: d })}
          // ⚠️ Live while typing, one step on blur — the same split the Lage got (useMapDrawing ·
          // patchDrawingLabelLive). Through `patchCommit` every keystroke was its own undo step and
          // its own audit event: eleven of each for the word «Sicherung».
          onLabel={(label) => {
            if (labelLive.current !== selDraw.id) { labelLive.current = selDraw.id; pushPast() }
            patch(selDraw.id, { label: label || undefined })
          }}
          onLabelCommit={(label) => {
            const live = labelLive.current === selDraw.id
            labelLive.current = null
            if (live) emit('board.edit', { id: selDraw.id, patch: { label: label || undefined }, planId: activeId })
            else patchCommit(selDraw.id, { label: label || undefined })
          }}
          onMarker={(marker) => patchCommit(selDraw.id, { marker: marker || undefined })}
          onArrow={(arrow) => patchCommit(selDraw.id, { arrow: arrow || undefined })}
          onEnding={(ending) => void changePlanEnding(ending)}
          onReverse={selDraw.kind === 'draw' ? reverseAnno : undefined}
          onContent={(content) => patchCommit(selDraw.id, { content })}
          onLineNo={(lineNo) => { patchCommit(selDraw.id, { lineNo }); onLineRenumber?.(selDraw.id, lineNo) }}
          onFloorTag={(floorTag) => patchCommit(selDraw.id, { floorTag })}
          onTrupp={onLinkLineTrupp ? (truppId) => onLinkLineTrupp(selDraw.id, truppId) : undefined}
          trupps={trupps.filter((t) => t.status !== 'raus').map((t) => ({ id: t.id, name: t.name }))}
          usedLineNos={annos.filter((a) => a.kind === 'draw' && a.id !== selDraw.id && a.lineNo != null).map((a) => a.lineNo!)}
          truppOnLine={truppForLine(selDraw, trupps)?.name}
          truppOnLineOut={truppIsOut(truppForLine(selDraw, trupps))}
          onShowTrupp={onShowTrupp && truppForLine(selDraw, trupps) ? () => onShowTrupp(truppForLine(selDraw, trupps)!.id) : undefined}
          onShowDistance={(showDistance) => patchCommit(selDraw.id, { showDistance: showDistance || undefined })}
          onRadius={() => {}}
          onFillOpacity={(fillOpacity) => patchCommit(selDraw.id, { fillOpacity })}
          attachmentLabels={Object.fromEntries((['start', 'end'] as const).flatMap((endpoint) => {
            const a = endpoint === 'start' ? selDraw.startAttachment : selDraw.endAttachment
            if (!a) return []
            const target = annos.find((x) => x.id === a.target.id)
            const label = target?.kind === 'draw' ? lineLabel(target) : target?.label ?? target?.text ?? appConfig.copy.drawingEditor.line
            return [[endpoint, label]]
          }))}
          onRouting={(endpoint, routing) => {
            const key = endpoint === 'start' ? 'startAttachment' : 'endAttachment'
            const a = selDraw[key]; if (a) patchCommit(selDraw.id, { [key]: { ...a, routing } })
          }}
          onDetach={detachPlanEndpoint}
          onFocusAttachment={(endpoint) => {
            const a = endpoint === 'start' ? selDraw.startAttachment : selDraw.endAttachment
            if (a) setSelId(a.target.id)
          }}
          // Verriegeln — the same control the Lage's line editor has, on the same field name
          // (types · BoardAnno.locked mirrors Drawing.locked). Locking DESELECTS, because a locked
          // shape can no longer be tapped: leaving its panel open would offer edits to something
          // that has just stopped accepting them. ⚠️ Not `readOnly` — that is the whole SURFACE
          // being locked for a viewer, and a viewer may not change this flag at all.
          locked={!!selDraw.locked}
          onToggleLock={readOnly ? undefined : () => {
            patchCommit(selDraw.id, { locked: selDraw.locked ? undefined : true })
            if (!selDraw.locked) setSelId(null)
          }}
          onDelete={() => void removeWithConnections(selDraw)}
          onClose={() => setSelId(null)}
        />
      )}

      {/* selected-shape editor — the SAME colour sheet as the Lage map (size + rotation
          live on the canvas handles). Read-only surfaces just show the selection halo. */}
      {editorSlotFree && !readOnly && selShape && (
        <ShapeEditor
          key={selShape.id}
          entity={selShape}
          onColor={(c) => patchCommit(selShape.id, { color: c })}
          // ±25 % steps scale BOTH axes: sizeN is the width and the height is width × aspect
          onScale={(f) => patchCommit(selShape.id, { sizeN: Math.max(0.03, Math.min(0.9, (selShape.sizeN ?? SHAPE_DEFS[selShape.shape ?? 'square'].defaultSizeN) * f)) })}
          onStop={(v) => patchCommit(selShape.id, { stop: v })}
          onDelete={() => void removeWithConnections(selShape)}
          onClose={() => setSelId(null)}
        />
      )}

      {paletteOpen && sym.ready && (
        <Palette sym={sym} onPick={pickSymbol} onPickShape={pickShape} onClose={() => { setPaletteOpen(false); if (!pending && !pendingShape) setTool('pan') }} />
      )}

      {truppPick && (
        /* ⚠️ Modal → lib/overlays (focus trap + restore, scroll-lock, Esc, backdrop dismissal).
           The hand-rolled scrim it replaces had none of those, and the board's own Escape handler
           fired underneath it. The AGENTS.md carve-out is for the NON-modal tool docks. */
        <Overlay open onClose={() => setTruppPick(null)} className="wb-trupp-pick ui-dialog" ariaLabel={appConfig.copy.whiteboard.selectTrupp}>
          <div className="wb-trupp-pick-head">{appConfig.copy.whiteboard.selectTrupp}</div>
          {/* twin of the Lage picker (IncidentWorkspace): a Trupp already on THIS plan is
              greyed out, because picking it would move its chip rather than add one. One on
              the map or another plan stays selectable — that is a real move. */}
          {trupps.filter((t) => t.status !== 'raus').map((t) => {
            const here = !!t.annoId && t.planId === activeId
            return (
              <button
                key={t.id} className={`wb-trupp-opt${here ? ' placed' : ''}`} disabled={here}
                onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor, t); setTruppPick(null) }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {here
                  ? <i>{appConfig.copy.whiteboard.truppPlacedHere}</i>
                  : (t.lineNo != null || t.lineNumber) ? <i>Ltg {t.lineNo ?? t.lineNumber}</i> : null}
              </button>
            )
          })}
          <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor); setTruppPick(null) }}>
            <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
          </button>
        </Overlay>
      )}

      {/* Maßstab — metre-entry popover after the two reference taps: a clean −/+ stepper */}
      {calPrompt && (
        <PlanScalePrompt refMInput={refMInput} setRefMInput={setRefMInput}
          onCommit={commitCalibration} onClose={closeCalPrompt} />
      )}

      {/* The facts about a plan that no page of it states — WHICH object, at what scale, and (on
          the Gebäude) which building — in one row in the stage's quiet corner. Objekt and Maßstab
          were a bespoke glass chip in the top-left and this pill down here; two recipes for one
          job, with the louder of the two sitting on the corner of the plan that is actually looked
          at. One family now, one corner — and the building switch joined it rather than earning a
          rail tile of its own. */}
      <div className="wb-botleft">
      {/* ⚠️ While «Karte verknüpfen» is armed, this row carries the INSTRUMENT and nothing else.
          One mode, one indicator: the chip that armed the mode is the thing that now says what
          to tap, how far along it is and how to stop — and the facts that were in this row
          (Objekt, Gebäude, Massstab) are not what anyone is reading mid-pairing. They come
          straight back when the mode ends. On a phone the instrument is the bar instead
          (GeorefMode · GeorefModeBars), so this row simply stays empty of it. */}
      {georefArmed && !isPhone ? <GeorefInstrument mode={georef} /> : <>
      {objectChip}
      {buildingChip}
      {/* Maßstab — trust chip: shows where the active plan's scale comes from. A manually
          calibrated scale remains a control because tapping it edits that calibration. An
          automatic scale is different: it is DERIVED from the Karte link and must therefore be
          a reading, never a shortcut into a second, competing manual calibration. The separate
          Verknüpft control beside it opens the Passung and its explicit correction actions.
          Hidden for the OSM live outline / blank sheet (no printed reference to measure against).
          A locked surface keeps the reading but cannot arm a manual calibration. */}
      {(!readOnly || slimRail) && !osm && !blank && (
        scaleAuto
          /* Still a reading, not a second calibration path – but a TAPPABLE one (29.08.): the
             hover title never fires on the field iPad, so the chip explains itself the same
             way as «Verknüpft» beside it – by opening the Passung, where the derived scale,
             the pair count and the residual sit next to what to do about them. */
          ? <button className="wb-scale-chip wb-scale-status on"
              title={appConfig.copy.whiteboard.scale.chipAutoHint}
              aria-expanded={georefQuality}
              onClick={() => setQualityFor(georefQuality ? null : activeId)}>
              <Icon id="measure" />
              <span>{appConfig.copy.whiteboard.scale.chipAuto}</span>
            </button>
          : <button
              className={`wb-scale-chip ${calibrated ? 'on' : ''} ${scaleStale ? 'stale' : ''} ${tool === 'scale' ? 'arm' : ''}`}
              title={readOnly ? undefined : appConfig.copy.whiteboard.scale.recalibrate}
              disabled={readOnly}
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
      {/* «⌖ Karte» — the third fact about a plan that no page of it states: whether this sheet is
          tied to the world, and how well. Same recipe and same corner as the Massstab beside it,
          and the same rule: never a hidden assumption. Blue, like Messen and Massstab — a
          georeference is not an alarm, so never the station's --accent.
          A viewer sees the reading but cannot arm it; a plan with no reference offers the verb. */}
      {canGeoref && (!readOnly || georefState.kind === 'linked') && (
        <button
          className={`wb-scale-chip ${georefState.kind === 'linked' ? (georefState.warn ? 'wb-georef-warn' : 'wb-georef-ok') : ''} ${georefQuality ? 'arm' : ''}`}
          title={readOnly ? undefined
            : georefState.kind === 'linked' ? appConfig.copy.whiteboard.georef.openQuality
            : appConfig.copy.whiteboard.georef.linkTitle}
          disabled={readOnly}
          aria-expanded={georefState.kind === 'linked' ? georefQuality : undefined}
          onClick={() => {
            // linked ⇒ the chip opens the Passung; unlinked ⇒ it arms the pairing straight away.
            // A plan that has no reference has nothing to show, so the reading would be an empty
            // panel where the verb belongs.
            if (georefState.kind === 'linked') setQualityFor(georefQuality ? null : activeId)
            else beginGeoref()
          }}
        >
          <Icon id="locate" />
          {/* ⚠️ «Verknüpft», and nothing after it. The chip used to carry the reading too —
              «Verknüpft · aus 2 Punkten», «Verknüpft · ⌀ 10.8 m» — which is a sentence in a row
              of three-word pills, and it put the one number that needs context (a residual means
              nothing without «out of how many pairs») where there is no room to give any. The
              TONE still says whether the fit is checked; the number lives one tap away, in the
              Passung, next to what to do about it. */}
          <span>{georefState.kind === 'linked'
            ? appConfig.copy.whiteboard.georef.chipLinked
            : appConfig.copy.whiteboard.georef.chipUnlinked}</span>
        </button>
      )}
      </>}
      </div>

      {/* #3: persist a fresh calibration station-wide so plans measure out of the box next time */}
      {savePrompt && !readOnly && (
        <PlanScalePersist scale={savePrompt} activeId={activeId} onDone={() => setSavePrompt(null)} />
      )}

      {/* Passung — the reading behind the linked chip, in the same dock the Massstab's own
          follow-up uses (`.wb-scale-persist`), one row above the chip that opened it.
          ⚠️ Deliberately NOT the shared <Popover>. That one is modal-ish by construction: it
          portals, manages focus and dismisses on the first press anywhere outside — over a LIVE
          board that means the next tap on a symbol is eaten by the dismissal instead of
          selecting it. src/lib/overlays/Popover.tsx says exactly this in its own header: for
          surfaces that must stay live underneath, keep the hand-rolled dock. */}
      {georefQuality && georefFit && !georefArmed && (
        <div className="wb-georef-dock" role="group" aria-label={appConfig.copy.whiteboard.georef.qualityTitle}>
          <GeorefQuality
            fit={georefFit}
            onClose={() => setQualityFor(null)}
            onAddPoint={() => beginGeoref({ returnToQuality: true })}
            // «Deckung prüfen» needs BOTH pictures on screen, which is exactly what the armed
            // split is — so the check arms the mode and comes up with the outline already drawn.
            onCheck={() => beginGeoref({ check: true, returnToQuality: true })}
            onTransfer={georefTransferTargets.length ? () => setGeorefTransferOpen(true) : undefined}
            onReset={() => { setQualityFor(null); resetGeorefPlan(activeGeorefKey); toast(appConfig.copy.whiteboard.georef.resetDone) }}
          />
        </div>
      )}

      {georefTransferOpen && active && georefTransferTargets.length > 0 && (
        <GeorefTransfer
          source={active}
          targets={georefTransferTargets}
          onTransfer={transferGeoref}
          onClose={() => setGeorefTransferOpen(false)}
          onDone={() => { setGeorefTransferOpen(false); setQualityFor(null) }}
        />
      )}

      {/* the dashed seam, and nothing but it: the boundary the split created. It carries no
          label — the mode's instruction and the way out are the chip row's instrument on a
          tablet and a shell-level bar on a phone (this component is unmounted for the map half
          of every pair there). See GeorefMode · GeorefSplitSeam. */}
      {georefArmed && !isPhone && <GeorefSplitSeam />}
    </div>
  )
}
