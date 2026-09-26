import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LineMarker } from './LineMarker'
import { ConnectRing, NodeDeleteChip } from './NodeDeleteChip'
import type { BoardAnno, BoardKind, BoardPoint, BoardTool, BuildingDoc, CaptionMode, LineAttachment, LineEndpoint, LngLat, NoteSize, PlanDocument, ShapeKind, SrcGeoref, Trupp } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import type { RailLabels } from '../lib/prefs'
import { Icon } from '../lib/icons'
import { newId } from '../lib/ids'
import { Palette } from './Palette'
import { FloorPage } from './FloorPage'
import { usePlanPaperMm } from './usePlanPaper'
import { paperMaxScale } from '../lib/planTiles'
import { prefetchPlanTiles } from '../lib/planTilePrefetch'
import { PdfViewport, planMatcherImage, planPrintedMPerU, prewarmPlans } from './PdfViewport'
import { PdfScroller } from './PdfScroller'
import { OsmOutline } from './OsmOutline'
import { appConfig } from '../config/appConfig'
import { markerParamsAlong, markerSpacing, markerGlyph, lerpPoint, lookbackPoint, rdpIndices, isTapStroke, DEFAULT_INK, FREEHAND_SIMPLIFY_PX } from '../lib/lineStyle'
import { minPoints } from '../lib/vertexOps'
import { centroid, rotateAround, turnedBy } from '../lib/selectionTransform'
import { useWbVertexEdit, type PlanEndpointDrag } from './useWbVertexEdit'
import { useWbChipDrag } from './useWbChipDrag'
import { CIRCLE_MAX_N, useWbRotor } from './useWbRotor'
import { SelectionBar } from './SelectionBar'
import { SelectionTurn } from './SelectionTurn'
import { useArmedTransform } from '../lib/useArmedTransform'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { beginSheetPeek, endSheetPeek } from '../lib/sheetPeek'
import { buzz } from '../lib/haptics'
import { TeilstueckFork, EndTag, hasLineDecor, lineLabel } from '../lib/lineDecor'
import { markerTakesLineEnd, truppForLine, truppIdForAttachment, truppIsOut, truppLineTone, type LinkableLine } from '../lib/truppLines'
import { freshTeamLabel, nextTeamName, teamNoTaken } from '../lib/placedTrupps'
import { fillTemplate, formatSymbolName, formatTime } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { ApiError } from '../lib/api'
import { Overlay, Popover } from '../lib/overlays'
import { isBottomSheet, nudgeSelectionIntoRect, rectCenter, visibleWorkRect, type NudgeBox } from '../lib/panelNudge'
import { TacticalSymbol, compositeSpec, compositePartGlyph, luefterVariant, isHubretter, HubretterBoom, floorBadge } from '../lib/symbolRender'
import { doneAct, doneBadge, doneFirst, donePlace } from '../lib/objectDone'
import { annoLogName } from '../lib/drawingEdit'
import { serverNowIso } from '../lib/serverClock'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { placardSvgForSymbol } from '../lib/placard'
import { useHazardData } from '../lib/useHazardData'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys, symbolCaptionText, isRotatableSym, isVehicleSym } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import { ContextPanel } from './ContextPanel'
import { DrawEditor } from './DrawEditor'
import { ShapeEditor } from './ShapeEditor'
import { TwinTeamPill } from './TwinTeamPill'
import { LockChip } from './LockChip'
import { ShapeGlyph, SHAPE_AXIS_GRIPS, SHAPE_DEFS, SHAPE_MAX_N, SHAPE_MIN_N, SHAPE_TWO_POINT, rotationBoundsN, rotationBox, rotationGripOffPx, rotationRun, shapeAspect } from '../lib/shapes'
import { TEAM_DOT_PX, TEAM_PILL_CAP_PX } from '../lib/mapView'
import { noteScale, autoNoteWN, noteWN } from '../lib/notes'
import { isAtemschutzTrupp } from '../lib/atemschutz'
import { dismissNearbyBanner, nearbyBannerDismissed, nearbyBannerKey } from '../lib/nearbyBanner'
import { ghostTrailLabel, type TruppTrail } from '../lib/truppTrails'
import { planUrl, tileAspectOf, TOP_INSET, STACK_VPAD, STACK_CHIP_ROW, sideInsets, clamp01, floorLabel, floorGeometry, signedFloor, floorCrossings, storeyTowards } from '../lib/whiteboard'
import { loadHiddenFloors, saveHiddenFloors, shownFloors } from '../lib/floorPrefs'

/** height of the strip a folded-away storey leaves behind (board px, matches 09-whiteboard.css) */
const FOLDED_H = 28
import { advanceDwell, armDwell, attachInsetPx, boundaryPoint, DETACH_SHOW_PROGRESS, distance, dwellFor, EMPTY_DWELL, flipLine, forkPortPoint, incomingAttachments, isMagnetAnno, nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget, STROKE_START_RADIUS_PX, wouldCreateCycle, type AttachableLine, type DwellState, type MagneticTarget } from '../lib/lineAttachments'
import { packFrameRing, packPagePlacement, pagePlacement, regionCorners, reorientBearings, stackGroundFit } from '../lib/stackFit'
import { inSection, storeySections, visibleCentre } from '../lib/storeyClip'
import type { FloorPackView } from '../lib/floorPackBinding'
import { stackInstances } from '../lib/stackFloors'
import { circleRadiusM, circleRadiusN, pathMetres, polyAreaM2, scaleLampTone, type PlanScale } from '../lib/planScale'
import { slimTools, PLAN_READONLY_TOOLS } from '../lib/readOnlyTools'
import { isSelectOnlySurface } from '../lib/useObjectPlans'
import { useIsPhone } from '../lib/useIsPhone'
import type { PlanScales } from '../lib/workspace'
import { fmtDistance, fmtArea, hoseLengthHint } from '../lib/geo'
import { activeViewDeg, bandAspect, BOX_H, BOX_W, buildView, principalAngleDeg, remapPoint, stackScaleMPerU, type Ring } from '../lib/footprint'
import { usePlanMeasure } from './usePlanMeasure'
import { useMeasuredSheet } from './useMeasuredSheet'
import { PlanScalePrompt, PlanScalePersist } from './PlanScalePrompts'
import { GeorefBoardLayer, GeorefInstrument, GeorefLinkChooser, GeorefSplitSeam, type PlanViewApi } from './GeorefMode'
import { GeorefQuality } from './GeorefQuality'
import { GeorefTransfer, type GeorefTransferTarget } from './GeorefTransfer'
import { fitSimilarity, hasAutoPairs, realPairCount } from '../lib/georef'
import { incidentBindingApproved } from '../lib/incidentPlanBindings'
import { georefForPlan, getStationPlanScales, noteMeasuredAspect, refreshStationPlanScales } from '../lib/stationPlanScale'
import { planAspect } from '../lib/georefTwins'
import { georefChip, georefChipTone, georefDispatch, resetGeorefPlan, setGeorefSaveErrorHandler, startGeorefMode, startGeorefProposal, transferGeorefPlan, useGeorefMode, useGeorefStorage } from '../lib/georefMode'
import { georefSuggestEligible, requestGeorefSuggestion, type GeorefSuggestStep } from '../lib/georefSuggest'
import { PlanLiveLayer } from './PlanLiveLayer'
import type { LiveMark } from '../lib/planProjection'
import { MAX_SCALE, MAX_SCALE_STACK, MIN_SCALE, boardViewSignature, useBoardView, type BoardViews } from './useBoardView'
import { newPlanStep, pushBoardPast, useBoardDoc, type BoardHistory } from './useBoardDoc'
import { recordKey, watchRecords } from '../lib/undoKeys'
import { useBoardGestures } from './useBoardGestures'
import { WbToolDocks, WbCircleHandle, WbCircleLayer, WbInkLayer, WbVertexHandles, WbDraftHandles } from './WbControls'
import { MeasurePanel } from './MeasurePanel'
import { ToolDock } from './ToolDock'
import { PlanCompass } from './PlanCompass'
import { OrientSlider } from './OrientSlider'
import { ToolRail } from './ToolRail'
import { SucheToolButton } from './suche/SucheToolButton'
import { SuchePinChip } from './suche/SuchePins'
import sucheCss from './suche/Suche.module.css'
import type { SuchePin } from '../lib/suche'

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
  /** the one writer of this sheet's list. `gesture: false` = the board's own ↶/↷ restoring a
   *  snapshot, which places nothing (lib/useObjectStore · setBoard) */
  onChange: (next: BoardAnno[], opts?: { gesture?: boolean }) => void
  building: BuildingDoc | null
  /** the active object's floor pack – the PDF page each storey tile draws underneath, and the
   *  pack's shared map fit that places it (lib/floorPackBinding) */
  floorPack?: FloorPackView | null
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
  /** Einsatz-Link session (App · linkScoped): the bottom-left setting chips (Maßstab /
   *  Verknüpft) disappear entirely — every setting comes from the origin, and an outside
   *  viewer gets no door to a settings surface, not even a disabled one. */
  linkViewer?: boolean
  /** device pref «Beschriftung der Werkzeugleisten» (lib/prefs · railLabels) — the word under each glyph.
   *  The setting says «in den beiden Leisten», so the plan's rail has to be handed it too. */
  railLabels?: RailLabels
  /** the Suche's door at the end of the rail (components/suche · SucheToolButton, 26.09.2026) —
   *  the same button the Karte carries beside Ebenen; the card it opens is the workspace's */
  suche?: { on: boolean; count: number; onToggle: () => void }
  /** the Suche's pins (lib/suche · suchePins) — the ones on THIS sheet are drawn on their storey */
  suchePins?: readonly SuchePin[]
  onSuchePin?: (pin: SuchePin) => void
  /** the Suche hands the plan a pick (components/suche · SuchePick): the next TAP on the sheet is
   *  a place's position — a drag still pans, two fingers still zoom */
  suchePick?: { onPick: (p: { planId: string; x: number; y: number; floor: number }) => void } | null
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
  /** who is signed in — stamped on a «Gelöscht / erledigt» (lib/objectDone · markDone) */
  authorName?: string
  /** name the NEXT undo step in the operator's words («Feuer EG gelöscht») instead of «Plan …» */
  onStepLabel?: (label: string) => void
  /** symbol placed → App may offer logging it as Mittel (same hook as the Lage map) */
  /** record a plan mutation in the hash-chained audit trail (board.* ops). No-op
   *  default keeps the component usable standalone / in tests. */
  emit?: (op: string, payload?: Record<string, unknown>) => void
  /** expose this plan's per-document undo/redo so the GLOBAL TopBar control can drive
   *  it while the Plan is the active surface (App routes undo/redo by surface). */
  historyRef?: React.MutableRefObject<{ undo: (expect?: string) => boolean; redo: (expect?: string) => boolean } | null>
  /** ⚠️ The plan undo/redo STACKS, held by the caller: this component unmounts on every surface
   *  switch, so history kept in its own state was thrown away the moment you glanced at the
   *  Verlauf. Keyed by plan id, so it stays per-plan-document. See useBoardDoc · BoardHistory. */
  hist: BoardHistory
  setHist: React.Dispatch<React.SetStateAction<BoardHistory>>
  /** Tell the caller that this plan gained an undo step, so it lands on the ONE global timeline
   *  (lib/undoTimeline) in the same chronology as the Karte and the Atemschutz-Tafel. Every
   *  `setHist(pushBoardPast(…))` in this file owes it a call — the stacks and the timeline are
   *  two halves of one step and must never come apart. */
  onCheckpoint?: (planId: string, step: string) => void
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
  keysRef?: React.MutableRefObject<{ pickTool: (tool: string) => void; zoom: (f: number) => void; duplicate: () => void } | null>
  /** a Verlauf row asked to revisit a plan point — center + select on arrival. */
  /** `flash` shows the anno (a few-second outline) instead of selecting it — see the focus effect */
  focus: { x: number; y: number; floor: number; annoId?: string; twinEntityId?: string; flash?: boolean; nonce: number } | null
  /** report the current plan-view centre (tile-local). Optional and currently unused: it existed
   *  for the composer's «an der Planmitte anheften», which went away on 14.08. — the Wiedergabe
   *  answers «wie sah es da aus» by scrubbing the whole picture instead of storing a point. */
  onView?: (c: { x: number; y: number; floor: number }) => void
  /** currently monitored Atemschutz Trupps — offered when placing a team chip on the plan. */
  trupps?: Trupp[]
  /** every chip and marker name standing on ANY surface of this Einsatz — the Karte and every
   *  plan — so a new generic «Trupp N» draws from the one counter the Atemschutz board numbers
   *  from too (lib/placedTrupps · nextTruppNo). Absent: this board's own chips count alone. */
  placedTeamNames?: () => (string | undefined)[]
  /** Would renaming chip `id` to `label` say a «Trupp N» somebody holds? Then the rename pen
   *  refuses it (docs/trupp-naming.md §7 — a duplicate one device could see coming is never left
   *  for a merge to settle). Absent: this board's own chips are checked alone. */
  teamNameTaken?: (id: string, label: string) => boolean
  /** link a placed chip to a tracked Trupp (chip ↔ Trupp; sets the Trupp's annoId/planId). */
  onLinkTrupp?: (annoId: string, truppId: string) => void
  /** jump to the Atemschutz board for a linked Trupp ("show the trupp"). */
  onShowTrupp?: (truppId: string) => void
  /** the incident's ghost «Spuren» recorded on THIS sheet (lib/truppTrails · planGhostTrails) —
   *  the searched area a removed Trupp chip left behind. Drawn read-only and grey, on the storey
   *  each point was walked on; `onGhostTrail` is the «Spur löschen» door (absent ⇒ no door). */
  ghostTrails?: TruppTrail[]
  onGhostTrail?: (id: string) => void
  /** «Marker und Spur löschen» (18.09.2026): ARM the incident's ghost reconciliation to write
   *  this chip's ghost already deleted, so the removal that follows leaves no searched area
   *  standing (lib/truppTrails · reconcileGhostTrails `dropped`). Disarmed again when the
   *  removal is called off, or the chip's NEXT removal would silently take its trail with it. */
  onTrailDrop?: (annoId: string, on: boolean) => void
  /** join this CHIP to an Atemschutz-Trupp — `undefined` lets go of the one it has. The plan twin
   *  of the map marker's «Atemschutz-Trupp» menu (MapMarkers · onTeamTrupp) and routed through the
   *  same action, so the takeover confirm and the «einrücken?» ask exist exactly once
   *  (useTruppActions · adoptTruppMarker / releaseTruppMarker). A chip dropped before anybody was
   *  registered finds its Trupp afterwards, instead of having to be deleted and re-placed — which
   *  on a plan chip would throw away its recorded trail. Absent ⇒ no picker (read-only / locked). */
  onTeamTrupp?: (annoId: string, truppId: string | undefined) => void
  /** «Neuer Trupp» on that same menu: open the Anmeldung for a Trupp that adopts this chip on
   *  save (IncidentWorkspace · newTruppFromMarker). Absent ⇒ no row. */
  onTeamNewTrupp?: (annoId: string) => void
  /** «Gehört zu Trupp …» in the line editor — undefined truppId unlinks. Omitted ⇒ row hidden.
   *  Also the call a Trupp chip dropped on a hose's free end makes (see chipUp). */
  onLinkLineTrupp?: (annoId: string, truppId: string | undefined) => void
  /** A Leitung end just docked onto something — handed up so the workspace can join the hose to
   *  an Atemschutz-Trupp when the thing it docked onto is that Trupp's chip (useTruppActions ·
   *  linkLineToAttachedTrupp). The Karte reports the identical fact from its own magnet
   *  (lib/useMapDrawing · onLineAttached). */
  onLineAttached?: (annoId: string, attachment: LineAttachment) => void
  /** …and the reverse (15.09.): an end let go of its coupling («Lösen», or dragged off) – with
   *  the coupling it had, so the Trupp link that coupling made is dropped too. */
  onLineDetached?: (annoId: string, previous: LineAttachment) => void
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
  /** set when the AUTO-surfaced object is only the nearest one with plans, not the incident's
   *  own address – the chip turns amber and reads the distance (lib/useObjectPlans) */
  objectNearby?: { distanceM: number; objectId: string } | null
  /** the Einsatz the banner's dismissal is remembered for, and the address it contrasts with */
  incidentId?: string
  incidentAddress?: string | null
  /** anchor for «Automatisch ausrichten» — the active object's coordinate (else the Einsatzort);
   *  the backend fetches its OSM building reference box around it (lib/georefSuggest) */
  georefAnchor?: LngLat | null
  /** the Einsatz's own coordinate (null without one) — the pin on the Gebäude picker */
  incidentPos?: LngLat | null
  /** open the PlanPicker. Omitted (an Einsatz-Link, which is bound to one object's plans)
   *  hides the whole control — a read-out nobody may act on is chrome. */
  onObjectSwitch?: () => void
  /** per-plan distance calibration (planId → factor). A plan has no inherent scale; the user
   *  calibrates against a printed scale bar so line lengths read in metres. See lib/planScale. */
  planScale?: PlanScales
  /** persist a plan's calibration (null clears it). Rides the workspace blob via App. */
  onCalibrate?: (planId: string, scale: PlanScale | null) => void
  /** The Karte's live feed on this sheet — vehicles and shared responder positions, already
   *  projected and clipped by the caller (lib/planProjection · liveOverlay). Everything else
   *  the Karte holds is an OBJECT and arrives in `annos` like the sheet's own work. */
  live?: LiveMark[]
  /** Drag a live VEHICLE on this sheet: the same held-in-place override the Karte writes. */
  onPlanLiveMove?: (entityId: string, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  /** ⚠️ This gesture is OVER — called from every `phase === 'end'` path below. A gesture that
   *  reaches an object this sheet does not own is one step on the store's stack, and only the
   *  surface can say when it ended: the release writes its final frame from the same pointerup
   *  a listener would hear (lib/useObjectStore · endSheetStep). */
  onStepEnd?: () => void
  /** Show a plan-owned object at its projected position on the Lage map. */
  onPlanProjection?: (planId: string, annoId: string, coord: LngLat) => void
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
export interface PlanLogExtra {
  kind?: 'symbol' | 'team' | 'history'; annoId?: string; x?: number; y?: number; floor?: number
  /** which object a row is ABOUT without making it a jump target — a removal (types ·
   *  TimelineEvent.subjectId), exactly what the Karte's removal row carries */
  subjectId?: string
}

// Whiteboard / Tafel — pick a plan document as the background, then
// annotate it with draw / text / symbols and place resource chips whose
// timestamp updates each time they are moved. All annotation coordinates are
// normalized 0..1 in plan-image space so they stick across zoom/pan.
export function Whiteboard({ plans, activeId, annos, symMul = 1, captionMode = 'off', mapSuppressedCaptions, onChange, building, floorPack, onSelectBuilding, onBuildingFace, onReorient, onAddFloor, onRemoveFloor, readOnly: readOnlyProp = false, sym, rosterNames = [], rosterRank, onRosterField, personStatus, fieldHints, onRecent, log, authorName, onStepLabel, emit = () => {}, historyRef, hist, setHist, onCheckpoint, views, fitRef, keysRef, focus, onView, trupps = [], placedTeamNames, teamNameTaken, onLinkTrupp, onShowTrupp, ghostTrails = [], onGhostTrail, onTrailDrop, onTeamTrupp, onTeamNewTrupp, onLinkLineTrupp, onLineAttached, onLineDetached, onLineRenumber, truppSeverities, objectName, objectAddress, objectNearby, incidentId, incidentAddress, georefAnchor, incidentPos, onObjectSwitch, planScale = {}, onCalibrate, live = [], onPlanLiveMove, onStepEnd, onPlanProjection, slimTools: slimToolsProp = false, linkViewer = false, railLabels, suche, suchePins = [], onSuchePin, suchePick }: Props) {
  // repaint the baked placard glyphs (Kemler auto-derived via lookupUN) when the fetched
  // ADR dataset lands — see lib/useHazardData.
  useHazardData()
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
  /** THE SHEET, as opposed to the Modul slot `activeId` names — every Einsatzobjekt has a «Modul
   *  2», and everything that belongs to one concrete building's paper (its reference, its measured
   *  shape) is keyed on this. Read this high up because the aspect hook below already needs it. */
  const activeGeorefKey = active?.georefKey ?? activeId
  // A viewer-only plan (e.g. PV/documentation PDF) is read-only regardless of role: plain
  // pan/zoom, no drawing tools or annotation surface. Folds into the existing readOnly gates.
  const readOnly = readOnlyProp || active?.viewer === true || selectOnly
  // The slim read-only rail (Auswahl · Messen) — never on a viewer-only or selection-only
  // document, which has no tool rail for ANYONE, so a locked editor and a viewer keep seeing the
  // same surface.
  const slimRail = readOnly && slimToolsProp && active?.viewer !== true && !selectOnly
  // Messen left the Plan rail on 29.08. («a distance worth keeping is a drawn Linie») and came
  // BACK on 02.09.: the field kept reaching for the quick throwaway «wie weit?» glance, and a
  // drawn Linie is a journal-logged act, not a glance. See usePlanMeasure's header.
  const planTools = useMemo(() => appConfig.copy.planTools, [])
  const slimPlanTools = useMemo(() => slimTools(planTools, PLAN_READONLY_TOOLS), [planTools])
  const isPhone = useIsPhone()

  // ⚠️ `tool` is DERIVED, not raw state. The armed tool survives a plan switch (this component
  // does not remount between documents), so a Linie armed on the Tafel would arrive still armed
  // on the selection-only Umrisse sheet — with no rail left to disarm it. Forcing the rest tool
  // there closes every create path at once (they all gate on `tool`) instead of gating each.
  const [armedTool, setTool] = useState<BoardTool>('pan')
  /** measure node currently in the hand — its cumulative label (25px over the fingertip) steps
   *  aside and the fixed .measure-readout carries the number instead (mirrors MapView) */
  const [measDragNode, setMeasDragNode] = useState<number | null>(null)
  // released ANYWHERE ends the readout — the node drag itself is window-tracked (usePlanMeasure),
  // so the button that started it never reliably sees the up
  useEffect(() => {
    if (measDragNode == null) return
    const clear = () => setMeasDragNode(null)
    window.addEventListener('pointerup', clear, true)
    window.addEventListener('pointercancel', clear, true)
    return () => {
      window.removeEventListener('pointerup', clear, true)
      window.removeEventListener('pointercancel', clear, true)
    }
  }, [measDragNode])
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
  // …and the mirrored Karte objects the same box caught (D-09), by their twin key
  // (lib/georefTwins · `drawing:<id>` / `content:<id>`). The bar's writers fold each one back
  // through the fit and write the ONE source object on the Karte.
  const [editId, setEditId] = useState<string | null>(null)
  // which note has its detail panel open. Since 29.08. TAPPING a note opens it (chipDown) —
  // the same grammar as a symbol, unified across Karte and Plan. Still separate from selId:
  // a freshly PLACED note goes straight into typing (editId) and must not mount the panel
  // over the keyboard, so placement selects without opening this.
  const [notePanelId, setNotePanelId] = useState<string | null>(null)
  // …and which of them was just PLACED, so its panel opens with the caret in the text field
  // (the Karte's twin — IncidentWorkspace · notePlacedId). A one-shot: a later reopen is a read.
  const [notePlacedId, setNotePlacedId] = useState<string | null>(null)
  // style the NEXT note carries, chosen in the armed-tool dock before anything is placed
  const [noteDefaults, setNoteDefaults] = useState<{ size: NoteSize; plain: boolean; color: string }>(
    { size: 'm', plain: false, color: '' },
  )
  // which Georeferenz twin has its source-backed editor open — the Karte's object, mirrored onto
  // this sheet. Its open panel gives the projection the source object's normal selection halo.
  // a pending team placement awaiting a Trupp pick (x/y/floor of the tapped point)
  const [truppPick, setTruppPick] = useState<{ x: number; y: number; floor: number } | null>(null)
  // The NEXT ink's style — «the last line is the template» (the Lage map's drawColor/…).
  // Since «D pur» (09.09.) the docks carry no style controls and there is no preset row
  // either: the DrawEditor's edits write these back, decoration included.
  const [color, setColor] = useState<string>(appConfig.drawing.defaultColor)
  const [width, setWidth] = useState(5)
  const [dashed, setDashed] = useState(false)
  const [marker, setMarker] = useState('')
  const [lineArrow, setLineArrow] = useState(false)
  // Fläche: tapped nodes, or a dragged outline — the Lage map's `areaMode`, same default and
  // same reason (a fire's edge has no corners to tap).
  const [areaMode, setAreaMode] = useState<'nodes' | 'freehand'>('nodes')
  const [draft, setDraft] = useState<BoardPoint[] | null>(null)
  /** Absperrkreis being dragged out: centre (plan-normalized, storey-local) + radius as a
   *  fraction of the plan width. The drag IS the shape here, exactly as on the Karte
   *  (useMapCanvasGestures · circle), so it lives beside `draft` and never in the document. */
  const [circleDraft, setCircleDraft] = useState<{ x: number; y: number; floor: number; r: number } | null>(null)
  const draftAttachments = useRef<{ startAttachment?: LineAttachment; endAttachment?: LineAttachment }>({})
  // the single Linie tool's input mode: Freihand (drag) ↔ Punkte (tap each vertex), like the Lage map
  const [lineMode, setLineMode] = useState<'freehand' | 'nodes'>('freehand')
  /** Where the selected anno was TAPPED (client px), paired with its id so a selection that
   *  arrived some other way can't borrow a stale point. Read only by the panel nudge. */
  const [annoTap, setAnnoTap] = useState<{ id: string; x: number; y: number } | null>(null)
  /** the FIRST of a Rotation's two points, while the second is still being looked for (lib/shapes
   *  · SHAPE_TWO_POINT). Lives and dies with one placement gesture. */
  const [rotStart, setRotStart] = useState<BoardPoint | null>(null)
  // last node-tap (time + point) to detect a double-tap that finishes the shape
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  // h/w of the document box, plus «is that a measurement of THIS sheet or the A4 seed» — one hook,
  // keyed on the sheet rather than on the Modul slot, because the two questions go wrong together
  // (components/useMeasuredSheet). Seeded and reseeded there; nothing else may set it.
  const { aspect, takeAspect, measured: aspectMeasured } = useMeasuredSheet(activeGeorefKey, active?.orientation)
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
  // drag a single selected freehand stroke (its original board-space vertices + the start point)
  // `bpts` keep each vertex's storey AS STORED (floorGeometry · boardPts); `last` is the stroke as
  // the latest sample wrote it, which is what the release reports
  const drawDrag = useRef<{ id: string; floor: number; sx: number; sy: number; bpts: BoardPoint[]; moved: boolean; last?: BoardPoint[] } | null>(null)
  // `origin` + `attached` + `detach` are the RELEASE half of the ring language (see the Lage map's
  // EndpointDrag — same shape, board coords instead of lng/lat).
  const [planEndpointDragState, setPlanEndpointDragState] = useState<PlanEndpointDrag | null>(null)
  const planEndpointDrag = useRef<PlanEndpointDrag | null>(null)
  const planDwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPlanEndpointDrag = (next: PlanEndpointDrag | null) => { planEndpointDrag.current = next; setPlanEndpointDragState(next) }
  // `first` is where the stroke went DOWN — the start's claim is kept while the finger is still
  // within STROKE_START_RADIUS_PX of it (see updatePlanDraftMagnet), exactly as on the Lage map.
  type PlanDraftMagnet = { first: BoardPoint; atStart: boolean; point: BoardPoint; dwell: DwellState; candidate: MagneticTarget | null }
  const [planDraftMagnetState, setPlanDraftMagnetState] = useState<PlanDraftMagnet | null>(null)
  const planDraftMagnet = useRef<PlanDraftMagnet | null>(null)
  const planDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPlanDraftMagnet = (next: PlanDraftMagnet | null) => { planDraftMagnet.current = next; setPlanDraftMagnetState(next) }
  // which text note is mid-edit (so we checkpoint undo once per edit session, then stream
  // each keystroke live into the anno — like the Lage note title)
  const textEditId = useRef<string | null>(null)
  // The selection bar's drag origin: the original board-space geometry and bearings of every
  // selected anno, plus the centre a turn pivots about. Pan/pinch/marquee refs live in
  // useBoardGestures.
  type GrpOrig = { id: string; floor: number; rot?: number; rot2?: number; bx?: number; by?: number; bpts?: BoardPoint[] }
  const groupOrig = useRef<GrpOrig[]>([])
  const barRotCentre = useRef<{ x: number; y: number } | null>(null)
  // zoom/pan view state (layout-based zoom + focal wheel-zoom) lives in a hook, which also
  // remembers it per plan across a surface switch — `signature` says when a remembered view has
  // gone stale (the plan's image / floor stack / calibration changed under it).
  const viewMemory = views
    ? { views, planId: activeId, signature: boardViewSignature(active, building, planScale[activeId]) }
    : undefined
  // floor-stack: a vertical stack of footprint sheets (top = highest storey). Read before the
  // view hook because the stack zooms one step deeper than a sheet does (see MAX_SCALE_STACK).
  const stack = !!(active.floorStack && building && building.floors.length)
  // the Gebäude also keeps its «+ UG» off the bottom-left chip row (lib/whiteboard ·
  // STACK_CHIP_ROW); `vShift` is where the centre of the lane between bar and row lies — the
  // board transform, the zoom focus (useBoardView) and «centre on» all read it
  const botRes = stack ? STACK_CHIP_ROW : 0
  const vShift = (TOP_INSET - botRes) / 2
  // ⚠️ A sheet drawn from tiles zooms by its PAPER size (lib/planTiles · paperMaxScale): the fit it
  // is measured against is computed further down, so the ceiling lives in state and the view hook
  // reads it through a ref.
  const [paperScale, setPaperScale] = useState<number | null>(null)
  // …and a Gebäude whose storeys are tiled reports how dense its drawings lie on the board
  // (FloorPage · onDensity, board px per paper mm AT FIT), which gives the stack the same rule.
  const [stackDensity, setStackDensity] = useState<number | null>(null)
  const maxScale = stack
    ? (stackDensity ? paperMaxScale(stackDensity, 1, MAX_SCALE_STACK) : MAX_SCALE_STACK)
    : Math.max(MAX_SCALE, paperScale ?? 0)
  const { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom } = useBoardView(canvasRef, canvasEl, viewMemory, maxScale, vShift)

  const osm = active.osm
  /** every storey the building HAS, top-to-bottom – what the eye toggles list, what the document
   *  keeps ink for, and what the Rapport prints, whatever this device has folded away */
  const allFloorsTTB = useMemo(() => (stack ? [...building!.floors].sort((a, b) => b - a) : []), [stack, building])
  // …and which of them THIS DEVICE is looking at (lib/floorPrefs, 16.09.2026). Device-local on
  // purpose: folding a Geschoss away is a way of reading the stack, so it never reaches the synced
  // workspace – the Karte, the other tablets and the Rapport keep the whole building.
  const [hiddenFloors, setHiddenFloors] = useState<number[]>(() => (incidentId ? loadHiddenFloors(incidentId) : []))
  useEffect(() => { setHiddenFloors(incidentId ? loadHiddenFloors(incidentId) : []) }, [incidentId])
  const floorsTTB = useMemo(() => shownFloors(allFloorsTTB, hiddenFloors), [allFloorsTTB, hiddenFloors])
  const N = floorsTTB.length || 1
  const putHidden = (next: number[]) => {
    setHiddenFloors(next)
    if (incidentId) saveHiddenFloors(incidentId, next)
  }
  /** Fold a storey away, or bring it back. ⚠️ The LAST visible one cannot be folded: a stack with
   *  no tile has nothing left to tap, and the way back would be gone with it. */
  const toggleFloor = (f: number) => {
    if (hiddenFloors.includes(f)) { putHidden(hiddenFloors.filter((x) => x !== f)); return }
    if (floorsTTB.length <= 1) return
    putHidden([...hiddenFloors, f])
  }
  /** Bring a storey back because something is SENDING us there – a stair mark tapped on the tile
   *  below, a Leitung climbing into it. Being sent to a storey that is not on the board would
   *  otherwise pan the view into empty space (or, for the climb, do nothing at all). */
  const revealFloor = (f: number) => { if (hiddenFloors.includes(f)) putHidden(hiddenFloors.filter((x) => x !== f)) }
  /** The folded-away storeys as strips: where each one belongs between the drawn tiles (`seam` =
   *  how many drawn tiles are above it) and how many folded storeys share that seam. */
  const folded = useMemo(() => {
    let seam = 0, order = 0
    const rows = allFloorsTTB.flatMap((f) => {
      if (floorsTTB.includes(f)) { seam += 1; order = 0; return [] }
      return [{ floor: f, seam, order: order++ }]
    })
    // how many share each seam – the group ABOVE the top tile grows upwards, so it needs to know
    // its own size to keep the storeys in order (the highest one furthest from the board)
    const sizes = new Map<number, number>()
    for (const r of rows) sizes.set(r.seam, (sizes.get(r.seam) ?? 0) + 1)
    return rows.map((r) => ({ ...r, count: sizes.get(r.seam)! }))
  }, [allFloorsTTB, floorsTTB])
  /** how many PDF regions the stack bakes, which is what shares the device's pixel budget – a
   *  storey drawn as two wings is two rasters, not one (lib/pdfRenderBudget · pageCanvasBudget) */
  const drawings = Math.max(N, floorPack ? floorsTTB.reduce((n, f) => n + (floorPack.tiles[f]?.length ?? 0), 0) : 0)
  const blank = !active.imageUrl && !osm && !stack

  // Active footprint view: buildings picked since auto-orientation carry `src`, so the
  // rendered rings/aspect are derived for the current orientation (oriented by default,
  // or north-up when toggled). Older docs fall back to their stored rings (north-up only).
  /** What the Gebäudeview TURNS: a picked footprint, or – since 16.09.2026 – the plan pack's own
   *  frame as a rectangle in isotropic page space (lib/stackFit · packFrameRing). One ring either
   *  way, so the rotation, the annotation re-glue and the north dial are the same machinery for a
   *  Geschossplan as for an outline. */
  const orientSrc = useMemo(
    () => (building?.pack ? packFrameRing(building.pack) : building?.src?.length ? (building.src as Ring[]) : null),
    [building],
  )
  // a pack's «Längsachse» is its frame's long side; an outline's is its principal axis, computed
  // once when it was picked
  const orientDeg = useMemo(
    () => (building?.pack ? principalAngleDeg(packFrameRing(building.pack)) : building?.orientDeg ?? 0),
    [building],
  )
  const viewAngle = building ? activeViewDeg(building) : 0
  // A8 (29.08.): a DRAG on the north dial rotates the building continuously. While the finger
  // is down this holds the live preview angle; the commit (one reorientTo, through the same
  // remap + undo path as the tap) happens on release, so annotations re-glue exactly once.
  // The release is the slider's native `change`; a gesture cancelled instead drops the preview
  // again (OrientSlider).
  const [dialDragDeg, setDialDragDeg] = useState<number | null>(null)
  const shownAngle = dialDragDeg ?? viewAngle
  /** the turned view of `orientSrc` – present whenever there is something to turn */
  const packView = useMemo(() => (orientSrc ? buildView(orientSrc, shownAngle) : null), [orientSrc, shownAngle])
  const fpView = useMemo(
    () => (packView ?? (building ? { rings: building.rings ?? [building.ring], aspect: building.ringAspect } : null)),
    [packView, building],
  )
  // the align-longest-axis compass only makes sense on the Gebäude floor-stack (whose storeys are
  // drawn from the building footprint). On a module/PDF plan the page is already aligned, so even
  // though a building may be selected at the incident level, the compass must NOT appear there.
  // ⚠️ A PACK may always be turned: its pages are drawn the way the architect's sheet happened to
  // lie, which is exactly what the operator needs to be able to correct. A footprint is only worth
  // offering when its auto-orientation found something to straighten.
  const canOrient = stack && (!!building?.pack || (!!building?.src?.length && Math.abs(orientDeg) > 0.001))
  /** where north is on the paper this stack shows: for an outline, the view angle itself (0 = north
   *  up, by construction); for a pack, the page's own bearing from its map fit, turned by the view.
   *  Null when a pack has no approved fit – then nothing here knows where north is, and the dial
   *  says so instead of pointing somewhere. */
  const northDeg = building?.pack
    ? floorPack?.fit ? floorPack.fit.rotationDeg + shownAngle : null
    : shownAngle

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
  const { mapY, localY, floorAt, boardPts, moveRigid } = floorGeometry(stack, floorsTTB, N)

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
    setTool('pan'); setPending(null); setPendingShape(null); setPaletteOpen(false); setDraft(null); setCircleDraft(null)
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
      if (rotStart) { setRotStart(null); clearRotMagnet() }
      else if (draft) { setDraft(null); draftAttachments.current = {}; lastTap.current = null }
      else if (circleDraft) setCircleDraft(null)
      // …then the Passung dock. It is deliberately not an Overlay (it must not trap the board
      // behind a scrim while a fit is being judged), so it has no Escape of its own and would
      // otherwise be the ONE panel on this surface that the key cannot dismiss.
      else if (qualityFor) setQualityFor(null)
      else if (notePanelId) setNotePanelId(null)
      else if (selId) setSelId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, circleDraft, qualityFor, selId, notePanelId])

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
  // …and the sheets that have a tile pyramid are fetched WHOLE for offline use (lib/planTilePrefetch)
  useEffect(() => {
    const t = setTimeout(() => prefetchPlanTiles(plans.filter((p) => p.imageUrl).map((p) => planUrl(p.imageUrl))), 4000)
    return () => clearTimeout(t)
  }, [plans])

  // in stack mode the board's aspect is driven by the floor count and the BUILDING's own storey
  // band – a flat hall gets flat cards, so the stack is as tall as its drawings need (16.09.2026)
  const tileAR = tileAspectOf(building)
  const effAspect = stack ? N * tileAR : aspect
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
    const h = Math.max(0, vp.h - TOP_INSET - botRes - (stack ? 2 * STACK_VPAD : 0)); if (!w || !h) return { w: 0, h: 0 }
    const byW = { w, h: w * effAspect }
    return byW.h <= h ? byW : { w: h / effAspect, h }
  }, [vp, effAspect, stack, side, botRes])
  // a storey says its density at the CURRENT zoom; the ceiling wants it at fit. Rounded, so the
  // sub-pixel wobble of a re-layout cannot move the ceiling under a finger.
  const takeStackDensity = (now: number) => {
    // `scale` of THIS render – the one the storey measured itself in – never the ref, which a
    // pinch has already moved on
    const atFit = Math.round((now / (scale || 1)) * 100) / 100
    if (atFit > 0) setStackDensity((was) => (was === atFit ? was : atFit))
  }
  const paperMm = usePlanPaperMm(!stack && active.imageUrl ? planUrl(active.imageUrl) : null)
  useEffect(() => {
    setPaperScale(paperMm && fit.w ? paperMaxScale(fit.w, paperMm, MAX_SCALE) : null)
  }, [paperMm, fit.w])
  // Zoom by LAYOUT, not by a CSS scale transform: the board's real pixel size is
  // fit × scale. This re-rasterizes the PDF + SVG symbols + text crisply at the
  // actual zoom instead of bitmap-scaling a 100% texture (which pixelates them).
  const sW = fit.w * scale, sH = fit.h * scale

  // client point → normalized 0..1 in plan space (board rect reflects the transform)
  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const r = boardRef.current?.getBoundingClientRect(); if (!r || !r.width) return null
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height]
  }
  // the Suche's pick (26.09.2026): a TAP — one finger, no travel — on the sheet is the position;
  // anything else stays the board's own gesture (a pan, a pinch). Read in the capture phase, so
  // the stage below still pans as ever; the transparent layer over the sheet keeps the tap off
  // whatever stands there.
  const pickTap = useRef<{ x: number; y: number; n: number } | null>(null)
  const pickUp = (e: React.PointerEvent) => {
    const t = pickTap.current
    pickTap.current = null
    if (!suchePick || !t || t.n > 1 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) return
    const n = toNorm(e.clientX, e.clientY)
    if (!n || n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1) return
    const floor = stack ? floorAt(n[1]) : 0
    suchePick.onPick({ planId: activeId, x: n[0], y: stack ? localY(n[1], floor) : n[1], floor })
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
  // Opening a sheet is the moment its station data has to be current: the Massstab and the
  // Georeferenz are set by whoever happens to be holding a device, and every OTHER device only
  // read the document once, at boot. Re-reads on plan switch (and on focus, from main.tsx);
  // an unchanged answer notifies nobody, so this costs a render only when something really moved.
  useEffect(() => { void refreshStationPlanScales() }, [activeGeorefKey])
  const canGeoref = !osm && !blank && !stack && active?.viewer !== true
  const measureARForGeoref = stack ? 1 / tileAR : 1 / aspect
  const georefPairs = georefArmed ? georef.pairs : georefForPlan(activeGeorefKey)?.pairs ?? []
  const georefFit = canGeoref ? fitSimilarity(georefPairs, measureARForGeoref) : null
  // A7 (29.08.): the Gebäude floor-stack is excluded from the georef fit (one similarity can't
  // mean anything across a column of storey copies), but its scale needs no fit at all — the
  // footprint's ground size is known since georeferencing shipped (`geo.spanM`), so the Massstab
  // is derived from geometry alone and a fresh Gebäude measures immediately. Committed view
  // angle on purpose (not the drag preview): the derived factor must match the document the
  // measured lines are glued to. Legacy buildings without `geo` keep the manual calibration
  // path (SrcGeoref's contract: nothing may misbehave without it).
  // …and a PACK stack knows it from the pack's map fit (lib/stackFit): tile → frame → page → ground
  // is one similarity, whose metres per tile unit are the Massstab – «Ref. auto», like a linked sheet.
  const packMPerU = stack && building?.pack && floorPack?.fit ? stackGroundFit(building, floorPack.fit)?.scaleMPerU ?? null : null
  const stackMPerU = packMPerU ?? (stack && building?.src?.length && building.geo
    ? stackScaleMPerU(building.src, building.geo.spanM, viewAngle, N, measureARForGeoref)
    : null)
  const autoScale: PlanScale | undefined = georefFit
    ? { mPerU: georefFit.scaleMPerU, refM: 0, ar: measureARForGeoref }
    : stackMPerU
      ? { mPerU: stackMPerU, refM: 0, ar: measureARForGeoref }
      : undefined
  /**
   * ⚠️ …and this surface tells the station document what SHAPE the sheet is.
   *
   * It is the only one that can. The app shell solves every plan's fit through an aspect recovered
   * from the plan's stored calibration (georefTwins · planAspect), and that number goes stale the
   * moment a Modul PDF is replaced by a differently-shaped sheet — undetectably, because
   * staleness is measured against the very aspect being looked for and the pairs were fitted at
   * the same wrong one. Here the bitmap is on screen and measured. Once per sheet per session,
   * only for a sheet that HAS a reference (the fit is what the number is for), only when it
   * really disagrees, and never from a read-only session: `noteMeasuredAspect` holds all four
   * conditions, so this is just the offer.
   */
  useEffect(() => {
    if (readOnlyProp || !canGeoref || !active || !aspectMeasured) return
    if (!georefForPlan(activeGeorefKey)?.pairs.length) return
    noteMeasuredAspect(activeGeorefKey, measureARForGeoref, planAspect(active, getStationPlanScales(), planScale[activeId]))
  }, [readOnlyProp, canGeoref, active, aspectMeasured, activeId, activeGeorefKey, measureARForGeoref, planScale])
  const {
    calNodes, setCalNodes, calPrompt, setCalPrompt, lastRefM, refMInput, setRefMInput, savePrompt, setSavePrompt,
    measMode, setMeasMode, setMeasLine, setMeasArea,
    measureAR, activeScale, scaleAuto, scaleStale, calibrated, planMetres,
    measPath, setMeasPath, measMpts, measLenM, measAreaM2, measPerimM, measReset, resetEphemeral,
    measNodeDown, measMove, measUp, measDragging, measInsert, measDelete, measPress,
    closeCalPrompt, commitCalibration,
  } = usePlanMeasure({ activeId, stack, aspect, tileAR, planScale, localY, floorAt, tool, setTool, toNorm, log, onCalibrate, autoScale })
  /**
   * The sheet's own ground width in metres — one normalized sheet width is `mPerU · measureAR`,
   * because the measurement space is `(nx · measureAR, ny)` (lib/planScale's header) and a stored
   * `x`/`sizeN` is a fraction of the WIDTH. Identical to `georefTwins · planGroundWidthM` for a
   * georeferenced sheet (`activeScale.mPerU` is then the fit's `scaleMPerU`), but it also answers
   * for a Gebäude stack and for a hand-calibrated plan, which is exactly what «the plan knows its
   * scale» has to mean. Null on a sheet that does not know.
   */
  const planWidthM = activeScale ? activeScale.mPerU * measureAR : null
  /** …so a Rotation on a scaled sheet states the same 300 m / 20–45 m / 20 km the Karte does
   *  (lib/shapes · rotationBoundsN). Read by the placement tap, the two end grips and the ±
   *  «Länge» stepper, so all three agree with each other and with the map. */
  const rotN = rotationBoundsN(planWidthM)

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
  // ⚠️ …and whether the station APPROVED this sheet's fit (incidentPlanBindings ·
  // incidentBindingApproved): an approved fit is a linked one, in the same tone a hand-measured
  // reference wears — see georefMode · georefChip (18.09.2026).
  const georefApproved = incidentBindingApproved(activeGeorefKey)
  const georefState = georefChip(georefFit, georef, activeId, georefPairs, georefApproved)
  /** The Massstab pill's own lamp (18.09.2026) — the phone pill is icon + lamp and nothing else,
   *  so this dot is all that is left of «Ref. 25 m» / «nicht kalibriert» / «Massstab neu prüfen».
   *  The mapping is a pure helper (planScale · scaleLampTone) so the tones cannot drift from the
   *  branches the chip below actually renders. A scale DERIVED from the Kartenverknüpfung is only
   *  as trustworthy as that fit, so it borrows the georef chip's own warn state. */
  const scaleTone = scaleLampTone({
    auto: scaleAuto, autoFromFit: !!georefFit, fitWarn: georefState.warn, stale: scaleStale, calibrated,
  })
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
  // ── «Automatisch ausrichten» — the CV suggestion path of an unlinked sheet ─────────────────
  // The unlinked chip opens a two-way chooser when the matcher CAN be asked (Modul-2 template,
  // an anchor coordinate, a resolvable calibration); otherwise it arms the point flow directly,
  // exactly as before. The suggestion arrives as a PROPOSAL review on the coverage view —
  // nothing is stored until «Übernehmen» there (lib/georefMode · startGeorefProposal).
  const [linkChoice, setLinkChoice] = useState(false)
  // the phase the busy card names (render → Gebäudedaten → vergleichen); null = not running
  const [autoStep, setAutoStep] = useState<GeorefSuggestStep | null>(null)
  const autoBusy = autoStep != null
  // Token of the CURRENT auto-align run. The matcher takes seconds and a thread cannot be
  // recalled — but its ANSWER can be orphaned: closing the chooser, switching sheets or
  // starting a fresh run bumps the token, so a stale completion can never yank the workspace
  // into a proposal review nobody is waiting for.
  const autoRunRef = useRef(0)
  useEffect(() => { autoRunRef.current++; setLinkChoice(false); setAutoStep(null) }, [activeId])
  // Warm «Plan rendern» — the matcher raster (usually the resident bake, encoded) and the
  // printed-scale read — the moment the chooser opens, so the seconds the operator spends
  // reading the card cover whatever little work remains.
  useEffect(() => {
    if (!linkChoice || !active?.imageUrl) return
    const url = planUrl(active.imageUrl)
    void planMatcherImage(url).catch(() => {})
    void planPrintedMPerU(url).catch(() => {})
  }, [linkChoice]) // eslint-disable-line react-hooks/exhaustive-deps
  const georefAnchorPt = georefAnchor ? { lng: georefAnchor[0], lat: georefAnchor[1] } : null
  const canAutoAlign = !!active?.imageUrl && georefSuggestEligible(activeId, georefAnchorPt)
  const runAutoAlign = async () => {
    if (!georefAnchorPt || !active?.imageUrl || autoBusy) return
    const runId = ++autoRunRef.current
    setAutoStep('render')
    try {
      const out = await requestGeorefSuggestion(
        {
          planUrl: planUrl(active.imageUrl),
          anchor: georefAnchorPt,
          mPerU: activeScale?.mPerU,
          template: activeId.startsWith('modul1') ? 'm1' : 'm2',
        },
        (step) => { if (runId === autoRunRef.current) setAutoStep(step) },
      )
      // the chooser was closed / the sheet switched while the matcher ran — orphaned answer
      if (runId !== autoRunRef.current) return
      if (out.kind !== 'fit') {
        // a normal outcome, not an error: the chooser stays up, «Punkte selbst setzen» is right there
        toast(out.kind === 'noScale' ? appConfig.copy.whiteboard.georef.autoNoScale : appConfig.copy.whiteboard.georef.autoNone, { icon: 'warn', tone: 'warn' })
        return
      }
      setLinkChoice(false)
      startGeorefProposal(activeId, measureAR, { storageKey: activeGeorefKey, pairs: out.suggestion.pairs, previewUrl: georefPreviewUrl(), uncertain: !out.suggestion.confident })
    } catch (e) {
      if (runId !== autoRunRef.current) return // an orphaned failure has no audience either
      const unavailable = e instanceof ApiError && e.status === 503
      toast(unavailable ? appConfig.copy.whiteboard.georef.autoUnavailable : appConfig.copy.whiteboard.georef.autoFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      if (runId === autoRunRef.current) setAutoStep(null)
    }
  }
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
  /** A live VEHICLE dropped on the paper: folded back through this sheet's own fit and handed to
   *  the Karte's writer, which turns it into the same held-in-place override the Karte writes.
   *  `georefFit.toMap` is the exact inverse of the projection that drew the mark, so it lands
   *  where it was dropped. Gated on `readOnly`: a viewer may look and nothing more. */
  const moveLiveMark = useCallback((id: string, pt: { x: number; y: number }, phase: 'start' | 'move' | 'end') => {
    if (readOnly || !georefFit || !onPlanLiveMove) return
    const c = georefFit.toMap(pt)
    onPlanLiveMove(id, [c.lng, c.lat], phase)
  }, [readOnly, georefFit, onPlanLiveMove])

  // reset transient state when switching document. Sits BELOW the hook because it clears the
  // state the hook owns — above it, resetEphemeral is not yet declared.
  // ⚠️ The ASPECT is no longer seeded here, and deliberately: this effect is keyed on the Modul
  // SLOT, which does not change when the operator switches Einsatzobjekt — so the seed never ran
  // for the new building and the previous one's shape carried over into its fit. It is reseeded
  // per SHEET now (components/useMeasuredSheet), which covers a plan switch as well.
  // ⚠️ The VIEW is no longer reset here: useBoardView restores the plan's remembered zoom/pan
  // (falling back to fit on a first visit), and a reset here would run after it and undo it.
  useEffect(() => {
    setSelId(null); setSelIds([]); setEditId(null); setDraft(null); setPending(null)
    resetEphemeral() // the calibrate state usePlanMeasure owns
    if (tool === 'symbol') setTool('pan')
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
    annos, onChange, emit, activeId, selId, setSelId, editId, setEditId, historyRef, hist, setHist, onCheckpoint, onStepEnd,
  })
  // expose fit-to-view (the phone top bar's Fit button calls it; desktop uses the rail footer)
  useEffect(() => { if (fitRef) fitRef.current = () => applyView(1, { x: 0, y: 0 }); return () => { if (fitRef) fitRef.current = null } })
  /**
   * Cmd/Ctrl+D — duplicate the ONE selected annotation, a small nudge away so the copy is visibly
   * offset and separately selectable (A22). The Karte's own semantics (IncidentWorkspace ·
   * duplicateSelection), in plan-width fractions: one object at a time, one undo step, one
   * «Objekt dupliziert» row, and the selection moves to the copy.
   *
   * Deliberately NOT wired for a Mehrfach group or for a mirrored object — neither is on the
   * Karte either. A group would need a per-item id remap (and, on the Kroki, would have to decide
   * what a copied attachment points at); a twin's source lives in the other document, and this
   * surface's `add` writes only its own.
   *
   * ⚠️ The copy carries no `trail`. A recorded track belongs to the Trupp that walked it, and a
   * duplicate that inherited it would put a fabricated movement history into the record — and,
   * since 18.09.2026, leave a ghost trail behind that nobody ever walked.
   */
  const DUP_OFFSET_N = 0.02 // ~2 % of the plan width — the same visible nudge a detached endpoint gets
  const DUP_PREFIX: Record<BoardKind, string> = { draw: 'l', area: 'a', circle: 'c', text: 't', symbol: 's', shape: 'sh', resource: 'r' }
  const duplicateSelection = () => {
    if (readOnly || selIds.length > 1) return
    const src = annos.find((a) => a.id === selId)
    if (!src) return
    const id = newId(DUP_PREFIX[src.kind])
    // …and no «Gelöscht / erledigt» either: the copy is a new thing on the picture (lib/duplicate)
    const { done: _done, ...rest } = src
    // ⚠️ a loose «Trupp 3» copied is not a second Trupp 3 (docs/trupp-naming.md §7): it takes the
    // next number of the one counter, as a chip dropped with the Trupp tool would
    const teamNames = () => [...annos.filter((a) => a.kind === 'resource').map((a) => a.text), ...(placedTeamNames?.() ?? [])]
    const copy: BoardAnno = {
      ...rest, id, trail: undefined,
      ...(src.kind === 'resource' && !src.truppId ? { text: freshTeamLabel(src.text, teamNames()) } : {}),
      ...(src.pts ? { pts: src.pts.map(([x, y, floor]): BoardPoint => [x + DUP_OFFSET_N, y + DUP_OFFSET_N, floor ?? src.floor ?? 0]) } : {}),
      ...(src.x != null ? { x: src.x + DUP_OFFSET_N } : {}),
      ...(src.y != null ? { y: src.y + DUP_OFFSET_N } : {}),
    }
    add(copy)
    setSelId(id); setSelIds([])
    log('layers', appConfig.copy.log.duplicated, { annoId: id, x: copy.x ?? copy.pts?.[0]?.[0], y: copy.y ?? copy.pts?.[0]?.[1], floor: copy.floor })
  }

  // expose tool-pick + zoom + duplicate to the keyboard-shortcut layer. Semantic ids (from App) →
  // Plan tools; the rest tool is 'pan' (the plan pans on empty canvas), 'note'→'text',
  // 'team'→'resource'. No dep array (mirrors fitRef) so the handle always closes over live state.
  useEffect(() => {
    if (!keysRef) return
    const MAP: Record<string, BoardTool> = { select: 'pan', lasso: 'lasso', line: 'line', area: 'area', circle: 'circle', note: 'text', team: 'resource', measure: 'measure' }
    keysRef.current = {
      pickTool: (cmd) => {
        if (selectOnly) return // the Umrisse sheet arms nothing — by keyboard either (see selectOnly)
        if (cmd === 'symbol') { setTool('symbol'); setPaletteOpen(true); return }
        const id = MAP[cmd]; if (!id) return
        setTool(tool === id ? 'pan' : id); setPending(null)
      },
      zoom: (f) => zoom(f),
      duplicate: () => duplicateSelection(),
    }
    return () => { if (keysRef) keysRef.current = null }
  })

  // every tap-to-place tool needs the .wb-ink capture overlay mounted — INCLUDING 'shape'
  // (the palette's Rauch/Rechteck/Pfeil forms). Omitting 'shape' left its overlay off the
  // Plan, so arming a shape froze the surface: the tap placed nothing and, with no overlay,
  // the board couldn't pan either. placeNode already handles 'shape'.
  const creating = tool === 'line' || tool === 'area' || tool === 'circle' || tool === 'text' || tool === 'symbol' || tool === 'shape' || tool === 'resource' || tool === 'scale' || tool === 'measure'
  /** a two-point shape (Rotation) is armed: each of its two taps may claim a symbol, and it does
   *  so by dwelling — press, hold until the ring closes, let go (lib/shapes · SHAPE_TWO_POINT) */
  const rotPlacing = tool === 'shape' && !!pendingShape && SHAPE_TWO_POINT[pendingShape] && !readOnly
  // Derived guard, not per-exit bookkeeping (the Lage map has the same one): the moment the
  // two-point gesture stops being armed, its first point is meaningless — left behind, it drew
  // an orphaned anchor dot in pan mode and silently became one end of the NEXT Rotation.
  useEffect(() => {
    if (!rotPlacing) { setRotStart(null); clearRotMagnet() }
  }, [rotPlacing]) // eslint-disable-line react-hooks/exhaustive-deps
  // node-based (tap each vertex, then finish): the area tool, and the Linie tool in Punkte mode.
  // In Freihand mode the Linie tool drags a stroke instead (handled below).
  const noding = (tool === 'area' && areaMode === 'nodes') || (tool === 'line' && lineMode === 'nodes')
  /** the drag IS the shape right now — a freehand Linie or a freehand Fläche. The one
   *  predicate the three pointer handlers share, so the two tools cannot drift apart. */
  const inking = (tool === 'line' && lineMode === 'freehand') || (tool === 'area' && areaMode === 'freehand')
  // the in-progress node draft is committable: an area needs ≥3 pts, a Punkte-mode line ≥2 (gates ✓)
  const draftActive = (tool === 'area' && areaMode === 'nodes' && (draft?.length ?? 0) >= minPoints('area')) || (tool === 'line' && lineMode === 'nodes' && (draft?.length ?? 0) >= minPoints('draw'))
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
  /** The box a plan object offers an attaching line, in board px. A team chip is a left-anchored
   *  STRIP — its stored point is the DOT, so its ~76×44 body hangs to the RIGHT of that point
   *  rather than around it (see the wb-anno transform); `dx` puts the box back over the chip. */
  const attachBox = (a: Pick<BoardAnno, 'kind'>) => (a.kind === 'resource'
    ? { width: 76, height: 44, dx: 76 / 2 - TEAM_DOT_PX / 2 }
    : { width: symBase, height: symBase, dx: 0 })
  /**
   * Every MIRRORED Karte object this sheet offers a docking Leitung — the same kinds a native
   * plan symbol/chip offers (lib/lineAttachments · MAGNET_ANNO_KINDS). A hose that reaches the
   * mirrored TLF has reached the TLF; nothing on the surface said why it could not (D-08).
   * ⚠️ The stored attachment names an object in the KARTE's document. See the Lage's twin of this
   * list (MapView · twinMagnets) for what that costs: the live surfaces resolve it, print and
   * a far-side delete fall back to the stored point, which resolveLinePoints already does safely.
   */
  const objectPoint = (id: string, toward: BoardPoint, _a: LineAttachment, source: AttachableLine<BoardPoint>): BoardPoint | null => {
    const target = annos.find((a) => a.id === id && isMagnetAnno(a)) ?? null
    if (!target || target.x == null || target.y == null || !sW || !sH) return null
    const floor = target.floor ?? 0
    const box = attachBox(target)
    const center: [number, number] = [target.x * sW + box.dx, mapY(floor, target.y) * sH]
    const tp: [number, number] = [toward[0] * sW, mapY(toward[2] ?? floor, toward[1]) * sH]
    // negative padding = the endpoint lands just INSIDE the glyph, so the stroke disappears
    // under the symbol instead of stopping short of it (see attachInsetPx)
    const p = boundaryPoint({ shape: 'rect', center, width: box.width, height: box.height, rotation: target.rotation }, tp, -attachInsetPx(source.width))
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

  /** Every placed Trupp chip on this sheet, as the one-Trupp rule reads them (a Plan's `resource`
   *  is the Karte's team marker — lib/truppLines · TruppMarker). */
  const planTruppMarkers = () => annos.flatMap((a) => (a.kind === 'resource' ? [{ id: a.id, truppId: a.truppId }] : []))
  const planCandidatesAt = (sourceId: string, pointer: [number, number]): MagneticTarget[] => {
    // ── EINE Leitung, EIN Trupp, schon am Magneten (lib/truppLines · markerTakesLineEnd) ──
    // The Plan's twin of the Lage rule (MapView · candidatesAt): a hose that already has a crew
    // does not see another Trupp's chip as a target at all — only its own, so a coupling pulled
    // off can be put back. A draft is judged by the claim its first end already made.
    const draftStart = draftAttachments.current.startAttachment
    const srcLine: LinkableLine | undefined = annos.find((a) => a.id === sourceId && a.kind === 'draw')
      ?? (sourceId === '__draft__' ? { id: sourceId, truppId: truppIdForAttachment(draftStart, planTruppMarkers()) } : undefined)
    const objects: MagneticTarget[] = annos
      .filter((a) => isMagnetAnno(a) && a.x != null && a.y != null
        && (a.kind !== 'resource' || markerTakesLineEnd(srcLine, trupps, { id: a.id, truppId: a.truppId })))
      .map((a) => {
        const box = attachBox(a)
        const center: [number, number] = [a.x! * sW + box.dx, mapY(a.floor, a.y!) * sH]
        const edge = boundaryPoint({ shape: 'rect', center, width: box.width, height: box.height, rotation: a.rotation }, pointer)
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
   *  the Teilstück's prong because that is where the branch begins); a SYMBOL acquired later in
   *  the same stroke has to hold still for `MAGNET_DWELL_MS` first, a LINE target acquired later
   *  arms at once (lib/lineAttachments · dwellFor).
   *
   *  `atStart` is the caller's claim on pointerDOWN only. A MOVE re-derives it from the stroke's
   *  own first point — the map's rule — so it is not passed there. */
  const updatePlanDraftMagnet = (point: BoardPoint, phase: 'start' | 'move', atStart = false) => {
    const pointer: [number, number] = [point[0] * sW, mapY(point[2], point[1]) * sH]
    const cur = planDraftMagnet.current
    const targets = planCandidatesAt('__draft__', pointer)
    if (planDraftTimer.current) clearTimeout(planDraftTimer.current)
    if (phase === 'start') {
      const candidate = nearestMagneticTarget(pointer, targets)
      setPlanDraftMagnet({ first: point, point, atStart, candidate, dwell: armDwell(candidate?.key ?? null, Date.now()) })
      if (candidate) {
        draftAttachments.current = { ...draftAttachments.current, [atStart ? 'startAttachment' : 'endAttachment']: planAttachmentFor(candidate) }
        buzz()
      }
      return
    }
    if (!cur) return
    // The start KEEPS its claim while the finger is still within STROKE_START_RADIUS_PX of the
    // pointerDOWN point and has not already banked a start attachment — the same rule the map
    // applies (MapView · updateDraftMagnet). The Plan used to hand `false` in from the very first
    // pixel of movement, so a SHORT stroke begun on a symbol lost the start's ring before it could
    // ever be honoured. Leaving that radius ends the claim: from there the FAR end earns its own
    // ring, even over the very target the stroke began on.
    const first = cur.first
    const firstPx: [number, number] = [first[0] * sW, mapY(first[2], first[1]) * sH]
    const nowAtStart = cur.atStart && distance(firstPx, pointer) < STROKE_START_RADIUS_PX && !draftAttachments.current.startAttachment
    const candidate = stickyMagneticTarget(pointer, targets, cur.candidate?.key ?? null)
    const base = nowAtStart === cur.atStart ? cur.dwell : EMPTY_DWELL
    const next: PlanDraftMagnet = { first, point, atStart: nowAtStart, candidate, dwell: advanceDwell(base, candidate, Date.now()) }
    setPlanDraftMagnet(next)
    // a line target arms on acquisition (dwellFor = 0) — one buzz, as the closed ring gives
    if (next.dwell.armed && !base.armed) buzz()
    // arm on a motionless finger (no pointermove ⇒ no advanceDwell); the attachment itself is
    // only written on release, so moving on after arming still lets the end go free.
    if (candidate && !next.dwell.armed) planDraftTimer.current = setTimeout(() => {
      const now = planDraftMagnet.current
      if (!now || now.candidate?.key !== candidate.key) return
      setPlanDraftMagnet({ ...now, dwell: { ...now.dwell, armed: true } }); buzz()
    }, Math.max(0, dwellFor(candidate) - (Date.now() - next.dwell.since)))
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
      if (inking) { setDraft(null); if (tool === 'line') { finishPlanDraftMagnet(); draftAttachments.current = {} } }
      setCircleDraft(null) // two fingers navigate — no cordon is laid by a pinch
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
      updatePlanDraftMagnet([x, y, floor], 'start', atStart)
    }
    if (tool === 'circle') {
      // Absperrkreis: press = the centre, drag = the radius, exactly the Karte's grammar
      // (useMapCanvasGestures · circle). The ring shows at its default radius the instant the
      // finger lands — «etwas ist hier, zieh es auf» — instead of a zero-size point, and a
      // release without a drag commits that default rather than nothing.
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      draftFloor.current = floor
      setCircleDraft({ x, y, floor, r: appConfig.drawing.circleInitialRadiusN })
      return
    }
    if (inking) {
      // Freehand is the one create gesture that IS the drag — the stroke follows the finger,
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
    // …and a two-point shape's tap may claim a symbol: press, hold until the ring closes, let go
    if (rotPlacing) claimRotTarget({ x: e.clientX, y: e.clientY })
  }
  // create a resource chip — linked to a tracked Trupp when one is picked, else a generic team
  const placeTeamChip = (x: number, y: number, floor: number, trupp?: Trupp) => {
    const teams = annos.filter((a) => a.kind === 'resource').length
    const id = newId('r')
    // generic chips are numbered from the ONE counter of the Einsatz — every surface's chips
    // and every registered Trupp — so a second «Trupp 1» cannot appear anywhere (placedTeamNames)
    const name = trupp ? trupp.name : nextTeamName([
      ...annos.filter((a) => a.kind === 'resource').map((a) => a.text),
      ...(placedTeamNames?.() ?? []),
    ], trupps)
    const color = TEAM_COLORS[teams % TEAM_COLORS.length]
    add({ id, kind: 'resource', x, y, floor, text: name, t: formatTime(new Date()), color, trail: [], truppId: trupp?.id })
    if (trupp) onLinkTrupp?.(id, trupp.id)
    // the row already states a place («auf Plan gesetzt»); on a floor stack that place is a
    // storey, so it is named (18.09.2026 — same rule as useTruppActions · placeTruppOnPlan)
    setSelId(id); log('flag', fillTemplate(appConfig.copy.whiteboard.placeTeam, { name }) + (stack ? ` · ${floorLabel(floor)}` : ''), { annoId: id, x, y, floor })
  }
  // deferred placement for the node tools: run on a genuine tap (pointer-up without a pan). Mirrors
  // the bodies the Lage map runs on click — Maßstab nodes, node-draw vertices, Text, Symbol,
  // Trupp. Freehand is the exception (it draws on the drag itself), so it never routes through here.
  const placeNode = (e: React.PointerEvent) => {
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    let floor = stack ? floorAt(n[1]) : 0
    let x = n[0], y = localY(n[1], floor)
    // a two-point shape's tap lands ON the symbol whose ring closed under it, not beside it
    if (rotPlacing) {
      const claimed = rotMagnetRef.current?.armed ? rotMagnetRef.current : null
      clearRotMagnet()
      if (claimed) { x = claimed.x; y = claimed.y; floor = claimed.floor }
    }
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
      // …but calibration is a WRITE (it persists to the workspace and the station default), so a
      // locked surface just can't measure until someone with edit rights has set the scale — the
      // panel says exactly that instead of offering a button that would fail.
      if (!calibrated) {
        if (readOnly) return
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
      const id = newId('t')
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
      // Straight into typing — in the detail sheet, with the caret already in its text field
      // (05.09., in lockstep with the Karte: IncidentWorkspace's note placement). The on-canvas
      // inline editor is still the desktop double-tap.
      setSelId(id); setNotePanelId(id); setNotePlacedId(id); setTool('pan'); log('type', appConfig.copy.whiteboard.placeText, { annoId: id, x, y, floor })
      return
    }
    if (tool === 'symbol') {
      if (!pending) { setPaletteOpen(true); return }
      const id = newId('s'); const s = pending
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
      const id = newId('sh'); const k = pendingShape
      const def = SHAPE_DEFS[k]
      const name = appConfig.copy.shapes.names[k] ?? appConfig.copy.shapes.kindLabel
      // same defaults + naming as the Lage placement path; size is normalized to the plan width
      let geom: Pick<BoardAnno, 'x' | 'y' | 'floor' | 'rotation' | 'sizeN' | 'aspect'> =
        { x, y, floor, sizeN: def.defaultSizeN, rotation: 0 }
      // ── A Rotation is laid between two PLACES (lib/shapes · SHAPE_TWO_POINT) ──────────────
      // The twin of the Lage map's two taps, in plan space: first the Wasserbezug, then the
      // Brandstelle. A second tap on the SAME spot lays down the default run instead, so nobody
      // is ever left holding half a gesture with no way to finish it.
      if (SHAPE_TWO_POINT[k]) {
        if (!rotStart) { setRotStart([x, y, floor]); return }
        // ⚠️ y is normalized against the board HEIGHT and sizeN against its WIDTH, so the two
        // axes are only comparable once y is scaled by the board's own proportions
        const f0 = rotStart[2] ?? floor
        const gy0 = mapY(f0, rotStart[1]), gy1 = mapY(floor, y)
        const dx = x - rotStart[0], dy = (gy1 - gy0) * (sH / sW)
        const span = Math.hypot(dx, dy)
        const apart = span >= SHAPE_MIN_N
        const box = rotationBox(apart ? span : rotN.runN, rotN.w)
        geom = {
          x: apart ? (x + rotStart[0]) / 2 : rotStart[0],
          // the midpoint is halved in BOARD space and re-localised into the first tap's storey —
          // averaging two storey-local y's from different storeys puts the loop nowhere
          y: apart ? localY((gy0 + gy1) / 2, f0) : rotStart[1],
          floor: f0,
          rotation: apart ? Math.round((((Math.atan2(dy, dx) * 180) / Math.PI % 360) + 360) % 360) : 0,
          sizeN: box.size,
          aspect: Math.round(box.aspect * 1000) / 1000,
        }
        setRotStart(null)
      }
      add({ id, kind: 'shape', shape: k, color: def.defaultColor, label: name, ...geom })
      log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name }), { annoId: id, x: geom.x, y: geom.y, floor: geom.floor })
      // unlocked: place once → pan with the shape selected (its two ends usable); locked: keep placing
      if (placeLock && !SHAPE_TWO_POINT[k]) setSelId(null)
      else { setPendingShape(null); setTool('pan'); setSelId(id) }
      return
    }
    if (tool === 'resource') {
      // if any Trupps are being tracked, ask WHICH one this chip is (listing the names);
      // otherwise drop a generic Team N. Placed trupps are listed too so the names always appear
      // once a Trupp is tracked — and so are the ones that are OUT (05.09.), which is the same
      // list the picker itself renders.
      if (trupps.length) { setTruppPick({ x, y, floor }); setTool('pan') }
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
      // a two-point shape's press keeps its claim under the travelling finger
      if (rotPlacing) {
        const wasPaused = rotPanPaused.current
        claimRotTarget({ x: e.clientX, y: e.clientY })
        // while the ring fills the board must not pan (rotPanPaused): the wobble budget is the
        // magnet radius, not the tap threshold below. Leaving the ring hands the pan back —
        // re-anchored to where the finger rests now, so the board doesn't jump by the wobble.
        if (rotPanPaused.current) return
        if (wasPaused) {
          const st = inkTap.current
          // …and if the finger has already travelled past the tap threshold by the time it left
          // the ring, this was a drag all along: the tap dies here, as it does on the Karte,
          // where MapLibre's own click tolerance is long gone by that distance.
          if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > DRAG_DEADZONE_PX) st.moved = true
          st.x = e.clientX; st.y = e.clientY; st.px = posRef.current.x; st.py = posRef.current.y
        }
      }
      if (tool === 'line') {
        const n = toNorm(e.clientX, e.clientY)
        if (n) { const floor = stack ? floorAt(n[1]) : draftFloor.current; updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], 'move') }
      }
      // node tool: drag pans the board (and disqualifies the tap). 8px of slop tolerates finger
      // jitter so a still tap still places. Pan from the recorded origin, like useBoardGestures.
      const st = inkTap.current, dx = e.clientX - st.x, dy = e.clientY - st.y
      if (!st.moved && Math.hypot(dx, dy) > 8) st.moved = true
      if (st.moved) applyView(scaleRef.current, { x: st.px + dx, y: st.py + dy })
      return
    }
    if (circleDraft) {
      // the board rect IS the plan's px box (toNorm works in the same space), so the radius is
      // the pointer's distance from the centre as a fraction of the sheet's width
      const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
      const cx = rect.left + circleDraft.x * rect.width, cy = rect.top + mapY(circleDraft.floor, circleDraft.y) * rect.height
      setCircleDraft({ ...circleDraft, r: Math.hypot(e.clientX - cx, e.clientY - cy) / rect.width })
      return
    }
    if (!inking || !draft) return
    const n = toNorm(e.clientX, e.clientY); if (n) {
      const floor = stack ? floorAt(n[1]) : draftFloor.current
      if (tool === 'line') updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], 'move')
      setDraft((d) => (d ? [...d, [n[0], localY(n[1], floor), floor]] : [[n[0], localY(n[1], floor), floor]]))
    }
  }
  const inkUp = (e?: React.PointerEvent) => {
    if (e) inkPtrs.current.delete(e.pointerId)
    // the claim survives just long enough for placeNode to consume it, and no longer
    if (rotPlacing && (!e || e.type !== 'pointerup' || inkTap.current?.moved)) clearRotMagnet()
    if (inkPtrs.current.size < 2) inkPinch.current = null
    if (inkTap.current) {
      const st = inkTap.current; inkTap.current = null
      rotPanPaused.current = false // the press is over — whatever happens next pans normally
      // a clean pointer-up that never panned is a tap → drop the node; a drag (moved) or a
      // pointer-cancel just leaves the panned view as-is, with no stray node placed.
      if (e && e.type === 'pointerup' && !st.moved) placeNode(e)
      finishPlanDraftMagnet()
      return
    }
    if (circleDraft) {
      const c = circleDraft; setCircleDraft(null)
      // a real drag keeps its dragged radius; a tap (below the minimum) drops the default-size
      // cordon, so the tool never does «nothing» — the radius is editable either way
      if (e && e.type === 'pointerup') {
        addCircle(c.x, c.y, c.floor, c.r >= appConfig.drawing.circleMinRadiusN ? c.r : appConfig.drawing.circleInitialRadiusN)
      }
      return
    }
    // A dragged Fläche: the same thinned stroke as a freehand Linie, closed into a ring. No
    // magnet and no attachments — those belong to a Leitung's ends, and an area has none.
    if (tool === 'area' && areaMode === 'freehand' && draft) {
      const px = draft.map(([x, y, floor]): [number, number] => [x * sW, mapY(floor ?? draftFloor.current, y) * sH])
      if (!isTapStroke(px)) {
        const idx = rdpIndices(px, FREEHAND_SIMPLIFY_PX)
        if (idx.length >= minPoints('area')) addArea(idx.map((i) => draft[i]))
      }
      setDraft(null)
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
    const id = newId('l')
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'draw', pts, floor, color, width, ...draftAttachments.current,
      dashed: dashed || undefined, ...(marker ? { marker } : {}), ...(lineArrow ? { arrow: true } : {}) }
    add(anno)
    // a stroke that ENDED on a Trupp's chip is that Trupp's Leitung — both ends are reported,
    // because either of them may be the coupling (see Props · onLineAttached)
    for (const a of [anno.startAttachment, anno.endAttachment]) if (a) onLineAttached?.(id, a)
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
    const id = newId('a')
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'area', pts, floor, color, width, dashed }
    add(anno)
    log('area', appConfig.copy.whiteboard.placeArea, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
    return anno
  }
  const addArea = (pts: BoardPoint[]) => { const { id } = commitArea(pts); setSelId(id); setTool('pan') }
  // Absperrkreis / Gefahrenradius — the plan twin of the Karte's createCircle (lib/useMapDrawing):
  // the same hazard colour, dashed slim ring and default fill, undoable + journaled + audited
  // through the same `add`. Drops to pan with the circle selected so its radius stepper is right
  // there, exactly as the map's does.
  const addCircle = (x: number, y: number, floor: number, radiusN: number) => {
    const id = newId('c')
    add({ id, kind: 'circle', x, y, floor, radiusN, color: appConfig.drawing.circleColor,
      dashed: true, width: appConfig.drawing.circleLineWidth, fillOpacity: appConfig.drawing.circleFillOpacity })
    log('circle', appConfig.copy.whiteboard.placeCircle, { annoId: id, x, y, floor })
    setSelId(id); setTool('pan')
  }
  // commit the in-progress node shape: a Linie (≥2 pts) or a Fläche (≥3 pts, closed + filled).
  // Then drop to pan so it's immediately selectable.
  const finishShape = () => {
    const d = draft
    if (tool === 'line' && d && d.length >= minPoints('draw')) {
      setDraft(null); lastTap.current = null
      addLine(d)
      return
    }
    if (tool === 'area' && d && d.length >= minPoints('area')) {
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
    if (d.length < minPoints(kind)) {
      draftAttachments.current = {}
      toast(appConfig.copy.toolDock.draftDiscarded)
      return
    }
    const att = { ...draftAttachments.current } // commitLine consumes the ref — kept for the undo
    const planId = activeId
    const anno = kind === 'line' ? commitLine(d) : commitArea(d)
    // the take-back deletes this ONE anno — spent once another device's merge changed it
    // (lib/undoKeys · watchRecords), so it can never delete their edit
    const watch = watchRecords([recordKey('objects', anno.id)])
    toast(fillTemplate(appConfig.copy.toolDock.autoCommitted, { name: kind === 'line' ? appConfig.copy.drawingEditor.line : appConfig.copy.drawingEditor.area }), {
      onDismiss: watch.release,
      action: {
        label: appConfig.copy.toolDock.autoCommitUndo,
        onClick: () => {
          watch.release()
          if (!watch.ok()) { toast(appConfig.copy.undoLost, { icon: 'warn' }); return }
          if (activeIdRef.current === planId) {
            // still on this sheet: take the anno back and put the shape in the hand again
            const step = newPlanStep()
            setHist((m) => pushBoardPast(m, planId, annosRef.current, step)); onCheckpoint?.(planId, step)
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
            const step = newPlanStep()
            setHist((m) => pushBoardPast(m, planId, [...annos, anno], step)); onCheckpoint?.(planId, step)
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
    // …and a half-dragged cordon goes with the tool: its overlay unmounts with it, so nothing
    // would ever end the gesture and the preview ring would hang on the sheet
    if (from !== tool) setCircleDraft(null)
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
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for a stroke
    // too big for its bounds to mean anything (lib/panelNudge · panelNudgeSelection). Client px,
    // the same space the nudge's box is built in.
    setAnnoTap({ id, x: e.clientX, y: e.clientY })
    setSelId(id); setSelIds([])
    const a = annos.find((x) => x.id === id); if (!a || (a.kind !== 'draw' && a.kind !== 'area')) return
    // snapshot the vertices in board-space (y mapped to the stacked board), so the delta is always
    // applied to the original geometry — no drift across re-renders (mirrors the group-move math)
    drawDrag.current = { id, floor: a.floor ?? 0, sx: e.clientX, sy: e.clientY, bpts: boardPts(a.pts ?? [], a.floor ?? 0), moved: false }
  }
  const drawMove = (e: React.PointerEvent) => {
    const st = drawDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    // tap-vs-drag threshold: a finger never lands perfectly still, so without this a plain TAP on
    // a selected area/line nudged it (and stamped an undo step). Inside DRAG_DEADZONE_PX it's a
    // tap → no move, so tapping just keeps the selection (and tapping empty space still
    // deselects via the stage). Same deadzone as every other drag on both surfaces.
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_DEADZONE_PX) return
      pushPast(); st.moved = true // one checkpoint per drag
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    const a = annos.find((x) => x.id === st.id)
    // ⚠️ ONE body: the stroke keeps its shape at a tile's edge (floorGeometry · moveRigid) — the
    // per-vertex clamp flattened a Leitung onto the tile's rim in the field (23.09.2026)
    const pts = moveRigid(st.bpts, st.floor, (x, by) => [x + ndx, by + ndy], (i) => (
      (i === 0 && a?.startAttachment) || (i === st.bpts.length - 1 && a?.endAttachment)
        ? a?.pts?.[i] ?? [st.bpts[i][0], localY(st.bpts[i][1], st.bpts[i][2] ?? st.floor), st.bpts[i][2] ?? st.floor]
        : null))
    st.last = pts
    patch(st.id, { pts })
  }
  const drawUp = () => {
    const st = drawDrag.current; drawDrag.current = null
    if (!st?.moved) return
    // ⚠️ …WITH the points. A stroke's position IS its points, and this was the one board.move that
    // named none — an unfoldable payload, so the replay left the line where the last snapshot had
    // it while every other plan drag now moves (lib/replay · board.move).
    emit('board.move', { id: st.id, pts: st.last ?? annos.find((x) => x.id === st.id)?.pts, planId: activeId })
  }

  // --- single Absperrkreis select + move (tap its ring/fill in WbCircleLayer, pan mode) ---
  // ⚠️ A DELTA on the centre, not the chip drag's jump-to-the-finger (chipMove): a cordon is
  // grabbed anywhere on its face, and moving the centre to the grab point would shift the ring
  // out from under the hand. Same grammar as the stroke body-drag above — deadzone, one
  // checkpoint per drag, one board.move on release.
  const circleDrag = useRef<{ id: string; sx: number; sy: number; x0: number; by0: number; floor: number; moved: boolean } | null>(null)
  const circleDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan' || readOnly) return
    const a = annos.find((x) => x.id === id)
    if (!a || a.locked) return // locked ink is click-through; the LockChip is its only door
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    setAnnoTap({ id, x: e.clientX, y: e.clientY })
    setSelId(id); setSelIds([])
    circleDrag.current = { id, sx: e.clientX, sy: e.clientY, x0: a.x ?? 0, by0: mapY(a.floor, a.y ?? 0), floor: a.floor ?? 0, moved: false }
  }
  const circleMove = (e: React.PointerEvent) => {
    const st = circleDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_DEADZONE_PX) return
      pushPast(); st.moved = true // one checkpoint per drag
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    // the storey stays put (a cordon belongs to the sheet it was drawn on): board-global y is
    // re-localised back into that same tile, exactly as the stroke drag does
    patch(st.id, { x: st.x0 + ndx, y: localY(st.by0 + ndy, st.floor) })
  }
  const circleUp = () => {
    const st = circleDrag.current; circleDrag.current = null
    if (!st?.moved) return
    const a = annos.find((x) => x.id === st.id)
    emit('board.move', { id: st.id, x: a?.x, y: a?.y, floor: a?.floor, planId: activeId })
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
    if (!st?.moved) return
    // …with the offsets it dragged: a `board.edit` naming no patch folds to nothing (lib/replay),
    // so the nudged label snapped back on every scrub between snapshots.
    const a = annos.find((x) => x.id === st.id)
    emit('board.edit', { id: st.id, planId: activeId,
      patch: st.which === 'end' ? { endDx: a?.endDx, endDy: a?.endDy } : { labelDx: a?.labelDx, labelDy: a?.labelDy } })
  }

  // --- vertex editing of a selected line/area and of the in-progress node draft (drag a node,
  // insert on a segment, delete a node, grow an end, take the stairs) — components/useWbVertexEdit.
  // ⚠️ Called HERE, where the handlers used to be defined: everything it reads is declared above,
  // except centerOnPoint (further down), which is handed over as a lazy wrapper.
  const {
    vertDrag, draftVert, vertDown, vertMove, vertUp, climbLine, extendLine, insertVertex, deleteVertex,
    draftVertDown, draftVertMove, draftVertUp, draftInsert, draftDeleteVertex,
  } = useWbVertexEdit({
    annos, selId, tool, readOnly, stack, toNorm, localY, floorAt, mapY, sW, sH,
    resolvedPts, attachmentLines, planCandidatesAt, pushPast, patch, patchCommit, emit, activeId,
    onLineAttached, onLineDetached, planEndpointDrag, setPlanEndpointDrag, planDwellTimerRef: planDwellTimer,
    allFloorsTTB, revealFloor, centerOnPoint: (x, y, floor, atScale) => centerOnPoint(x, y, floor, atScale), scaleRef,
    draftFloor, setDraft,
  })

  // --- chip dragging (resource / symbol / text in pan mode) — components/useWbChipDrag ---
  const { chipDrag, chipDown, chipMove, chipUp } = useWbChipDrag({
    tool, readOnly, annos, editId, setSelId, setSelIds, setNotePanelId, toNorm, stack, floorAt, localY, mapY, sW, sH,
    attachmentLines, pushPast, set, patch, emit, activeId, onLinkLineTrupp,
  })

  // object-manipulation hand-off for the stage dispatcher in useBoardGestures: when no
  // pan/pinch/marquee gesture owns the pointer, route move/up to the active chip/draw/vertex
  // drag (each no-ops if its ref is null — same fall-through the inline dispatcher had).
  const manipMove = (e: React.PointerEvent) => {
    if (chipDrag.current) chipMove(e)
    else if (circleDrag.current) circleMove(e)
    else if (drawDrag.current) drawMove(e)
    else if (vertDrag.current) vertMove(e)
    else if (draftVert.current) draftVertMove(e)
    else if (measDragging()) measMove(e)
    // once an object is really travelling (past the shared deadzone), the phone detail sheet
    // peeks down to its grip line so the board isn't reduced to a strip — lib/sheetPeek
    if (chipDrag.current?.moved || circleDrag.current?.moved || drawDrag.current?.moved || vertDrag.current?.moved) beginSheetPeek()
  }
  const manipUp = () => { endSheetPeek(); chipUp(); circleUp(); drawUp(); vertUp(); draftVertUp(); measUp(); onStepEnd?.() }

  // pan / pinch-zoom / marquee multi-select + the shared stage pointer dispatcher live in
  // useBoardGestures; object manipulation is reached through manipMove/manipUp above.
  const { marquee, stageDown, stageMove, stageUp, trackDown, trackUp } = useBoardGestures({
    tool, annos, setSelId, setSelIds, setTool, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp,
  })

  // --- drag-to-rotate / resize / the Rotation's ends and its claim ring — components/useWbRotor ---
  const { rotMagnet, rotMagnetRef, rotPanPaused, clearRotMagnet, claimRotTarget, rotDown, rotMove, rotUp } = useWbRotor({
    tool, readOnly, annos, boardRef, inkTap, toNorm, localY, mapY, sW, rotN, pushPast, patch, emit, activeId, onStepEnd,
  })

  // the ONLY way a position is recorded: stamp the current spot + time into the trail
  const markPosition = () => {
    const a = annos.find((x) => x.id === selId)
    if (!a || a.kind !== 'resource') return
    const now = formatTime(new Date())
    patchCommit(a.id, { t: now, trail: [...(a.trail ?? []), { x: a.x ?? 0, y: a.y ?? 0, floor: a.floor ?? 0, t: now }] })
    // «Position markieren» names a PLACE, so on a stack it names the storey too — a row that
    // says only «Trupp 3: Position markiert» cannot be read back as a position at all
    const where = stack ? ` · ${floorLabel(a.floor ?? 0)}` : ''
    log('flag', fillTemplate(appConfig.copy.whiteboard.positionMarked, { name: a.text ?? '' }) + where, { kind: 'team', annoId: a.id, x: a.x, y: a.y, floor: a.floor ?? 0 })
    // no toast (20.09.2026): the dot lands under the finger and the Verlauf has the row
  }
  const clearTrail = async () => {
    const a = annos.find((x) => x.id === selId)
    if (!a || a.kind !== 'resource' || !a.trail?.length) return
    // confirm first — one mis-tap must not silently wipe the recorded Truppverfolgung (Lage parity)
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.clearTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: a.text ?? '', n: a.trail.length }),
      confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    patchCommit(a.id, { trail: [] })
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: a.text ?? '' }))
  }
  // ⚠️ No recolouring of a team chip any more (04.09.): a colour is changed on the Karte's
  // marker or not at all, so there is nothing here to write and nothing to carry to the card.

  // ⚠️ A trail no longer LOCKS its chip (18.09.2026). The record is protected by outliving the
  // marker instead: a removed chip's recorded positions move into a ghost trail the incident
  // owns (lib/truppTrails · reconcileGhostTrails, driven from IncidentWorkspace), so the trash
  // always does the one thing it says and the searched area is still on the sheet afterwards.
  /**
   * «Entfernen» on the plan writes the Karte's removal row (review item 21b, 24.09.2026) —
   * «{name} gelöscht» (`log.objectDeleted`), named the way the Karte names the same object
   * (lib/drawingEdit · annoLogName) and carrying it as its SUBJECT, never as a jump target: the
   * object is gone. It used to write nothing for a single object, so a Feuer deleted on the EG
   * left no trace in the Verlauf at all. ONE act, ONE row: the store fold writes none, and a
   * group of several keeps its «n Objekte vom Plan gelöscht». An empty Notiz writes none, as on
   * the Karte.
   */
  const logRemoved = (a: BoardAnno) => {
    const name = annoLogName(a)
    if (name == null) return
    log('close', fillTemplate(appConfig.copy.log.objectDeleted, { name }), { subjectId: a.id })
  }

  /**
   * «Gelöscht / erledigt» on the plan (lib/objectDone) — the same prop edit the Karte makes
   * (IncidentWorkspace · setEntityDone): one checkpoint on this plan's history, the `board.edit`
   * audit event (`done: null` for «Wieder aktiv», which JSON would otherwise drop), the write-
   * through onto the map body through the store fold, and ONE Verlauf row, with the storey the
   * symbol stands on — on the Gebäude that is its tile (or its Von/Bis span).
   */
  const setAnnoDone = (a: BoardAnno, on: boolean) => {
    if (readOnly) return
    const from = stack ? a.floorFrom ?? a.floor ?? 0 : a.floorFrom ?? a.storey
    const act = doneAct(a, on, {
      atIso: serverNowIso(), by: authorName,
      place: donePlace(from, stack ? a.floorTo ?? from : a.floorTo),
      // this sheet's view — a projected Karte symbol has no anno in the recorded board, and the
      // event folds to nothing there, while its `entity.edit` greys the map view (lib/objectDone)
      sheetPlanId: activeId,
    })
    if (!act) return
    onStepLabel?.(act.text) // the ↶ says «Feuer EG gelöscht», the Karte's way, not «Plan …»
    commit(annos.map((x) => (x.id === a.id ? { ...x, done: act.done } : x)))
    for (const [op, payload] of act.events) emit(op, payload)
    log(on ? 'check' : 'undo', act.text, { annoId: a.id, x: a.x, y: a.y, floor: a.floor })
  }

  // returns whether the object actually went — «Marker und Spur löschen» has to take its arming
  // back when the connection question (or the note question) was answered with «Abbrechen»
  const removeWithConnections = async (target: BoardAnno): Promise<boolean> => {
    const affected = annos.flatMap((a) => (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && ((rel.target.kind === 'object' && rel.target.id === target.id) || (rel.target.kind === 'line' && rel.target.id === target.id)) ? [{ a, endpoint, rel }] : []
    }))
    if (!affected.length) {
      const gone = await removeAnno(target)
      if (gone) logRemoved(target)
      return gone
    }
    const ok = await confirmDialog({
      title: fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: target.label ?? target.text ?? appConfig.copy.drawingEditor.drawing }),
      message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }),
      confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return false
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
    logRemoved(target)
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
    return true
  }

  /**
   * «Marker und Spur löschen» — the third row of the chip's trash menu (components/TwinTeamPill).
   * Both go, and unlike a plain removal NOTHING is left behind: the incident is armed first
   * (`onTrailDrop`), so the reconciliation writes this chip's ghost already `removedAt`-stamped
   * instead of standing the searched area back up (lib/truppTrails). It stays ONE undo step —
   * the chip's own removal — because nothing but that removal was ever committed.
   */
  const removeWithTrail = async (a: BoardAnno) => {
    if (a.kind !== 'resource' || !a.trail?.length) return
    // a trail is never destroyed without the ask, wherever the door is (Karte parity)
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.removeMarkerTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: a.text ?? '', n: a.trail.length }),
      confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    onTrailDrop?.(a.id, true)
    if (!await removeWithConnections(a)) { onTrailDrop?.(a.id, false); return }
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: a.text ?? '' }))
  }

  // group delete — removes the whole selection; a trail-carrying team goes with it and leaves
  // its ghost trail behind (see removeWithConnections).
  const deleteGroup = async () => {
    if (readOnly) return
    const removable = selIds.filter((id) => annos.some((x) => x.id === id))
    if (!removable.length) return
    const affected = annos.flatMap((a) => removable.includes(a.id) ? [] : (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && removable.includes(rel.target.id) ? [{ a, endpoint, rel }] : []
    }))
    if (affected.length) {
      const ok = await confirmDialog({ title: appConfig.copy.whiteboard.groupDeleteTitle, message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }), confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true })
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
    const lone = removable.length === 1 ? annos.find((a) => a.id === removable[0]) : undefined
    if (lone) { logRemoved(lone); return }
    log('close', removable.length > 1
      ? fillTemplate(appConfig.copy.whiteboard.groupDeletedN, { n: removable.length })
      : appConfig.copy.whiteboard.groupDeleted)
  }

  const planWorkRect = (canvas: DOMRect, panelEl?: Element | null): NudgeBox => {
    // The default fitted view already reserves these permanent lanes; use the same geometry for
    // focus so “centre” never means underneath a rail or the floating top bar.
    const surface = {
      minX: canvas.left + side.l, maxX: canvas.right - side.r,
      minY: canvas.top + TOP_INSET, maxY: canvas.bottom - botRes,
    }
    if (!panelEl) return visibleWorkRect(surface, null, false)
    const panel = panelEl.getBoundingClientRect()
    if (!panel.width) return visibleWorkRect(surface, null, false)
    const obstruction = { minX: panel.left, maxX: panel.right, minY: panel.top, maxY: panel.bottom }
    return visibleWorkRect(surface, obstruction, isBottomSheet(panel.width, canvas.width))
  }

  // pan (no zoom change) so a normalized plan point lands at the centre of the unobscured work area
  /**
   * Move a whole Leitung to another Geschoss — the «Geschoss» stepper in its detail sheet.
   *
   * ⚠️ It used to patch `anno.floor` alone, and on the stack that changes NOTHING: every vertex
   * of a line drawn here carries its own storey (`pts[i][2]`, stamped at draw time) and the
   * renderer reads the point before the anno. The stepper stepped, the sheet said the new storey,
   * and the hose stayed where it was (Bastian, 17.09.2026).
   *
   * Every vertex moves by the SAME step, so a Leitung that climbs keeps its climb. A step that
   * would take any vertex off the building is refused; a storey the building does not have is
   * resolved to the next one it does (a pack with EG and +2 steps straight from one to the
   * other), and a folded-away target is unfolded, because a hose that moved somewhere invisible
   * has simply gone missing.
   */
  const moveLineToStorey = (id: string, to: number | undefined) => {
    if (to == null || readOnly) return
    const a = annos.find((x) => x.id === id)
    if (!a?.pts?.length) return
    const from = a.pts[0][2] ?? a.floor ?? 0
    const target = storeyTowards(allFloorsTTB, from, to)
    if (target == null) return
    const delta = target - from
    const moved = a.pts.map(([x, y, f]): BoardPoint => [x, y, (f ?? a.floor ?? 0) + delta])
    if (moved.some((p) => !allFloorsTTB.includes(p[2] as number))) return
    revealFloor(target)
    patchCommit(id, { floor: from + delta, pts: moved })
  }

  const centerOnPoint = (x: number, y: number, floor: number, atScale?: number) => {
    const s = atScale ?? scaleRef.current, w = fit.w * s, h = fit.h * s
    const canvas = canvasRef.current?.getBoundingClientRect()
    if (!w || !h || !canvas) return
    const my = mapY(floor, y)
    const target = rectCenter(planWorkRect(canvas, document.querySelector('.ctx')))
    const baseX = canvas.left + canvas.width / 2 + (side.l - side.r) / 2
    const baseY = canvas.top + canvas.height / 2 + vShift
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
    // ⚠️ No twin branch any more: a Karte object shown on this sheet IS an anno with the same
    // id, so «zeigen» finds it through `focus.annoId` like anything else the sheet draws.
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
  /**
   * ⚠️ The Plan has no Ebenen of its own any more (15.09.2026). It used to share the slot with
   * the selected object's details — the layer list said which projection that object belonged to
   * — but the unified object model took the plan's twin rows away (`planRasterRows` is the
   * Karte's alone), and the panel has been an empty room ever since: the rail's button opened
   * nothing at all, and on a phone it hid the detail panel to do it. Either a section lists
   * something or it is not in the sidebar — so the button is gone, and the detail slot is the
   * plan's whole business. `tool === 'pan'` remains the long-standing selection-only gate.
   */
  const editorSlotFree = tool === 'pan'
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
  // the «just placed» mark lives exactly as long as that panel does
  useEffect(() => { if (notePlacedId && notePanelId !== notePlacedId) setNotePlacedId(null) }, [notePanelId, notePlacedId])
  // a selected stroke / Linie / Fläche — drives the shared DrawEditor (style + presets) panel
  // ⚠️ 'circle' rides along: an Absperrkreis is styled, locked, measured and deleted through the
  // same DrawEditor as a Linie/Fläche (the Karte does exactly this — MapView · editDraw). It is
  // the one member with no `pts`, so every geometry path below asks for them before using them.
  const selDraw = annos.find((a) => a.id === selId && (a.kind === 'draw' || a.kind === 'area' || a.kind === 'circle'))
  /** The selected Absperrkreis's radius in REAL metres — only once the sheet is calibrated
   *  against its printed Maßstab (lib/planScale · circleRadiusM). Undefined on an uncalibrated
   *  Kroki, which is what keeps the editor's metre stepper and its subtitle away (DrawEditor). */
  const selCircleM = selDraw?.kind === 'circle' && calibrated && activeScale
    ? circleRadiusM(selDraw.radiusN ?? 0, activeScale.mPerU, measureAR)
    : undefined
  /** The selected line/Fläche AS AN EDIT TARGET — null whenever the surface may not be written.
   *  Read-only never gets handles, the same rule the Karte states at MapView · editDraw: grips
   *  that look grabbable but move under the finger and snap back are the worst kind of 3am lie.
   *  ⚠️ `readOnly` here is BROADER than the onChange guard upstream (tacticalLocked alone), so on
   *  a phone with the Verlauf open these handles did not merely lie — they wrote. */
  const editDraw = readOnly ? undefined : selDraw
  // Explicit detach for a plan line endpoint (the × chip on the canvas + the Verbindung lösen button
  // in the editor both call this) — materialize the endpoint at its resolved point, drop the link.
  const detachPlanEndpoint = (endpoint: LineEndpoint) => {
    if (readOnly || !selDraw?.pts?.length) return
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
    onLineDetached?.(selDraw.id, a)
  }
  // a selected generic shape — colour via the same ShapeEditor sheet as the Lage map
  const selShape = annos.find((a) => a.id === selId && a.kind === 'shape')

  // --- the selection bar's transform target (components/SelectionBar) ------------------------
  // ONE writer for every selection this surface has: a Mehrfach group, a single Linie/Fläche/
  // Absperrkreis, a single Form. The bar hands over a client-px delta or a turn in degrees; what
  // happens to each member depends only on whether it is ink (pts) or a point anno (x/y), never
  // on how many are selected. That is what retired the plan's group pill and the map's hub in
  // the same move.
  const barIds: string[] = selIds.length > 1 ? selIds
    : editDraw ? [editDraw.id]
    : selShape && !readOnly ? [selShape.id]
    : []
  const barActive = barIds.length > 0
    && (selIds.length > 1 ? tool === 'pan' || tool === 'lasso' : tool === 'pan')
    && !readOnly && !georefArmed
  /** The selection's centre in board-normalized space — the shared resolver (lib/selectionTransform),
   *  and the reason a line, a Fläche and an Absperrkreis have one at all: rotDown reads the
   *  `.wb-anno` chip's bounding box, and ink has no chip. */
  const barCentre = (() => {
    if (!barActive) return null
    const c = centroid([
      ...annos.flatMap((a): [number, number][] => {
        if (!barIds.includes(a.id)) return []
        // ink is its points; everything else (chip, Form, Absperrkreis, Notiz) is its anchor
        if (a.pts?.length) return a.pts.map(([x, y, floor]) => [x, mapY(floor ?? a.floor, y)])
        return [[a.x ?? 0, mapY(a.floor, a.y ?? 0)]]
      }),
    ])
    return c ? { x: c[0], y: c[1] } : null
  })()
  /** snapshot every member's ORIGINAL board-space geometry, so each frame's delta is applied to
   *  the start position and never compounds across re-renders */
  const barSnapshot = () => {
    pushPast() // one checkpoint for the whole gesture
    groupOrig.current = annos.filter((a) => barIds.includes(a.id)).map((a) =>
      a.pts
        ? { id: a.id, floor: a.floor ?? 0, rot: a.rotation, rot2: a.rotation2, bpts: boardPts(a.pts, a.floor ?? 0) }
        : { id: a.id, floor: a.floor ?? 0, rot: a.rotation, rot2: a.rotation2, bx: a.x ?? 0, by: mapY(a.floor, a.y ?? 0) },
    )
  }
  /** write one frame of the gesture: `t` moves in board fractions, `deg` turns about `barCentre`.
   *  Members stay on their own storey (floor unchanged) and an ATTACHED line end stays pinned to
   *  its target — the same two rules the single-object body drag already follows. Returns what
   *  it wrote, so the release reports the frame it actually ended on. */
  const barApply = (t: { ndx: number; ndy: number; deg: number }, centre: { x: number; y: number } | null): BoardAnno[] => {
    // x and y are fractions of DIFFERENT edges, so a turn has to happen in px proportions
    const xScale = (sW || 1) / (sH || 1)
    const turn = (x: number, by: number): [number, number] => (t.deg && centre
      ? rotateAround([x, by], [centre.x, centre.y], t.deg, { xScale })
      : [x, by])
    const next = annos.map((a) => {
      const o = groupOrig.current.find((g) => g.id === a.id); if (!o) return a
      const turned = t.deg
        ? { ...(o.rot !== undefined ? { rotation: turnedBy(o.rot, t.deg) } : null), ...(o.rot2 !== undefined ? { rotation2: turnedBy(o.rot2, t.deg) } : null) }
        : null
      // ⚠️ each stroke is ONE body, turned and moved whole and kept whole at its tile's edge
      // (floorGeometry · moveRigid) — the same writer as the stroke body drag above
      const bpts = o.bpts
      if (bpts) return { ...a, ...turned, pts: moveRigid(bpts, o.floor, (x, by) => { const [rx, ry] = turn(x, by); return [rx + t.ndx, ry + t.ndy] }, (i) => (
        (i === 0 && a.startAttachment) || (i === bpts.length - 1 && a.endAttachment)
          ? a.pts?.[i] ?? [bpts[i][0], localY(bpts[i][1], bpts[i][2] ?? o.floor), bpts[i][2] ?? o.floor]
          : null)) }
      const [rx, ry] = turn(o.bx ?? 0, o.by ?? 0)
      return { ...a, ...turned, x: rx + t.ndx, y: localY(ry + t.ndy, o.floor) }
    })
    set(next)
    return next
  }
  /** One `board.move` per member, carrying its POSITION — `pts` for ink, whose position IS its
   *  points (the same payload `drawUp` sends). ⚠️ It sent x/y/floor for everything, which a stroke
   *  does not have: the event named no position at all and the replay folded nothing (prod
   *  23.09.2026 19:00:55). Read off the frame the gesture ended on, not off the last render. */
  const barCommit = (written: BoardAnno[]) => written.filter((a) => barIds.includes(a.id))
    .forEach((a) => emit('board.move', a.pts
      ? { id: a.id, pts: a.pts, planId: activeId }
      : { id: a.id, x: a.x, y: a.y, floor: a.floor, planId: activeId }))
  const barMove = (dx: number, dy: number, phase: 'start' | 'move' | 'end') => {
    if (readOnly) return
    if (phase === 'start') { barSnapshot(); beginSheetPeek(); return }
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    const t = { ndx: dx / rect.width, ndy: dy / rect.height, deg: 0 }
    const written = barApply(t, barCentre)
    if (phase === 'end') { endSheetPeek(); barCommit(written); onStepEnd?.() }
  }
  const barRotate = (deg: number, phase: 'start' | 'move' | 'end') => {
    if (readOnly) return
    // the turn is read on the sheet, beside its pivot (components/SelectionTurn)
    if (phase === 'end') setBarTurn(null)
    else if (phase === 'start') { const c = barCentreClient(); setBarTurn(c ? { cx: c.x, cy: c.y, deg: 0 } : null) }
    else setBarTurn((t) => (t ? { ...t, deg } : t))
    if (phase === 'start') { barRotCentre.current = barCentre; barSnapshot(); return }
    const written = barApply({ ndx: 0, ndy: 0, deg }, barRotCentre.current)
    if (phase === 'end') { barCommit(written); barRotCentre.current = null; onStepEnd?.() }
  }
  /** Remove whatever the bar is pointed at — a Mehrfach group, a single Linie/Fläche/
   *  Absperrkreis, a Form, and the mirrored members of any of those (which delete through their
   *  ONE source object on the Karte).
   *  ⚠️ No longer reachable FROM the bar (02.09.): this is what the Delete key runs, and what an
   *  object's own editor sheet runs. The bar's third slot is «Fertig». */
  const deleteSelection = () => {
    if (readOnly) return
    if (selIds.length > 1) { void deleteGroup(); return }
    const a = annos.find((x) => barIds.includes(x.id))
    if (a) void removeWithConnections(a)
  }
  /** «Fertig» — the editing state ends: nothing selected, no mode armed, every sheet that was
   *  open for this selection closed. The bar carries no Löschen any more: an object is deleted
   *  from its own editor sheet and with the Delete key, which reaches natives and mirrors alike. */
  const barDone = () => {
    setSelId(null); setSelIds([]); setNotePanelId(null); setEditId(null); setAnnoTap(null)
  }
  /** ⟳ is absent, not inert, where the model carries no angle: an Absperrkreis is a centre and a
   *  radius — the native's and the mirror's alike. */
  const barCanRotate = selIds.length > 1 || editDraw?.kind !== 'circle'
  /** ✥ / ⟳ tapped instead of dragged: the same two writers, taken on the sheet itself. Capturing
   *  on `.wb-canvas` is also this surface's pan guard — the press never reaches `stageDown`, so
   *  no pan, no marquee and no placement can start under an armed drag (lib/useArmedTransform). */
  const [barTurn, setBarTurn] = useState<{ cx: number; cy: number; deg: number } | null>(null)
  const barCentreClient = () => {
    const r = boardRef.current?.getBoundingClientRect()
    return r && barCentre ? { x: r.left + barCentre.x * r.width, y: r.top + barCentre.y * r.height } : null
  }
  const arm = useArmedTransform({
    enabled: barActive,
    surface: () => canvasRef.current,
    centreClient: barCentreClient,
    onMove: barMove,
    onRotate: barCanRotate ? barRotate : undefined,
    // a different selection is a different thing to move, and an armed tool is a different
    // answer to the same press: neither carries the mode over
    resetKey: `${tool}|${barIds.join(',')}`,
  })

  /**
   * Delete / Backspace removes the current selection — the Karte's key, now on the Kroki too
   * (A21). It reaches for exactly what the bar's trash reaches for: a Mehrfach group, a single
   * Linie/Fläche/Absperrkreis, a Form, and the mirrored members of any of those (which delete
   * through their one source object). A selected symbol / Notiz / Truppmarker never gets the bar,
   * so it goes the way its own panel deletes it — `removeWithConnections`, which is also what
   * keeps a trail-carrying Trupp protected and asks before an attached line is cut loose.
   *
   * ⚠️ Never while a field owns the press. On a sheet full of Notiz textareas and Trupp names
   * Backspace is a character far more often than it is a delete, and the target — not
   * activeElement — is what still names the field once its own handler has blurred (same reason
   * as the Escape listener above).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (readOnly) return
      if (barIds.length) { e.preventDefault(); deleteSelection(); return }
      const a = annos.find((x) => x.id === selId)
      if (a) { e.preventDefault(); void removeWithConnections(a) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `annos` is a dep so the delete closes over the live document, as on the Karte
  }, [annos, selId, selIds, barIds, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const ok = await confirmDialog({ title: appConfig.copy.drawingEditor.endingTeilstueck, message: fillTemplate(appConfig.copy.drawingEditor.removeEMessage, { n: incoming.length }), confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true })
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


  // removing a storey: the confirm is the OWNER's (IncidentWorkspace · onRemoveFloor →
  // lib/storeyRemoval), because only the store knows which annos on this tile are the stack's own
  // and which are the Karte's, merely shown here — and only the own ones can be lost
  const removeFloor = (f: number) => {
    if (readOnly || building?.pack || floorPack?.tiles[f]) return
    onRemoveFloor(f)
  }

  // footprint draw box per floor tile: fill most of the tile, preserving the
  // building's true aspect (the SVG inside stretches the 0..1 ring to this box).
  // Mirror of lib/footprint · fpBoxFrac (kept here in px for layout).
  const fpBox = (() => {
    if (!stack || !fpView) return null
    const tileH = sH / N
    const availW = sW * BOX_W, availH = tileH * BOX_H
    let w = availW, hgt = availW * fpView.aspect
    if (hgt > availH) { hgt = availH; w = availH / fpView.aspect }
    return { w, h: hgt }
  })()

  /** Each drawn storey's VISIBLE SECTION in board px (lib/storeyClip, 24.09.2026): the drawings the
   *  tile shows — laid exactly as the <FloorPage>s below lay them — cut to the footprint box, or
   *  the whole tile where there is no Geschossplan. Ink, Flächen and Absperrkreise are cut to it
   *  and wear an edge mark where they leave; a Karte hose no longer runs through the blank band
   *  into the next storey's plan. Null off the stack. */
  const sections = stack && building && sW && sH ? storeySections({
    floorsTTB, sW, sH, box: fpBox,
    drawings: (f) => {
      const parts = floorPack?.tiles[f]
      if (!parts?.length || !fpBox) return []
      if (building.pack) return packView ? parts.map((tile) => regionCorners(packPagePlacement(packView, building.pack!.aspect, tile), tile.clip)) : []
      const corners = floorPack?.fit && building.src?.length ? pagePlacement(building, shownAngle, floorPack.fit) : null
      return corners ? [corners] : []
    },
  }) : null
  /** is a board-px point on its storey's visible section? (true off the stack) — what decides
   *  whether a line's arrowhead, tag, label or stair mark still has somewhere to stand */
  const onSection = (floor: number | undefined, p: [number, number]) => {
    const s = sections?.get(floor ?? 0)
    return !s || inSection(p, s)
  }

  // Rotate the Gebäudeview to `toDeg`. Re-derives the footprint view and re-glues every
  // floor-stack annotation (x/y, freehand pts, team trails) so they stay on the same
  // real-world spot — see lib/footprint · remapPoint — and the VIEW with them (the pan at the
  // end). The single commit path for every door: the compass chip's popover, the rail footer's,
  // the slider and the two named-angle chips inside them.
  const reorientTo = (toDeg: number) => {
    if (!building || !orientSrc || !onReorient || readOnly || !sW || !sH) return
    const fromDeg = viewAngle
    if (Math.abs(toDeg - fromDeg) < 0.01) return
    const view = buildView(orientSrc, toDeg)
    const layout = { boardW: sW, boardH: sH, floors: N }
    // …and the board the turn lands on: a pack's card follows its frame, so turning a flat frame
    // upright makes every storey band taller. The ink is stored against the box inside that band,
    // so the re-glue has to know both boards (lib/footprint · remapPoint).
    const nextTileAR = building.pack ? bandAspect(view.aspect) : tileAR
    const toLayout = { boardW: sW, boardH: sW * N * nextTileAR, floors: N }
    const src = orientSrc
    const mv = (p: [number, number]): [number, number] => remapPoint(src, fromDeg, toDeg, layout, p, toLayout)
    // where the view is looking, in tile coordinates, re-glued the same way (see the pan below)
    const anchor = (() => {
      const s = scaleRef.current, w = fit.w * s, h = fit.h * s
      if (!w || !h) return null
      if (s <= 1 && Math.abs(posRef.current.x) < 1 && Math.abs(posRef.current.y) < 1) return null
      const nx = clamp01((w / 2 - posRef.current.x) / w), ny = clamp01((h / 2 - posRef.current.y) / h)
      const floor = floorAt(ny)
      const [x, y] = mv([nx, localY(ny, floor)])
      return { x, y, floor }
    })()
    const remapped = annos.map((a) => {
      // ⚠️ the BEARINGS turn with the paper too (lib/stackFit · reorientBearings, 15.09.2026):
      // a stored rotation is relative to the sheet, and the sheet is what just moved. Without it
      // a Fahrzeug DRAWN on a tile stayed pointing where it was while the identical one placed
      // on the Karte — projected through the stack's fit — swung with the building.
      const next: BoardAnno = { ...reorientBearings(a, toDeg - fromDeg) }
      if (a.x != null && a.y != null) { const [x, y] = mv([a.x, a.y]); next.x = x; next.y = y }
      if (a.pts) next.pts = a.pts.map((p): BoardPoint => { const [x, y] = mv([p[0], p[1]]); return p[2] == null ? [x, y] : [x, y, p[2]] })
      if (a.trail) next.trail = a.trail.map((tp) => { const [x, y] = mv([tp.x, tp.y]); return { ...tp, x, y } })
      return next
    })
    commit(remapped) // re-glued annotations go through undo/redo + sync
    // `northUp` stays in sync (0° IS north-up) so pre-dial clients keep their binary read — on a
    // PACK it would be a lie (0° is the page as drawn, which is north-up only by luck), and the
    // rings would be the frame rectangle, which a pack deliberately has none of. Only the aspect
    // crosses over: it is what makes the tile box follow the turned frame.
    onReorient(building.pack
      ? { ...building, viewDeg: toDeg, ringAspect: view.aspect, tileAR: nextTileAR }
      : { ...building, viewDeg: toDeg, northUp: toDeg === 0, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect })
    emit('building.reorient', { northUp: toDeg === 0, deg: toDeg, planId: activeId })
    // …and the VIEW is re-glued too. The board keeps its size through a rotation (a stack's
    // aspect is the floor count, not the footprint's — see effAspect), so the storey cards stay
    // centred in their tiles; what moves is the content INSIDE them, around the footprint's own
    // bbox centre. Zoomed in on one corner of the building, that swings the corner off the
    // screen. Take the point the operator is looking at, re-glue it exactly like an annotation,
    // and pan it back under their eyes. At the fitted view there is nothing to hold — the whole
    // stack is on screen and centred by definition — so that one is left alone.
    if (anchor) centerOnPoint(anchor.x, anchor.y, anchor.floor)
  }
  // ── rotation popover (30.08., replaces the A8 dial drag) ── a hidden drag on a 44px dial was
  // «hard to control»; the compass (dial AND rail button) now opens a small popover with a
  // degree SLIDER instead. Within ~5° of the two meaningful angles — north-up and the long
  // axis — the slider snaps, live in the preview (shownAngle) so the catch is visible before
  // release; the two named angles are also one-tap chips.
  const DIAL_SNAP_DEG = 5
  const normDeg = (d: number) => { let x = d % 360; if (x > 180) x -= 360; if (x <= -180) x += 360; return x }
  /** The angle that puts real north up. For an outline that is 0 by construction (`src` is stored
   *  north-up); for a PACK it is the negative of the page's own bearing, which only its approved
   *  map fit knows — without one there is no such angle, and no chip offering it. */
  const northUpDeg = building?.pack ? (floorPack?.fit ? normDeg(-floorPack.fit.rotationDeg) : null) : 0
  const snapDial = (d: number) => {
    const n = normDeg(d)
    for (const target of [0, orientDeg, northUpDeg]) {
      if (target != null && Math.abs(normDeg(n - target)) <= DIAL_SNAP_DEG) return target
    }
    return n
  }
  const commitOrient = (deg: number) => { setDialDragDeg(null); reorientTo(snapDial(deg)) }
  // ⚠️ The popover is portalled to <body>, but React bubbles its events through the COMPONENT
  // tree — for the north dial's door that is the board's canvas, whose pointerdown pans and takes
  // pointer capture. Captured, a chip's click landed on the canvas («Norden oben» did nothing with
  // a mouse, rarely something on the iPad) and the slider's drag panned the board. Nothing inside
  // the popover is the board's (24.09.2026).
  const orientControls = (
    <div className="wb-orient-pop" onPointerDown={(e) => e.stopPropagation()}>
      <label className="wb-orient-row">
        <span className="wb-orient-lbl">{appConfig.copy.whiteboard.orientSliderLabel}</span>
        {/* ⚠️ a cancelled gesture (iOS: the touch became a scroll) or the popover closing drops
            the preview instead of leaving the backdrop turned uncommitted (24.09.2026) */}
        <OrientSlider
          value={Math.round(normDeg(dialDragDeg ?? viewAngle))}
          label={appConfig.copy.whiteboard.orientSliderLabel}
          onPreview={(deg) => setDialDragDeg(snapDial(deg))}
          onCommit={commitOrient}
          onAbandon={() => setDialDragDeg(null)}
        />
        <b className="wb-orient-val">{Math.round(normDeg(dialDragDeg ?? viewAngle))}°</b>
      </label>
      <div className="wb-orient-chips">
        {/* «Wie gezeichnet» is the pack's own 0°: the sheet as the architect drew it, which is a
            meaningful place to come back to and is NOT north-up (that is the chip beside it) */}
        {building?.pack && (
          <button type="button" className={`wb-orient-chip${normDeg(shownAngle) === 0 ? ' on' : ''}`}
            onClick={() => commitOrient(0)}>{appConfig.copy.whiteboard.orientAsDrawn}</button>
        )}
        {northUpDeg != null && (
          <button type="button" className={`wb-orient-chip${normDeg(shownAngle) === northUpDeg ? ' on' : ''}`}
            onClick={() => commitOrient(northUpDeg)}>{appConfig.copy.whiteboard.orientNorthUp}</button>
        )}
        {Math.abs(orientDeg) > 0.001 && (
          <button type="button" className={`wb-orient-chip${normDeg(shownAngle) === normDeg(orientDeg) ? ' on' : ''}`}
            onClick={() => commitOrient(orientDeg)}>{appConfig.copy.whiteboard.orientLongAxis}</button>
        )}
      </div>
    </div>
  )

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
  // A nearby-only object (the nearest one with plans, not the Einsatzadresse) is a warning the
  // chip carries itself: amber, the warn glyph, and the distance after the address. Short on
  // the pill, the full sentence in the label – the chip only hints, the reader gets the meaning.
  const nearbyDist = objectNearby ? fmtDistance(objectNearby.distanceM) : null
  const objectChipText = nearbyDist
    ? fillTemplate(appConfig.copy.whiteboard.objectNearby, { name: objectChipName, distance: nearbyDist })
    : objectChipName
  const objectChipLabel = nearbyDist
    ? fillTemplate(appConfig.copy.whiteboard.objectNearbyLabel, { distance: nearbyDist })
    : onObjectSwitch
      ? fillTemplate(appConfig.copy.whiteboard.objectSwitch, { name: objectChipName })
      : fillTemplate(appConfig.copy.whiteboard.objectIs, { name: objectChipName })
  const objectChip = objectChipHidden ? null : (
    <button
      type="button"
      className={`wb-scale-chip wb-object${nearbyDist ? ' wb-object-nearby' : ''}`}
      // «Objekt» named the field, which is the one thing the value already says — a plan set
      // belongs to an Einsatzobjekt and nothing else in this corner is a place name. The chevron
      // went with it: everywhere else in this app it opens a popover under the control, and here
      // it opened a full modal with a search field and a map. What is left is the fact itself.
      // The verb lives in the label a screen reader reads, where it was missing entirely.
      aria-label={objectChipLabel}
      title={nearbyDist ? objectChipLabel : onObjectSwitch ? appConfig.copy.whiteboard.objectSwitchShort : undefined}
      disabled={!onObjectSwitch}
      onClick={onObjectSwitch}
    >
      <Icon id={nearbyDist ? 'warn' : 'footprint'} />
      <span>{objectChipText}</span>
    </button>
  )


  // The banner half of the same warning (owner, 14.09.): the chip is permanent but small, and at
  // 3am a small amber pill is not a sentence. So the first time a plan of a merely-nearby object
  // is opened in this Einsatz, a banner over the sheet says both addresses side by side and
  // offers the picker. ✕ is remembered per Einsatz and object (lib/nearbyBanner) – after that
  // only the chip keeps saying it. Hidden where the chip is hidden: nothing there is that
  // object's plan.
  const bannerKey = objectNearby && incidentId ? nearbyBannerKey(incidentId, objectNearby.objectId) : null
  const [bannerGone, setBannerGone] = useState<string | null>(null)
  const nearbyBanner = bannerKey && nearbyDist && !objectChipHidden && bannerGone !== bannerKey && !nearbyBannerDismissed(bannerKey) ? (
    <div className="wb-nearby-banner" role="status">
      <Icon id="warn" />
      <span className="wb-nearby-text">
        <b>{appConfig.copy.whiteboard.nearbyBannerTitle}</b>{' '}
        {fillTemplate(appConfig.copy.whiteboard.nearbyBannerBody, { incident: incidentAddress || appConfig.copy.whiteboard.nearbyBannerNoAddress, object: objectChipName, distance: nearbyDist })}
      </span>
      {onObjectSwitch && (
        <button type="button" className="wb-nearby-switch" onClick={onObjectSwitch}>{appConfig.copy.whiteboard.objectSwitchShort}</button>
      )}
      <button
        type="button" className="wb-nearby-x" aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog}
        onClick={() => { dismissNearbyBanner(bannerKey); setBannerGone(bannerKey) }}
      ><Icon id="close" /></button>
    </div>
  ) : null

  // ── The way between the two faces of the ONE «Gebäude» tile ────────────────────────────────
  // The rail lists one entry for the outline picker and the floor stack (lib/useObjectPlans ·
  // railPlanTiles), so «ich will ein anderes Gebäude» needs a door — and it belongs HERE, in the
  // row that already answers «was schaue ich an» (Objekt · Maßstab), not as a second rail tile
  // that would put the mechanism back in the navigation it was just taken out of.
  // Only ever shown on the two surfaces it is about, and only once there is somewhere to go:
  // on the stack it opens the picker, on the picker (with a stack behind it) it goes back.
  // Pure navigation — but only where the picker can be used (see `buildingChipLocked`). Replacing
  // the building is still the picker's own act, with its confirm-and-undo (IncidentWorkspace ·
  // onSelectBuilding); this chip only walks there.
  // ⚠️ On the STACK the pill reads the building's own NAME, not the verb (owner, 18.09.2026).
  // «Anderes Gebäude wählen» is an instruction, and the object read-out beside it is dropped on
  // exactly this surface (objectChipHidden) — so the one pill that could answer «which building
  // am I standing in» spent its whole width telling the operator what tapping it would do. The
  // name (the object's ADDRESS, name as fallback — the same string objectChip uses, because a
  // BuildingDoc carries no name of its own) plus a chevron says both: what this is, and that
  // the pill goes somewhere. The VERB stays in title/aria-label, so a screen reader and a
  // long-press still get the instruction that left the face.
  // On the picker face there is no stack to name yet — «Zurück zum Gebäude» is the whole point
  // of the pill there, and it keeps the never-truncating treatment (.wb-building).
  const buildingChipLabel = stack ? appConfig.copy.whiteboard.replaceBuilding : appConfig.copy.whiteboard.backToBuilding
  // …and with no object bound at all there is no name to show: the verb comes back, and with it
  // the never-truncating treatment, rather than a pill reading «Kein Objekt» about a building
  // that is plainly there.
  const buildingChipName = stack ? objectAddress?.trim() || objectName?.trim() || null : null
  // ⚠️ …but not for a session that cannot pick (25.09.2026, 3am test on staging): the picker face
  // is non-interactive under the lock (OsmOutline · interactive), so «Anderes Gebäude wählen» led
  // an `el` to outlines it could not tap and no «Übernehmen» — a door into a dead end. Locked, the
  // stack's pill is only the building's NAME as a read-out (the `.wb-object` recipe: disabled, not
  // greyed); with no name there is nothing to read and no pill. The picker face's «Zurück zum
  // Gebäude» stays for everyone: it is the way OUT.
  const buildingChipLocked = stack && readOnlyProp
  const buildingChip = onBuildingFace && (stack || (osm && building)) && !(buildingChipLocked && !buildingChipName) ? (
    <button
      type="button"
      className={`wb-scale-chip wb-building${buildingChipName ? ' wb-building-named' : ''}`}
      aria-label={buildingChipLocked ? buildingChipName! : buildingChipLabel}
      title={buildingChipLocked ? undefined : buildingChipLabel}
      disabled={buildingChipLocked}
      onClick={() => onBuildingFace(stack ? 'pick' : 'stack')}
    >
      <Icon id={stack ? 'footprint' : 'floors'} />
      <span>{buildingChipName ?? buildingChipLabel}</span>
      {buildingChipName && !buildingChipLocked && <Icon id="chevron" className="wb-chip-chev" />}
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
        {nearbyBanner}
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
          // ⚠️ …and it stands down entirely while ✥ / ⟳ are armed: React delegates at the app
          // root, so this capture handler runs BEFORE useArmedTransform's listener on this very
          // element and would dismiss the twin panel of the object the drag is about to move.
          onPointerDownCapture={(e) => {
            if (suchePick) pickTap.current = { x: e.clientX, y: e.clientY, n: pickTap.current ? 2 : 1 }
            if (arm.armed && !(e.target as HTMLElement | null)?.closest?.('[data-arm-exempt]')) return
            if (!(e.target as HTMLElement | null)?.closest?.('[data-twin]')) { setNotePanelId(null) }
            trackDown(e)
          }}
          onPointerUpCapture={(e) => { pickUp(e); trackUp(e) }}
          onPointerCancelCapture={(e) => { pickTap.current = null; trackUp(e) }}
          onPointerDown={(e) => { if (!(e.target as HTMLElement | null)?.closest?.('[data-twin]')) { setNotePanelId(null) } stageDown(e) }}
          onPointerMove={stageMove}
          onPointerUp={stageUp}
          onPointerCancel={stageUp}
        >
          <div
            ref={boardRef}
            className={`wb-board ${blank ? 'wb-board-blank' : ''}`}
            // the reserved lanes are not symmetric (the rails differ), so the centre shifts by half
            // their difference — exactly what `vShift` does for the top bar (and the Gebäude's
            // chip row below)
            style={{ width: sW || undefined, height: sH || undefined, transform: `translate(-50%, -50%) translate(${pos.x + (side.l - side.r) / 2}px, ${pos.y + vShift}px)` }}
          >
            {stack && building ? (
              <>
              {/* what is folded away, as a strip where the storey belongs – «+2 · 2. OG
                  ausgeblendet · einblenden». Chrome, not a tile: the board's geometry is the DRAWN
                  storeys, so nothing under it moves when one is folded (mock A, 16.09.2026). */}
              {folded.map(({ floor: f, seam, order, count }) => {
                const top = seam === 0 ? -(count - order) * FOLDED_H       // above the stack, in order
                  : seam >= N ? sH + order * FOLDED_H                      // below it
                  : (seam / N) * sH - FOLDED_H / 2 + order * FOLDED_H      // straddling the seam
                const name = building.floorNames?.[String(f)] ?? floorLabel(f)
                // ⚠️ the WHOLE strip is the button, and it says so by name: on a narrow tile the
                // «einblenden» word and the eye on the headers above are both dropped (09-whiteboard.css),
                // so this label is all that is left to announce what tapping the row does.
                return (
                  <button key={`folded:${f}`} type="button" className="wb-floor-folded" style={{ top, width: sW, height: FOLDED_H }}
                    title={`${name} ${appConfig.copy.whiteboard.floorShow}`} aria-label={`${name} ${appConfig.copy.whiteboard.floorShow}`}
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleFloor(f)}>
                    <span className={`wb-floor-idx${f === 0 ? ' zero' : ''}`}>{signedFloor(f)}</span>
                    <span className="wb-floor-name">{name}</span>
                    <span className="wb-floor-folded-state">{appConfig.copy.whiteboard.floorHidden}</span>
                    <span className="wb-floor-folded-cta"><Icon id="eyeoff" />{appConfig.copy.whiteboard.floorShow}</span>
                  </button>
                )
              })}
              {floorsTTB.map((f, idx) => (
                <div key={f} className="wb-floor" style={{ top: (idx / N) * sH, height: sH / N, width: sW }}>
                  <div className="wb-floor-label">
                    {/* mock B (14.09.2026): the signed index as the SAME chip the Karte badges a storey
                        with – recognition, not reading – then the name; a custom name («Hauptebene»)
                        never hides the order, and level 0 is the blue one */}
                    <span className={`wb-floor-idx${f === 0 ? ' zero' : ''}`}>{signedFloor(f)}</span>
                    <span className="wb-floor-name">{building.floorNames?.[String(f)] ?? floorLabel(f)}</span>
                    {/* fold this storey away – a way of LOOKING, so it stands on every surface,
                        read-only ones included, and never asks (the strip it leaves is the way back) */}
                    {floorsTTB.length > 1 && (
                      <button className="wb-floor-eye" title={appConfig.copy.whiteboard.floorHide} aria-label={appConfig.copy.whiteboard.floorHide}
                        onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleFloor(f)}><Icon id="eye" /></button>
                    )}
                  </div>
                  {/* «Geschoss entfernen» — NOT in the label any more (3am test r2, 25.09.2026): an
                      18px ✕ right beside the fold eye, one tap took a storey away for everybody. It
                      stands alone in the tile's opposite corner now, a full --tap square, so a press
                      meant for the name or the eye can never land on it; the act is still
                      confirm-with-undo (IncidentWorkspace · onRemoveFloor). Its Verlauf row and
                      the «entfernt» wording come with PR #226 (whiteboard.floorRemovedLog). */}
                  {f !== 0 && !readOnly && !building.pack && !floorPack?.tiles[f] && (
                    <button className="wb-floor-x"
                      title={`${appConfig.copy.whiteboard.removeFloor}: ${building.floorNames?.[String(f)] ?? floorLabel(f)}`}
                      aria-label={`${appConfig.copy.whiteboard.removeFloor}: ${building.floorNames?.[String(f)] ?? floorLabel(f)}`}
                      onPointerDown={(e) => e.stopPropagation()} onClick={() => removeFloor(f)}><Icon id="close" /></button>
                  )}
                  {/* (the north dial used to be drawn on this tile, top-right. It now floats in
                      the viewport's corner — see <PlanCompass> below the board: inside the tile
                      it panned and zoomed away with the paper, taking the rotation control with
                      it. One compass, one corner, on every device.) */}
                  <div className="wb-floor-fp" style={{ width: fpBox?.w, height: fpBox?.h }}>
                    {/* px viewBox, no vector-effect — see WbInkLayer's header for why the 1×1
                        stretch + non-scaling-stroke pattern is banned on the board */}
                    <svg viewBox={`0 0 ${fpBox?.w || 1} ${fpBox?.h || 1}`} preserveAspectRatio="none" className="wb-floor-svg">
                      {/* the storey's Geschossplan page UNDER the outline, placed through the pack's
                          map fit and the footprint's geo anchor (lib/stackFit · pagePlacement) */}
                      {floorPack && floorPack.tiles[f]?.length && fpBox && (building.pack || (floorPack.fit && building.src?.length)) && (() => {
                        const parts = floorPack.tiles[f]
                        if (building.pack) {
                          // the tile box IS the reference frame: each of the storey's drawings is laid into it
                          // shifted by its OWN anchor difference, and only that drawing is rendered
                          // (lib/floorPackBinding) – two wings of one storey land side by side
                          return parts.map((tile) => (
                            <FloorPage key={`${f}:${tile.part}:${tile.url}`} url={tile.url} corners={packPagePlacement(packView!, building.pack!.aspect, tile)}
                              region={tile.clip} w={fpBox.w} h={fpBox.h} floors={drawings} onDensity={takeStackDensity} />
                          ))
                        }
                        // a footprint stack places the whole page through the fits – one page, one raster
                        const corners = pagePlacement(building, shownAngle, floorPack.fit!)
                        return corners && <FloorPage key={parts[0].url} url={parts[0].url} corners={corners} w={fpBox.w} h={fpBox.h} floors={N} onDensity={takeStackDensity} />
                      })()}
                      {building.pack && !floorPack?.tiles[f]?.length && fpBox && (
                        <text x={fpBox.w / 2} y={fpBox.h / 2} textAnchor="middle" className="wb-floor-noplan">{appConfig.copy.whiteboard.noFloorPlan}</text>
                      )}
                      {/* the footprint outline – a pack has none: its frame is a rectangle around
                          the drawing, and drawing it would put a box on every storey */}
                      {!building.pack && (fpView?.rings ?? building.rings ?? [building.ring]).map((ring, ri) => (
                        <polygon key={ri} points={ring.map((p) => `${p[0] * (fpBox?.w || 1)},${p[1] * (fpBox?.h || 1)}`).join(' ')} />
                      ))}
                    </svg>
                  </div>
                </div>
              ))}
              </>
            ) : osm ? (
              /* the ONE interaction this surface has. Gated on the ROLE's read-only (viewer / EL /
                 locked / replay) — NOT on `readOnly`, which is true here for everybody by design
                 (see selectOnly above); picking a building is the whole point of the sheet. */
              // the building already in the stack is handed down so the picker can find it among the
              // live footprints and start it SELECTED — «Anderes Gebäude wählen» is almost always
              // «ergänzen». A building saved without a georeference has nothing to match on and
              // still starts empty, which `replacing` then says out loud.
              <OsmOutline key={active.id} center={osm.center} radiusM={osm.radiusM} onAspect={takeAspect}
                sW={sW} sH={sH}
                interactive={!readOnlyProp} replacing={!!building}
                preselectSrc={building?.geo ? building.src : undefined} preselectGeo={building?.geo}
                pin={incidentPos} onPick={onSelectBuilding} />
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
                onAspect={takeAspect}
              />
            )}

            {/* Absperrkreise — their own px-space layer, painted under the ink (WbCircleLayer) */}
            <WbCircleLayer annos={renderAnnos} draft={circleDraft} sW={sW} sH={sH} mapY={mapY}
              color={appConfig.drawing.circleColor} selId={selId} flashId={flashId}
              onPickCircle={tool === 'pan' ? circleDown : undefined} sections={sections ?? undefined} />

            {/* committed drawings */}
            <WbInkLayer annos={renderAnnos} draft={draft} draftFloor={draftFloor.current} draftClosed={tool === 'area'} color={color} width={width} dashed={dashed} hiddenTrails={hiddenTrails} mapY={mapY}
              selId={selId} flashId={flashId} networkIds={[...relationship.lineIds]} onPickDraw={tool === 'pan' ? drawDown : undefined}
              truppTones={truppTones} sW={sW} sH={sH} sections={sections ?? undefined} />
            {/* «Ring lädt, dann schnappt es» — the identical pair the Lage map draws: a blue chip
                BESIDE the target whose ring is the remaining dwell (only a full one attaches), and
                its red twin at the socket an attached endpoint is being pulled out of (only a full
                one releases). The key carries `since`, so re-entering the same target restarts the
                CSS fill. Cycle-forming targets never make the candidate list, so no blocked state.
                The explicit «Verbindung lösen» chip on a selected endpoint stays as it was.
                ⚠️ No ring for a LINE target (dwellFor = 0): it attaches the instant it is
                acquired, so there is no fill to picture — Karte parity. */}
            {planEndpointDragState?.candidate && dwellFor(planEndpointDragState.candidate) > 0 && (
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
            {planDraftMagnetState?.candidate && dwellFor(planDraftMagnetState.candidate) > 0 && (
              <span key={`${planDraftMagnetState.candidate.key}:${planDraftMagnetState.dwell.since}`} className="magnet-anchor wb-magnet"
                style={{ left: planDraftMagnetState.candidate.point[0], top: planDraftMagnetState.candidate.point[1] }}>
                <ConnectRing since={planDraftMagnetState.dwell.since} armed={planDraftMagnetState.dwell.armed} />
              </span>
            )}
            {/* …and the same ring for a Rotation, at both the end being dragged and each of the
                two taps that lay it down (claimRotTarget) */}
            {/* the first of a Rotation's two points, while the second is still being looked for */}
            {rotStart && (
              <span className="magnet-anchor wb-magnet" style={{ left: rotStart[0] * sW, top: mapY(rotStart[2] ?? 0, rotStart[1]) * sH }}>
                <span className="place-anchor" />
              </span>
            )}
            {rotMagnet && (
              <span key={`rotmag:${rotMagnet.since}`} className="magnet-anchor wb-magnet"
                style={{ left: rotMagnet.x * sW, top: mapY(rotMagnet.floor, rotMagnet.y) * sH }}>
                <ConnectRing since={rotMagnet.since} armed={rotMagnet.armed} />
              </span>
            )}

            {/* line arrowheads · repeated marker letters · free-text label + distance — rendered in
                board px (the ink SVG is stretched 1×1 and would distort them). Same feature set +
                spacing math as the Lage map (markerParamsAlong / —R— rhythm); the metric distance
                read-out now works too, once the plan is calibrated (lib/planScale). One per Linie. */}
            {/* stair marks (mock C, 14.09.2026): where a Leitung leaves a storey, a circled number
                says where it goes; where it arrives, where it came from – at the same spot on both
                tiles, the staircase. Tapping one moves the view to the other end of the climb. */}
            {stack && renderAnnos.filter((a) => a.kind === 'draw' && (a.pts?.length ?? 0) >= 2).flatMap((a) => {
              const p = a.pts!
              const color = a.color || COLORS[0]
              return floorCrossings(p, a.floor).flatMap((i) => [[p[i], p[i + 1]], [p[i + 1], p[i]]].map(([at, other], side) => {
                const atFloor = at[2] ?? a.floor ?? 0, otherFloor = other[2] ?? a.floor ?? 0
                // a climb made outside the storey's visible section has nowhere to stand
                if (!onSection(atFloor, [at[0] * sW, mapY(atFloor, at[1]) * sH])) return null
                const label = fillTemplate(side === 0 ? appConfig.copy.whiteboard.stairTo : appConfig.copy.whiteboard.stairFrom, { floor: signedFloor(otherFloor) })
                return (
                  <button key={`${a.id}:stair:${i}:${side}`} type="button" className="wb-line-stair" aria-label={label} title={label}
                    // off the vertex, like a badge: the vertex itself stays tappable (select, drag, ↑/↓)
                    style={{ color, transform: `translate(${at[0] * sW + 18}px, ${mapY(atFloor, at[1]) * sH - 18}px) translate(-50%, -50%)` }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      // …and if the other end is folded away, unfold it: the rAF lets the new tile
                      // layout land before the view is aimed at it
                      revealFloor(otherFloor)
                      requestAnimationFrame(() => centerOnPoint(other[0], other[1], otherFloor))
                    }}>
                    {signedFloor(otherFloor)}
                  </button>
                )
              }))
            })}
            {renderAnnos.filter((a) => a.kind === 'draw' && (a.arrow || a.marker || a.label || a.showDistance || hasLineDecor(a)) && (a.pts?.length ?? 0) >= 2).map((a) => {
              const p = a.pts!
              const bpx = p.map(([x, y, floor]) => [x * sW, mapY(floor ?? a.floor, y) * sH] as [number, number])
              const end = bpx[bpx.length - 1]
              const midIdx = Math.floor((bpx.length - 1) / 2)
              const mid = bpx[midIdx]
              const color = a.color || COLORS[0]
              // On the stack the stroke is cut to its storey's section (lib/storeyClip): whatever
              // stands on a part that is not drawn — the tip, the tag, a marker, the label — is not
              // drawn either; the edge mark says the line goes on. `seg` names the vertex a spot
              // follows, whose storey it is on.
              const onLine = (seg: number, at: [number, number]) => onSection(p[seg][2] ?? a.floor, at)
              const endShown = onLine(bpx.length - 1, end)
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
              // `deg` rides along so an FKS chain glyph stands on the line; a letter ignores it.
              // Board px are screen px here (the board is only translated/scaled), so the bearing
              // is directly usable — the same value the Lage map computes from projected px.
              const markerPts: { at: [number, number]; deg: number }[] = a.marker
                ? (() => {
                  const along = markerParamsAlong(bpx, markerSpacing(a.marker))
                  const ps = along.map(({ seg, t, deg }) => ({ seg, at: lerpPoint(bpx[seg], bpx[seg + 1], t), deg }))
                  return (ps.length ? ps : [{ seg: midIdx, at: mid, deg: 0 }])
                    .filter((m) => onLine(m.seg, m.at)).map(({ at, deg }) => ({ at, deg }))
                })()
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
                  {a.arrow && endShown && (
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
                  {a.teilstueck && endShown && (
                    <span className="wb-line-deco" style={{ transform: `translate(${end[0]}px, ${end[1]}px) translate(-50%, -50%)` }}>
                      <TeilstueckFork angleDeg={ang} color={color} width={a.width ?? 5} />
                    </span>
                  )}
                  {/* one combined FKS tag (Leitung-Nr · content · Stockwerk) — anchored just before
                      the tip and draggable (endDx/endDy, normalized) to clear other symbols */}
                  {(a.content || a.lineNo != null || a.floorTag != null || lineTrupp) && (() => {
                    const pe = bpx[bpx.length - 1]
                    const pp = bpx[bpx.length - 2] ?? pe
                    const base: [number, number] = [pp[0] + (pe[0] - pp[0]) * 0.72, pp[1] + (pe[1] - pp[1]) * 0.72]
                    if (!onLine(bpx.length - 1, base)) return null
                    const ax = base[0] + (a.endDx ?? 0) * sW
                    const ay = base[1] + (a.endDy ?? -0.02) * sH
                    return (
                      <span className="wb-line-deco draggable" style={{ transform: `translate(${ax}px, ${ay}px) translate(-50%, -50%)`, cursor: tool === 'pan' ? 'move' : undefined }}
                        onPointerDown={tool === 'pan' ? (e) => labelDown(e, a.id, a.endDx ?? 0, a.endDy ?? -0.02, 'end') : undefined}
                        onPointerMove={tool === 'pan' ? labelMove : undefined}
                        onPointerUp={tool === 'pan' ? labelUp : undefined}
                        onPointerCancel={tool === 'pan' ? labelUp : undefined}>
                        <EndTag
                          lineNo={a.lineNo} content={a.content} floorTag={a.floorTag}
                          tone={lineTone}
                          color={color}
                        />
                      </span>
                    )
                  })()}
                  {/* a LETTER keeps the plan's chip (plate + ring, legible over a printed plan);
                      a chain GLYPH is bare, like the sheet draws it — hence the two classes. */}
                  {markerPts.map((mp, i) => (
                    <span key={`mk-${i}`} className={markerGlyph(a.marker) ? 'wb-line-glyph' : 'wb-line-marker'}
                      style={{ left: 0, top: 0, color, transform: `translate(${mp.at[0]}px, ${mp.at[1]}px) translate(-50%, -50%)` }}>
                      <LineMarker marker={a.marker!} color={color} deg={mp.deg} className="wb-line-mk" />
                    </span>
                  ))}
                  {labelLines.length > 0 && onLine(midIdx, mid) && (
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
              // on the stack: the centre of what is LEFT of the Fläche on its storey's section
              // (lib/storeyClip) — none when nothing of it shows
              const section = sections?.get(a.floor ?? 0)
              const centre = section ? visibleCentre(bpx, section) : null
              if (section && !centre) return null
              const cx = centre ? centre[0] : bpx.reduce((s, q) => s + q[0], 0) / bpx.length
              const cy = centre ? centre[1] : bpx.reduce((s, q) => s + q[1], 0) / bpx.length
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
                    <button key={`mi-${i}`} className="wb-vins" title={appConfig.copy.measure.insertPoint} aria-label={appConfig.copy.measure.insertPoint}
                      style={{ left: 0, top: 0, transform: `translate(${((p[0] + b[0]) / 2) * sW}px, ${((p[1] + b[1]) / 2) * sH}px) translate(-50%, -50%)` }}
                      onPointerDown={(e) => measInsert(i, e)}><Icon id="plus" /></button>
                  )
                })}
                {/* draggable nodes (hold to delete) + cumulative-distance labels */}
                {measPath.map((p, i) => {
                  const cum = calibrated && i > 0 ? pathMetres(measMpts.slice(0, i + 1), activeScale!.mPerU, measureAR) : null
                  return (
                    <Fragment key={`mn-${i}`}>
                      {/* positioning wrapper so the handle's :active scale never clobbers the
                          board-px placement (mirrors how the map nests the handle in a Marker) */}
                      <div className="wb-meas-node" style={{ left: 0, top: 0, transform: `translate(${p[0] * sW}px, ${p[1] * sH}px) translate(-50%, -50%)` }}>
                        <button className={`measure-handle ${measPress.armed?.key === `m${i}` ? 'doomed' : ''}`}
                          title={appConfig.copy.measure.deleteNode} aria-label={appConfig.copy.measure.deleteNode}
                          onPointerDown={(e) => { measPress.press(`m${i}`, () => measDelete(i)).onPointerDown(e); measNodeDown(i, e); setMeasDragNode(i) }}
                        >{measPress.armed?.key === `m${i}` && <NodeDeleteChip progress={measPress.armed.progress} />}</button>
                      </div>
                      {measMode === 'line' && cum != null && measDragNode !== i && (
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

            {/* an Absperrkreis states its radius at the ring's top edge, exactly as the Karte does
                (MapView · circleLabels) — in the sheet's calibrated metres. Uncalibrated there is
                no honest number to print, so the ring simply carries none. */}
            {calibrated && activeScale && renderAnnos.filter((a) => a.kind === 'circle' && (a.radiusN ?? 0) > 0).map((a) => {
              const cx = (a.x ?? 0) * sW, cy = mapY(a.floor, a.y ?? 0) * sH
              const r = (a.radiusN ?? 0) * sW
              return (
                <span key={`cr-${a.id}`} className="wb-line-label"
                  style={{ left: 0, top: 0, transform: `translate(${cx}px, ${cy - r}px) translate(-50%, -100%)` }}>
                  {fmtDistance(circleRadiusM(a.radiusN ?? 0, activeScale.mPerU, measureAR))}
                </span>
              )
            })}

            {/* vertex editing for a selected line/area — node drag / insert / delete (one shared
                code path for Linie + Fläche). A many-point freehand stroke used to be skipped here
                entirely and so could not be reshaped at all; WbVertexHandles now thins its own
                grips instead (mirrors the map's cap). */}
            {editDraw && editDraw.kind !== 'circle' && tool === 'pan' && (
              <WbVertexHandles anno={renderAnnos.find((a) => a.id === editDraw.id) ?? editDraw} sW={sW} sH={sH} mapY={mapY}
                onVertexDown={vertDown} onInsert={insertVertex} onDeleteVertex={deleteVertex} onExtend={extendLine}
                onClimb={stack ? climbLine : undefined} floors={stack ? floorsTTB : undefined} />
            )}
            {/* Absperrkreis: ONE grip on the ring (screen-right) sets the radius — the gesture
                that placed it, available again afterwards. It is the only way to resize on an
                uncalibrated sheet, where the editor's metre stepper has nothing to say. */}
            {editDraw?.kind === 'circle' && tool === 'pan' && (
              <WbCircleHandle anno={editDraw} sW={sW} sH={sH} mapY={mapY}
                onRadiusDown={(e) => rotDown(e, editDraw.id, 'radius')} onMove={rotMove} onUp={rotUp} />
            )}
            {/* unlock chip on every locked line/area/shape — the click-through ink's only tap
                target, a SHORT HOLD to unlock + select (the Lage's twin, MapView · LockChip /
                MapMarkers · shape-lock-anchor). Its only job is unlocking, so it stays away where
                editing is locked anyway. Position mirrors the map: an area is chipped at its
                centroid, a line at its middle vertex, a shape at its centre. */}
            {!readOnly && tool === 'pan' && renderAnnos.filter((a) => a.locked && (a.kind === 'shape' || a.kind === 'circle' || ((a.kind === 'draw' || a.kind === 'area') && a.pts?.length))).map((a) => {
              const pts = a.pts ?? []
              const p = a.kind === 'shape' || a.kind === 'circle'
                ? [a.x ?? 0, mapY(a.floor, a.y ?? 0)] as const
                : a.kind === 'area'
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
            {editDraw?.kind === 'draw' && tool === 'pan' && !planEndpointDragState && (['start', 'end'] as const).map((ep) => {
              const rel = ep === 'start' ? editDraw.startAttachment : editDraw.endAttachment
              const pts = renderAnnos.find((a) => a.id === editDraw.id)?.pts ?? editDraw.pts
              if (!rel || !pts || pts.length < 2) return null
              const p = ep === 'start' ? pts[0] : pts[pts.length - 1]
              return (
                <span key={`detach-${ep}`} className="line-detach-chip wb-magnet" role="button"
                  title={appConfig.copy.drawingEditor.detachConnection} aria-label={appConfig.copy.drawingEditor.detachConnection}
                  style={{ left: p[0] * sW + 16, top: mapY(p[2] ?? editDraw.floor, p[1]) * sH - 16 }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); detachPlanEndpoint(ep) }}><Icon id="close" /></span>
              )
            })}

            {/* Every covered floor exposes the same object through the full native renderer. */}
            {annos.filter((a) => a.kind !== 'draw').flatMap((a) => stack ? stackInstances(a, floorsTTB) : [a]).map((a) => (
              <div
                key={`${a.id}:${a.floor ?? 0}`}
                className={`wb-anno wb-${a.kind}${relationship.objectIds.has(a.id) ? ' network' : ''} ${selId === a.id || selIds.includes(a.id) ? 'sel' : ''}`}
                // transform positions the anchor at the (scaled) plan point. SYMBOLS hold a
                // constant screen size (symBase, zoom-independent — 30.08.: they are pins like
                // the map's, and «zoomed in» made them comically dwarf the building); shapes
                // stay sheet-true, text scales with the paper, team pills stay constant.
                // a shape's --gpx (→ halo/handle anchor --hbox) takes the LARGER box side so the
                // selection ring always encloses a stretched rectangle (width × width·aspect)
                // ⚠️ A team chip is a STRIP — [dot][gap][name] — and centring the whole strip put
                // half the NAME's width between the dot and the point it states. It is anchored by
                // its LEFT edge with half a dot taken back (the selected pill takes its accent cap
                // back instead, so selecting doesn't shift it) — the same geometry the Karte's
                // Trupp markers use (MapMarkers · anchor="left" + offset), because a Trupp
                // transferred between the two surfaces must not visibly jump. Everything else
                // stays centred on its glyph.
                // a LOCKED shape is click-through, like a locked drawn Fläche: no tap, no drag,
                // no double-tap — the LockChip (own layer below) is the only door back in
                style={{ left: 0, top: 0, transform: `translate(${(a.x ?? 0) * sW}px, ${mapY(a.floor, a.y ?? 0) * sH}px) translate(${a.kind === 'resource' ? `${selId === a.id ? -TEAM_PILL_CAP_PX : -TEAM_DOT_PX / 2}px` : '-50%'}, -50%)`, ['--gpx' as string]: `${a.kind === 'shape' ? (a.sizeN ?? 0.1) * sW * Math.max(1, shapeAspect(a.shape ?? 'square', a.aspect)) : symBase}px`, ...(a.kind === 'shape' && a.locked ? { pointerEvents: 'none' as const } : null) }}
                onPointerDown={(e) => chipDown(e, a.id, a.floor)}
                // double-tap still opens the on-surface textarea; the panel steps aside so the
                // two editors for one text never stream keystrokes side by side.
                // ⚠️ `!readOnly` mirrors the editors this arms: on a read-only surface the pill
                // renders without `acts`, so `renaming` mounts no input and nothing ever fires
                // the blur that clears `editId` — a viewer's double-tap latched it for the whole
                // mount. The guard is the fix; do NOT mount the editor here instead (its blur
                // would commit a patch from a read-only session).
                onDoubleClick={(e) => { if ((a.kind === 'text' || a.kind === 'resource') && tool === 'pan' && !readOnly) { e.stopPropagation(); setEditId(a.id); setSelId(a.id); if (a.kind === 'text') setNotePanelId(null) } }}
              >
                {relationship.objectIds.has(a.id) && selId !== a.id && <span className="network-halo" />}
                {/* selection halo — the same accent ring the Lage map draws, so a selected
                    symbol/shape reads identically on the plan (teams keep their own team-colour ring) */}
                {/* ⚠️ Symbols only (02.09.): a Form is selected to be worked with its own ends
                    and axes, and a ring around a sheet-sized shape covers the very paper those
                    grips work on. Karte parity — MapMarkers excludes it there too. */}
                {(selId === a.id || selIds.includes(a.id)) && a.kind === 'symbol' && <div className="sel-halo" />}
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
                  const overlay = comp ? { svg: sym.byName[compositePartGlyph(comp, a.extract)] ?? sym.byName[comp.part] ?? '', rotation: a.rotation2 ?? 0, scale: comp.scale, offsetX: comp.offsetX } : undefined
                  // Hubretter boom: variable-reach articulated arm mounted on the turntable (drawn ON
                  // TOP of the body), sized as a fraction of the plan width (reachN), aimed by rotation2.
                  const boomPx = hub ? Math.max(12, (a.reachN ?? 0.12) * sW) : 0
                  return (
                    <>
                      <TacticalSymbol
                        svg={svg}
                        // symBase WITHOUT × scale (30.08.): a plan symbol is a pin with a
                        // constant screen size, exactly like the Lage map's — zooming the sheet
                        // must not balloon it past the building. Twins share the same number.
                        sizePx={symBase}
                        rotation={veh ? 0 : (a.rotation ?? 0)}
                        overlay={overlay}
                        // the signed Stockwerk badge, same slot and same glyph as on the Lage.
                        // `storey`, never `floor` — that one is the stack's tile index.
                        floor={stack ? undefined : a.storey}
                        floorFrom={stack ? undefined : a.floorFrom}
                        floorTo={stack ? undefined : a.floorTo}
                        spread={a.spread}
                        count={a.count}
                        // «Gelöscht / erledigt»: grey glyph + the time — the Karte's rule, on the
                        // Modul sheets and on every Gebäude storey alike
                        done={doneBadge(a)}
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
                    <ShapeGlyph kind={a.shape ?? 'square'} color={a.color ?? DEFAULT_INK} stop={a.stop} aspect={a.aspect} carrier={a.carrier} reverse={a.reverse} strokeW={a.strokeW} boxPx={(a.sizeN ?? 0.1) * sW} fillOpacity={a.fillOpacity} hatch={a.hatch} sharpCorners={a.sharpCorners} />
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
                        {/* the storey, at rest as well as selected (18.09.2026): on a stack the
                            tile says it only to whoever is already looking at that tile */}
                        {stack && <span className="team-floor" title={floorLabel(a.floor ?? 0)}>{floorBadge(a.floor ?? 0)}</span>}
                      </span>
                    )
                  }
                  // the pill AND its action bar are the ONE shared component
                  // (components/TwinTeamPill) — the very same one the Karte's own Trupp marker and
                  // both mirrors wear, so no surface can answer differently for the same Trupp.
                  // The bar only appears while this board may be written on; the anno wrapper
                  // already owns the press, so no `hit` shell is passed.
                  // ⚠️ No Farbe swatch — and since 04.09. none on the SelectionBar either. The
                  // colour is automatic, and the ONE place left to change it is the marker's own
                  // bar on the Karte (the same TwinTeamPill, with `acts.color` passed there and
                  // nowhere else). A plan chip that offered it too would be a second answer to a
                  // question the Lage already owns.
                  return (
                    <TwinTeamPill
                      name={a.text ?? ''} time={a.t} color={teamCol}
                      raus={isRaus} truppId={a.truppId} floor={stack ? a.floor ?? 0 : undefined}
                      trailCount={a.trail?.length ?? 0}
                      trailShown={!hiddenTrails.has(a.id)} trupps={trupps}
                      renameRef={focusOnce}
                      // ⚠️ the rename flag stays OUT here: on this surface a chip also enters
                      // rename by DOUBLE-CLICK on the anno wrapper (the desktop path), which the
                      // pill knows nothing about — so `editId` remains the one source of truth.
                      renaming={editId === a.id} onRenaming={(on) => setEditId(on ? a.id : null)}
                      acts={tool === 'pan' && !readOnly ? {
                        // an empty name keeps the old one — a blank chip is nobody
                        rename: (name) => {
                          // a number somebody else holds is refused, not left for a merge to settle
                          const taken = teamNameTaken
                            ? teamNameTaken(a.id, name)
                            : teamNoTaken(name, annos.filter((x) => x.kind === 'resource' && x.id !== a.id).map((x) => x.text))
                          if (name && name !== a.text && taken) {
                            toast(fillTemplate(appConfig.copy.whiteboard.teamNameTaken, { name }), { icon: 'warn', tone: 'warn' })
                            return
                          }
                          patchCommit(a.id, { text: name || a.text })
                        },
                        pick: onTeamTrupp && ((truppId) => onTeamTrupp(a.id, truppId)),
                        newTrupp: onTeamNewTrupp && (() => onTeamNewTrupp(a.id)),
                        mark: markPosition,
                        clearTrail: () => void clearTrail(),
                        remove: () => void removeWithConnections(a),
                        removeWithTrail: () => void removeWithTrail(a),
                        showTrupp: onShowTrupp,
                        toggleTrail: () => toggleTrail(a.id),
                      } : undefined} />
                  )
                })()}
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
                {/* ⚠️ …and no right-edge width grip on a Textfeld either (05.09., with its Karte
                    twin — MapMarkers). A note sizes itself to what is typed (`noteAutoW`), so the
                    grip only ever un-did that, and it sat where a finger reaches for the note
                    itself. Breite is not a decision the Kroki needs from anybody. */}
                {/* generic shape: its size grips, riding the shape's rotation (identical to the
                    Lage map). The rotate knob left on 02.09. — the SelectionBar's ⟳ is the one
                    way to turn a Form. */}
                {a.kind === 'shape' && selId === a.id && tool === 'pan' && !readOnly && !a.locked && (() => {
                  // CSS anchors the knob/grip off a SQUARE --hbox; a stretched shape overrides
                  // them inline so the knob rides the real top edge and the grip the real
                  // corner (identical to the Lage map — MapMarkers' shape rotor)
                  const hbW = Math.max((a.sizeN ?? 0.1) * sW, 56)
                  const hbH = Math.max((a.sizeN ?? 0.1) * sW * shapeAspect(a.shape ?? 'square', a.aspect), 56)
                  // ── A Rotation is its two ENDS, and nothing else (lib/shapes · SHAPE_TWO_POINT) ──
                  // Each end sets the run's length AND its bearing, and the width follows the run,
                  // so there is no rotate knob and no size grip left to draw. The twin of the Lage
                  // map's pair (MapMarkers), down to the tether that keeps a grip off its own cap.
                  if (SHAPE_TWO_POINT[a.shape ?? 'square']) {
                    const boxW = (a.sizeN ?? SHAPE_DEFS.rotation.defaultSizeN) * sW
                    const boxH = boxW * shapeAspect('rotation', a.aspect)
                    const runPx = Math.max(0, boxW - boxH)
                    const off = rotationGripOffPx(boxH)
                    return (
                      <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                        {([['endA', -1], ['endB', 1]] as const).map(([which, sign]) => (
                          <button key={which} className="handle shape-end"
                            style={{ left: `calc(50% + ${sign * (runPx / 2 + off)}px)`, top: '50%' }}
                            title={appConfig.copy.shapes.endHint} aria-label={appConfig.copy.shapes.endHint} data-holdaction
                            onPointerDown={(e) => rotDown(e, a.id, which)} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp}
                            onClick={(e) => e.stopPropagation()}>
                            <Icon id="resize-h" />
                          </button>
                        ))}
                      </div>
                    )
                  }
                  // no rotate knob on a Form (02.09.) — the bar's ⟳ turns it; see MapMarkers
                  return (
                  <div className="shape-rotor" style={{ transform: `rotate(${a.rotation ?? 0}deg)` }}>
                    {/* ── ONE GRIP PER AXIS on a Rechteck and a Rotation (01.09.) ── the ↔ on the
                        right edge moves the x-axis, the ↕ on the bottom edge the y-axis: each grip
                        stands ON the axis it controls. Identical to the Lage map (MapMarkers); the
                        Rauch keeps the diagonal corner (lib/shapes · SHAPE_AXIS_GRIPS). */}
                    {SHAPE_AXIS_GRIPS[a.shape ?? 'square'] ? <>
                      <button className="handle shape-resize shape-axis-x" style={{ left: `calc(50% + ${hbW / 2 + 3}px)`, top: '50%' }}
                        title={appConfig.copy.shapes.boxWidthHint}
                        aria-label={appConfig.copy.shapes.boxWidthHint} data-holdaction
                        onPointerDown={(e) => rotDown(e, a.id, 'resize')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="resize-h" />
                      </button>
                      <button className="handle shape-width shape-axis-y" style={{ left: '50%', top: `calc(50% + ${hbH / 2 + 3}px)` }}
                        title={appConfig.copy.shapes.boxHeightHint}
                        aria-label={appConfig.copy.shapes.boxHeightHint} data-holdaction
                        onPointerDown={(e) => rotDown(e, a.id, 'sizeY')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="resize-v" />
                      </button>
                    </> : (
                      <button className="handle shape-resize" style={{ left: `calc(50% + ${hbW / 2 + 3}px)`, top: `calc(50% + ${hbH / 2 + 3}px)` }} title={appConfig.copy.shapes.resizeHint} aria-label={appConfig.copy.shapes.resizeHint} data-holdaction
                        onPointerDown={(e) => rotDown(e, a.id, 'resize')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="resize" />
                      </button>
                    )}
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
                      aria-label={appConfig.copy.shapes.rotate} data-holdaction
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
                      <button className="handle shape-rotate" title={appConfig.copy.contextPanel.rotationVehicle} aria-label={appConfig.copy.contextPanel.rotationVehicle} data-holdaction
                        onPointerDown={(e) => rotDown(e, a.id, 'rotate')} onPointerMove={rotMove} onPointerUp={rotUp} onPointerCancel={rotUp} onClick={(e) => e.stopPropagation()}>
                        <Icon id="rotate" />
                      </button>
                    </div>
                    <div className="shape-rotor shape-rotor-fan" style={{ transform: `rotate(${a.rotation2 ?? 0}deg)` }}>
                      <span className="shape-stem" />
                      <button className="handle shape-rotate shape-rotate-fan" title={appConfig.copy.contextPanel[annoComposite(a)!.partLabel]} aria-label={appConfig.copy.contextPanel[annoComposite(a)!.partLabel]} data-holdaction
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
                      <button className="handle shape-cage" title={appConfig.copy.shapes.moveHint} aria-label={appConfig.copy.shapes.moveHint} data-holdaction
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

            {/* Geister-Spuren: the searched area a removed Trupp chip left behind
                (lib/truppTrails). Same breadcrumb dots, in the neutral ink and with no
                timestamp-selection state, because it is a record rather than a Trupp — it is not
                selectable AS one. The label chip is the hit target: one tap offers «Spur
                löschen» with the existing confirm (IncidentWorkspace · deleteGhostTrail). Each
                point is drawn on the storey it was WALKED on (TrailPoint.floor), not on the
                chip's last tile — a Trupp that went up was a floor below a minute ago. */}
            {ghostTrails.map((g) => {
              const pts = g.points ?? []
              const head = pts[pts.length - 1]
              const label = ghostTrailLabel(g, appConfig.copy.whiteboard.team, trupps)
              return (
                <Fragment key={g.id}>
                  {pts.map((p, i) => (
                    <div key={`ghost-${g.id}-${i}`} className="wb-trail-dot wb-ghost-trail-dot"
                      style={{ transform: `translate(${p.x * sW}px, ${mapY(p.floor ?? 0, p.y) * sH}px) translate(-50%, -50%)` }}>
                      <span className="wb-trail-mark" />
                      <i>{p.t}</i>
                    </div>
                  ))}
                  {head && (
                    <button type="button" className="wb-ghost-label"
                      style={{ left: `${head.x * sW}px`, top: `${mapY(head.floor ?? 0, head.y) * sH}px` }}
                      title={fillTemplate(appConfig.copy.whiteboard.ghostTrailHint, { name: label })}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onGhostTrail?.(g.id) }}>
                      <Icon id="footprint" />{label}
                    </button>
                  )}
                </Fragment>
              )
            })}

            {/* the Suche's pins on this sheet (their own layer: over the sheet's objects, under
                every popup) — on a stack each on its storey band, and none on a folded storey */}
            {suchePins.filter((p) => p.point.planId === activeId && p.point.x != null && p.point.y != null
              && (!stack || floorsTTB.includes(p.point.floor ?? 0))).map((p) => (
              <div key={`suche:${p.id}`} className={sucheCss.planPin}
                style={{ left: `${p.point.x! * 100}%`, top: `${(stack ? mapY(p.point.floor ?? 0, p.point.y!) : p.point.y!) * 100}%` }}>
                <SuchePinChip pin={p} onOpen={onSuchePin} />
              </div>
            ))}
            {/* …and while the Suche waits for a position, one clear layer over all of it */}
            {suchePick && <div className="wb-ink wb-suche-pick" style={{ zIndex: 9, cursor: 'crosshair' }} />}

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
            {!georefArmed && live.length > 0 && (
              <PlanLiveLayer
                marks={live}
                byName={sym.byName}
                sW={sW}
                sH={sH}
                // the sheet's own symbol size (symBase): the live feed renders exactly like a
                // symbol somebody placed here — presentation-equivalent, doctrine 30.08.
                sizePx={symBase}
                captionMode={captionMode}
                suppressedCaptions={mapSuppressedCaptions}
                // undefined (not a no-op) on a locked surface, so the mark shows no grab cursor
                // and no drag affordance it would refuse to honour
                onMove={readOnly || tool !== 'pan' ? undefined : moveLiveMark}
              />
            )}
            {/* add a storey above (OG) / below (UG) — attached to the stack itself, just above
                the top floor and below the bottom floor, like a real building section */}
            {stack && !readOnly && !building?.pack && (
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
          {/* the tool's number while a measure node is in the hand — fixed top-centre, where
              nothing moves while it changes; the label under the finger is suppressed above.
              Same class and reasoning as the Lage's readout (11-measure.css). */}
          {measDragNode != null && calibrated && measPath.length >= 2 && (
            <div className="measure-readout" aria-hidden>
              {measMode === 'line' ? fmtDistance(measLenM) : fmtArea(measAreaM2)}
            </div>
          )}
          {readOnly && (!slimRail || isPhone) && (
            <div className="wb-zoom wb-zoom-float" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => zoom(1 / 1.3)} disabled={scale <= MIN_SCALE} title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut}><Icon id="minus" /></button>
              <button onClick={() => zoom(1.3)} disabled={scale >= maxScale} title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn}><Icon id="plus" /></button>
              <button className="wb-fit" onClick={() => applyView(1, { x: 0, y: 0 })} disabled={scale === 1 && pos.x === 0 && pos.y === 0} title={appConfig.copy.nav.fit}>{appConfig.copy.whiteboard.fit}</button>
            </div>
          )}

          {/* the Gebäude's north dial — fixed in the viewport's top-right corner, NOT on the
              paper (PlanCompass). It reads whenever a footprint stack is on screen; where the
              building was auto-rotated and the surface is editable it is also the one door to
              turning it — the same popover the rail footer's compass opens, two doors, one room.
              Rendered AFTER the floating zoom so the chip can step below it (module CSS). */}
          {stack && fpView && (
            <PlanCompass deg={northDeg ?? shownAngle} northUnknown={northDeg == null}
              controls={canOrient && !readOnly ? orientControls : undefined} />
          )}

          {/* ONE bar for every selection this sheet has — the same component, in the same corner
              of the viewport, as on the Karte (components/SelectionBar). It lives OUTSIDE the
              board's pan/zoom transform on purpose: the control that moves the paper's contents
              must not move with the paper. ⟳ is absent on an Absperrkreis, which is a centre and
              a radius and has no angle to turn. */}
          {barActive && (
            <SelectionBar
              onMove={barMove}
              onRotate={barCanRotate ? barRotate : undefined}
              onDone={barDone}
              armed={arm.armed} onArm={arm.toggle}
            />
          )}
          {/* …and the turn is read where it happens, not in the bar's far corner */}
          {(arm.turn ?? barTurn) && (arm.turn
            ? <SelectionTurn cx={arm.turn.cx} cy={arm.turn.cy} px={arm.turn.px} py={arm.turn.py} deg={arm.turn.deg} />
            : <SelectionTurn cx={barTurn!.cx} cy={barTurn!.cy} deg={barTurn!.deg} />)}

        </div>

        {/* on a locked surface the rail can only arm Messen, so the only dock this can render
            there is the Messen one (its ✕ / Strecke↔Fläche / Zurücksetzen — all ephemeral) */}
        {(!readOnly || tool === 'measure') && <WbToolDocks
          tool={tool}
          lineMode={lineMode}
          areaMode={areaMode}
          setAreaMode={setAreaMode}
          draftActive={draftActive}
          setTool={setTool}
          setLineMode={setLineMode}
          onFinish={finishShape}
          onCancelDraft={cancelShape}
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
          // ⚠️ Auswahl and Mehrfach share ONE rail slot (05.09., the same on the Karte): the rail
          // resolves that toggle, so a second tap on the armed Auswahl arrives here as 'lasso'
          // and a tap on the armed Mehrfach as 'pan' — both plain tool switches from here.
          onPick={(id) => {
            // a tool picked puts the Suche's card away — as a tool on the Karte puts Ebenen away
            if (suche?.on) suche.onToggle()
            if (id === 'symbol') { setTool('symbol'); setPaletteOpen(true); return }
            setTool(tool === id ? 'pan' : (id as BoardTool)); setPending(null)
          }}
          footer={
            <>
              {/* ⚠️ NO Ebenen row here (15.09.2026). The map rail's footer opens a panel with
                  the deployment's layers in it; this one opened an empty room — the Plan's twin
                  rows went with the unified object model, and the sheet is lent nothing that can
                  be switched. A word that answers a press with nothing is worse than no word. */}
              {/* «Einpassen» — where the map rail carries its compass / views button: the one
                  control that puts the whole surface back in front of you. */}
              <button className="vrail-nbtn vrail-fit" title={appConfig.copy.nav.fit} aria-label={appConfig.copy.nav.fit} disabled={scale === 1 && pos.x === 0 && pos.y === 0} onClick={() => applyView(1, { x: 0, y: 0 })}><span className="vrail-glyph"><Icon id="cross" /></span><span className="vrail-label">{appConfig.copy.nav.fit}</span></button>
              {/* the Suche — at the END of the plan's bar on a phone (15-mobile · order), under
                  «Einpassen» on the rail: the same door the Karte has beside Ebenen */}
              {suche && <SucheToolButton on={suche.on} count={suche.count} onClick={suche.onToggle} />}
              {/* zoom ±: desktop only (.vrail-zoom is hidden under 1024px) — the plan pinches
                  on every touch form factor, and «Einpassen» above covers the one state that
                  matters. */}
              <button className="vrail-nbtn vrail-zoom" title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut} disabled={scale <= MIN_SCALE} onClick={() => zoom(1 / 1.3)}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomOut}</span></button>
              <button className="vrail-nbtn vrail-zoom" title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn} disabled={scale >= maxScale} onClick={() => zoom(1.3)}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{appConfig.copy.nav.zoomIn}</span></button>
              {/* Gebäude rotation — only on a floor-stack that was auto-rotated. The SAME
                  popover the north dial opens (30.08.): slider + named-angle chips; two doors,
                  one room, one visible control instead of a hidden drag. */}
              {/* not under the lock: `reorientTo` refuses a locked surface, so the slider would
                  preview a turn and snap back on release (the north dial below already gates) */}
              {canOrient && !readOnly && (
                <>
                  <div className="vrail-sep vrail-sep-foot" />
                  <Popover
                    ariaLabel={appConfig.copy.whiteboard.orientMenuTitle}
                    popupClassName="wb-orient-popup"
                    side="left" align="end" zIndex={30}
                    trigger={
                      <button className="vrail-nbtn"
                        title={appConfig.copy.whiteboard.orientMenuTitle}
                        aria-label={appConfig.copy.whiteboard.orientMenuTitle}
                      ><span className="vrail-glyph"><Icon id="compass" /></span><span className="vrail-label">{appConfig.copy.whiteboard.orientMenuTitle}</span></button>
                    }
                  >{orientControls}</Popover>
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
          [{ type: 'close', onClick: () => { setPendingShape(null); setRotStart(null); setTool('pan') } }],
          [{ type: 'glyph', node: <ShapeGlyph kind={pendingShape} color="#fff" aspect={SHAPE_DEFS[pendingShape].defaultAspect} fit /> }],
          // «mehrere nacheinander» has no meaning for a shape laid between two named places
          ...(SHAPE_TWO_POINT[pendingShape] ? [] : [[{ type: 'toggle' as const, icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }]]),
          [{ type: 'info', text: !SHAPE_TWO_POINT[pendingShape] ? appConfig.copy.dockHints.shape
            : rotStart ? appConfig.copy.dockHints.rotationEnd : appConfig.copy.dockHints.rotationStart }],
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
          // On the Gebäude stack the tile seeds BOTH ends of Von/Bis (anno.floor, absent = 0) – the
          // storey vocabulary is the same as on the Karte (15.09.2026); a span set here shows the
          // symbol as copies on every tile it covers.
          entity={{ ...selSymbol, floor: stack ? undefined : selSymbol.storey, ...(stack ? { floorFrom: selSymbol.floorFrom ?? selSymbol.floor ?? 0, floorTo: selSymbol.floorTo ?? selSymbol.floorFrom ?? selSymbol.floor ?? 0 } : {}) }}
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
          // the span («Von/Bis») is the same optional extra on both surfaces – the panel keeps it
          // behind «Über mehrere Geschosse» unless it is set (ContextPanel · showFloorRange)
          onFloorFrom={(f) => patchCommit(selSymbol.id, stack
            ? { floorFrom: f ?? undefined, floorTo: selSymbol.floorTo ?? selSymbol.floor ?? 0 }
            : { storey: undefined, floorFrom: f ?? undefined, floorTo: selSymbol.floorTo ?? selSymbol.storey })}
          onFloorTo={(f) => patchCommit(selSymbol.id, stack
            ? { floorFrom: selSymbol.floorFrom ?? selSymbol.floor ?? 0, floorTo: f ?? undefined }
            : { storey: undefined, floorFrom: selSymbol.floorFrom ?? selSymbol.storey, floorTo: f ?? undefined })}
          onSpread={(s) => patchCommit(selSymbol.id, { spread: s ?? undefined })}
          onCount={(n) => patchCommit(selSymbol.id, { count: n && n > 1 ? n : undefined })}
          onRotate={(deg) => patchCommit(selSymbol.id, { rotation: deg ?? undefined })}
          onRotate2={(deg) => patchCommit(selSymbol.id, { rotation2: deg ?? undefined })}
          onCaption={(m) => patchCommit(selSymbol.id, { caption: m })}
          captionDefault={captionMode}
          onAirflow={(extract) => patchCommit(selSymbol.id, { extract: extract || undefined })}
          // every symbol on a storey tile has storeys – whatever its preset says about the badge
          controls={stack ? new Set([...symbolControls(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat), 'floorRange']) : symbolControls(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
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
          onDone={!readOnly ? (on) => setAnnoDone(selSymbol, on) : undefined}
          doneFirst={doneFirst(selSymbol.symbol, sym.symbols.find((x) => x.name === selSymbol.symbol)?.cat)}
        />
      )}

      {/* note detail panel — the same ContextPanel, opened by the tap that selects the note (see
          notePanelId) and by placing one. The note's TEXT is its title, so the panel's title
          field edits the note itself. */}
      {editorSlotFree && selNote && (
        <ContextPanel
          key={selNote.id}
          entity={{ ...selNote, label: selNote.text, subtitle: appConfig.copy.notes.section }}
          readOnly={readOnly}
          // a note that was just put down opens ready to be written (see notePlacedId)
          autoFocusNote={notePlacedId === selNote.id && !readOnly}
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
          // …each style edit is remembered as the NEXT note's default too («D pur», 09.09.:
          // the Notiz dock carries no style controls any more — this is the stickiness)
          onNoteSize={(s) => {
            patchCommit(selNote.id, selNote.noteAutoW
              ? { noteSize: s, wN: autoNoteWN(selNote.text ?? '', txtBase * scale * noteScale(s), sW) }
              : { noteSize: s })
            setNoteDefaults((d) => ({ ...d, size: s ?? 'm' }))
          }}
          onNotePlain={(p) => { patchCommit(selNote.id, { notePlain: p || undefined }); setNoteDefaults((d) => ({ ...d, plain: p })) }}
          onColor={(c) => { patchCommit(selNote.id, { color: c || undefined }); setNoteDefaults((d) => ({ ...d, color: c })) }}
          onDelete={() => { setNotePanelId(null); void removeWithConnections(selNote) }}
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
          drawing={{ kind: selDraw.kind as 'draw' | 'area' | 'circle', radiusM: selCircleM, color: selDraw.color, width: selDraw.width, dashed: selDraw.dashed, label: selDraw.label, marker: selDraw.marker, arrow: selDraw.arrow, arrowStop: selDraw.arrowStop, showDistance: selDraw.showDistance, fillOpacity: selDraw.fillOpacity, hatch: selDraw.hatch, teilstueck: selDraw.teilstueck, content: selDraw.content, lineNo: selDraw.lineNo, floorTag: stack ? selDraw.floorTag ?? selDraw.floor ?? 0 : selDraw.floorTag, startAttachment: selDraw.startAttachment, endAttachment: selDraw.endAttachment }}
          pointCount={selDraw.pts?.length ?? 0}
          /* the distance toggle appears once the plan is calibrated against its printed scale bar */
          supportsDistance={calibrated}
          /* same Messung section as the Lage, in the plan's calibrated metres — but no
             Höhenprofil: a building plan carries no height data */
          lengthM={selDraw.pts && selDraw.pts.length >= 2 ? planMetres(selDraw.pts.map(([x, y]) => [x, y])) : null}
          /* …and a Fläche measures itself the same way the Lage's does — Fläche + Umfang, in the
             plan's calibrated metres. Without these the Messung section simply never appeared for
             an area on a plan, so a Sektor drawn on Modul 2 could state neither. */
          areaM2={selCircleM != null ? Math.PI * selCircleM ** 2
            : selDraw.kind === 'area' && calibrated && activeScale && (selDraw.pts?.length ?? 0) >= 3
            ? polyAreaM2(selDraw.pts!.map(([x, y]) => [x, y]), activeScale.mPerU, measureAR) : null}
          perimeterM={selCircleM != null ? 2 * Math.PI * selCircleM
            : selDraw.kind === 'area' && (selDraw.pts?.length ?? 0) >= 3
            ? planMetres([...selDraw.pts!, selDraw.pts![0]].map(([x, y]) => [x, y])) : null}
          // …the ground box, measured through `planMetres` like every other plan distance, so the
          // sheet's scale AND its aspect ratio are honoured exactly once (lib/geo · bboxSizeM is
          // the map's twin of this)
          // a circle's box is its bounding square — the diameter each way, exactly as the Karte
          // states it (IncidentWorkspace · the map DrawEditor)
          boxM={selCircleM != null ? { widthM: 2 * selCircleM, heightM: 2 * selCircleM }
            : selDraw.kind === 'area' && calibrated && activeScale && (selDraw.pts?.length ?? 0) >= 3
            ? (() => {
                const xs = selDraw.pts!.map(([x]) => x), ys = selDraw.pts!.map(([, y]) => y)
                const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
                const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
                const widthM = planMetres([[x0, y0], [x1, y0]])
                const heightM = planMetres([[x0, y0], [x0, y1]])
                // planMetres answers null on an uncalibrated sheet; `calibrated` is already
                // checked above, so this only narrows the type
                return widthM == null || heightM == null ? null : { widthM, heightM }
              })()
            : null}
          // …each style edit is also remembered as the NEXT ink's default («D pur», 09.09.:
          // the docks carry no style controls and the preset row is gone — the last line is
          // the template, decoration included)
          onColor={(c) => { patchCommit(selDraw.id, { color: c }); setColor(c) }}
          onWidth={(w) => { patchCommit(selDraw.id, { width: w }); setWidth(w) }}
          onDashed={(d) => { patchCommit(selDraw.id, { dashed: d }); setDashed(d) }}
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
          onMarker={(m) => { patchCommit(selDraw.id, { marker: m || undefined }); setMarker(m) }}
          onArrow={(a) => { patchCommit(selDraw.id, { arrow: a || undefined }); setLineArrow(a) }}
          onEnding={(ending) => void changePlanEnding(ending)}
          onReverse={selDraw.kind === 'draw' ? reverseAnno : undefined}
          onContent={(content) => patchCommit(selDraw.id, { content })}
          onLineNo={(lineNo) => { patchCommit(selDraw.id, { lineNo }); onLineRenumber?.(selDraw.id, lineNo) }}
          // on the stack the line's storey is its tile: stepping it MOVES the line rather than
          // writing a badge (lib/whiteboard · movedToStorey)
          onFloorTag={stack ? (floorTag) => moveLineToStorey(selDraw.id, floorTag) : (floorTag) => patchCommit(selDraw.id, { floorTag })}
          onTrupp={onLinkLineTrupp ? (truppId) => onLinkLineTrupp(selDraw.id, truppId) : undefined}
          trupps={trupps.filter((t) => t.status !== 'raus').map((t) => ({ id: t.id, name: t.name }))}
          usedLineNos={annos.filter((a) => a.kind === 'draw' && a.id !== selDraw.id && a.lineNo != null).map((a) => a.lineNo!)}
          truppOnLine={truppForLine(selDraw, trupps)?.name}
          truppOnLineOut={truppIsOut(truppForLine(selDraw, trupps))}
          onShowTrupp={onShowTrupp && truppForLine(selDraw, trupps) ? () => onShowTrupp(truppForLine(selDraw, trupps)!.id) : undefined}
          onShowDistance={(showDistance) => patchCommit(selDraw.id, { showDistance: showDistance || undefined })}
          // metres in, plan-width fraction out — the stepper only exists on a calibrated sheet
          onRadius={(radiusM) => {
            if (!activeScale) return
            const n = circleRadiusN(radiusM, activeScale.mPerU, measureAR)
            if (n != null) patchCommit(selDraw.id, { radiusN: Math.max(appConfig.drawing.circleMinRadiusN, Math.min(CIRCLE_MAX_N, n)) })
          }}
          onHatch={(hatch, fillOpacity) => patchCommit(selDraw.id, { hatch: hatch || undefined, fillOpacity })}
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
          onScale={(f) => patchCommit(selShape.id, { sizeN: Math.max(SHAPE_MIN_N, Math.min(SHAPE_MAX_N[selShape.shape ?? 'square'], (selShape.sizeN ?? SHAPE_DEFS[selShape.shape ?? 'square'].defaultSizeN) * f)) })}
          // A Rotation has one size and it is the RUN between its two ends; the loop's width
          // follows from it. Same rebuild as the Lage map, in plan-width fractions — the buttons
          // are the two ends' gesture in fixed steps (lib/shapes · rotationBox).
          onScaleLength={(f) => {
            const run = rotationRun(selShape.sizeN ?? SHAPE_DEFS.rotation.defaultSizeN, selShape.aspect)
            const box = rotationBox(Math.max(SHAPE_MIN_N, Math.min(rotN.maxN, run * f)), rotN.w)
            patchCommit(selShape.id, { sizeN: box.size, aspect: Math.round(box.aspect * 1000) / 1000 })
          }}
          onStop={(v) => patchCommit(selShape.id, { stop: v })}
          onCarrier={(v) => patchCommit(selShape.id, { carrier: v })}
          onReverse={() => patchCommit(selShape.id, { reverse: !selShape.reverse || undefined })}
          onStrokeW={(w) => patchCommit(selShape.id, { strokeW: w })}
          onFill={(fillOpacity, hatch) => patchCommit(selShape.id, { fillOpacity, hatch: hatch || undefined })}
          onCorners={(sharp) => patchCommit(selShape.id, { sharpCorners: sharp || undefined })}
          // locking DESELECTS (same as a locked Fläche): the ink goes click-through and the
          // LockChip becomes the only door back in
          onToggleLock={() => { patchCommit(selShape.id, { locked: !selShape.locked || undefined }); if (!selShape.locked) setSelId(null) }}
          locked={selShape.locked}
          onDelete={() => void removeWithConnections(selShape)}
          onClose={() => setSelId(null)}
        />
      )}

      {paletteOpen && sym.ready && (
        <Palette sym={sym} onPick={pickSymbol} onPickShape={pickShape}
          // PHONE: the draw tools, the Notiz and the Trupp are the sheet's first section there —
          // the same five the Karte's sheet carries (lib/toolFold), by the plan's own ids
          tools={planTools} onPickTool={(id) => { setPaletteOpen(false); setTool(id as BoardTool); setPending(null) }}
          onClose={() => { setPaletteOpen(false); if (!pending && !pendingShape) setTool('pan') }} />
      )}

      {truppPick && (
        /* ⚠️ Modal → lib/overlays (focus trap + restore, scroll-lock, Esc, backdrop dismissal).
           The hand-rolled scrim it replaces had none of those, and the board's own Escape handler
           fired underneath it. The AGENTS.md carve-out is for the NON-modal tool docks. */
        <Overlay open onClose={() => setTruppPick(null)} className="wb-trupp-pick ui-dialog" ariaLabel={appConfig.copy.whiteboard.selectTrupp}>
          <div className="wb-trupp-pick-head">{appConfig.copy.whiteboard.selectTrupp}</div>
          {/* twin of the Lage picker (IncidentWorkspace): a Trupp already on THIS plan is
              greyed out, because picking it would move its chip rather than add one. One on
              the map or another plan stays selectable — that is a real move.
              ⚠️ …and one that is OUT is offered too (05.09.), for the reason the Lage's twin
              spells out: the crew at the vehicle is exactly the one whose place gets asked
              about. It says «Draussen» rather than being withheld. */}
          {trupps.map((t) => {
            const here = !!t.annoId && t.planId === activeId
            return (
              <button
                key={t.id} className={`wb-trupp-opt${here ? ' placed' : ''}`} disabled={here}
                onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor, t); setTruppPick(null) }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {/* «AS» — this crew is under Presslufatmer. Both lists mix Atemschutz-Trupps and
                    work squads, and the difference matters before the chip lands. Quiet blue: a
                    fact about the Trupp, never the board's amber/red (a clock running out). */}
                {isAtemschutzTrupp(t) && <span className="wb-trupp-as" title={appConfig.copy.atemschutz.kindAtemschutz}>{appConfig.copy.atemschutz.asMark}</span>}
                {here
                  ? <i>{appConfig.copy.whiteboard.truppPlacedHere}</i>
                  : t.status === 'raus' ? <i>{appConfig.copy.atemschutz.status.raus}</i>
                  : (t.lineNo != null || t.lineNumber) ? <i>Ltg {t.lineNo ?? t.lineNumber}</i> : null}
              </button>
            )
          })}
          <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeTeamChip(truppPick.x, truppPick.y, truppPick.floor); setTruppPick(null) }}>
            <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
          </button>
        </Overlay>
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
          hint={readOnly ? appConfig.copy.whiteboard.scale.needsCalibrationViewer : appConfig.copy.whiteboard.scale.needsCalibration}
          // «Als Linie/Fläche übernehmen»: the measured nodes become a real Linie resp. Fläche on
          // this plan. Board coords are whole-board normalized, so each point is folded back into
          // its storey tile (the space every stored `pts` lives in) before addLine/addArea sees it.
          // Unreachable while the plan is uncalibrated — the panel then shows the hint, not the
          // readout, so neither adopt button is rendered.
          onAdopt={!readOnly && measPath.length >= (measMode === 'line' ? 2 : 3)
            ? () => {
                // a Linie keeps the storey under each node; a Fläche lives on ONE storey — its
                // first point's — exactly like the node tool, which pins every vertex of a ring
                // to the floor it was started on.
                const floorOf = (y: number) => (stack ? floorAt(y) : draftFloor.current)
                const ringFloor = floorOf(measPath[0][1])
                const pts: BoardPoint[] = measPath.map(([x, y]) => {
                  const f = measMode === 'line' ? floorOf(y) : ringFloor
                  return [x, localY(y, f), f]
                })
                measReset()
                if (measMode === 'line') addLine(pts)
                else addArea(pts)
              }
            : undefined}
          // ⚠️ NOT offered on an automatically referenced sheet. `scaleAuto` means the metres come
          // from the Kartenverknüpfung, and the same rule the Massstab chip follows holds here:
          // an automatic scale is a READING, never a shortcut into a second, competing manual
          // calibration. «Neu kalibrieren» under a plan that is already tied to the map read as
          // «this is not calibrated» — the opposite of the truth. The reading takes its place.
          onCalibrate={readOnly || scaleAuto ? undefined : () => setTool('scale')}
          calibrateLabel={appConfig.copy.whiteboard.scale.calibrate}
          recalibrateLabel={appConfig.copy.whiteboard.scale.recalibrate}
          /* …and it names the RIGHT source. Same discriminator as the Massstab chip below: only a
             georef fit comes «aus der Kartenverknüpfung» — the Gebäude's scale comes from its
             Grundriss, and the panel used to tell the operator about a link the stack has not got. */
          scaleNote={scaleAuto
            ? georefFit || packMPerU ? appConfig.copy.whiteboard.scale.chipAutoHint : appConfig.copy.whiteboard.scale.chipAutoStackHint
            : undefined}
        />
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
      {!georefArmed && nearbyBanner}
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
          ⚠️ On a LOCKED surface (el, Führungsansicht, viewer, replay) this chip and «⌖ Karte» are
          READ-OUTS (25.09.2026, 3am test + review of #232): the same words and the same tone, and
          no tap — «Ref. auto» used to open the Passung with «Punkt hinzufügen / Übertragen /
          Zurücksetzen» live for an `el` whose save 403s. They are not hidden, because what they
          say is load-bearing: an unchecked automatic fit must never look like a checked one (the
          «ungemessen» / amber rules above), and a locked device reads the plan too. Disabled in
          the `.wb-object:disabled` recipe — not greyed. An Einsatz-Link viewer (linkViewer) gets
          neither: the chips are the origin's instruments. */}
      {(!readOnly || slimRail) && !osm && !blank && !linkViewer && (
        scaleAuto
          /* Still a reading, not a second calibration path – but a TAPPABLE one (29.08.): the
             hover title never fires on the field iPad, so the chip explains itself the same
             way as «Verknüpft» beside it – by opening the Passung, where the derived scale,
             the pair count and the residual sit next to what to do about them.
             ⚠️ Only a GEOREF-derived scale has a Passung to open. The Gebäude's scale (A7) is
             derived from geometry alone — no pairs, no residual — so there the tap says its
             hint as a toast instead of arming a panel that would come up empty. */
          ? <button className="wb-scale-chip wb-scale-status wb-lamped on"
              title={georefFit || packMPerU ? appConfig.copy.whiteboard.scale.chipAutoHint : appConfig.copy.whiteboard.scale.chipAutoStackHint}
              aria-label={appConfig.copy.whiteboard.scale.chipAuto}
              aria-expanded={georefFit && !readOnly ? georefQuality : undefined}
              disabled={readOnly}
              onClick={() => georefFit
                ? setQualityFor(georefQuality ? null : activeId)
                : toast(packMPerU ? appConfig.copy.whiteboard.scale.chipAutoHint : appConfig.copy.whiteboard.scale.chipAutoStackHint)}>
              <Icon id="measure" />
              <span>{appConfig.copy.whiteboard.scale.chipAuto}</span>
              <span className="wb-lamp" data-tone={scaleTone} aria-hidden="true" />
            </button>
          : (() => {
              const label = tool === 'scale' ? appConfig.copy.whiteboard.scale.calibrateHint
                : scaleStale ? appConfig.copy.whiteboard.scale.stale
                : calibrated ? fillTemplate(appConfig.copy.whiteboard.scale.chipCalibrated, { m: String(activeScale!.refM) })
                : appConfig.copy.whiteboard.scale.chipUncalibrated
              return <button
                className={`wb-scale-chip wb-lamped ${calibrated ? 'on' : ''} ${scaleStale ? 'stale' : ''} ${tool === 'scale' ? 'arm' : ''}`}
                title={readOnly ? undefined : appConfig.copy.whiteboard.scale.recalibrate}
                aria-label={label}
                disabled={readOnly}
                onClick={() => setTool(tool === 'scale' ? 'pan' : 'scale')}
              >
                <Icon id="measure" />
                <span>{label}</span>
                <span className="wb-lamp" data-tone={scaleTone} aria-hidden="true" />
              </button>
            })()
      )}
      {/* «⌖ Karte» — the third fact about a plan that no page of it states: whether this sheet is
          tied to the world, and how well. Same recipe and same corner as the Massstab beside it,
          and the same rule: never a hidden assumption. Blue, like Messen and Massstab — a
          georeference is not an alarm, so never the station's --accent.
          A locked session sees the linked reading as a read-out (tone intact, no tap — see the
          Maßstab chip above); a plan with no reference offers the verb, to editors only. An
          Einsatz-Link viewer sees neither. */}
      {canGeoref && (!readOnly || georefState.kind === 'linked') && !linkViewer && (
        <button
          className={`wb-scale-chip wb-lamped ${georefState.kind === 'linked' ? (georefState.warn ? 'wb-georef-warn' : 'wb-georef-ok') : ''} ${georefQuality ? 'arm' : ''}`}
          title={readOnly ? undefined
            : georefState.kind === 'linked' ? appConfig.copy.whiteboard.georef.openQuality
            : appConfig.copy.whiteboard.georef.linkTitle}
          aria-label={georefState.kind === 'linked'
            ? appConfig.copy.whiteboard.georef.chipLinked
            : appConfig.copy.whiteboard.georef.chipUnlinked}
          disabled={readOnly}
          aria-expanded={georefState.kind === 'linked' && !readOnly ? georefQuality : undefined}
          onClick={() => {
            // linked ⇒ the chip opens the Passung; unlinked ⇒ the chooser when the matcher can
            // be asked, else the pairing straight away. A plan that has no reference has nothing
            // to show, so the reading would be an empty panel where the verb belongs.
            if (georefState.kind === 'linked') setQualityFor(georefQuality ? null : activeId)
            else if (canAutoAlign) setLinkChoice((v) => !v)
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
          {/* …and the tone as a LAMP as well as a text colour (18.09.2026). On a phone this pill
              is icon + lamp and nothing else, so the dot has to carry the reading the words used
              to — red: no reference · amber: a fit nobody has checked · green: measured or
              station-approved. One source for the three tones (georefMode · georefChipTone). */}
          <span className="wb-lamp" data-tone={georefChipTone(georefState)} aria-hidden="true" />
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
      {georefQuality && georefFit && !georefArmed && !readOnly && (
        <div className="wb-georef-dock" role="group" aria-label={appConfig.copy.whiteboard.georef.qualityTitle}>
          <GeorefQuality
            fit={georefFit}
            auto={hasAutoPairs(georefPairs)}
            approved={georefApproved}
            realPoints={realPairCount(georefPairs)}
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

      {/* the unlinked chip's chooser — «Automatisch ausrichten» / «Punkte selbst setzen». Same
          dock (and the same stay-live rule) as the Passung above; only offered when the matcher
          can actually be asked (canAutoAlign), else the chip arms the point flow directly. */}
      {linkChoice && !georefArmed && georefState.kind !== 'linked' && !readOnly && (
        <div className="wb-georef-dock" role="group" aria-label={appConfig.copy.whiteboard.georef.linkTitle}>
          <GeorefLinkChooser
            busyStep={autoStep}
            onAuto={() => void runAutoAlign()}
            onManual={() => { setLinkChoice(false); beginGeoref() }}
            onClose={() => { autoRunRef.current++; setAutoStep(null); setLinkChoice(false) }}
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
