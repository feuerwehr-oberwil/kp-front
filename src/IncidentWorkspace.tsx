import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type SetStateAction } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import './app.css'
import { IconSprite, Icon } from './lib/icons'
import { motionDuration, prefersReducedMotion } from './lib/reducedMotion'
import { useSymbols } from './lib/useSymbols'
import { vehicleSymbolSvg } from './lib/useVehiclePositions'
import { useVehicleLayer } from './lib/useVehicleLayer'
import { useVehiclePresenceLog } from './lib/useVehiclePresenceLog'
import { usePersonPositions } from './lib/usePersonPositions'
import { useShareMyPosition } from './lib/useShareMyPosition'
import { useViewportPan } from './lib/useViewportPan'
import { useScrollFocusIntoView } from './lib/useScrollFocusIntoView'
import { SharePositionPill, SharePositionSheet } from './components/SharePosition'
import { autoActivateLayers, defaultLayers, deriveInitial, sanitizeWorkspace, WORKSPACE_SCHEMA_VERSION, type Doc, type ReportMeta, type Saved, type WorkspaceGate } from './lib/workspace'
import { sheetAnchoredIds, viewsOf, withOwnAnnos, type PlanFit } from './lib/tacticalObjects'
import { saveLayerPrefs } from './lib/layerPrefs'
import { useReplay } from './lib/useReplay'
import { resolveHotkey, isTypingTarget } from './lib/hotkeys'
import { routeHotkey } from './lib/hotkeyRoute'
import { moduleNumbers, navStops } from './lib/navRail'
import { incident as demoIncident, planDocuments, gebaeudeDoc, preparedOverlays } from './data/demoIncident'
import { ergRingOverlays } from './lib/ergRings'
import { useHazardData } from './lib/useHazardData'
import { carryDocked, dockRadiusFor, isDockable, isPlacard, nearestDockHost } from './lib/docking'
import type { BoardAnno, CameraView, Drawing, Entity, Incident, LayerDef, LayerId, LineAttachment, LineEndpoint, LngLat, MittelEntry, Person, ReactivateResult, ShapeKind, Shift, ShiftBand, SucheDoc, TimelineEvent, Trupp, TruppFields, BuildingDoc } from './types'
import { appConfig } from './config/appConfig'
import { clearAllDrafts } from './lib/draftKeep'
import { newId, newRowId } from './lib/ids'
import { atemschutzDoctrine, getDeploymentConfig, deploymentDefaultCenter, isDemoMode, sucheUebergabe } from './lib/deploymentConfig'
import { countSurface } from './lib/visitBeacon'
import { fillTemplate, fmtFileSize, formatSymbolName, formatTime } from './lib/format'
import { formatAudioDuration } from './lib/audioImport'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys, VEHICLE_SYMBOLS } from './lib/symbols'
import { bboxSizeM, bearingDeg, circlePolygon, fmtLV95, fmtWGS, haversineM, midCoord, pathLengthM, polygonAreaM2 } from './lib/geo'
import { intervalsOf, isPresent, openPresence } from './lib/attendanceIntervals'
import { mergeRoleNote, personStatusHint, roleConflictHint, rosterFieldRole, truppRoleNote, unrecordedCrewNames, type AssignableRole } from './lib/roleAssignment'
import { useShiftActions } from './lib/useShiftActions'
import { useBandActions } from './lib/useBandActions'
import { editorPrintTransport, fetchPrintStatus, type PrintRelayStatus } from './lib/printRelay'
import { trackPrintJob } from './lib/printJobToast'
import { buildZeitplanPayload, downloadZeitplanPdf, printZeitplan, type ZeitplanSheet } from './lib/zeitplanPrint'
import { lineLabel } from './lib/lineDecor'
import { conflictResolvedRow, type OpenConflict } from './lib/attendanceConflict'
import { isBottomSheet, nudgePointIntoRect, nudgeSelectionIntoRect, rectCenter, visibleWorkRect, type NudgeBox } from './lib/panelNudge'
import { cartoRasterTiles } from './lib/carto'
import { useMeasure } from './lib/useMeasure'
import { useCoordPicker } from './lib/useCoordPicker'
import { useVoiceMemo } from './lib/useVoiceMemo'
import { useObjectStore } from './lib/useObjectStore'
import { useGpsFollow } from './lib/useGpsFollow'
import { useUndoTimeline } from './lib/useUndoTimeline'
import type { UndoDomain } from './lib/undoTimeline'
import { clearUndoCaption, flashUndoCaption } from './lib/undoFlash'
import { useUndoableSlice, type UndoableSlice } from './lib/useUndoableSlice'
import { pushSliceStep } from './lib/sliceUndoStep'
import { foldsIntoPrevious, keepMachineFields, reportStep as reportStepOf } from './lib/reportUndo'
import { useJournal } from './lib/useJournal'
import { useWakeLock } from './lib/useWakeLock'
import { toast, confirmDialog, undoToast } from './lib/ui'
import { confirmLogout } from './lib/logoutConfirm'
import { Overlay } from './lib/overlays'
import { apiDelete } from './lib/api'
import { initialMode, loadPrefs, planSymbolScale, savePrefs } from './lib/prefs'
import { useAttendanceActions } from './lib/useAttendanceActions'
import { changedAttendanceNames } from './lib/attendanceDiff'
import { useMittelActions } from './lib/useMittelActions'
import { useChecklistActions } from './lib/useChecklistActions'
import { useTeamMarkerActions } from './lib/useTeamMarkerActions'
import { useDevicePrefs } from './lib/useDevicePrefs'
import { useSheets } from './lib/useSheets'
import { useAtemschutzMute } from './lib/useAtemschutzMute'
import { useTacticalSelection } from './lib/useTacticalSelection'
import { useWorkspaceDoc } from './lib/useWorkspaceDoc'
import { addPlanBindings, fillBindingFloors, hasLegacyAlignmentContext } from './lib/incidentPlanBindings'
import { useIncidentPlanBindings } from './lib/useIncidentPlanBindings'
import { buildLabel } from './lib/buildInfo'
import { consumeJustUpdated } from './lib/swUpdate'
import { useIsPhone, useMediaQuery } from './lib/useIsPhone'
import { useOnline } from './lib/useOnline'
import { onReachable } from './lib/connectivity'
import { MapView } from './components/MapView'
import { Splash } from './components/Splash'
import { TopBar, WeatherBadge } from './components/TopBar'
import { NavRail } from './components/NavRail'
import { MapUtility } from './components/MapUtility'
import { MapViewsButton, type ViewsApi } from './components/MapViewsMenu'
import { LayerPanel } from './components/LayerPanel'
import { planRasterRows, twinVisible, isTwinLayerId } from './lib/georefTwins'
import { ToolRail } from './components/ToolRail'
import { slimTools, isMapReadOnlyTool, MAP_READONLY_TOOLS } from './lib/readOnlyTools'
import { Palette } from './components/Palette'
import { ContextPanel } from './components/ContextPanel'
import { DrawEditor } from './components/DrawEditor'
import { ToolDock } from './components/ToolDock'
import { ShapeEditor } from './components/ShapeEditor'
import { MeasurePanel } from './components/MeasurePanel'
import { ROTATION_DEFAULT_RUN_M, ROTATION_MAX_M, ROTATION_W_M, SHAPE_DEFS, SHAPE_MAX_M, SHAPE_MIN_M, SHAPE_TWO_POINT, ShapeGlyph, rotationBox, rotationRun, shapeAspect } from './lib/shapes'
import { Journal } from './components/Journal'
import { JournalComposer, type JournalDraft } from './components/JournalComposer'
import { composeJournalText } from './lib/journalEntry'
import { journalVocabulary } from './lib/journalLinks'
import { AudioPlayerSheet } from './components/AudioPlayerSheet'
import { ReminderBanner } from './components/ReminderBanner'
import { AtemschutzAlarmMeldungen } from './components/AtemschutzAlarmMeldung'
import { UpdateBanner } from './components/UpdateBanner'
import { OfflineMeldung } from './components/OfflineMeldung'
import { InstallBanner } from './components/InstallBanner'
import { InstallGuide } from './components/InstallGuide'
import { getInstallPlatform, isStandalone } from './lib/installPrompt'
import { isStorageDegraded } from './lib/idb'
import { installOffered } from './lib/installPolicy'
import { claimBootNotifyTarget } from './lib/notifyTarget'
import { TabLockBanner } from './components/TabLockBanner'
import { GpsFollowMeldung } from './components/GpsFollowMeldung'
import { SurfaceBoundary } from './components/SurfaceBoundary'
import { SymbolsFailedMeldung } from './components/SymbolsFailedMeldung'
import { NoBasemapMeldung } from './components/NoBasemapMeldung'
import { RemindersHost, useReminders } from './lib/useReminders'
import { useRenderStorm } from './lib/useRenderStorm'
import { useMediaQueue } from './lib/useMediaQueue'
import { AtemschutzAlarmHost } from './lib/useAtemschutzAlarm'
import { isAtemschutzTrupp, type AtemschutzAlarmState } from './lib/atemschutz'
import { ensureNotifyPermission } from './lib/alarm'
import { bareText } from './lib/reminders'
import { GeorefModeBars } from './components/GeorefMode'
import { georefDispatch, setGeorefOpenDroppedHandler, useGeorefMode, useGeorefSurfaceBridge } from './lib/georefMode'
import type { BoardHistory } from './components/useBoardDoc'
import type { BoardViews } from './components/useBoardView'
import { ReplayBar } from './components/ReplayBar'
import { FabEntry } from './components/FabEntry'
import { prewarmPlans } from './components/PdfViewport'
import { prefetchOutlines } from './components/OsmOutline'
import { buildView } from './lib/footprint'
import { amendBuilding } from './lib/buildingTransfer'
import { removeStorey, withoutOwnOnStorey } from './lib/stackFloors'
import { askStoreyRemoval } from './lib/storeyRemoval'
import { floorPackOf, packFloorNames, packStoreys } from './lib/floorPackBinding'
import { floorLabel } from './lib/whiteboard'
import { isAtemschutzLinkKind, useAuth } from './lib/auth'
import {
  WorkspaceSync, uploadMedia,
  type IncidentMeta,
  isIncidentRunning,
} from './lib/incidents'
import { useAuditEvents } from './lib/useAuditEvents'
import { eventScopeFor } from './lib/eventScope'
import { combinedSyncStatus } from './lib/combinedSyncStatus'
import { downloadBlob } from './lib/download'
import { JournalDeliveryNotice } from './components/JournalDeliveryNotice'
import { useMapDrawing } from './lib/useMapDrawing'
import { applyRouting, moveLineBody, resolveMapDrawings } from './lib/lineAttachments'
import { duplicateDrawing, duplicateEntity } from './lib/duplicate'
import { centroid, rotateAround, turnedBy } from './lib/selectionTransform'
import { leitungOptions, lineTakesTrupp, truppForLine, truppIsOut } from './lib/truppLines'
import { useIncidentSync } from './lib/useIncidentSync'
import { useTruppActions, LAGE_TARGET } from './lib/useTruppActions'
import { useObjectPlans, isSelectOnlySurface, railPlanTiles, BUILDING_PICK_ID } from './lib/useObjectPlans'
import { PlanPicker } from './components/PlanPicker'
import { FeedbackSheet, IncidentSwitcher, ReviewBanner, SettingsSheet, OfflineReadinessSheet, ShareIncidentSheet } from './components/panels'
import { fetchShareLink } from './lib/viewLink'
import { HelpOverlay } from './components/HelpOverlay'
import { useWeather } from './lib/useWeather'
import { fillTileTemplate, predownloadArea, tilesForBounds } from './lib/offlineTiles'
import { WARM_BYTES, estimateStorage, fittedTileCap, prefetchFit } from './lib/storageBudget'
import { ChecklistsView } from './components/ChecklistsView'
import { AtemschutzView, type TruppOrder } from './components/AtemschutzView'
import { AnwesenheitView } from './components/AnwesenheitView'
import { MittelView } from './components/MittelView'
import { usePersonnel } from './lib/usePersonnel'
import { assignedPersonIds, canonicalName, linkTrupps, personIdForName, rosterIdByName as rosterIdByNameOf, truppByPersonId } from './lib/personnel'
import { rosterWithGuests } from './lib/guests'
import type { ChecklistState, Item } from './lib/checklists'
import { warmTemplates } from './lib/checklists'
import { primeKeyboard } from './lib/keyboardPrime'
import { flushSync } from 'react-dom'
import type { NoteSize } from './types'
import { initialRapportPage, isRapportPage, writeRapportPage } from './lib/rapportPages'
import { TruppFinder } from './components/TruppFinder'
import { markerOptions, markerSite, placedTrupps, type PlacedTrupp } from './lib/placedTrupps'
import { serverNowIso } from './lib/serverClock'
import { useGhostTrails } from './lib/useGhostTrails'
import { ghostRevival, ghostTrailLabel, mapGhostTrails, planGhostTrails, removeGhostTrail, restoreGhostTrail, trailPointCount, trailSources } from './lib/truppTrails'
import { annotatedPlans, changedReportMetaLines, normalizeReportMeta } from './lib/report'
import { useAbschluss } from './lib/useAbschluss'
import { useRowMediaUpload } from './lib/useRowMediaUpload'
import { useGeorefFits } from './lib/useGeorefFits'
import { createEditSettle, entityEditChanges, entityLogName, rosterFieldsToRefile, type EditSettle } from './lib/entityEdit'
import { drawingLogName } from './lib/drawingEdit'
import { mittelLineCount } from './lib/mittel'
import { SUCHE_DOCK_INSET, bereichStatusOf, emptySuche, keepSucheSeeds, movedRows, openBereiche, personenViews, rowOwner, sanitizeSuche, storeyBadges, sucheGroups, vermisstCount, type TruppHere } from './lib/suche'
import { SucheDock, SuchePhoneSheet } from './components/suche/SucheSurface'
import type { FundPreset, SucheTab } from './components/suche/SuchePanel'
import { useSucheTrupps } from './lib/useSucheTrupps'
import type { Detent } from './lib/overlays'
import { useSucheActions, type SucheActions } from './lib/useSucheActions'
import type { SucheComposerLink } from './components/JournalComposer'
import { autoNoteWPx } from './lib/notes'
import { mintLocalThumb } from './lib/mediaUrl'
import { whenIdle } from './lib/idle'

const prefs = loadPrefs()

/* Two single-mode surfaces are their OWN chunks (perf sweep 23.09.2026): the Plan (Whiteboard,
 * ~140 KB minified) and the Rapport (ReportPreflight + the Kroki framing panel, ~65 KB) sat in
 * the field app's chunk, parsed on every boot — on the Karte, the Atemschutz-Tafel and a link
 * phone alike. (GeorefMode cannot follow them: GeorefMapLayer, which the Karte mounts, needs it.) They are fetched on IDLE right after the workspace mounts (see the prefetch
 * effect), so by the time anyone switches mode the chunk is already here and the switch is as
 * instant as it was; offline they come out of the precache like every other chunk.
 * ⚠️ Nothing alarm-critical is lazy: the Atemschutz-Tafel, the alarm banner and the sync status
 * stay in the eager chunk — a surface that may be needed at 3am must never show a gap first. */
const loadWhiteboard = () => import('./components/Whiteboard')
const Whiteboard = lazy(() => loadWhiteboard().then((m) => ({ default: m.Whiteboard })))
const loadReportPreflight = () => import('./components/ReportPreflight')
const ReportPreflight = lazy(() => loadReportPreflight().then((m) => ({ default: m.ReportPreflight })))
/** «Open the Rapport ON this Mindestangabe» (ReportPreflight · requestReportStep), through the
 *  lazy module: the ask queues there until the sheet mounts, exactly as it did when static. */
const requestReportStep = (step: Parameters<typeof import('./components/ReportPreflight').requestReportStep>[0]) => {
  void loadReportPreflight().then((m) => m.requestReportStep(step))
}

/**
 * Let a drawing go from an object that is disappearing off the Karte, pinning the endpoint where
 * the object stood so the drawn line does not jump.
 *
 * An object leaves the map by two doors — «Löschen» and «Hierher übertragen» (onto a Modul) — and
 * both owe every Leitung anchored to it the same courtesy. Only deletion used to do it; the
 * transfer filtered the entity out and left the attachments pointing at an id that no longer
 * existed, so «Verbunden mit» printed the raw id and trace-routing quietly stopped working. One
 * helper, so the two doors cannot drift apart again.
 *
 * Returns the drawing unchanged when nothing is attached to `ent` — safe to `.map()` over the
 * whole list.
 */
function detachDrawingFrom(dr: Drawing, ent: Entity): Drawing {
  let next = dr
  for (const endpoint of ['start', 'end'] as const) {
    const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
    if (a?.target.kind !== 'object' || a.target.id !== ent.id || next.coords.length < 2) continue
    const coords = next.coords.map((p, i) => (i === (endpoint === 'start' ? 0 : next.coords.length - 1) ? ent.coord : p))
    next = { ...next, coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
  }
  return next
}

/** How long an edit has to sit still before it earns a Verlauf row. Long enough that a sentence
 *  being typed is ONE edit, short enough that reading the Verlauf a moment later already shows
 *  it. Shared by the Rapportangaben logger and the Kroki symbol-edit logger — both write on
 *  every keystroke, and both would otherwise produce one row per character. */
const META_LOG_SETTLE_MS = 4000

/** Is the caret in a free-text Rapportangabe right now? Read off the `[data-sync]` markers the
 *  ReportPreflight puts on every synced field (its own focus bookkeeping runs on the same
 *  attribute). Free-TEXT only: a settle window held open by a focused Stepper button or a
 *  datetime input would never close — those keep the plain 4 s fallback (decided 29.08.). */
function isTypingMetaField(): boolean {
  const el = focusedElement()
  return !!el?.closest?.('[data-sync]') && isFreeText(el)
}

/** …and the same question for a symbol's own editor: the ContextPanel marks its free-text blocks
 *  with `data-entity-edit`. Its Notiz field commits on BLUR, and on a tablet one sentence gets
 *  blurred and picked up again three times — which is how «Notiz «1 Roller in en»», «…in ennen»
 *  and «…innen» reached the 03.09. Rapport as three rows. While the caret is back in one of those
 *  fields the Verlauf row waits (lib/entityEdit · createEditSettle). */
function isTypingSymbolField(): boolean {
  const el = focusedElement()
  return !!el?.closest?.('[data-entity-edit]') && isFreeText(el)
}

const focusedElement = (): HTMLElement | null =>
  typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)

/** Free TEXT only: a window held open by a focused Stepper button or a datetime input would never
 *  close — those keep the plain settle (decided 29.08.). */
function isFreeText(el: HTMLElement): boolean {
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  return el.tagName === 'INPUT' && ['text', 'tel', 'search', 'email'].includes((el as HTMLInputElement).type)
}
// The manually-picked Einsatzobjekt moved from this device cookie into the synced workspace blob
// (per incident). Keep the value in-memory so deriveInitial can import it once this session, then
// clear the legacy cookie field so a later reset can't be resurrected from a stale cookie.
if (prefs.pickedObject) savePrefs({ ...loadPrefs(), pickedObject: undefined })

interface WorkspaceProps {
  incidentMeta: IncidentMeta
  incidents: IncidentMeta[]
  workspace: Saved | null
  sync: WorkspaceSync
  forceReadOnly: boolean
  /** another tab of THIS browser is editing the incident → read-only here + take-over banner */
  tabLockLost: boolean
  onTakeOverTab: () => void
  onSwitchIncident: (i: IncidentMeta) => void
  onOpenHistory: () => void
  onOpenDivera: () => void
  onOpenDatenquellen: () => void
  /** freshly one-tap-taken Divera incident: show the correct-in-place review banner */
  needsReview: boolean
  onReviewDone: () => void
  /** When the Einsatzdaten were reviewed ON THIS DEVICE («Passt» or a saved correction — App's
   *  markReviewed funnels both). Only the workspace can write the incident's blob, so this is
   *  what gets published to the other devices as `intakeReviewedAt`. */
  reviewedLocallyAt?: string
  onEditMeta: () => void
  /** The Abschluss was confirmed here (see `confirmAndComplete`): stamp report_done_at + close.
   *  Resolves TRUE only when the close actually happened — App reports the outcome so a failed
   *  handover (offline, server error) does not pretend to have archived anything.
   *  ⚠️ There is deliberately no second «archive the active one» prop. Both doors — the Rapport
   *  and the Einsatz-Menü row — go through the one confirm and end in this one callback. */
  onCompleteRapport: () => Promise<boolean>
  /** re-open the CLOSED active incident (confirm dialog included) — the banner action */
  onReactivateActive?: () => Promise<ReactivateResult>
  /** leave the archived read-only view — back to the previously active incident, else the
   *  «Alle Einsätze» list it was entered from (everyone, not just editors) */
  onBackFromArchive?: () => void
}


/** One Drehung of the Gebäude is one drag, not forty slider frames — see onReorient. */
const REORIENT_FOLD_MS = 1500

export function IncidentWorkspace({
  incidentMeta, incidents, workspace, sync, forceReadOnly, tabLockLost, onTakeOverTab, onCompleteRapport,
  onSwitchIncident, onOpenHistory, onOpenDivera, onOpenDatenquellen, onReactivateActive, onBackFromArchive,
  needsReview, onReviewDone, reviewedLocallyAt, onEditMeta,
}: WorkspaceProps) {
  // Identity + permissions. Viewers get a read-only picture: they can pan / zoom /
  // inspect, but every editing affordance is hidden and commit() is neutered so
  // nothing can mutate the document (defense in depth).
  const { user, logout } = useAuth()
  /**
   * The Atemschutz-Link session (auth · AuthUser.link_kind): a link holder who may OPERATE the
   * Atemschutzüberwachung of this one Einsatz — Trupp anmelden, Eingerückt, Kontakt, Druck,
   * Rückzug, Draussen, bearbeiten, entfernen — and nothing else. It renders as «Tafel pur»
   * (the lite branch at the bottom of this component), which is why the rest of the workspace
   * never has to reason about it beyond the three flags below.
   */
  const asLink = isAtemschutzLinkKind(user?.link_kind)
  // ⚠️ `asLink` is NOT read-only. Its writes are real (the trupp slice of the workspace, journal
  // rows of kind 'team', `atemschutz.*` events — the backend allowlists exactly those), and
  // read-only would neuter `commit`, the journal store and the sync push alike, leaving a board
  // whose Kontakt button did nothing. What it is NOT is an editor: `isEditor`/`canEditIncident`
  // stay false, so every affordance outside the Tafel is withheld exactly as for a viewer.
  /** The `el` ROLE (Einsatzleiter function, 07.09.): the asLink pattern generalised — NOT
   *  read-only (its record writes are real: the `workspace/record` slice, journal rows,
   *  record-vocabulary events, Beilagen uploads — the backend allowlists exactly those), and
   *  NOT an editor (`isEditor`/`canEditIncident` stay false, `tacticalLocked` is permanently
   *  on, and the sync pushes only the record slice, so a local doc write could never reach
   *  the server). Distinct from `elView` below, which is an EDITOR's hands-off mode. */
  const isEl = user?.role === 'el'
  const baseReadOnly = (user?.role !== 'editor' && !asLink && !isEl) || forceReadOnly || tabLockLost
  const isEditor = user?.role === 'editor'
  // Einsatz-Link session (/l/<token>): a viewer narrowed to ONE incident. Read-only is not
  // enough here — a plain viewer may still generate the Rapport/Zeitplan PDFs and drive the
  // station printer, and all of that is refused for a link (backend/app/auth/incident_link.py).
  // Same rule as everywhere else: never show a control that will fail.
  const linkScoped = !!user?.link_scoped
  // Phones are a live viewer + field-capture device: lock all TACTICAL editing (tools,
  // map drawing/placing, plan annotation) even for a editor — but keep journal capture
  // + sync alive (those hang off `readOnly`, which stays false for a editor). Tablets
  // and desktop keep full editing.
  const isPhone = useIsPhone()
  /** The phone bar's FOLDED shape (18.09.2026): the plan documents collapse into one «Pläne»
   *  tile, and Anwesenheit + Material give up their tiles to become tabs of the Rapport — five
   *  tiles, which is what 360px holds without a sideways scroll. One flag for both folds and for
   *  the surfaces they move, so the bar can never offer a destination that is not there (or
   *  hide one that is). The vertical rail on a tablet/desktop is untouched. */
  const phoneFold = isPhone
  /** The ONE width at which the top bar drops its ↶ ↷ (15-mobile.css · max-width 359px), so the
   *  surface being tapped can offer its own pair instead of leaving the operator with no way back.
   *  ⚠️ NOT «an Atemschutz-Alarmchip is in the bar» any more (15.09.2026). That cost the pair
   *  exactly while a Trupp was überfällig — i.e. exactly when a mis-tap is most likely and the
   *  newest timeline step is a Funkkontakt — and a deleted Leitung became unreachable behind a
   *  loop: ↶ takes the Kontakt back, the Trupp is überfällig again, the pair is gone again. The
   *  Einsatzuhr yields to the chip now; the history pair never does. */
  const topBarUndoHidden = useMediaQuery('(max-width: 359px)')
  // Time-travel replay is a read-only past view: while active it locks ALL editing
  // (folded into both readOnly and tacticalLocked) and swaps the live doc for the
  // reconstructed state. Owned by useReplay; `active` feeds the lock derivations below.
  // the top bar and the nav rail stay put while iOS pans the page under a keyboard
  useViewportPan()
  // …and the field you are actually typing in stays above it (one listener for the whole app)
  useScrollFocusIntoView()
  const { active: replayActive, setActive: setReplayActive, ws: replayWs, onState: onReplayState, onVehicles: onReplayVehicles, exit: exitReplay, entities: replayEntities, board: replayBoard, building: replayBuilding } = useReplay()
  const readOnly = baseReadOnly || replayActive
  // Führungsansicht: an EDITOR's deliberate hands-off mode — tactical editing locked
  // like a phone, but journal capture and read-only symbol details stay live. Device toggle
  // (Einstellungen), seeded by the login's server-side default (el_view_default) so a
  // dedicated «Einsatzleiter» account starts hands-off without per-device setup.
  const [elViewPref, setElViewPref] = useState<boolean | null>(() => loadPrefs().elView ?? null)
  const elView = isEditor && (elViewPref ?? user?.el_view_default ?? false)
  const setElView = (v: boolean) => { setElViewPref(v); savePrefs({ ...loadPrefs(), elView: v }) }
  // «not edit anything» is broader than the tactical surfaces: EL view also locks the
  // Atemschutz / Mittel / checklist / dispatch actions that hang off this flag.
  //
  // ⚠️ `readOnly`, not `replayActive`: this used to miss `forceReadOnly`, so an ARCHIVED Einsatz
  // opened from «Alle Einsätze» — the view whose banner says «Nur ansehen – zum Bearbeiten
  // reaktivieren» — still let an editor tick a checklist, mark someone present and log Mittel.
  // The edits were saved and (correctly) badged as Nachträge, but nobody had asked for them:
  // the unlock is «Reaktivieren», deliberately, once, with its own confirm.
  const canEditIncident = isEditor && !readOnly && !elView
  /** …and the ONE slice an Atemschutz-Link may write. Everything Atemschutz-side gates on this
   *  rather than on `canEditIncident`, so the handed-over Tafel is operable while the rest of
   *  the workspace stays as read-only for it as it is for any viewer. */
  const canEditTrupps = canEditIncident || (asLink && !readOnly)
  /** «may keep the incident RECORD» — the Einsatzleiter function (07.09.): Anwesenheit (incl.
   *  Zeitplan), Mittel, Checklisten and the Rapport (incl. Beilagen). True for the `el` role
   *  AND for an editor in the Führungsansicht — the EL's view means the same thing whichever
   *  account holds the device; a plain editor has it anyway via `canEditIncident`. The
   *  backend enforces the same boundary (`workspace/record` · RECORD_WORKSPACE_KEYS), so this
   *  flag is presentation, not the protection. */
  const canEditRecord = (isEditor || isEl) && !readOnly
  /** «may correct the EINSATZDATEN» — the dispatch facts at the head of the record: Stichwort,
   *  Kategorie, Priorität, Ort, Alarmierungszeit, Alarmmeldung, Übung. The `el` role keeps the
   *  record, so it owns the head of it too (10.09.) — the asLink pattern again: not an editor,
   *  but the one surface outside its slice it may write. The LIFECYCLE stays with the editors
   *  (Abschluss, Archivieren, Rapport fertig) and gates on `canEditIncident` as before; the
   *  backend draws the identical line (PATCH /incidents/{id} · EL_META_FIELDS). */
  const canEditMeta = canEditIncident || (isEl && !readOnly)
  /**
   * «may write the incident RECORD at large» — the flag every writer that used to gate on bare
   * `readOnly` now uses.
   *
   * ⚠️ It is not `canEditIncident`. That one also excludes the Führungsansicht, where journal
   * capture, media upload and the weather log deliberately stay live (see `elView`); gating
   * these on it would silently switch off half of what an EL device is for. What has to be
   * excluded is the Atemschutz-Link: it is genuinely not read-only — it operates the Tafel —
   * but it owns exactly ONE slice, and everything outside that slice is refused by the backend.
   * Left on bare `readOnly`, those writers would emit `weather.observe` events into a 403,
   * drain a media queue that cannot upload, and dirty a blob whose push carries only Trupps.
   */
  const canWriteRecord = !readOnly && !asLink
  // Phones edit like tablets — the tool bar is simply always there on the drawing surfaces
  // (stacked above the surface bar). Viewers and the EL-Ansicht stay hands-off; a brigade
  // that wants a view-only phone uses exactly those.
  const tacticalLocked = readOnly || elView || isEl

  // Seed all state slices once from this incident's workspace (the component is keyed
  // by incident id upstream, so this runs exactly once per incident). The blob passes the
  // sanitize/version gate first — a stale or malformed cached blob must never crash the open.
  const bootGate = useMemo(() => sanitizeWorkspace(workspace), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const init = useMemo(() => deriveInitial(bootGate.ws, incidentMeta.id, prefs, incidentMeta.type), [])  // eslint-disable-line react-hooks/exhaustive-deps
  /** the linked plans' fits for the bake, keyed by planId — written where `linkedPlans` is
   *  derived (much further down), read by the object store's writers through this getter, so a
   *  bake always uses the fit that exists NOW rather than the one that existed when the mutator
   *  was created */
  const planFitsRef = useRef<Map<string, PlanFit>>(new Map())
  const getFits = useCallback(() => planFitsRef.current, [])
  /** ⚠️ Bumped when a fit REALLY changes (see the rebake effect far below). Every sheet's view is
   *  derived through those fits, and a ref is invisible to a memo — this is the one value that
   *  tells the store a corrected georeference moved every projection on that sheet. */
  const [fitsVersion, setFitsVersion] = useState(0)
  /** the caption the NEXT store checkpoint carries, when its writer knows a better word than
   *  the domain's — see `onCheckpoint` below */
  const stepLabel = useRef<string | null>(null)
  // On open, fit the map to the incident's existing map content (symbols + drawings) instead of
  // zooming onto the bare Einsatzort point — so a pre-filled Lage is framed ("eingepasst"). One
  // snapshot per incident (mirrors `init`), so it never snaps the view back while you draw.
  const initialFitPoints = useMemo<LngLat[] | undefined>(() => {
    const pts: LngLat[] = []
    for (const e of init.doc.entities) if (e.coord) pts.push(e.coord)
    for (const d of init.doc.drawings) {
      // A circle (Absperrkreis / Gefahrenradius) stores only its centre in `coords`, so include
      // its rendered outline so the whole area is framed, not just the point.
      if (d.kind === 'circle' && d.radiusM && d.coords[0]) {
        for (const [lng, lat] of circlePolygon(d.coords[0], d.radiusM, 8)[0]) pts.push([lng, lat])
      } else {
        for (const c of d.coords) pts.push(c)
      }
    }
    return pts.length >= 2 ? pts : undefined  // <2 → MapView keeps the incident-centred default
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const incidentView: Incident = useMemo(() => ({
    type: incidentMeta.type ?? '',
    title: incidentMeta.title,
    address: incidentMeta.address ?? '',
    // center precedence: this incident's own coordinate → the deployment's configured
    // default view (/api/config map.defaultView; WGS84 `center`, else LV95 `centerLv95`
    // converted to WGS84 — the backend rejects both being set) → the neutral bundled
    // fallback center (Switzerland centroid; only hit by a config-less/public build).
    // 0/0 = "no location" (Divera convention; older rows stored it verbatim) — fall back
    // like a missing coordinate instead of centring map + weather on Null Island.
    center: (incidentMeta.lng != null && incidentMeta.lat != null && (incidentMeta.lng !== 0 || incidentMeta.lat !== 0)
      ? [incidentMeta.lng, incidentMeta.lat]
      : deploymentDefaultCenter() ?? demoIncident.center) as LngLat,
    startedAt: incidentMeta.started_at, durationSec: 0, offline: false, cachedTiles: 0, recording: false, recDurationSec: 0,
  }), [incidentMeta])

  // Cross-visibility QR → KP: the QR-usage counters live on the incident meta, and the
  // FRESHEST copy comes from the 30 s incident-list watch (`incidents`) — `incidentMeta`
  // itself is only replaced on open/patch. Chip on the QR-writable surfaces only
  // (Anwesenheit / Mittel / Rapport), deliberately not in the incident switcher.
  const qrMeta = incidents.find((i) => i.id === incidentMeta.id) ?? incidentMeta
  const captureUsage = (qrMeta.capture_writes ?? 0) > 0
    ? { writes: qrMeta.capture_writes ?? 0, lastAt: qrMeta.capture_last_at ?? null }
    : null

  const sym = useSymbols()
  // ── the two «Karte läuft, aber…» rows (02.09.) ─────────────────────────────────────────
  // Symbol pack failed for good (sym.error): Karte and Kroki mount anyway with an empty glyph
  // table, and the Meldeleiste row offers the reload. Dismissed here only; a reload that fails
  // again brings it back (reload() clears `error` first, so the row re-publishes on the next
  // failure).
  const [symbolsRowHidden, setSymbolsRowHidden] = useState(false)
  // No cached basemap for this view while offline (MapView · onBasemapUnavailable). Said ONCE
  // per Einsatz mount — every tile of the view fails, and a dismissed row must not come straight
  // back — and withdrawn the moment the link returns.
  const [noBasemap, setNoBasemap] = useState(false)
  const noBasemapSaid = useRef(false)
  const onBasemapUnavailable = useCallback(() => {
    if (noBasemapSaid.current) return
    noBasemapSaid.current = true
    setNoBasemap(true)
  }, [])
  useEffect(() => {
    const clear = () => setNoBasemap(false)
    window.addEventListener('online', clear)
    // …or the server answered again without the browser announcing it (lib/connectivity)
    const offReachable = onReachable(clear)
    return () => { window.removeEventListener('online', clear); offReachable() }
  }, [])
  const mapRef = useRef<MapRef>(null)
  // the locked surface's tool set — see lib/readOnlyTools for why only these two qualify
  const slimMapTools = useMemo(() => slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS), [])

  /**
   * ── ONE undo timeline for the whole Einsatz (08.09.2026) ──────────────────────────────────
   * The header's ↶ used to mean «take back what you last did HERE», which asked the operator to
   * already know which surface his last tap landed on — the recall the 3am tenet exists to
   * refuse. It now means «take back the last thing that happened», wherever that was, and it
   * says what that is before and after the press (`peekUndo().label`, `flashUndoCaption`).
   *
   * ⚠️ The domain stacks below are NOT replaced. The Karte doc, each Plan document and the
   * Anwesenheit slice keep their own history and remain the thing that performs the step; the
   * timeline records the CHRONOLOGY and delegates. Only the surfaces that never had a stack —
   * the Atemschutz-Tafel, Mittel, Checklisten, the Gebäude one-shots — carry their inverse in
   * the entry itself. See `lib/undoTimeline`.
   */
  const { timeline: undoHist, canUndo: histCanUndo, canRedo: histCanRedo, undoLabel, redoLabel } = useUndoTimeline()
  const C_HIST = appConfig.copy
  /** `log`/`emit` are built far below (they need half this component); a timeline entry pushed up
   *  here has to reach the versions that exist when the ↶ is actually pressed. */
  const histSide = useRef<{ log: typeof log; emit: typeof emit }>({ log: () => {}, emit: () => {} })
  /** ⚠️ Through a ref: `applyWorkspace` below is a `useCallback` pinned to the incident, so it
   *  must not close over a timeline handle from one particular render. */
  const histClear = useRef(() => {})
  histClear.current = () => undoHist.clear()
  /**
   * The Verlauf row + audit event one step owes the record — append-only, so this ADDS a row
   * saying the correction happened and never touches the row it corrects.
   *
   * ⚠️ `op` is domain-scoped on purpose, and a bare `undo` is only ever sent from the tactical
   * surfaces an editor alone can reach. An `el` session may append the RECORD vocabulary only
   * (`EL_EVENT_PREFIXES` in backend · api/events.py) and a link session only `atemschutz.*` —
   * one refused op_type 403s the WHOLE batch and wedges the outbox, so an Anwesenheits-↶ sends
   * `attendance.undo`, a Mittel-↶ `mittel.undo`, a Checklisten-↶ `checklist.undo`.
   */
  const logHistStep = (dir: 'undo' | 'redo', label: string, op: string, icon = 'undo', kind: TimelineEvent['kind'] = 'history') => {
    const L = appConfig.copy.log
    histSide.current.log(icon, fillTemplate(dir === 'undo' ? L.undoNamed : L.redoNamed, { action: label }), kind)
    histSide.current.emit(`${op}${dir}`)
  }
  /** A delegating entry's step: the domain's own history does the work, and the record gets its
   *  row ONLY if that history actually moved. `false` travels back to the timeline as «this one
   *  is gone» — the entry is discarded and the operator is told, quietly. */
  const histStep = (moved: boolean, dir: 'undo' | 'redo', label: string, op: string, icon?: string, kind?: TimelineEvent['kind']): boolean => {
    if (!moved) return false
    logHistStep(dir, label, op, icon, kind)
    return true
  }

  // --- THE tactical store (undoable) — one collection of objects, the Karte's `doc` and the
  // plans' `board` as views of it (lib/useObjectStore, schema 2). Every writer below still speaks
  // the document it always spoke; the store folds it back. ---
  // ⚠️ The Karte's checkpoint carries a DOMAIN label, not the name of the edit: `commit` is
  // reached from every drawing, symbol and property path in the app, and threading a word through
  // all of them would be a different change. The Tafel, Mittel and the Checklisten name their
  // action exactly, because there the timeline entry is written by hand anyway.
  const {
    objects, doc, board, setDocRaw, setBoard, beginSheetStep, endSheetStep, commit, beginDrag, endDrag, gestureOpen, rebake,
    undo: undoDoc, redo: redoDoc, replaceObjects,
  } = useObjectStore(
    init.objects,
    readOnly,
    {
      getFits,
      fitsVersion,
      defaultLayer: appConfig.defaults.operationalLayerId,
      /** ⚠️ The caption names what the step DID where the writer knows it — the ↶ bubble
       *  saying «Änderung auf der Karte» for a corrected georeference described the wrong act
       *  entirely. One-shot: a writer sets it just before its checkpoint, everything else keeps
       *  the domain word, which for a store step is honest (the object IS the Karte's). */
      onCheckpoint: () => {
        const label = stepLabel.current ?? C_HIST.undoDomains.karte
        stepLabel.current = null
        undoHist.push({
          domain: 'karte',
          label,
          undo: () => histStep(undoDocRef.current(), 'undo', label, ''),
          redo: () => histStep(redoDocRef.current(), 'redo', label, ''),
        })
      },
      /**
       * An object changed SURFACE, and the audit stream is told both halves of it.
       *
       * ⚠️ The surface that was dragged on emits its own document's event and can emit no other:
       * the Karte says `entity.move`, the sheet says `board.move`. A flip changes both views at
       * once, and the replay folds VIEWS (lib/replay, deliberately) — so a map flip that said only
       * «the entity moved» left the anno standing on the recorded sheet and the scrub showed one
       * object twice, while a plan flip said «this anno moved» about an anno the recorded board
       * never held and the scrub showed it in neither.
       *
       * So the store reports the flip (lib/tacticalObjects · anchorChanges) and the missing half
       * is emitted here — once per gesture, because the flip happens once. `board.add` carries the
       * anno the sheet has THIS instant; the release's own `board.move` refines it, exactly as it
       * does for an anno that was always the sheet's.
       */
      onAnchorChange: (changes) => {
        for (const c of changes) {
          if (c.left) histSide.current.emit('board.delete', { id: c.id, planId: c.left })
          if (!c.joined) continue
          histSide.current.emit('board.add', { id: c.id, planId: c.joined.planId, anno: c.joined.anno })
          // …and the ground position the sheet's new anno was baked to. The Karte draws a
          // sheet-anchored object itself (tacticalObjects · viewsOf), so without this the map view
          // of the replay kept the pre-flip coordinate.
          if (c.entity) histSide.current.emit('entity.move', { id: c.id, coord: c.entity.coord })
          else if (c.drawing) histSide.current.emit('draw.edit', { id: c.id, patch: { coords: c.drawing.coords } })
        }
      },
      onForeignSheetEdit: (events) => {
        for (const event of events) histSide.current.emit(event.op, event.payload)
      },
    },
  )
  // ⚠️ Through refs: the entry outlives the render that pushed it, and `undoDoc` closes over that
  // render's `past`/`future`. Calling the captured one would step a stack that has moved on.
  const undoDocRef = useRef(undoDoc); undoDocRef.current = undoDoc
  const redoDocRef = useRef(redoDoc); redoDocRef.current = redoDoc
  // …and the store itself, for a closure that has to ask «which of these does the Gebäude OWN»
  // when it RUNS (the ↶ of «Geschoss hinzufügen»), not when it was made
  const objectsRef = useRef(objects); objectsRef.current = objects
  // Live vehicles from kp-rueck's GPS feed — kept out of the editable document so
  // they auto-update and never get persisted. The operator can drag a vehicle to
  // reposition it and drag its handle to orient it; those overrides live here
  // (persisted) and win over the GPS value until reset via the "GPS" button.
  const { gpsVehicles, liveVehicles, liveIds, overrides: vehicleOverrides, setOverrides: setVehicleOverrides, gpsStale, gpsAgeMs } = useVehicleLayer(init.vehicleOverrides)
  // Standort teilen. Two halves that deliberately do not meet: this device REPORTS where its
  // holder is (`share`, available to every session including a link-scoped phone), and the
  // command post READS the crew picture (`livePeople`, refused to a link session server-side,
  // so it isn't even polled for one). Both die with the incident.
  // Exactly what the backend calls "still running" (models.Incident.is_open) — a phone must
  // not keep reporting into an Einsatz that is over, and finding out via a 404 would leave a
  // green pill on the screen in the meantime. Shared helper, not a hand-written copy: this
  // check used to spell out `status === 'offen'` and so hid the whole feature on an Einsatz
  // somebody had marked «In Arbeit».
  const incidentOpen = isIncidentRunning(incidentMeta)
  const share = useShareMyPosition(incidentMeta.id, incidentOpen)
  // DEMO ONLY: the crew picture is SIMULATED in this browser rather than polled — a public demo
  // must not carry real people's coordinates, so the backend refuses every position route there
  // and nothing is ever posted (lib/demoCrewWalk). The walkers are the incident's own Trupp
  // leaders, plus whoever taps «Standort teilen» on this device, so the dots carry the same
  // synthetic names as the rest of the scene.
  const demoCrew = useMemo(() => {
    if (!isDemoMode()) return undefined
    // ONE dot, not a fleet: the demo is showing the concept — «ein AdF meldet, wo er ist» — and
    // three of them just look like a feature demanding attention. Sharing on this device replaces
    // it, so there is still exactly one.
    if (share.state === 'on' && share.pref?.personId) {
      return {
        center: incidentView.center,
        crew: [{ id: share.pref.personId, displayName: share.pref.displayName ?? '' }],
      }
    }
    // Somebody who is present but NOT in a Trupp — the Trupps are inside the building, and a dot
    // walking around outside under a name the Atemschutz board says is on the 2nd floor is the
    // kind of contradiction a demo must not show. Matched by NAME as well as by roster id: the
    // demo's Trupps are seeded with names only (backend/app/demo_reset), so an id-only check
    // would have happily picked the Angriffstrupp's Truppführer.
    // …and a Trupp taken off the Tafel deploys nobody: its members are free again (Trupp.removedAt)
    const onBoard = init.trupps.filter((t) => !t.removedAt)
    const deployedIds = new Set(onBoard.flatMap((t) => [t.leaderPersonId, ...(t.memberPersonIds ?? [])].filter(Boolean) as string[]))
    const deployedNames = new Set(onBoard.flatMap((t) => [t.name, ...(t.members ?? [])]).map((n) => n?.trim()).filter(Boolean))
    // …and not the Einsatzleiter either: they are already ON the map as their own symbol, so a
    // second, walking dot with the same name reads as two people.
    const el = init.reportMeta.einsatzleiter?.trim()
    const free = Object.entries(init.attendance).find(([id, a]) => isPresent(a)
      && !deployedIds.has(id)
      && !deployedNames.has(a.displayNameSnapshot?.trim())
      && (!el || a.displayNameSnapshot?.trim() !== el))
    if (!free) return undefined
    const [id, entry] = free
    // Anchor on something an author PLACED (the Einsatzleiter, a vehicle): those sit on the road
    // or the Areal by construction, whereas a blind offset from the incident can land the dot in
    // the Weiher. The incident centre is the fallback.
    const anchor = init.doc.entities.find((e) => e.kind === 'symbol'
      && (e.symbol === appConfig.symbols.vehicleName || e.symbol?.includes('Fahrzeug') || e.symbol?.includes('Einsatzleiter')))
    return {
      center: anchor?.coord ?? incidentView.center,
      crew: [{ id, displayName: entry.displayNameSnapshot ?? '' }],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init.* is the mount-time seed
  }, [share.state, share.pref?.personId, share.pref?.displayName, incidentView.center])
  const livePeople = usePersonPositions(incidentMeta.id, !linkScoped && !replayActive, demoCrew)
  // null = closed · 'ask' = permission + name · 'pick' = the roster alone (changing the name).
  // NOTHING opens this on its own: sharing somebody's location is never proposed by the app,
  // only reached by tapping «Standort teilen» in the compass menu. That is also why there is no
  // «nicht jetzt» state to remember — nobody is being asked in the first place.
  const [sharePick, setSharePick] = useState<null | 'ask' | 'pick'>(null)

  // Session-only tactical editing state (active tool, place gesture, selection) — see
  // useTacticalSelection. Declared before enterReplay (which clears it) so its setters are in
  // scope for that callback; threaded into useMapDrawing below just as before.
  const { selectedId, setSelectedId, tool, setTool, teamPick, setTeamPick, pending, setPending, pendingShape, setPendingShape, placeLock, setPlaceLock, selectedDrawingId, setSelectedDrawingId, selectedDrawIds, setSelectedDrawIds, selectedEntityIds, setSelectedEntityIds } = useTacticalSelection()
  /** Where the currently selected drawing was TAPPED (map-container px), paired with its id so a
   *  selection that arrived some other way can't borrow a stale point. Only the panel nudge reads
   *  it (lib/panelNudge · panelNudgeSelection). */
  const [drawTap, setDrawTap] = useState<{ id: string; x: number; y: number } | null>(null)
  /** the FIRST of a Rotation's two points, while the second is still being looked for. Held here
   *  rather than in the tactical selection because it lives and dies with one placement gesture
   *  (lib/shapes · SHAPE_TWO_POINT); the guard effect below clears it on EVERY exit from that
   *  gesture — per-exit bookkeeping missed paths, and a stale point silently became one end of
   *  the next Rotation laid minutes later. */
  const [rotStart, setRotStart] = useState<LngLat | null>(null)
  useEffect(() => {
    if (tool !== 'shape' || !pendingShape || !SHAPE_TWO_POINT[pendingShape]) setRotStart(null)
  }, [tool, pendingShape])

  // Per-incident SYNCED workspace slices (checklists, trupps, attendance, mittel, camera
  // views, plan scale, report meta, Gebäude, active plan, picked object, synced settings, the
  // shared «Einsatzdaten geprüft» stamp) — see
  // useWorkspaceDoc. State only; buildPayload/applyWorkspace + the trupps auto-free effects stay
  // below and read these. layers/recent stay in the component (own derivation/effects); `board`
  // is a view of the tactical store above.
  const {
    incidentSettings, setIncidentSettings, checklists, setChecklists,
    trupps: allTrupps, setTrupps, attendance, setAttendance, mittel, setMittel, shifts, setShifts, bands, setBands, cameraViews, setCameraViews, trails, setTrails, attachments, setAttachments, suche, setSuche,
    planScale, setPlanScale, reportMeta, setReportMeta, building, setBuilding,
    planBindings, setPlanBindings,
    activePlanId, setActivePlanId, pickedObjectId, setPickedObjectId,
    intakeReviewedAt, setIntakeReviewedAt,
  } = useWorkspaceDoc(init)
  // The bindings register as the georef home for `incident:` keys (pairing mode, Passung,
  // reset all route through it) and their corrections join the shared undo timeline.
  useIncidentPlanBindings(incidentMeta.id, planBindings, setPlanBindings, readOnly, undoHist)
  // ⚠️ The board list, filtered ONCE at the source. A deleted Trupp is stamped rather than
  // removed (types · Trupp.removedAt) so the Rapport can still print it — and everything else in
  // this component, from the alarm host to the map markers to the roster lock, must never see it
  // again. Filtering here is what makes that true by construction instead of by fifteen call
  // sites remembering. `allTrupps` goes to exactly three places, and all three are the RECORD
  // rather than the board: what is SAVED, what is PRINTED, and the journal's vocabulary — a row
  // that named a Trupp keeps naming it after the crew has come out (see `journalVocab`).
  const trupps = useMemo(() => allTrupps.filter((t) => !t.removedAt), [allTrupps])
  // …and the other half: what was taken off the board, newest first. The Atemschutz header offers
  // them back, so the delete's six-second toast is the fast way and not the only one.
  const removedTrupps = useMemo(
    () => allTrupps.filter((t) => t.removedAt).sort((a, b) => (b.removedAt ?? '').localeCompare(a.removedAt ?? '')),
    [allTrupps],
  )
  /** ⚠️ `allTrupps`, NOT the filtered board list — this is what the timeline's Trupp entries ask
   *  «is the card you describe still there?». Löschen is a stamp, so a deleted Trupp is filtered
   *  out of `trupps` while very much still in the record; asking the filtered list would make
   *  «Löschen rückgängig» decline itself as pointing at something gone. */
  const truppsRef = useRef(allTrupps); truppsRef.current = allTrupps

  // --- time-travel replay (read-only past view) — state/reconstruction owned by useReplay ---
  // enterReplay lives further down, next to clearMapUi, whose reset list it shares.

  // map entities/drawings: the live doc + GPS, or the reconstructed past blob during replay.
  // Live crew positions join the vehicles: derived from the backend, never persisted, never
  // in the replay (they are the present by definition and no history of them is kept).
  const entities = useMemo(
    () => (replayActive ? replayEntities : [...doc.entities, ...liveVehicles, ...livePeople.people]),
    [replayActive, replayEntities, doc.entities, liveVehicles, livePeople.people],
  )
  const drawings = replayActive ? (replayWs?.drawings ?? []) : doc.drawings

  // re-render when the fetched ADR/ERG datasets land (lib/useHazardData) — the rings and
  // baked placards below read them synchronously.
  const hazVersion = useHazardData()
  // ERG Schutzabstand rings, derived per render from the placards on the board (lib/ergRings,
  // Feldtest Manuel 07.09.). Joined with the prepared overlays so MapLayers needs no new prop.
  // The day/night split is read at compute time; a board left open across 07/19 h picks the
  // flip up with the next re-render, which any interaction provides — a Planungshilfe does not
  // warrant its own clock.
  const mapOverlays = useMemo(
    () => [...preparedOverlays, ...ergRingOverlays(entities, new Date())],
    // hazVersion: the ERG table arrives by fetch shortly after boot (lib/useHazardData) —
    // rings drawn from an already-typed UN appear with it.
    [entities, hazVersion],
  )
  const resolvedMapDrawings = useMemo(() => resolveMapDrawings(drawings, entities), [drawings, entities])
  /**
   * The ONE thing the header pair does: step the global timeline, then SAY what it stepped.
   *
   * The caption is not a toast (`lib/undoFlash`): it is the button answering the press that was
   * just made, in the same bubble the hold shows when it is asked what it would do. It matters
   * because ↶ now reaches across surfaces — the operator is looking at the Karte and the thing
   * that came back happened on the Tafel, where he cannot see it happen.
   *
   * The one FAILURE is soft and button-less: the step pointed at something a merge has taken
   * away. Nothing is half-done (the entry declined before writing), so there is nothing to
   * retry and nothing to confirm — just a word, and the next ↶ moves on to the step below.
   */
  const stepHistory = (dir: 'undo' | 'redo', anchor?: HTMLElement | null): void => {
    const r = dir === 'undo' ? undoHist.undo() : undoHist.redo()
    if (r.status === 'empty') return
    if (r.status === 'lost') { toast(appConfig.copy.undoLost, { icon: 'warn' }); return }
    if (anchor) flashUndoCaption(anchor, fillTemplate(dir === 'undo' ? C_HIST.undoNamed : C_HIST.redoNamed, { action: r.entry.label }))
  }
  /** …from a button, which anchors the caption at itself. Every ↶ ↷ in the app goes through this. */
  const onHistoryPress = (dir: 'undo' | 'redo') => (e: ReactMouseEvent<HTMLButtonElement>) => stepHistory(dir, e.currentTarget)
  useEffect(() => clearUndoCaption, [])
  // the Plan keeps its own per-document history (inside Whiteboard); it reports its
  // step fns up here so the GLOBAL TopBar undo/redo drives whichever
  // surface is showing — one control, both surfaces, no rail-level duplication.
  const planHist = useRef<{ undo: () => void; redo: () => void } | null>(null)
  // ⚠️ …and the STACKS live here rather than inside the Whiteboard, because the Whiteboard is
  // mounted only while `mode === 'plans'`: as component state the plan's history was thrown away
  // every time somebody glanced at the Verlauf or the Karte and came back — «nichts, was sich
  // nicht rückgängig machen lässt» broken by a tab switch. Keyed by plan id (see BoardHistory),
  // so surviving the unmount never leaks one plan's undo into another plan's.
  // ⚠️ They snapshot ONE plan's ANNOS, not the tactical store — deliberately, now that the board
  // is a view of it (lib/useObjectStore). A plan step is a statement about one sheet, and
  // restoring it through `setBoard` is exactly that statement: `applyBoardToObjects` folds the
  // restored list back and re-bakes those objects, leaving every other sheet and the whole Karte
  // where they stand. Snapshotting the store here would make a plan's ↶ reach across surfaces,
  // which is the opposite of what these per-document stacks exist for.
  const [planHistory, setPlanHistory] = useState<BoardHistory>({})
  // ⚠️ Live copies for the timeline's entries. An entry is pushed in one render and pressed in
  // another, and both of these move constantly — a plan's step read off the render that recorded
  // it would restore an annotation array from before everything that happened since.
  const planHistoryRef = useRef(planHistory); planHistoryRef.current = planHistory
  /**
   * Record that ONE plan document moved, on the global timeline.
   *
   * ⚠️ Scoped by plan id, and stepped by plan id — never through `planHist` (which points at
   * whichever plan is OPEN). The header's ↶ is chronological now, so the last thing that happened
   * may well be on a plan the operator has since navigated away from; delegating to the open
   * plan's history would then quietly undo a step on the wrong document. Where the plan IS open
   * we still go through `planHist`, because that path also clears the board's selection and
   * writes the Verlauf row the Whiteboard has always written.
   */
  const planStepAt = (planId: string, dir: 'undo' | 'redo'): boolean => {
    if (planId === activePlanIdRef.current && planHist.current) {
      const can = planHistoryRef.current[planId]
      const has = dir === 'undo' ? !!can?.past.length : !!can?.future.length
      if (!has) return false
      if (dir === 'undo') planHist.current.undo(); else planHist.current.redo()
      return true
    }
    const cur = planHistoryRef.current[planId]
    const stack = dir === 'undo' ? cur?.past : cur?.future
    if (!stack?.length) return false
    const to = dir === 'undo' ? stack[stack.length - 1] : stack[0]
    const from = boardRef.current[planId] ?? []
    setPlanHistory((m) => {
      const c = m[planId]
      if (!c) return m
      return { ...m, [planId]: dir === 'undo'
        ? { past: c.past.slice(0, -1), future: [from, ...c.future] }
        : { past: [...c.past, from], future: c.future.slice(1) } }
    })
    // ⚠️ a RESTORE, not a placement (`gesture: false`): the snapshot is the sheet's whole view,
    // projections included, and read as a hand it flipped any it still held at an older spot
    setBoard((all) => ({ ...all, [planId]: to }), { gesture: false })
    return true
  }
  /** Record on the timeline that one plan document just gained a step. The Whiteboard pushes its
   *  own checkpoint (useBoardDoc · pushPast) and calls only this — it is the ONLY writer of these
   *  per-document stacks. A writer that reaches a plan while the board is unmounted (the Trupp
   *  sweeps, a Gebäude amend) goes through the store's `setBoard` instead, which lays its step on
   *  the STORE's stack where the write touched an object the sheet does not own (lib/useObjectStore
   *  · touchedForeign) — the one stack such a write can reach. */
  const rememberPlanStep = (planId: string) => {
    // ⚠️ …and the STORE is told too, because a plan gesture may reach an object the sheet does
    // not own (lib/useObjectStore · setBoard): one gesture is one step on whichever stack owns
    // what it touched, and this is the signal that keeps it to one.
    beginSheetStep()
    const label = fillTemplate(C_HIST.undoDomains.plan, { plan: planLabelRef.current(planId) })
    undoHist.push({
      domain: 'plan',
      scope: planId,
      label,
      undo: () => histStep(planStepAt(planId, 'undo'), 'undo', label, ''),
      redo: () => histStep(planStepAt(planId, 'redo'), 'redo', label, ''),
    })
  }
  // …and the zoom/pan of each plan, for the same reason: coming back from the Karte to a board
  // that had reset itself to «eingepasst» means finding your place on it again, every time.
  // Same scope as the Lage map's own view memory (MapView · viewRef): this component is keyed
  // per Einsatz and dies with it, and nothing here is written to the synced workspace — where a
  // viewer stands on a plan is private to their device. A REF, so a pan re-renders only the board.
  const planViews = useRef<BoardViews>({})
  // the Plan exposes its fit-to-view here so the phone top bar can offer Fit (the plan's
  // equivalent of the map's locate) instead of a floating zoom cluster on a small screen.
  const planFit = useRef<(() => void) | null>(null)
  // the Plan exposes tool-pick + zoom here so the global keyboard-shortcut layer can drive it
  // while the Plan is the active surface (parity with how it drives the Lage map).
  const planKeys = useRef<{ pickTool: (tool: string) => void; zoom: (f: number) => void; duplicate: () => void } | null>(null)
  // always-fresh keydown dispatcher — assigned every render (below, once all handlers exist) so
  // the single window listener never re-subscribes yet never closes over stale state.
  const hotkeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  /**
   * The Verlauf row for EDITING a symbol on the Kroki, written once the editing stops.
   *
   * Same shape and the same reason as the Rapportangaben logger further down: the inspector
   * writes on every keystroke, so a row per `patchEntity` would be a row per character typed
   * into a name field. The base is the entity as it stood when the editing STARTED, and the
   * line names what actually moved between those two points — per entity, so editing two
   * symbols in the same four seconds stays two rows about two symbols.
   *
   * ⚠️ …and the window RE-ARMS while the sentence is still being written (04.09.) — see
   * `createEditSettle` and `isTypingSymbolField`. A plain settle read every pause as «done» and
   * put a half-typed Notiz on the Rapport three times.
   */
  // ⚠️ Built ONCE per mount, so the open windows survive a re-render. Its callbacks close over
  // `log` from the render that first opened one — which is safe, and only because `log` writes
  // through the ref-held journal store (useJournal · append is stable per mount).
  const entityLogSettle = useRef<EditSettle<Entity> | null>(null)
  /** Streamed keystrokes, per entity — the on-canvas note editor has no panel to read focus off
   *  (`noteTextLive` is its only signal), so it says so here instead. */
  const entityTypedAt = useRef(new Map<string, number>())
  const noteEntityEdit = (before: Entity, after: Entity) => {
    entityLogSettle.current ??= createEditSettle<Entity>({
      ms: META_LOG_SETTLE_MS,
      stillEditing: (id) => isTypingSymbolField()
        || Date.now() - (entityTypedAt.current.get(id) ?? 0) < META_LOG_SETTLE_MS,
      onSettled: (id, base, latest) => {
        entityTypedAt.current.delete(id)
        const changes = entityEditChanges(base, latest)
        if (!changes.length) return
        log('pen', fillTemplate(appConfig.copy.log.entityEdited, {
          name: entityLogName(latest), changes: changes.join(', '),
        }), 'symbol', undefined, id)
      },
    })
    entityLogSettle.current.push(before.id, before, after)
  }

  // one place that edits a single map entity: a discrete undo step + the audit
  // emit, so every field edit (label/fields/notes/floor/count/rotation) is recorded
  // identically — previously notes/floor/count silently skipped the audit stream.
  // `commit` alone only stops a VIEWER: in the Führungsansicht readOnly is false, so every
  // entity write needs the tactical lock too (the panels hide their controls, this is the floor).
  const patchEntity = (id: string, patch: Partial<Entity>) => {
    if (tacticalLocked) return
    commit((d) => {
      const before = d.entities.find((e) => e.id === id)
      if (before) noteEntityEdit(before, { ...before, ...patch })
      return { ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) }
    })
    emit('entity.edit', { id, patch })
  }

  const [layers, setLayers] = useState<LayerDef[]>(init.layers)
  // Category-driven layer pre-activation on a LATER re-categorization (a BMA that turns out
  // to be a real fire brings the hydrants up). Additive only — never hides anything; the
  // creation-time activation for a fresh workspace happens in deriveInitial.
  const prevIncidentType = useRef(incidentMeta.type)
  useEffect(() => {
    if (incidentMeta.type === prevIncidentType.current) return
    prevIncidentType.current = incidentMeta.type
    setLayers((ls) => autoActivateLayers(ls, incidentMeta.type))
  }, [incidentMeta.type])
  // Verlauf rows live in the append-only journal store (server rows + offline outbox), NOT
  // in the synced blob — the one unbounded domain no longer re-syncs wholesale on every edit.
  // `legacy` seeds display + migration from an older incident's in-blob timeline.
  const journal = useJournal({ incidentId: incidentMeta.id, readOnly, legacy: init.timeline })
  // pulled out by name: `journal` itself is a fresh object every render, so a callback that
  // depends on it either churns or (the bug this replaced) silently keeps a stale `rows`
  const { swapPhoto, overlaySession: overlayRow, appendPatch: patchRow } = journal
  const timeline = journal.rows
  const [recent, setRecent] = useState<string[]>(init.recent)
  // most-recently-used symbols (shared by both surfaces' palettes) — newest first, deduped, capped
  const addRecent = (name: string) => setRecent((r) => [name, ...r.filter((x) => x !== name)].slice(0, 12))
  // overlay / popover / sheet open-state (views popover, symbol palette, Einstellungen,
  // Objekt-Picker, Hilfe, Installations-Guide, Offline-Bereitschaft — the Rapport is not here,
  // it is a rail surface, so «open it» is setMode('rapport'),
  // layers panel) — grouped in useSheets; switching to a tool closes the views popover + panel.
  const { viewsOpen, setViewsOpen, paletteOpen, setPaletteOpen, settingsOpen, setSettingsOpen, pickerOpen, setPickerOpen, helpOpen, setHelpOpen, installGuideOpen, setInstallGuideOpen, offlineReadyOpen, setOfflineReadyOpen, shareLink, setShareLink } = useSheets()
  /** Who may hand a link out at all — an editor on a live view, and never a link session itself
   *  (a link may not mint further links). Says nothing about WHICH link: after the Abschluss only
   *  the read-only link is still a thing, and that is `shareDoors`' business (lib/viewLink). */
  const canShareLink = canEditIncident && !readOnly && !linkScoped
  /** …and the ONE link that DIES with the Abschluss — the Truppüberwacher-Link (its session
   *  404s). A door straight to it, bypassing the sheet's own tabs, has to close when the Einsatz
   *  does, or it offers an address that never worked. Same guard the «Einsatz abschliessen» row
   *  uses further down. */
  const canShareLive = canShareLink && !incidentMeta.is_archived
  /** Is there an Atemschutz-Link on this Einsatz right now? ONE request per incident, and
   *  deliberately never polled: the QR in the Atemschutz header only claims that a link EXISTS,
   *  and the only thing that changes that is minting or revoking one — which happens in the
   *  sheet, on this device, and reports straight back through its `onState`. */
  const [atemschutzLinkOn, setAtemschutzLinkOn] = useState(false)
  useEffect(() => {
    if (!canShareLink) return // nobody who could see the button — asking would only 403
    let alive = true
    void fetchShareLink(incidentMeta.id, 'atemschutz')
      .then((l) => { if (alive) setAtemschutzLinkOn(l.enabled) })
      .catch(() => { /* an unknown state paints «kein Link» — the sheet is the honest answer */ })
    return () => { alive = false }
  }, [incidentMeta.id, canShareLink])
  // Child sheets suspend their parent rather than destroying it. Their origin decides whether
  // cancel restores Einstellungen/Ansichten/status and whether a completed action closes the
  // entire chain.
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackParent, setFeedbackParent] = useState<'settings' | null>(null)
  const [shareParent, setShareParent] = useState<'settings' | 'views' | 'status' | null>(null)
  const shareStatusRestore = useRef<(() => void) | null>(null)
  // the layers side panel shares the tool docks' on-screen slot, so switching to any drawing
  // tool closes it + the views popover. Kept here (not in useSheets) next to the tactical
  // gesture state it's cleared alongside (enterReplay), so those stay plain useState setters.
  const [panel, setPanel] = useState<'layers' | null>(null)
  // «Trupp finden» (TruppFinder) — an overlay over whatever is on screen, not a surface
  const [findTruppOpen, setFindTruppOpen] = useState(false)
  useEffect(() => { if (tool !== 'select') { setViewsOpen(false); setPanel(null) } }, [tool])
  // measurement tool (distance/height-profile line, or area) — extracted to useMeasure.
  // All ephemeral (never saved); gated on the measure tool being active.
  const measure = useMeasure(tool === 'measure')
  // The surface is remembered across reloads — but only within the SAME Einsatz: a new
  // emergency opens on the Karte, never on whatever tab the last one ended on (lib/prefs ·
  // initialMode, Feldtest Manuel 07.09.). An Atemschutz-Link session has exactly ONE surface,
  // so the remembered one is ignored there: the lite shell renders whatever `mode` says and
  // has no rail to steer back with. Fresh loadPrefs(), not the module-level boot snapshot —
  // an in-session incident switch must see the mode the LAST workspace saved.
  const [mode, setMode] = useState<'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'>(() => initialMode(loadPrefs(), incidentMeta.id, asLink))
  /** The Rapport is a surface now, so «open it» is «go there». Kept as a named helper because
   *  half a dozen entry points say it (Abschluss-Assistent, the print action, the return chip). */
  const openRapport = () => setMode('rapport')
  // «Karte verknüpfen» on a PHONE hops between the plan and the map — there is no room for the
  // two-pane split, so the app follows the mode instead of asking anyone to find the other
  // surface. This one line is the whole bridge; the mode itself lives in lib/georefMode.
  useGeorefSurfaceBridge(setMode)
  // «Fertig»/«Schliessen»/Esc drop reference halves that never found their counterpart, and
  // the toast saying so must fire on WHICHEVER surface the exit happened — on a phone the
  // mode's map half runs with the Whiteboard unmounted, so the handler lives at app level.
  useEffect(() => {
    setGeorefOpenDroppedHandler((k) => toast(
      k === 1
        ? appConfig.copy.whiteboard.georef.openDroppedOne
        : fillTemplate(appConfig.copy.whiteboard.georef.openDroppedMany, { k: String(k) }),
      { icon: 'warn' },
    ))
    return () => setGeorefOpenDroppedHandler(null)
  }, [])
  const georefMode = useGeorefMode()
  const georefActive = !!georefMode.planId
  // «Karte verknüpfen» must not survive navigation to a surface it cannot run on: a notification
  // tap (or the nav rail) can land on Atemschutz/Verlauf mid-pairing, and the armed mode then
  // left a stuck loupe + reticle over a page with no map. `end`, deliberately NOT `dismiss`:
  // «Fertig» semantics — completed pairs are kept and the debounced save is flushed, only the
  // open half-points are dropped (lib/georefMode).
  useEffect(() => {
    if (georefActive && mode !== 'map' && mode !== 'plans') georefDispatch({ type: 'end' })
  }, [georefActive, mode])
  // …nor an Einsatz switch. The mode is a MODULE store; the Whiteboard's own effect dismisses it
  // on a plan switch, but on a phone the Whiteboard is not mounted while the map half runs, so
  // the next workspace inherited a `planId` and armed its mode bars for a plan it does not have.
  useEffect(() => () => georefDispatch({ type: 'dismiss' }), [])
  // diagnostics only — a non-throwing render storm of THIS component gets one beacon + a
  // Rückmeldung prompt; nothing else in the tree can see one (lib/useRenderStorm). The beacon names
  // the open tab and which of these values kept changing (identity checks, nothing deeper).
  useRenderStorm('IncidentWorkspace', {
    context: `tab=${mode}`,
    watch: { objects, layers, fitsVersion, planHistory, journalRows: journal.rows, recent, georefMode },
  })
  const phoneGeoref = isPhone && !!georefMode.planId
  // Demo-only: which surface someone opened, for the public demo's visit statistics. A no-op
  // on every real station (isDemoMode) and in a link session — see lib/visitBeacon.ts.
  useEffect(() => { countSurface(mode, { linkScoped }) }, [mode, linkScoped])
  // `phoneTools` (the second, stacked tool bar → its extra bottom clearances) is computed below,
  // once `planDocs` is known: a viewer-only plan renders NO tool bar, so it must reserve one bar,
  // not two.
  // (Horizontal swipe-to-page between sections is GONE — 2026-08-14. On the tablet it is the
  // primary surface for, an invisible gesture that jumps the whole workspace to another section
  // is a thing you trigger by accident, never on purpose. The NavRail and the `nav` hotkey are
  // the two ways to change section.)
  // tactical-symbol size (Karte / standalone Module; linked Module follow Karte), captions, offline cache radius,
  // keep-screen-on — device prefs shared with the landing Einstellungen (see useDevicePrefs;
  // lazy loadPrefs seed). Their persistence rides the mode/activePlanId effect below.
  const { symbolScale, setSymbolScale, symbolCaptions, setSymbolCaptions, offlineRadiusM, setOfflineRadiusM, offlineAuto, setOfflineAuto, keepScreenOn, setKeepScreenOn, railLabels, setRailLabels } = useDevicePrefs()
  // "Mein Standort": bumping this takes a single GPS fix + flies to it. On-demand (no continuous
  // watch) so the GPS chip isn't powered all shift — see MapView.locateNonce.
  const [locateReq, setLocateReq] = useState(0)
  // Atemschutz doctrine resolves in two tiers here: per-incident synced settings →
  // atemschutzDoctrine() (deployment /api/config override → static appConfig fallback).
  // These already merged values flow to AtemschutzView via props.
  const doctrine = atemschutzDoctrine()
  const azIntervalMin = incidentSettings.contactIntervalMin ?? doctrine.contactIntervalMin
  const azGraceSec = incidentSettings.contactGraceSec ?? doctrine.contactGraceSec
  const azFunkkanal = incidentSettings.defaultFunkkanal ?? doctrine.defaultFunkkanal
  // One-shot confirmation after an update reload (swUpdate stamps sessionStorage before it) —
  // closes the loop the reload cut off: the operator sees the new build actually landed.
  useEffect(() => {
    if (consumeJustUpdated()) toast(fillTemplate(appConfig.copy.update.updated, { v: buildLabel() }), { icon: 'check', tone: 'success' })
  }, [])
  /**
   * Keep every Trupp's placement join pointing at where its marker actually STANDS — and free it
   * when the marker is gone, so «Platzieren» comes back instead of pointing at nothing (the
   * button is gated on the join being empty).
   *
   * ⚠️ ONE effect over the store, because which surface a marker stands on is its ANCHOR
   * (lib/placedTrupps · markerSite) and no longer «which collection holds its id»: the Karte
   * draws plan-anchored objects too. As two membership tests this went wrong in both directions
   * — a chip dragged off its sheet onto the Karte lost its Trupp entirely (the anno left `board`,
   * so the plan half freed itself), and one dragged the other way kept an `entityId` naming a
   * surface it had left. The join follows the anchor instead.
   */
  useEffect(() => {
    setTrupps((ts) => {
      let changed = false
      const next = ts.map((t) => {
        const markerId = t.entityId ?? t.annoId
        if (!markerId) return t
        const site = markerSite(markerId, objects)
        if (!site) { changed = true; return { ...t, entityId: undefined, annoId: undefined, planId: undefined } }
        if (site.kind === 'map') {
          if (t.entityId === markerId && !t.annoId && !t.planId) return t
          changed = true
          return { ...t, entityId: markerId, annoId: undefined, planId: undefined }
        }
        if (t.annoId === markerId && t.planId === site.planId && !t.entityId) return t
        changed = true
        return { ...t, annoId: markerId, planId: site.planId, entityId: undefined }
      })
      return changed ? next : ts
    })
  }, [objects, setTrupps])
  // What the bell actually controls: per-device, but scoped to THIS Einsatz — a tablet muted at a
  // drill in February is armed again for the next one (see useAtemschutzMute). `audioBlocked` is
  // the third honest state: the browser has not released audio, so only the OS notification can
  // fire and the bell says so instead of claiming to be on.
  const { muted: atemschutzMuted, mute: muteAtemschutz, toggle: toggleAtemschutzMuted, audioBlocked: atemschutzAudioBlocked, unlockAudio: unlockAtemschutzAudio } = useAtemschutzMute(incidentMeta.id)
  // how the Atemschutz board is arranged — a way of LOOKING at it, so per device. The hand-set
  // order it can show (Trupp.order) is synced, so «wie gesetzt» is the same board everywhere.
  const [atemschutzOrder, setAtemschutzOrderState] = useState<TruppOrder>(() => loadPrefs().atemschutzOrder ?? 'manuell')
  const setAtemschutzOrder = (o: TruppOrder) => { setAtemschutzOrderState(o); savePrefs({ ...loadPrefs(), atemschutzOrder: o }) }
  // Which linked sheets this device lays under the Karte as a raster. A DEVICE pref like every
  // other «what am I looking at» switch, persisted the way `atemschutzOrder` above is: seeded
  // lazily from the cookie, written on the toggle. The `twin:` prefix is what the persisted keys
  // have always said (lib/prefs) — renaming it would rewrite device preferences for a word.
  const [twinLayers, setTwinLayers] = useState<Record<string, boolean>>(() => loadPrefs().twinLayers ?? {})
  const [twinLayerOpacity, setTwinLayerOpacity] = useState<Record<string, number>>(() => loadPrefs().twinLayerOpacity ?? {})
  const [mapSuppressedCaptions, setMapSuppressedCaptions] = useState<ReadonlySet<string>>(new Set())
  /**
   * ⚠️ The cookie write happens OUTSIDE the updater, exactly as `setAtemschutzOrder` above does
   * it. React runs updater functions during the render phase — and twice under StrictMode — so a
   * `savePrefs` inside one is a side effect on an unpredictable schedule, which is the one thing
   * an updater may not contain. These three setters used to do it inside; the comment above even
   * claimed they were "persisted the same way `atemschutzOrder` is", which is precisely what they
   * were not doing.
   */
  const persistTwinLayers = (next: Record<string, boolean>) => {
    setTwinLayers(next)
    savePrefs({ ...loadPrefs(), twinLayers: next })
  }
  const toggleTwinLayer = (id: string) => persistTwinLayers({ ...twinLayers, [id]: !twinVisible(twinLayers, id) })
  // a Rapport checklist row navigated to Anwesenheit/Mittel → offer the one-tap way back
  const [rapportReturn, setRapportReturn] = useState(false)
  // the Verlauf drawer sits BELOW the Rapport sheet (z 61 vs 80), so opening it from the
  // checklist closes the sheet and reopens it when the Verlauf closes — a real round trip
  const [journalFromRapport, setJournalFromRapport] = useState(false)
  // leaving those surfaces for anything else ends the round trip (no stale chip later)
  useEffect(() => { if (mode !== 'anwesenheit' && mode !== 'mittel') setRapportReturn(false) }, [mode])
  // per-object backend module plans (auto-surfaced near object, or a manual PlanPicker override),
  // plus the resolved plan-doc list with module PDFs swapped in — see useObjectPlans.
  // The binding options freeze each surfaced sheet on first contact: which dataset revision,
  // which fit. Sheets that already carry ink under a legacy station fit keep that fit; a whole
  // workspace from before bindings existed (content, no bindings) preserves ALL its fits.
  const legacyPlanIds = useMemo(() => new Set(Object.keys(board).filter((id) => board[id]?.length)), [board])
  const preserveLegacy = useMemo(
    () => !bootGate.ws?.planBindings?.length && hasLegacyAlignmentContext(bootGate.ws),
    [],  // eslint-disable-line react-hooks/exhaustive-deps
  )
  const { backendPlans, resolvedPlanDocs, manualObject, activeObjectName, activeObjectAddress, activeObjectPos, activeObjectNearby, pickObject, resetObject, activeObjectId } = useObjectPlans(incidentMeta.id, incidentView.center, setActivePlanId, pickedObjectId, setPickedObjectId, {
    bindings: planBindings,
    onBind: (proposed) => { if (!readOnly) setPlanBindings((prev) => fillBindingFloors(addPlanBindings(prev, proposed), proposed)) },
    legacyPlanIds,
    preserveLegacy,
  })

  // PWA: pre-download the current map area + plans/symbols/geodata so the base map and
  // reference data render offline at the scene (delivers the `offline`/`cachedTiles` promise).
  // One box around the incident (editable radius) — caches the map AND crops the region-wide
  // Leitungskataster GeoJSON to the scene via a `bbox` query the backend honours. A FIXED box
  // (not unioned with the viewport) keeps the tile count predictable on a memory-tight iPad.
  const incidentBounds = useMemo(() => {
    const [clng, clat] = incidentView.center
    const dLat = offlineRadiusM / 111320
    const dLng = offlineRadiusM / (111320 * Math.cos((clat * Math.PI) / 180))
    return { west: clng - dLng, south: clat - dLat, east: clng + dLng, north: clat + dLat }
  }, [incidentView.center, offlineRadiusM])
  const geoBbox = useMemo(
    () => `bbox=${incidentBounds.west.toFixed(5)},${incidentBounds.south.toFixed(5)},${incidentBounds.east.toFixed(5)},${incidentBounds.north.toFixed(5)}`,
    [incidentBounds],
  )
  // append the incident bbox to a reference/geo: URL so render + offline cache pull the SAME
  // cropped slice (non-geo URLs pass through unchanged).
  const withGeoBbox = useCallback(
    (url: string) => (url.includes('/api/reference/geo:') ? `${url}${url.includes('?') ? '&' : '?'}${geoBbox}` : url),
    [geoBbox],
  )
  // Online: render the FULL region-wide geodata (e.g. all PV-Anlagen across town), not just the
  // incident box — an operator zooming out expects to see the whole town. Offline: fall back to
  // the cropped `bbox` slice, which is exactly what `downloadOffline` warmed into the SW cache.
  const online = useOnline()

  const [offlineProgress, setOfflineProgress] = useState<{ done: number; total: number } | null>(null)
  // The running download's controller. Aborting stops the tile workers (offlineTiles · signal);
  // `cancelOffline` is what the sheet's «Abbrechen» will call, and the unmount effect below
  // calls it so an Einsatz switch does not leave three workers pulling tiles for a map nobody
  // is looking at.
  const offlineAbort = useRef<AbortController | null>(null)
  const cancelOffline = useCallback(() => { offlineAbort.current?.abort() }, [])
  useEffect(() => cancelOffline, [cancelOffline])
  // `quiet` = the automatic self-warm (Offline-Vorbereitung, see the effect below): no dialogs,
  // no toasts — the Offline-Bereitschaft sheet is where the resulting truth is read. A tight
  // storage budget silently takes the reduced download instead of asking; the manual button
  // remains the place where that trade is offered as a question.
  const downloadOffline = useCallback(async ({ quiet = false } = {}) => {
    const map = mapRef.current?.getMap()
    if (!map) return
    const base = layers.find((l) => l.base && l.visible)
    const templates = base?.tiles ?? cartoRasterTiles('rastertiles/voyager', ['a'])
    const rasterOverlays = layers.filter((l) => !l.base && l.tiles?.length).map((l) => l.tiles as string[])
    const bounds = incidentBounds
    // warm: per-object plan PDFs and the geojson overlays cropped to the box. NOT the symbol
    // library — it is a bundled asset (Workbox precaches every .json in the build) and the app
    // stopped reading the backend's copy of it entirely (lib/useSymbols · 01.09.).
    const warmUrls = [
      ...Object.values(backendPlans),
      ...layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
    ]
    // Pre-flight: everything cached for offline shares ONE origin quota, so a download into a
    // nearly-full bucket used to succeed at the expense of whatever wrote next — the incident
    // record. Predict the cost and, when it won't fit, offer the reduced download instead of
    // silently starting a doomed one. An unknown budget is never treated as a full one.
    const HARD_CAP = 1200
    const coverageTileCount = Math.min(tilesForBounds(bounds, 14, 17).length, HARD_CAP)
    const rasterSourceCount = 1 + rasterOverlays.length
    const tileCount = coverageTileCount * rasterSourceCount
    const extraBytes = warmUrls.length * WARM_BYTES
    const budget = await estimateStorage()
    const fit = prefetchFit(budget, tileCount, extraBytes)
    let cap = HARD_CAP
    if (!fit.fits && budget) {
      const co = appConfig.copy.offline
      const reducedTotal = fittedTileCap(budget, HARD_CAP * rasterSourceCount, extraBytes)
      const reduced = Math.floor(reducedTotal / rasterSourceCount)
      if (reduced === 0) {
        // not even the plans fit — nothing useful to offer but the honest refusal
        if (!quiet) toast(fillTemplate(co.dlNoSpace, { free: fmtFileSize(budget.free) }), { icon: 'map', tone: 'warn' })
        return
      }
      if (!quiet) {
        const ok = await confirmDialog({
          title: co.dlTightTitle,
          message: fillTemplate(co.dlTightMsg, {
            need: fmtFileSize(fit.needBytes), free: fmtFileSize(budget.free), pct: String(Math.round((reduced / coverageTileCount) * 100)),
          }),
          confirmLabel: co.dlTightConfirm,
          cancelLabel: appConfig.copy.cancel,
        })
        if (!ok) return
      }
      cap = reduced
    }
    setOfflineProgress({ done: 0, total: 1 })
    const ctrl = new AbortController()
    offlineAbort.current = ctrl
    // throttle progress to whole-percent changes so we don't re-render this (huge) component
    // ~750× during the download — a real contributor to memory/CPU pressure on the device.
    let lastPct = -1
    try {
      const res = await predownloadArea({
        templates,
        overlayTemplates: rasterOverlays,
        bounds,
        minZoom: 14,
        // z17 (building-level), not 18: z18 ~4× the tiles and OOMs an iPad mid-download
        maxZoom: 17,
        cap,
        warmUrls,
        signal: ctrl.signal,
        onProgress: (done, total) => {
          const pct = total ? Math.floor((done / total) * 100) : 0
          if (pct !== lastPct) { lastPct = pct; setOfflineProgress({ done, total }) }
        },
      })
      // ⚠️ FOUR OUTCOMES, FOUR MESSAGES — not one message with different numbers. The bar
      // reaches 100 % whatever happens (it counts attempts finished, and it has to, or a dead
      // host would hang it for ever), so «fertig» said nothing about «geklappt»: tapped in the
      // Magazin on dead WLAN this toasted a green «Karte offline verfügbar (0 Kacheln)», and the
      // one figure that contradicted it stood in a bracket nobody reads at 03:10. Green is now
      // earned: it needs every FETCHABLE tile AND every plan/Ebene to have come back — a 404 is
      // not a miss (the tile does not exist at a layer's edge; «Weiterladen» could never fill
      // it, so counting it kept «Teilweise geladen» on screen for ever). Only retryable
      // failures (network/5xx) make the download partial. And all-404 with zero hits is its own
      // sentence: the source has no coverage here (or the Kachel-URL is wrong) — «kein Netz»
      // would mis-describe a host that answered every single request.
      const co = appConfig.copy.offline
      const got = res.fetched + res.warmFetched
      const retry = { label: co.dlRetry, onClick: () => { void downloadOfflineRef.current() } }
      if (quiet) return // self-warm: the Offline-Bereitschaft sheet reports the resulting truth
      if (got === 0 && res.failed > 0) {
        toast(co.dlNone, { icon: 'map', tone: 'warn', action: retry })
      } else if (got === 0 && res.notFound > 0) {
        // no retry offer: every request was answered, retrying returns the same 404s
        toast(co.dlNoCoverage, { icon: 'map', tone: 'warn' })
      } else if (res.failed > 0) {
        // capped AND partial: keep saying «Ausschnitt begrenzt», or «Weiterladen» promises
        // tiles the cap will exclude again
        toast(fillTemplate(res.capped ? co.dlPartialCapped : co.dlPartial, { n: got, total: got + res.failed }), { icon: 'map', tone: 'warn', action: { ...retry, label: co.dlContinue } })
      } else {
        toast(fillTemplate(res.capped ? co.dlDoneCapped : co.dlDone, { n: res.fetched }), { icon: 'map', tone: 'success' })
      }
    } catch {
      // a cancel is not a failure: the operator (or the unmount) asked for it, nothing to report
      if (!quiet && !ctrl.signal.aborted) toast(appConfig.copy.offline.dlFailed, { icon: 'map', tone: 'warn' })
    } finally {
      if (offlineAbort.current === ctrl) offlineAbort.current = null
      setOfflineProgress(null)
    }
  }, [layers, backendPlans, incidentBounds, withGeoBbox])
  // «Weiterladen» / «Nochmals» re-runs the same download. Through a ref because the action rides
  // on a toast that outlives the render it was made in, and the callback cannot name itself.
  const downloadOfflineRef = useRef(downloadOffline)
  useEffect(() => { downloadOfflineRef.current = downloadOffline }, [downloadOffline])
  // ── Offline-Vorbereitung: the device prepares ITSELF (28.08. field feedback) ──
  // The button relied on someone remembering it before losing coverage. Now, ~30 s after an
  // Einsatz is open (long enough for the map, plans and layer list to have settled), the same
  // download runs quietly — installed app only, exactly like the sheet's own reasoning: a
  // browser tab's cache is evicted too readily to call it «bereit». Re-armed when what there is
  // to warm changes (another Objekt's plans, a new Leitungs-Ebene), so a plan attached mid-
  // incident still gets pulled; the signature keeps one warm per state, not one per minute.
  // «Nur manuell» (device pref) switches all of this off; the button always stays.
  // …and re-armed when the operator grows the offline radius (29.08.): the readiness probe
  // measures against the CURRENT bbox, so a warm run for the old radius would keep reporting
  // «nicht geladen» forever. Centre and raster-reference ids are explicit too: a corrected
  // Einsatz location or newly configured WMS/WMTS layer owes the device another warm pass.
  const offlineWarmSig = `${incidentMeta.id}|${incidentView.center.join(',')}|${offlineRadiusM}|${Object.values(backendPlans).sort().join(',')}|${layers.filter((l) => l.geojson || (!l.base && l.tiles?.length)).map((l) => l.id).join(',')}`
  const offlineWarmed = useRef('')
  useEffect(() => {
    if (!offlineAuto || !isStandalone()) return
    if (offlineWarmed.current === offlineWarmSig) return
    const t = setTimeout(() => {
      if (!navigator.onLine || isStorageDegraded()) return // this round stays owed — the ref is only stamped on a start
      offlineWarmed.current = offlineWarmSig
      void downloadOfflineRef.current({ quiet: true })
    }, 30_000)
    return () => clearTimeout(t)
  }, [offlineAuto, offlineWarmSig])
  // the Gebäude (floor-stack) document only exists once a building is picked; it sits
  // directly after «Umrisse» (the OSM outline you pick the building from) in the CATALOG —
  // the rail shows the two as one morphing tile (railPlanDocs below).
  // during replay the floor-stack tab follows the RECONSTRUCTED building, so the past
  // plan list matches the past state (Gebäude appears iff a building existed back then)
  const effBuilding = replayActive ? replayBuilding : building
  // during replay the Atemschutz/Anwesenheit surfaces show the RECONSTRUCTED past state (the
  // views are read-only then) so scrubbing moves Trupp status + attendance back in time too
  // The replay-aware Trupp list. Every surface that DRAWS a Trupp (the Atemschutz board, and the
  // hose tags on Lage + Plan) reads this one, so a replayed picture names who was on the line
  // THEN — the live list would paint today's links onto a two-hour-old scene.
  const effTrupps = replayActive ? (replayWs?.trupps ?? []) : trupps
  const effAttendance = replayActive ? (replayWs?.attendance ?? {}) : attendance
  const effShifts = replayActive ? (replayWs?.shifts ?? []) : shifts
  const effBands = replayActive ? (replayWs?.bands ?? []) : bands
  // during replay the Mittel log is reconstructed from the scrubbed-instant workspace blob
  const effMittel = replayActive ? ((replayWs?.mittel as MittelEntry[] | undefined) ?? []) : mittel
  // The plan CATALOG — every document this incident can address by id. Everything that looks a
  // plan up (the board, the Verlauf's row labels, the Rapport's page list, placedTrupps, the
  // Whiteboard itself) reads this one, so `osm` keeps resolving even once a Gebäude exists.
  const planDocs = useMemo(() => {
    if (!effBuilding) return resolvedPlanDocs
    const out = [...resolvedPlanDocs]
    const osmIdx = out.findIndex((p) => p.id === BUILDING_PICK_ID)
    out.splice(osmIdx >= 0 ? osmIdx + 1 : out.length, 0, gebaeudeDoc)
    return out
  }, [effBuilding, resolvedPlanDocs])
  // …and the LEISTE's version of it, where «Umrisse» and «Gebäude» are one tile that morphs
  // (23.08.). Two tiles for one building was the mechanism showing through: you picked on the
  // first and worked on the second, and the first stayed in the rail forever afterwards doing
  // nothing. See lib/useObjectPlans · railPlanTiles for why the two ids survive the merge.
  const railPlanDocs = useMemo(() => railPlanTiles(planDocs, activePlanId), [planDocs, activePlanId])
  // ⚠️ The live values the timeline's plan entries read (see `planStepAt`).
  // A step is pressed long after the render that recorded it, so nothing there may close over
  // this render's `board`, `activePlanId` or plan titles.
  const boardRef = useRef(board); boardRef.current = board
  const activePlanIdRef = useRef(activePlanId); activePlanIdRef.current = activePlanId
  const planLabelRef = useRef<(id: string) => string>(() => '')
  planLabelRef.current = (id) => planDocs.find((p) => p.id === id)?.title ?? id

  // both bars are stacked on the two drawing surfaces (tool bar above the surface bar) — this drives
  // the extra bottom clearances for FAB / docks / stage / whiteboard on phones. A viewer-only plan
  // (e.g. Modul 6 Gebäudepläne) renders no tool bar, so it gets ONE bar of clearance, not two —
  // otherwise the empty tool-bar lane blocks the PDF from scrolling to the bottom nav.
  // ⚠️ A half-typed Mittel (or guest) belongs to the Einsatz it was started on. Switching
  // incidents drops every kept draft, so the next one can never be handed the previous one's
  // entry — see lib/draftKeep.
  useEffect(() => { clearAllDrafts() }, [incidentMeta.id])
  // The Checkliste templates load the moment an Einsatz opens, not when the tab is first tapped
  // (lib/checklists · warmTemplates): the surface opens on a list that is already there, and the
  // offline cache is filled while there is still a network to fill it from.
  useEffect(() => { void warmTemplates().list }, [incidentMeta.id])
  // A plan surface that shows no tool bar at all: an admin-configured module viewer, or the
  // select-only Umrisse (23.08.) — different reasons, same consequence for the phone's lanes.
  const activePlanNoTools = mode === 'plans' && (() => {
    const d = planDocs.find((p) => p.id === activePlanId)
    return d?.viewer === true || isSelectOnlySurface(d)
  })()
  // a LOCKED surface now carries a bar too (the slim rail: Auswahl · Messen on the map,
  // Auswahl only on the plan since Messen left it 29.08.), so it reserves the
  // same two lanes as an editor's — only replay, which renders no rail at all, gets one.
  const phoneTools = isPhone && !replayActive && (mode === 'map' || (mode === 'plans' && !activePlanNoTools))
  // the floating top-right map-utility cluster (zoom · compass · Ebenen), which stands in for the
  // tool rail during replay. It is the ONLY thing the TopBar has to keep clear of on a wide
  // screen — `.map-util` lets the CSS reserve that width exactly when the cluster is there.
  const mapUtility = mode === 'map' && replayActive && !isPhone
  // the slim (read-only) tool rail is showing — on a phone that frees the top bar and the rail
  // footer, so the compass and the weather move back into them (see `.slim-tools` in app.css).
  const slimRail = tacticalLocked && !replayActive
  // published on <html>, not on the app div: the saved-views popover is portalled to <body>, so
  // a class inside the app cannot reach it (same reason the rail publishes --vrail-w up here).
  useEffect(() => {
    document.documentElement.classList.toggle('slim-tools', slimRail)
    return () => document.documentElement.classList.remove('slim-tools')
  }, [slimRail])

  // the flat nav order (matches NavRail) — map, EACH rail tile, then the sections. The `nav`
  // hotkey steps one destination at a time, so it walks through the modules individually instead
  // of collapsing to whatever plan was last open (the Gebäude).
  // ⚠️ The RAIL list, not the catalog: ⌘[ / ⌘] steps what the rail shows, so the merged Gebäude
  // tile is one stop, not two. Stepping onto an «Umrisse» stop that has no tile to land on is
  // exactly the chevron-lands-nowhere bug the merge exists to remove — and the SAME rule is why
  // the Rapport is a stop (it has always been a tile, and a surface the stepping could reach but
  // never leave is that bug in its worst form) and why Anwesenheit and Material stop being stops
  // once the phone bar folds them into it (18.09.2026): there is no tile to land on, and the
  // mode redirect below would bounce the step onward to the Rapport anyway.
  const navList = useMemo(() => navStops(railPlanDocs.map((d) => d.id), phoneFold), [railPlanDocs, phoneFold])
  const goToNav = (dir: -1 | 1) => {
    const cur = navList.findIndex((n) => n.mode === mode && (n.mode !== 'plans' || n.planId === activePlanId))
    const next = cur >= 0 ? navList[cur + dir] : undefined
    if (!next) return
    // stepping to the next section leaves the map exactly as the nav rail does — see clearMapUi.
    // (Defined further down; this only ever runs from a key, never at render time, same as
    // enterReplay.)
    if (next.mode !== mode) clearMapUi()
    if (next.mode === 'plans') { setMode('plans'); setActivePlanId(next.planId) }
    else setMode(next.mode)
  }
  // if the active plan vanished, fall back to the first available plan so the sidebar stays
  // in sync — BUT don't bump away from a remembered plan that's merely still loading: module
  // PDFs are filtered out of planDocs until their backend URL arrives, so a restored 'modul6'
  // would otherwise get reset to osm before the module loads. Only reset truly-unknown ids.
  useEffect(() => {
    if (!planDocs.length) return
    if (planDocs.some((p) => p.id === activePlanId)) return // valid + present
    const stillLoading = planDocuments.some((p) => p.id === activePlanId) || activePlanId === gebaeudeDoc.id
    if (stillLoading) return // known plan, just not loaded yet — keep it
    setActivePlanId(planDocs[0].id)
  }, [planDocs, activePlanId])
  // unified journal (Verlauf): a single append-only stream shared by both
  // surfaces, plus its quick-add composer — both reachable from the TopBar.
  const [journalOpen, setJournalOpen] = useState(false)
  /** «Show me that card»: alarm and attendance routes carry a nonce so tapping the same Trupp
   *  twice points again. Pointing is a gesture, not durable state; AtemschutzView clears its
   *  highlight on its own timer. */
  const [truppFocus, setTruppFocus] = useState<{ id: string; nonce: number } | null>(null)
  /** «Neuer Trupp» from a loose marker/chip (14.09.): open the Anmeldung, and on save the new
   *  Trupp adopts that marker. Same nonce grammar as `truppFocus` — a repeat tap opens again. */
  const [truppCreate, setTruppCreate] = useState<{ nonce: number; adoptMarkerId: string } | null>(null)

  // a tapped system notification (handled in public/sw-notify.js) posts here to open the
  // relevant tab — an Atemschutz alarm jumps to the Atemschutz view, a due Wiedervorlage
  // opens the Verlauf where reminders live. If the tap COLD-STARTED a killed app the target
  // arrives as the ?kpn= boot param instead (a postMessage would land before this listener
  // exists); claim is one-shot so an incident switch can't re-route the same tap.
  useEffect(() => {
    const route = (target: unknown) => {
      if (typeof target !== 'string') return
      // 'atemschutz:<truppId>' lands ON the overdue Trupp's card; the bare 'atemschutz' (older
      // service workers, older server pushes) keeps opening the board without a focus.
      if (target === 'atemschutz' || target.startsWith('atemschutz:')) {
        setMode('atemschutz')
        const truppId = target.startsWith('atemschutz:') ? target.slice('atemschutz:'.length) : ''
        if (truppId) setTruppFocus({ id: truppId, nonce: Date.now() })
      } else if (target === 'journal') setJournalOpen(true)
    }
    route(claimBootNotifyTarget(['atemschutz', 'journal']))
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
    if (!sw) return
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'kp-notification-click') route(e.data.target)
    }
    sw.addEventListener('message', onMsg)
    return () => sw.removeEventListener('message', onMsg)
  }, [])
  const [composerOpen, setComposerOpen] = useState(false)
  /** the Pendenz the composer is writing a Meldung on — set by tapping its row in the Verlauf.
   *  Cleared whenever the composer closes, so the next ordinary «Eintrag» is never still linked. */
  const [noteOn, setNoteOn] = useState<{ id: string; text: string } | null>(null)
  /** the Suche status change the entry being written carries (Tür 2, components/JournalComposer) */
  const [sucheLink, setSucheLink] = useState<SucheComposerLink | null>(null)
  /** the Suche's writers, built far below (they need the slice's undo) — read at submit time */
  const sucheActionsRef = useRef<SucheActions | null>(null)
  /** a remote hydrate replaced the slices — the Trupp status changes it brought are somebody
   *  else's to ask about at Raus (lib/useSucheTrupps) */
  const sucheRemoteRef = useRef(false)
  // the moment the Eintrag composer opened — used as the entry timestamp (the info was usually
  // relevant / the order given then, not when Erfassen is finally pressed)
  const composerOpenedAt = useRef<string | null>(null)
  useEffect(() => { if (composerOpen) composerOpenedAt.current = new Date().toISOString() }, [composerOpen])
  // a Verlauf row can ask the plan to revisit a point; nonce makes each request distinct
  const [planFocus, setPlanFocus] = useState<{ x: number; y: number; floor: number; annoId?: string; twinEntityId?: string; flash?: boolean; nonce: number } | null>(null)
  // «zeigen» on the Lage: the drawing gets an outline for a couple of seconds and is NOT selected
  // (see MapView · flashDrawingId). Cleared on a timer — pointing is a gesture, not a state.
  const [flashDrawingId, setFlashDrawingId] = useState<string | null>(null)
  useEffect(() => {
    if (!flashDrawingId) return
    const t = setTimeout(() => setFlashDrawingId(null), appConfig.drawing.flashMs)
    return () => clearTimeout(t)
  }, [flashDrawingId])
  // last reported plan-view centre, so a journal pin on the plan anchors to "here"
  // the note being edited inline with raw text directly on the map — exactly like the Plan
  // whiteboard's text notes (placement auto-edits; double-click re-enters; single tap just selects)
  const [editNoteId, setEditNoteId] = useState<string | null>(null)
  // true once a live title edit has snapshotted for undo, so we beginDrag once per edit
  // session and fold the whole keystroke stream into a single undo step on blur
  const titleLiveRef = useRef(false)
  // stream a note's raw text live (silent — snapshot once for undo), then fold the whole
  // edit into one undo step + a single audit event on blur. Mirrors the title editor.
  const noteTextLive = (id: string, v: string) => {
    if (tacticalLocked) return // setDocRaw bypasses commit's readOnly gate — a viewer must not type here
    // …and the Verlauf's settle window learns that this note is still being written: the canvas
    // editor is not inside a panel, so focus alone cannot tell (see noteEntityEdit)
    entityTypedAt.current.set(id, Date.now())
    if (!titleLiveRef.current) { titleLiveRef.current = true; beginDrag() }
    // a note that has never been resized by hand follows what is typed (lib/notes) — it grows
    // out of the minimum and stops at the maximum, where it wraps as it always did
    setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id
      ? { ...e, label: v, ...(e.noteAutoW ? { noteW: autoNoteWPx(v, e.noteSize) } : null) }
      : e)) }))
  }
  const noteTextCommit = (id: string, v: string) => {
    if (tacticalLocked) { setEditNoteId(null); return }
    if (titleLiveRef.current) { titleLiveRef.current = false; endDrag(); emit('entity.edit', { id, patch: { label: v } }) }
    else patchEntity(id, { label: v })
    setEditNoteId(null)
  }
  // which note has its detail panel open. NOT derived from selectedId: unlike a symbol, selecting
  // a note stays quiet — it is placed mid-sentence and a panel sliding in on every tap would be
  // in the way. Only the ⚙ handle sets this.
  const [notePanelId, setNotePanelId] = useState<string | null>(null)
  // …and which of them was just PLACED, so its panel opens with the caret in the text field. A
  // one-shot: reopening the same note later is an ordinary read and must not grab the keyboard.
  const [notePlacedId, setNotePlacedId] = useState<string | null>(null)
  // style the NEXT note carries, chosen in the armed-tool dock before anything is placed
  const [noteDefaults, setNoteDefaults] = useState<{ size: NoteSize; plain: boolean; color: string }>(
    { size: 'm', plain: false, color: '' },
  )
  const [view, setView] = useState<{ bearing: number; center: LngLat; zoom: number }>({ bearing: 0, center: incidentView.center, zoom: getDeploymentConfig().map?.defaultView?.zoom ?? 17.6 })
  // coordinate picker (one-shot crosshair + LV95/WGS84 readout) — extracted to useCoordPicker.
  const coord = useCoordPicker(false, view.center)

  // --- audit capture (substrate A): batch client tactical events, flush debounced (see useAuditEvents) ---
  // ⚠️ SCOPED to what this role may append (lib/eventScope, 24.09.2026): the `el` phone runs
  // the Atemschutz alarm engine like every device, and its `atemschutz.*` events 403'd into an
  // outbox that stayed red for the whole Einsatz.
  const auditScope = useMemo(() => eventScopeFor(user), [user?.role, user?.link_kind]) // eslint-disable-line react-hooks/exhaustive-deps
  const auditDelivery = useAuditEvents(incidentMeta.id, readOnly, user ? `${user.id}:${user.link_kind ?? 'login'}` : null, auditScope)
  const { emit, flushEvents, flushEventsBeacon } = auditDelivery

  // Weather for the incident location. Polled live; each NEW observation is recorded as a
  // `weather.observe` event so the replay fold can show the wind/condition as it stood at any
  // past instant (see lib/replay · stateAt). During replay the badge reads the folded reading.
  const liveWeather = useWeather(incidentView.center)
  const lastWxAt = useRef<string | null>(null)
  useEffect(() => {
    const w = liveWeather.data
    if (!canWriteRecord || !w || !w.observed_at || w.observed_at === lastWxAt.current) return
    lastWxAt.current = w.observed_at
    emit('weather.observe', { weather: w })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveWeather.data, canWriteRecord])
  const displayWeather = replayActive ? (replayWs?.weather ?? null) : liveWeather.data
  const openWeatherDetails = useCallback(() => {
    const [lng, lat] = incidentView.center
    const url = appConfig.copy.weather.detailsUrl.replace('{lat}', String(lat)).replace('{lng}', String(lng))
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [incidentView.center])

  // Honest reporting for the workspace load gate — once per incident mount, so a persistently
  // malformed server blob (re-applied on every poll) nudges the operator once, not endlessly.
  const gateWarned = useRef(false)
  const reportGate = useCallback((g: WorkspaceGate) => {
    if (gateWarned.current || (g.dropped === 0 && !g.newerSchema)) return
    gateWarned.current = true
    if (g.dropped > 0) toast(fillTemplate(appConfig.copy.offline.wsDropped, { n: g.dropped }), { icon: 'warn', tone: 'warn' })
    if (g.newerSchema) toast(appConfig.copy.offline.wsNewer, { icon: 'warn', tone: 'warn' })
  }, [])
  useEffect(() => { reportGate(bootGate) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Write an authoritative workspace (conflict take-server or live-follow poll) into App's
  // state slices. useIncidentSync wraps this with its skip-save guard and drives it from the
  // poll/auto-merge paths; the state lives here, so the writer does too.
  // …reached through a ref because the Anwesenheit's history is created much further down (it
  // needs the roster and the attendance actions), while this merge path has to exist up here.
  // Same shape as `planHist` below.
  const attHistClear = useRef<(() => void) | null>(null)
  // …and the ghost-trail reconciliation's re-seed, for the same reason: the hook that owns it
  // (lib/useGhostTrails) needs the tactical store, which is built further down.
  const ghostReseedRef = useRef<(() => void) | null>(null)
  /* The blob's `layerState` as it stands on the SERVER — carried through untouched.
   *
   * Which Ebenen are on is a device preference now (lib/layerPrefs), so this device's toggles
   * must not travel; but the field is not ours to empty either. It is what `lib/replay` folds
   * `layer.toggle` onto when an old Einsatz is scrubbed, and it is the one-time seed a second
   * device reads on its first open (lib/workspace · deriveInitial). So: never written from the
   * live layers, never wiped — whatever the record already says goes back unchanged. */
  const syncedLayerState = useRef<Saved['layerState']>(bootGate.ws?.layerState ?? [])
  const applyWorkspace = useCallback((ws: Saved) => {
    const gate = sanitizeWorkspace(ws)
    reportGate(gate)
    syncedLayerState.current = gate.ws?.layerState ?? []
    const next = deriveInitial(gate.ws, incidentMeta.id, prefs, incidentMeta.type)
    // replaceObjects swaps the whole store — the Karte AND every sheet, they are one collection
    // now — AND drops undo history (the local stacks no longer apply to remote/merged state:
    // undoing into it would resurrect remotely-deleted content).
    replaceObjects(next.objects); setLayers(next.layers); journal.ingestLegacy(next.timeline)
    setRecent(next.recent); setBuilding(next.building)
    setVehicleOverrides(next.vehicleOverrides); setChecklists(next.checklists); setTrupps(next.trupps); setAttendance(next.attendance); setMittel(next.mittel); setShifts(next.shifts); setBands(next.bands); setCameraViews(next.cameraViews); setTrails(next.trails); setPlanScale(next.planScale); setReportMeta(next.reportMeta); setAttachments(next.attachments); setSuche(next.suche); sucheRemoteRef.current = true; setIncidentSettings(next.settings); setPlanBindings(next.planBindings); setPickedObjectId(next.pickedObjectId); setIntakeReviewedAt(next.intakeReviewedAt)
    // …and the Anwesenheit's own stack goes with it, for the same reason: it holds snapshots of a
    // list that no longer exists, and stepping into one would write this device's rows back over
    // what another device just merged in. The Plan's stacks go too — they now outlive the board's
    // unmount (see `planHistory`), so nothing else drops them any more.
    attHistClear.current?.(); setPlanHistory({})
    // …and the ghost-trail reconciliation re-seeds instead of running: the store was REPLACED, so
    // every marker on it would read as «vanished» and the merge would ghost the whole picture.
    // Through a ref, because the hook that owns it is declared further down this component.
    ghostReseedRef.current?.()
    // …and every OPEN fold window with them. A burst that is still collecting (a Kurzbericht
    // being typed, a Bildlegende, the Gebäude-Drehung) points at a state the merge has replaced:
    // folding the next write into it would write a pre-merge value back, and — worse — lay no
    // step of its own, so the edit that followed a merge would be the one thing with no way back.
    lastReportStep.current = null; lastCaptionStep.current = null; lastReorient.current = null
    // ⚠️ …and the ONE global timeline goes with ALL of them. This path replaces every slice at
    // once — the doc, the board, the trupps, the Anwesenheit, Mittel, Checklisten — so there is
    // no entry left that describes anything real: a delegating one would step a stack that has
    // just been emptied, and a closure one would write a pre-merge snapshot back over what
    // another device merged in. Dropping the whole timeline is the honest answer, and it is why
    // `invalidate(domain)` exists for the narrower case rather than being used here.
    histClear.current()
    // Drop any selection pointing at an entity/drawing that no longer exists after the merge.
    setSelectedId((id) => (id && next.doc.entities.some((e) => e.id === id) ? id : null))
    setSelectedDrawingId((id) => (id && next.doc.drawings.some((d) => d.id === id) ? id : null))
    setSelectedDrawIds((ids) => ids.filter((id) => next.doc.drawings.some((d) => d.id === id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentMeta.id, incidentMeta.type])

  // Build the workspace blob from the current slices. The memo deps are exactly the persisted
  // slices, so its identity changes iff one of them does — that's what re-fires the save in
  // useIncidentSync (replacing the old slice-keyed persistence effect's dependency array).
  const buildPayload = useCallback((): Saved => {
    /* ⚠️ A `photo` entity never rides the blob: its `photoUrl` is a session `blob:` URL that
     * means nothing on another device or after a reload. Nothing places one any more (it is
     * legacy content), so it is kept on screen for as long as the incident is open and dropped
     * HERE — at the wire, from the store and from its views together, so the two cannot
     * disagree about what was saved. */
    const persisted = objects.filter((o) => o.entity?.kind !== 'photo')
    const views = viewsOf(persisted)
    return {
    objects: persisted,
    entities: views.entities,
    drawings: views.drawings, recent, board: views.board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, trupps: allTrupps, attendance, mittel, shifts, bands, cameraViews, trails, planScale, reportMeta, attachments, settings: incidentSettings, planBindings, intakeReviewedAt,
    // the Suche rides only once it holds something — an Einsatz that never opened it carries no key
    ...(suche.personen.length || suche.bereiche.length ? { suche } : {}),
    // ⚠️ NOT `layers` — the Ebenen this device is looking at stay on this device (see
    // syncedLayerState above and lib/layerPrefs). The record's own value goes back unchanged.
    layerState: syncedLayerState.current,
    // Verlauf rows live in the journal store now; the blob echoes an older incident's legacy
    // rows only until they're safely on the server, then ships empty forever (see JournalStore).
    timeline: journal.blobTimeline,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
  }
  }, [objects, journal.blobTimeline, recent, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, allTrupps, attendance, mittel, shifts, bands, cameraViews, trails, planScale, reportMeta, attachments, suche, incidentSettings, planBindings, intakeReviewedAt])

  // …and they are remembered here instead, per incident, on this device only. Written on every
  // change (not just on a deliberate toggle) so the set derived at boot — including the
  // category pre-activation — is what this device comes back to.
  useEffect(() => {
    saveLayerPrefs(incidentMeta.id, layers.map((l) => ({ id: l.id, visible: l.visible, opacity: l.opacity })))
  }, [layers, incidentMeta.id])

  // SCBA contact-clock alarm runs app-wide (not just on the Atemschutz surface) so an überfällig
  // Trupp alerts no matter which page is open. Paused during replay (read-only past view).
  // Hosted in a null-rendering child (see AtemschutzAlarmHost): its 1 Hz tick must NOT re-render
  // App — that repainted the whole tree every second a Trupp was in the field (battery drain).
  // Declared up here (not with the Atemschutz block) because the sync loop below reads it.
  const [azAlarm, setAzAlarm] = useState<AtemschutzAlarmState>({ peak: 0, urgent: null, severities: {} })

  // persistence, teardown beacons, live-follow poll (with the tablet sync-race guard),
  // in-place auto-merge apply, and the reactive sync-status badge all live in useIncidentSync.
  const { syncStatus: workspaceSyncStatus, lastSyncedAt, syncNow: syncWorkspaceNow, clockSkewMs } = useIncidentSync({
    sync, readOnly, incidentId: incidentMeta.id,
    buildPayload, applyWorkspace, flushEvents, flushEventsBeacon,
    // attendance-divergence note (both sides changed the same person → one Verlauf row)
    // Not for an Atemschutz-Link session: the server refuses every non-«team» row from it (403,
    // deliberately not a 422), and a refused row at the head of the outbox would block the
    // Kontakt rows queued behind it. Attendance conflicts are not that session's business.
    appendJournal: canWriteRecord ? journal.append : undefined,
    // a ringing device polls fast even when hidden — the Funkkontakt that ends its alarm is
    // usually entered on another device and arrives via this very poll
    alarmUrgent: azAlarm.peak >= 2,
    // a Karte drag, a plan step, or typing (the Rapport saves per keystroke): while one is open
    // and a push is owed, the save skips its whole-blob compare
    gestureOpen: () => gestureOpen() || isTypingTarget(document.activeElement),
  })
  // The record outboxes alone — what the media drain waits for (below). The badge's status adds
  // the media queue to it once that exists (`syncStatus`, after useMediaQueue).
  const recordsSyncStatus = combinedSyncStatus(workspaceSyncStatus, journal.syncStatus, auditDelivery.status)

  // Publish this device's «Einsatzdaten geprüft» to the crew. The question belongs to the Einsatz,
  // not to the tablet it was answered on (lib/incidentAlerts), and this component is the only
  // writer of the incident's blob — so whichever way it was answered here (App's markReviewed
  // takes both «Passt» and a saved correction) the stamp goes out with the next save and every
  // other device drops the banner on its next poll. Auto-opened Einsätze only: a hand-typed one
  // was never up for review, and stamping it would dirty the blob for nothing.
  useEffect(() => {
    // `isEl` too: the stamp lives outside the record slice, so an el write would only ever
    // reach this device — the banner would drop here and stand everywhere else, a silent lie
    if (!canWriteRecord || isEl || !reviewedLocallyAt || intakeReviewedAt || !incidentMeta.auto_opened) return
    setIntakeReviewedAt(reviewedLocallyAt)
  }, [canWriteRecord, isEl, reviewedLocallyAt, intakeReviewedAt, incidentMeta.auto_opened, setIntakeReviewedAt])

  // Keep the screen awake while an incident workspace is open (this component only mounts for an
  // open incident) — so the map never dims/sleeps mid-operation on a station/vehicle tablet.
  // Default on, but a per-device toggle (Einstellungen) lets a personal/background device opt out
  // and save battery. No-ops on browsers without the Wake Lock API.
  useWakeLock(keepScreenOn)

  // (The Einstellungen sheet no longer writes the Atemschutz safety values — 28.08., they are
  // /admin doctrine now. `incidentSettings` overrides already stored in workspaces keep applying;
  // the settle-and-log machinery that guarded their edits left with the editor.)

  /**
   * Rapportangaben with a Verlaufszeile. The printed rapport's own content — Einsatzleiter,
   * Endezeit, Gerettete, Partnerorganisationen, die Alarm-/Fahrzeugzeiten — changed through a
   * bare setter: no journal row, no audit event, nothing. On a document that gets signed and
   * filed, a field that can be corrected without trace is the wrong kind of quiet.
   *
   * One row per save naming WHICH fields moved, not one per field: the sheet writes several at
   * once (a Combo commit patches its neighbours), and a line per field would bury the Verlauf.
   */
  const metaLogBase = useRef<ReportMeta | null>(null)
  const metaLogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** the freshest saved meta, for the settle callback — it may re-arm past the save that made it */
  const metaLogNext = useRef<ReportMeta | null>(null)
  /** the current Mittel line count for normalizeReportMeta — a ref because saveReportMeta is
   *  deliberately identity-stable per mount and must not close over stale state */
  const mittelCountRef = useRef(0)
  useEffect(() => { mittelCountRef.current = mittelLineCount(mittel) }, [mittel])

  /**
   * The Rapport's ONE write path, held in a ref.
   *
   * ⚠️ It is the undoable slice's `set` (see `reportSet` further down, where `canWriteRecord`
   * and the timeline are both in scope), while `saveReportMeta` itself is deliberately
   * identity-stable per mount — the same shape `attHistClear` uses for the Anwesenheit. Before
   * that assignment lands it is the plain setter, so a write on the very first render still
   * reaches the workspace; it simply lays no step down.
   */
  const reportSetRef = useRef<UndoableSlice<ReportMeta>['set']>((u) => { setReportMeta(u); return false })
  /** the step that stands, so the next keystroke can decide whether it belongs to it */
  const lastReportStep = useRef<{ key: string; at: number } | null>(null)
  const saveReportMeta = useCallback((next: ReportMeta) => {
    reportSetRef.current((prev) => {
      // «Entfällt» and a value are two answers to the same question — resolve the contradiction
      // on EVERY meta write, here where all of them funnel through (lib/report ·
      // normalizeReportMeta; the QR poster's path does the same in CaptureApp).
      const clean = normalizeReportMeta(next, prev, { mittelCount: mittelCountRef.current }) as ReportMeta
      // The sheet persists on every KEYSTROKE (the textareas save as you type), so logging each
      // save wrote one Verlauf row per character typed into a Bemerkung. The row is written from
      // the state the editing STARTED in, once the typing stops — one line per edit, naming what
      // actually moved between those two points.
      if (!metaLogBase.current) metaLogBase.current = prev
      metaLogNext.current = clean
      const settle = () => {
        // ⚠️ Mid-typing is not «settled»: the sheet saves per keystroke but a slow, thought-out
        // sentence pauses past 4 s, and the row then quoted the half-typed value («Einsatzleiter
        // «Me»»). While the caret sits in a free-text Rapportangabe the window re-arms and only
        // closes once the field is left — last value wins. Steppers, Combos and time inputs are
        // not held open (isTypingMetaField) and keep the plain 4 s settle.
        if (isTypingMetaField()) {
          metaLogTimer.current = setTimeout(settle, META_LOG_SETTLE_MS)
          return
        }
        const base = metaLogBase.current
        const latest = metaLogNext.current
        metaLogBase.current = null
        metaLogNext.current = null
        metaLogTimer.current = null
        if (!base || !latest) return
        // scalar fields keep the ONE joined «Rapportangaben: …» row; each structured statement
        // («Partnerorganisation Sanität ergänzt …») is its own row, in diff order — three
        // decisions are three rows, not three sentences crammed into one (lib/report).
        const { fields, statements } = changedReportMetaLines(base, latest)
        if (fields.length) log('clipboard', fillTemplate(appConfig.copy.preflight.logMetaChanged, { fields: fields.join(', ') }))
        for (const s of statements) log('clipboard', s)
      }
      if (metaLogTimer.current) clearTimeout(metaLogTimer.current)
      metaLogTimer.current = setTimeout(settle, META_LOG_SETTLE_MS)
      return clean
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- log is stable per mount
  }, [])

  // Offline media queue: reattaches queued captures to their rows after a reload, retries on
  // reconnect, and swaps a row's local blob: URL for the persistent server URL on success.
  const swapRowMedia = useCallback((rowId: string, kind: 'photo' | 'audio', url: string, replaces?: string) => {
    // a persistent server URL becomes an appended enrichment patch (the record stays
    // append-only); a session blob: URL (queue restore) is a display-only overlay
    if (kind === 'photo') {
      // photos are a LIST: a queued upload that lands later must replace ITS OWN picture and
      // leave the row's others alone. The store reads the current list itself — a copy taken
      // here would be the one from whichever render created this callback (see swapPhoto).
      swapPhoto(rowId, replaces ?? '', url)
      return
    }
    if (url.startsWith('blob:')) overlayRow(rowId, { audioUrl: url })
    else patchRow(rowId, { audioUrl: url })
  }, [swapPhoto, overlayRow, patchRow])
  const media = useMediaQueue({
    incidentId: incidentMeta.id, readOnly: !canWriteRecord,
    onUploaded: swapRowMedia, onRestore: swapRowMedia,
  })
  // ⚠️ The media queue is an operational outbox too (23.09.2026): a Foto or Sprachnotiz that has
  // not reached the server is not saved, and one this device could not even store is `storage`.
  // It used to be left out, so the badge said «gespeichert» over captures that lived only here.
  const syncStatus = combinedSyncStatus(recordsSyncStatus, media.syncStatus)
  const syncNow = async () => {
    await Promise.all([syncWorkspaceNow(), journal.retry(), auditDelivery.retry()])
    await media.flush().catch(() => {})
    if (combinedSyncStatus(sync.syncStatus, journal.getStatus(), auditDelivery.getStatus(), media.getStatus()) !== 'synced') {
      throw new Error('Operational records have not all been acknowledged')
    }
  }

  // --- ONE «Einsatz abschliessen» ------------------------------------------------------------
  //
  // Two doors lead here — the Rapport's button/band and the row in the Einsatz-Menü — and until
  // 22.08. only ONE of them checked anything. The menu row archived plainly: no `report_done_at`,
  // none of the seven ABSCHLUSS_STEPS, so an Einsatz put away that way stood in the Historie as
  // «offen» for ever, while the identically-labelled path through the Rapport stamped and
  // counted. Two doors into one room are fine; two doors with the same sign into different rooms
  // are not. The confirm and the open-point count live HERE, above both of them.
  /** what the Abschluss asks about the Suche: people still missing, areas not abgesucht */
  const sucheAbschluss = useMemo(() => {
    const floors = planDocs.some((d) => d.floorStack) ? building?.floors ?? [] : []
    const name = (f: number) => building?.floorNames?.[String(f)] ?? floorLabel(f)
    return { vermisst: vermisstCount(suche), openBereiche: openBereiche(suche, sucheGroups(suche, floors, name)) }
  }, [suche, building, planDocs])
  /** the Suche's door for the confirm's rows — `openSuche` is built further down */
  const openSucheRef = useRef<() => void>(() => {})
  /** «Als «nicht eingesetzt» schliessen» in the Abschluss (useAbschluss · standDownTrupps,
   *  24.09.2026): the card's own stand-down, per Trupp. The Trupp actions are created much further
   *  down, so the hook gets a stable door and the ref is pointed at them once they exist. */
  const standDownRef = useRef<(ids: string[]) => void>(() => {})
  const standDownTrupps = useCallback((ids: string[]) => standDownRef.current(ids), [])
  const { abschlussMissing, truppsStillOut, azFrozenAt, azMonitoring, confirmAndComplete } = useAbschluss({
    reportMeta, attendance, mittel, trupps, incidentMeta, replayActive, media, onCompleteRapport,
    setMode, setPanel, setOfflineReadyOpen, requestReportStep,
    // only where the Tafel may be written — a viewer's or a replay's Abschluss has nothing to close
    standDownTrupps: canEditTrupps ? standDownTrupps : undefined,
    suche: sucheAbschluss, openSuche: useCallback(() => openSucheRef.current(), []),
  })

  /** the one-shot pusher, ref-held: the Beilagen handlers are `useCallback`s per mount and the
   *  timeline helper is created much further down — the same shape `reportSetRef` uses. */
  const rememberOneShotRef = useRef<(domain: UndoDomain, label: string, restore: () => void, reapply: () => void) => () => void>(() => () => {})
  /** the Bildlegende step that stands — a caption is typed, so it is ONE step and not one per
   *  letter (same window and the same reason as the Rapportangaben above). */
  const lastCaptionStep = useRef<{ key: string; at: number; from: string | undefined; drop: () => void } | null>(null)
  /** …and the Gebäude-Drehung, which is a slider: one drag is one step (see onReorient). */
  const lastReorient = useRef<{ at: number; from: BuildingDoc; drop: () => void } | null>(null)
  // the row media uploads and the Rapport-Beilagen — lib/useRowMediaUpload. ⚠️ The two refs go in
  // as the REF OBJECTS: rememberOneShotRef is assigned much further down, and lastCaptionStep is
  // reset by the remote hydrate above.
  const { uploadPhotoForRow, uploadMediaForRow, addAttachments, captionAttachment, removeAttachment } = useRowMediaUpload({
    incidentMeta, canWriteRecord, media, swapPhoto, swapRowMedia, attachments, setAttachments, emit,
    rememberOneShotRef, lastCaptionStepRef: lastCaptionStep,
  })

  // When the workspace sync recovers (server reachable again), drain any queued media too —
  // a stronger signal than the browser's `online` event, which fires on link-up not reach.
  // ⚠️ On the RECORD status, not `syncStatus`: that one includes the media queue itself, and
  // would never read «synced» while anything is queued — the drain would wait for itself.
  useEffect(() => { if (recordsSyncStatus === 'synced') void media.flush() }, [recordsSyncStatus, media])

  // Escape is the universal bail-out — it peels back one layer of transient state at a time so
  // there's always a quick way back to the plain map: (1) cancel an armed placement, (2) close the
  // open map chrome (Ebenen panel / views popover), (3) clear the current selection. (Modal sheets
  // handle their own Esc via the overlay wrapper; this is only the non-modal map chrome.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // typing in a field? Escape leaves the FIELD and nothing more — one key press must never
      // both finish the text and drop the selection. Read the event TARGET, not activeElement:
      // the field's own handler has already blurred by the time this bubbles up.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      // …and a MODAL on top of the map owns Escape outright — it closes, and the map does NOT also
      // peel a layer behind it. That is what the note above always claimed; it was never enforced,
      // so Esc in the «Welcher Trupp?» picker closed the picker AND disarmed the Team tool. Focus
      // is trapped inside the dialog, so the event target is enough to tell.
      // ⚠️ `alertdialog` as well as `dialog`: ConfirmCard (lib/overlays/ConfirmCard) renders the
      // alert role, so a delete confirm on the Lage was NOT a modal by this test — Escape closed
      // the confirm AND peeled a map layer behind it. The Plan's twin of this handler already
      // matched both roles; this is the Lage catching up.
      if (el?.closest('[role="dialog"], [role="alertdialog"]')) return
      if (pending || pendingShape) { setPending(null); setPendingShape(null); setRotStart(null); setTool('select') }
      // …then the coordinate crosshair: while it aims it swallows every map tap and hides the
      // selection bar, and until 02.09. Escape did not know it existed
      else if (coord.mode !== 'off') coord.setMode('off')
      else if (panel || viewsOpen) { setPanel(null); setViewsOpen(false) }
      // …then the active TOOL and the dock that belongs to it. Escape used to bail out of an
      // armed placement but leave Messen or Zeichnen running with its dock open over the map,
      // so the one key that is supposed to get you back to a plain map got you most of the way
      // and stopped.
      // ⚠️ setDraft([]), NOT settleDraft: Escape is the EXPLICIT discard. Every tap-away path
      // auto-commits a committable draft (see settleDraft), but a deliberate cancel has to keep
      // cancelling — the one key that means «weg damit» must never save the thing instead.
      else if (tool !== 'select') { setTool('select'); setDraft([]) }
      // the note panel closes BEFORE the selection does — Escape backs out one layer at a time
      else if (notePanelId) setNotePanelId(null)
      else if (selectedId || selectedDrawingId || selectedDrawIds.length || selectedEntityIds.length) { setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, pendingShape, coord.mode, panel, viewsOpen, tool, notePanelId, selectedId, selectedDrawingId, selectedDrawIds, selectedEntityIds])  // eslint-disable-line react-hooks/exhaustive-deps

  // Selecting something opens its details (ContextPanel) — so the moment a NEW selection lands, drop
  // every other transient bit of map chrome that would sit over it or the tool rail: the Ebenen dock,
  // the views popover, and any armed tool / placement dock (back to Auswahl). Edge-triggered on a
  // changing key so merely *opening* one of those while something is already selected doesn't
  // insta-close it. (Separate effect below handles modal sheets opening.)
  const selKey = `${selectedId ?? ''}|${selectedDrawingId ?? ''}|${selectedDrawIds.join(',')}|${selectedEntityIds.join(',')}`
  const prevSelKey = useRef(selKey)
  useEffect(() => {
    const changedToSelection = prevSelKey.current !== selKey && (!!selectedId || !!selectedDrawingId || selectedDrawIds.length > 0 || selectedEntityIds.length > 0)
    prevSelKey.current = selKey
    // settleDraft, not setDraft([]): a selection landing mid-draft used to throw the tapped-out
    // points away silently — a committable draft now auto-commits (without stealing this new
    // selection), a fragment says it was discarded (useMapDrawing · settleDraft).
    if (changedToSelection) { setPanel(null); setViewsOpen(false); setTool('select'); setPending(null); setPendingShape(null); settleDraft() }
  }, [selKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || shareLink || composerOpen || journalOpen || teamPick) setPanel(null)
  }, [settingsOpen, paletteOpen, pickerOpen, helpOpen, installGuideOpen, offlineReadyOpen, shareLink, composerOpen, journalOpen, teamPick])

  // Delete / Backspace removes the current selection (drawing first, then entity) — but
  // never while typing in a field. `doc` is a dep so the delete closes over fresh state.
  // ⚠️ Map surface only: the Plan carries the same key on its own selection (Whiteboard, A21),
  // and this listener lives on the window whether the Karte is on screen or not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (mode !== 'map') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      // ⚠️ The bar's «Löschen» left with the bar, so this key is where a boxed GROUP is deleted
      // from — plan-drawn members included: they are ordinary map objects now, and a group had
      // no other affordance at all.
      if (selectedDrawIds.length || selectedEntityIds.length) {
        e.preventDefault(); deleteGroup(selectedDrawIds, selectedEntityIds)
      } else if (selectedDrawingId) { e.preventDefault(); deleteDrawing(selectedDrawingId) }
      else if (selectedId && !tacticalLocked) { e.preventDefault(); deleteEntity(selectedId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, selectedId, selectedDrawingId, selectedDrawIds, selectedEntityIds, doc, tacticalLocked])  // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts (see lib/hotkeys + the "Tastaturkürzel" help section). One mount-once
  // listener delegates to hotkeyRef, which is reassigned every render with the live handlers —
  // so shortcuts always act on current state without a churn of add/removeEventListener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => hotkeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // warm the OSM building-outline cache so the Umgebung sheet (and the building picker)
  // opens instantly instead of waiting on the Overpass fetch. Must use the RESOLVED docs:
  // useObjectPlans re-centres the osm surface on the incident, so prefetching the bundled
  // catalog's default center warmed a bbox nobody looks at. Re-runs when the center moves
  // (e.g. the alarm address lands); prefetchOutlines dedupes by bbox, so repeats are free.
  // Not for an Atemschutz-Link session: it never shows a plan, and /api/overpass is off the
  // link allowlist – the warm-up would only be a 403 in the console.
  useEffect(() => {
    if (asLink) return
    for (const p of resolvedPlanDocs) if (p.osm) prefetchOutlines(p.osm.center, p.osm.radiusM)
  }, [resolvedPlanDocs, asLink])

  // remember the active surface + plan document in a cookie (preserve incidentId)
  // (…but never FROM a link session: its surface is forced, so remembering it would make the
  // next ordinary open of this browser land on the Atemschutz board for no reason anyone gave.)
  useEffect(() => { savePrefs({ ...loadPrefs(), ...(asLink ? {} : { mode, modeIncidentId: incidentMeta.id }), activePlanId, symbolScaleMap: symbolScale.map, symbolScaleBoard: symbolScale.board, symbolCaptions, offlineRadiusM, offlineAuto, keepScreenOn, railLabels }) }, [asLink, mode, incidentMeta.id, activePlanId, symbolScale, symbolCaptions, offlineRadiusM, offlineAuto, keepScreenOn, railLabels])

  // …and the CODE of the two lazy surfaces (Plan, Rapport — see loadWhiteboard at the top), on
  // idle after the first paint, so a mode switch finds its chunk already parsed. Not for an
  // Atemschutz-Link phone: it is shown the Tafel and nothing else.
  useEffect(() => {
    if (asLink) return
    return whenIdle(() => { void loadWhiteboard(); void loadReportPreflight() })
  }, [asLink])

  // warm the plan bitmaps at app load (on idle) so the first open of the Plan tab appears
  // instantly — the exact-fit bake reuses these unless the stage is larger. ⚠️ Only the active
  // plan and its two rail neighbours are baked at window size; the rest get a small preview
  // (~5 MB instead of up to ~83 MB each on an iPad — every plan at full size was enough to have
  // the tab reclaimed before the Plan tab was ever opened). Re-runs on a plan switch, so the
  // new neighbours are warmed as the operator moves along the rail (PdfViewport · prewarmPlans).
  useEffect(() => {
    if (asLink) return // never shows a plan — a phone must not bake every page into memory for nothing
    const docs = resolvedPlanDocs.filter((p) => p.imageUrl)
    const urls = docs.map((p) => (p.imageUrl.startsWith('/') || /^https?:/.test(p.imageUrl) ? p.imageUrl : `${import.meta.env.BASE_URL}${p.imageUrl}`))
    const active = Math.max(0, docs.findIndex((p) => p.id === activePlanId))
    const run = () => prewarmPlans(urls, window.innerWidth, window.innerHeight, urls.slice(Math.max(0, active - 1), active + 2))
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    const id = idle ? idle(run) : window.setTimeout(run, 600)
    return () => { const ric = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback; if (idle && ric) ric(id); else clearTimeout(id) }
  }, [resolvedPlanDocs, activePlanId, asLink])

  // Layers the MAP renders: during replay, apply the reconstructed layerState so
  // `layer.toggle` history (which layer was on/off at that moment) is faithful too.
  const mapLayers = useMemo(() => {
    // Online → full region-wide geojson; offline → the incident-box crop the offline cache warmed
    // (same URL, so a stored slice serves the live layer offline). See `online` / `withGeoBbox`.
    const scoped = layers.map((l) => (l.geojson ? { ...l, geojson: online ? l.geojson : withGeoBbox(l.geojson) } : l))
    if (!replayActive || !replayWs?.layerState) return scoped
    return scoped.map((l) => {
      const s = replayWs.layerState!.find((x) => x.id === l.id)
      return s ? { ...l, visible: s.visible, opacity: s.opacity } : l
    })
  }, [replayActive, replayWs, layers, withGeoBbox, online])

  const isVisible = useMemo(() => {
    const m = new Map(mapLayers.map((l) => [l.id, l.visible]))
    return (id: LayerId) => m.get(id) ?? true
  }, [mapLayers])

  // --- Georeferenz: which plans are tied to the ground, and how — lib/useGeorefFits -------------
  // ⚠️ Called HERE, where the block stood: its effects must keep their place after the store's and
  // the hydrate's. `log` is declared below and reaches it through `histSide` (assigned under it).
  const { linkedPlans, floorPack, georefPlanRasters, activeLinkedPlan, selectedPlanProjection, planLive } = useGeorefFits({
    planDocs, planScale, building, setBuilding, planBindings, activeObjectId, board, objects, rebake,
    planFitsRef, fitsVersion, setFitsVersion, stepLabelRef: stepLabel, histSide, readOnly, tacticalLocked, replayActive,
    twinLayers, twinLayerOpacity, activePlanId, selectedId, liveVehicles, livePeople, isVisible,
  })

  // The journal is append-only: every action pushes a row, and nothing ever edits
  // or removes one — undo/redo log their own lines. So the stream stays a faithful
  // record of what happened across both surfaces (and could back a standalone screen).
  const pushEvent = (ev: Omit<TimelineEvent, 'id' | 't' | 'at'> & { at?: string }, id?: string) => {
    // a caller may stamp `at` explicitly (e.g. a journal entry timed to when the composer was
    // opened, not when Erfassen was pressed); the HH:MM display derives from the same instant.
    const { at: atOverride, ...rest } = ev
    // ⚠️ The DEPLOYMENT's clock, not the device's (lib/serverClock). Every Atemschutz stamp is
    // written that way (useTruppActions · serverNowIso), and a Verlauf row is the same fact said
    // in words: stamped device-local it drifted away from the row it describes, so the printed
    // Journal said «Trupp X draussen 15:22» while the Atemschutz-Detailprotokoll of the same
    // action said 15:27 — two devices, two clocks, one Einsatz (field report 02.09.). Offline
    // `serverNowIso()` IS `Date.now()`, so nothing changes for a station that never reached the
    // server.
    const at = atOverride ?? serverNowIso()
    // ⚠️ Two rows in the same millisecond must never share an id — the server's idempotency skip
    // silently swallows the second (legal record). A per-mount counter kept ONE device's rows
    // apart but not two devices' (post-mortem 23.09.2026): newRowId adds the random tail (lib/ids).
    journal.append({ id: id ?? newRowId(), t: formatTime(new Date(at)), at, ...rest })
  }
  // map events keep the positional signature, so every existing call site is unchanged
  // `opts` carries the two things a row may need that are not part of its sentence: `rowId`
  // mints it under a caller-chosen id (idempotency across devices — see useTruppActions ·
  // logTruppAlarm), `subjectId` names the object it is ABOUT without making it a jump target
  // (see types · TimelineEvent.subjectId).
  const log = (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string,
    opts?: { rowId?: string; subjectId?: string; suche?: TimelineEvent['suche'] }) =>
    pushEvent({ icon, text, kind, audioUrl, entityId, subjectId: opts?.subjectId, ...(opts?.suche ? { suche: opts.suche } : {}), surface: 'map' }, opts?.rowId)
  // plan events carry document + (optional) team / coordinate context for jump-back
  const logPlan = (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number }) =>
    pushEvent({ icon, text, kind: extra?.kind ?? 'symbol', surface: 'plan', planId: activePlanId, annoId: extra?.annoId, px: extra?.x, py: extra?.y, floor: extra?.floor })
  // …and now that both exist, hand them to the timeline's entries (see `histSide` far above:
  // an entry is pushed long before this line runs and pressed long after it).
  histSide.current = { log, emit }

  // Lage-map drawing surface (draft, line mode/preset, draw-style controls, Drawing CRUD +
  // on-canvas editing) lives in useMapDrawing — the undoable doc and selection state are
  // threaded in so the handlers behave identically to their former inline selves.
  const {
    draft, setDraft,
    drawColor, setDrawColor, drawWidth, setDrawWidth, drawDashed, setDrawDashed,
    setDrawMarker, setDrawArrow,
    lineMode, setLineMode, areaMode, setAreaMode,
    draftActive, lineNodes, freehandKind, selectedDrawing,
    commitDraft, settleDraft, noteDrawingEdit, createLine, createArea, onFreehand, setDraftPointAttachment, createCircle, patchDrawing, patchDrawingById,
    patchDrawingLabelLive, commitDrawingLabel,
    editDrawingCoords, editDrawingRadius, moveLabel, insertDrawingVertex, deleteDrawingVertex, deleteDrawing, reverseDrawing, setDrawingAttachment,
  } = useMapDrawing({
    drawings, resolvedDrawings: resolvedMapDrawings, selectedDrawingId, tacticalLocked, tool, setTool,
    commit, setDocRaw, beginDrag, endDrag, emit, log,
    setSelectedDrawingId, setSelectedId, setSelectedDrawIds, setSelectedEntityIds,
    // a Leitung end snapped onto a Trupp's marker IS the Leitung pick (15.09.) — the same call
    // the Plan makes from its own magnet (Whiteboard · onLineAttached)
    onLineAttached: (lineId, attachment) => { linkLineToAttachedTrupp(lineId, attachment) },
    onLineDetached: (lineId, previous) => { unlinkLineFromDetachedTrupp(lineId, previous) },
  })
  const changeMapEnding = async (ending: 'none' | 'arrow' | 'arrowStop' | 'teilstueck', drawing = selectedDrawing) => {
    if (!drawing) return
    const incoming = drawing.teilstueck && ending !== 'teilstueck'
      ? drawings.flatMap((d) => (['start', 'end'] as const).filter((endpoint) => {
        const a = endpoint === 'start' ? d.startAttachment : d.endAttachment
        return a?.target.kind === 'line' && a.target.id === drawing.id && a.target.endpoint === 'end'
      }).map((endpoint) => ({ id: d.id, endpoint }))) : []
    if (incoming.length) {
      const ok = await confirmDialog({ title: appConfig.copy.drawingEditor.endingTeilstueck, message: fillTemplate(appConfig.copy.drawingEditor.removeEMessage, { n: incoming.length }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    const resolvedTarget = resolvedMapDrawings.find((d) => d.id === drawing.id)
    const fallback = resolvedTarget?.coords[resolvedTarget.coords.length - 1] ?? drawing.coords[drawing.coords.length - 1]
    // the Abschluss is a semantic edit like any DrawEditor field — one settled Verlauf row
    // («Zeichnung: Abschluss: Teilstück»), same funnel as patchDrawing (useMapDrawing ·
    // noteDrawingEdit / lib/drawingEdit), which this hand-rolled commit bypasses.
    noteDrawingEdit(drawing, { arrow: ending === 'arrow' || ending === 'arrowStop' || undefined, arrowStop: ending === 'arrowStop' || undefined, teilstueck: ending === 'teilstueck' || undefined })
    commit((doc) => ({ ...doc, drawings: doc.drawings.map((d) => {
      if (d.id === drawing.id) return { ...d, arrow: ending === 'arrow' || ending === 'arrowStop' || undefined, arrowStop: ending === 'arrowStop' || undefined, teilstueck: ending === 'teilstueck' || undefined }
      let next = d
      for (const endpoint of ['start', 'end'] as const) {
        const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
        if (!incoming.some((x) => x.id === d.id && x.endpoint === endpoint) || !a || next.coords.length < 2) continue
        const coords = next.coords.map((p, i) => i === (endpoint === 'start' ? 0 : next.coords.length - 1) ? fallback : p)
        next = { ...next, coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      return next
    }) }))
    emit('draw.edit', { id: drawing.id, patch: { arrow: ending === 'arrow' || undefined, teilstueck: ending === 'teilstueck' || undefined } })
    incoming.forEach(({ id, endpoint }) => {
      const line = drawings.find((d) => d.id === id)
      if (!line) return
      const coords = line.coords.map((p, i) => i === (endpoint === 'start' ? 0 : line.coords.length - 1) ? fallback : p)
      emit('draw.edit', { id, patch: { coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) } })
    })
  }
  // Attached Leitung ends follow their live vehicles (lib/useGpsFollow).
  // ⚠️ 24.09.2026 — this pass was the render storm of the Übung on 23.09.2026 (React #185 on
  // every device with the vehicle feed, and the Karte torn down under a tapped Trupp): it wrote a
  // fresh drawing on every run whether or not anything had moved, and it ran after every render
  // because `setDocRaw` was a new function each time. Both halves are fixed at their root — the
  // pass is idempotent, the store's writers are stable — and both have to stay that way. Gated on
  // `canEditIncident` like the other machine writer on the feed below: a device that cannot
  // write the tactical document only reads the coupling, and a replay is the past.
  useGpsFollow({ liveVehicles, enabled: canEditIncident, setDocRaw })

  // «Wann ist das TLF weggefahren?» — the feed answers it into the Verlauf, because an hour
  // later nobody can. Reads the RAW feed (`gpsVehicles`), not the overridden view: a vehicle
  // held in place by hand still really drives away, and that is the moment worth recording.
  useVehiclePresenceLog({
    vehicles: gpsVehicles,
    center: incidentView.center,
    enabled: canEditIncident && !replayActive,
    log,
    // the shared Verlauf: another device's row for the same transition is read back here, so
    // three tablets on one login write ONE «hat den Einsatzort verlassen» (24.09.2026)
    rows: journal.rows,
  })

  const pausedGpsConnections = useMemo(() => drawings.flatMap((drawing) => (['start', 'end'] as const).flatMap((endpoint) => {
    const attachment = endpoint === 'start' ? drawing.startAttachment : drawing.endAttachment
    return attachment?.gps?.state === 'paused' ? [{ drawing, endpoint, attachment }] : []
  })), [drawings])
  const setGpsRouting = (drawing: Drawing, endpoint: 'start' | 'end', routing: 'direct' | 'trace') => {
    const key = endpoint === 'start' ? 'startAttachment' : 'endAttachment'
    const attachment = drawing[key]
    if (!attachment) return
    const target = attachment.target.kind === 'object' ? entities.find((e) => e.id === attachment.target.id) : null
    const state = routing === 'trace' ? 'continuous' : attachment.gps?.state === 'continuous' ? 'paused' : 'guarded'
    patchDrawingById(drawing.id, { [key]: { ...attachment, routing, ...(attachment.gps ? { gps: { ...attachment.gps, state, ...(target && state === 'guarded' ? { confirmedAt: target.coord, lastSafe: target.coord } : {}) } } : {}) } })
  }
  const detachGpsHere = (drawing: Drawing, endpoint: 'start' | 'end') => {
    const attachment = endpoint === 'start' ? drawing.startAttachment : drawing.endAttachment
    if (!attachment) return
    const resolved = resolvedMapDrawings.find((d) => d.id === drawing.id)
    const fallback = resolved?.coords[endpoint === 'start' ? 0 : resolved.coords.length - 1] ?? drawing.coords[endpoint === 'start' ? 0 : drawing.coords.length - 1]
    setDrawingAttachment(drawing.id, endpoint, undefined, fallback)
  }

  const toggleLayer = (id: LayerId) => {
    // A linked plan's RASTER row (its sheet, drawn under the Karte's ink — lib/georefTwins ·
    // planRasterRows) is not a `LayerDef` and does not live in `layerState`: its ids are per plan
    // and per object, so they have no home in the fixed layer list `deriveInitial` reconciles
    // against. It is a device pref instead — same scope, different drawer. Routed by id so the
    // Ebenen panel stays ONE list with one gesture. ⚠️ The `twin:` prefix these ids carry is
    // PERSISTED on the device; it keeps its word because renaming it would reset everyone's rows.
    if (isTwinLayerId(id)) { toggleTwinLayer(id); return }
    const target = layers.find((l) => l.id === id)
    // ⚠️ Not from an `el` session: its audit stream carries the record vocabulary only (the
    // backend refuses the whole batch otherwise), and which Ebenen an EL is looking at is
    // their own view, not the FU's tactical picture the replay reconstructs. A viewer's emit
    // is already dropped by the read-only event store; `el` is the one writable non-editor.
    if (!isEl) emit('layer.toggle', { id, base: !!target?.base, visible: target?.base ? true : !(target?.visible ?? true) })
    setLayers((ls) => {
      const target = ls.find((l) => l.id === id)
      if (!target) return ls
      if (target.base) return ls.map((l) => (l.base ? { ...l, visible: l.id === id } : l))
      return ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    })
  }
  /** Ebenen quick-taps (field ask 07.09.): flip every overlay at once, or return to the layer
   *  set this Einsatz category opens with. Bases stay out of the bulk flip (a map with no base
   *  is a flat colour, and the base row is a radio, not an eye); the plan raster rows keep their
   *  own drawer.
   *  Each real change emits the ordinary `layer.toggle`, so the replay reconstructs bulk taps
   *  with the vocabulary it already speaks. */
  const setAllLayers = (visible: boolean) => {
    // same `!isEl` rule as toggleLayer above — an EL's Ebenen are their own view
    if (!isEl) for (const l of layers) if (!l.base && l.visible !== visible) emit('layer.toggle', { id: l.id, base: false, visible })
    setLayers((ls) => ls.map((l) => (l.base || l.visible === visible ? l : { ...l, visible })))
  }
  const resetLayers = () => {
    const next = defaultLayers(incidentMeta.type)
    if (!isEl) for (const l of next) {
      const cur = layers.find((x) => x.id === l.id)
      if (!cur || cur.visible === l.visible) continue
      // a base is a radio: only the one that BECOMES visible is announced, or the replay's
      // radio semantics would re-select whichever base event happened to come last
      if (l.base && !l.visible) continue
      emit('layer.toggle', { id: l.id, base: !!l.base, visible: l.visible })
    }
    setLayers(next)
  }
  const setOpacity = (id: LayerId, v: number) => {
    if (isTwinLayerId(id)) {
      // written outside the updater — see the note on persistTwinLayers
      const next = { ...twinLayerOpacity, [id]: v }
      setTwinLayerOpacity(next)
      savePrefs({ ...loadPrefs(), twinLayerOpacity: next })
      return
    }
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: v } : l)))
  }

  /**
   * The ONE place that drops the Lage map's transient UI. Six call sites — pick, togglePanel,
   * toggleViews, NavRail's onMode, goToModule, enterReplay — each used to hand-write its own
   * subset of this list, and the subsets had drifted apart. That drift was the bug: reaching for
   * Linie / Fläche / Notiz / Team while a symbol was selected left its ContextPanel open, and the
   * panel is drawn straight over the tool's own dock (the ✓/✕ and the colour/width controls), so
   * the tool you had just picked was unusable until you guessed to press Esc. On a phone the panel
   * is a 46dvh bottom sheet and buries the tool bar outright. The Plan surface never had this —
   * Whiteboard gates all four of its editors on `tool === 'pan'`; this is the Lage catching up.
   *
   * `keep: 'selection'` is for the two chrome toggles (Ebenen, Kartenansichten): throwing away
   * what you had tapped just to look at a layer would be its own surprise, so the halo stays and
   * the panel returns when the dock closes.
   *
   * ⚠️ This used to claim the toggles are "drawn ABOVE the detail panel … so nothing becomes
   * unreachable". They are drawn above it — and at the SAME coordinates: `.layers-card` (z201,
   * 264px) lands on `.ctx` (z35, 360px), and on a phone both are bottom sheets on the same edge
   * with only a z28 backdrop between them, so the buried panel stayed tappable. Keeping the
   * selection was right; concluding that the panel could therefore stay rendered was not. The
   * panel now stands down via `detailSlotFree` while a dock is up — see its note above.
   */
  const clearMapUi = (keep?: 'selection') => {
    // settleDraft, not setDraft([]): leaving the map (or opening a dock) mid-draft used to be a
    // silent discard — a committable draft auto-commits with an undo toast, a fragment says so
    // (useMapDrawing · settleDraft; Escape stays the explicit discard).
    setTool('select'); setPending(null); setPendingShape(null); settleDraft(); setTeamPick(null)
    // the palette IS the arming UI for the symbol tool, so it goes with the tool it arms —
    // otherwise leaving the map with it open silently re-opened it on the way back
    setPanel(null); setViewsOpen(false); setPaletteOpen(false)
    if (keep === 'selection') return
    setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
    setNotePanelId(null); setEditNoteId(null)
  }

  // Locking the surface mid-draw (Führungsansicht toggled on, tab lock lost, replay entered)
  // must not leave a create tool armed behind a dock that is no longer rendered — disarm down to
  // the tool set the locked rail actually offers. Messen and Auswahl survive untouched.
  useEffect(() => {
    if (!tacticalLocked || isMapReadOnlyTool(tool)) return
    // settleDraft under the lock cannot commit (the create funnel refuses a locked surface) —
    // but it still SAYS the draft was discarded instead of dropping it silently.
    setTool('select'); setPending(null); setPendingShape(null); settleDraft(); setTeamPick(null)
    setPaletteOpen(false); setEditNoteId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tacticalLocked, tool])

  // Enter replay WITHOUT forcing a surface: one timeline drives both the Lagekarte and the Plan,
  // so the user can toggle Lage/Plan during playback to inspect each surface at the scrubbed
  // instant. Editing stays locked (replayActive feeds readOnly/tacticalLocked); clearMapUi makes
  // sure nothing is mid-edit on entry — including the lasso halos and the «Welcher Trupp?» picker,
  // which its old hand-written list missed and which then sat over a read-only past.
  const enterReplay = () => { clearMapUi(); setReplayActive(true) }
  // ── Verlauf ⇄ Wiedergabe ──
  // The bar owns the playhead (it ticks four times a second at 4×; lifting that here would
  // re-render the workspace on every frame). It reports the playhead only when it CROSSES a
  // Verlauf row, and hands its seek down through a ref — the same imperative-handle pattern the
  // Plan's fit and history already use. Together those two make a row a way into the moment.
  const replaySeek = useRef<((ms: number) => void) | null>(null)
  const [journalLandOn, setJournalLandOn] = useState<{ id: string; nonce: number } | null>(null)
  const [replayAtMs, setReplayAtMs] = useState<number | null>(null)
  const onReplayPlayhead = useCallback((ms: number) => setReplayAtMs(ms), [])
  const seekToEvent = (e: TimelineEvent) => {
    const t = e.at ? Date.parse(e.at) : NaN
    if (Number.isFinite(t)) replaySeek.current?.(t)
  }

  // Ebenen shares the dock slot with the views popover and the tool docks — opening it
  // drops the active tool and closes the views menu (mirror of toggleViews below).
  const togglePanel = (name: 'layers') => {
    if (panel === name) { setPanel(null); return }
    clearMapUi('selection')
    setPanel(name)
  }

  // navigate from a Verlauf row back to wherever the event happened, then close
  // the drawer. Plan rows switch surface + document and (when located) recenter.
  // leaving replay drops the playhead with it, or a later Verlauf would still dim its own future
  useEffect(() => { if (!replayActive) setReplayAtMs(null) }, [replayActive])

  const focusEvent = (e: TimelineEvent) => {
    // a Suche row opens the Suche on its person / area (beside the Gebäude, else the Karte)
    if (e.suche) {
      setJournalOpen(false)
      openSuche({ personId: e.suche.personId, bereichId: e.suche.bereichId, tab: e.suche.personId ? 'personen' : 'bereiche' })
      return
    }
    if (e.surface === 'plan' && e.planId) {
      if (e.planId === gebaeudeDoc.id && !building) { setJournalOpen(false); return } // floor-stack gone
      setMode('plans'); setPanel(null); setActivePlanId(e.planId)
      if (e.px != null && e.py != null) setPlanFocus({ x: e.px, y: e.py, floor: e.floor ?? 0, annoId: e.annoId, nonce: Date.now() })
    } else if (e.coord) {
      setMode('map'); flyToMapVisible(e.coord, 18)
    } else if (e.entityId) {
      setMode('map'); focusEntity(e.entityId)
    }
    setJournalOpen(false)
  }

  // quick-add a journal entry (text and/or voice memo), optionally pinned to the
  // current view so the row becomes a clickable, located marker.
  const addJournal = (d: JournalDraft) => {
    const onPlan = mode === 'plans'
    // ⚠️ No coordinate. «An aktueller Kartenmitte anheften» is gone (14.08.): it wrote the
    // centre of whatever happened to be on screen — neither where the author stood nor where
    // the event was — and its only payoff was that the row could fly the map back to that spot.
    // The Wiedergabe answers the question it was really asked («wie sah es da aus?») properly,
    // by scrubbing the whole picture to the moment. Rows written BEFORE this still carry their
    // coord and stay clickable; nothing reads `pinned` to decide anything else.
    const photoUrls = d.photoUrls ?? []
    const icon = d.audioUrl ? 'mic' : photoUrls.length ? 'photo' : 'type'
    const kind = d.audioUrl ? 'audio' : photoUrls.length ? 'photo' : 'journal'
    const imported = d.audioMeta?.source === 'imported'
    const body = d.text
      || (imported
        ? fillTemplate(appConfig.copy.journal.audioImportedNote, { duration: d.audioMeta?.durationSec != null ? formatAudioDuration(d.audioMeta.durationSec) : '–' })
        // ⚠️ A picture needs no caption saying «Foto» — the row shows the picture. A Sprachnotiz
        // is the opposite case and keeps its label: audio has nothing to look at, so without the
        // words the row would be a blank line with a play button. (Rows already written with the
        // placeholder are cleaned at render — lib/verlauf · rowText.)
        : d.audioUrl ? `${appConfig.copy.log.audioNote}${d.secs ? ` (${d.secs}s)` : ''}` : photoUrls.length ? '' : appConfig.copy.log.journalNote)
    const rowId = newRowId('j')
    // ── Pendenz / Meldung ────────────────────────────────────────────────────────────────────
    // ⚠️ The lifecycle event rides on THIS row — the entry IS the Pendenz. «Auftrag · Trupp 2
    // entraucht Treppenhaus» is both the record and the open item; there is no shadow row.
    // ⚠️ And tracking hangs off this event, NEVER off `entryType === 'auftrag'`. Keying it to the
    // tag would turn every Auftrag row already written — live incidents and the archive alike —
    // into an eternally open Pendenz nobody can tick off. Old rows stay plain text, no migration.
    // ⚠️ A due time makes this an open item even when the ring was never touched: an Erinnerung
    // that cannot be ticked off would keep firing its banner with no way to answer it. The composer
    // enforces the same rule at its end (setDue/setOpen); this is the second half of it, for every
    // other caller of addJournal.
    // ⚠️ `!d.noteFor`: a MELDUNG with a due time is not a new item — it moves the clock of the one
    // it reports on (see the `reminder` below). Without this guard the row said `op:'note'` while
    // the hash-chained audit got a `reminder.create` for an id that exists in no row at all, and
    // the `reminder.note` event never fired: the one feature this change adds, corrupting the
    // record it is supposed to keep.
    const pendenzId = !d.noteFor && (d.pendenz || d.dueAt) ? newId('pnd') : undefined
    // ── the Suche (Tür 2) — the status changes on the way, and THIS row is its Verlauf row: the
    // record's own row stays in the person's log («Gefunden: Eva Beispiel»), but the Verlauf gets
    // one line, the one that was written, linked to the person ──
    const sucheRef = sucheLink && canEditSuche
      ? (sucheLink.kind === 'gefunden'
        ? (sucheActionsRef.current?.gefunden(sucheLink.personId, {}, { silent: true }) ? { personId: sucheLink.personId } : undefined)
        : ((id) => (id ? { personId: id } : undefined))(sucheActionsRef.current?.addPerson({ name: sucheLink.name }, { silent: true }) ?? null))
      : undefined
    const reminder: TimelineEvent['reminder'] = d.noteFor
      // ⚠️ A Meldung with a due time RE-DATES the item it reports on — «Werkhof meldet 20 Minuten»
      // is exactly the moment to move the Wiedervorlage. It stays op `note`, NOT `snoozed`: the
      // note has to keep standing in the item's thread, and a snooze row is not part of it (see
      // lib/reminders · the note branch, which reads the dueAt without touching open/closed).
      ? { op: 'note', id: d.noteFor.id, dueAt: d.dueAt }
      : pendenzId
        ? {
          op: 'created', id: pendenzId,
          // the BARE text, without the «Auftrag · » tag composeJournalText adds — the list and
          // the Rapport print their own context and would otherwise stutter it (see types)
          text: body, urgent: d.pendenz?.urgent || undefined, assignee: d.assignee,
          dueAt: d.dueAt,
        }
        : undefined
    pushEvent({
      // «Wer» and «Art» are composed INTO the text (lib/journalEntry): `text` is the record —
      // Verlauf, Rapport and the hash chain all read this one string, and a row whose meaning
      // lived in a side field would read differently in the app than it does on paper. The
      // structured fields travel along for filtering, not for display.
      icon, text: composeJournalText(body, d), kind, entryType: d.entryType, reminder,
      ...(sucheRef ? { suche: sucheRef } : {}),
      audioUrl: d.audioUrl, photoUrls: photoUrls.length ? photoUrls : undefined, audioMeta: d.audioMeta,
      // …already SERVER urls (a generic Beilage is uploaded during save, never queued), so
      // nothing here has to be swapped later the way a photo's blob: URL is
      files: d.files,
      // an imported memo lands at its confirmed recording start; everything else at composer-open
      at: (imported ? d.audioMeta?.startedAt : undefined) ?? composerOpenedAt.current ?? undefined,
      surface: onPlan ? 'plan' : 'map', planId: onPlan ? activePlanId : undefined,
    }, rowId)
    // one upload per picture; each swaps ITS OWN blob: URL for the server URL when it lands
    for (const url of photoUrls) void uploadPhotoForRow(rowId, url)
    // an imported memo's audioUrl is already the server URL (uploaded during save) — only a
    // session blob: URL (in-app recording) still needs the upload/queue path
    if (d.audioUrl?.startsWith('blob:')) void uploadMediaForRow(rowId, d.audioUrl, 'audio')
    emit('journal.add', { id: rowId, kind })
    // the Pendenz lifecycle goes into the hash-chained audit too, like create/done/snooze already do
    if (pendenzId) emit('reminder.create', { id: pendenzId, ...(d.dueAt ? { dueAt: d.dueAt } : {}) })
    else if (d.noteFor) emit('reminder.note', { id: d.noteFor.id, ...(d.dueAt ? { dueAt: d.dueAt } : {}) })
    // …and only a row that will actually ring asks for the OS permission — on this submit gesture,
    // which is the only moment a browser grants it.
    if (d.dueAt) void ensureNotifyPermission()
    // Leave the Verlauf as it was. Forcing it open is right for exactly one entry point — the
    // Verlauf's own «Eintrag» button — and there it is already open behind the composer, so it
    // is a no-op. From the phone's FAB or a checklist deep link it yanked the operator off the
    // map they were working on, for a save the toast has already confirmed.
    setComposerOpen(false)
    setNoteOn(null)
    setSucheLink(null)
    const C = appConfig.copy.journal
    // ⚠️ The due time wins the confirmation. «Pendenz gesetzt» on a row that will ring in ten
    // minutes tells the smaller half of what was just decided — and the clock is the half that
    // acts on its own, so it is the one worth reading back.
    toast(
      d.dueAt ? C.reminderSaved
        : d.noteFor ? C.noteSaved
          : d.pendenz ? (d.pendenz.urgent ? C.pendenzUrgentSaved : C.pendenzSaved)
            : C.saved,
      // 'bell' for the timed one, the glyph the Erinnerung wears everywhere else it is met (the
      // banner, and the snooze row in the Verlauf). It was 'clock' until 23.08.; on the Verlauf
      // that glyph now means an Anwesenheits-Zeitenzeile and nothing else (lib/report · journalArea).
      { icon: d.dueAt ? 'bell' : d.pendenz || d.noteFor ? 'circle' : icon, tone: 'success' },
    )
  }

  // Durchhören player: replay a long recording and
  // append ordinary journal rows at the paused position — Nachdokumentation. The row's `at`
  // is the wall-clock instant inside the recording, so it lands (and marks) correctly.
  const [player, setPlayer] = useState<{ row: TimelineEvent; seekSec?: number } | null>(null)
  const playerRow = player?.row ?? null
  // returns the created row id (the STT confirm flow stamps it onto the draft segment);
  // `quiet` skips the toast for bulk confirms — the row appearing as a marker IS the feedback
  const addPlayerEntry = (text: string, atIso: string, quiet = false): string => {
    const rowId = newRowId('p')
    pushEvent({
      icon: 'type', text, kind: 'journal', at: atIso,
      surface: playerRow?.surface ?? 'map', planId: playerRow?.planId,
    }, rowId)
    emit('journal.add', { id: rowId, kind: 'journal' })
    if (!quiet) toast(appConfig.copy.journal.saved, { icon: 'type', tone: 'success' })
    return rowId
  }

  // Wiedervorlagen: derive the open set from the timeline, alert when due (shared tone +
  // OS notification), and append done/snooze rows. Paused during replay so scrubbing past a
  // due time doesn't re-alarm. The `created` rows are written by addJournal above.
  const reminders = useReminders(
    timeline,
    (ev) => {
      pushEvent({ icon: ev.icon, text: ev.text, kind: 'reminder', surface: mode === 'plans' ? 'plan' : 'map', planId: mode === 'plans' ? activePlanId : undefined, reminder: ev.reminder })
      // mirror the create emit (see addJournal) so the hash-chained audit / replay carry the FULL
      // reminder lifecycle — done + snooze + reopen — not just creation.
      const op = ev.reminder.op
      emit(op === 'done' ? 'reminder.done' : op === 'reopened' ? 'reminder.reopen' : 'reminder.snooze', { id: ev.reminder.id, ...(ev.reminder.dueAt ? { dueAt: ev.reminder.dueAt } : {}) })
    },
    {
      dueTitle: appConfig.copy.journal.dueTitle, doneLog: appConfig.copy.journal.doneLog,
      pendenzDoneLog: appConfig.copy.journal.pendenzDoneLog, snoozeLog: appConfig.copy.journal.snoozeLog,
      reopenLog: appConfig.copy.journal.reopenLog, pendenzReopenLog: appConfig.copy.journal.pendenzReopenLog,
    },
    !replayActive,
    incidentMeta.closed_at,
    // «Erledigt» is confirm-with-undo and joins the one timeline (useReminders · completeReminder)
    undoHist,
  )

  // «wieder in …» on a done row (Journal · onReminderAgain): re-raise a closed item as a FRESH
  // timed Wiedervorlage — new id, same bare text, due in `mins`. The Führungsrhythmus move
  // (Handbuch 2.4): the moment the Lagerapport-Pendenz is ticked off is when the next one gets
  // its time. Appends a normal `created` row; the closed item stays closed, nothing mutates.
  const reRaisePendenz = (reminderId: string, mins: number) => {
    const src = timeline.find((e) => e.reminder?.op === 'created' && e.reminder.id === reminderId)
    if (!src) return
    const text = bareText(src)
    // server clock, like the row's own `at` (pushEvent): the Wiedervorlage is read by every
    // device, so a fast tablet must not make it ring early for the whole deployment
    const dueAt = new Date(Date.parse(serverNowIso()) + mins * 60_000).toISOString()
    const id = newId('pnd')
    pushEvent({
      icon: 'bell', kind: 'reminder',
      // the record row carries the time in words (same template the legacy composer wrote, and
      // exactly what lib/reminders · bareText knows how to strip back off)
      text: fillTemplate(appConfig.copy.journal.reminderCreated, { t: formatTime(new Date(dueAt)), text }),
      surface: mode === 'plans' ? 'plan' : 'map', planId: mode === 'plans' ? activePlanId : undefined,
      reminder: { op: 'created', id, dueAt, text },
    })
    emit('reminder.create', { id, dueAt })
    // a row that will ring asks for the OS permission on this gesture, like the composer does
    void ensureNotifyPermission()
  }

  // Voice memo driven by the TopBar's Eintrag button (hold to start, tap to stop) —
  // lifecycle in useVoiceMemo; here we persist the finished clip into the journal. The
  // surface (map/plan) is snapshotted at hold-start so a mid-recording tab switch can't
  // re-file the clip (preserves the previous start-time behaviour).
  const voiceStartCtx = useRef<{ onPlan: boolean; planId: string }>({ onPlan: false, planId: activePlanId })
  const voice = useVoiceMemo(({ url, secs }) => {
    const { onPlan, planId } = voiceStartCtx.current
    const rowId = newRowId('v')
    pushEvent({
      icon: 'mic', text: `${appConfig.copy.log.audioNote} (${secs}s)`, kind: 'audio', audioUrl: url,
      audioMeta: { source: 'recorded', startedAt: new Date(Date.now() - secs * 1000).toISOString(), durationSec: secs },
      surface: onPlan ? 'plan' : 'map', planId: onPlan ? planId : undefined,
    }, rowId)
    void uploadMediaForRow(rowId, url, 'audio')
    emit('journal.add', { id: rowId, kind: 'audio' })
    toast(fillTemplate(appConfig.copy.toast.audioSaved, { secs }), { icon: 'mic', tone: 'success' })
  })
  const startVoiceMemo = () => { voiceStartCtx.current = { onPlan: mode === 'plans', planId: activePlanId }; void voice.start() }

  // «Eintrag» hold released over «Foto» (see lib/useHoldEntry): straight to the camera, no
  // composer in between — the picture IS the entry. The row is stamped at the moment of the
  // GESTURE, not of the shot: framing and confirming a photo takes half a minute, and the
  // Verlauf should say when you reached for the camera. The composer's own timestamp works the
  // same way (composerOpenedAt).
  const photoInputRef = useRef<HTMLInputElement>(null)
  const startQuickPhoto = () => { composerOpenedAt.current = new Date().toISOString(); photoInputRef.current?.click() }
  const onQuickPhotoPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // the same file twice in a row must still fire
    if (!files.length) return
    const urls = files.map((f) => URL.createObjectURL(f))
    // Thumbnails FIRST, then the row: its chips read the session thumbnail the moment they render
    // (lib/mediaUrl · thumbUrl), and a chip pointed at the camera file is the decode that killed
    // the tab. The row is stamped at the gesture (composerOpenedAt), so the moment it appears
    // does not move its time.
    void Promise.all(files.map((f, i) => mintLocalThumb(urls[i], f))).then(() => addJournal({ text: '', photoUrls: urls }))
  }

  // Every path through here ends the "I am reading this object" state — reaching for a tool means
  // you are done with the detail panel, exactly as it has always worked for a note (see the
  // notePanelId effect). Symbol goes through it too: it opens the palette without setting `tool`,
  // so dismissing the palette without picking used to reveal the stale panel again.
  const pick = (id: string) => {
    if (id === 'symbol') { clearMapUi(); setPaletteOpen(true); return }
    // Auswahl (select) is the default navigate state: one finger pans the map, a tap
    // selects, a drag on an object moves it. There is no separate pan mode any more —
    // panning is always available.
    // ⚠️ Auswahl and Mehrfach SHARE one rail slot (05.09.), and the rail resolves that toggle
    // itself: a second tap on the armed Auswahl arrives here as `'lasso'` (and a tap on the armed
    // Mehrfach as `'select'`), so it falls through to the setTool below — clearing the selection
    // on the way, exactly as picking the separate Mehrfach button always did.
    // tapping the already-active tool again exits it → back to Auswahl (closes its option dock)
    if (id === tool) { clearMapUi(); return }
    clearMapUi(); setTool(id)
  }

  const pickShape = (kind: ShapeKind) => { setTool('shape'); setPending(null); setPendingShape(kind); setPaletteOpen(false) }

  // A real, stationary tap on the map — MapView drops the click that merely trails a pan or a
  // pinch before it ever gets here (see its panGesture note), so moving the map neither places
  // anything nor reaches the deselect at the end of this chain. On a phone that deselect IS the
  // detail sheet's dismiss, and it used to fire on every pan.
  /** «Fertig» on the selection bar — the editing state ends. Exactly what a tap on the empty map
   *  already does: nothing selected, and every sheet that was open FOR that selection closed. */
  const finishSelection = () => {
    setSelectedId(null); setSelectedDrawingId(null)
    setSelectedDrawIds([]); setSelectedEntityIds([])
    setNotePanelId(null); setEditNoteId(null)
  }
  const onMapClick = (c: LngLat) => {
    // a map tap dismisses an open Ebenen panel first (parity with the phone backdrop) —
    // the panel is map chrome, so tapping the map behind it should just close it
    if (panel !== null) { setPanel(null); return }
    // read-only surfaces: Messen is the one tool whose taps mean anything (its path is ephemeral —
    // see lib/useMeasure). Everything else falls through to "deselect", so a stale armed tool can
    // never keep collecting draft points behind a hidden dock.
    if (tacticalLocked && tool !== 'measure') {
      setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
      return
    }
    if (tool === 'shape' && pendingShape) {
      const id = newId('sh'); const def = SHAPE_DEFS[pendingShape]
      const name = appConfig.copy.shapes.names[pendingShape]
      // ── A Rotation is laid between two PLACES (lib/shapes · SHAPE_TWO_POINT) ──────────────
      // The first tap is the Wasserbezug, the second the Brandstelle, and the loop's centre,
      // length, bearing and width all fall out of the pair. A second tap on the SAME spot means
      // «einfach hinlegen»: the default run, aimed east — nobody is ever left holding half a
      // gesture with no way to finish it.
      let geom: Pick<Entity, 'coord' | 'rotation' | 'sizeM' | 'aspect'> = { coord: c, sizeM: def.defaultSizeM, rotation: 0 }
      if (SHAPE_TWO_POINT[pendingShape]) {
        if (!rotStart) { setRotStart(c); return }
        const spanM = haversineM(rotStart, c)
        const apart = spanM >= SHAPE_MIN_M
        const box = rotationBox(apart ? spanM : ROTATION_DEFAULT_RUN_M, ROTATION_W_M)
        geom = {
          coord: apart ? midCoord(rotStart, c) : rotStart,
          rotation: apart ? Math.round(bearingDeg(rotStart, c)) : 0,
          sizeM: Math.round(box.size),
          aspect: Math.round(box.aspect * 1000) / 1000,
        }
        setRotStart(null)
      }
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, shape: pendingShape, color: def.defaultColor, label: name, ...geom }] }))
      // unlocked: place once, then drop back to select with the new shape active so
      // its edit handles are immediately usable. locked: stay in place-mode (no
      // selection so the editor doesn't interrupt) to drop several in a row.
      // Both branches drop a lasso group too — it used to survive every placement and keep
      // painting halos over unrelated objects.
      setSelectedDrawIds([]); setSelectedEntityIds([])
      if (placeLock) { setSelectedId(null); setSelectedDrawingId(null) }
      else { setPendingShape(null); setTool('select'); setSelectedId(id); setSelectedDrawingId(null) }
      log('area', fillTemplate(appConfig.copy.log.shapePlaced, { name }), 'symbol', undefined, id)
      emit('entity.add', { id, kind: 'shape', entity: { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, shape: pendingShape, color: def.defaultColor, label: name, ...geom } })
    } else if (tool === 'symbol' && pending) {
      const id = newId('p'); const s = pending
      // shared seeding (label / subtitle / fields / vehicle rotation) — identical to
      // the Plan placement path so a symbol carries the same structure on both surfaces
      // A driven vehicle is stored on the Fahrzeuge layer, so it toggles with the live GPS
      // glyphs rather than sitting among the tactical symbols. (Old incidents are handled by
      // effectiveLayer at read time — this just means new data needs no shim.)
      const layer = VEHICLE_SYMBOLS.has(s) ? appConfig.gps.layerId : appConfig.defaults.operationalLayerId
      const entity: Entity = { id, kind: 'symbol', layer, coord: c, ...seedSymbolProps(s, sym.symbols) }
      commit((d) => ({ ...d, entities: [...d.entities, entity] }))
      addRecent(s)
      setSelectedDrawIds([]); setSelectedEntityIds([])
      if (placeLock) { setSelectedId(null); setSelectedDrawingId(null) }
      else { setPending(null); setTool('select'); setSelectedId(id); setSelectedDrawingId(null) }
      log('hex', fillTemplate(appConfig.copy.log.symbolPlaced, { name: entity.label || formatSymbolName(s) }), 'symbol', undefined, id)
      emit('entity.add', { id, symbol: s, entity })
    } else if (tool === 'note') {
      const id = newId('n')
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: c, label: '', subtitle: appConfig.copy.entities.noteSubtitle, noteW: autoNoteWPx('', noteDefaults.size === 'm' ? undefined : noteDefaults.size), noteAutoW: true, noteSize: noteDefaults.size === 'm' ? undefined : noteDefaults.size, notePlain: noteDefaults.plain || undefined, color: noteDefaults.color || undefined }] }))
      // Straight into typing — in the detail sheet, with the caret already in its text field
      // (05.09.). It used to open the on-canvas inline editor instead, which is a text cursor
      // sitting on the map with no visible field, no room for a second line and, on a phone, the
      // keyboard over the very spot just tapped. Double-tap still opens that inline editor for
      // the desktop hand that wants it.
      setSelectedId(id); setSelectedDrawingId(null); setNotePanelId(id); setNotePlacedId(id); setTool('select'); log('type', appConfig.copy.log.notePlaced, 'note', undefined, id)
      emit('entity.add', { id, kind: 'note', entity: { id, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: c, label: '', subtitle: appConfig.copy.entities.noteSubtitle, noteW: autoNoteWPx('', noteDefaults.size === 'm' ? undefined : noteDefaults.size), noteAutoW: true, noteSize: noteDefaults.size === 'm' ? undefined : noteDefaults.size, notePlain: noteDefaults.plain || undefined, color: noteDefaults.color || undefined } })
    } else if (tool === 'team') {
      setTeamPick(c) // which Trupp? — picker over the tapped spot (mirrors the plan's Team tool)
    } else if (tool === 'area') {
      setDraft((d) => [...d, c])
    } else if (tool === 'line' && lineMode === 'nodes') {
      setDraft((d) => [...d, c]) // node mode: tap to place each line vertex; ✓ finishes
    } else if (tool === 'measure') {
      measure.setPath((d) => [...d, c])
    } else { setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }
  }

  // "Center" doesn't just recentre the alarm point — it frames the whole tactical picture:
  // fit the incident location PLUS every placed symbol/shape/note and drawn line/area/circle,
  // with padding, so zooming to the Einsatz shows everything that's been worked on. Falls back
  // to a plain recentre when nothing has been drawn yet (a single point has no extent to fit).
  const centerIncident = () => {
    const map = mapRef.current; if (!map) return
    const pts: LngLat[] = [incidentView.center]
    // exclude live GPS vehicles — they may be parked at the Magazin, far from the scene, and
    // would blow the bounds wide open. Only the placed tactical picture frames the view.
    for (const e of entities) if (!liveIds.has(e.id) && Array.isArray(e.coord)) pts.push(e.coord as LngLat)
    for (const d of resolvedMapDrawings) {
      if (!Array.isArray(d.coords)) continue
      if (d.kind === 'circle' && d.coords[0] && d.radiusM) {
        const [lng, lat] = d.coords[0]
        const dLat = d.radiusM / 110540
        const dLng = d.radiusM / ((111320 * Math.cos((lat * Math.PI) / 180)) || 1)
        pts.push([lng - dLng, lat - dLat], [lng + dLng, lat + dLat])
      } else {
        for (const c of d.coords) if (Array.isArray(c)) pts.push(c as LngLat)
      }
    }
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs), minLat = Math.min(...lats), maxLat = Math.max(...lats)
    if (maxLng - minLng < 1e-6 && maxLat - minLat < 1e-6) {
      map.flyTo({ center: incidentView.center, zoom: 17.6, ...(prefersReducedMotion() ? { duration: 0 } : {}) })
    } else {
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 96, maxZoom: 17.6, duration: motionDuration(600) })
    }
  }

  // Saved map views (camera bookmarks) — snapshot the live camera, fly back to one on tap. The
  // list is synced per incident so the crew shares framings (a north-up overview + the map turned
  // to how they're standing). Restore animates with rotation so the bearing comes back too.
  // plain object (not memoised) so onFit always calls the LATEST centerIncident — that closure
  // captures the live entities/drawings, which a stale memo would freeze.
  const viewsApi: ViewsApi = {
    list: cameraViews,
    current: view,
    onGo: (v) => mapRef.current?.flyTo({ center: v.center, zoom: v.zoom, bearing: v.bearing, duration: motionDuration(600) }),
    // an animated turn back to north, like a map app's compass — at the saved views' pace, and
    // instant under reduced motion (MapLibre's own default is a fixed 1 s that ignores it)
    onResetNorth: () => mapRef.current?.resetNorth({ duration: motionDuration(600) }),
    onFit: centerIncident,
    onLocate: () => setLocateReq((n) => n + 1),
    // Standort teilen — the act, one row under «Mein Standort». ALWAYS rendered: when there is
    // nothing to report into (a finished Einsatz, the demo) it says so in place rather than
    // vanishing, because an absent control and an unbuilt feature look identical. One tap once
    // the device has permission and a name; otherwise the sheet asks for both first.
    share: (() => {
      const C = appConfig.copy.sharePosition
      // The demo no longer blocks this: sharing there is simulated — the control works, a dot
      // walks, and no location is taken or sent (lib/demoCrewWalk). The sub-line says so, so
      // nobody believes the demo is broadcasting their phone.
      const blocked = !incidentOpen ? C.menuClosed : null
      const on = share.state !== 'off'
      return {
        on,
        label: on ? C.menuOn : C.menuOff,
        // While sharing, the sub-line names the way out. Turning it ON is one tap, so turning
        // it OFF has to be one tap in the same place, and has to SAY so — a device that is
        // broadcasting where somebody is must never make stopping the thing you go hunting for.
        note: blocked ?? (isDemoMode() ? C.menuDemo : on ? C.menuOnHint : null),
        disabled: !!blocked,
        onToggle: () => {
          if (on) { share.stop(); return false }
          // One tap only once somebody confirmed «das bin ich» FOR THIS Einsatz. A device that
          // merely remembers a name from the last one has to be asked again — a Tablet that
          // gets handed around otherwise reports the whole Einsatz under the wrong name. The
          // permission is not re-asked, only the identity, so that is the picker alone.
          else if (share.confirmed) { share.start(); return false }
          else {
            setShareParent('views')
            setSharePick(share.ready ? 'pick' : 'ask')
            return true
          }
          return false
        },
      }
    })(),
    onSave: () => {
      // The time it was saved, not «Ansicht 3». A counter says nothing about which view it
      // is; the clock at least anchors it to what was happening then, and the list is in
      // save order anyway. Renaming stays one tap away for a view worth a real name.
      const v: CameraView = { id: newId('v'), name: formatTime(new Date()), center: view.center, zoom: view.zoom, bearing: view.bearing }
      setCameraViews((vs) => [...vs, v])
      // …and it comes back off the list with ↶, like everything else on the Karte. An Ansicht is
      // cheap to make and was impossible to unmake except by deleting it through a confirm.
      rememberOneShotRef.current('ansicht', C_HIST.undoDomains.ansicht,
        () => setCameraViews((vs) => vs.filter((x) => x.id !== v.id)),
        () => setCameraViews((vs) => (vs.some((x) => x.id === v.id) ? vs : [...vs, v])))
      toast(appConfig.copy.mapViews.saved, { icon: 'compass', tone: 'success' })
    },
    onRename: (id, name) => {
      const prev = cameraViews.find((v) => v.id === id)
      if (!prev || !name || name === prev.name) return
      setCameraViews((vs) => vs.map((v) => (v.id === id ? { ...v, name } : v)))
      rememberOneShotRef.current('ansicht', C_HIST.undoDomains.ansicht,
        () => setCameraViews((vs) => vs.map((v) => (v.id === id ? { ...v, name: prev.name } : v))),
        () => setCameraViews((vs) => vs.map((v) => (v.id === id ? { ...v, name } : v))))
    },
    onDelete: async (id) => {
      const index = cameraViews.findIndex((x) => x.id === id)
      const v = cameraViews[index]; if (!v) return
      const ok = await confirmDialog({ title: appConfig.copy.mapViews.deleteTitle, message: fillTemplate(appConfig.copy.mapViews.deleteMsg, { name: v.name }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
      setCameraViews((vs) => vs.filter((x) => x.id !== id))
      // the confirm asked; the timeline entry is what makes the answer reversible — the view
      // comes back at the position it stood in, because the list is in save order
      rememberOneShotRef.current('ansicht', C_HIST.undoDomains.ansicht,
        () => setCameraViews((vs) => (vs.some((x) => x.id === id) ? vs : [...vs.slice(0, index), v, ...vs.slice(index)])),
        () => setCameraViews((vs) => vs.filter((x) => x.id !== id)))
    },
  }
  // Open/close the views popover. Opening it first drops any active tool and the Ebenen
  // panel (only one of {views popover, Ebenen, tool dock} occupies the dock slot).
  // Activating a tool closes both back (the effect below), so no two are ever open together.
  const toggleViews = (open: boolean) => {
    if (open) clearMapUi('selection')
    setViewsOpen(open)
  }

  // --- keyboard shortcuts ---------------------------------------------------------------------
  // Duplicate the current selection (Cmd/Ctrl+D) — a small nudge so the copy is visibly offset and
  // separately selectable (lib/duplicate). Single symbol/shape/note OR single drawing; live GPS
  // markers can't be copied. Multi-select duplicate isn't wired (rare; would need per-item id remap).
  const duplicateSelection = () => {
    // tacticalLocked, not readOnly: the drawing branch below used to duplicate for real in the
    // Führungsansicht, where readOnly is false.
    if (tacticalLocked) return
    if (selectedId) {
      const src = doc.entities.find((e) => e.id === selectedId)
      if (!src || src.live || !Array.isArray(src.coord)) return
      const id = newId('p')
      const copy = duplicateEntity(src, id)
      commit((d) => ({ ...d, entities: [...d.entities, copy] }))
      setSelectedId(id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
      log('layers', appConfig.copy.log.duplicated, 'symbol', undefined, id); emit('entity.add', { id, entity: copy })
    } else if (selectedDrawingId) {
      const src = doc.drawings.find((dr) => dr.id === selectedDrawingId)
      if (!src) return
      const id = newId('sh')
      const copy = duplicateDrawing(src, id)
      commit((d) => ({ ...d, drawings: [...d.drawings, copy] }))
      setSelectedDrawingId(id); setSelectedId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
      log('layers', appConfig.copy.log.duplicated, 'symbol', undefined, id); emit('draw.add', { id, kind: src.kind, drawing: copy })
    }
  }

  // Jump straight to the Nth surface (number keys). Pressing the Pläne key again while already in
  // Pläne cycles to the next plan document, so the whole nav is reachable from the keyboard.
  // a number key opens the plan module carrying that number (2 or 3 → the "2/3" sheet). No such
  // module → do nothing. Sub-slots / Umgebung / Gebäude have no number and are reached by stepping.
  // Returns whether it landed, so callers that need a fallback (the checklist deep link) can
  // tell "opened Modul n" from "this object has no such module".
  const goToModule = (n: number): boolean => {
    const doc = planDocs.find((p) => moduleNumbers(p).includes(n))
    if (!doc) return false
    if (mode !== 'plans') clearMapUi()
    setMode('plans'); setActivePlanId(doc.id)
    return true
  }

  // Reassigned every render (effect, no deps) so the mount-once listener (above) always sees
  // live handlers/state without re-subscribing — the latest-ref pattern.
  useEffect(() => { hotkeyRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(document.activeElement)) return
    // WHERE the key goes is lib/hotkeyRoute's table (pure, tested there); this only carries it out
    const { action: a, prevent } = routeHotkey(resolveHotkey(e), {
      // a modal sheet owns the screen — its own focus trap / Esc handle keys; stay inert behind it.
      modalOpen: !!(settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || shareLink || composerOpen),
      mode, georefPlanId: georefActive ? georefMode.planId : null,
      moduleTargetId: (n) => planDocs.find((p) => moduleNumbers(p).includes(n))?.id,
      tacticalLocked, replayActive, readOnly, linkScoped,
    })
    if (prevent) e.preventDefault()
    switch (a.type) {
      case 'georef': georefDispatch({ type: a.go }); break
      case 'module': goToModule(a.n); break
      case 'surface': if (a.clear) clearMapUi(); setMode(a.surface); break
      case 'nav': goToNav(a.dir); break
      case 'fitPlan': planFit.current?.(); break
      case 'centerMap': centerIncident(); break
      // No caption — a keyboard user is not asking a button what it did.
      case 'undo': stepHistory('undo'); break
      case 'redo': stepHistory('redo'); break
      case 'duplicateMap': duplicateSelection(); break
      case 'duplicatePlan': planKeys.current?.duplicate(); break
      case 'toolMap': pick(a.tool); break
      case 'toolPlan': planKeys.current?.pickTool(a.tool); break
      case 'journal': setJournalOpen((v) => !v); break
      case 'composer': setComposerOpen(true); break
      case 'layers': togglePanel('layers'); break
      case 'settings': setSettingsOpen(true); break
      case 'help': setHelpOpen(true); break
      case 'zoomPlan': planKeys.current?.zoom(a.factor); break
      case 'zoomMap': if (a.dir === 'in') mapRef.current?.zoomIn(); else mapRef.current?.zoomOut(); break
      case 'locate': setLocateReq((n) => n + 1); break
      case 'coord': coord.cycle(); break
    }
  } })

  const selected = entities.find((e) => e.id === selectedId) ?? null
  // the note whose ⚙ was tapped — a deleted note simply drops out here and the panel unmounts
  const noteEntity = entities.find((e) => e.id === notePanelId && e.kind === 'note') ?? null
  // the panel belongs to the SELECTED note: deselecting (empty map, Esc, picking something
  // else) closes it too, so a stray panel can never outlive the thing it describes
  useEffect(() => { if (notePanelId && selectedId !== notePanelId) setNotePanelId(null) }, [selectedId, notePanelId])
  // reaching for a tool means you are done reading this note — the panel should not sit there
  // while you place the next thing (selection alone doesn't change until that thing lands)
  useEffect(() => { if (tool !== 'select') setNotePanelId(null) }, [tool])
  // the «just placed» mark lives exactly as long as that panel does
  useEffect(() => { if (notePlacedId && notePanelId !== notePlacedId) setNotePlacedId(null) }, [notePanelId, notePlacedId])

  const mapWorkRect = (container: DOMRect, panelEl: Element): NudgeBox | null => {
    const panel = panelEl.getBoundingClientRect()
    if (!panel.width) return null
    const surface = { minX: 0, maxX: container.width, minY: 0, maxY: container.height }
    const obstruction = {
      minX: panel.left - container.left, maxX: panel.right - container.left,
      minY: panel.top - container.top, maxY: panel.bottom - container.top,
    }
    return visibleWorkRect(surface, obstruction, isBottomSheet(panel.width, container.width))
  }

  // keep the tapped symbol visible: the ContextPanel overlay covers the right band of the
  // map — when the selection (incl. its halo/handles) lands under it, ease the camera just
  // enough to bring it clear (lib/panelNudge). Keyed on the id only, NOT the coord: dragging
  // or rotating the selected symbol must never re-trigger a camera move. The rAF lets the
  // panel mount first so we measure its real rect (desktop/tablet widths differ).
  useEffect(() => {
    if (!selectedId || mode !== 'map') return
    const raf = requestAnimationFrame(() => {
      const m = mapRef.current?.getMap()
      const panelEl = document.querySelector('.ctx')
      if (!m || !panelEl || !selected) return
      const cont = m.getContainer().getBoundingClientRect()
      const work = mapWorkRect(cont, panelEl)
      if (!work) return // panel present but CSS-hidden — nothing occludes
      const pt = m.project(selected.coord)
      const nudge = nudgePointIntoRect(pt, work)
      if (nudge) m.panBy(nudge, { duration: motionDuration(350) })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mode, notePanelId])
  // same courtesy for a tapped or just-finished drawing: the DrawEditor is the same .ctx
  // overlay, but a line/area/circle occupies an extent — so its whole projected bbox
  // (circle = centre ± radius) is brought clear, capped by panelNudgeBox so an extent
  // wider than the open area never slides fully off-screen. Keyed on the id only, like
  // the symbol nudge: reshaping/moving the selected drawing must not re-trigger a pan.
  useEffect(() => {
    if (!selectedDrawingId || mode !== 'map') return
    const raf = requestAnimationFrame(() => {
      const m = mapRef.current?.getMap()
      const panelEl = document.querySelector('.ctx')
      const d = drawings.find((x) => x.id === selectedDrawingId)
      if (!m || !panelEl || !d?.coords.length) return
      const cont = m.getContainer().getBoundingClientRect()
      const work = mapWorkRect(cont, panelEl)
      if (!work) return // panel present but CSS-hidden — nothing occludes
      const coords = d.kind === 'circle' && d.radiusM
        ? (circlePolygon(d.coords[0], d.radiusM, 16)[0] as LngLat[])
        : d.coords
      const pts = coords.map((c) => m.project(c))
      const box = {
        minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
      }
      // `e.point` is already container-relative, the same space `box` lives in
      const tap = drawTap?.id === selectedDrawingId ? { x: drawTap.x, y: drawTap.y } : null
      const nudge = nudgeSelectionIntoRect(box, tap, work)
      if (nudge) m.panBy(nudge, { duration: motionDuration(350) })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingId, mode])

  // a marquee selects a SET of drawings: one falls back to the single-edit path, several
  // become a group (move/delete together). Empty box clears any selection. The lasso is a
  // one-shot tool: drop back to plain navigate (select) after the box so a stray next
  // finger pans the map instead of drawing another box.
  const onMarquee = (drawIds: string[], entIds: string[]) => {
    // live (GPS) entities aren't editable, and anything LOCKED is click-through — its chip is
    // the only door (LockChip), so a lasso may neither move, delete nor select it
    const ents = entIds.filter((id) => { const e = entities.find((x) => x.id === id); return !liveIds.has(id) && !e?.locked })
    const draws = drawIds.filter((id) => !drawings.find((d) => d.id === id)?.locked)
    setSelectedId(null)
    if (draws.length + ents.length <= 1) {
      // a single object → drop into the normal single-edit selection
      setSelectedDrawIds([]); setSelectedEntityIds([])
      setSelectedDrawingId(draws[0] ?? null)
      setSelectedId(ents[0] ?? null)
    } else {
      setSelectedDrawingId(null)
      setSelectedDrawIds(draws); setSelectedEntityIds(ents)
    }
    setTool('select')
  }
  // Move and/or turn the marquee group from the selection bar: a (lng,lat) delta and a turn in
  // degrees, both applied to the snapshot taken at gesture start (drawings' coords + entities'
  // coord) — so the whole drag is one undo step and no frame compounds on the last.
  // A turn moves each member AROUND the group's centre and turns each member's own bearing by
  // the same amount, which is what makes a boxed picture read as one rigid thing.
  const groupOrig = useRef<{ draws: Record<string, LngLat[]>; ents: Record<string, Entity>; centre: LngLat | null }>({ draws: {}, ents: {}, centre: null })
  const transformGroup = (ids: string[], entIds: string[], t: { dLng: number; dLat: number; deg: number }, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') {
      beginDrag()
      const draws = Object.fromEntries(ids.map((id) => [id, drawings.find((d) => d.id === id)?.coords ?? []]))
      const ents = Object.fromEntries(entIds.flatMap((id) => { const e = entities.find((x) => x.id === id); return e ? [[id, e] as [string, Entity]] : [] }))
      groupOrig.current = {
        draws,
        ents,
        centre: centroid([
          ...Object.values(draws).flat().map((c) => c as [number, number]),
          ...Object.values(ents).map((e) => e.coord as [number, number]),
        ]),
      }
      return
    }
    const { draws, ents, centre } = groupOrig.current
    // rigid in a local east/north frame, so the turn looks like a turn at any latitude
    const xScale = centre ? Math.cos((centre[1] * Math.PI) / 180) || 1e-6 : 1
    const turn = (c: LngLat): LngLat => (t.deg && centre
      ? rotateAround(c as [number, number], centre as [number, number], t.deg, { xScale, yUp: true }) as LngLat
      : c)
    /** What the write actually produced, for the release to record. ⚠️ The group bar was the one
     *  map gesture that emitted NOTHING at all: a marquee of eleven symbols dragged across the
     *  Lage left no trace in the audit stream, so the replay held them at their last snapshotted
     *  place — and once a member of the group could be sheet-anchored, its flip was reported
     *  (`onAnchorChange`) with no ground position to go with it. */
    const written: { doc: Doc | null } = { doc: null }
    setDocRaw((d) => (written.doc = {
      ...d,
      drawings: d.drawings.map((dr) => (ids.includes(dr.id) && draws[dr.id]
        ? { ...dr, coords: moveLineBody({ id: dr.id, points: draws[dr.id].map(turn), startAttachment: dr.startAttachment, endAttachment: dr.endAttachment }, [t.dLng, t.dLat]) }
        : dr)),
      entities: d.entities.map((e) => {
        const o = entIds.includes(e.id) ? ents[e.id] : undefined
        if (!o) return e
        const [lng, lat] = turn(o.coord)
        return {
          ...e,
          coord: [lng + t.dLng, lat + t.dLat] as LngLat,
          // a symbol's own bearing is geographic too, so it turns with the picture
          ...(t.deg && o.rotation !== undefined ? { rotation: turnedBy(o.rotation, t.deg) } : null),
          ...(t.deg && o.rotation2 !== undefined ? { rotation2: turnedBy(o.rotation2, t.deg) } : null),
        }
      }),
    // the boxed group IS what the hand moved — every member of it, and nothing else
    }), { movedIds: [...ids, ...entIds] })
    if (phase === 'end') {
      endDrag()
      // one event per member, on release only — the same grammar a single marker's drag has.
      // A release that moved NOTHING (tap on the handle, no drag) emits nothing: every plan-side
      // sibling guards this way, and n no-op rows are audit noise proportional to the selection.
      if (t.dLng || t.dLat || t.deg) {
        for (const e of written.doc?.entities ?? []) if (entIds.includes(e.id)) emit('entity.move', { id: e.id, coord: e.coord })
        for (const dr of written.doc?.drawings ?? []) if (ids.includes(dr.id)) emit('draw.edit', { id: dr.id, patch: { coords: dr.coords } })
      }
      groupOrig.current = { draws: {}, ents: {}, centre: null }
    }
  }
  // ⚠️ A trail no longer LOCKS its marker (18.09.2026, Karte/Plan parity). The record is
  // protected by outliving the marker instead: the removed marker's recorded positions move into
  // a ghost trail the incident owns (lib/truppTrails · reconcileGhostTrails, the effect below).
  const deleteGroup = async (ids: string[], entIds: string[]) => {
    if (tacticalLocked) return
    const ents = entIds.filter((id) => !liveIds.has(id))
    const affected = drawings.flatMap((dr) => ids.includes(dr.id) ? [] : (['start', 'end'] as const).flatMap((endpoint) => {
      const a = endpoint === 'start' ? dr.startAttachment : dr.endAttachment
      return a && ((a.target.kind === 'object' && ents.includes(a.target.id)) || (a.target.kind === 'line' && ids.includes(a.target.id))) ? [{ dr, endpoint, a }] : []
    }))
    if (affected.length) {
      const ok = await confirmDialog({ title: appConfig.copy.whiteboard.groupDeleteTitle, message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    commit((d) => ({
      ...d,
      drawings: d.drawings.filter((dr) => !ids.includes(dr.id)).map((dr) => {
        let next = dr
        for (const endpoint of ['start', 'end'] as const) {
          const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
          if (!a || next.coords.length < 2) continue
          const object = a.target.kind === 'object' && ents.includes(a.target.id) ? entities.find((e) => e.id === a.target.id) : null
          const targetLine = a.target.kind === 'line' && ids.includes(a.target.id) ? drawings.find((x) => x.id === a.target.id) : null
          const fallback = object?.coord ?? (targetLine && a.target.kind === 'line' ? targetLine.coords[a.target.endpoint === 'start' ? 0 : targetLine.coords.length - 1] : null)
          if (!fallback) continue
          const coords = next.coords.map((p, i) => i === (endpoint === 'start' ? 0 : next.coords.length - 1) ? fallback : p)
          next = { ...next, coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
        }
        return next
      }),
      entities: d.entities.filter((e) => !ents.includes(e.id)),
    }))
    ids.forEach((id) => emit('draw.delete', { id }))
    ents.forEach((id) => emit('entity.delete', { id }))
    affected.forEach(({ dr, endpoint, a }) => {
      const object = a.target.kind === 'object' ? entities.find((e) => e.id === a.target.id) : null
      const targetLine = a.target.kind === 'line' ? drawings.find((x) => x.id === a.target.id) : null
      const fallback = object?.coord ?? (targetLine && a.target.kind === 'line' ? targetLine.coords[a.target.endpoint === 'start' ? 0 : targetLine.coords.length - 1] : dr.coords[endpoint === 'start' ? 0 : dr.coords.length - 1])
      const coords = dr.coords.map((p, i) => i === (endpoint === 'start' ? 0 : dr.coords.length - 1) ? fallback : p)
      emit('draw.edit', { id: dr.id, patch: { coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) } })
    })
    setSelectedDrawIds([]); setSelectedEntityIds([])
    // «Zeichnung entfernt» after a lasso over eleven objects is not vague, it is wrong — the
    // singular says one thing went. The count is right here; a reconstruction needs it. A single
    // deletion is named like its creation row («Fläche gelöscht», «Einsatzleiter gelöscht»).
    const gone = ids.length + ents.length
    const lone = ids.length === 1 ? drawings.find((d) => d.id === ids[0]) : undefined
    const loneEnt = ents.length === 1 ? entities.find((e) => e.id === ents[0]) : undefined
    log('close', gone > 1
      ? fillTemplate(appConfig.copy.log.selectionDeleted, { n: gone })
      : lone ? fillTemplate(appConfig.copy.log.objectDeleted, { name: drawingLogName(lone) })
      : loneEnt ? fillTemplate(appConfig.copy.log.objectDeleted, { name: entityLogName(loneEnt) })
      : appConfig.copy.log.drawingDeleted,
      // …named by WHAT was removed, so two «Feuerwehr gelöscht» seconds apart stay two rows
      undefined, undefined, undefined, { subjectId: ids[0] ?? ents[0] })
  }

  /** Centre a deliberate jump in the part of the map that remains visible around an editor.
   *  Selection state mounts the editor in the same frame; one rAF lets us measure its real
   *  desktop/tablet/phone geometry before the camera moves. Zoom is chosen by the caller. */
  const flyToMapVisible = (center: LngLat, zoom: number) => {
    requestAnimationFrame(() => {
      const m = mapRef.current?.getMap()
      if (!m) return
      const cont = m.getContainer().getBoundingClientRect()
      const panelEl = document.querySelector('.ctx')
      const surface = { minX: 0, maxX: cont.width, minY: 0, maxY: cont.height }
      const work = panelEl ? mapWorkRect(cont, panelEl) : visibleWorkRect(surface, null, false)
      const target = rectCenter(work ?? visibleWorkRect(surface, null, false))
      m.flyTo({ center, zoom, offset: [target.x - cont.width / 2, target.y - cont.height / 2], ...(prefersReducedMotion() ? { duration: 0 } : {}) })
    })
  }

  // select + fly to an object — used by clickable Verlauf rows
  const focusEntity = (id: string) => {
    const e = entities.find((x) => x.id === id); if (!e) return
    setSelectedId(id); setSelectedDrawingId(null); flyToMapVisible(e.coord, 18.4)
  }
  const focusDrawing = (id: string) => {
    const d = drawings.find((x) => x.id === id); if (!d?.coords[0]) return
    // A long line is never zoom-fitted. Its first real vertex is enough to make a useful part
    // visible, centred in the free workspace; the current drawing zoom convention stays intact.
    setSelectedDrawingId(id); setSelectedId(null); flyToMapVisible(d.coords[0], 17.8)
  }
  /** One movement path for a real Lage marker and for that marker's projection on a Modul.
   *  The gesture still writes the ONE source entity, so undo, routed Leitungen, audit and Verlauf
   *  cannot diverge depending on which picture the operator happened to drag. */
  const startEntityMove = (id: string) => { if (!liveIds.has(id)) beginDrag() }
  const streamEntityMove = (id: string, c: LngLat) => {
    if (tacticalLocked) return
    if (liveIds.has(id)) { setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], coord: c } })); return }
    setDocRaw((d) => ({
      ...d,
      // an angedockte Gefahrentafel rides along mid-drag too (lib/docking), keeping the
      // offset the operator chose — not just snapping into place on release
      entities: carryDocked(d.entities, id, d.entities.find((e) => e.id === id)?.coord ?? c, c)
        .map((e) => (e.id === id ? { ...e, coord: c } : e)),
      drawings: d.drawings.map((dr) => {
        if (dr.kind !== 'line') return dr
        let next = dr
        for (const endpoint of ['start', 'end'] as const) {
          const a = next[endpoint === 'start' ? 'startAttachment' : 'endAttachment']
          if (a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace') next = { ...next, coords: applyRouting(next.coords, endpoint, c, 'trace', 0.000008) }
        }
        return next
      }),
    // ⚠️ ONE id: the write carries the docked placard and re-routes the attached hoses, and
    // none of those were placed by the hand that dragged this (lib/tacticalObjects · movedIds).
    }), { movedIds: [id] })
  }
  const finishEntityMove = (id: string, c: LngLat, join?: { lineId: string; endpoint: LineEndpoint } | null, dock?: { hostId: string } | null) => {
    if (tacticalLocked) return
    if (liveIds.has(id)) setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], coord: c } }))
    else {
      // Andocken (lib/docking, Feldtest Manuel 07.09.): a Gefahrentafel dropped beside a
      // dockable object becomes its placard; dropped in the open, an existing bond lets go.
      // Decided here, once, on release — never re-resolved — and the whole answer folds into
      // the same undo step as the move itself. Since 15.09. a Trupp marker docks the same way:
      // «bei «Hydrant»» on its card, and it rides along when the symbol is moved.
      const ent = doc.entities.find((x) => x.id === id)
      const map = mapRef.current
      let dockPatch: { dockedTo: string | undefined } | null = null
      let dockHost: Entity | undefined
      if (isDockable(ent) && map) {
        const others = doc.entities.filter((e) => e.id !== id)
        const near = () => nearestDockHost(c, others, (p) => map.project(p), dockRadiusFor(ent)) ?? undefined
        // a Trupp marker docks only through a CLOSED ring (MapView · trackDockAim); with the ring
        // still open the drop keeps an existing bond while it is in reach and lets go beyond it
        dockHost = dock === undefined ? near()
          : dock ? others.find((e) => e.id === dock.hostId)
          : (ent?.dockedTo && near()?.id === ent.dockedTo ? near() : undefined)
        if ((dockHost?.id ?? undefined) !== ent?.dockedTo) dockPatch = { dockedTo: dockHost?.id }
      }
      // Ein Trupp auf dem Leitungsende (15.09.): dropping a Trupp's marker on the FREE end of a
      // hose joins the two, the same link snapping the hose onto the marker makes — the picture
      // is the pick, from whichever side the operator happens to work.
      // ⚠️ The aim is NOT re-computed here. The Karte drew the blue ring while the marker
      // travelled and it is the one that knows whether the ring actually CLOSED — «not armed =
      // nothing attaches, not even on release» (MapView · trackTeamJoin). Guessing a second time
      // at the drop point is how this coupled hoses nobody had aimed at. It is still folded into
      // the move's own undo step, as one gesture.
      // ⚠️ …and ONE Trupp per Leitung (lib/truppLines · lineTakesTrupp, 15.09.): a hose that
      // already has a crew takes no second one, not even the same one at its other end. The ring
      // is not offered for such an end in the first place (MapView · freeHoseEnds), so this is
      // the floor under a stale aim — the map never silently replaces a crew, which is the
      // Atemschutz board's job and asks first.
      const hoseJoin = ent?.kind === 'team' && ent.truppId
        && (!join || lineTakesTrupp(doc.drawings.find((dr) => dr.id === join.lineId) ?? { id: join.lineId }, trupps))
        ? (join ?? null) : null
      const hoseKey = hoseJoin?.endpoint === 'start' ? 'startAttachment' : 'endAttachment'
      // the marker's own trace-routed coupling, written exactly as the endpoint magnet writes one
      const hoseAttachment: LineAttachment = { target: { kind: 'object', id }, routing: 'trace' }
      // a moved team marker re-stamps its «last moved» time; it does NOT breadcrumb
      setDocRaw((d) => ({
        ...d,
        entities: carryDocked(d.entities, id, d.entities.find((e) => e.id === id)?.coord ?? c, c)
          .map((e) => (e.id === id ? { ...e, coord: c, ...(dockPatch ?? {}), ...(e.kind === 'team' ? { t: formatTime(new Date()) } : {}) } : e)),
        drawings: hoseJoin
          ? d.drawings.map((dr) => (dr.id === hoseJoin.lineId ? { ...dr, [hoseKey]: hoseAttachment } : dr))
          : d.drawings,
      }), { movedIds: [id] })
      endDrag()
      if (hoseJoin && ent?.truppId) {
        emit('draw.attach', { id: hoseJoin.lineId, endpoint: hoseJoin.endpoint, attachment: hoseAttachment })
        // …and the link itself, unless this hose is already anchored to this very Trupp — nudging
        // the marker beside its own Leitung is not a new fact, and every link writes a Verlauf row
        if (doc.drawings.find((dr) => dr.id === hoseJoin.lineId)?.truppId !== ent.truppId) linkTruppLine(ent.truppId, hoseJoin.lineId)
      }
      if (dockPatch) {
        const name = ent?.label || appConfig.copy.entities.fallbackObjectName
        const hostName = (dockHost ?? doc.entities.find((e) => e.id === ent?.dockedTo))?.label
          || appConfig.copy.entities.fallbackObjectName
        const L = appConfig.copy.log
        log('select', fillTemplate(isPlacard(ent) ? (dockHost ? L.placardDocked : L.placardUndocked) : (dockHost ? L.teamDocked : L.teamUndocked),
          { name, host: hostName }), isPlacard(ent) ? 'symbol' : 'team', undefined, id)
        emit('entity.edit', { id, patch: dockPatch })
      }
      // …and the placards this host carried along re-emit like the trace-routed lines below
      for (const e of doc.entities) {
        if (e.dockedTo === id && e.coord && ent?.coord) {
          emit('entity.move', { id: e.id, coord: [e.coord[0] + c[0] - ent.coord[0], e.coord[1] + c[1] - ent.coord[1]] })
        }
      }
    }
    log('select', fillTemplate(appConfig.copy.log.objectMoved, { name: entities.find((x) => x.id === id)?.label ?? appConfig.copy.entities.fallbackObjectName }), 'symbol', undefined, id)
    emit(liveIds.has(id) ? 'entity.edit' : 'entity.move', { id, coord: c })
    drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace'))
      .forEach((d) => emit('draw.edit', { id: d.id, patch: { coords: d.coords } }))
  }
  /**
   * «Lösen» on an angedockter Trupp, from the HOST symbol's panel (15.09.2026).
   *
   * The exact inverse of the drop that made the bond, and it reports itself the same way that
   * drop does — the `teamUndocked` Verlauf row — plus the confirm-with-undo toast the marker's
   * own «Lösen» wears: the bond is a document write, but a bond broken by a tap on a list of
   * rows deserves the same one-shot way back as one broken by a drag.
   * The marker keeps its coordinate and simply stands on it again (lib/docking · dockSlotOffset:
   * only the RENDERED position was ever snapped to the host's corner).
   */
  const undockTeam = (entityId: string) => {
    const ent = doc.entities.find((e) => e.id === entityId)
    const hostId = ent?.dockedTo
    if (!ent || !hostId) return
    const L = appConfig.copy.log
    const line = fillTemplate(L.teamUndocked, {
      name: ent.label || appConfig.copy.entities.fallbackObjectName,
      host: doc.entities.find((e) => e.id === hostId)?.label || appConfig.copy.entities.fallbackObjectName,
    })
    patchEntity(entityId, { dockedTo: undefined })
    log('select', line, 'team', undefined, entityId)
    undoToast(line, () => patchEntity(entityId, { dockedTo: hostId }))
  }
  /**
   * A live Fahrzeug was dragged on a Modul — «hier ist es wirklich».
   *
   * Deliberately the SAME three calls the Karte's own marker drag makes, in the same order: the
   * gesture writes the one override, so undo, trace-routed Leitungen, the audit event and the
   * Verlauf row cannot diverge depending on which picture the operator happened to have in front
   * of them. `startEntityMove`'s doc has described this as its second call site since the
   * Georeferenz landed; until 27.08. nothing actually called it that way, so a twin simply
   * ignored every drag and the sheet gave no reason why.
   *
   * A LIVE vehicle behaves exactly as it does on the Karte: `finishEntityMove` writes a position
   * override, which is «Festhalten» — the vehicle stops following the feed until «GPS» hands it
   * back. Dragging one here is the same statement as dragging it there.
   */
  /** A live Fahrzeug dropped on a sheet — the same writers the Karte's own marker drag uses, so
   *  it lands as the same held-in-place override and nothing about it depends on which surface
   *  the finger was on. */
  const moveLiveOnSheet = (entityId: string, coord: LngLat, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') startEntityMove(entityId)
    else if (phase === 'move') streamEntityMove(entityId, coord)
    else finishEntityMove(entityId, coord)
  }
  /** Every Trupp standing somewhere on this Einsatz — Lage markers AND plan chips, Atemschutz
   *  or not (lib/placedTrupps). Feeds the rail's count and the finder's list. */
  const placed = useMemo(() => placedTrupps(objects, planDocs, trupps), [objects, planDocs, trupps])
  /**
   * Go to the picked Trupp. ⚠️ The SAME two jumps «auf Plan zeigen» makes from the Atemschutz
   * card (useTruppActions · focusTruppOnPlan) — a second way to arrive at a marker would be a
   * second set of rules about what «zeigen» leaves behind: the map jump selects the marker, the
   * plan jump opens its storey and points at the chip.
   */
  /** «Auf Plan zeigen». The object is an ordinary anno on that sheet — same id — so this is the
   *  sheet's own «zeigen», not a door to a projection. */
  const showMapSourceOnPlan = (entity: Entity, target = selectedPlanProjection) => {
    if (!target) return
    setPanel(null); setMode('plans'); setActivePlanId(target.plan.id)
    setPlanFocus({ x: target.pt.x, y: target.pt.y, floor: 0, annoId: entity.id, nonce: Date.now() })
  }
  /** «Auf der Karte zeigen», from a plan-drawn object's own panel. It IS a map object — same id,
   *  same selection, same detail panel — so this is the ordinary jump, not a door to a projection.
   *
   *  ⚠️ …unless it is not there yet: a sheet whose georeference has just been made, or an object
   *  the fit cannot place, has no map body to select. `coord` is the projected point the caller
   *  already worked out, and flying to it is the honest answer — the operator asked to be shown
   *  where this is, not to have it selected. */
  const showPlanSourceOnMap = (_planId: string, annoId: string, coord: LngLat) => {
    setPanel(null); setMode('map')
    if (doc.entities.some((e) => e.id === annoId)) focusEntity(annoId)
    flyToMapVisible(coord, 18.4)
  }
  const goToTrupp = (t: PlacedTrupp) => {
    setPanel(null)
    if (t.target.kind === 'map') { setMode('map'); focusEntity(t.target.entityId); return }
    setMode('plans'); setActivePlanId(t.target.planId)
    setPlanFocus({ x: t.target.x, y: t.target.y, floor: t.target.floor, annoId: t.target.annoId, nonce: Date.now() })
  }
  const deleteEntity = async (id: string) => {
    if (tacticalLocked) return false
    const ent = entities.find((e) => e.id === id)
    const connected = drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === id))
    // Written notes and any indirectly detached lines ask once before the structural change.
    if ((ent?.kind === 'note' && (ent.label ?? '').trim()) || connected.length) {
      const ok = await confirmDialog({
        title: connected.length ? fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: ent?.label ?? appConfig.copy.entities.fallbackObjectName }) : appConfig.copy.notes.deleteTitle,
        message: connected.length ? fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: connected.length }) : appConfig.copy.notes.deleteMsg,
        confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
      })
      if (!ok) return false
    }
    commit((d) => ({
      ...d,
      // …and a deleted host releases its angedockte Gefahrentafel (the placard stays — it is
      // still a record of the substance — it just stops following a ghost)
      entities: d.entities.filter((e) => e.id !== id).map((e) => (e.dockedTo === id ? { ...e, dockedTo: undefined } : e)),
      // the same detach «Hierher übertragen» performs — see detachDrawingFrom
      drawings: ent ? d.drawings.map((dr) => detachDrawingFrom(dr, ent)) : d.drawings,
    }))
    if (selectedId === id) setSelectedId(null)
    if (editNoteId === id) setEditNoteId(null)
    // ⚠️ An EMPTY Notiz writes no row. Its label is `''`, not undefined, so `??` never reached the
    // fallback name and the Verlauf printed a bare «gelöscht» — a row that names nothing, about a
    // note that said nothing. The same predicate already decides that this deletion asks nothing
    // (see the confirm above): a note with no text is a placement being taken back, not a record.
    // Rows already written stay: the journal is append-only, this only stops writing a new one.
    if (!(ent?.kind === 'note' && !(ent.label ?? '').trim())) {
      log('close', fillTemplate(appConfig.copy.log.objectDeleted, { name: ent?.label ?? appConfig.copy.entities.fallbackObjectName }),
        undefined, undefined, undefined, { subjectId: id })
    }
    emit('entity.delete', { id })
    if (ent) connected.forEach((dr) => {
      for (const endpoint of ['start', 'end'] as const) {
        const a = endpoint === 'start' ? dr.startAttachment : dr.endAttachment
        if (a?.target.kind !== 'object' || a.target.id !== id) continue
        const coords = dr.coords.map((p, i) => i === (endpoint === 'start' ? 0 : dr.coords.length - 1) ? ent.coord : p)
        emit('draw.edit', { id: dr.id, patch: { coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) } })
      }
    })
    return true
  }
  // a generic (untracked) team marker — the map twin of the plan's placeTeamChip
  const { placeGenericTeam, renameTeam, markTeamPosition, clearTeamTrail } = useTeamMarkerActions({
    entities, commit, log, emit, setSelectedId, setSelectedDrawingId,
    // every plan's chips and every registered Trupp count into the numbering: ONE counter per
    // Einsatz (docs/trupp-naming.md §1)
    placedTeamNames: () => Object.values(board).flat().filter((a) => a.kind === 'resource').map((a) => a.text),
    trupps: () => truppsRef.current,
  })
  // --- Atemschutzüberwachung (SCBA monitoring): Trupp mutations live in useTruppActions ---
  const { createTrupp, updateTrupp, moveTrupp, placeTruppOnPlan, placeTruppOnMap, adoptTruppMarker, releaseTruppMarker, askTruppEntry, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, transferOutOfTrupp, reactivateTrupp, logTruppAlarm, logTruppAlarmCleared, deleteTrupp, restoreTrupp, linkTruppLine, linkLineToAttachedTrupp, unlinkLineFromDetachedTrupp, unlinkTruppLine, unlinkLine, syncLineNoToTrupp, showTruppLine, truppsWithLine, truppLineNos, truppColors } =
    useTruppActions({
      trupps, drawings, entities, objects, setTrupps, board, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus,
      // The Atemschutz-Tafel joins the one global timeline (08.09.2026): every Kontakt, Druck,
      // Statuswechsel, Bearbeitung, Wieder-Einrücken, Anmeldung and Löschen records itself there,
      // so ↶ in the header reaches the board — including from the handed-over Link-Tafel, which
      // has no TopBar and gets its own pair (AtemschutzView · headActs).
      undoTimeline: undoHist,
      // ⚠️ …and reads the CURRENT trupps when a step is finally pressed, not the render that
      // recorded it. A merge between the tap and the ↶ is exactly the case that has to decline.
      liveTrupps: () => truppsRef.current,
      // An Atemschutz-Link session syncs the trupps slice and nothing else: a chip removed or
      // recoloured here would change only on this phone and be undone by the next poll, while
      // the tablet keeps the old one. So the placement half of every Trupp action is a no-op
      // there; the tablet's own board/entities stay the single source for the picture.
      setBoard: asLink ? () => {} : setBoard,
      setDocRaw: asLink ? () => {} : setDocRaw,
      // a new map marker lands at the current map centre (the operator drags it to position);
      // fall back to the Einsatzort when the map hasn't been opened yet this session
      mapCenter: () => {
        const c = mapRef.current?.getMap()?.getCenter()
        return c ? [c.lng, c.lat] as LngLat : incidentView.center
      },
      // jump-to for a team marker: coord is passed on placement (state not yet committed);
      // later focuses look the entity up like a Verlauf row does. fly=false selects without
      // moving the camera (tap-placed markers are already in view).
      // the hose a Trupp works on — «Leitung zeigen» on the Atemschutz card
      // «Leitung zeigen» SHOWS the hose, it does not open it: fly there and outline it for a
      // moment, with nothing selected — no vertex handles under the finger, no editor sheet over
      // the map. Tapping the line is still how you edit it.
      focusMapDrawing: (drawingId) => {
        setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedDrawingId(null); setSelectedId(null)
        const d = drawings.find((x) => x.id === drawingId)
        if (d?.coords[0]) flyToMapVisible(d.coords[0], 17.8)
        setFlashDrawingId(drawingId)
      },
      focusMapEntity: (entityId, coord, fly = true) => {
        setMode('map')
        if (!fly) { setSelectedId(entityId); setSelectedDrawingId(null); return }
        if (coord) { setSelectedId(entityId); setSelectedDrawingId(null); flyToMapVisible(coord, 18.4) }
        else focusEntity(entityId)
      },
    })
  /** The card's / the form's half of a marker join. A Trupp that was JUST registered is not in
   *  the hook's `trupps` until the next render, so its adopt waits one render (pendingAdopt);
   *  an existing Trupp joins straight away. */
  const [pendingAdopt, setPendingAdopt] = useState<{ truppId: string; markerId: string } | null>(null)
  const adoptMarkerA = (truppId: string, markerId: string) => {
    if (trupps.some((t) => t.id === truppId)) void adoptTruppMarker(truppId, markerId)
    else setPendingAdopt({ truppId, markerId })
  }
  useEffect(() => {
    if (!pendingAdopt || !trupps.some((t) => t.id === pendingAdopt.truppId)) return
    setPendingAdopt(null)
    void adoptTruppMarker(pendingAdopt.truppId, pendingAdopt.markerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAdopt, trupps])
  /** «Neuer Trupp» on a loose marker's join sheet (both surfaces): to the board, form open,
   *  and the marker waits for the save. */
  const newTruppFromMarker = (markerId: string) => {
    setMode('atemschutz'); setPanel(null)
    setTruppCreate({ nonce: Date.now(), adoptMarkerId: markerId })
  }
  // where a Trupp can actually go: always the Lage map (outdoor teams), plus the Gebäude
  // floor-stack ONLY once it's been created from the Umrisse (building != null), plus Modul 6
  // ONLY if this object has that plan. ≥1 target always — the picker adapts (1 → place
  // directly, 2+ → choose).
  const placeTargets = useMemo(() => [
    { id: LAGE_TARGET, label: appConfig.copy.atemschutz.placeLage },
    // …plus every plan sheet this object actually HAS, in rail order — not just Modul 6 (05.09.).
    // A Trupp works on the Modul the Einsatz is being run off, and hard-coding one slot meant a
    // station whose floor plans live on Modul 2/3 could only put a crew on the Karte. Two are
    // left out on purpose: a `viewer` sheet carries no annotation surface, and the Umrisse picker
    // (isSelectOnlySurface) is where a Gebäude is CHOSEN — the Gebäude itself is in `planDocs` the
    // moment it exists, and that is the one to stand on.
    ...planDocs.filter((p) => !p.viewer && !isSelectOnlySurface(p)).map((p) => ({ id: p.id, label: p.code })),
  ], [planDocs])
  // one placement dispatcher for the AtemschutzView picker: Lage target → map, else plan
  const placeTrupp = (id: string, targetId?: string) =>
    targetId === LAGE_TARGET ? placeTruppOnMap(id) : placeTruppOnPlan(id, targetId)
  // The Leitungen that exist on either surface, for the Trupp form's quick-picks. A function
  // rather than a memo: the «taken by» read has to ignore the Trupp currently being edited.
  const truppLeitungOptions = (exceptTruppId?: string) => leitungOptions(
    drawings.filter((d) => d.kind === 'line'),
    Object.values(board).flat().filter((a) => a.kind === 'draw'),
    effTrupps, exceptTruppId,
  )
  // The Trupp symbols that already stand somewhere, for the placement picker. A function, like
  // the Leitung quick-picks: «gehört zu» has to ignore the Trupp being placed itself.
  const truppMarkerOptions = (exceptTruppId?: string) => markerOptions(placed, effTrupps, exceptTruppId)
  // --- Anwesenheit (attendance over the Divera Mannschaft) ---
  // Roster is session-loaded; attendance rides the per-incident workspace blob. Marking
  // is append-only in spirit: a no-op tap never logs, "Gegangen" keeps the earlier presence,
  // and a person in an active Trupp can't be marked gone until the Trupp is out (checkout rule).
  const { people: personnel, loading: personnelLoading, error: personnelError, reload: reloadPersonnel } = usePersonnel()
  // Offline-readiness: the representative URLs the readiness sheet probes against the SW
  // Cache to report REAL offline presence (not a guess) for the runtime-cached resources.
  const offlineProbeUrls = useMemo(() => {
    const base = layers.find((l) => l.base && l.visible)
    const tpls = base?.tiles ?? []
    // The downloader cycles tile subdomains (Carto = a/b/c/d), so a given tile lands under ONE
    // of them. Probe the incident-centre tile across ALL subdomains and pass if any is cached —
    // checking only [0] gave a false "nicht geladen".
    let tiles: string[] = []
    if (tpls.length) {
      const z = 16
      const [lng, lat] = incidentView.center
      const x = Math.floor(((lng + 180) / 360) * 2 ** z)
      const r = (lat * Math.PI) / 180
      const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
      tiles = tpls.map((t) => t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)))
    }
    const z = 16
    const [lng, lat] = incidentView.center
    const x = Math.floor(((lng + 180) / 360) * 2 ** z)
    const r = (lat * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
    const covered = tilesForBounds(incidentBounds, 14, 17).slice(0, 1200)
    const centreIndex = covered.findIndex((tile) => tile.z === z && tile.x === x && tile.y === y)
    return {
      tiles,
      plan: Object.values(backendPlans)[0] ?? null,
      // Every vector and raster reference layer. Raster layers use one representative centre
      // tile; vector layers use the incident crop. These are exact URLs from the warm pass.
      references: [
        ...layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
        ...layers.filter((l) => !l.base && l.tiles?.length).map((l) => {
          const templates = l.tiles as string[]
          const template = templates[Math.max(0, centreIndex) % templates.length]
          return fillTileTemplate(template, z, x, y)
        }),
      ],
    }
  }, [layers, incidentView.center, incidentBounds, backendPlans, withGeoBbox])
  /** The roster as a PICKER sees it: the Mannschaft plus everybody recorded on this Einsatz who
   *  is not on it (lib/guests). A Gast used to be nameable exactly once — on the Anwesenheit that
   *  created them — and was then invisible to the Trupp form, the Fahrer field and the
   *  Einsatzleiter picker, so the Nachbarwehr driver who was standing right there could not be
   *  written down anywhere it mattered. */
  const pickablePersonnel = useMemo(() => rosterWithGuests(personnel, attendance), [personnel, attendance])
  /** ⚠️ …and every index below is built from THAT list, guests included. Offering a Gast in the
   *  dropdown while resolving names against the bare Mannschaftsliste is the worst of both: the
   *  picker let you choose the Nachbarwehr's Fahrer and then nothing recorded it, because the
   *  name resolved to no id — no Anwesenheits-Bemerkung, no lock, and their name never marked in
   *  the Verlauf. What a picker offers and what the app can resolve have to be one list. */
  const rosterById = useMemo(() => new Map(pickablePersonnel.map((p) => [p.id, p])), [pickablePersonnel])
  /** roster display name → person id. The symbol fields and the Erfassungsblatt pick from a list
   *  of NAMES (Combo, not PersonField), so this is what turns «Widmer Céline» back into somebody
   *  the Anwesenheit can be written for. A name that matches nobody — not even a Gast already on
   *  this Einsatz — resolves to undefined: that is mutual aid nobody has written down yet.
   *  ⚠️ Built by lib/personnel rather than inline, so it is the SAME index (and the same word-
   *  order tolerance) the Atemschutz board and `truppSlots` match against — an app that resolves
   *  «Hans Müller» on one screen and not on the next is worse than one that never resolves it. */
  const rosterIdByName = useMemo(() => rosterIdByNameOf(pickablePersonnel), [pickablePersonnel])
  // ⚠️ Read the Trupps through the roster first (lib/personnel · linkTrupps). Everything below
  // answers «who is already committed» from IDS, so a Trupp carrying only names was invisible to
  // all of it — the Fahrer picker said nothing about somebody under Atemschutz, their Anwesenheit
  // row did not lock, and «einer, ein Trupp» quietly stopped holding. The record is untouched.
  const linkedTrupps = useMemo(() => linkTrupps(trupps, rosterIdByName, rosterById), [trupps, rosterIdByName, rosterById])
  const blockedAttendanceIds = useMemo(() => assignedPersonIds(linkedTrupps), [linkedTrupps])
  const truppOfPerson = useMemo(() => truppByPersonId(linkedTrupps), [linkedTrupps])
  // ── the Anwesenheit is undoable, like the map ──────────────────────────────────────────────
  // ⚠️ Its own stack, driven by the SAME ↶ ↷ in the TopBar (see showHistory below). The list is
  // the fastest-tapped surface in the app — 60 names, gloves, a neighbouring row half a centimetre
  // away — and until now only three of its actions offered a way back (the confirm-with-undo
  // toasts in useAttendanceActions). Those stay: the toast catches the mistake you notice at once,
  // the stack the one you notice three names later. A toast undo is itself a write through `set`,
  // so ↶ after it re-applies the tap — «undo the last thing I did», consistently.
  // ⚠️ `canWriteRecord`, not `readOnly`: the Anwesenheit is not the Atemschutz-Link's slice.
  const attHist = useUndoableSlice(attendance, setAttendance, !canWriteRecord)
  attHistClear.current = attHist.clear
  /** Record an Anwesenheits-Schritt on the global timeline. The slice keeps its own stack and
   *  performs the step (delegation); this only says WHEN it happened relative to everything else.
   *  ⚠️ Through a ref, and declared up here: `attSet` is handed to `useAttendanceActions` during
   *  THIS render, while `stepAttendance` needs the roster that is built further down.
   *  ⚠️ The label is the surface, not the names. At push time the write has not landed, so who
   *  moved is not knowable yet — and the Verlauf row `stepAttendance` writes still names them,
   *  which is where a reader six months later actually looks. */
  const stepAttendanceRef = useRef<(dir: 'undo' | 'redo') => boolean>(() => false)
  const rememberAttendanceStep = () => undoHist.push({
    domain: 'anwesenheit',
    label: C_HIST.undoDomains.anwesenheit,
    undo: () => stepAttendanceRef.current('undo'),
    redo: () => stepAttendanceRef.current('redo'),
  })
  /** The one write path for the Anwesenheit: checkpoint on the slice, and record the step. */
  const attSet: typeof attHist.set = (update) => { const laid = attHist.set(update); rememberAttendanceStep(); return laid }
  /**
   * A Gebäude one-shot on the timeline. These own no stack at all — a storey added, a storey
   * removed, a building replaced — so the entry carries BOTH states itself, the way the
   * confirm-with-undo toast used to carry one of them.
   *
   * ⚠️ The toasts stay (they are the fast door for the mistake you notice at once) and each one
   * drops its entry when it is used, so an act is never undoable twice. The label is the toast's
   * own sentence, so the header says «Rückgängig: Geschoss gelöscht» and not «… Gebäude».
   */
  const rememberOneShot = (domain: UndoDomain, label: string, restore: () => void, reapply: () => void) => undoHist.push({
    domain,
    label,
    undo: () => { restore(); logHistStep('undo', label, ''); return true },
    redo: () => { reapply(); logHistStep('redo', label, ''); return true },
  })
  rememberOneShotRef.current = rememberOneShot
  // the Abschluss's «nicht eingesetzt» door (standDownTrupps above) — read only when the question
  // is answered, long after this commit, so an effect is the place to point it
  useEffect(() => { standDownRef.current = (ids) => { for (const id of ids) setTruppStatus(id, 'raus') } })
  const rememberGebaeudeStep = (label: string, restore: () => void, reapply: () => void) =>
    rememberOneShot('gebaeude', label, restore, reapply)

  /* ── «Spur»: der abgesuchte Bereich überlebt seinen Marker (18.09.2026) ─────────────────────
   *
   * Removing a Trupp marker used to remove the searched area with it, which is why both surfaces
   * REFUSED to remove a marker carrying a trail. The trail is now owned by the incident
   * (lib/truppTrails): a marker that disappears leaves a read-only grey ghost behind, and one
   * that comes back takes its own trail home again.
   *
   * ⚠️ Driven as a RECONCILIATION rather than as a write on each removal path, and that is what
   * makes the undo ONE step. Four doors take a marker off a picture — the chip's trash, the map
   * marker's trash, either group delete, and `deleteTrupp` · `dropPlacements` — each with its own
   * history; a ghost written by each of them would be a second timeline entry, and «Rückgängig»
   * would hand the marker back with its ghost still standing beside it. Here nothing is pushed:
   * the removal's own step is the whole act, in both directions.
   *
   * ⚠️ `prevSources` is NULLED by a remote hydrate (applyWorkspace replaces the whole store), or
   * the merge would read every marker as removed at once and ghost the lot.
   */
  const truppNoOf = (id: string | undefined) => (id ? allTrupps.find((t) => t.id === id)?.no : undefined)
  const planIsStack = (id: string) => !!planDocs.find((p) => p.id === id)?.floorStack
  const trailSourcesNow = useMemo(
    () => trailSources(objects, planIsStack, truppNoOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, planDocs, allTrupps],
  )
  /* The pass itself, plus «Marker und Spur löschen»'s arming, are ONE mechanism and live in one
   * hook (lib/useGhostTrails): the surface arms `armTrailDrop(id, true)` in the same breath as
   * the removal, and the very next pass writes that marker's ghost already `removedAt`-stamped
   * instead of standing the searched area back up. `reseedGhostTrails` is the hydrate's door. */
  const { armTrailDrop, reseed: reseedGhostTrails } = useGhostTrails({ sources: trailSourcesNow, setTrails })
  ghostReseedRef.current = reseedGhostTrails
  /**
   * «Marker und Spur löschen» on the Karte's Trupp marker — the third row of its trash menu
   * (components/TwinTeamPill), the twin of the plan chip's (Whiteboard · removeWithTrail).
   * The reconciliation is armed FIRST, so the ghost this removal would otherwise stand up is
   * written already `removedAt`-stamped (lib/truppTrails) and the searched area goes with the
   * marker. One undo step: only the marker's own removal was ever committed, and taking it back
   * brings the marker home with its trail — the stamped row is dropped by the next pass, because
   * its marker is live again.
   */
  const removeTeamWithTrail = async (id: string) => {
    if (tacticalLocked) return
    const e = entities.find((x) => x.id === id)
    if (!e || e.kind !== 'team' || !e.trail?.length) return
    // a trail is never destroyed without the ask, wherever the door is (Plan parity)
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.removeMarkerTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: e.label ?? '', n: e.trail.length }),
      confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    armTrailDrop(id, true)
    // the connection question inside deleteEntity may still be answered with «Abbrechen» — then
    // the marker stays and the arming has to go, or its next removal would eat the trail
    if (!await deleteEntity(id)) { armTrailDrop(id, false); return }
    // the Verlauf says BOTH things happened; no `entity.edit` beside it, because the entity the
    // edit would describe is the one just deleted (the `entity.delete` row carries the act)
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: e.label ?? '' }))
  }
  /**
   * A tap on a ghost trail. «Spur löschen» with the same confirm the live trail has, undoable as
   * one step – and, where the Trupp behind it still exists, the way BACK first (20.09.2026): the
   * marker returns where the trail ends, under the id it was recorded on, and the reconciliation
   * takes the ghost home with it (lib/truppTrails · ghostRevival). One ask, three answers; the
   * delete stays the red one and keeps its own wording.
   */
  const deleteGhostTrail = async (id: string) => {
    if (tacticalLocked) return
    const g = trails.find((t) => t.id === id)
    if (!g || g.removedAt) return
    const name = ghostTrailLabel(g, appConfig.copy.whiteboard.team)
    const message = fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name, n: trailPointCount(g) })
    // ⚠️ offered for EVERY ghost that has somewhere to return to, not only one with a live Trupp
    // behind it (first cut, 20.09.2026 – and the field's first try was a loose «Trupp 1» chip,
    // which got the delete-only ask again). A marker joined to a Trupp that still exists goes
    // back through the Trupp's own placement; anything else – a loose chip, or one whose Trupp
    // has since been removed – returns as the loose marker it then is, under the same id.
    const back = ghostRevival(g)
    const liveTruppId = g.truppId && trupps.some((t) => t.id === g.truppId && !t.removedAt) ? g.truppId : undefined
    if (back) {
      const answer = await confirmDialog({
        title: fillTemplate(appConfig.copy.whiteboard.ghostTrailTitle, { name }),
        message: appConfig.copy.whiteboard.ghostTrailAsk,
        confirmLabel: appConfig.copy.whiteboard.ghostTrailRestore, cancelLabel: appConfig.copy.cancel,
        altLabel: appConfig.copy.whiteboard.clearTrail, altDanger: true,
      })
      if (answer === true) {
        const revive = { id: back.markerId, trail: back.trail }
        // (the Trupp's own placement writes its «platziert» row; the loose marker gets this one)
        if (!liveTruppId) log('flag', fillTemplate(appConfig.copy.whiteboard.ghostTrailRestored, { name }))
        if (liveTruppId) {
          if (back.surface === 'plan') placeTruppOnPlan(liveTruppId, back.planId, back.at, { id: back.markerId, trail: back.trail })
          else placeTruppOnMap(liveTruppId, back.coord, { id: back.markerId, trail: back.trail })
        } else if (back.surface === 'plan') {
          const chip: BoardAnno = { id: revive.id, kind: 'resource', ...back.at, text: g.name || name, t: formatTime(new Date()), color: g.color, trail: back.trail }
          setBoard((b) => ({ ...b, [back.planId]: [...(b[back.planId] ?? []).filter((a) => a.id !== chip.id), chip] }))
        } else {
          const marker: Entity = { id: revive.id, kind: 'team', layer: appConfig.defaults.operationalLayerId, coord: back.coord, label: g.name || name, t: formatTime(new Date()), color: g.color, trail: back.trail }
          setDocRaw((d) => ({ ...d, entities: [...d.entities.filter((e) => e.id !== marker.id), marker] }))
        }
        return
      }
      if (answer !== 'alt') return
    } else {
      const ok = await confirmDialog({
        title: appConfig.copy.whiteboard.clearTrail, message,
        confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
      })
      if (!ok) return
    }
    const at = serverNowIso()
    setTrails((ts) => removeGhostTrail(ts, id, at))
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name }))
    // the domain is where the trail was WALKED — a ghost on a sheet is the Plan's act, so the
    // header's «Rückgängig: …» names the surface the operator is standing on
    rememberOneShot(g.planId ? 'plan' : 'karte', appConfig.copy.whiteboard.clearTrail,
      () => setTrails((ts) => restoreGhostTrail(ts, id)),
      () => setTrails((ts) => removeGhostTrail(ts, id, at)))
  }
  // …and what each person's Bemerkung said, for as long as this incident is open here. The record
  // loses it when a row is cycled to «frei» (the entry goes, as it must); this is what puts it back
  // when the same person is ticked present again — see useAttendanceActions · noteMemory. Per
  // incident by construction: this component remounts with the incident.
  const attNotes = useRef<Record<string, string>>({})
  const { markPresent, markLeft, clearAttendance, setAttendanceTimes, removeAttendanceBlock, setAttendanceNote, setAttendanceOrt, addGuest } = useAttendanceActions({
    attendance, setAttendance: attSet, blockedAttendanceIds, noteMemory: attNotes,
    startedAt: incidentMeta.started_at, reportDoneAt: incidentMeta.report_done_at, log,
  })
  /** Step the Anwesenheit back or forward and SAY SO in the Verlauf. The record is append-only, so
   *  the tap's own row stands; this adds the correction beside it, naming whoever moved — which is
   *  the only thing a reader six months later needs from it. */
  /**
   * Settle one Anwesenheits-Abweichung from the Rapport: put the chosen value into the record
   * and append the row that says so. ONE action, because the halves must not drift apart — a
   * record change with no line, or a line about a change that never landed, are both a worse
   * record than the «bitte prüfen» warning they replace.
   *
   * ⚠️ The warning row STAYS. The Verlauf is append-only: this adds the answer beside the
   * question, it does not go back and tidy the question away. A record that could be edited to
   * say a check happened would be no proof that one did, which is the whole 1.6 finding.
   * ⚠️ «Beide stimmen so» writes NOTHING to the record — the merge already stands, and the point
   * of that answer is that it was correct. Only the row is appended.
   */
  const resolveAttendanceConflict = (open: OpenConflict, choice: 0 | 1 | 'both') => {
    if (choice !== 'both') {
      const picked = open.sides[choice]?.entry
      // …through the history-aware setter, so ↶ takes it back like every other Anwesenheit tap
      if (picked && open.key) attSet((cur) => ({ ...cur, [open.key]: picked }))
    }
    journal.append(conflictResolvedRow(open, choice, user?.display_name))
    emit('attendance.conflict.resolved', { key: open.key, sig: open.sig })
  }
  const stepAttendance = (dir: 'undo' | 'redo'): boolean => {
    const moved = dir === 'undo' ? attHist.undo() : attHist.redo()
    if (!moved) return false
    const names = changedAttendanceNames(moved.from, moved.to, rosterById)
    const A = appConfig.copy.anwesenheit
    // ⚠️ icon 'people', not 'undo'. The Bereich column and the Verlauf chip are derived from the
    // icon (lib/report · journalArea) and 'undo' is the Atemschutz-Rückzug's icon — so every
    // «Anwesenheit zurückgenommen» printed under «Atemschutz», on a sheet whose whole job is
    // saying where a row came from. The undo-ness is in the sentence; the icon says the surface.
    log('people', fillTemplate(dir === 'undo' ? A.undone : A.redone, { names: names.join(', ') || '–' }), 'team')
    // ⚠️ `attendance.undo`, NOT a bare `undo` (fixed 08.09.2026). An `el` session may write the
    // Anwesenheit but may append only the RECORD event vocabulary (backend · EL_EVENT_PREFIXES),
    // and ONE refused op_type 403s the whole batch — so the first ↶ an Einsatzleiter pressed
    // wedged their entire audit outbox. `attendance.` is already on that allowlist.
    emit(`attendance.${dir}`)
    return true
  }
  stepAttendanceRef.current = stepAttendance
  /**
   * Mittel and Checklisten join the timeline the same way the Anwesenheit does: their slice gets
   * an undo stack (`useUndoableSlice`), every write goes through it, and the entry delegates.
   *
   * ⚠️ Whole-slice snapshots, not reverse patches — the same reason the Anwesenheit takes them.
   * A Mittel save is append-only with tombstones and a Checklisten-Haken carries who ticked it
   * and when, so «put the list back as it stood» is a statement the record can make; «un-tick
   * item 4» is not, once a merge has been through it.
   * ⚠️ `canEditRecord`, like the Anwesenheit: both are record surfaces an `el` may write.
   */
  const mittelHist = useUndoableSlice(mittel, setMittel, !canWriteRecord)
  const checklistHist = useUndoableSlice(checklists, setChecklists, !canWriteRecord)
  /** One recorded step over a slice somebody else owns. `op` is the domain-scoped audit prefix —
   *  see `logHistStep` for why a bare `undo` would wedge an `el` session's outbox. */
  /*  `describe` lets the domain write the step's rows itself — the Checklisten write «☑ …» /
   *  «Meilenstein zurückgenommen: …» for a milestone, the same row a tap writes — and a `true`
   *  from it replaces the generic «… rückgängig gemacht», so one step is never two rows. */
  /*  ⚠️ The slice's history travels as a REF, read when the step is taken (lib/sliceUndoStep). */
  const rememberSliceStep = <T,>(domain: UndoDomain, histRef: { readonly current: UndoableSlice<T> }, label: string, op: string, icon: string, onStep?: () => void, describe?: (moved: { from: T; to: T }) => boolean) =>
    pushSliceStep(undoHist, {
      domain, label, histRef, onStep,
      record: (moved, dir) => {
        if (moved && describe?.(moved)) { histSide.current.emit(`${op}${dir}`); return true }
        return histStep(!!moved, dir, label, op, icon, 'journal')
      },
    })
  const mittelSet: typeof mittelHist.set = (u) => { const laid = mittelHist.set(u); rememberSliceStep('mittel', mittelHistRef, C_HIST.undoDomains.mittel, 'mittel.', 'box'); return laid }
  const checklistSet: typeof checklistHist.set = (u) => { const laid = checklistHist.set(u); rememberSliceStep('checkliste', checklistHistRef, C_HIST.undoDomains.checkliste, 'checklist.', 'check', undefined, (moved) => checklistDescribeRef.current(moved)); return laid }
  // ⚠️ The entry outlives the render that pushed it, and `hist` closes over that render's stacks.
  const mittelHistRef = useRef(mittelHist); mittelHistRef.current = mittelHist
  const checklistHistRef = useRef(checklistHist); checklistHistRef.current = checklistHist
  /** the milestone rows of a Checklisten step (useChecklistActions · describeStep), set below */
  const checklistDescribeRef = useRef<(moved: { from: ChecklistState; to: ChecklistState }) => boolean>(() => false)
  /**
   * …and the Einsatzrapport, the last record surface with no way back (field report 18.09.2026:
   * «Rettungen eingetragen, Zahl war falsch, Rückgängig macht nichts»). Same slice mechanism as
   * Mittel and the Checklisten — but the Rapport is the only surface that persists on every
   * KEYSTROKE, so a checkpoint per write would have filled the whole history with one
   * Kurzbericht and made ↶ hand back a single character. `lib/reportUndo` classifies the write
   * instead: a burst of typing in the same field is ONE step, and a value or a row appearing or
   * disappearing (a Rettung, «Keine», a Partnerorganisation, a cleared Gruppenzeit) is its own.
   *
   * ⚠️ Deliberately NOT a separate pair of buttons on the sheet: the Rapport wears the same
   * TopBar as every other surface, and its ↶ ↷ already drive this one timeline (08.09.2026).
   */
  // ⚠️ the machine's own bookkeeping rides OUTSIDE the snapshots (lib/reportUndo ·
  // keepMachineFields): it lays no step of its own, so it travels inside whatever step stands —
  // and a ↶ that handed back an outstanding `printJob` would leave `settlePrintJob` nothing to
  // stamp, i.e. lose the «in der Warteschlange» / «Rapport erstellt» marks to an undone sentence.
  const reportHist = useUndoableSlice(reportMeta, setReportMeta, !canWriteRecord, keepMachineFields)
  const reportHistRef = useRef(reportHist); reportHistRef.current = reportHist
  const reportSet: typeof reportHist.set = (u) => {
    // ⚠️ A session that may not write the record still writes LOCALLY exactly as it did before
    // this stack existed — it simply lays no step down. Dropping the write here instead would
    // have made undo a silent gate on a path that never had one.
    if (!canWriteRecord) { setReportMeta(u); return false }
    const hist = reportHistRef.current
    const laid = hist.set(u, {
      coalesce: (prev, next) => {
        const step = reportStepOf(prev, next)
        // the app's own bookkeeping (reportMadeAt / printJob / krokiPrint) — it rides along with
        // whatever step stands and never becomes one of its own
        if (!step) { lastReportStep.current = null; return true }
        const now = Date.now()
        const fold = foldsIntoPrevious(lastReportStep.current, step, now)
        lastReportStep.current = { key: step.key, at: now }
        return fold
      },
    })
    // ⚠️ …and the fold window closes on every ↶ ↷ (the last argument): the step it would fold
    // into has just moved to the other stack, so typing in the same field right after an undo
    // would lay no step of its own — and the next ↷ would overwrite it.
    if (laid) rememberSliceStep('rapport', reportHistRef, C_HIST.undoDomains.rapport, 'report.', 'clipboard', () => { lastReportStep.current = null })
    return laid
  }
  reportSetRef.current = reportSet
  /**
   * The Suche (24.09.2026, lib/suche) joins the timeline like Mittel: one slice, whole-slice
   * snapshots, a delegating entry per act. ⚠️ EDITOR only in step 1 (`canEditIncident`): the `el`
   * reads, a link session reads — the backend's record slice does not carry `suche`, and an
   * Atemschutz-Link writes exactly three routes (AGENTS.md · role gating).
   * The step's rows are the records' own log rows, so ↶ says «Zurückgenommen: Gefunden: …» in
   * the words the act wrote and ↷ writes them again (`movedRows`) — the Checklisten pattern.
   * ⚠️ `keepSeeds`: the storeys the machine seeded after a checkpoint are no step of anybody's,
   * so a ↶ keeps them (they would only come back on the next open, as the same derived ids).
   */
  const canEditSuche = canEditIncident
  const sucheFloorName = useCallback((f: number) => building?.floorNames?.[String(f)] ?? floorLabel(f), [building])
  const sucheHist = useUndoableSlice(suche, setSuche, !canEditSuche, keepSucheSeeds)
  const sucheHistRef = useRef(sucheHist)
  useLayoutEffect(() => { sucheHistRef.current = sucheHist })
  const sucheDescribe = (moved: { from: SucheDoc; to: SucheDoc }): boolean => {
    const back = movedRows(moved.from, moved.to)
    const again = movedRows(moved.to, moved.from)
    for (const r of back) log('undo', fillTemplate(appConfig.copy.suche.rowUndone, { text: r.text }), 'history', undefined, undefined, { suche: rowOwner(moved.from, r.id) })
    for (const r of again) log('search', r.text, undefined, undefined, undefined, { suche: rowOwner(moved.to, r.id) })
    return back.length + again.length > 0
  }
  const sucheActions = useSucheActions({
    suche,
    set: (next) => { if (sucheHist.set(next)) rememberSliceStep('suche', sucheHistRef, C_HIST.undoDomains.suche, 'suche.', 'search', undefined, sucheDescribe) },
    setRaw: setSuche,
    canEdit: canEditSuche,
    log,
    emit,
    floorName: sucheFloorName,
  })
  useLayoutEffect(() => { sucheActionsRef.current = sucheActions })
  /* ── where the Suche is open (E5): a DOCK beside the Gebäude or the Karte on a tablet, a sheet
   *    over them on a phone. Device state — which list somebody is looking at is not the record. */
  const [sucheOpen, setSucheOpen] = useState(false)
  const [sucheTab, setSucheTab] = useState<SucheTab>('personen')
  const [sucheFocus, setSucheFocus] = useState<{ personId?: string; bereichId?: string; fund?: FundPreset; nonce: number } | null>(null)
  const [sucheDetent, setSucheDetent] = useState<Detent>('half')
  /** replay shows the search as it stood (lib/suche · sucheAt folds the anchor's slice) */
  const effSuche = useMemo<SucheDoc>(
    () => (replayActive ? sanitizeSuche(replayWs?.suche) ?? emptySuche() : suche),
    [replayActive, replayWs, suche],
  )
  const stackPlanId = planDocs.find((d) => d.floorStack)?.id
  const sucheFloors = useMemo(() => (stackPlanId ? building?.floors ?? [] : []), [stackPlanId, building])
  const sucheHasGebaeude = sucheFloors.length > 0
  const sucheMissing = vermisstCount(effSuche)
  /** the Trupps as the Suche names them: «Trupp 3» on paper, «T3 Muster» on a chip */
  const sucheTrupps = useMemo<TruppHere[]>(() => trupps.map((t) => {
    const S = appConfig.copy.suche
    return typeof t.no === 'number'
      ? { id: t.id, label: fillTemplate(S.truppLabel, { n: t.no }), short: fillTemplate(S.truppChip, { n: t.no, name: t.name ?? '' }).trim() }
      : { id: t.id, label: t.name, short: t.name }
  }), [trupps])
  /** which storey each Trupp's chip stands on in the Gebäude — «Gefunden…» pre-selects from it */
  const sucheTruppFloors = useMemo(() => (stackPlanId ? (board[stackPlanId] ?? []) : [])
    .filter((a) => a.kind === 'resource' && !!a.truppId)
    .map((a) => ({ truppId: a.truppId!, floor: a.floor ?? 0 })), [board, stackPlanId])
  const sucheGroupsNow = useMemo(() => sucheGroups(effSuche, sucheFloors, sucheFloorName), [effSuche, sucheFloors, sucheFloorName])
  const sucheBadges = useMemo(() => (sucheOpen || effSuche.personen.length || effSuche.bereiche.some((b) => b.log.length) ? storeyBadges(sucheGroupsNow) : undefined), [sucheOpen, effSuche, sucheGroupsNow])
  /**
   * Open the Suche. From the Karte or a plan it docks on the surface you are on (the tool rail's
   * toggle); from anywhere else — the rail door, the head chip, a Verlauf row — it opens beside
   * the Gebäude, or beside the Karte when there is none (E5 «Wo man hinkommt»). Opening is also
   * the moment every storey becomes its «ganzes Geschoss» (E6 «von selbst»).
   */
  const openSuche = (opts?: { tab?: SucheTab; personId?: string; bereichId?: string; fund?: FundPreset; stay?: boolean }) => {
    setSucheOpen(true)
    if (opts?.tab) setSucheTab(opts.tab)
    if (opts?.personId || opts?.bereichId || opts?.fund) setSucheFocus((f) => ({ personId: opts.personId, bereichId: opts.bereichId, fund: opts.fund, nonce: (f?.nonce ?? 0) + 1 }))
    if (isPhone) setSucheDetent('half')
    const onSurface = mode === 'map' || mode === 'plans'
    if (!(opts?.stay && onSurface)) sucheSurface(sucheHasGebaeude ? 'gebaeude' : 'karte')
    sucheActions.seed(sucheFloors)
  }
  useLayoutEffect(() => { openSucheRef.current = () => openSuche({ tab: 'personen' }) })
  /** the surface under the Suche — the phone sheet's Gebäude | Karte switch and every door */
  const sucheSurface = (to: 'gebaeude' | 'karte') => {
    if (to === 'gebaeude' && stackPlanId) {
      if (mode === 'plans' && activePlanId === stackPlanId) return
      if (mode !== 'plans') clearMapUi()
      setMode('plans'); setActivePlanId(stackPlanId)
    } else if (to === 'karte' && mode !== 'map') setMode('map')
  }
  /** a row or a storey chip was tapped: the stack scrolls there (markers are step 2) */
  const sucheToFloor = (floor: number) => {
    if (!stackPlanId || mode !== 'plans' || activePlanId !== stackPlanId) return
    setPlanFocus({ x: 0.5, y: 0.5, floor, nonce: Date.now() })
  }
  const sucheSurfaceOn = sucheOpen && (mode === 'map' || mode === 'plans')
  const suchePanelProps = {
    doc: effSuche, floors: sucheFloors, floorName: sucheFloorName, trupps: sucheTrupps, placed: sucheTruppFloors,
    canEdit: canEditSuche, actions: sucheActions, tab: sucheTab, onTab: setSucheTab, focus: sucheFocus,
    onFloor: sucheToFloor, uebergabe: sucheUebergabe(),
  }
  /* ── the Trupps' half (Tür 3, E6 «Aus dem Trupp») — lib/useSucheTrupps owns it: the storeys on
   *    the first «Absuchen», a Ziel's area «in Arbeit · Trupp 4», and «abgesucht?» at Raus ── */
  useSucheTrupps({
    trupps, suche, canEdit: canEditSuche && !replayActive, actions: sucheActions, floors: sucheFloors,
    floorName: sucheFloorName, placed: sucheTruppFloors, truppsHere: sucheTrupps, remoteRef: sucheRemoteRef,
  })
  /** «Fund melden» (storey + Trupp pre-filled) and «Bereich abgesucht» on a Trupp's ⋯ menu */
  const sucheTruppItems = (t: Trupp) => {
    // a Trupp that has not gone in yet has found nothing and searched nothing
    if (t.status === 'angemeldet') return []
    const S = appConfig.copy.suche
    const floor = sucheTruppFloors.find((p) => p.truppId === t.id)?.floor
    const mine = suche.bereiche.filter((b) => { const st = bereichStatusOf(b); return st.status === 'inArbeit' && st.truppId === t.id })
    const label = sucheTrupps.find((x) => x.id === t.id)?.label ?? t.name
    return [
      { label: S.fundMelden, onClick: () => openSuche({ tab: 'personen', fund: { truppId: t.id, floor } }) },
      {
        label: S.bereichAbgesucht,
        // the one area it searches is marked straight away (↶ takes it back); otherwise the
        // Bereiche open on its storey, to say which
        onClick: () => (mine.length === 1 ? void sucheActions.setStatus(mine[0].id, 'abgesucht', { label, id: t.id })
          : openSuche({ tab: 'bereiche', bereichId: mine[0]?.id ?? (floor != null ? `sbg${floor}` : undefined) })),
      },
    ]
  }
  /** every area by its full label, for the Trupp form's Ziel chips */
  const sucheZielChoices = useMemo(() => sucheGroupsNow.flatMap((g) => g.units.map((u) => u.full)).filter(Boolean), [sucheGroupsNow])
  /** the tool rail's toggle — tablet only (the phone's five tiles have no room; its door is the
   *  «Einsatz» chooser and the head chip) */
  const sucheRailButton = !isPhone ? (
    <button className={`vrail-tool${sucheSurfaceOn ? ' on' : ''}`} aria-pressed={sucheSurfaceOn}
      title={sucheSurfaceOn ? appConfig.copy.suche.toolClose : appConfig.copy.suche.toolOpen}
      aria-label={sucheSurfaceOn ? appConfig.copy.suche.toolClose : appConfig.copy.suche.toolOpen}
      onClick={() => (sucheSurfaceOn ? setSucheOpen(false) : openSuche({ stay: true }))}>
      <span className="vrail-glyph"><Icon id="search" />{sucheMissing > 0 && <span className="nav-live nav-count nav-vermisst" aria-hidden>{sucheMissing > 99 ? '99+' : sucheMissing}</span>}</span>
      <span className="vrail-label">{appConfig.copy.suche.rail}</span>
    </button>
  ) : null
  const { saveMittel } = useMittelActions({ mittel, setMittel: mittelSet, authorName: user?.display_name, log })
  // Symbol→Mittel moved OUT of the symbol's card (28.08.): the Material surface itself now shows
  // the «Gesetzt, aber nicht erfasst» strip, fed with every symbol standing on Lage + all plans.
  // The «has this station mapped anything» gate lives inside mittelRecommendations.
  // ⚠️ Deduped by id: since unified objects `entities` and `board` are two VIEWS of the same
  // records (lib/tacticalObjects · viewsOf), so this union repeats one object once per fitting
  // plan — and a repeated view is not a second symbol standing in the Einsatz.
  const placedSymbols = useMemo(
    () => [...new Map(
      [...doc.entities, ...Object.values(board).flat()]
        .filter((x) => !!x.symbol && !(x as { live?: boolean }).live)
        .map((x) => [x.id, { symbol: x.symbol as string, fields: x.fields, extract: x.extract }] as const),
    ).values()],
    [doc.entities, board],
  )
  /**
   * The Zeitplan joins the timeline as ONE slice, because a Schichtband and the Schichten in it
   * are not two things to an operator: removing a band strips `bandId` off its shifts in the
   * same breath, and two entries for that act would need two ↶ to take back half of what looked
   * like one press. `shifts` + `bands` are therefore snapshotted together.
   *
   * ⚠️ …which is also why one GESTURE is one step: the writers here legitimately touch both
   * lists in the same synchronous handler, so the first write of a burst lays the checkpoint and
   * whatever follows it in the same task folds in. A microtask closes the burst, so nothing is
   * held open across an await (the band-times question asks first and is its own decision).
   *
   * Before this, `addShift`, `setShiftTime`, `addBand`, `renameBand`, `setBandTimes` and every
   * cell tap had no way back at all — the surface's only doors were the four confirm-with-undo
   * toasts, and a toast expires.
   */
  const zeitplanDoc = useMemo(() => ({ shifts, bands }), [shifts, bands])
  const zeitplanHist = useUndoableSlice(zeitplanDoc, (v) => {
    const next = typeof v === 'function' ? v(zeitplanDoc) : v
    setShifts(next.shifts); setBands(next.bands)
  }, !canWriteRecord)
  const zeitplanHistRef = useRef(zeitplanHist); zeitplanHistRef.current = zeitplanHist
  const zeitplanBurst = useRef(false)
  const zeitplanWrite = (next: (cur: { shifts: Shift[]; bands: ShiftBand[] }) => { shifts: Shift[]; bands: ShiftBand[] }) => {
    const fold = zeitplanBurst.current
    const laid = zeitplanHistRef.current.set(next, { coalesce: () => fold })
    if (!zeitplanBurst.current) {
      zeitplanBurst.current = true
      queueMicrotask(() => { zeitplanBurst.current = false })
    }
    // `shift.` is on the `el` audit allowlist (backend · EL_EVENT_PREFIXES): an Einsatzleiter
    // plans shifts, so their ↶ must not 403 the batch — see logHistStep.
    if (laid) rememberSliceStep('zeitplan', zeitplanHistRef, C_HIST.undoDomains.zeitplan, 'shift.', 'clock')
  }
  const setShiftsUndoable: Dispatch<SetStateAction<Shift[]>> = (u) =>
    zeitplanWrite((cur) => ({ ...cur, shifts: typeof u === 'function' ? u(cur.shifts) : u }))
  const setBandsUndoable: Dispatch<SetStateAction<ShiftBand[]>> = (u) =>
    zeitplanWrite((cur) => ({ ...cur, bands: typeof u === 'function' ? u(cur.bands) : u }))
  // Schichtenplanung — a PLAN over the same Mannschaft; it never writes the attendance record
  const { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift } = useShiftActions({ shifts, setShifts: setShiftsUndoable, startedAt: incidentMeta.started_at })
  // …and the Schichten reading of it: the same shifts, grouped into named windows. Creating a band
  // writes no shift, deleting one deletes no shift — see useBandActions.
  const bandActions = useBandActions({ bands, setBands: setBandsUndoable, shifts, setShifts: setShiftsUndoable })
  // The Zeitplan-Führungsformular on paper. The relay status is fetched once per incident and
  // fail-closed (null → no printer button at all); the PDF download needs no relay.
  const [zeitplanRelay, setZeitplanRelay] = useState<PrintRelayStatus | null>(null)
  useEffect(() => {
    if (linkScoped) return // the relay is refused for a link session — don't even ask
    let alive = true
    void fetchPrintStatus(editorPrintTransport()).then((st) => { if (alive) setZeitplanRelay(st) })
    return () => { alive = false }
  }, [linkScoped])
  const zeitplanPayload = (rowPeople: Person[], sheet: ZeitplanSheet) => buildZeitplanPayload(
    rowPeople, attendance, shifts,
    { title: incidentMeta.title, address: incidentMeta.address, startedAt: incidentMeta.started_at },
    new Date().toISOString(),
    sheet, bands,
  )
  const onDownloadZeitplan = (rowPeople: Person[], sheet: ZeitplanSheet) => {
    void downloadZeitplanPdf(incidentMeta.id, zeitplanPayload(rowPeople, sheet))
      .catch(() => toast(appConfig.copy.zeitplan.printFailed, { icon: 'warn', tone: 'warn' }))
  }
  // No confirmDialog here any more: the sheet picked from the printer menu IS the confirmation.
  // It names the sheet, how many people are on it and as of when, and offers PDF and printer side
  // by side — so paper still never starts moving on one stray thumb, and choosing WHICH sheet did
  // not cost four menu entries and a second dialog on top of them.
  const onPrintZeitplan = (rowPeople: Person[], sheet: ZeitplanSheet) => {
    void printZeitplan(incidentMeta.id, zeitplanPayload(rowPeople, sheet))
      .then((jobId) => trackPrintJob(editorPrintTransport(), jobId))
      .catch(() => toast(appConfig.copy.zeitplan.printFailed, { icon: 'warn', tone: 'warn' }))
  }
  // assigning someone to a Trupp implies they're on scene — mark every roster-linked member
  // present (even at "angemeldet"). Only the newly-present are logged, so re-edits don't spam.
  /** The linkable vocabulary of this Einsatz — Mannschaft, Mittel, Partnerorganisationen,
   *  Fahrzeuge, Alarmgruppen (lib/journalLinks). ONE memo, shared by the composer and the
   *  Verlauf, so the two can never mark different things. */
  // ⚠️ The PICKABLE roster, guests included — so a Gast's name is marked in the Verlauf like
  // anybody else's. A name the composer offers but the Verlauf then refuses to mark reads as
  // the app not recognising somebody it just autocompleted.
  // …and which Trupp somebody is in right now, so the composer's chip can say «Meier Anna · Trupp 2»
  // while you type. Names only, never inserted: it answers «which of them do I mean» at that moment
  // (see journalLinks · JournalLink.hint).
  const truppNameOfPerson = useMemo(() => {
    // the NUMBER where there is one («Meier Anna · Trupp 2»), the leader's name on a record that
    // predates numbers — journalVocabulary puts the word in front either way
    const byId = new Map(linkedTrupps.map((t) => [t.id, typeof t.no === 'number' ? String(t.no) : t.name]))
    return new Map([...truppOfPerson].map(([personId, truppId]) => [personId, byId.get(truppId) ?? '']))
  }, [truppOfPerson, linkedTrupps])
  // ⚠️ …and the TRUPPS themselves, as «Trupp Meier Anna» (journalLinks · journalVocabulary). Off
  // `allTrupps`, the unfiltered slice: a Trupp that has come out or been taken off the board is
  // still named in the rows written while it was working, and those must keep their marking.
  const journalVocab = useMemo(
    () => journalVocabulary(pickablePersonnel, attendance, truppNameOfPerson, allTrupps),
    [pickablePersonnel, attendance, truppNameOfPerson, allTrupps],
  )
  // active-member names feeding the symbol detail comboboxes (Einsatzleiter / Offizier / Fahrer)
  // ⚠️ Built from the PICKABLE roster, guests included. These names fill the dropdowns on a
  // symbol («Fahrer», «Name» on the Einsatzleiter glyph), and a Nachbarwehr driver recorded
  // on the Anwesenheit could not be selected on the vehicle they were actually driving.
  const rosterNames = useMemo(() => pickablePersonnel.filter((p) => p.active).map((p) => p.displayName), [pickablePersonnel])
  // name → rank key, for the officer-first sort + "nur Offiziere" filter on leadership symbols.
  // Guests included: they carry no Dienstgrad, and an entry MISSING from this map is what tells
  // the picker to sort them by name alone — which is the right answer for a Nachbarwehr.
  const rosterRank = useMemo(
    () => Object.fromEntries(pickablePersonnel.filter((p) => p.active).map((p) => [p.displayName, p.rank])),
    [pickablePersonnel],
  )
  // present crew (attendance) — offered first in the Einsatzleiter picker (mirrors Atemschutz)
  const presentIds = useMemo(() => new Set(Object.entries(attendance).filter(([, a]) => isPresent(a)).map(([id]) => id)), [attendance])

  /**
   * PHONE: which of the Rapport's THREE pages the «Rapport» tile opens, remembered per Einsatz
   * and per device (lib/rapportPages). The three are ordinary separate surfaces — they were tried
   * as tabs of the Rapport on 18.09.2026 and thrown out the same day, because a whole surface
   * mounted under the Rapport's own tab strip stacked three navigations on one screen. What the
   * fold actually buys is a bar of five tiles whose fifth one is a DOOR to the group, plus the
   * switcher at the foot of all three pages.
   */
  useEffect(() => {
    if (phoneFold && isRapportPage(mode)) writeRapportPage(incidentMeta.id, mode)
  }, [phoneFold, mode, incidentMeta.id])
  /** where the bar's «Rapport» tile goes: back to the page this device left the group on, else
   *  the first-open rule (nobody present yet → Anwesenheit, else the Rapport itself). */
  const rapportTarget = useMemo(
    // ⚠️ INSIDE the group the target is the page already showing: the memory is written by the
    // effect above, i.e. AFTER this render, so reading it here named the page just left and the
    // lit tile bounced between the last two pages. The memory only answers a tap from outside.
    () => (isRapportPage(mode) ? mode : initialRapportPage({ incidentId: incidentMeta.id, presentCount: presentIds.size })),
    [incidentMeta.id, presentIds.size, mode],
  )

  /** What is already known about a roster NAME — «unter AS», «Magazin», «gegangen». Shown on
   *  the dropdown entry itself (see roleAssignment · personStatusHint). */
  const personStatus = (name: string) => {
    const id = personIdForName(rosterIdByName, name)
    const hint = personStatusHint(id, attendance, linkedTrupps)
    // …and whether they are one of ours at all. A Gast is offered in these dropdowns like anybody
    // else (lib/guests), so the list has to SAY so — the same word the Anwesenheit badges them
    // with. Leads whatever else is known: «Gast» changes who you think you are picking.
    if (!(id && rosterById.get(id)?.guest)) return hint
    const gast = appConfig.copy.anwesenheit.guestBadge
    return { label: hint ? `${gast} · ${hint.label}` : gast, tone: hint?.tone ?? 'info' as const }
  }
  /** …and the contradiction a FILLED roster field already carries, per field key. ⚠️ This used
   *  to be a toast fired once at assignment time: it appeared after the pick and then went away,
   *  so the field it was about never said anything. */
  const rosterFieldHints = (e: Entity | undefined): Record<string, string | undefined> | undefined => {
    if (!e || e.kind !== 'symbol') return undefined
    const out: Record<string, string | undefined> = {}
    for (const [key, val] of Object.entries(e.fields ?? {})) {
      const name = (val ?? '').trim()
      if (!name || !ROSTER_FIELDS.includes(key)) continue
      const role = rosterFieldRole(e.symbol, key, e.label)
      const id = personIdForName(rosterIdByName, name)
      out[key] = roleConflictHint(id, role.role, name, attendance, trupps)
    }
    return out
  }

  /**
   * Being given a job on this Einsatz puts you on the Anwesenheit list. Whoever is named as
   * Einsatzleiter, put in a Trupp or entered as the Fahrer of a vehicle IS on scene; a rapport
   * that names somebody the attendance sheet has never heard of contradicts itself, and the
   * contradiction goes to the Gemeinde on paper.
   *
   * `roleNote` additionally fills that person's Bemerkung («Fahrer TLF», «Einsatzleiter») — the
   * field whose placeholder has always advertised exactly this and which nothing ever wrote. Only
   * onto an EMPTY remark: what somebody typed there by hand outranks anything derived.
   */
  /**
   * Clear a crew member's self-reported position from the command post. The dot's entity id is
   * `pos-<personId>` (lib/usePersonPositions), which is the only handle the panel has.
   *
   * No `device` on the request: that parameter scopes the delete to ONE phone, which is right
   * for «nicht mehr teilen» pressed on that phone and useless here — the whole point is that the
   * phone is not reachable (driven home, flat battery). The backend requires an editor for the
   * device-less form.
   */
  const stopPersonSharing = async (entityId: string) => {
    const personId = entityId.replace(/^pos-/, '')
    try {
      await apiDelete(`/api/incidents/${incidentMeta.id}/positions/${personId}`)
      setSelectedId(null)
      log('people', appConfig.copy.contextPanel.stopSharing, 'team')
    } catch {
      toast(appConfig.copy.contextPanel.stopSharingFailed, { icon: 'warn', tone: 'warn' })
    }
  }

  /** `groupTemplate` folds the per-person rows into ONE line naming the whole crew — see the
   *  Trupp caller below for why. It is the TEMPLATE and not a flag because the two kinds of Trupp
   *  read differently: «Unter AS: …» is a sentence, «Unter Trupp: …» is not.
   *  `noteFor` overrides the Funktion for ONE of them — the Gruppenführer's «AS-GF» beside his
   *  crew's «AS» (lib/roleAssignment · truppRoleNote). Only the note differs: the crew line still
   *  names the whole Trupp under its own Funktion, because that is the fact being recorded. */
  const ensurePresentForRole = (
    ids: (string | undefined)[], roleNote?: string, groupTemplate?: string,
    noteFor?: (id: string) => string | undefined,
  ) => {
    // Not on an Atemschutz-Link session: its Anwesenheit write is a no-op (the slice never
    // carries attendance), and a Verlauf row claiming «anwesend · AS» over a record that never
    // changed would be a lie on paper. The tablet marks the crew present when it takes the Trupp.
    if (!canWriteRecord) return
    const wanted = [...new Set(ids.filter(Boolean) as string[])]
    const fresh = wanted.filter((id) => !isPresent(attendance[id]))
    // ⚠️ APPEND, don't fill-if-empty: one person routinely holds two jobs, and the Fahrer who
    // then goes under Atemschutz is «Fahrer Pio, AS». See lib/roleAssignment · mergeRoleNote for
    // when a part replaces an earlier one instead of joining it.
    const noteOf = (id: string) => noteFor?.(id) ?? roleNote
    const needNote = roleNote
      ? wanted.filter((id) => mergeRoleNote(attendance[id]?.note, noteOf(id)!) !== (attendance[id]?.note ?? '').trim())
      : []
    if (!fresh.length && !needNote.length) return
    // through the history, like every other write to this slice — being made Fahrer or EL puts
    // somebody on the Anwesenheit, and «that was the wrong name» is the same mistake as a tap
    attSet((cur) => {
      const next = { ...cur }
      for (const id of fresh) {
        const name = rosterById.get(id)?.displayName ?? cur[id]?.displayNameSnapshot ?? id
        // being given the job opens a presence block: the alarm time for a first one, the real
        // clock for someone who had already left and is being sent out again
        const at = intervalsOf(cur[id]).length ? new Date().toISOString() : incidentMeta.started_at
        next[id] = openPresence(cur[id], at, name)
      }
      // …stamped, so «wer ist jetzt EL» has an answer that does not depend on a sort order
      // (types · AttendanceEntry.noteAt)
      const at = new Date().toISOString()
      for (const id of needNote) if (next[id]) next[id] = { ...next[id], note: mergeRoleNote(next[id].note, noteOf(id)!), noteAt: at }
      return next
    })
    // ONE row per person, not one for the presence and a second for the remark: naming a Fahrer
    // is a single act, and «Meier Anna anwesend» followed by «Meier Anna – Bemerkung: Fahrer TLF»
    // reads like two things happened to her.
    const A = appConfig.copy.anwesenheit
    const noted = new Set(needNote)
    // ── ONE row for a whole crew (01.09.) ──
    // A Trupp of three wrote three near-identical lines — «X – Bemerkung: AS» ×3 — under the
    // Trupp's own rows, which is three quarters of a screen at 3am saying one thing. Worse, the
    // word was wrong: nobody remarked anything, the app filled a Funktion. The names are what a
    // reader is after, so they go on one line and the field they came from is not mentioned.
    if (groupTemplate && roleNote) {
      const named = wanted
        .filter((id) => fresh.includes(id) || noted.has(id))
        .map((id) => rosterById.get(id)?.displayName ?? attendance[id]?.displayNameSnapshot ?? id)
      if (named.length) log('people', fillTemplate(groupTemplate, { role: roleNote, list: named.join(', ') }), 'team')
      return
    }
    for (const id of fresh) {
      const name = rosterById.get(id)?.displayName ?? id
      log('people', noted.has(id) && roleNote
        ? fillTemplate(A.logPresentAs, { name, role: noteOf(id)! })
        : `${name} anwesend`, 'team')
    }
    // somebody already on the list who has just been given the job: the role is the news
    for (const id of needNote) {
      if (fresh.includes(id)) continue
      log('people', fillTemplate(A.logNote, { name: rosterById.get(id)?.displayName ?? id, note: noteOf(id) ?? '–' }), 'team')
    }
  }
  /** ⚠️ Being in a Trupp is a JOB, and the Anwesenheit should say so. It marked the crew present
   *  and wrote nothing, so the list — and the Personalblatt printed from it — could not tell an
   *  AdF who stood at the Magazin from one who was under Atemschutz. The link already existed in
   *  one direction (the Trupp picker says «unter AS» about somebody on the list); this is the
   *  same fact read the other way round. Like every auto-Bemerkung it only fills an EMPTY one,
   *  so anything typed by hand survives.
   *
   *  ⚠️ …and the crew typed BY HAND, which this used to miss entirely (field report 02.09.). The
   *  Trupp form's «Name eingeben (Gast/Nachbarwehr)» records a display name and no roster id, so
   *  the id list above never saw that person: a Gast who had been under Atemschutz for the whole
   *  Einsatz was absent from the Anwesenheit, from the headcount and from the Personalblatt
   *  printed off it. Same route a typed name on a symbol has always taken (assignTypedName):
   *  known to the roster → the person they are, unknown → a Gast row on THIS Einsatz. */
  /* ⚠️ …and the Funktion says WHICH KIND of Trupp (04.09., Feldtest). Every crew member used to
   *  be filed as «AS», the Verkehrstrupp included — and the Verlauf prints that Bemerkung behind
   *  the name on its first mention (lib/journalLinks), so a row about a Trupp without Atemschutz
   *  read «Müller Hans (AS)»: a statement about where somebody was, on the surface the
   *  Personalblatt is printed from. The list itself has drawn the distinction since 03.09.
   *  («unter AS» / «im Trupp»); this is the same fact written onto the row.
   *  ⚠️ …and the GRUPPENFÜHRER gets the «-GF» variant of it, wherever his name came from: the
   *  picker (`leaderPersonId`) or the keyboard (the first name `unrecordedCrewNames` returns is
   *  `f.name`, which IS the leader — see types · Trupp.name). */
  const ensurePresentFromTrupp = (f: Pick<TruppFields, 'name' | 'members' | 'leaderPersonId' | 'memberPersonIds' | 'kind'>) => {
    const { role, leaderRole, groupTemplate } = truppRoleNote(f)
    const ids = [f.leaderPersonId, ...(f.memberPersonIds ?? [])]
    ensurePresentForRole(ids, role, groupTemplate, (id) => (id === f.leaderPersonId ? leaderRole : undefined))
    // 'presence': being in a Trupp contradicts nothing — the conflict check is about somebody
    // holding a SECOND job (lib/roleAssignment · roleConflictHint)
    const lead = f.name.trim()
    for (const name of unrecordedCrewNames(f, (n) => personIdForName(rosterIdByName, n))) {
      assignTypedName(name, 'presence', name === lead ? leaderRole : role)
    }
  }

  /** Assign a role: presence + Bemerkung, and the hint if it contradicts the record (lib ·
   *  roleAssignment). The hint never blocks — it is shown after the assignment went through. */
  const assignRole = (personId: string | undefined, role: AssignableRole, note?: string) => {
    if (!personId) return
    const name = rosterById.get(personId)?.displayName ?? attendance[personId]?.displayNameSnapshot ?? personId
    const hint = roleConflictHint(personId, role, name, attendance, trupps)
    ensurePresentForRole([personId], note)
    if (hint) toast(hint, { icon: 'warn', tone: 'warn' })
  }

  /**
   * The id a HAND-TYPED name is filed under, given the job it was typed into — the one thing
   * every person field needs and only two of them used to have.
   *
   * Typing a name is the normal way a Nachbarwehr, a Gast or an AdF whose roster row never
   * synced gets onto this Einsatz. Only the Anwesenheit's «Weitere Person» and the Trupp form
   * recorded one; everywhere else the name stopped on the object it was typed on — a Fahrer on a
   * vehicle, a Stv. on the Einsatzleiter glyph, the Einsatzleiter on the Rapport — so an Einsatz
   * could be led by somebody the Anwesenheit, the Personalblatt and the Soldblatt printed from it
   * had never heard of.
   *
   * ⚠️ Resolve BEFORE recording. The pickable roster already holds this Einsatz's guests, so
   * naming the same Nachbarwehr driver on a second vehicle finds the row they already have
   * rather than opening a second one under the same name.
   *
   * ⚠️ And a NEW Gast gets the job from `addGuest` itself, not from a role assignment afterwards:
   * their row does not exist yet in this render's `attendance`/`rosterById`, so the assignment
   * would mark a stranger present and write their raw id into the Verlauf.
   */
  const assignTypedName = (name: string, role: AssignableRole, note?: string): string | undefined => {
    const known = personIdForName(rosterIdByName, name)
    if (!known) return addGuest(name, note)
    assignRole(known, role, note)
    return known
  }

  /**
   * A name typed into a symbol's roster field («Fahrer» on the TLF, «Name»/«Stv.» on the
   * Einsatzleiter glyph) is a job handed to somebody who is standing there. It used to live
   * ONLY on the entity: the Rapport, the Anwesenheit and the Soldblatt never learned about it,
   * and the operator entered the same person twice. Only fields that CHANGED are considered —
   * re-rendering the panel must not re-open a presence block somebody closed on purpose.
   */
  const ROSTER_FIELDS: readonly string[] = appConfig.symbols.rosterFields
  const linkRosterFields = (prev: Entity, fields: Record<string, string>, opts?: { force?: boolean }) => {
    // ⚠️ Which fields actually moved is a decision with edge cases (a seeded blank is not a
    // change; a changed FUNKTION has to re-file the name beside it), so it lives in
    // lib/entityEdit · rosterFieldsToRefile with its own tests rather than inline here.
    for (const { key: k, value: v } of rosterFieldsToRefile(prev.fields, fields, ROSTER_FIELDS, opts)) {
      // which job this field hands out, and what it writes into the Bemerkung — lib ·
      // roleAssignment, so «Fahrer TLF» / «Einsatzleiter» / «Stv. Einsatzleiter» is one
      // decision with tests rather than a chain of conditions inside the workspace
      const { role, note } = rosterFieldRole(prev.symbol, k, prev.label, fields)
      // ⚠️ …and a name the Mannschaftsliste has never heard of is a Gast, recorded as one
      // rather than dropped: it was typed onto a symbol because that person is standing there.
      assignTypedName(v, role, note)
    }
  }

  /** Edit a Karte-owned symbol through the projection shown on a linked Modul. This is the map
   *  editor's normal mutation path, including its single-step live title edit and roster side
   *  effects; only the pointer happened to start on the plan. */

  /**
   * The roster's spelling of every name on a Trupp, applied ON THE WAY IN.
   *
   * ⚠️ The Trupp's name is what the rest of the app draws from — the card, the hose tag, the
   * Kroki chip (through `abbreviateName`, which reads the station's name order to decide which
   * token is the surname) and the bold in the Verlauf. Typed «Hans Müller» where the roster says
   * «Müller Hans», all four disagreed at once: one Kroki carrying «Müller H.» beside «Peter S.»,
   * and a Verlauf marking one Trupp's leader and not the other's. The name resolves to the same
   * person either way (lib/personnel · personIdForName) — so it may as well be written down the
   * way the person is spelled everywhere else. A real Gast matches nobody and is left alone.
   */
  const canonTrupp = <T extends TruppFields | Trupp>(t: T): T => ({
    ...t,
    name: canonicalName(t.name, rosterIdByName, rosterById),
    members: t.members?.map((m) => canonicalName(m, rosterIdByName, rosterById)),
  })
  // ⚠️ The CANONICALISED crew reaches the Anwesenheit too, not the raw form values: a Gast row is
  // opened under the name that is written down everywhere else, so «Hans Müller» typed into the
  // Trupp form cannot open a second row beside the roster's «Müller Hans».
  const createTruppA = (t: Trupp) => { const c = canonTrupp(t); createTrupp(c); ensurePresentFromTrupp(c) }
  const editTruppA = (id: string, f: TruppFields) => { const c = canonTrupp(f); editTrupp(id, c); ensurePresentFromTrupp(c) }
  // `standby` MUST be forwarded: this wrapper used to swallow it, so «Bereitstellen» ran the
  // «Wieder einrücken» path — a crew standing at the vehicle with a running contact clock, which
  // is exactly the case the standby fork exists to prevent (see useTruppActions · reactivateTrupp).
  const reactivateTruppA = (id: string, f: TruppFields, standby?: boolean) => { const c = canonTrupp(f); reactivateTrupp(id, c, standby); ensurePresentFromTrupp(c) }

  // --- checklists ---
  // Ticking is field documentation, not tactical editing, so it's gated by ROLE
  // (editor, incl. on a phone) rather than tacticalLocked — but still blocked for
  // true viewers and during replay. Presence in `ticks` = checked.
  // canEditRecord, not canEditIncident (07.09.): ticking is record-keeping — the el role
  // and an editor's Führungsansicht keep it; the backend enforces the same boundary.
  const canTick = canEditRecord
  const { toggleTick, setBranch, describeStep: describeChecklistStep } = useChecklistActions({ canTick, checklists, setChecklists: checklistSet, authorName: user?.display_name, log, emit })
  // in an effect, not during render: it is read only when a step is TAKEN, long after this commit
  useEffect(() => { checklistDescribeRef.current = describeChecklistStep })
  // Deep links: an item's `action` jumps to the matching surface (best-effort, reusing
  // existing setters). journal → open the composer; plan → Plan tab; draw → Lage + pen.
  const checklistAction = (_item: Item, a: NonNullable<Item['action']>) => {
    if (a === 'journal') setComposerOpen(true)
    else if (a === 'plan') {
      // «Objektplan bereitlegen» must land ON the Übersicht, not merely on the Pläne tab:
      // activePlanId is remembered per device, so a bare setMode dropped a first-time user
      // on whatever was open last (the OSM whiteboard on a fresh device) and left them to
      // find the module themselves. Modul 1 is the FKS Übersicht — the sheet the item means.
      // No Modul 1 on this object (or no object at all) → the tab, as before.
      setPanel(null)
      if (!goToModule(1)) setMode('plans')
    }
    else if (a === 'draw') { setMode('map'); setTool('line') }
  }

  const mapUI = mode === 'map'

  /* ── one fault line per view (SurfaceBoundary, 02.09.) ─────────────────────────────────────
   * A throw in ANY panel — a Mittel row without a label, a Verlauf text, a building without
   * floors when the Kroki opened — used to unmount the whole workspace, the Atemschutz alarm host
   * with it. Every surface below renders inside its own boundary: the card sits in the view, the
   * rail, top bar and Meldeleiste keep working, and «Zur Karte» is the way out. The alarm host
   * stays OUTSIDE every one of them (both layouts), and the per-incident ErrorBoundary in App
   * remains the last line. `toMap` false = no such button (the map itself, the handed-over board). */
  const crashToMap = () => { if (mode !== 'map') clearMapUi(); setJournalOpen(false); setPanel(null); setMode('map') }
  const guarded = (surface: string, node: ReactNode, toMap = true) => (
    <SurfaceBoundary surface={surface} onToMap={toMap ? crashToMap : undefined}>{node}</SurfaceBoundary>
  )
  /**
   * Is the right-hand dock slot free for a detail panel (.ctx — ContextPanel / DrawEditor /
   * ShapeEditor)?
   *
   * The Lage's twin of Whiteboard · `editorSlotFree`, and the same rule: that slot holds exactly
   * ONE thing. `05-navrail.css` already writes it down for the chrome toggles — «Only one of
   * {Ebenen, views popover, tool dock} is ever open» — but the detail panel was never counted
   * into that set even though `.ctx` sits in the same band (z35, right of the tool rail) that
   * `.layers-card` opens over (z201), and on a phone on the very same bottom edge. Opening
   * Ebenen therefore buried an open panel that stayed tappable through the z28 backdrop.
   *
   * ⚠️ Hides the panel, never the SELECTION. `clearMapUi('selection')` deliberately keeps
   * `selectedId` for exactly these two toggles, so the halo stays put and the panel comes back
   * the moment Ebenen closes. That is the half of its reasoning which was always right; the half
   * that claimed «nothing becomes unreachable» was not, and this is what makes it true.
   */
  const detailSlotFree = mapUI && !journalOpen && panel === null && !viewsOpen

  const annotatedPlanCount = useMemo(() => annotatedPlans(planDocs, board, false).length, [planDocs, board])

  // `maptool-<tool>` on the root drives the map cursor (see .maptool-* in app.css) the way the
  // plan canvas's own `tool-<tool>` does. Gated on mapUI so an armed tool can never leak a
  // crosshair onto Checkliste, Atemschutz or the plan.
  /* The Atemschutzüberwachung, as ONE element used by both branches below — the full workspace
   * and the handed-over «Tafel pur» (asLink). Extracted so the prop list exists once: a board
   * that drifts between the two would be the same failure the twin doctrine names, on a surface
   * where a missing control is a Trupp nobody clocked. */
  const atemschutzBoard = (
    <AtemschutzView
      trupps={effTrupps}
      // ⚠️ A link holder has no picture to read a hose number off and no surface to draw one on,
      // so the quick-picks are empty there and the Ltg-Nr row goes with them (`lite`).
      leitungOptions={asLink ? () => [] : truppLeitungOptions}
      truppColors={truppColors()}
      showTruppLine={showTruppLine} truppsWithLine={truppsWithLine()} lineNoOf={truppLineNos()}
      unlinkTruppLine={unlinkTruppLine}
      // where each placed Trupp's marker stands, if it is docked to a symbol (lib/docking)
      dockedAt={new Map(doc.entities.flatMap((e) => {
        if (e.kind !== 'team' || !e.truppId || !e.dockedTo) return []
        const host = doc.entities.find((h) => h.id === e.dockedTo)
        return host ? [[e.truppId, host.label || appConfig.copy.entities.fallbackObjectName] as const] : []
      }))}
      // the ONE slice an Atemschutz-Link may write — see canEditTrupps
      canEdit={canEditTrupps}
      personnel={pickablePersonnel}
      attendance={effAttendance}
      // a Gast under PA was at the Einsatz — record them on the Anwesenheit too. Through
      // assignTypedName, so typing the name of somebody who IS on the list (or already on
      // this Einsatz) links that row instead of opening a second one beside it. No job
      // written here: the Trupp is not formed yet, and submitting it writes «AS» itself.
      // ⚠️ NOT for a link session: the Anwesenheit is not its slice, and the write would 403.
      onAddGuest={canEditIncident ? (name) => assignTypedName(name, 'presence') : undefined}
      createTrupp={createTruppA}
      placeTrupp={placeTrupp}
      placeTargets={placeTargets}
      // the Trupp symbols already standing on Lage/plan, offered under the placement targets
      markerOptions={truppMarkerOptions}
      adoptMarker={adoptMarkerA}
      focusTruppOnPlan={focusTruppOnPlan}
      recordContact={recordContact}
      recordPressure={recordPressure}
      setTruppStatus={setTruppStatus}
      editTrupp={editTruppA}
      // «In diesen Trupp verschieben» — the one tap behind the form's double-assignment warning.
      // It only ever touches the crew fields of the OTHER Trupp, so it is the same slice an
      // Atemschutz-Link session already writes (useTruppActions · transferOutOfTrupp).
      transferOutOfTrupp={transferOutOfTrupp}
      reactivateTrupp={reactivateTruppA}
      deleteTrupp={deleteTrupp}
      restoreTrupp={restoreTrupp}
      removedTrupps={removedTrupps}
      muted={atemschutzMuted}
      onToggleMuted={toggleAtemschutzMuted}
      audioBlocked={atemschutzAudioBlocked}
      onUnlockAudio={unlockAtemschutzAudio}
      order={atemschutzOrder}
      onOrder={setAtemschutzOrder}
      onMove={canEditIncident && !readOnly ? moveTrupp : undefined}
      intervalMin={azIntervalMin}
      graceSec={azGraceSec}
      defaultFunkkanal={azFunkkanal}
      focus={truppFocus}
      createRequest={truppCreate}
      // «Überwachung abgeben» — the QR beside the bell, on the page the FU is standing on when
      // they decide to hand the Tafel over. Same sheet as the Einsatz-Karte's «Teilen», opened
      // on its «Nur Atemschutz» half.
      onShareLink={canShareLive ? () => setShareLink('atemschutz') : undefined}
      shareLinkActive={atemschutzLinkOn}
      // the board's own sync/clock line (safety review 01.09.): the Tafel says itself whether
      // its Stand is saved and its clock is right — on the handed-over board there is no
      // top-bar pill to say it, and on the tablet nobody watching Trupps watches the top bar
      syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} clockSkewMs={clockSkewMs}
      // the Suche's two doors on a Trupp (Tür 3) and its areas under the Ziel — editor only
      sucheItems={canEditSuche && !replayActive ? sucheTruppItems : undefined}
      zielChoices={canEditSuche && !replayActive ? sucheZielChoices : undefined}
      // «Tafel pur»: the whole app for this session, so the subtitle has to name the Einsatz —
      // nothing else on that screen does.
      // …and the two halves apart as well: the phone's one-row head cuts the joined line and
      // prints these two whole in the popover behind the title (AtemschutzView · headDetail).
      lite={asLink ? {
        subtitle: [incidentMeta.title, incidentMeta.address].filter(Boolean).join(' · '),
        title: incidentMeta.title || undefined,
        address: incidentMeta.address || undefined,
      } : undefined}
      // …and with no TopBar on that screen, the app's ONE ↶ ↷ pair rides in the board's own
      // header. Same timeline as everywhere else — only trupp actions can reach this session's
      // stack, and its writes go down the trupps slice, which a link session already syncs.
      onUndo={onHistoryPress('undo')}
      onRedo={onHistoryPress('redo')}
      canUndo={histCanUndo}
      canRedo={histCanRedo}
      undoLabel={undoLabel}
      redoLabel={redoLabel}
      // a closed Einsatz is a record, not a situation: every clock stands at the Einsatzende
      frozenAt={azFrozenAt}
    />
  )

  /* ── «Tafel pur»: the Atemschutz-Link session's WHOLE app ────────────────────────────────
   *
   * Somebody scanned the QR the FU held out and is now watching this Einsatz's Atemschutz on
   * their own phone. What they get is the board and the two things that make it safe — the
   * alarm host (tone + OS notification, which is the half that works while the screen is off)
   * and the alarm strip, on the same terms as everywhere else. Nothing else: no TopBar, no
   * NavRail, no context panel, no Meldeleiste, no sheets but the Trupp-Formular the board opens
   * itself. Every control that is not here is one this session's backend would refuse.
   *
   * ⚠️ AFTER every hook, and it uses the SAME `atemschutzBoard` element as the full layout —
   * one prop list, so the handed-over board cannot quietly drift from the one in the app.
   * Toasts + confirms are already mounted app-wide (App · Overlays), the icon sprite is not. */
  if (asLink) {
    return (
      <div className="app as-link-shell">
        <IconSprite />
        {/* ⚠️ Same tab-lock message as the full layout, WITHOUT its editor gate: an Atemschutz-
            Link session is role 'viewer' but genuinely writes, so losing the lock to another tab
            of this browser must say so — silently hiding every button left a handed-over Tafel
            that looked read-only for no reason. The Meldeleiste is mounted at App root, so the
            row paints here too. */}
        {tabLockLost && <TabLockBanner onTakeOver={onTakeOverTab} />}
        <AtemschutzAlarmHost trupps={trupps} muted={atemschutzMuted} active={azMonitoring}
          logAlarm={logTruppAlarm} logAlarmCleared={logTruppAlarmCleared} intervalMin={azIntervalMin} graceSec={azGraceSec} onState={setAzAlarm} />
        <RemindersHost {...reminders.host} />
        {guarded('atemschutz', atemschutzBoard, false)}
        {/* `onBoard` is unconditionally true here — the board IS the screen, and the strip's own
            rule (see AtemschutzAlarmMeldung's header) is that it steps aside for it. Mounted
            regardless so the two layouts obey ONE contract rather than two. */}
        <AtemschutzAlarmMeldungen
          trupps={trupps}
          severities={azAlarm.severities}
          intervalMin={azIntervalMin}
          graceSec={azGraceSec}
          onBoard
          onAcknowledge={muteAtemschutz}
          onGoToTrupp={(id) => setTruppFocus({ id, nonce: Date.now() })}
        />
      </div>
    )
  }

  /* ── Anwesenheit and Material: full surfaces here, TABS of the Rapport on a phone ──
     ONE instance of each, built once and handed to whichever mounts it (18.09.2026). The phone
     bar holds five tiles, so those two gave up theirs; they are the same components with the
     same props either way — a fork would have been two rosters to keep in step, and the one on
     the phone is the one that gets corrected during the Appell. */
  const anwesenheitSurface = (
      <AnwesenheitView
        people={personnel}
        attendance={effAttendance}
        canEdit={canEditRecord}
        loading={personnelLoading}
        error={personnelError}
        blockedIds={blockedAttendanceIds}
        onAddGuest={canEditRecord ? addGuest : undefined}
        onMarkPresent={markPresent}
        onMarkLeft={markLeft}
        onClear={clearAttendance}
        truppOfPerson={truppOfPerson}
        onJumpToTrupp={(truppId) => {
          setMode('atemschutz'); setPanel(null)
          if (truppId) setTruppFocus({ id: truppId, nonce: Date.now() })
        }}
        onReload={() => { void reloadPersonnel() }}
        // the phone's way back — but ONLY while the top bar's own ↶ ↷ are off the bar, which
        // since 15.09.2026 is one width and nothing else: below 360px (see topBarUndoHidden).
        // Any other time the bar pair is the one door, so nothing is duplicated (06.09.).
        onUndo={canEditRecord ? onHistoryPress('undo') : undefined}
        onRedo={canEditRecord ? onHistoryPress('redo') : undefined}
        canUndo={histCanUndo}
        canRedo={histCanRedo}
        topBarUndoHidden={topBarUndoHidden}
        onSetTimes={canEditRecord ? setAttendanceTimes : undefined}
        onRemoveBlock={canEditRecord ? removeAttendanceBlock : undefined}
        onSetNote={canEditRecord ? setAttendanceNote : undefined}
        onSetOrt={canEditRecord ? setAttendanceOrt : undefined}
        captureUsage={captureUsage}
        shifts={effShifts}
        bands={effBands}
        onCreateBand={canEditRecord ? (label, from, to) => { bandActions.addBand(label, from, to) } : undefined}
        onSaveBand={canEditRecord ? (id, label, from, to) => {
          bandActions.renameBand(id, label)
          void bandActions.askAndSetBandTimes(id, from, to)
        } : undefined}
        onRemoveBand={canEditRecord ? bandActions.removeBand : undefined}
        onCycleCell={canEditRecord ? bandActions.cycleCell : undefined}
        onSetCellState={canEditRecord ? bandActions.setCellState : undefined}
        onPutCellState={canEditRecord ? bandActions.putCellState : undefined}
        startedAt={incidentMeta.started_at}
        onAddShift={canEditRecord ? addShift : undefined}
        onAddShiftSpan={canEditRecord ? addShiftSpan : undefined}
        onReplaceShift={canEditRecord ? replaceShift : undefined}
        onSetShiftTime={canEditRecord ? setShiftTime : undefined}
        onRemoveShift={canEditRecord ? removeShift : undefined}
        // Zeitplan-PDF and Zeitplan-Druck are both refused for a link session (the sheet
        // carries the crew's names) — without either prop the block hides itself
        onPrintZeitplan={!linkScoped && zeitplanRelay?.available ? onPrintZeitplan : undefined}
        onDownloadZeitplan={linkScoped ? undefined : onDownloadZeitplan}
        zeitplanPrintOnline={!!zeitplanRelay?.online}
        // Live crew positions, read next to the name — this is where somebody looks when
        // they want to know where a person is, and where they would pick up the phone.
        incidentId={incidentMeta.id}
        livePositions={livePeople.byPerson}
        incidentCenter={incidentView.center}
        onShowOnMap={(personId) => { setMode('map'); setPanel(null); focusEntity(`pos-${personId}`) }}
      />
  )
  const mittelSurface = (
      <MittelView
        entries={effMittel}
        canEdit={canEditRecord}
        onSave={saveMittel}
        captureUsage={captureUsage}
        placedSymbols={placedSymbols}
        trupps={effTrupps}
      />
  )

  return (
    <div className={`app mode-${mode}${phoneTools ? ' phone-tools' : ''}${georefActive ? ' georef-mode' : ''}${phoneGeoref ? ' phone-georef' : ''}${mapUtility ? ' map-util' : ''}${isPhone && sucheSurfaceOn ? ' suche-sheet' : ''}${mapUI ? ` maptool-${tool}` : ''} ${(tool === 'symbol' && pending) || (tool === 'shape' && pendingShape) ? 'placing' : ''}`}>
      <IconSprite />
      <AtemschutzAlarmHost trupps={trupps} muted={atemschutzMuted} active={azMonitoring}
        logAlarm={logTruppAlarm} logAlarmCleared={logTruppAlarmCleared} intervalMin={azIntervalMin} graceSec={azGraceSec} onState={setAzAlarm} />
      {/* the reminder clock, hosted for the same reason as the alarm above (10 s ≠ 1 Hz, same shape) */}
      <RemindersHost {...reminders.host} />

      {/* the map mounts once the pack has loaded OR failed for good — with an empty glyph table a
          symbol renders as its empty chip, which beats a splash that never ends (02.09.) */}
      {(sym.ready || sym.error) ? guarded('map', (
        <MapView
          ref={mapRef}
          entities={entities}
          readOnly={tacticalLocked}
          layers={mapLayers}
          byName={sym.byName}
          symMul={symbolScale.map}
          captionMode={symbolCaptions}
          onCaptionSuppressionChange={setMapSuppressedCaptions}
          initialCenter={incidentView.center}
          fitPoints={initialFitPoints}
          locateNonce={locateReq}
          editNoteId={editNoteId}
          onNoteText={noteTextLive}
          onNoteCommit={noteTextCommit}
          onNoteEdit={tacticalLocked ? undefined : (id) => { setSelectedId(id); setSelectedDrawingId(null); setEditNoteId(id) }}
          // the ⚙ stays on a locked surface — it opens the note READ-ONLY (a long note is
          // truncated on the map, and reading it is not editing it)
          onNotePanel={(id) => {
            if (tool === 'measure') return // the tap already landed as a measuring point (onSelect)
            setNotePanelId(id)
          }}
          trupps={effTrupps}
          truppSeverities={azAlarm.severities}
          // …and it LANDS on the card: the board can be a wall of Trupps, so «Im Atemschutz
          // zeigen» points at the one that was tapped (same gesture as the alarm row's «Zum
          // Trupp»). Without the focus the jump answered «which one is this?» with a list.
          onShowTrupp={(truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) }}
          // the marker's half of the Trupp join — the same action the Atemschutz card's picker
          // calls, so the takeover confirm and the «einrücken?» ask exist exactly once
          onTeamTrupp={tacticalLocked ? undefined : (entityId, truppId) => {
            if (truppId) void adoptTruppMarker(truppId, entityId)
            else releaseTruppMarker(entityId)
          }}
          onTeamNewTrupp={tacticalLocked ? undefined : newTruppFromMarker}
          onTeamMark={tacticalLocked ? undefined : markTeamPosition}
          onTeamRename={tacticalLocked ? undefined : renameTeam}
          onTeamClearTrail={tacticalLocked ? undefined : clearTeamTrail}
          onTeamRemoveWithTrail={tacticalLocked ? undefined : (id) => void removeTeamWithTrail(id)}
          // the searched areas removed Trupp markers left behind (lib/truppTrails)
          ghostTrails={mapGhostTrails(trails)}
          onGhostTrail={tacticalLocked ? undefined : (id) => void deleteGhostTrail(id)}
          // «Lösen» on a joined Trupp marker: it lets go of the Leitung on BOTH sides (anchor +
          // the Trupp's own number), which is a Trupp-record write and therefore outside the
          // Karte's document undo — so it quits with the confirm-with-undo toast one-shot ops
          // use here, and re-linking is the exact inverse call.
          onTeamUnlink={tacticalLocked ? undefined : (entityId, lineId) => {
            const marker = doc.entities.find((e) => e.id === entityId)
            const truppId = marker?.truppId
            if (!truppId) return
            // …and the hose lets go of the marker with it (useTruppActions · unlinkTruppLine)
            unlinkTruppLine(truppId)
            // …and the marker steps away from the end it just left (15.09., «places it away»), so
            // the two do not keep standing on one pixel looking joined. The hose end stays put.
            const map = mapRef.current
            if (map && marker?.coord) {
              const p = map.project(marker.coord)
              const c = map.unproject([p.x + 36, p.y + 36])
              patchEntity(entityId, { coord: [c.lng, c.lat] })
            }
            undoToast(appConfig.copy.atemschutz.lineUnlinkedToast, () => { linkTruppLine(truppId, lineId) })
          }}
          // the pill's «Lösen» for the OTHER bond (15.09.): a docked marker lets go of its symbol
          // without the detail sheet – dragging cannot part them any more, it moves both
          onTeamUndock={tacticalLocked ? undefined : (entityId) => {
            const marker = doc.entities.find((e) => e.id === entityId)
            const host = doc.entities.find((e) => e.id === marker?.dockedTo)
            if (!marker?.dockedTo) return
            patchEntity(entityId, { dockedTo: undefined })
            log('select', fillTemplate(appConfig.copy.log.teamUndocked, {
              name: marker.label || appConfig.copy.entities.fallbackObjectName,
              host: host?.label || appConfig.copy.entities.fallbackObjectName,
            }), 'team', undefined, entityId)
          }}
          preparedOverlays={mapOverlays}
          onSelectionDone={finishSelection}
          // the linked sheets themselves, as a raster backdrop under the ink — a picture of the
          // paper, not an object on it, which is why THIS one is not a projection of anything
          georefPlanRasters={georefPlanRasters}
          isVisible={isVisible}
          selectedId={selectedId}
          // Messen: a tap on a symbol is a measuring point FROM ITS CENTRE, never a selection —
          // opening the detail panel mid-measurement read as the tool cancelling itself
          // (Feldtest 09.09.). Drawings need no branch: `placing` already routes their taps to
          // the plain map click, which appends the tapped point.
          onSelect={(e) => {
            if (tool === 'measure') { measure.setPath((d) => [...d, e.coord as LngLat]); return }
            setSelectedId(e.id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
          }}
          onMapClick={onMapClick}
          drawings={drawings}
          drawingsVisible={isVisible(appConfig.defaults.drawingLayerId)}
          draft={draft}
          draftKind={tool === 'area' && areaMode === 'nodes' ? 'area' : lineNodes ? 'line' : null}
          placing={tool !== 'select'}
          onDraftDrag={(i, c) => setDraft((pts) => pts.map((p, j) => (j === i ? c : p)))}
          onDraftInsert={(i, c) => setDraft((pts) => { const next = [...pts]; next.splice(i, 0, c); return next })}
          onDraftDelete={(i) => setDraft((pts) => pts.filter((_, j) => j !== i))}
          onDraftPointAttachment={setDraftPointAttachment}
          measurePoints={tool === 'measure' ? measure.path : []}
          measureKind={tool === 'measure' ? measure.mode : null}
          onMeasureDrag={(i, c) => measure.setPath((pts) => pts.map((p, j) => (j === i ? c : p)))}
          onMeasureInsert={(i, c) => measure.setPath((pts) => { const next = [...pts]; next.splice(i, 0, c); return next })}
          onMeasureDelete={(i) => measure.setPath((pts) => pts.filter((_, j) => j !== i))}
          measureLabels={measure.labels}
          draggable={!tacticalLocked && tool === 'select'}
          onMarkerDragStart={startEntityMove}
          onMarkerMove={streamEntityMove}
          onMarkerDragEnd={finishEntityMove}
          onRotate={(id, deg) => { if (tacticalLocked) return; setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], rotation: deg } })) }}
          onShapeTransform={(id, patch, phase) => {
            if (tacticalLocked) return
            if (phase === 'start') { beginDrag(); return }
            if (phase === 'move') { setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) })); return }
            endDrag()  // 'end' — fold the whole gesture into a single undo step
          }}
          onView={setView}
          onBasemapUnavailable={onBasemapUnavailable}
          picking={coord.mode === 'aim'}
          onCursor={coord.setAim}
          onPick={(c) => {
            coord.setPicked(c); coord.setAim(null)
            coord.setMode('set')
          }}
          pickedPoint={coord.mode === 'set' ? coord.picked : null}
          placeMagnet={tool === 'shape' && !!pendingShape && SHAPE_TWO_POINT[pendingShape] && !tacticalLocked}
          placeAnchor={tool === 'shape' && !!pendingShape ? rotStart : null}
          freehand={freehandKind}
          onFreehand={onFreehand}
          circleEnabled={tool === 'circle' && !tacticalLocked}
          onCircle={createCircle}
          drawColor={drawColor}
          drawWidth={drawWidth}
          drawDashed={drawDashed}
          selectedDrawingId={selectedDrawingId}
          flashDrawingId={flashDrawingId}
          onSelectDrawing={(id, at) => {
            // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for
            // a drawing too big for its bounds to mean anything. Any other way into the selection
            // (Verlauf jump, a just-finished stroke) leaves a stale id here and is simply ignored.
            setDrawTap(at ? { id, x: at.x, y: at.y } : null)
            setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
          }}
          onUnlockDrawing={tacticalLocked ? undefined : (id) => { patchDrawingById(id, { locked: undefined }); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null) }}
          onUnlockShape={tacticalLocked ? undefined : (id) => { commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, locked: undefined } : e)) })); setSelectedId(id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }}
          onDelete={deleteEntity}
          selectedDrawing={selectedDrawing}
          onDrawingEdit={editDrawingCoords}
          onDrawingRadius={editDrawingRadius}
          onDrawingVertexInsert={insertDrawingVertex}
          onDrawingVertexDelete={deleteDrawingVertex}
          onDrawingAttachment={setDrawingAttachment}
          onLabelMove={tacticalLocked ? undefined : moveLabel}
          marqueeEnabled={tool === 'lasso' && !tacticalLocked && coord.mode === 'off'}
          selectedDrawIds={selectedDrawIds}
          selectedEntityIds={selectedEntityIds}
          onMarquee={onMarquee}
          onGroupTransform={transformGroup}
        />
      // the Karte's own card offers no «Zur Karte»: that button would lead to the view it is on
      ), false) : (
        <Splash inApp sub={appConfig.copy.loadingSubtitle} />
      )}

      <TopBar
        incident={incidentView}
        startedAt={incidentMeta.started_at}
        // the declared Einsatzende wins over the server's closure stamp: it is what the EL said
        // the Einsatz ended, and it is what the Rapport prints
        endedAt={reportMeta.endedAt ?? incidentMeta.closed_at}
        recording={voice.recording}
        recStartedAt={voice.recStartedAt}
        journalOpen={journalOpen}
        onToggleJournal={() => setJournalOpen((v) => !v)}
        reminderCount={reminders.openCount}
        // NOT a composer on a read-only surface: it used to open, take the text, and have the
        // journal store drop the row — «ich kann keine Einträge erfassen», with no reason given.
        // A tab that merely LOST THE LOCK keeps the button though: making it vanish answers the
        // question just as badly, so it says what is in the way and offers the one tap out of it
        // (the same «Hier bearbeiten» the banner carries, for when the banner is scrolled away).
        onAddEntry={linkScoped ? undefined
          : !readOnly ? () => setComposerOpen(true)
          : tabLockLost && isEditor ? () => toast(appConfig.copy.tabLock.hint, {
              icon: 'info',
              action: { label: appConfig.copy.tabLock.takeOver, onClick: onTakeOverTab },
            })
          : undefined}
        onHoldStart={linkScoped ? undefined : startVoiceMemo}
        onHoldEnd={linkScoped ? undefined : voice.stop}
        onHoldPhoto={linkScoped ? undefined : startQuickPhoto}
        // ⚠️ ONE pair, ONE history (08.09.2026). It used to route by surface — «take back what you
        // last did HERE» — which asked the operator to already know which surface his last tap
        // landed on, and left the Tafel's actions reachable only through a toast that expired.
        // It now steps the one global timeline and NAMES what it will take back, so an undo that
        // lands on another surface is never invisible (lib/undoTimeline · IncidentWorkspace ·
        // stepHistory).
        onUndo={onHistoryPress('undo')}
        onRedo={onHistoryPress('redo')}
        canUndo={histCanUndo}
        canRedo={histCanRedo}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        // ⚠️ No longer gated by SURFACE (08.09.2026). It used to be «map, plans or anwesenheit,
        // and not tacticalLocked», because on Checklisten or Mittel the pair would have stepped
        // the map's document invisibly — the very thing that made it a per-surface control. With
        // one timeline that reason is gone and the gate inverts: those surfaces are exactly the
        // ones whose actions had no way back at all, and hiding the pair there would hide the
        // only door to them. What is left is the honest question — may this session write
        // anything? An Einsatzleiter may (the record surfaces), so `tacticalLocked` is the wrong
        // test for it; a viewer may not, and gets nothing.
        showHistory={canEditIncident || canEditRecord}
        // On EVERY surface, not only the Karte: which way the smoke goes matters exactly as much
        // on the Atemschutz board and a Modul as on the map, and the chip vanishing on a surface
        // switch read as «the weather indicator is broken» in the field. Phones keep their
        // map-only float (.phone-wx) — that bar is genuinely too narrow everywhere else.
        weather={displayWeather}
        onOpenWeather={openWeatherDetails}
        bearing={view.bearing}
        azAlarm={azAlarm}
        // …and the chip lands ON the urgent Trupp's card, like every other way in (Meldeleiste,
        // Anwesenheit, the notification tap) — the chip names a Trupp, so the tap must find it.
        onOpenAtemschutz={(truppId) => {
          setMode('atemschutz'); setPanel(null)
          if (truppId) setTruppFocus({ id: truppId, nonce: Date.now() })
        }}
        // «2 vermisst» for everyone, and the tap lands on the Personen tab (E5)
        sucheMissing={sucheMissing}
        onOpenSuche={() => openSuche({ tab: 'personen' })}
        // Only on the map surface: the chip is a caveat about what the MAP is showing, and on
        // Plan/Atemschutz there are no vehicle symbols for it to qualify. During replay the
        // positions are historical by definition, so a staleness warning would be nonsense.
        gpsStale={mapUI && !replayActive && gpsStale}
        gpsAgeMs={gpsAgeMs}
        // On EVERY surface, unlike the GPS caveat above: this says what the device in your hand
        // is doing, which does not stop being true because you switched to the Plan.
        shareSlot={<SharePositionPill share={share} onChangeName={(restore) => {
          shareStatusRestore.current = restore
          setShareParent('status')
          setSharePick('pick')
        }} />}
        // «Einsatz abgeschlossen»: a mode of the incident, so it stands beside the Einsatzname
        // instead of floating as a fifth banner. Its two exits ride in the chip's menu.
        archived={incidentMeta.is_archived}
        onBackFromArchive={onBackFromArchive}
        onReactivate={onReactivateActive}
        // On the phone map surface the compass in the bottom bar already carries Einpassen
        // (== centerIncident) + Mein Standort, so a top-bar center button here would just
        // duplicate it AND crowd the narrow bar off its right edge (clipping the Atemschutz
        // alarm chip). A Plan's bottom bar carries «Einpassen» as its own tile too (20.09.2026:
        // the top-bar twin went) – so this is left ONLY for the sheets that have no bar at all:
        // a viewer-only Modul, the Gebäude pick surface, a replay. There the floating zoom is
        // dropped on a phone (15-mobile.css · .wb-zoom-float) and this is the one way back.
        mapNav={isPhone && mode === 'plans' && !phoneTools
          ? { action: { icon: 'cross', label: appConfig.copy.nav.fit, onClick: () => planFit.current?.() } }
          : null}
        titleSlot={
          <IncidentSwitcher
            active={incidentMeta}
            incidents={incidents}
            isEditor={isEditor}
            syncStatus={syncStatus}
            syncDetail={(journal.syncStatus === 'error' || auditDelivery.status === 'error') && syncStatus !== 'storage' ? appConfig.copy.journal.delivery.short : undefined}
            lastSyncedAt={lastSyncedAt}
            user={{ display_name: user?.display_name ?? '', color: user?.color ?? null, role: user?.role ?? 'viewer' }}
            onSettings={linkScoped ? undefined : () => setSettingsOpen(true)}
            onSwitch={onSwitchIncident}
            onHistory={linkScoped ? undefined : onOpenHistory}
            onEditMeta={canEditMeta ? onEditMeta : undefined}
            onDivera={onOpenDivera}
            onDatenquellen={onOpenDatenquellen}
            // Einsatzrapport (PDF + Drucken) and «Alle Einsätze» are both refused for a link
            // session — one generates a document with everyone's names, the other lists the
            // Einsätze this link has nothing to do with.
            // ⚠️ The SAME confirm the Rapport runs, with the same count in front of it — this row
            // used to archive plainly (see confirmAndComplete). The badge puts the check where it
            // can be read before the row is pressed, not only after.
            onArchive={canEditIncident && !readOnly && !incidentMeta.is_archived ? () => { void confirmAndComplete() } : undefined}
            // …the Trupps that are still out included: the badge exists so the open points can be
            // read BEFORE the row is pressed, and «niemand hat den Trupp rausgemeldet» is one.
            archiveOpenCount={abschlussMissing.length + (truppsStillOut > 0 ? 1 : 0)}
            // «Teilen» — THE door to the share sheet (06.09.): the bar's own Teilen button is
            // gone on every width, so this Einsatz-Karte row is the one place an Einsatz is
            // handed to somebody. Same gate as every minting door (`canShareLink`): editors,
            // never a viewer, a read-only surface or a link session.
            onShare={canShareLink ? () => setShareLink('view') : undefined}
            onHelp={() => setHelpOpen(true)}
            onInstall={isStandalone() || !installOffered(getInstallPlatform()) ? undefined : () => setInstallGuideOpen(true)}
            onOfflineReadiness={() => setOfflineReadyOpen(true)}
            onSyncNow={syncNow}
            // ⚠️ No «Abmelden» for a link session (02.09.): a link is the literal page and owns
            // no login on this device, so there is none to end here — and the row used to end
            // the DEVICE's own one. Leaving the link means leaving the page.
            // …and it always asks first (lib/logoutConfirm), saying what is still unsent here
            onLogout={linkScoped ? undefined : () => {
              void confirmLogout({
                online: navigator.onLine,
                unsyncedEntries: journal.pendingCount + journal.rejectedCount + media.pendingCount,
                unsyncedOther: syncStatus !== 'synced',
              }).then((ok) => { if (ok) void logout() })
            }}
            navKey={`${mode}|${journalOpen ? 'journal' : ''}`}
            sheetOpen={settingsOpen || helpOpen || installGuideOpen || offlineReadyOpen || !!shareLink}
          />
        }
      />


      <ReminderBanner
        due={reminders.due}
        onDone={reminders.markDone}
        onSnooze={(r) => reminders.snooze(r, 10)}
        // …and the way in, on the row's TITLE (Meldeleiste · MeldungTitle) rather than a third
        // button: open the Verlauf ON the row that raised this item, not at the top
        onOpen={(r) => { setJournalOpen(true); setJournalLandOn({ id: r.rowId, nonce: Date.now() }) }}
      />

      {/* One row per Trupp in Alarm — the tone's own message. Fed from the SAME fold that drives
          the tone (azAlarm.severities), so the strip cannot be silent while the app is not; and
          empty during replay, where the fold is silent too. «Zum Trupp» points at the card the
          Funkkontakt / die Druckmeldung is entered on — the same gesture the Anwesenheit's locked
          rows already use (onJumpToTrupp below). */}
      {/* the two degraded-map rows (see the state above): symbols that did not load, a basemap
          that is not cached for this view — each says what still works */}
      {sym.error && !symbolsRowHidden && (
        <SymbolsFailedMeldung onReload={() => { setSymbolsRowHidden(false); sym.reload() }} onDismiss={() => setSymbolsRowHidden(true)} />
      )}
      {noBasemap && (
        <NoBasemapMeldung onOpenOffline={() => { setNoBasemap(false); setOfflineReadyOpen(true) }} onDismiss={() => setNoBasemap(false)} />
      )}
      <AtemschutzAlarmMeldungen
        trupps={trupps}
        severities={azAlarm.severities}
        // a device that cannot end the alarm gets «Zur Kenntnis genommen» (see the component)
        canEdit={canEditTrupps}
        intervalMin={azIntervalMin}
        graceSec={azGraceSec}
        // withheld while the board itself is on screen — it shows the alarm in full and the
        // strip only covered its controls (see AtemschutzAlarmMeldung's header)
        onBoard={mode === 'atemschutz'}
        // Reaching the named card is acknowledgement enough to stop the room's tone and tray
        // re-notifications. The row itself stays until a real contact/pressure event clears it.
        onAcknowledge={muteAtemschutz}
        onGoToTrupp={(id) => {
          setMode('atemschutz'); setPanel(null)
          setTruppFocus({ id, nonce: Date.now() })
        }}
      />

      {/* one row per paused GPS attachment — they queue behind each other instead of stacking */}
      {mapUI && !tacticalLocked && pausedGpsConnections.map(({ drawing, endpoint, attachment }) => (
        <GpsFollowMeldung
          key={`${drawing.id}:${endpoint}`}
          id={`${drawing.id}:${endpoint}`}
          label={entities.find((e) => e.id === attachment.target.id)?.label ?? drawing.label ?? appConfig.copy.drawingEditor.drawing}
          onContinue={() => setGpsRouting(drawing, endpoint, 'trace')}
          onDetach={() => detachGpsHere(drawing, endpoint)}
        />
      ))}

      {/* one-tap way back after a Rapport checklist row navigated here — without it, the
          round trip went through the incident menu every time (feedback 2026-07-08) */}
      {rapportReturn && (mode === 'anwesenheit' || mode === 'mittel') && (
        <button
          type="button"
          className="rp-return"
          onClick={() => { setRapportReturn(false); openRapport() }}
        >
          <Icon id="doc" /> {appConfig.copy.abschluss.backToRapport}
        </button>
      )}

      {/* non-blocking "new build ready" prompt — waits for the operator instead of auto-reloading */}
      <UpdateBanner />

      {/* standing «Offline» row once the sync has sat in 'offline' past the grace window —
          the one-shot toast announces, this stays until the link is back (field ask 07.09.) */}
      <OfflineMeldung status={syncStatus} onSyncNow={() => void syncNow()} />

      {/* "Als App installieren" nudge — browser-tab only, one «Später» dismisses it for good
          on this device (the menu keeps the permanent entry).
          Hidden on the demo: a visitor isn't installing the demo as their command app. */}
      {!isDemoMode() && <InstallBanner onOpenGuide={() => setInstallGuideOpen(true)} />}

      {/* No demo «Zurücksetzen» button: it sat bottom-centre over the map's bottom controls
          (obstructing them on a phone), and a plain page reload already restores the pristine
          scene — the sandbox keeps a visitor's edits in React state only (see useIncidentSync),
          so reloading re-fetches the curated seed. The welcome modal spells this out. */}

      {/* another tab of this browser is editing this incident → this one is read-only; one tap
          moves editing here (only meaningful for editors — viewers are read-only anyway) */}
      {tabLockLost && user?.role === 'editor' && <TabLockBanner onTakeOver={onTakeOverTab} />}

      {/* ⚠️ «Einsatz abgeschlossen» is NOT published here (23.08.). Read-only is a property of the
          incident, not a message about it, so it rides beside the Einsatzname as a mode chip in
          the top bar — where the incident lives — and carries its two exits there. */}

      {/* correct-in-place: an alarm opens its Einsatz by itself, so the EL lands here
          operational immediately and with the dispatch's guesses unchecked. «Passt» confirms
          them, «Bearbeiten» opens the panel that holds Stichwort/Priorität/Ort/Einsatzart — no
          wizard between the crew and the Lage, which is the whole point (2026-08-02). */}
      {/* ⚠️ …and it is asked ONCE of the crew, not once of every device: `intakeReviewedAt` is the
          shared stamp on the workspace blob (lib/workspace). App decides `needsReview` from the
          blob as it stood when the Einsatz was opened — the live-follow poll only lands HERE, so
          this is the gate that retires the banner mid-Einsatz the moment someone else confirms on
          their tablet. */}
      {needsReview && !readOnly && !intakeReviewedAt && (
        <ReviewBanner meta={incidentMeta} onEdit={onEditMeta} onDone={onReviewDone} />
      )}

      {/* single left navigation rail — all surfaces; switches Karte / object Pläne / Checkliste */}
      <NavRail
        // device pref: the surface's word under its glyph (Einstellungen · Leisten)
        labels={railLabels}
        mode={mode}
        // leaving the map ends whatever was in progress on it. Without this the whole tactical
        // state was merely hidden and restored verbatim — you came back to an armed tool, a
        // half-drawn line and a re-opening symbol palette from minutes ago.
        onMode={(m) => { if (m !== mode) clearMapUi(); setMode(m) }}
        // the RAIL list: «Umrisse» + «Gebäude» are one morphing tile here, two documents everywhere
        // else (see railPlanDocs)
        planDocs={railPlanDocs}
        // PHONE only: the bar folds (18.09.2026) — every plan document into ONE «Pläne» tile,
        // and Anwesenheit + Material out of the bar entirely and into the Rapport as tabs. Five
        // tiles is what a 360px bar holds without a sideways scroll. The vertical rail keeps one
        // tile per document and both surfaces.
        fold={phoneFold}
        // …and the first tap on «Pläne» in an Einsatz opens «Plan wählen» by itself, once
        incidentId={incidentMeta.id}
        // …and with the Anwesenheit tile gone, its one number rides on the Rapport tile instead
        presentCount={presentIds.size}
        // the tile is the door to the GROUP: it opens the page this device was last on, and a
        // second tap / a hold opens the list of three — which carries each page's live count
        rapportTarget={rapportTarget}
        openCount={abschlussMissing.length}
        mittelCount={mittelLineCount(mittel)}
        activePlanId={activePlanId}
        onSelectPlan={(id) => { if (mode !== 'plans') clearMapUi(); setMode('plans'); setActivePlanId(id) }}
        azSeverity={azAlarm.peak}
        // the Suche's door (a dock, not a surface): toggles where it stands
        onSuche={() => (sucheSurfaceOn ? setSucheOpen(false) : openSuche())}
        sucheOn={sucheSurfaceOn}
        sucheCount={sucheMissing}
      />

      {findTruppOpen && (
        <TruppFinder trupps={placed} onPick={goToTrupp} onClose={() => setFindTruppOpen(false)} />
      )}

      {mapUI && (
        <>
          {/* zoom + locate — normally folded into the right ToolRail footer; floats
              top-right only on desktop where the rail is gone (replay, whose scrubber the rail's
              Messen readout would collide with). On a phone the tool bar's footer carries
              Ebenen + the compass, so this cluster isn't rendered there. */}
          {mapUtility && (
            <MapUtility
              onZoomIn={() => mapRef.current?.zoomIn()}
              onZoomOut={() => mapRef.current?.zoomOut()}
              bearing={view.bearing}
              views={viewsApi}
              // `|| isEl`: saved camera views live in the shared blob (cameraViews), which the
              // el record slice never pushes — offering «Speichern» would fake a shared save
              readOnly={readOnly || isEl}
              viewsOpen={viewsOpen}
              onViewsOpenChange={toggleViews}
              coordsOn={coord.mode !== 'off'}
              onToggleCoords={coord.cycle}
              layersOn={panel === 'layers'}
              onToggleLayers={() => togglePanel('layers')}
            />
          )}

          {/* phone: the wind read-out floats top-right under the bar — the top bar clipped it at
              the screen edge (that bar already carries switcher · Einsatzuhr · undo/redo ·
              Verlauf). NOT on a read-only surface: there the top bar has room for the weather
              (measured: 96px free with no undo/redo/Eintrag). The compass is NOT up here: it sits
              in the tool bar, beside Ebenen, where the map's other controls are (05.08.2026). It
              floated here again for one day (18.09.) and came back down — above the bar its menu
              opened half a screen away from the thumb that asked for it. */}
          {isPhone && !slimRail && displayWeather?.wind_dir_deg != null && (
            <div className="phone-wx">
              <WeatherBadge weather={displayWeather} onOpenMeteo={openWeatherDetails} bearing={view.bearing} popAlignOffset={-5} />
            </div>
          )}

          {/* coordinate readout — bottom-centre; aiming follows the cursor, set is locked.
              hidden during replay so it never stacks under the bottom-centre scrubber. The ✕ on
              its right is the same exit in both states — the mode used to be leavable only from
              the compass menu, two taps away, while it swallowed every map tap (02.09.). */}
          {coord.readout && !replayActive && (
            <div className={`coord-read${coord.mode === 'aim' ? ' aiming' : ''}${tool === 'measure' ? ' coord-read-stacked' : ''}`} role="status">
              <div className="cr-rows">
                <div className="cr-row"><span className="cr-tag">LV95</span><span className="cr-val">{fmtLV95(coord.readout[0], coord.readout[1])}</span></div>
                <div className="cr-row"><span className="cr-tag">WGS84</span><span className="cr-val">{fmtWGS(coord.readout[0], coord.readout[1])}</span></div>
              </div>
              <button type="button" className="cr-x" aria-label={appConfig.copy.nav.coordsExit} onClick={() => coord.setMode('off')}>
                <Icon id="close" />
              </button>
              <div className="cr-hint">{coord.mode === 'aim' ? appConfig.copy.nav.coordsHint : appConfig.copy.nav.coordsLocked}</div>
            </div>
          )}

        </>
      )}

      {/* click-away: a transparent full-screen backdrop closes the open map panel */}
      {/* phone only: a tap-catcher behind the panel sheet to close it. On desktop the panel
          floats as a side card, so NO backdrop — the map stays pannable with Ebenen open. */}
      {/* ⚠️ The KARTE's backdrop, and only it (15.09.2026). The Plan half used to be here for a
          LayerPanel the Plan no longer has — and with the panel gone the catcher was the whole
          bug it was once written to avoid: a full-screen z28 sheet over the z20 whiteboard,
          eating the first tap on a board that looked perfectly normal. */}
      {mapUI && panel !== null && isPhone && <div className="mapctl-backdrop" onClick={() => setPanel(null)} />}

      {/* the Ebenen dock (.layers-card z201) sits ABOVE the +Eintrag composer / Verlauf
          scrim that covers every other map popup, so it needs an explicit guard to hide
          with them — otherwise it pokes through the modal (parity with the tool popups) */}
      {mapUI && panel === 'layers' && !composerOpen && !journalOpen && !offlineReadyOpen && (
        <LayerPanel
          layers={layers}
          onToggle={toggleLayer}
          onOpacity={setOpacity}
          twins={planRasterRows(linkedPlans, twinLayers, twinLayerOpacity)}
          // …directly under «Lage», wherever the deployment's config calls that group: the sheet
          // a symbol was drawn on belongs beside that symbol, not past Wasser and Gefahren.
          twinsAfterGroup={layers.find((l) => l.id === appConfig.defaults.operationalLayerId)?.group}
          onShowAll={() => setAllLayers(true)}
          onHideAll={() => setAllLayers(false)}
          onReset={resetLayers}
          onClose={() => setPanel(null)}
        />
      )}

      {/* `tool === 'select'`, matching the Plan (Whiteboard gates all four of its editors on
          `tool === 'pan'`): a detail editor belongs to Auswahl and nothing else. clearMapUi already
          drops the selection on every tool pick, so this is the backstop for any path that sets a
          tool without going through pick(). */}
      {detailSlotFree && !tacticalLocked && tool === 'select' && selected && selected.kind === 'shape' && (
        <ShapeEditor
          key={selected.id}
          entity={selected}
          onColor={(c) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, color: c } : e)) }))}
          // ⚠️ The SAME ceiling the corner/axis drag clamps to (lib/shapes · SHAPE_MAX_M). It used
          // to be a local 800 while the drag stopped at 500, so the ± button grew a Rechteck to a
          // size the grip then refused to touch.
          onScale={(f) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, sizeM: Math.max(SHAPE_MIN_M, Math.min(SHAPE_MAX_M[e.shape ?? 'square'], (e.sizeM ?? SHAPE_DEFS[e.shape ?? 'square'].defaultSizeM) * f)) } : e)) }))}
          // A Rotation has one size and it is the RUN between its two ends; the loop's width
          // follows from it. So the buttons scale the run and the box is rebuilt from it — the
          // same maths the two end grips use, just in fixed steps for a finger that would rather
          // press twice than drag (lib/shapes · rotationBox).
          onScaleLength={(f) => commit((d) => ({ ...d, entities: d.entities.map((e) => {
            if (e.id !== selected.id) return e
            const run = rotationRun(e.sizeM ?? SHAPE_DEFS.rotation.defaultSizeM, e.aspect)
            const next = Math.max(SHAPE_MIN_M, Math.min(ROTATION_MAX_M, run * f))
            const box = rotationBox(next, ROTATION_W_M)
            return { ...e, sizeM: Math.round(box.size), aspect: Math.round(box.aspect * 1000) / 1000 }
          }) }))}
          onStop={(v) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, stop: v } : e)) }))}
          onCarrier={(v) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, carrier: v } : e)) }))}
          onReverse={() => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, reverse: !e.reverse || undefined } : e)) }))}
          onStrokeW={(w) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, strokeW: w } : e)) }))}
          onFill={(fillOpacity, hatch) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, fillOpacity, hatch: hatch || undefined } : e)) }))}
          onCorners={(sharp) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, sharpCorners: sharp || undefined } : e)) }))}
          // locking DESELECTS (same as a drawn Fläche, onToggleLock below): the ink goes
          // click-through and the LockChip becomes the only door back in
          onToggleLock={() => { commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, locked: !e.locked || undefined } : e)) })); if (!selected.locked) setSelectedId(null) }}
          locked={selected.locked}
          {...(selected.shape === 'square' ? (() => {
            // ⚠️ The box on the GROUND, from the two numbers the shape is stored with: `sizeM` is
            // its width and `sizeM × aspect` its height (types · Entity). No polygon to integrate
            // — a Rechteck is its own rectangle — so this is the same answer `polygonAreaM2` would
            // give for the outline, arrived at directly.
            const wM = selected.sizeM ?? SHAPE_DEFS.square.defaultSizeM
            const hM = wM * shapeAspect('square', selected.aspect)
            // ⚠️ Unrotated: `sizeM` is the box's own width and height. A rotated Rechteck occupies a
            // bigger axis-aligned box, but «wie gross ist diese Fläche» is asking about the shape,
            // not about the room it needs — which is the opposite call from a drawn Fläche, whose
            // outline has no width of its own to report.
            return { areaM2: wM * hM, perimeterM: 2 * (wM + hM), boxM: { widthM: wM, heightM: hM } }
          })() : {})}
          onCenter={() => flyToMapVisible(selected.coord, 18.4)}
          onDelete={() => deleteEntity(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* rendered even when tactical editing is locked (viewer / EL view — NOT phones, where
          the .ctx overlay is CSS-hidden): tapping a symbol always shows its details; the
          forced readOnly strips every edit affordance inside the panel. */}
      {detailSlotFree && tool === 'select' && selected && selected.kind !== 'shape' && selected.kind !== 'note' && selected.kind !== 'team' && (
        <ContextPanel
          key={selected.id}
          entity={selected}
          readOnly={selected.live || tacticalLocked}
          svg={selected.symbolSvg ?? (selected.symbol === appConfig.symbols.vehicleName ? vehicleSymbolSvg(selected.label ?? '', selected.rotation ?? 0) : selected.symbol ? sym.byName[selected.symbol] : undefined)}
          onClose={() => setSelectedId(null)}
          onCenter={() => flyToMapVisible(selected.coord, 18.4)}
          onProjection={selectedPlanProjection ? () => showMapSourceOnPlan(selected) : undefined}
          projectionLabel={selectedPlanProjection
            ? fillTemplate(appConfig.copy.contextPanel.showOnPlan, { plan: selectedPlanProjection.plan.code })
            : undefined}
          onTitleLive={(v) => {
            // stream into the doc so the note-pill / label updates live, but silently —
            // snapshot once for undo, no per-keystroke audit event
            entityTypedAt.current.set(selected.id, Date.now())
            if (!titleLiveRef.current) { titleLiveRef.current = true; beginDrag() }
            setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, label: v } : e)) }))
          }}
          onTitle={(v) => {
            // blur: fold the whole live edit into one undo step + a single audit event
            if (titleLiveRef.current) { titleLiveRef.current = false; endDrag(); emit('entity.edit', { id: selected.id, patch: { label: v } }) }
            else patchEntity(selected.id, { label: v })
            // ⚠️ …and the Fahrer's Bemerkung is «Fahrer {Label}», so naming the vehicle AFTER
            // naming its driver has to reach that person. A generic Fahrzeug is placed unlabelled
            // and gets its Bezeichnung typed later, which makes «Fahrer» with nothing after it
            // the NORMAL first state rather than an edge case.
            linkRosterFields({ ...selected, label: v }, selected.fields ?? {}, { force: true })
          }}
          // Symbol→Mittel: only where the station mapped at least one material to a symbol.
          // No switch to find — a Wehr that has not configured it never gets an offer.
          onFields={(fields) => { patchEntity(selected.id, { fields }); linkRosterFields(selected, fields) }}
          onNotes={!selected.live ? (v) => patchEntity(selected.id, { notes: v || undefined }) : undefined}
          onFloor={selected.kind === 'symbol' && !selected.live ? (f) => patchEntity(selected.id, { floor: f ?? undefined }) : undefined}
          onFloorFrom={selected.kind === 'symbol' && !selected.live ? (f) => patchEntity(selected.id, { floor: undefined, floorFrom: f ?? undefined, floorTo: selected.floorTo ?? selected.floor }) : undefined}
          onFloorTo={selected.kind === 'symbol' && !selected.live ? (f) => patchEntity(selected.id, { floor: undefined, floorFrom: selected.floorFrom ?? selected.floor, floorTo: f ?? undefined }) : undefined}
          onSpread={selected.kind === 'symbol' && !selected.live ? (s) => patchEntity(selected.id, { spread: s ?? undefined }) : undefined}
          onCount={selected.kind === 'symbol' && !selected.live ? (n) => patchEntity(selected.id, { count: n && n > 1 ? n : undefined }) : undefined}
          onRotate={selected.kind === 'symbol' && !selected.live ? (deg) => patchEntity(selected.id, { rotation: deg ?? undefined }) : undefined}
          // Karte only: the Schutzabstand rings are metric geometry, which the Plan cannot draw
          // (lib/ergRings). 'small' is the default and is stored as absent, so a fresh placard
          // syncs the same in both directions.
          onErgRings={selected.kind === 'symbol' && !selected.live ? (mode) => patchEntity(selected.id, { ergRings: mode === 'small' ? undefined : mode }) : undefined}
          // «Übernehmen» (Feldtest 07.09.): the ERG distance becomes a REAL Absperrkreis around
          // the symbol — createCircle selects it, so the operator lands on the editable cordon.
          // The derived preview rings go quiet for this placard: the real circle replaces them,
          // and two red rings at the same radius would read as a rendering bug.
          onAdoptRadius={selected.kind === 'symbol' && !selected.live && !tacticalLocked ? (radiusM) => {
            createCircle(selected.coord, radiusM)
            patchEntity(selected.id, { ergRings: 'off' })
          } : undefined}
          // Angedockte Gefahrentafel (lib/docking): name the host, offer the release — the drop
          // gesture that made the bond draws nothing, so this row is where it becomes visible.
          dockedToLabel={selected.dockedTo ? doc.entities.find((e) => e.id === selected.dockedTo)?.label || appConfig.copy.entities.fallbackObjectName : undefined}
          onUndock={selected.dockedTo && !tacticalLocked ? () => patchEntity(selected.id, { dockedTo: undefined }) : undefined}
          // …and the same bond from the HOST's side: the Trupps standing on THIS symbol, one row
          // each, worded «Trupp 4 · bei «Hydrant»» so a row names both sides before «Lösen»
          // separates them — the mirror of the marker's own join slot (components/TwinTeamPill).
          dockedTeams={doc.entities.flatMap((e) => {
            if (e.kind !== 'team' || e.dockedTo !== selected.id) return []
            const no = effTrupps.find((t) => t.id === e.truppId)?.no
            return [{
              id: e.id,
              label: fillTemplate(appConfig.copy.atemschutz.dockLabel, {
                who: no != null
                  ? fillTemplate(appConfig.copy.atemschutz.truppTerm, { name: String(no) })
                  : e.label || appConfig.copy.entities.fallbackObjectName,
                host: selected.label || appConfig.copy.entities.fallbackObjectName,
              }),
              onRelease: tacticalLocked ? undefined : () => undockTeam(e.id),
            }]
          })}
          onRotate2={selected.kind === 'symbol' && !selected.live ? (deg) => patchEntity(selected.id, { rotation2: deg ?? undefined }) : undefined}
          onCaption={selected.kind === 'symbol' && !selected.live ? (m) => patchEntity(selected.id, { caption: m }) : undefined}
          captionDefault={symbolCaptions ?? 'auto'}
          onAirflow={selected.kind === 'symbol' && !selected.live ? (extract) => patchEntity(selected.id, { extract: extract || undefined }) : undefined}
          controls={symbolControls(selected.symbol, sym.symbols.find((x) => x.name === selected.symbol)?.cat)}
          titleOptions={selected.kind === 'symbol' && !selected.live ? symbolTitleOptions(selected.symbol, sym.symbols.find((x) => x.name === selected.symbol)?.cat) : undefined}
          fieldOptions={selected.kind === 'symbol' && !selected.live ? symbolFieldOptions(selected.symbol, sym.symbols.find((x) => x.name === selected.symbol)?.cat, rosterNames) : undefined}
          rosterRank={rosterRank}
          personStatus={personStatus}
          fieldHints={rosterFieldHints(selected)}
          protectedKeys={selected.kind === 'symbol' ? new Set(symbolPresetFieldKeys(selected.symbol, sym.symbols.find((x) => x.name === selected.symbol)?.cat)) : undefined}
          onDelete={() => deleteEntity(selected.id)}
          hasOverride={vehicleOverrides[selected.id] != null}
          // Vehicles only. «GPS» undoes an operator's drag/rotate of a live symbol — a person
          // dot has neither (both are blocked in MapMarkers), so the button sat there
          // permanently disabled, a dead control inviting «what does this do?».
          // A crew member's own dot: the command post may clear it (editor only). Never offered
          // for a vehicle — that position comes from the fleet feed, not from a person.
          onStopSharing={selected.live && selected.kind === 'person' && canEditIncident && !readOnly
            ? () => { void stopPersonSharing(selected.id) }
            : undefined}
          onResetGps={selected.live && selected.kind !== 'person'
            ? () => setVehicleOverrides((m) => { const { [selected.id]: _drop, ...rest } = m; return rest })
            : undefined}
          // «Hier festhalten»: the Kroki is printed hours later, and a vehicle that has since
          // driven home takes its symbol with it — the picture then shows no TLF at an Einsatz
          // that had one. Pinning writes the CURRENT position as an override, which is the same
          // mechanism a drag already uses, so «GPS» beside it is the way back and there is no
          // second kind of pinned vehicle to reason about.
          onPinGps={selected.live && selected.kind !== 'person' && canEditIncident && !readOnly
            && Array.isArray(selected.coord) && vehicleOverrides[selected.id]?.coord == null
            ? () => {
              const coord = selected.coord as LngLat
              setVehicleOverrides((m) => ({ ...m, [selected.id]: { ...m[selected.id], coord } }))
              log('truck', fillTemplate(appConfig.copy.contextPanel.logPinned, { name: selected.label ?? '' }), 'symbol', undefined, selected.id)
            }
            : undefined}
          // A live vehicle's Fahrer: the GPS feed reports where a vehicle IS, never who is in
          // it, and that is the one thing the FU needs to reach it. Kept in the override map
          // because the entity itself is rebuilt from the feed on every poll.
          driver={selected.live && selected.kind !== 'person' && !readOnly
            ? {
              value: vehicleOverrides[selected.id]?.fahrer ?? '',
              options: rosterNames,
              onChange: (v: string) => {
                setVehicleOverrides((m) => ({
                  ...m,
                  [selected.id]: { ...m[selected.id], fahrer: v.trim() || undefined },
                }))
                // same rule as a placed vehicle's Fahrer field: naming a driver puts them on
                // the Anwesenheit list with «Fahrer <Fahrzeug>» as their Bemerkung — and a typed
                // Nachbarwehr driver onto it as a Gast (assignTypedName)
                assignTypedName(v, 'fahrer', fillTemplate(appConfig.copy.anwesenheit.roleFahrer, { vehicle: selected.label ?? '' }).trim())
              },
            }
            : undefined}
          connectedLines={drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === selected.id)).map((d) => ({ id: d.id, label: lineLabel(d) }))}
          onFocusLine={focusDrawing}
        />
      )}

      {/* note detail panel — the same ContextPanel, opened by the tap that selects the note (see
          notePanelId above) and by placing one. The note's TEXT is its title, so the panel's
          title field edits the note itself. */}
      {detailSlotFree && noteEntity && (
        <ContextPanel
          key={noteEntity.id}
          entity={noteEntity}
          // a note that was just put down opens ready to be written (see notePlacedId)
          autoFocusNote={notePlacedId === noteEntity.id && !tacticalLocked}
          // locked surfaces open the same panel with every edit affordance stripped — the note's
          // full text is exactly the kind of thing an Einsatzleiter needs to read off the map
          readOnly={tacticalLocked}
          onClose={() => setNotePanelId(null)}
          onTitleLive={(v) => noteTextLive(noteEntity.id, v)}
          onTitle={(v) => {
            if (titleLiveRef.current) { titleLiveRef.current = false; endDrag(); emit('entity.edit', { id: noteEntity.id, patch: { label: v } }) }
            else patchEntity(noteEntity.id, { label: v })
          }}
          onFields={(fields) => patchEntity(noteEntity.id, { fields })}
          // setting a width in the panel is a hand-made decision too — it ends the auto-fit
          // the S/M/L step keeps following the text, so it re-measures at the new font size
          // …each style edit is remembered as the NEXT note's default too («D pur», 09.09.:
          // the Notiz dock carries no style controls any more — this is the stickiness)
          onNoteSize={(s) => {
            patchEntity(noteEntity.id, noteEntity.noteAutoW
              ? { noteSize: s, noteW: autoNoteWPx(noteEntity.label ?? '', s) }
              : { noteSize: s })
            setNoteDefaults((d) => ({ ...d, size: s ?? 'm' }))
          }}
          onNotePlain={(p) => { patchEntity(noteEntity.id, { notePlain: p || undefined }); setNoteDefaults((d) => ({ ...d, plain: p })) }}
          onColor={(c) => { patchEntity(noteEntity.id, { color: c || undefined }); setNoteDefaults((d) => ({ ...d, color: c })) }}
          onDelete={() => { setNotePanelId(null); deleteEntity(noteEntity.id) }}
        />
      )}

      {detailSlotFree && tool === 'select' && selectedDrawing && (
        <DrawEditor
          drawing={selectedDrawing}
          pointCount={selectedDrawing.coords.length}
          // locked: the panel keeps the numbers (Länge, Höhenprofil, Fläche) and the
          // Verbindungen, and drops every control that would change the shape
          readOnly={tacticalLocked}
          areaM2={selectedDrawing.kind === 'circle' ? Math.PI * (selectedDrawing.radiusM ?? 0) ** 2
            : selectedDrawing.kind === 'area' && selectedDrawing.coords.length >= 3 ? polygonAreaM2(selectedDrawing.coords) : null}
          // a circle's box is its bounding square — the diameter each way
          boxM={selectedDrawing.kind === 'circle'
            ? { widthM: 2 * (selectedDrawing.radiusM ?? 0), heightM: 2 * (selectedDrawing.radiusM ?? 0) }
            : selectedDrawing.kind === 'area' && selectedDrawing.coords.length >= 3 ? bboxSizeM(selectedDrawing.coords) : null}
          perimeterM={selectedDrawing.kind === 'circle' ? 2 * Math.PI * (selectedDrawing.radiusM ?? 0)
            : selectedDrawing.kind === 'area' && selectedDrawing.coords.length >= 3
              ? pathLengthM([...selectedDrawing.coords, selectedDrawing.coords[0]]) : null}
          supportsDistance
          /* Messung on a line that is already drawn — geodesic length here, and the coords feed
             the collapsible swisstopo Höhenprofil (fetched only once it is opened) */
          lengthM={selectedDrawing.coords.length >= 2 ? pathLengthM(selectedDrawing.coords) : null}
          profileCoords={selectedDrawing.coords}
          // …each style edit is remembered as the NEXT drawing's default («D pur», 09.09.: the
          // docks carry no style controls and the preset row is gone — the last line is the
          // template, decoration included)
          onColor={(c) => { patchDrawing({ color: c }); setDrawColor(c) }}
          onWidth={(w) => { patchDrawing({ width: w }); setDrawWidth(w) }}
          onDashed={(dashed) => { patchDrawing({ dashed }); setDrawDashed(dashed) }}
          onLabel={(label) => { if (selectedDrawingId) patchDrawingLabelLive(selectedDrawingId, label) }}
          onLabelCommit={(label) => { if (selectedDrawingId) commitDrawingLabel(selectedDrawingId, label) }}
          onMarker={(marker) => { patchDrawing({ marker }); setDrawMarker(marker) }}
          onArrow={(arrow) => { patchDrawing({ arrow }); setDrawArrow(arrow) }}
          onEnding={(ending) => void changeMapEnding(ending)}
          onReverse={tacticalLocked ? undefined : () => reverseDrawing(selectedDrawing.id)}
          onContent={(content) => patchDrawing({ content })}
          // the anchored Trupp carries a COPY of the number (the AS chip prints it), so a
          // renumbered hose renumbers the Trupp too (useTruppActions · syncLineNoToTrupp)
          onLineNo={(lineNo) => { patchDrawing({ lineNo }); syncLineNoToTrupp(selectedDrawing.id, lineNo) }}
          onFloorTag={(floorTag) => patchDrawing({ floorTag })}
          // Abschnitt on the Fläche — Leiter + Auftrag (FKS Einsatzführung 3.5.2). Lage only:
          // a Plan sketch is not an Abschnitt, so the Whiteboard passes no handlers.
          onAbschnittLeiter={selectedDrawing.kind === 'area' ? (name) => patchDrawing({ abschnittLeiter: name }) : undefined}
          onAbschnittAuftrag={selectedDrawing.kind === 'area' ? (auftrag) => patchDrawing({ abschnittAuftrag: auftrag }) : undefined}
          people={pickablePersonnel.map((p) => p.displayName)}
          // Flächen that carry Leiter or Auftrag, THIS one counted as if already assigned —
          // so the FKS hint (max 3–4) shows while the 5th is being set up, not one edit late
          abschnittCount={drawings.filter((d) => d.kind === 'area' && (d.abschnittLeiter || d.abschnittAuftrag)).length
            + (selectedDrawing.abschnittLeiter || selectedDrawing.abschnittAuftrag ? 0 : 1)}
          // «Gehört zu Trupp …»: linking from the LINE's side. Routed through the same action the
          // Atemschutz board uses, so both directions write both collections identically.
          onTrupp={(truppId) => (truppId ? linkTruppLine(truppId, selectedDrawing.id) : unlinkLine(selectedDrawing.id))}
          trupps={effTrupps.filter((t) => t.status !== 'raus').map((t) => ({ id: t.id, name: t.name }))}
          usedLineNos={drawings.filter((d) => d.kind === 'line' && d.id !== selectedDrawing.id && d.lineNo != null).map((d) => d.lineNo!)}
          truppOnLine={truppForLine(selectedDrawing, effTrupps)?.name}
          truppOnLineOut={truppIsOut(truppForLine(selectedDrawing, effTrupps))}
          onShowTrupp={() => { setSelectedDrawingId(null); setMode('atemschutz'); setPanel(null) }}
          onShowDistance={(showDistance) => patchDrawing({ showDistance })}
          onRadius={(radiusM) => patchDrawing({ radiusM })}
          onHatch={(hatch, fillOpacity) => patchDrawing({ hatch: hatch || undefined, fillOpacity })}
          attachmentLabels={Object.fromEntries((['start', 'end'] as const).flatMap((endpoint) => {
            const a = endpoint === 'start' ? selectedDrawing.startAttachment : selectedDrawing.endAttachment
            if (!a) return []
            const targetLine = drawings.find((x) => x.id === a.target.id)
            const label = a.target.kind === 'object' ? entities.find((e) => e.id === a.target.id)?.label ?? a.target.id : targetLine ? lineLabel(targetLine) : appConfig.copy.drawingEditor.line
            return [[endpoint, label]]
          }))}
          onRouting={tacticalLocked ? undefined : (endpoint, routing) => setGpsRouting(selectedDrawing, endpoint, routing)}
          onDetach={tacticalLocked ? undefined : (endpoint) => {
            const a = endpoint === 'start' ? selectedDrawing.startAttachment : selectedDrawing.endAttachment
            if (!a) return
            const fallback: LngLat = a.target.kind === 'object'
              ? entities.find((e) => e.id === a.target.id)?.coord ?? (endpoint === 'start' ? selectedDrawing.coords[0] : selectedDrawing.coords[selectedDrawing.coords.length - 1])
              : (() => { const target = drawings.find((d) => d.id === a.target.id); return target ? (a.target.endpoint === 'start' ? target.coords[0] : target.coords[target.coords.length - 1]) : (endpoint === 'start' ? selectedDrawing.coords[0] : selectedDrawing.coords[selectedDrawing.coords.length - 1]) })()
            setDrawingAttachment(selectedDrawing.id, endpoint, undefined, fallback)
          }}
          onFocusAttachment={(endpoint) => {
            const a = endpoint === 'start' ? selectedDrawing.startAttachment : selectedDrawing.endAttachment
            if (!a) return
            if (a.target.kind === 'object') focusEntity(a.target.id); else focusDrawing(a.target.id)
          }}
          attachmentHidden={Object.fromEntries((['start', 'end'] as const).map((endpoint) => {
            const a = endpoint === 'start' ? selectedDrawing.startAttachment : selectedDrawing.endAttachment
            const target = a?.target.kind === 'object' ? entities.find((e) => e.id === a.target.id) : null
            return [endpoint, !!target && !isVisible(target.layer)]
          }))}
          onRevealAttachment={(endpoint) => {
            const a = endpoint === 'start' ? selectedDrawing.startAttachment : selectedDrawing.endAttachment
            const target = a?.target.kind === 'object' ? entities.find((e) => e.id === a.target.id) : null
            if (target && !isVisible(target.layer)) toggleLayer(target.layer)
          }}
          locked={!!selectedDrawing.locked}
          onToggleLock={tacticalLocked ? undefined : () => { patchDrawing({ locked: selectedDrawing.locked ? undefined : true }); if (!selectedDrawing.locked) setSelectedDrawingId(null) }}
          onDelete={() => selectedDrawingId && deleteDrawing(selectedDrawingId)}
          onClose={() => setSelectedDrawingId(null)}
        />
      )}

      {/* active-tool affordances — all anchored bottom-centre, like the draw style bar */}
      {mapUI && tool === 'symbol' && pending && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setPending(null); setTool('select') } }],
          [{ type: 'toggle', icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }],
          [{ type: 'info', text: appConfig.copy.dockHints.symbol }],
        ]} />
      )}
      {mapUI && tool === 'lasso' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('select') }],
          [{ type: 'info', text: appConfig.copy.dockHints.lasso }],
        ]} />
      )}
      {mapUI && tool === 'line' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setDraft([]); setTool('select') } }],
          // input mode: Freihand (drag) ↔ Punkte (tap each vertex, ✓ to finish)
          [
            { type: 'toggle', icon: 'pen', label: appConfig.copy.drawingEditor.modeFreehand, on: lineMode === 'freehand', onClick: () => { setLineMode('freehand'); setDraft([]) } },
            { type: 'toggle', icon: 'polygon', label: appConfig.copy.drawingEditor.modeNodes, on: lineMode === 'nodes', onClick: () => setLineMode('nodes') },
            ...(lineMode === 'nodes' ? [{ type: 'go' as const, disabled: !draftActive, onClick: commitDraft }] : []),
          ],
          // «D pur» (09.09.): no colour/width/style here — the finished line lands selected in
          // the DrawEditor (useMapDrawing · one-shot to Select), which is where the styling
          // lives; new lines inherit the last-used style (the editor writes the defaults back)
          [{ type: 'info', text: appConfig.copy.dockHints.line }],
        ]} />
      )}
      {mapUI && tool === 'area' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setDraft([]); setTool('select') } }],
          [
            { type: 'toggle', icon: 'pen', label: appConfig.copy.drawingEditor.modeFreehand, on: areaMode === 'freehand', onClick: () => { setAreaMode('freehand'); setDraft([]) } },
            { type: 'toggle', icon: 'polygon', label: appConfig.copy.drawingEditor.modeNodes, on: areaMode === 'nodes', onClick: () => setAreaMode('nodes') },
            ...(areaMode === 'nodes' ? [{ type: 'go' as const, disabled: !draftActive, onClick: commitDraft }] : []),
          ],
          // «D pur» like the line dock above: styling happens in the editor afterwards
          [{ type: 'info', text: appConfig.copy.dockHints.area }],
        ]} />
      )}
      {/* Notiz armed — «D pur» (09.09.) here too: a fresh note opens its detail panel with the
          caret already in the text (notePlacedId), and Zettel/Klartext, S/M/L and the colour
          live THERE — where they also write the next note's defaults. */}
      {mapUI && tool === 'note' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('select') }],
          [{ type: 'info', text: appConfig.copy.dockHints.note }],
        ]} />
      )}
      {/* Trupp — the one tool that had NO dock (testing feedback 2026-07-15): every active
          tool shows a ✕ + ⓘ so nobody is stranded wondering what the mode does */}
      {mapUI && tool === 'team' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setTeamPick(null); setTool('select') } }],
          // ⚠️ «Trupp finden» lives HERE, on the tool the question is about — not in the left
          // rail, which navigates between surfaces. Reaching for the Trupp tool is already the
          // gesture for «etwas mit einem Trupp», and placing one and finding one are the two
          // things that gesture can mean. Disabled rather than hidden while nothing is placed:
          // on the tool's own dock, its absence would read as a tool that lost a button.
          [{
            type: 'action', icon: 'search', label: appConfig.copy.truppFinder.title,
            disabled: placed.length === 0, onClick: () => setFindTruppOpen(true),
          }],
          [{ type: 'info', text: appConfig.copy.dockHints.team }],
        ]} />
      )}
      {mapUI && tool === 'circle' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('select') }],
          [{ type: 'info', text: appConfig.copy.dockHints.circle }],
        ]} />
      )}
      {mapUI && tool === 'measure' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { measure.reset(); setTool('select') } }],
          [
            { type: 'toggle', icon: 'measure', label: appConfig.copy.measure.modeLine, on: measure.mode === 'line', onClick: () => measure.setMode('line') },
            { type: 'toggle', icon: 'area', label: appConfig.copy.measure.modeArea, on: measure.mode === 'area', onClick: () => measure.setMode('area') },
          ],
          [{ type: 'action', icon: 'trash', label: appConfig.copy.measure.clear, disabled: !measure.path.length, onClick: () => measure.setPath(() => []) }],
          [{ type: 'info', text: appConfig.copy.dockHints.measure }],
        ]} />
      )}
      {mapUI && tool === 'shape' && pendingShape && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setPendingShape(null); setRotStart(null); setTool('select') } }],
          [{ type: 'glyph', node: <ShapeGlyph kind={pendingShape} color="#fff" aspect={SHAPE_DEFS[pendingShape].defaultAspect} fit /> }],
          // a two-point shape is placed by naming two places, so «mehrere nacheinander» has no
          // meaning for it — the lock row is simply not offered
          ...(SHAPE_TWO_POINT[pendingShape] ? [] : [[{ type: 'toggle' as const, icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }]]),
          // …and the hint says which of the two taps is due
          [{ type: 'info', text: !SHAPE_TWO_POINT[pendingShape] ? appConfig.copy.dockHints.shape
            : rotStart ? appConfig.copy.dockHints.rotationEnd : appConfig.copy.dockHints.rotationStart }],
        ]} />
      )}
      {mapUI && tool === 'measure' && (
        <MeasurePanel mode={measure.mode} coords={measure.path} profile={measure.profile} profileLoading={measure.loading}
          // «Als Linie/Fläche übernehmen»: the measured points become a real line resp. Fläche
          // (createLine/createArea drop into Select with it active, so its editor opens straight
          // away). Hidden on a locked surface — there, Messen is a question the EL may ask, not a
          // way to draw — and while the measurement is still too short to be one.
          onAdopt={!tacticalLocked && measure.path.length >= (measure.mode === 'line' ? 2 : 3)
            ? () => {
              const coords = measure.path
              measure.reset()
              if (measure.mode === 'line') createLine(coords)
              else createArea(coords)
            }
            : undefined} />
      )}

      {/* the Verlauf drawer now docks INBOARD of this rail (see .journal-drawer /
          .journal-scrim), so the rail — and its pinned zoom/fit footer — stays put
          instead of being buried + replaced by a floating cluster. */}
      {/* the rail is the SAME object for everyone — a locked surface just gets the slim tool set
          (map: Auswahl · Messen; plan: Auswahl), in the same place, with the same footer. Replay is the exception:
          its scrubber owns the bottom band that the Messen readout would land in. */}
      {mapUI && !replayActive && (
        <ToolRail
          labels={railLabels}
          className="tool-rail"
          primary={appConfig.copy.primarySymbol}
          tools={tacticalLocked ? slimMapTools : appConfig.copy.mapTools}
          extras={sucheRailButton}
          /* ⚠️ the armed tool, and nothing else. This used to read
             `voice.recording ? 'audio' : tool`, but there is no 'audio' entry in `mapTools` — so
             starting a Sprachnotiz matched nothing and the armed tool went DARK mid-recording, on
             the surface where «was macht mein nächster Tipp» is the whole question. Recording is
             already stated where it is started: the TopBar +Eintrag button, and the FabEntry on a
             phone. */
          active={tool}
          onPick={pick}
          footer={(() => {
            const c = appConfig.copy.nav
            return (
              <>
                {/* Ebenen — PINNED so it never scrolls out of reach on short iPads; the
                    Basiskarte choice lives inside its panel (the BaseSwitcher popover and
                    the standalone Koordinaten button are folded away — coords is a row in
                    the compass menu now, testing feedback 2026-07-14) */}
                <button className={`vrail-nbtn vrail-layers ${panel === 'layers' ? 'on' : ''}`} title={appConfig.copy.panels.layers} aria-label={appConfig.copy.panels.layers} aria-pressed={panel === 'layers'} onClick={() => togglePanel('layers')}><span className="vrail-glyph"><Icon id="layers" /></span><span className="vrail-label">{appConfig.copy.panels.layers}</span></button>
                {/* multi-purpose compass: always shown, rotates to the live bearing, and opens the
                    saved-views menu (Nach Norden · Einpassen · Standort · Koordinaten · saved
                    framings · Ansicht speichern). */}
                <MapViewsButton api={viewsApi} bearing={view.bearing} readOnly={readOnly} variant="rail" btnClassName="vrail-nbtn vrail-views" activeClassName="on" glyphClassName="vrail-compass" label={appConfig.copy.mapViews.title} open={viewsOpen && !(sharePick && shareParent === 'views')} onOpenChange={toggleViews} coordsOn={coord.mode !== 'off'} onToggleCoords={coord.cycle} />
                {/* zoom ±: desktop only (.vrail-zoom is hidden under 1024px). Every touch form
                    factor pinches, and on a tablet the two buttons cost rail space that the
                    tools above need more. */}
                <button className="vrail-nbtn vrail-zoom" title={c.zoomOut} aria-label={c.zoomOut} onClick={() => mapRef.current?.zoomOut()}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{c.zoomOut}</span></button>
                <button className="vrail-nbtn vrail-zoom" title={c.zoomIn} aria-label={c.zoomIn} onClick={() => mapRef.current?.zoomIn()}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{c.zoomIn}</span></button>
              </>
            )
          })()}
        />
      )}

      {mapUI && paletteOpen && sym.ready && (
        <Palette
          sym={sym}
          onPick={(name) => { setTool('symbol'); setPending(name); setPaletteOpen(false) }}
          onPickShape={pickShape}
          // PHONE: Linie · Fläche · Absperrkreis · Notiz · Trupp are the sheet's first section
          // there, because they have left the bar for it (lib/toolFold). `pick` closes the sheet.
          tools={appConfig.copy.mapTools}
          onPickTool={pick}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* map Team tool — «Welcher Trupp?» picker over the tapped spot; the SAME picker
          (markup + classes) the plan's Team tool shows, kept in lockstep. A tracked Trupp
          routes through placeTruppOnMap (one-place rule); «Neues Team» drops an untracked
          marker. One-shot: after placing, drop back to Auswahl with the marker selected. */}
      {mapUI && teamPick && (
        /* ⚠️ Modal → lib/overlays, in lockstep with the plan's twin: focus trap + restore,
           scroll-lock, Esc and backdrop dismissal. The hand-rolled scrim both used to share had
           none of them. (AGENTS.md's hand-rolled carve-out is the NON-modal tool docks.) */
        <Overlay
          open
          onClose={() => { setTeamPick(null); setTool('select') }}
          className="wb-trupp-pick ui-dialog"
          ariaLabel={appConfig.copy.whiteboard.selectTrupp}
        >
          <div className="wb-trupp-pick-head">{appConfig.copy.whiteboard.selectTrupp}</div>
          {/* A Trupp lives at exactly ONE place, so picking one that is already on the map
              does not add a second marker — it MOVES the existing one, silently, and the
              operator who wanted a second Trupp has just relocated the first. Placed ones
              are greyed out and say where they are instead. A Trupp on a PLAN stays
              selectable: moving it to the map is a real thing to want.
              ⚠️ A Trupp that is OUT is offered too (05.09.). It used to be filtered away, which
              meant the crew standing at the vehicle — the one about to go back in, the one whose
              position somebody is asking about — was the one name the picker refused to show. It
              carries its «Draussen» so the choice is made knowingly; placing a marker changes no
              clock (lib/placedTrupps · the join doctrine). */}
          {trupps.map((t) => {
            const here = !!t.entityId
            return (
              <button
                key={t.id} className={`wb-trupp-opt${here ? ' placed' : ''}`} disabled={here}
                onClick={() => { placeTruppOnMap(t.id, teamPick); setTeamPick(null); setTool('select') }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {/* «AS» — see the plan's twin of this picker (Whiteboard · wb-trupp-as) */}
                {isAtemschutzTrupp(t) && <span className="wb-trupp-as" title={appConfig.copy.atemschutz.kindAtemschutz}>{appConfig.copy.atemschutz.asMark}</span>}
                {here
                  ? <i>{appConfig.copy.whiteboard.truppPlacedHere}</i>
                  : t.status === 'raus' ? <i>{appConfig.copy.atemschutz.status.raus}</i>
                  : t.lineNumber ? <i>Ltg {t.lineNumber}</i> : null}
              </button>
            )
          })}
          <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeGenericTeam(teamPick); setTeamPick(null); setTool('select') }}>
            <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
          </button>
        </Overlay>
      )}

      {/* like the map: mounted once the pack has loaded OR failed for good (empty glyph table) */}
      {mode === 'plans' && (sym.ready || sym.error) && guarded('board', (
        /* the chunk is prefetched on idle (loadWhiteboard); on the rare cold switch the fallback is
           the board's own empty paper, never a spinner */
        <Suspense fallback={<div className="whiteboard" aria-hidden />}><Whiteboard
          railLabels={railLabels}
          plans={planDocs}
          // on desktop the Verlauf drawer docks beside the plan's tool rail (same as the
          // map), so the rail + its zoom/fit footer stay live. Only a phone still parks
          // the plan read-only while Verlauf is open (there it's a full-width bottom sheet).
          readOnly={tacticalLocked || (isPhone && journalOpen)}
          // …but a locked plan still offers the tool that changes nothing (Auswahl; the plan
          // lost Messen 29.08.). Not during replay (the scrubber owns the bottom band) and not
          // behind the phone's Verlauf sheet, which parks the plan entirely.
          slimTools={!replayActive && !(isPhone && journalOpen)}
          // Einsatz-Link session: the bottom-left setting chips (Maßstab / Verknüpft) are the
          // ORIGIN's instruments — an outside viewer can set nothing, so no doors to settings.
          linkViewer={linkScoped}
          activeId={activePlanId}
          // which object's plans these are — named on the Plan surface itself (it decides what
          // the rail lists). A link session is bound to one object, so it gets no switch.
          objectName={activeObjectName}
          objectAddress={activeObjectAddress}
          // only the AUTO-surfaced object can be «merely nearby»; a manual pick is the operator's
          objectNearby={activeObjectNearby}
          incidentId={incidentMeta.id}
          incidentAddress={incidentMeta.address}
          // the anchor «Automatisch ausrichten» fetches its OSM reference box around: the active
          // object's own coordinate, else the Einsatzort (they coincide for a near object)
          georefAnchor={activeObjectPos ?? incidentView.center}
          onObjectSwitch={linkScoped ? undefined : () => setPickerOpen(true)}
          // A georeferenced Modul has the Karte's real scale, so its tactical symbols follow the
          // Karte setting too. Standalone sheets keep the independent Modul preference.
          symMul={planSymbolScale(symbolScale, !!activeLinkedPlan)}
          captionMode={symbolCaptions}
          mapSuppressedCaptions={mapSuppressedCaptions}
          // …and the half of the Karte that is NOT a record: the live feed, drawn on the paper
          // and editable only in the one way it is on the Karte — a dropped Fahrzeug is «hier
          // ist es wirklich». Everything else the Karte holds arrives in `annos` as an object.
          live={planLive}
          onPlanLiveMove={tacticalLocked ? undefined : moveLiveOnSheet}
          onPlanProjection={showPlanSourceOnMap}
          /* ⚠️ REPLAY shows the recorded sheet and nothing else. `replayBoard` is the anno list as
             it was written down, so a plan-drawn object appears exactly as it was — but a Karte
             object standing beside it does NOT, because its place on this paper is derived and
             the derivation would use TODAY's fit on yesterday's record. Absent is the honest
             answer until replay carries the projection it was recorded with (phase 4). */
          annos={(replayActive ? replayBoard : board)?.[activePlanId] ?? []}
          /* ⚠️ Not during replay: a ghost trail is today's record of a removal, and the replayed
             sheet is what was on the screen at the recorded moment (lib/replay stays VIEW-based). */
          ghostTrails={replayActive ? [] : planGhostTrails(trails, activePlanId)}
          onGhostTrail={tacticalLocked ? undefined : (id) => void deleteGhostTrail(id)}
          // «Marker und Spur löschen» on a chip: arm the ghosting to write it already deleted
          onTrailDrop={tacticalLocked ? undefined : armTrailDrop}
          onChange={(next, opts) => { if (tacticalLocked) return; setBoard((b) => ({ ...b, [activePlanId]: next }), opts) }}
          building={replayActive ? replayBuilding : building}
          floorPack={floorPack}
          onSelectBuilding={async (src, orientDeg, geo) => {
            // Picking new footprint(s) changes the building under the floor-stack — usually an
            // AMENDMENT (a Nebengebäude added, a wrong footprint dropped), not a fresh start.
            //
            // The markings come along, because they are carried THROUGH THE GROUND: each one
            // goes old tile frame → world position → new tile frame (lib/buildingTransfer ·
            // amendBuilding), so a Brandherd keeps the spot it marks on the earth rather than
            // the spot it occupied in the old rectangle. The storeys come along too — otherwise
            // everything above the ground floor is homeless the moment the new stack starts
            // at [0]. What lands off the new sheet is DROPPED and counted, never clamped: a
            // Trupp pinned to a wall it is not at reads as knowledge, not as a guess.
            //
            // ⚠️ A building picked before `BuildingDoc.geo` existed carries no ground position,
            // so nothing can be anchored and the old rule still holds for it: the markings go,
            // counted and named. Never guessed, never quietly — and the undo is one tap away
            // either way.
            if (!src.length) return
            // ⚠️ Only the stack's OWN ink is carried (24.09.2026). Its view also holds the Karte's
            // objects projected onto it, and those are not the stack's to re-anchor: their ground
            // position is their truth, and the new stack's fit projects them afresh. Carried
            // through the amend they came back «moved» — measured against the fit of the building
            // being replaced, the store has not seen the new one yet — and either flipped onto the
            // stack or, as a machine write, moved on the ground.
            const ownIds = sheetAnchoredIds(objects, 'gebaeude')
            const prevGebaeude = (board.gebaeude ?? []).filter((a) => ownIds.has(a.id))
            const markCount = prevGebaeude.length
            const prevBuilding = building
            const amend = amendBuilding(prevBuilding, { src, orientDeg, geo }, prevGebaeude)
            const owned = new Set([...ownIds, ...amend.annos.map((a) => a.id)])
            const hasWork = !!building && (markCount > 0 || building.floors.length > 1)
            const wb = appConfig.copy.whiteboard
            if (hasWork) {
              const message = amend.legacy
                ? (markCount > 0 ? fillTemplate(wb.replaceBuildingConfirmMarks, { n: markCount }) : wb.replaceBuildingConfirm)
                : amend.dropped > 0 ? fillTemplate(wb.replaceBuildingConfirmCarryDrop, { n: amend.carried, d: amend.dropped })
                : markCount > 0 ? fillTemplate(wb.replaceBuildingConfirmCarry, { n: amend.carried })
                : wb.replaceBuildingConfirmKeep
              const ok = await confirmDialog({
                title: wb.replaceBuilding, message,
                confirmLabel: wb.replaceBuilding, cancelLabel: appConfig.copy.cancel,
                // only a loss is a red button — an amendment that carries everything is not one
                danger: amend.legacy ? markCount > 0 : amend.dropped > 0,
              })
              if (!ok) return
            }
            // auto-orient to longest-axis-horizontal by default; rings/ring/ringAspect
            // mirror the active (oriented) view for back-compat renderers + the north arrow
            const view = buildView(src, orientDeg)
            // a FRESH stack takes its storeys and names from the object's floor pack (decided
            // 14.09.2026); an amendment keeps what the operator already has
            const pack = prevBuilding ? null : floorPackOf(planBindings, activeObjectId)
            const floors = pack?.floors.length ? packStoreys(pack.floors) : amend.floors
            const floorNames = pack ? packFloorNames(pack.floors) : prevBuilding?.floorNames
            const nextBuilding: BuildingDoc = { src, orientDeg, geo, northUp: false, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect, floors, ...(floorNames && Object.keys(floorNames).length ? { floorNames } : {}) }
            setBuilding(nextBuilding)
            // a machine write (`gesture: false`): the amend re-anchors ink, nobody placed it
            setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, amend.annos) }), { gesture: false })
            setActivePlanId('gebaeude') // auto-jump to the floor-stack
            if (hasWork) {
              // confirm-with-undo: the previous stack (floors + markings) is restorable in place,
              // and the toast repeats the counts — «Gebäude ersetzt» alone never said what happened.
              const line = amend.legacy
                ? (markCount > 0 ? fillTemplate(wb.buildingReplacedMarks, { n: markCount }) : wb.buildingReplaced)
                : amend.dropped > 0 ? fillTemplate(wb.buildingReplacedCarriedDropped, { n: amend.carried, d: amend.dropped })
                : markCount > 0 ? fillTemplate(wb.buildingReplacedCarried, { n: amend.carried })
                : wb.buildingReplacedKept
              const restore = () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, prevGebaeude) }), { gesture: false }) }
              const reapply = () => { setBuilding(nextBuilding); setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, amend.annos) }), { gesture: false }) }
              const drop = rememberGebaeudeStep(line, restore, reapply)
              undoToast(line, () => { restore(); drop() })
            }
          }}
          // the two faces of the ONE «Gebäude» rail tile. Both plan ids stay real documents —
          // this only moves the active one, which is what makes the merged tile navigable at all
          // (railPlanTiles reads activePlanId to decide which face the tile wears).
          onBuildingFace={(face) => setActivePlanId(face === 'pick' ? BUILDING_PICK_ID : gebaeudeDoc.id)}
          onReorient={(next) => {
            // The Drehung is a SLIDER with a live preview, so it writes many times per drag: one
            // burst is one step, and the step goes back to the angle the drag started from — the
            // same fold the Bildlegende uses, for the same reason. It matters beyond the screen,
            // because the printed Geschossseiten come out at whatever angle is set.
            const now = Date.now()
            const prev = lastReorient.current
            const folding = !!prev && now - prev.at <= REORIENT_FOLD_MS
            const from = folding ? prev.from : building
            if (folding) prev.drop()
            setBuilding(next)
            if (!from) return
            const drop = rememberGebaeudeStep(appConfig.copy.whiteboard.orientMenuTitle, () => setBuilding(from), () => setBuilding(next))
            lastReorient.current = { at: now, from, drop }
          }}
          onAddFloor={(dir) => {
            if (!building || building.pack) return
            const prevBuilding = building
            const newFloor = dir > 0 ? Math.max(...building.floors) + 1 : Math.min(...building.floors) - 1
            const nextBuilding = { ...prevBuilding, floors: dir > 0 ? [...prevBuilding.floors, newFloor] : [newFloor, ...prevBuilding.floors] }
            setBuilding(nextBuilding)
            // confirm-with-undo (standing rule): the undo also sweeps any annotation already
            // dropped on the brand-new storey so nothing orphans — the stack's OWN only
            // (24.09.2026): a Karte object shown on the new storey is the Karte's, and dropped from
            // the view it was deleted outright (see onRemoveFloor)
            const restore = () => {
              setBuilding(prevBuilding)
              setBoard((b) => ({ ...b, gebaeude: withoutOwnOnStorey(b.gebaeude ?? [], sheetAnchoredIds(objectsRef.current, 'gebaeude'), newFloor) }), { gesture: false })
            }
            const drop = rememberGebaeudeStep(appConfig.copy.whiteboard.floorAdded, restore, () => setBuilding(nextBuilding))
            undoToast(appConfig.copy.whiteboard.floorAdded, () => { restore(); drop() })
          }}
          onRemoveFloor={async (floor) => {
            if (building?.pack || floorPack?.tiles[floor]) return
            const prevBuilding = building
            const nextBuilding = prevBuilding ? { ...prevBuilding, floors: prevBuilding.floors.filter((f) => f !== floor) } : prevBuilding
            // ⚠️ Only the stack's OWN annos are swept (24.09.2026). The view also shows the Karte's
            // objects projected onto their storey, and those are not the storey's: handed back
            // untouched (`withOwnAnnos`) they fold to nothing, stay on the Karte, and simply find no
            // tile once the storey is gone. The sweep used to run over the whole view — and an
            // absent anno is a deletion, so every Karte Fahrzeug shown on the storey went with it.
            // ⚠️ Computed HERE, as values the closures keep: the timeline's ↷ has to put back
            // exactly the stack this removal produced, not re-run a sweep against a document that
            // has moved on since.
            const sweep = removeStorey(board.gebaeude ?? [], sheetAnchoredIds(objects, 'gebaeude'), floor, nextBuilding?.floors ?? [])
            // asks only about what the sweep LOSES — own annos deleted or cut short, never a Karte
            // object shown here — and not at all when that is nothing; the toast undoes either way
            if (!await askStoreyRemoval(sweep.lost, floorLabel(floor))) return
            // a machine write (`gesture: false`) — a sweep of what stood on the storey, no placement
            const writeOwn = (own: BoardAnno[]) => setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, sweep.owned, own) }), { gesture: false })
            setBuilding(nextBuilding)
            writeOwn(sweep.after)
            // confirm-with-undo: the removed storey's annotations come back with it
            const restore = () => { setBuilding(prevBuilding); writeOwn(sweep.before) }
            const reapply = () => { setBuilding(nextBuilding); writeOwn(sweep.after) }
            const drop = rememberGebaeudeStep(appConfig.copy.whiteboard.floorRemoved, restore, reapply)
            undoToast(appConfig.copy.whiteboard.floorRemoved, () => { restore(); drop() })
          }}
          sym={sym}
          rosterNames={rosterNames}
          rosterRank={rosterRank}
          onRosterField={(symbol, label, key, name) => linkRosterFields({ symbol, label } as Entity, { [key]: name })}
          // the same two roster read-outs the Lage's symbol panel has shown all along: who that
          // name already is ON the dropdown entry, and the contradiction a filled field carries
          // UNDER it. A plan symbol is not an Entity, so the hint call is fed its parts.
          personStatus={personStatus}
          fieldHints={(symbol, label, fields) => rosterFieldHints({ kind: 'symbol', symbol, label, fields } as Entity)}
          // Symbol→Mittel on the plan, with the Lage's exact gate and the shared count: a TLF
          // placed on Modul 1 books onto the Material sheet like one placed on the Karte
          onRecent={addRecent}
          log={logPlan}
          emit={emit}
          historyRef={planHist}
          hist={planHistory}
          setHist={setPlanHistory}
          onCheckpoint={rememberPlanStep}
          onStepEnd={endSheetStep}
          views={planViews}
          fitRef={planFit}
          keysRef={planKeys}
          focus={planFocus}
          // the Suche docked beside the stack takes its width off the fit (tablet only), and the
          // storey labels carry its progress («1. OG 2/4»)
          dockInset={sucheSurfaceOn && !isPhone ? SUCHE_DOCK_INSET : 0}
          storeyBadges={sucheBadges}
          railExtras={sucheRailButton}
          trupps={effTrupps}
          // the Karte's markers and the other plans' chips, for the one Trupp counter
          placedTeamNames={() => [
            ...entities.filter((e) => e.kind === 'team').map((e) => e.label),
            ...Object.values(board).flat().filter((a) => a.kind === 'resource').map((a) => a.text),
          ]}
          truppSeverities={azAlarm.severities}
          // the plan's Trupp tool placed a chip FOR a Trupp — same ask as every other placement:
          // the picture now says the crew is there, so «einrücken?» belongs here (askTruppEntry)
          onLinkTrupp={(annoId, truppId) => { updateTrupp(truppId, { annoId, planId: activePlanId }); void askTruppEntry(truppId) }}
          // …and the chip's half of the join, joined from the picture rather than from the card —
          // the identical wiring the map marker's menu gets, through the identical action, so the
          // takeover confirm and the «einrücken?» ask exist exactly once for both surfaces
          onTeamTrupp={tacticalLocked ? undefined : (annoId, truppId) => {
            if (truppId) void adoptTruppMarker(truppId, annoId)
            else releaseTruppMarker(annoId)
          }}
          onTeamNewTrupp={tacticalLocked ? undefined : newTruppFromMarker}
          onLinkLineTrupp={(annoId, truppId) => (truppId ? linkTruppLine(truppId, annoId) : unlinkLine(annoId))}
          // a Leitung end snapped onto a Trupp's chip IS the Leitung pick (15.09.) — the same
          // call the Karte makes from its own magnet (lib/useMapDrawing · onLineAttached)
          onLineAttached={(annoId, attachment) => { linkLineToAttachedTrupp(annoId, attachment) }}
          onLineDetached={(annoId, previous) => { unlinkLineFromDetachedTrupp(annoId, previous) }}
          onLineRenumber={syncLineNoToTrupp}
          // the plan chip's twin of the map marker's jump — it points at the card too
          onShowTrupp={(truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) }}
          planScale={planScale}
          onCalibrate={(planId, sc) => { if (tacticalLocked) return; setPlanScale((m) => { if (!sc) { const { [planId]: _drop, ...rest } = m; return rest } return { ...m, [planId]: sc } }) }}
        /></Suspense>
      ))}

      {pickerOpen && (
        <PlanPicker
          center={incidentView.center}
          activeObjectId={manualObject?.id ?? null}
          onSelect={pickObject}
          onReset={manualObject ? resetObject : undefined}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {mode === 'checklists' && guarded('checklists', (
        <ChecklistsView
          checklists={checklists}
          canTick={canTick}
          divera={{ title: incidentMeta.title, type: incidentMeta.type ?? undefined }}
          onTick={toggleTick}
          onBranch={setBranch}
          onAction={checklistAction}
        />
      ))}

      {mode === 'atemschutz' && guarded('atemschutz', atemschutzBoard)}

      {mode === 'anwesenheit' && guarded('anwesenheit', anwesenheitSurface)}

      {mode === 'mittel' && guarded('mittel', mittelSurface)}

      {/* the Suche (24.09.2026): docked beside the Gebäude or the Karte on a tablet, a peek · half ·
          full sheet over them on a phone — standing on the nav bar, never over it */}
      {sucheSurfaceOn && guarded('suche', isPhone ? (
        <SuchePhoneSheet {...suchePanelProps} onClose={() => setSucheOpen(false)}
          detent={sucheDetent} onDetent={setSucheDetent}
          surface={mode === 'plans' && activePlanId === stackPlanId ? 'gebaeude' : 'karte'}
          onSurface={sucheSurface} hasGebaeude={sucheHasGebaeude} />
      ) : (
        <SucheDock {...suchePanelProps} onClose={() => setSucheOpen(false)} />
      ), false)}

      {/* time-travel replay scrubber — read-only past view, owns the playhead + fold */}
      {replayActive && (
        <ReplayBar
          incidentId={incidentMeta.id}
          startedAt={incidentMeta.started_at}
          onState={onReplayState}
          onVehicles={onReplayVehicles}
          onExit={exitReplay}
          journal={timeline}
          onPlayhead={onReplayPlayhead}
          seekRef={replaySeek}
          // «im Verlauf» on the caption: open the drawer and land on that row.
          // ⚠️ Offered only while the Verlauf is CLOSED. The drawer is modal — a full-screen
          // scrim at z-index 60 over a bar at 50 — so with it open the button cannot be reached
          // at all: the click lands on the scrim (which closes the drawer) or, where the drawer
          // itself overlaps the bar, on one of its rows, which during a Wiedergabe seeks. Both
          // read as «the button does nothing». With the Verlauf open it is redundant anyway:
          // every row is right there, the one at the playhead is marked, and tapping any of them
          // moves the moment.
          onShowEntry={journalOpen ? undefined : (rowId) => { setJournalOpen(true); setJournalLandOn({ id: rowId, nonce: Date.now() }) }}
        />
      )}

      {mode === 'rapport' && guarded('rapport', (
        /* onEditDispatch leaves the preflight open so the Einsatzdaten wizard stacks on top
           (later in DOM, same z-index) — canceling it reveals the rapport again instead of a
           dead end. (Saving still remounts the workspace and returns to the map.) */
        <Suspense fallback={<div className="rp-backdrop" aria-hidden />}><ReportPreflight
          incident={incidentMeta}
          reportMeta={reportMeta}
          personnel={pickablePersonnel}
          presentIds={presentIds}
          events={timeline}
          annotatedPlanCount={annotatedPlanCount}
          // ⚠️ `allTrupps`, here and on the `trupps` prop below — the two places that print. A Trupp
          // taken off the Tafel was still under PA, and its readings, entry pressure and times are
          // exactly what the Atemschutz page exists to record (types · Trupp.removedAt).
          // ⚠️ …and PA only: this number decides whether the Atemschutz page is offered at all and
          // is printed in its own toggle («Atemschutz (3)»). A plain work squad never appears on
          // that page (lib/reportPdfDirect), so counting it would offer an empty page on an
          // Einsatz where nobody went under PA.
          truppCount={allTrupps.filter(isAtemschutzTrupp).length}
          attendanceCount={Object.keys(attendance).length}
          mittelCount={mittelLineCount(mittel)}
          mittel={mittel}
          // ⚠️ What counts as «es wurde eine Lage gezeichnet» — and a LIVE vehicle does not.
          // Those entities arrive from GPS on their own, so on a station running Traccar the
          // Kroki was pre-selected on every Einsatz, including ones where nobody drew anything:
          // a page of the printed rapport showing three lorries on an empty map. Only what an
          // operator placed or drew is a reason to print a picture.
          mapContentCount={entities.filter((e) => !e.live).length + drawings.length}
          pendingMediaCount={media.pendingCount}
          attendance={attendance}
          trupps={allTrupps}
          contactIntervalMin={azIntervalMin}
          contactGraceSec={azGraceSec}
          plans={planDocs}
          scene={{ entities, drawings, layers: mapLayers, byName: sym.byName, center: incidentView.center, view: { center: view.center, zoom: view.zoom }, captionMode: symbolCaptions ?? 'auto' }}
          board={board}
          building={effBuilding}
          suche={effSuche}
          captureUsage={captureUsage}
          attachments={attachments}
          onAddAttachments={canEditRecord ? addAttachments : undefined}
          onCaptionAttachment={canEditRecord ? captionAttachment : undefined}
          onRemoveAttachment={canEditRecord ? removeAttachment : undefined}
          canEdit={canEditRecord}
          onRolePicked={assignRole}
          // the Einsatzleiter / Rückmeldung pickers: a typed name is a Gast, so the EL named on
          // the front page of the rapport is on the Anwesenheit behind it even for a Nachbarwehr
          onAddGuest={canEditRecord ? assignTypedName : undefined}
          onSaveMeta={saveReportMeta}
          // dispatch data + Abschluss stay incident-level: PATCH /incidents is editor-only,
          // and archiving an Einsatz is not record-keeping (the el role reads both).
          onEditDispatch={canEditMeta ? onEditMeta : undefined}
          onOpenAnwesenheit={() => { setMode('anwesenheit'); setRapportReturn(true) }}
          onOpenMittel={() => { setMode('mittel'); setRapportReturn(true) }}
          onResolveConflict={canWriteRecord ? resolveAttendanceConflict : undefined}
          // Do NOT close the sheet here. On the real path the completion switches the active
          // Einsatz and this whole workspace unmounts, so closing it is redundant; on the demo
          // (and on any refusal) `completeRapport` returns early with a toast — and the sheet
          // had already been shut, so the operator lost their place for an action that never
          // happened. The «Abschliessen» confirm closes itself; that is the only thing that should.
          // ⚠️ The confirm (and the media flush that follows it) lives in `confirmAndComplete`
          // above, shared with the Einsatz-Menü row — one action, one dialog, one wording.
          onComplete={canEditIncident && !readOnly ? confirmAndComplete : undefined}
          onFixTranscripts={() => { setJournalOpen(true); setJournalFromRapport(true) }}
        /></Suspense>
      ))}
      {/* unified Verlauf + quick-add — rendered app-level so both open over either surface,
          and AFTER the Rapport sheet so its checklist row can stack the Verlauf on top */}
      {journalOpen && guarded('journal', (
        <Journal
          deliveryNotice={<JournalDeliveryNotice
            status={combinedSyncStatus(journal.syncStatus, auditDelivery.status)}
            count={journal.pendingCount + journal.rejectedCount + auditDelivery.pendingCount + auditDelivery.rejectedCount}
            refused={auditDelivery.refusedCount}
            onRetry={async () => { await Promise.all([journal.retry(), auditDelivery.retry()]) }}
            onExport={() => downloadBlob(new Blob([JSON.stringify({ ...journal.recoveryData(), audit: auditDelivery.getRecoveryData() }, null, 2)], { type: 'application/json' }), `verlauf-${incidentMeta.id}.json`)}
          />}
          vocab={journalVocab}
          events={timeline}
          closedAt={incidentMeta.closed_at}
          plans={planDocs}
          onSelect={focusEvent}
          replayAtMs={replayActive ? replayAtMs : null}
          onSeekTo={replayActive ? seekToEvent : undefined}
          landOn={journalLandOn}
          // ⚠️ The landing is CONSUMED on close. The drawer remounts every time it opens, so the
          // «already landed» guard inside it resets — and a stale `landOn` left lying around
          // meant the next ordinary open (TopBar, checklist, Rapport) silently jumped to
          // whatever row the Wiedergabe caption had pointed at, possibly hours ago.
          onClose={() => { setJournalOpen(false); setJournalLandOn(null); if (journalFromRapport) { setJournalFromRapport(false); openRapport() } }}
          onTranscript={!readOnly ? (id, transcript) => journal.appendPatch(id, { transcript: transcript.trim() }) : undefined}
          onReplay={!replayActive ? () => { setJournalOpen(false); enterReplay() } : undefined}
          openReminders={reminders.open}
          onReminderDone={!readOnly ? reminders.markDone : undefined}
          // tap a Pendenz → write a Meldung on it. The Verlauf steps aside so the composer is
          // not stacked on a drawer the operator can no longer see behind it.
          // ⚠️ The Verlauf STAYS OPEN behind it. Closing it meant that finishing a Meldung — or
          // thinking better of it — dropped you back onto the map, away from the list you were
          // working through; and at a Lagerapport you write several in a row. The composer is a
          // modal above the drawer (z 81 over 61), so nothing is lost behind it.
          onReminderNote={!readOnly ? (r) => {
            setNoteOn({ id: r.id, text: r.text })
            setComposerOpen(true)
          } : undefined}
          onReminderAgain={!readOnly && !replayActive ? reRaisePendenz : undefined}
          mediaStatusOf={media.statusOf}
          onOpenPlayer={(e, seekSec) => setPlayer({ row: e, seekSec })}
          onEditText={!readOnly ? (id, text) => journal.appendPatch(id, { textEdit: text }) : undefined}
        />
      ))}
      {player && (
        <AudioPlayerSheet
          row={player.row}
          events={timeline}
          readOnly={readOnly}
          initialSeekSec={player.seekSec}
          // the same vocabulary the composer gets — «Eintrag an dieser Stelle» writes into the
          // same Verlauf, so it completes and marks names identically
          vocab={journalVocab}
          onAddEntry={!readOnly ? addPlayerEntry : undefined}
          // a voice memo's words land on the memo itself, as a transcript section at the
          // playhead — appended like every enrichment, never edited in place
          onAddSection={!readOnly ? (atSec, text) => {
            journal.appendPatch(player.row.id, { transcriptSection: { at: atSec, text } })
            toast(appConfig.copy.journal.saved, { icon: 'type', tone: 'success' })
          } : undefined}
          // fixing a section replaces its words in place ('' removes it) — the recording is
          // the original, so no «korrigiert» mark and no new Verlauf line
          onEditSection={!readOnly ? (sectionId, text) => journal.appendPatch(player.row.id, { transcriptSectionEdit: { id: sectionId, text } }) : undefined}
          onPatchEntry={!readOnly ? (rowId, text) => journal.appendPatch(rowId, { textEdit: text }) : undefined}
          onRetractEntry={!readOnly ? (rowId) => {
            journal.appendPatch(rowId, { retracted: true })
            toast(appConfig.copy.journal.entryRemoved, {
              icon: 'trash', tone: 'default',
              action: { label: appConfig.copy.undo, onClick: () => journal.appendPatch(rowId, { retracted: false }) },
            })
          } : undefined}
          onClose={() => setPlayer(null)}
        />
      )}
      {composerOpen && (
        <JournalComposer
          // everything this Einsatz has words for — Mannschaft, Mittel, Partnerorganisationen,
          // Fahrzeuge, Alarmgruppen. Typing three letters of any of them completes it.
          vocab={journalVocab}
          // …and this Einsatz's own rows, so the chips offered on an empty field are the phrases
          // that are actually being used tonight (lib/startChips)
          timeline={timeline}
          onSubmit={addJournal}
          onClose={() => { setComposerOpen(false); setNoteOn(null); setSucheLink(null) }}
          noteOn={noteOn ?? undefined}
          onClearNote={() => setNoteOn(null)}
          // …and the same list the Verlauf pins, so an entry being written can be attached to an
          // open item without going through the Verlauf at all — the sheet offers the ones the
          // sentence already names, and holds a picker for the rest.
          openPendenzen={reminders.open.map((r) => ({ id: r.id, text: r.text, urgent: !!r.urgent }))}
          onLinkPendenz={(pdz) => setNoteOn(pdz)}
          // Tür 2: a sentence naming somebody missing can find them on its way (editor only)
          suchePersonen={canEditSuche ? personenViews(suche) : undefined}
          sucheLink={sucheLink}
          onSucheLink={setSucheLink}
          incidentStartAt={incidentMeta.started_at}
          uploadAudio={(blob, filename) => uploadMedia(incidentMeta.id, blob, 'audio', filename)}
          // generic Beilagen (PDF & Co.) ride the same endpoint under kind 'file' — the server
          // hands those back as a download, never inline (backend/app/api/media.py)
          uploadFile={(blob, filename) => uploadMedia(incidentMeta.id, blob, 'file', filename)}
        />
      )}
      {sharePick && (
        <SharePositionSheet
          roster={personnel}
          pickOnly={sharePick === 'pick'}
          lastPersonId={share.pref?.personId ?? null}
          // «Neuer Einsatz» rather than «Namen ändern»: the question is back because this
          // Einsatz has not been confirmed yet, and the sheet says so instead of looking like
          // the app forgot.
          reconfirm={!share.confirmed}
          onPick={(id, displayName) => {
            share.start({ id, displayName })
            setSharePick(null)
            if (shareParent === 'views') setViewsOpen(false)
            shareStatusRestore.current = null
            setShareParent(null)
          }}
          onClose={() => {
            setSharePick(null)
            if (shareParent === 'status') shareStatusRestore.current?.()
            shareStatusRestore.current = null
            setShareParent(null)
          }}
        />
      )}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {/* ONE sheet for every «Teilen» door — its own tabs are the chooser (03.09.). `archived`
          drops the Atemschutz tab, which dies with the Einsatz. */}
      {shareLink && (
        <ShareIncidentSheet
          incidentId={incidentMeta.id}
          initialKind={shareLink}
          archived={incidentMeta.is_archived}
          // the QR beside the Atemschutz bell hands over in ONE tap: pressing it IS the
          // decision, so the sheet mints the link rather than asking a second time
          autoCreate={shareLink === 'atemschutz'}
          onClose={() => setShareLink(null)}
          // the Atemschutz header's own button paints its «ein Link läuft» tint from this,
          // so minting or revoking one is reflected the moment the sheet closes
          onState={(k, l) => { if (k === 'atemschutz') setAtemschutzLinkOn(l.enabled) }}
        />
      )}
      {installGuideOpen && <InstallGuide onClose={() => setInstallGuideOpen(false)} />}
      {offlineReadyOpen && (
        <OfflineReadinessSheet
          onClose={() => setOfflineReadyOpen(false)}
          probeUrls={offlineProbeUrls}
          symbolsReady={sym.ready}
          planCount={Object.keys(backendPlans).length}
          objectLabel={manualObject?.name ?? null}
          weatherOk={liveWeather.data != null}
          weatherError={liveWeather.error != null}
          personnelCount={personnel.length}
          syncStatus={syncStatus}
          lastSyncedAt={lastSyncedAt}
          onSyncNow={syncNow}
          onLoadAll={() => { void downloadOffline(); void reloadPersonnel() }}
          onCancel={cancelOffline}
          loading={offlineProgress != null}
          progress={offlineProgress}
        />
      )}
      {settingsOpen && !feedbackOpen && !(sharePick && shareParent === 'settings') && (
        <SettingsSheet
          onClose={() => setSettingsOpen(false)}
          symbolScale={symbolScale}
          onSymbolScale={setSymbolScale}
          symbolCaptions={symbolCaptions}
          onSymbolCaptions={setSymbolCaptions}
          railLabels={railLabels}
          onRailLabels={setRailLabels}
          offlineRadiusM={offlineRadiusM}
          onOfflineRadius={setOfflineRadiusM}
          offlineAuto={offlineAuto}
          onOfflineAuto={setOfflineAuto}
          keepScreenOn={keepScreenOn}
          onKeepScreenOn={setKeepScreenOn}
          themeCoord={incidentMeta.lng != null && incidentMeta.lat != null ? [incidentMeta.lng, incidentMeta.lat] : null}
          elView={elView}
          onElView={isEditor ? setElView : undefined}
          // Rückmeldung posts a diagnostic report — refused for a link session, so don't offer it
          onFeedback={linkScoped ? undefined : () => { setFeedbackParent('settings'); setFeedbackOpen(true) }}
          // Einstellungen holds the PERMISSION only — «dieses Gerät darf meinen Standort
          // verwenden» — never the act. Switching it on opens the sheet (the device has to know
          // whose position it would be reporting); switching it off revokes and stops.
          shareAs={share.ready ? (share.pref?.displayName ?? null) : null}
          onSharePosition={!isDemoMode()
            ? (on) => {
              if (on) {
                setShareParent('settings')
                setSharePick('ask')
              }
              else share.revoke()
            }
            : undefined}
        />
      )}
      {/* Rückmeldung, opened deliberately from Einstellungen. Nothing ever PUSHES this at the
          operator mid-incident — the trouble prompt lives on the launcher (see lib/trouble). */}
      {feedbackOpen && <FeedbackSheet onClose={(reason) => {
        setFeedbackOpen(false)
        if (reason === 'complete' && feedbackParent === 'settings') setSettingsOpen(false)
        setFeedbackParent(null)
      }} />}

      {/* phone field-capture: a editor can't draw tactical symbols on a phone, but can
          always add a journal entry / photo / voice memo from the field — tap to compose,
          hold to record a voice memo (same gesture as the desktop TopBar Eintrag) */}
      {isPhone && !readOnly && !linkScoped && !composerOpen && !panel && (
        <FabEntry
          recording={voice.recording}
          recStartedAt={voice.recStartedAt}
          // the composer opens on its text field WITH the keyboard: on a phone the entry is typed
          // far more often than it is tapped together. ⚠️ flushSync, so the sheet commits INSIDE
          // this click and its textarea focuses itself in the same call stack (JournalComposer ·
          // focusedOnAttach) – React otherwise commits a microtask later, and iOS gives a focus
          // made outside the tap a caret and no keys. primeKeyboard is the belt to that brace.
          onTap={() => { primeKeyboard(); flushSync(() => setComposerOpen(true)) }}
          onHoldStart={startVoiceMemo}
          onHoldStop={voice.stop}
          onHoldPhoto={startQuickPhoto}
        />
      )}

      {/* the camera behind the hold gesture's «Foto» target — one input for both the TopBar
          button and the phone FAB, so there is exactly one quick-photo path.
          ⚠️ `.file-picker`, not `hidden`: iOS never opens a picker for a display:none input
          (see 02-base.css) — that is the whole reason this target did nothing on a phone. */}
      {!readOnly && !linkScoped && (
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" multiple
          className="file-picker" tabIndex={-1} onChange={onQuickPhotoPicked} />
      )}

      {/* «Karte verknüpfen» runs ACROSS surfaces (Plan ⇄ Karte), so its instruction and action
          bars belong to the shell rather than to either one — on a phone the Plan is unmounted
          for the map half of every pair. Renders nothing while the mode is off. */}
      <GeorefModeBars planLabel={planDocs.find((p) => p.id === georefMode.planId)?.code} />
    </div>
  )
}
