import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { SharePositionPill, SharePositionSheet } from './components/SharePosition'
import { autoActivateLayers, deriveInitial, sanitizeWorkspace, WORKSPACE_SCHEMA_VERSION, type Doc, type ReportMeta, type Saved, type WorkspaceGate } from './lib/workspace'
import { useReplay } from './lib/useReplay'
import { resolveHotkey, isTypingTarget } from './lib/hotkeys'
import { moduleNumbers } from './lib/navRail'
import { incident as demoIncident, planDocuments, gebaeudeDoc, preparedOverlays } from './data/demoIncident'
import type { BoardAnno, CameraView, Drawing, Entity, Incident, LayerDef, LayerId, LineEndpoint, LngLat, MittelEntry, Person, ReactivateResult, ShapeKind, TimelineEvent, Trupp, TruppFields } from './types'
import { appConfig } from './config/appConfig'
import { clearAllDrafts } from './lib/draftKeep'
import { atemschutzDoctrine, getDeploymentConfig, deploymentDefaultCenter, isDemoMode } from './lib/deploymentConfig'
import { countSurface } from './lib/visitBeacon'
import { fillTemplate, formatSymbolName, formatTime } from './lib/format'
import { formatAudioDuration } from './lib/audioImport'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys, VEHICLE_SYMBOLS } from './lib/symbols'
import { circlePolygon, fmtLV95, fmtWGS, haversineM, pathLengthM, polygonAreaM2 } from './lib/geo'
import { intervalsOf, isPresent, openPresence } from './lib/attendanceIntervals'
import { mergeRoleNote, personStatusHint, roleConflictHint, rosterFieldRole, type AssignableRole } from './lib/roleAssignment'
import { useShiftActions } from './lib/useShiftActions'
import { useBandActions } from './lib/useBandActions'
import { editorPrintTransport, fetchPrintStatus, type PrintRelayStatus } from './lib/printRelay'
import { trackPrintJob } from './lib/printJobToast'
import { buildZeitplanPayload, downloadZeitplanPdf, printZeitplan, type ZeitplanSheet } from './lib/zeitplanPrint'
import { lineLabel } from './lib/lineDecor'
import { isBottomSheet, nudgePointIntoRect, nudgeSelectionIntoRect, rectCenter, visibleWorkRect, type NudgeBox } from './lib/panelNudge'
import { cartoRasterTiles } from './lib/carto'
import { useMeasure } from './lib/useMeasure'
import { useCoordPicker } from './lib/useCoordPicker'
import { useVoiceMemo } from './lib/useVoiceMemo'
import { useUndoableDoc } from './lib/useUndoableDoc'
import { useUndoableSlice } from './lib/useUndoableSlice'
import { useJournal } from './lib/useJournal'
import { useWakeLock } from './lib/useWakeLock'
import { toast, confirmDialog } from './lib/ui'
import { Overlay } from './lib/overlays'
import { apiDelete } from './lib/api'
import { loadPrefs, planSymbolScale, savePrefs } from './lib/prefs'
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
import { buildLabel } from './lib/buildInfo'
import { consumeJustUpdated } from './lib/swUpdate'
import { useIsPhone } from './lib/useIsPhone'
import { useOnline } from './lib/useOnline'
import { MapView } from './components/MapView'
import { Splash } from './components/Splash'
import { TopBar, WeatherBadge } from './components/TopBar'
import { NavRail } from './components/NavRail'
import { MapUtility } from './components/MapUtility'
import { MapViewsButton, type ViewsApi } from './components/MapViewsMenu'
import { LayerPanel } from './components/LayerPanel'
import {
  boardTwinAnnosForPrint, georefPlans, mapContentTwins as projectMapContentTwins, mapTwins as projectMapTwins, mapTwinRows, planAspect, planTwinRows,
  twinPlanImageLayerId, twinPlanImageVisible, twinPlanLayerId, twinVisible, isTwinLayerId, TWIN_MAP_SYMBOLS, TWIN_MAP_VEHICLES,
  boardSymbolToEntity, contentTwinName, entityToBoardSymbol, movedTwinPath, onSheet, planGroundWidthM, revealTwinLayer,
  type MapContentTwin, type MapTwin,
} from './lib/georefTwins'
import { glyphFor, twinName } from './lib/twinGlyph'
import { GeorefTwinPanel } from './components/GeorefTwinPanel'
import { georefForPlan, getStationPlanScales } from './lib/stationPlanScale'
import { effectiveLayer } from './lib/mapView'
import { ToolRail } from './components/ToolRail'
import { slimTools, isMapReadOnlyTool, MAP_READONLY_TOOLS } from './lib/readOnlyTools'
import { Palette } from './components/Palette'
import { ContextPanel } from './components/ContextPanel'
import { DrawEditor } from './components/DrawEditor'
import { ToolDock } from './components/ToolDock'
import { ShapeEditor } from './components/ShapeEditor'
import { MeasurePanel } from './components/MeasurePanel'
import { SHAPE_DEFS, ShapeGlyph } from './lib/shapes'
import { Journal } from './components/Journal'
import { JournalComposer, type JournalDraft } from './components/JournalComposer'
import { composeJournalText } from './lib/journalEntry'
import { journalVocabulary } from './lib/journalLinks'
import { AudioPlayerSheet } from './components/AudioPlayerSheet'
import { ReminderBanner } from './components/ReminderBanner'
import { AtemschutzAlarmMeldungen } from './components/AtemschutzAlarmMeldung'
import { UpdateBanner } from './components/UpdateBanner'
import { InstallBanner } from './components/InstallBanner'
import { InstallGuide } from './components/InstallGuide'
import { getInstallPlatform, isStandalone } from './lib/installPrompt'
import { isStorageDegraded } from './lib/idb'
import { installOffered } from './lib/installPolicy'
import { claimBootNotifyTarget } from './lib/notifyTarget'
import { TabLockBanner } from './components/TabLockBanner'
import { GpsFollowMeldung } from './components/GpsFollowMeldung'
import { useReminders } from './lib/useReminders'
import { useMediaQueue } from './lib/useMediaQueue'
import { AtemschutzAlarmHost } from './lib/useAtemschutzAlarm'
import type { AtemschutzAlarmState } from './lib/atemschutz'
import { ensureNotifyPermission } from './lib/alarm'
import { Whiteboard } from './components/Whiteboard'
import { GeorefModeBars } from './components/GeorefMode'
import { georefDispatch, useGeorefMode, useGeorefStorage, useGeorefSurfaceBridge } from './lib/georefMode'
import { pushBoardPast, type BoardHistory } from './components/useBoardDoc'
import { deleteBoardTwinSource, patchBoardTwinSource } from './lib/georefTwinEdit'
import type { GeorefFit } from './lib/georef'
import type { BoardViews } from './components/useBoardView'
import { ReplayBar } from './components/ReplayBar'
import { FabEntry } from './components/FabEntry'
import { planPreviewUrl, prewarmPlans } from './components/PdfViewport'
import { prefetchOutlines } from './components/OsmOutline'
import { buildView } from './lib/footprint'
import { amendBuilding } from './lib/buildingTransfer'
import { useAuth } from './lib/auth'
import {
  WorkspaceSync, uploadMedia,
  referenceUrl,
  type IncidentMeta,
  isIncidentRunning,
} from './lib/incidents'
import { useAuditEvents } from './lib/useAuditEvents'
import { useMapDrawing } from './lib/useMapDrawing'
import { applyRouting, moveLineBody, resolveMapDrawings, resolvePlanAnnos } from './lib/lineAttachments'
import { leitungOptions, truppForLine, truppIsOut } from './lib/truppLines'
import { useIncidentSync } from './lib/useIncidentSync'
import { useTruppActions, LAGE_TARGET } from './lib/useTruppActions'
import { useObjectPlans, isSelectOnlySurface, railPlanTiles, BUILDING_PICK_ID } from './lib/useObjectPlans'
import { PlanPicker } from './components/PlanPicker'
import { FeedbackSheet, IncidentSwitcher, ReviewBanner, SettingsSheet, OfflineReadinessSheet } from './components/panels'
import { HelpOverlay } from './components/HelpOverlay'
import { useWeather } from './lib/useWeather'
import { fillTileTemplate, predownloadArea, tilesForBounds } from './lib/offlineTiles'
import { WARM_BYTES, estimateStorage, fittedTileCap, fmtBytes, prefetchFit } from './lib/storageBudget'
import { ChecklistsView } from './components/ChecklistsView'
import { AtemschutzView, type TruppOrder } from './components/AtemschutzView'
import { AnwesenheitView } from './components/AnwesenheitView'
import { MittelView } from './components/MittelView'
import { usePersonnel } from './lib/usePersonnel'
import { assignedPersonIds, canonicalName, linkTrupps, personIdForName, rosterIdByName as rosterIdByNameOf, truppByPersonId } from './lib/personnel'
import { rosterWithGuests } from './lib/guests'
import type { Item } from './lib/checklists'
import type { NoteSize } from './types'
import { ReportPreflight } from './components/ReportPreflight'
import { TruppFinder } from './components/TruppFinder'
import { markerOptions, placedTrupps, type PlacedTrupp } from './lib/placedTrupps'
import { annotatedPlans, changedReportMetaLines, normalizeReportMeta } from './lib/report'
import { missingSteps } from './lib/abschluss'
import { entityEditChanges, entityLogName } from './lib/entityEdit'
import { drawingLogName } from './lib/drawingEdit'
import { mittelLineCount } from './lib/mittel'
import { autoNoteWPx } from './lib/notes'
import { prepareUploadImage } from './lib/imagePrep'

const prefs = loadPrefs()

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
  const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  if (!el?.closest?.('[data-sync]')) return false
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


export function IncidentWorkspace({
  incidentMeta, incidents, workspace, sync, forceReadOnly, tabLockLost, onTakeOverTab, onCompleteRapport,
  onSwitchIncident, onOpenHistory, onOpenDivera, onOpenDatenquellen, onReactivateActive, onBackFromArchive,
  needsReview, onReviewDone, reviewedLocallyAt, onEditMeta,
}: WorkspaceProps) {
  // Identity + permissions. Viewers get a read-only picture: they can pan / zoom /
  // inspect, but every editing affordance is hidden and commit() is neutered so
  // nothing can mutate the document (defense in depth).
  const { user, logout } = useAuth()
  const baseReadOnly = user?.role !== 'editor' || forceReadOnly || tabLockLost
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
  // Time-travel replay is a read-only past view: while active it locks ALL editing
  // (folded into both readOnly and tacticalLocked) and swaps the live doc for the
  // reconstructed state. Owned by useReplay; `active` feeds the lock derivations below.
  // the top bar and the nav rail stay put while iOS pans the page under a keyboard
  useViewportPan()
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
  // Phones edit like tablets — the tool bar is simply always there on the drawing surfaces
  // (stacked above the surface bar). Viewers and the EL-Ansicht stay hands-off; a brigade
  // that wants a view-only phone uses exactly those.
  const tacticalLocked = readOnly || elView

  // Seed all state slices once from this incident's workspace (the component is keyed
  // by incident id upstream, so this runs exactly once per incident). The blob passes the
  // sanitize/version gate first — a stale or malformed cached blob must never crash the open.
  const bootGate = useMemo(() => sanitizeWorkspace(workspace), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const init = useMemo(() => deriveInitial(bootGate.ws, incidentMeta.id, prefs, incidentMeta.type), [])  // eslint-disable-line react-hooks/exhaustive-deps
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
  const mapRef = useRef<MapRef>(null)
  // the locked surface's tool set — see lib/readOnlyTools for why only these two qualify
  const slimMapTools = useMemo(() => slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS), [])

  // --- document (undoable) — doc + history funnel extracted to useUndoableDoc ---
  const { doc, setDocRaw, commit, beginDrag, endDrag, undo: undoDoc, redo: redoDoc, canUndo, canRedo, replace: replaceDoc } = useUndoableDoc<Doc>(init.doc, readOnly)
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

  // Per-incident SYNCED workspace slices (board, checklists, trupps, attendance, mittel, camera
  // views, plan scale, report meta, Gebäude, active plan, picked object, synced settings, the
  // shared «Einsatzdaten geprüft» stamp) — see
  // useWorkspaceDoc. State only; buildPayload/applyWorkspace + the trupps auto-free effects stay
  // below and read these. layers/recent stay in the component (own derivation/effects).
  const {
    incidentSettings, setIncidentSettings, board, setBoard, checklists, setChecklists,
    trupps: allTrupps, setTrupps, attendance, setAttendance, mittel, setMittel, shifts, setShifts, bands, setBands, cameraViews, setCameraViews, attachments, setAttachments,
    planScale, setPlanScale, reportMeta, setReportMeta, building, setBuilding,
    activePlanId, setActivePlanId, pickedObjectId, setPickedObjectId,
    intakeReviewedAt, setIntakeReviewedAt,
  } = useWorkspaceDoc(init)
  // ⚠️ The board list, filtered ONCE at the source. A deleted Trupp is stamped rather than
  // removed (types · Trupp.removedAt) so the Rapport can still print it — and everything else in
  // this component, from the alarm host to the map markers to the roster lock, must never see it
  // again. Filtering here is what makes that true by construction instead of by fifteen call
  // sites remembering. `allTrupps` goes to exactly two places: what is SAVED, and what is PRINTED.
  const trupps = useMemo(() => allTrupps.filter((t) => !t.removedAt), [allTrupps])
  // …and the other half: what was taken off the board, newest first. The Atemschutz header offers
  // them back, so the delete's six-second toast is the fast way and not the only one.
  const removedTrupps = useMemo(
    () => allTrupps.filter((t) => t.removedAt).sort((a, b) => (b.removedAt ?? '').localeCompare(a.removedAt ?? '')),
    [allTrupps],
  )

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
  const resolvedMapDrawings = useMemo(() => resolveMapDrawings(drawings, entities), [drawings, entities])
  // undo/redo wrap the hook's pure history step with the audit log + emit (App-level).
  const undo = () => { if (undoDoc()) { log('undo', appConfig.copy.log.undo, 'history'); emit('undo') } }
  const redo = () => { if (redoDoc()) { log('redo', appConfig.copy.log.redo, 'history'); emit('redo') } }
  // the Plan keeps its own per-document history (inside Whiteboard); it reports its
  // step fns + can-flags up here so the GLOBAL TopBar undo/redo drives whichever
  // surface is showing — one control, both surfaces, no rail-level duplication.
  const planHist = useRef<{ undo: () => void; redo: () => void } | null>(null)
  const [planCan, setPlanCan] = useState({ canUndo: false, canRedo: false })
  // ⚠️ …and the STACKS live here rather than inside the Whiteboard, because the Whiteboard is
  // mounted only while `mode === 'plans'`: as component state the plan's history was thrown away
  // every time somebody glanced at the Verlauf or the Karte and came back — «nichts, was sich
  // nicht rückgängig machen lässt» broken by a tab switch. Keyed by plan id (see BoardHistory),
  // so surviving the unmount never leaks one plan's undo into another plan's.
  const [planHistory, setPlanHistory] = useState<BoardHistory>({})
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
  const planKeys = useRef<{ pickTool: (tool: string) => void; zoom: (f: number) => void } | null>(null)
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
   */
  const entityLogBase = useRef(new Map<string, { base: Entity; timer: ReturnType<typeof setTimeout> }>())
  const noteEntityEdit = (before: Entity, after: Entity) => {
    const open = entityLogBase.current.get(before.id)
    const base = open?.base ?? before
    if (open) clearTimeout(open.timer)
    const timer = setTimeout(() => {
      entityLogBase.current.delete(before.id)
      const changes = entityEditChanges(base, after)
      if (!changes.length) return
      log('pen', fillTemplate(appConfig.copy.log.entityEdited, {
        name: entityLogName(after), changes: changes.join(', '),
      }), 'symbol', undefined, before.id)
    }, META_LOG_SETTLE_MS)
    entityLogBase.current.set(before.id, { base, timer })
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
  const rowSeq = useRef(0) // per-mount suffix so same-millisecond rows get distinct ids
  const [recent, setRecent] = useState<string[]>(init.recent)
  // most-recently-used symbols (shared by both surfaces' palettes) — newest first, deduped, capped
  const addRecent = (name: string) => setRecent((r) => [name, ...r.filter((x) => x !== name)].slice(0, 12))
  // overlay / popover / sheet open-state (views popover, symbol palette, Einstellungen,
  // Objekt-Picker, Hilfe, Installations-Guide, Offline-Bereitschaft — the Rapport is not here,
  // it is a rail surface, so «open it» is setMode('rapport'),
  // layers panel) — grouped in useSheets; switching to a tool closes the views popover + panel.
  const { viewsOpen, setViewsOpen, paletteOpen, setPaletteOpen, settingsOpen, setSettingsOpen, pickerOpen, setPickerOpen, helpOpen, setHelpOpen, installGuideOpen, setInstallGuideOpen, offlineReadyOpen, setOfflineReadyOpen } = useSheets()
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
  // surface + active plan are remembered across reloads via a cookie
  const [mode, setMode] = useState<'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'>(prefs.mode ?? 'map')
  /** The Rapport is a surface now, so «open it» is «go there». Kept as a named helper because
   *  half a dozen entry points say it (Abschluss-Assistent, the print action, the return chip). */
  const openRapport = () => setMode('rapport')
  // «Karte verknüpfen» on a PHONE hops between the plan and the map — there is no room for the
  // two-pane split, so the app follows the mode instead of asking anyone to find the other
  // surface. This one line is the whole bridge; the mode itself lives in lib/georefMode.
  useGeorefSurfaceBridge(setMode)
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
  // If a Trupp's placed plan chip gets deleted on the board, free the Trupp (clear annoId/planId)
  // so it can be placed again — otherwise the "Platzieren" button (gated on !annoId) stayed hidden.
  useEffect(() => {
    setTrupps((ts) => {
      let changed = false
      const next = ts.map((t) => {
        if (t.annoId && t.planId && !(board[t.planId] ?? []).some((a) => a.id === t.annoId)) {
          changed = true
          return { ...t, annoId: undefined, planId: undefined }
        }
        return t
      })
      return changed ? next : ts
    })
  }, [board])
  // …and the same for a Lage-map team marker (deleted via undo / sync / group ops): free the
  // Trupp so «Platzieren» comes back instead of pointing at a marker that no longer exists.
  useEffect(() => {
    setTrupps((ts) => {
      let changed = false
      const next = ts.map((t) => {
        if (t.entityId && !doc.entities.some((e) => e.id === t.entityId)) {
          changed = true
          return { ...t, entityId: undefined }
        }
        return t
      })
      return changed ? next : ts
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.entities])
  // What the bell actually controls: per-device, but scoped to THIS Einsatz — a tablet muted at a
  // drill in February is armed again for the next one (see useAtemschutzMute). `audioBlocked` is
  // the third honest state: the browser has not released audio, so only the OS notification can
  // fire and the bell says so instead of claiming to be on.
  const { muted: atemschutzMuted, mute: muteAtemschutz, toggle: toggleAtemschutzMuted, audioBlocked: atemschutzAudioBlocked, unlockAudio: unlockAtemschutzAudio } = useAtemschutzMute(incidentMeta.id)
  // how the Atemschutz board is arranged — a way of LOOKING at it, so per device. The hand-set
  // order it can show (Trupp.order) is synced, so «wie gesetzt» is the same board everywhere.
  const [atemschutzOrder, setAtemschutzOrderState] = useState<TruppOrder>(() => loadPrefs().atemschutzOrder ?? 'manuell')
  const setAtemschutzOrder = (o: TruppOrder) => { setAtemschutzOrderState(o); savePrefs({ ...loadPrefs(), atemschutzOrder: o }) }
  // Which Georeferenz twin layers this device shows. A DEVICE pref like every other «what am I
  // looking at» switch, and persisted the same way `atemschutzOrder` above is: seeded lazily from
  // the cookie, written on the toggle. Absent = shown (lib/georefTwins · twinVisible) — a
  // georeference exists because somebody made one, and both pictures at once is what for.
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
  /** A «zeigen» jump is a promise that its target will be visible. Respect a deliberate layer
   *  choice normally, but turn the one required projection back on for that explicit jump. */
  const showTwinLayer = (id: string) => {
    const next = revealTwinLayer(twinLayers, id)
    if (next !== twinLayers) persistTwinLayers(next)
  }
  // a Rapport checklist row navigated to Anwesenheit/Mittel → offer the one-tap way back
  const [rapportReturn, setRapportReturn] = useState(false)
  // «Leitung wählen»: the Trupp waiting for a hose to be tapped. Ephemeral (never saved) and
  // honoured by BOTH surfaces, so the operator can arm it here and tap the line on the Lage or on
  // a plan — whichever is where they drew it.
  const [linePickTrupp, setLinePickTrupp] = useState<string | null>(null)
  // the Verlauf drawer sits BELOW the Rapport sheet (z 61 vs 80), so opening it from the
  // checklist closes the sheet and reopens it when the Verlauf closes — a real round trip
  const [journalFromRapport, setJournalFromRapport] = useState(false)
  // leaving those surfaces for anything else ends the round trip (no stale chip later)
  useEffect(() => { if (mode !== 'anwesenheit' && mode !== 'mittel') setRapportReturn(false) }, [mode])
  // per-object backend module plans (auto-surfaced near object, or a manual PlanPicker override),
  // plus the resolved plan-doc list with module PDFs swapped in — see useObjectPlans
  const { backendPlans, resolvedPlanDocs, manualObject, activeObjectName, activeObjectAddress, pickObject, resetObject } = useObjectPlans(incidentMeta.id, incidentView.center, setActivePlanId, pickedObjectId, setPickedObjectId)

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
    // warm: per-object plan PDFs, the symbol library, and the geojson overlays cropped to the box
    const warmUrls = [
      ...Object.values(backendPlans),
      referenceUrl('symbols:tactical'),
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
        if (!quiet) toast(fillTemplate(co.dlNoSpace, { free: fmtBytes(budget.free) }), { icon: 'map', tone: 'warn' })
        return
      }
      if (!quiet) {
        const ok = await confirmDialog({
          title: co.dlTightTitle,
          message: fillTemplate(co.dlTightMsg, {
            need: fmtBytes(fit.needBytes), free: fmtBytes(budget.free), pct: String(Math.round((reduced / coverageTileCount) * 100)),
          }),
          confirmLabel: co.dlTightConfirm,
          cancelLabel: appConfig.copy.cancel,
        })
        if (!ok) return
      }
      cap = reduced
    }
    setOfflineProgress({ done: 0, total: 1 })
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
      if (!quiet) toast(appConfig.copy.offline.dlFailed, { icon: 'map', tone: 'warn' })
    } finally {
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

  // both bars are stacked on the two drawing surfaces (tool bar above the surface bar) — this drives
  // the extra bottom clearances for FAB / docks / stage / whiteboard on phones. A viewer-only plan
  // (e.g. Modul 6 Gebäudepläne) renders no tool bar, so it gets ONE bar of clearance, not two —
  // otherwise the empty tool-bar lane blocks the PDF from scrolling to the bottom nav.
  // ⚠️ A half-typed Mittel (or guest) belongs to the Einsatz it was started on. Switching
  // incidents drops every kept draft, so the next one can never be handed the previous one's
  // entry — see lib/draftKeep.
  useEffect(() => { clearAllDrafts() }, [incidentMeta.id])
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

  // the flat nav order (matches NavRail) — map, EACH rail tile, then the four sections. The `nav`
  // hotkey steps one destination at a time, so it walks through the modules individually instead
  // of collapsing to whatever plan was last open (the Gebäude).
  // ⚠️ The RAIL list, not the catalog: ⌘[ / ⌘] steps what the rail shows, so the merged Gebäude
  // tile is one stop, not two. Stepping onto an «Umrisse» stop that has no tile to land on is
  // exactly the chevron-lands-nowhere bug the merge exists to remove.
  const navList = useMemo(() => [
    { mode: 'map' as const },
    ...railPlanDocs.map((d) => ({ mode: 'plans' as const, planId: d.id })),
    { mode: 'checklists' as const },
    { mode: 'atemschutz' as const },
    { mode: 'anwesenheit' as const },
    { mode: 'mittel' as const },
  ], [railPlanDocs])
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
  // which Georeferenz twin has its source-backed editor open — a linked plan's symbol mirrored
  // onto the map. Selection belongs to the shared source object; the projection carries its halo.
  const [twinView, setTwinView] = useState<MapTwin | null>(null)
  // …and which mirrored NON-symbol object (line, area, note, shape, Trupp chip) has its in-place
  // panel open on the Karte. Same rule as twinView: a tap on a projection stays on this surface;
  // «Zum Original» in the panel is the explicit jump (E8).
  const [contentTwinView, setContentTwinView] = useState<MapContentTwin | null>(null)
  // …and which mirrored Karte entity (team chip, note, shape) has its panel open on the PLAN
  // surface — the other half of the same rule. Stored by id, resolved live below.
  const [planTwinEntityId, setPlanTwinEntityId] = useState<string | null>(null)
  // Title input in the map-side editor for a plan-owned twin. The source plan is not mounted,
  // so this brackets its live keystrokes into one caller-owned per-plan undo step.
  const planTwinTitleLive = useRef<string | null>(null)
  // A detail sidebar has one owner. Opening a projection first drops every real selection so
  // two editors can never stack, compete for Escape, or leave two objects looking active.
  const openTwinView = (twin: MapTwin) => {
    setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
    setNotePanelId(null); setEditNoteId(null)
    // …and the two chrome docks, which a twin's panel shares a slot with exactly as an ordinary
    // detail panel does. A twin is not part of `selKey`, so the «new selection closes the map
    // chrome» effect never fires for one — without this, tapping a projected Modul symbol while
    // Ebenen was open stacked a THIRD surface into the same band.
    setPanel(null); setViewsOpen(false)
    setContentTwinView(null)
    setTwinView(twin)
  }
  // the content twins' half of the same discipline: one detail sidebar, one owner
  const openContentTwinView = (twin: MapContentTwin) => {
    setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
    setNotePanelId(null); setEditNoteId(null)
    setPanel(null); setViewsOpen(false)
    setTwinView(null)
    setContentTwinView(twin)
  }
  // style the NEXT note carries, chosen in the armed-tool dock before anything is placed
  const [noteDefaults, setNoteDefaults] = useState<{ size: NoteSize; plain: boolean; color: string }>(
    { size: 'm', plain: false, color: '' },
  )
  // width drag on a note text box (screen px) — the 'start'/'end' phases bracket the gesture so
  // the whole drag folds into one undo step, exactly like the shape transform handles.
  const noteWidthDrag = (id: string, w: number | undefined, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') { beginDrag(); return }
    if (phase === 'end') { endDrag(); emit('entity.edit', { id, patch: { noteW: doc.entities.find((e) => e.id === id)?.noteW } }); return }
    // a hand-dragged width ends the auto-fit for good — the operator has decided how wide this
    // note is, and nothing may resize it under them afterwards
    setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, noteW: w, noteAutoW: undefined } : e)) }))
  }
  const [view, setView] = useState<{ bearing: number; center: LngLat; zoom: number }>({ bearing: 0, center: incidentView.center, zoom: getDeploymentConfig().map?.defaultView?.zoom ?? 17.6 })
  // coordinate picker (one-shot crosshair + LV95/WGS84 readout) — extracted to useCoordPicker.
  const coord = useCoordPicker(false, view.center)

  // --- audit capture (substrate A): batch client tactical events, flush debounced (see useAuditEvents) ---
  const { emit, flushEvents, flushEventsBeacon } = useAuditEvents(incidentMeta.id, readOnly)

  // Weather for the incident location. Polled live; each NEW observation is recorded as a
  // `weather.observe` event so the replay fold can show the wind/condition as it stood at any
  // past instant (see lib/replay · stateAt). During replay the badge reads the folded reading.
  const liveWeather = useWeather(incidentView.center)
  const lastWxAt = useRef<string | null>(null)
  useEffect(() => {
    const w = liveWeather.data
    if (readOnly || !w || !w.observed_at || w.observed_at === lastWxAt.current) return
    lastWxAt.current = w.observed_at
    emit('weather.observe', { weather: w })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveWeather.data, readOnly])
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
  const applyWorkspace = useCallback((ws: Saved) => {
    const gate = sanitizeWorkspace(ws)
    reportGate(gate)
    const next = deriveInitial(gate.ws, incidentMeta.id, prefs, incidentMeta.type)
    // replaceDoc swaps the doc AND drops undo history (the local stacks no longer apply to
    // remote/merged state — undoing into it would resurrect remotely-deleted content).
    replaceDoc(next.doc); setLayers(next.layers); journal.ingestLegacy(next.timeline)
    setRecent(next.recent); setBoard(next.board); setBuilding(next.building)
    setVehicleOverrides(next.vehicleOverrides); setChecklists(next.checklists); setTrupps(next.trupps); setAttendance(next.attendance); setShifts(next.shifts); setBands(next.bands); setCameraViews(next.cameraViews); setPlanScale(next.planScale); setReportMeta(next.reportMeta); setAttachments(next.attachments); setIncidentSettings(next.settings); setPickedObjectId(next.pickedObjectId); setIntakeReviewedAt(next.intakeReviewedAt)
    // …and the Anwesenheit's own stack goes with it, for the same reason: it holds snapshots of a
    // list that no longer exists, and stepping into one would write this device's rows back over
    // what another device just merged in. The Plan's stacks go too — they now outlive the board's
    // unmount (see `planHistory`), so nothing else drops them any more.
    attHistClear.current?.(); setPlanHistory({})
    // Drop any selection pointing at an entity/drawing that no longer exists after the merge.
    setSelectedId((id) => (id && next.doc.entities.some((e) => e.id === id) ? id : null))
    setSelectedDrawingId((id) => (id && next.doc.drawings.some((d) => d.id === id) ? id : null))
    setSelectedDrawIds((ids) => ids.filter((id) => next.doc.drawings.some((d) => d.id === id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentMeta.id, incidentMeta.type])

  // Build the workspace blob from the current slices. The memo deps are exactly the persisted
  // slices, so its identity changes iff one of them does — that's what re-fires the save in
  // useIncidentSync (replacing the old slice-keyed persistence effect's dependency array).
  const buildPayload = useCallback((): Saved => ({
    entities: doc.entities.filter((e) => e.kind !== 'photo'),
    drawings: doc.drawings, recent, board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, trupps: allTrupps, attendance, mittel, shifts, bands, cameraViews, planScale, reportMeta, attachments, settings: incidentSettings, intakeReviewedAt,
    layerState: layers.map((l) => ({ id: l.id, visible: l.visible, opacity: l.opacity })),
    // Verlauf rows live in the journal store now; the blob echoes an older incident's legacy
    // rows only until they're safely on the server, then ships empty forever (see JournalStore).
    timeline: journal.blobTimeline,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
  }), [doc, layers, journal.blobTimeline, recent, board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, allTrupps, attendance, mittel, shifts, bands, cameraViews, planScale, reportMeta, attachments, incidentSettings, intakeReviewedAt])

  // SCBA contact-clock alarm runs app-wide (not just on the Atemschutz surface) so an überfällig
  // Trupp alerts no matter which page is open. Paused during replay (read-only past view).
  // Hosted in a null-rendering child (see AtemschutzAlarmHost): its 1 Hz tick must NOT re-render
  // App — that repainted the whole tree every second a Trupp was in the field (battery drain).
  // Declared up here (not with the Atemschutz block) because the sync loop below reads it.
  const [azAlarm, setAzAlarm] = useState<AtemschutzAlarmState>({ peak: 0, urgent: null, severities: {} })

  // persistence, teardown beacons, live-follow poll (with the tablet sync-race guard),
  // in-place auto-merge apply, and the reactive sync-status badge all live in useIncidentSync.
  const { syncStatus, lastSyncedAt, syncNow } = useIncidentSync({
    sync, readOnly, incidentId: incidentMeta.id,
    buildPayload, applyWorkspace, flushEvents, flushEventsBeacon,
    // attendance-divergence note (both sides changed the same person → one Verlauf row)
    appendJournal: journal.append,
    // a ringing device polls fast even when hidden — the Funkkontakt that ends its alarm is
    // usually entered on another device and arrives via this very poll
    alarmUrgent: azAlarm.peak >= 2,
  })

  // Publish this device's «Einsatzdaten geprüft» to the crew. The question belongs to the Einsatz,
  // not to the tablet it was answered on (lib/incidentAlerts), and this component is the only
  // writer of the incident's blob — so whichever way it was answered here (App's markReviewed
  // takes both «Passt» and a saved correction) the stamp goes out with the next save and every
  // other device drops the banner on its next poll. Auto-opened Einsätze only: a hand-typed one
  // was never up for review, and stamping it would dirty the blob for nothing.
  useEffect(() => {
    if (readOnly || !reviewedLocallyAt || intakeReviewedAt || !incidentMeta.auto_opened) return
    setIntakeReviewedAt(reviewedLocallyAt)
  }, [readOnly, reviewedLocallyAt, intakeReviewedAt, incidentMeta.auto_opened, setIntakeReviewedAt])

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

  const saveReportMeta = useCallback((next: ReportMeta) => {
    setReportMeta((prev) => {
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
    incidentId: incidentMeta.id, readOnly,
    onUploaded: swapRowMedia, onRestore: swapRowMedia,
  })

  // --- ONE «Einsatz abschliessen» ------------------------------------------------------------
  //
  // Two doors lead here — the Rapport's button/band and the row in the Einsatz-Menü — and until
  // 22.08. only ONE of them checked anything. The menu row archived plainly: no `report_done_at`,
  // none of the seven ABSCHLUSS_STEPS, so an Einsatz put away that way stood in the Historie as
  // «offen» for ever, while the identically-labelled path through the Rapport stamped and
  // counted. Two doors into one room are fine; two doors with the same sign into different rooms
  // are not. The confirm and the open-point count live HERE, above both of them.
  const abschlussMissing = useMemo(
    () => missingSteps({ reportMeta, attendanceCount: Object.keys(attendance).length, mittelCount: mittelLineCount(mittel) }),
    [reportMeta, attendance, mittel],
  )
  /** Resolves TRUE when the Einsatz was actually handed over for closing — the Rapport uses that
   *  to decide whether to forget its scroll position, and a cancelled confirm must not. */
  const confirmAndComplete = useCallback(async (): Promise<boolean> => {
    const A = appConfig.copy.abschluss
    const P = appConfig.copy.preflight
    // ⚠️ Pending media belongs in this list. The Abschluss closes the incident, and a Foto or a
    // Sprachnotiz that never got a connection is still sitting on THIS device — the operator is
    // about to walk away, so that is part of what they are confirming.
    const pendingItem = media.pendingCount > 0
      ? [fillTemplate(P.pendingMediaConfirm, { n: media.pendingCount })]
      : []
    const ok = await confirmDialog({
      title: A.confirmTitle,
      message: abschlussMissing.length ? P.exportIncompleteLead : A.confirmMsg,
      items: [...abschlussMissing.map((s) => A.steps[s]), ...pendingItem],
      note: abschlussMissing.length ? A.confirmMsg : undefined,
      // the button names what is actually about to happen — closing an Einsatz with open points
      // is allowed, and the label is where that is said out loud
      confirmLabel: abschlussMissing.length ? A.confirmAnyway : A.confirmBtn,
    })
    if (!ok) return false
    // ⚠️ Drain the media queue FIRST, from here. The Abschluss closes the incident and App then
    // drops what has already gone up (clearUploadedMedia) — and an upload also has to patch its
    // Verlauf row's blob: URL to the server one (useMediaQueue · onUploaded), which needs this
    // workspace and its journal store, both gone after the handover.
    await media.flush().catch(() => {})
    // …and the answer is the REAL outcome, not the firing of the request: App reports whether
    // the close went through, so the Rapport's kept scroll position survives a failed Abschluss
    // (offline, server error) instead of being forgotten for an Einsatz that is still open.
    return onCompleteRapport()
  }, [abschlussMissing, media, onCompleteRapport])

  // upload a captured photo/audio blob and swap the timeline row's session blob: URL for the
  // persistent server URL (so history keeps the media). On failure the blob is persisted to the
  // offline queue so the capture survives a reload and re-uploads when connectivity returns.
  /**
   * Upload ONE picture of a row that may carry several, and swap that picture's local blob: URL
   * for the server URL — by value, not by field: a row with three photos must not lose two of
   * them because the third finished uploading. Failures keep the blob: entry, which the Rapport
   * preflight already counts as pending media.
   */
  const uploadPhotoForRow = useCallback(async (rowId: string, localUrl: string) => {
    if (readOnly) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return }
    blob = await prepareUploadImage(blob)
    try {
      const { url } = await uploadMedia(incidentMeta.id, blob, 'photo', `photo-${rowId}`)
      swapPhoto(rowId, localUrl, url)
    } catch {
      // queue THIS picture (keyed by its own blob: URL) — a row-wide key made each photo of a
      // multi-photo row evict the previous one, losing every capture but the last while offline
      await media.enqueue(rowId, 'photo', blob, `photo-${rowId}`, new Date().toISOString(), localUrl)
    }
  }, [incidentMeta.id, readOnly, media, swapPhoto])

  const uploadMediaForRow = useCallback(async (rowId: string, localUrl: string, kind: 'photo' | 'audio') => {
    if (readOnly) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return /* the blob: URL is already gone — nothing to persist */ }
    // A photo is re-encoded BEFORE the first attempt (and therefore before it is queued): the
    // server takes jpeg/png/webp only and a phone hands over a 4–12 MB HEIC, so the upload used
    // to 4xx, retry forever from the offline queue, and the picture quietly never reached the
    // printed Rapport. See lib/imagePrep.
    if (kind === 'photo') blob = await prepareUploadImage(blob)
    try {
      const { url } = await uploadMedia(incidentMeta.id, blob, kind, `${kind}-${rowId}`)
      swapRowMedia(rowId, kind, url, localUrl)
    } catch {
      // offline / server error — keep the blob for later instead of losing it this session
      await media.enqueue(rowId, kind, blob, `${kind}-${rowId}`, new Date().toISOString(), kind === 'photo' ? localUrl : undefined)
    }
  }, [incidentMeta.id, readOnly, media, swapRowMedia])

  /**
   * Rapport-Beilagen: add one or more photos that belong to the REPORT (an ID document, a damage
   * close-up). The row appears immediately with a local blob: URL and swaps to the server URL when
   * the upload lands — same shape as a journal photo, so an offline KP can still assemble the
   * Rapport and the picture catches up. A failed upload leaves the blob: row, and the preflight
   * says «noch nicht hochgeladen» beside it rather than pretending it will print.
   */
  const addAttachments = useCallback((files: File[]) => {
    if (readOnly) return
    const at = new Date().toISOString()
    for (const file of files) {
      const id = `att${Date.now()}${Math.random().toString(36).slice(2, 6)}`
      const localUrl = URL.createObjectURL(file)
      setAttachments((list) => [...list, { id, url: localUrl, at }])
      emit('report.attachment.add', { id })
      void (async () => {
        try {
          // Re-encode first: the server takes jpeg/png/webp only and a phone hands over HEIC at
          // 4–12 MB, so the raw file 4xx'd and the Beilage silently never printed (lib/imagePrep).
          const blob = await prepareUploadImage(file)
          const { url } = await uploadMedia(incidentMeta.id, blob, 'photo', file.name || 'beilage.jpg')
          setAttachments((list) => list.map((a) => (a.id === id ? { ...a, url } : a)))
        } catch (e) {
          // NOT silent: an upload that failed means this Beilage will not be on the paper, and
          // the operator has to hear that while they can still do something about it.
          toast(fillTemplate(appConfig.copy.preflight.attachmentsFailed, { name: file.name || '' }), { icon: 'warn', tone: 'warn' })
          console.warn('Beilage upload failed', e)
        }
      })()
    }
  }, [incidentMeta.id, readOnly, setAttachments, emit])
  const captionAttachment = useCallback((id: string, caption: string) => {
    if (readOnly) return
    // Stored AS TYPED. `.trim()` here ran on every keystroke, so the space you pressed was
    // deleted before the next letter arrived — «Ausweis Lenker» came out «AusweisLenker» and a
    // trailing space was impossible. Trimming belongs where the caption is USED (the print
    // payload), not where it is being written.
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, caption: caption || undefined } : a)))
  }, [readOnly, setAttachments])
  const removeAttachment = useCallback((id: string) => {
    if (readOnly) return
    setAttachments((list) => list.filter((a) => a.id !== id))
    emit('report.attachment.remove', { id })
  }, [readOnly, setAttachments, emit])

  // When the workspace sync recovers (server reachable again), drain any queued media too —
  // a stronger signal than the browser's `online` event, which fires on link-up not reach.
  useEffect(() => { if (syncStatus === 'synced') void media.flush() }, [syncStatus, media])

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
      if (pending || pendingShape) { setPending(null); setPendingShape(null); setTool('select') }
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
      else if (twinView) setTwinView(null)
      else if (contentTwinView) setContentTwinView(null)
      else if (notePanelId) setNotePanelId(null)
      else if (selectedId || selectedDrawingId || selectedDrawIds.length || selectedEntityIds.length) { setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, pendingShape, panel, viewsOpen, tool, twinView, contentTwinView, notePanelId, selectedId, selectedDrawingId, selectedDrawIds, selectedEntityIds])  // eslint-disable-line react-hooks/exhaustive-deps

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
    if (settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || composerOpen || journalOpen || teamPick) setPanel(null)
  }, [settingsOpen, paletteOpen, pickerOpen, helpOpen, installGuideOpen, offlineReadyOpen, composerOpen, journalOpen, teamPick])

  // Delete / Backspace removes the current selection (drawing first, then entity) — but
  // never while typing in a field. `doc` is a dep so the delete closes over fresh state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (selectedDrawIds.length || selectedEntityIds.length) { e.preventDefault(); deleteGroup(selectedDrawIds, selectedEntityIds) }
      else if (selectedDrawingId) { e.preventDefault(); deleteDrawing(selectedDrawingId) }
      else if (selectedId && !tacticalLocked) { e.preventDefault(); deleteEntity(selectedId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, selectedDrawingId, selectedDrawIds, selectedEntityIds, doc, tacticalLocked])  // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => {
    for (const p of resolvedPlanDocs) if (p.osm) prefetchOutlines(p.osm.center, p.osm.radiusM)
  }, [resolvedPlanDocs])

  // remember the active surface + plan document in a cookie (preserve incidentId)
  useEffect(() => { savePrefs({ ...loadPrefs(), mode, activePlanId, symbolScaleMap: symbolScale.map, symbolScaleBoard: symbolScale.board, symbolCaptions, offlineRadiusM, offlineAuto, keepScreenOn, railLabels }) }, [mode, activePlanId, symbolScale, symbolCaptions, offlineRadiusM, offlineAuto, keepScreenOn, railLabels])

  // bake every plan's bitmap into memory at app load (on idle, sized to the
  // window) so the very first time the Plan tab is opened the page appears
  // instantly — the exact-fit bake reuses these unless the stage is larger
  useEffect(() => {
    const urls = resolvedPlanDocs
      .filter((p) => p.imageUrl)
      .map((p) => (p.imageUrl.startsWith('/') || /^https?:/.test(p.imageUrl) ? p.imageUrl : `${import.meta.env.BASE_URL}${p.imageUrl}`))
    const run = () => prewarmPlans(urls, window.innerWidth, window.innerHeight)
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    const id = idle ? idle(run) : window.setTimeout(run, 600)
    return () => { const ric = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback; if (idle && ric) ric(id); else clearTimeout(id) }
  }, [resolvedPlanDocs])

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

  // --- Georeferenz: the twins (lib/georefTwins, components/GeorefTwinMark) -----------------------
  // A projection, never an object: it is not stored, logged, printed, given a clock or moved.
  // Repositioning belongs to the original surface; the twin panel provides that explicit jump.
  //
  // ⚠️ `useGeorefStorage()` is what makes the memo below re-run. `georefForPlan` reads a module
  // singleton synchronously, so a plan that was just linked has nothing else to tell React with.
  useGeorefStorage()
  // …and THIS is the dep that carries it: `saveStationPlanScales` replaces the singleton with a
  // new object on every write, so its identity changes exactly when a reference does (and once
  // more when the boot fetch lands). Read during render — it is a synchronous accessor.
  const stationScales = getStationPlanScales()
  // Every plan of this object that carries a usable fit, solved once per plan/pairs change. The
  // aspect each fit is taken at is recovered from the plan's calibration — see georefTwins ·
  // planAspect for why that is the right source and what happens when there is none.
  const linkedPlans = useMemo(
    () => georefPlans(planDocs, georefForPlan, (p) => planAspect(p, stationScales, planScale[p.id])),
    [planDocs, planScale, stationScales],
  )
  // The plans' symbols, projected onto the map. Re-projected only when a board or a fit actually
  // moves — never on a pan, a zoom or a vehicle poll, none of which change where a plan symbol is
  // on the ground. Hidden wholesale during replay: the georeference is station data that was
  // never part of the recorded incident, so a past picture must not carry today's fit.
  const mapTwinList = useMemo<MapTwin[]>(() => {
    if (replayActive) return []
    const shown = linkedPlans.filter((p) => twinVisible(twinLayers, twinPlanLayerId(p.id)))
    return shown.length ? projectMapTwins(shown, board) : []
  }, [replayActive, linkedPlans, twinLayers, board])
  const mapContentTwinList = useMemo<MapContentTwin[]>(() => {
    if (replayActive) return []
    const shown = linkedPlans.filter((p) => twinVisible(twinLayers, twinPlanLayerId(p.id)))
    return shown.length ? projectMapContentTwins(shown, board) : []
  }, [replayActive, linkedPlans, twinLayers, board])
  // The Karte's content standing on each linked sheet, as PRINTABLE annos (30.08.): the
  // exported Objektplan page shows what the screen's sheet shows. Same visibility gates as
  // boardTwinSources — a layer hidden on screen must not resurface on paper.
  const printTwinAnnos = useMemo<Record<string, BoardAnno[]>>(() => {
    if (replayActive || !linkedPlans.length || !twinVisible(twinLayers, TWIN_MAP_SYMBOLS)) return {}
    const twinEntities = [
      ...doc.entities.filter((e) => e.kind === 'symbol' && isVisible(effectiveLayer(e))),
      ...entities.filter((e) => (e.kind === 'note' || e.kind === 'shape' || e.kind === 'team') && isVisible(effectiveLayer(e))),
    ]
    const twinDrawings = isVisible(appConfig.defaults.drawingLayerId) ? doc.drawings : []
    const out: Record<string, BoardAnno[]> = {}
    for (const p of linkedPlans) {
      const annos = boardTwinAnnosForPrint(p, twinEntities, twinDrawings)
      if (annos.length) out[p.id] = annos
    }
    return out
  }, [replayActive, linkedPlans, twinLayers, doc.entities, doc.drawings, entities, isVisible])
  // Selection stores a stable twin key; derive the live source snapshot after every board edit so
  // the mirrored editor and its map marker update together while the panel stays open.
  const viewedMapTwin = twinView ? mapTwinList.find((t) => t.key === twinView.key) ?? twinView : null
  // same live re-derivation for the content twins' panel: the board edit lands, the projection
  // moves, and the open panel follows the same source snapshot
  const viewedContentTwin = contentTwinView ? mapContentTwinList.find((t) => t.key === contentTwinView.key) ?? contentTwinView : null
  const [georefPlanPreviews, setGeorefPlanPreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    if (replayActive) return
    let cancelled = false
    for (const p of linkedPlans) {
      if (!p.imageUrl || !twinPlanImageVisible(twinLayers, p.id) || georefPlanPreviews[p.id]) continue
      const url = p.imageUrl.startsWith('/') || /^https?:/.test(p.imageUrl)
        ? p.imageUrl
        : `${import.meta.env.BASE_URL}${p.imageUrl}`
      void planPreviewUrl(url, window.innerWidth, window.innerHeight).then((preview) => {
        if (!cancelled) setGeorefPlanPreviews((cur) => cur[p.id] ? cur : { ...cur, [p.id]: preview })
      }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [replayActive, linkedPlans, twinLayers, georefPlanPreviews])
  const georefPlanRasters = useMemo(() => replayActive ? [] : linkedPlans.flatMap((p) => {
    const url = georefPlanPreviews[p.id]
    if (!url || !twinPlanImageVisible(twinLayers, p.id)) return []
    const points = ([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as const)
      .map((pt) => { const c = p.fit.toMap(pt); return [c.lng, c.lat] as [number, number] })
    return [{
      id: p.id,
      url,
      opacity: (twinLayerOpacity[twinPlanImageLayerId(p.id)] ?? 55) / 100,
      coordinates: points as [[number, number], [number, number], [number, number], [number, number]],
    }]
  }), [replayActive, linkedPlans, georefPlanPreviews, twinLayers, twinLayerOpacity])
  // …and the other direction: what the Karte lends the OPEN sheet. Only the raw lists travel —
  // the Whiteboard projects and clips them against its own fit, which is solved at the aspect it
  // has actually measured (see Whiteboard · twinVehicles).
  const activeLinkedPlan = linkedPlans.find((p) => p.id === activePlanId) ?? null
  const selectedPlanProjection = useMemo(() => {
    const entity = doc.entities.find((e) => e.id === selectedId)
    if (!entity || entity.kind !== 'symbol') return null
    const ordered = [...linkedPlans].sort((a, b) => Number(b.id === activePlanId) - Number(a.id === activePlanId))
    for (const plan of ordered) {
      const pt = plan.fit.toPlan({ lng: entity.coord[0], lat: entity.coord[1] })
      if (onSheet(pt)) return { plan, pt }
    }
    return null
  }, [doc.entities, selectedId, linkedPlans, activePlanId])
  const boardTwinSources = useMemo(() => {
    if (replayActive || !activeLinkedPlan) return undefined
    return {
      vehicles: twinVisible(twinLayers, TWIN_MAP_VEHICLES) ? liveVehicles : [],
      // the Lage's own tactical symbols, honouring the Karte's layer switch: a symbol hidden
      // there must not reappear on the sheet through the back door
      symbols: twinVisible(twinLayers, TWIN_MAP_SYMBOLS)
        ? doc.entities.filter((e) => e.kind === 'symbol' && isVisible(effectiveLayer(e)))
        : [],
      // Notes, ground shapes, Atemschutz markers and shared responder positions share the Lage
      // content row with drawings. Photos remain source-only for now (the requested rollout is
      // operational markings, not media overlays).
      content: twinVisible(twinLayers, TWIN_MAP_SYMBOLS)
        ? entities.filter((e) => (e.kind === 'note' || e.kind === 'shape' || e.kind === 'team' || e.kind === 'person') && isVisible(effectiveLayer(e)))
        : [],
      drawings: twinVisible(twinLayers, TWIN_MAP_SYMBOLS) && isVisible(appConfig.defaults.drawingLayerId) ? doc.drawings : [],
    }
  }, [replayActive, activeLinkedPlan, twinLayers, liveVehicles, doc.entities, doc.drawings, entities, isVisible])

  // The journal is append-only: every action pushes a row, and nothing ever edits
  // or removes one — undo/redo log their own lines. So the stream stays a faithful
  // record of what happened across both surfaces (and could back a standalone screen).
  const pushEvent = (ev: Omit<TimelineEvent, 'id' | 't' | 'at'> & { at?: string }, id?: string) => {
    // a caller may stamp `at` explicitly (e.g. a journal entry timed to when the composer was
    // opened, not when Erfassen was pressed); the HH:MM display derives from the same instant.
    const { at: atOverride, ...rest } = ev
    const at = atOverride ?? new Date().toISOString()
    // a monotonic counter, not randomness: two rows in the same millisecond must never share
    // an id — the server's idempotency skip would silently swallow the second (legal record)
    journal.append({ id: id ?? `e${Date.now()}-${rowSeq.current++}`, t: formatTime(new Date(at)), at, ...rest })
  }
  // map events keep the positional signature, so every existing call site is unchanged
  const log = (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string) =>
    pushEvent({ icon, text, kind, audioUrl, entityId, surface: 'map' })
  // plan events carry document + (optional) team / coordinate context for jump-back
  const logPlan = (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number }) =>
    pushEvent({ icon, text, kind: extra?.kind ?? 'symbol', surface: 'plan', planId: activePlanId, annoId: extra?.annoId, px: extra?.x, py: extra?.y, floor: extra?.floor })

  // Lage-map drawing surface (draft, line mode/preset, draw-style controls, Drawing CRUD +
  // on-canvas editing) lives in useMapDrawing — the undoable doc and selection state are
  // threaded in so the handlers behave identically to their former inline selves.
  const {
    draft, setDraft,
    drawColor, setDrawColor, drawWidth, setDrawWidth, drawDashed, setDrawDashed,
    lineMode, setLineMode,
    draftActive, lineNodes, selectedDrawing,
    commitDraft, settleDraft, noteDrawingEdit, createLine, createArea, onFreehand, setDraftPointAttachment, createCircle, applyLinePreset, patchDrawing, patchDrawingById,
    patchDrawingLabelLive, commitDrawingLabel,
    editDrawingCoords, moveLabel, insertDrawingVertex, deleteDrawingVertex, deleteDrawing, reverseDrawing, setDrawingAttachment,
  } = useMapDrawing({
    drawings, resolvedDrawings: resolvedMapDrawings, selectedDrawingId, tacticalLocked, tool, setTool,
    commit, setDocRaw, beginDrag, endDrag, emit, log,
    setSelectedDrawingId, setSelectedId, setSelectedDrawIds, setSelectedEntityIds,
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
  const editTwinDrawing = (id: string, patch: Partial<Drawing>, phase?: 'live' | 'commit') => {
    if (phase === 'live' && typeof patch.label === 'string') { patchDrawingLabelLive(id, patch.label); return }
    if (phase === 'commit' && typeof patch.label === 'string') { commitDrawingLabel(id, patch.label); return }
    patchDrawingById(id, patch)
    if (patch.lineNo !== undefined) syncLineNoToTrupp(id, patch.lineNo)
  }
  const detachTwinDrawing = (id: string, endpoint: LineEndpoint) => {
    const drawing = drawings.find((d) => d.id === id)
    if (!drawing) return
    const a = endpoint === 'start' ? drawing.startAttachment : drawing.endAttachment
    if (!a) return
    const fallback: LngLat = a.target.kind === 'object'
      ? entities.find((e) => e.id === a.target.id)?.coord ?? (endpoint === 'start' ? drawing.coords[0] : drawing.coords[drawing.coords.length - 1])
      : (() => {
          const target = drawings.find((d) => d.id === a.target.id)
          return target ? (a.target.endpoint === 'start' ? target.coords[0] : target.coords[target.coords.length - 1]) : (endpoint === 'start' ? drawing.coords[0] : drawing.coords[drawing.coords.length - 1])
        })()
    setDrawingAttachment(id, endpoint, undefined, fallback)
  }
  const focusTwinDrawingAttachment = (id: string, endpoint: LineEndpoint) => {
    const drawing = drawings.find((d) => d.id === id)
    const a = endpoint === 'start' ? drawing?.startAttachment : drawing?.endAttachment
    if (!a) return
    setMode('map')
    if (a.target.kind === 'object') focusEntity(a.target.id)
    else focusDrawing(a.target.id)
  }
  // External GPS movement is safety-guarded per connection. Safe samples update only the small
  // lastSafe field; continuous/Spur samples intentionally edit and simplify the line geometry.
  // No hover/sample audit spam: the operator's follow/pause choice is emitted by DrawEditor.
  useEffect(() => {
    if (replayActive || !liveVehicles.length) return
    setDocRaw((cur) => {
      let changed = false
      const next = cur.drawings.map((d) => {
        if (d.kind !== 'line') return d
        let drawing = d
        for (const endpoint of ['start', 'end'] as const) {
          const key = endpoint === 'start' ? 'startAttachment' : 'endAttachment'
          const a = drawing[key]
          if (a?.target.kind !== 'object' || !a.target.live || !a.gps) continue
          const target = liveVehicles.find((e) => e.id === a.target.id)
          if (!target || a.gps.state === 'paused') continue // known Traccar positions remain visible; no prominent missing-signal alarm
          if (a.gps.state === 'guarded') {
            const exceeded = haversineM(a.gps.confirmedAt, target.coord) >= 20
            const gps = exceeded ? { ...a.gps, state: 'paused' as const } : { ...a.gps, lastSafe: target.coord }
            drawing = { ...drawing, [key]: { ...a, gps } }; changed = true
          } else {
            const coords = applyRouting(drawing.coords, endpoint, target.coord, 'trace', 0.000008)
            drawing = { ...drawing, coords, [key]: { ...a, gps: { ...a.gps, lastSafe: target.coord } } }; changed = true
          }
        }
        return drawing
      })
      return changed ? { ...cur, drawings: next } : cur
    })
  }, [liveVehicles, replayActive, setDocRaw])

  // «Wann ist das TLF weggefahren?» — the feed answers it into the Verlauf, because an hour
  // later nobody can. Reads the RAW feed (`gpsVehicles`), not the overridden view: a vehicle
  // held in place by hand still really drives away, and that is the moment worth recording.
  useVehiclePresenceLog({
    vehicles: gpsVehicles,
    center: incidentView.center,
    enabled: canEditIncident && !replayActive,
    log,
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
    // A Georeferenz twin row is not a `LayerDef` and does not live in `layerState`: its ids are
    // per plan (and per object), so they have no home in the fixed layer list `deriveInitial`
    // reconciles against. It is a device pref instead — same scope, different drawer. Routed by
    // id so the Ebenen panel stays ONE list with one gesture (lib/georefTwins · isTwinLayerId).
    if (isTwinLayerId(id)) { toggleTwinLayer(id); return }
    const target = layers.find((l) => l.id === id)
    emit('layer.toggle', { id, base: !!target?.base, visible: target?.base ? true : !(target?.visible ?? true) })
    setLayers((ls) => {
      const target = ls.find((l) => l.id === id)
      if (!target) return ls
      if (target.base) return ls.map((l) => (l.base ? { ...l, visible: l.id === id } : l))
      return ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    })
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
    setTwinView(null)
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
    const rowId = `e${Date.now()}-j`
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
    const pendenzId = !d.noteFor && (d.pendenz || d.dueAt) ? `pnd${Date.now()}` : undefined
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
  const playerSeq = useRef(0)
  // returns the created row id (the STT confirm flow stamps it onto the draft segment);
  // `quiet` skips the toast for bulk confirms — the row appearing as a marker IS the feedback
  const addPlayerEntry = (text: string, atIso: string, quiet = false): string => {
    const rowId = `e${Date.now()}-p${playerSeq.current++}`
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
      // reminder lifecycle — done + snooze — not just creation.
      emit(ev.reminder.op === 'done' ? 'reminder.done' : 'reminder.snooze', { id: ev.reminder.id, ...(ev.reminder.dueAt ? { dueAt: ev.reminder.dueAt } : {}) })
    },
    {
      dueTitle: appConfig.copy.journal.dueTitle, doneLog: appConfig.copy.journal.doneLog,
      pendenzDoneLog: appConfig.copy.journal.pendenzDoneLog, snoozeLog: appConfig.copy.journal.snoozeLog,
    },
    !replayActive,
    incidentMeta.closed_at,
  )

  // Voice memo driven by the TopBar's Eintrag button (hold to start, tap to stop) —
  // lifecycle in useVoiceMemo; here we persist the finished clip into the journal. The
  // surface (map/plan) is snapshotted at hold-start so a mid-recording tab switch can't
  // re-file the clip (preserves the previous start-time behaviour).
  const voiceStartCtx = useRef<{ onPlan: boolean; planId: string }>({ onPlan: false, planId: activePlanId })
  const voice = useVoiceMemo(({ url, secs }) => {
    const { onPlan, planId } = voiceStartCtx.current
    const rowId = `e${Date.now()}-v`
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
    addJournal({ text: '', photoUrls: files.map((f) => URL.createObjectURL(f)) })
  }

  // Every path through here ends the "I am reading this object" state — reaching for a tool means
  // you are done with the detail panel, exactly as it has always worked for a note (see the
  // notePanelId effect). Symbol goes through it too: it opens the palette without setting `tool`,
  // so dismissing the palette without picking used to reveal the stale panel again.
  const pick = (id: string) => {
    if (id === 'symbol') { clearMapUi(); setPaletteOpen(true); return }
    // Auswahl (select) is the default navigate state: one finger pans the map, a tap
    // selects, a drag on an object moves it. There is no separate pan mode any more —
    // panning is always available — so tapping Auswahl while active just clears any
    // current selection rather than toggling into a hidden mode.
    // tapping the already-active tool again exits it → back to Auswahl (closes its option dock)
    if (id === tool) { clearMapUi(); return }
    clearMapUi(); setTool(id)
  }

  const pickShape = (kind: ShapeKind) => { setTool('shape'); setPending(null); setPendingShape(kind); setPaletteOpen(false) }

  // A real, stationary tap on the map — MapView drops the click that merely trails a pan or a
  // pinch before it ever gets here (see its panGesture note), so moving the map neither places
  // anything nor reaches the deselect at the end of this chain. On a phone that deselect IS the
  // detail sheet's dismiss, and it used to fire on every pan.
  const onMapClick = (c: LngLat) => {
    setTwinView(null); setContentTwinView(null)
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
      const id = `sh${Date.now()}`; const def = SHAPE_DEFS[pendingShape]
      const name = appConfig.copy.shapes.names[pendingShape]
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, coord: c, shape: pendingShape, color: def.defaultColor, sizeM: def.defaultSizeM, rotation: 0, label: name }] }))
      // unlocked: place once, then drop back to select with the new shape active so
      // its edit handles are immediately usable. locked: stay in place-mode (no
      // selection so the editor doesn't interrupt) to drop several in a row.
      // Both branches drop a lasso group too — it used to survive every placement and keep
      // painting halos over unrelated objects.
      setSelectedDrawIds([]); setSelectedEntityIds([])
      if (placeLock) { setSelectedId(null); setSelectedDrawingId(null) }
      else { setPendingShape(null); setTool('select'); setSelectedId(id); setSelectedDrawingId(null) }
      log('area', fillTemplate(appConfig.copy.log.shapePlaced, { name }), 'symbol', undefined, id)
      emit('entity.add', { id, kind: 'shape', entity: { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, coord: c, shape: pendingShape, color: def.defaultColor, sizeM: def.defaultSizeM, rotation: 0, label: name } })
    } else if (tool === 'symbol' && pending) {
      const id = `p${Date.now()}`; const s = pending
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
      const id = `n${Date.now()}`
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: c, label: '', subtitle: appConfig.copy.entities.noteSubtitle, noteW: autoNoteWPx('', noteDefaults.size === 'm' ? undefined : noteDefaults.size), noteAutoW: true, noteSize: noteDefaults.size === 'm' ? undefined : noteDefaults.size, notePlain: noteDefaults.plain || undefined, color: noteDefaults.color || undefined }] }))
      // straight into typing on the surface; the detail panel waits for the ⚙
      setSelectedId(id); setSelectedDrawingId(null); setEditNoteId(id); setTool('select'); log('type', appConfig.copy.log.notePlaced, 'note', undefined, id)
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
    onResetNorth: () => mapRef.current?.resetNorth(),
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
      const v: CameraView = { id: 'v' + Date.now(), name: formatTime(new Date()), center: view.center, zoom: view.zoom, bearing: view.bearing }
      setCameraViews((vs) => [...vs, v])
      toast(appConfig.copy.mapViews.saved, { icon: 'compass', tone: 'success' })
    },
    onRename: (id, name) => setCameraViews((vs) => vs.map((v) => (v.id === id ? { ...v, name: name || v.name } : v))),
    onDelete: async (id) => {
      const v = cameraViews.find((x) => x.id === id); if (!v) return
      const ok = await confirmDialog({ title: appConfig.copy.mapViews.deleteTitle, message: fillTemplate(appConfig.copy.mapViews.deleteMsg, { name: v.name }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (ok) setCameraViews((vs) => vs.filter((x) => x.id !== id))
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
  // separately selectable. Single symbol/shape/note OR single drawing; live GPS markers can't be
  // copied. Multi-select duplicate isn't wired (rare; would need per-item id remap).
  const DUP_OFFSET = 0.00008 // ~6–9 m in WGS84 at Swiss latitudes
  const duplicateSelection = () => {
    // tacticalLocked, not readOnly: the drawing branch below used to duplicate for real in the
    // Führungsansicht, where readOnly is false.
    if (tacticalLocked) return
    if (selectedId) {
      const src = doc.entities.find((e) => e.id === selectedId)
      if (!src || src.live || !Array.isArray(src.coord)) return
      const id = `p${Date.now()}`
      const copy: Entity = { ...src, id, coord: [src.coord[0] + DUP_OFFSET, src.coord[1] - DUP_OFFSET] }
      commit((d) => ({ ...d, entities: [...d.entities, copy] }))
      setSelectedId(id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
      log('layers', appConfig.copy.log.duplicated, 'symbol', undefined, id); emit('entity.add', { id, entity: copy })
    } else if (selectedDrawingId) {
      const src = doc.drawings.find((dr) => dr.id === selectedDrawingId)
      if (!src) return
      const id = `sh${Date.now()}`
      const copy: Drawing = { ...src, id, coords: src.coords.map(([x, y]) => [x + DUP_OFFSET, y - DUP_OFFSET] as LngLat) }
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
    // a modal sheet owns the screen — its own focus trap / Esc handle keys; stay inert behind it.
    if (settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || composerOpen) return
    const cmd = resolveHotkey(e)
    if (!cmd) return
    // An alignment session owns navigation on every form factor. The hidden NavRail must not
    // have a keyboard back door to another module or surface; only its own Karte/Modul pair
    // remains reachable until the operator deliberately finishes or cancels the task.
    if (georefActive && cmd.type === 'module') {
      e.preventDefault()
      const target = planDocs.find((p) => moduleNumbers(p).includes(cmd.n))
      if (target?.id === georefMode.planId) georefDispatch({ type: 'goPlan' })
      return
    }
    if (georefActive && cmd.type === 'nav') {
      e.preventDefault()
      return
    }
    if (georefActive && cmd.type === 'surface') {
      e.preventDefault()
      if (cmd.surface === 'map') georefDispatch({ type: 'goMap' })
      return
    }
    const onMap = mode === 'map', onPlan = mode === 'plans', drawing = onMap || onPlan
    switch (cmd.type) {
      case 'module': e.preventDefault(); goToModule(cmd.n); break
      case 'surface': e.preventDefault(); if (cmd.surface !== mode) clearMapUi(); setMode(cmd.surface); break
      case 'nav': e.preventDefault(); goToNav(cmd.dir); break
      case 'fit':
        e.preventDefault()
        if (onPlan) planFit.current?.(); else if (onMap) centerIncident()
        break
      case 'undo': e.preventDefault(); if (onPlan) planHist.current?.undo(); else undo(); break
      case 'redo': e.preventDefault(); if (onPlan) planHist.current?.redo(); else redo(); break
      case 'duplicate': if (onMap) { e.preventDefault(); duplicateSelection() } break
      case 'tool':
        // a locked surface keeps the keys for the tools it still shows (D = Messen, V = Auswahl)
        if (!drawing || (tacticalLocked && !isMapReadOnlyTool(cmd.tool)) || replayActive) break
        e.preventDefault()
        if (onMap) pick(cmd.tool); else planKeys.current?.pickTool(cmd.tool)
        break
      case 'panel':
        switch (cmd.panel) {
          case 'journal': e.preventDefault(); setJournalOpen((v) => !v); break
          case 'composer': if (!readOnly && !linkScoped) { e.preventDefault(); setComposerOpen(true) } break
          case 'layers': if (onMap) { e.preventDefault(); togglePanel('layers') } break
          case 'settings': if (!linkScoped) { e.preventDefault(); setSettingsOpen(true) } break
          case 'help': e.preventDefault(); setHelpOpen(true); break
        }
        break
      case 'view':
        switch (cmd.view) {
          case 'zoomIn': e.preventDefault(); if (onPlan) planKeys.current?.zoom(1.3); else mapRef.current?.zoomIn(); break
          case 'zoomOut': e.preventDefault(); if (onPlan) planKeys.current?.zoom(1 / 1.3); else mapRef.current?.zoomOut(); break
          case 'locate': if (onMap) { e.preventDefault(); setLocateReq((n) => n + 1) } break
          case 'coord': if (onMap) { e.preventDefault(); coord.cycle() } break
          // «Nach Norden» has no key — the compass button carries it on every form factor and
          // R went to the Rapport surface (see lib/hotkeys)
        }
        break
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

  // Projections open the same editor geometry as real objects and therefore obey the same calm
  // visibility rule. A twin near an edge must not disappear behind its own panel.
  useEffect(() => {
    if (!viewedMapTwin || mode !== 'map') return
    const raf = requestAnimationFrame(() => {
      const m = mapRef.current?.getMap()
      const panelEl = document.querySelector('.ctx')
      if (!m || !panelEl) return
      const work = mapWorkRect(m.getContainer().getBoundingClientRect(), panelEl)
      if (!work) return
      const pt = m.project(viewedMapTwin.coord)
      const nudge = nudgePointIntoRect(pt, work)
      if (nudge) m.panBy(nudge, { duration: motionDuration(350) })
    })
    return () => cancelAnimationFrame(raf)
  }, [viewedMapTwin?.key, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  // a marquee selects a SET of drawings: one falls back to the single-edit path, several
  // become a group (move/delete together). Empty box clears any selection. The lasso is a
  // one-shot tool: drop back to plain navigate (select) after the box so a stray next
  // finger pans the map instead of drawing another box.
  const onMarquee = (drawIds: string[], entIds: string[]) => {
    // live (GPS) entities aren't editable, so they never join an editable group
    const ents = entIds.filter((id) => !liveIds.has(id))
    const total = drawIds.length + ents.length
    setSelectedId(null)
    if (total <= 1) {
      // a single object → drop into the normal single-edit selection
      setSelectedDrawIds([]); setSelectedEntityIds([])
      setSelectedDrawingId(drawIds[0] ?? null)
      setSelectedId(ents[0] ?? null)
    } else {
      setSelectedDrawingId(null)
      setSelectedDrawIds(drawIds); setSelectedEntityIds(ents)
    }
    setTool('select')
  }
  // drag the group by a (lng,lat) delta applied to each member (drawings' coords + entities'
  // coord) from the snapshot taken at gesture start — the whole drag is one undo step.
  const groupOrig = useRef<{ draws: Record<string, LngLat[]>; ents: Record<string, LngLat> }>({ draws: {}, ents: {} })
  const moveGroup = (ids: string[], entIds: string[], dLng: number, dLat: number, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') {
      beginDrag()
      groupOrig.current = {
        draws: Object.fromEntries(ids.map((id) => [id, drawings.find((d) => d.id === id)?.coords ?? []])),
        ents: Object.fromEntries(entIds.map((id) => [id, entities.find((e) => e.id === id)?.coord ?? [0, 0]] as [string, LngLat])),
      }
      return
    }
    setDocRaw((d) => ({
      ...d,
      drawings: d.drawings.map((dr) => (ids.includes(dr.id) && groupOrig.current.draws[dr.id]
        ? { ...dr, coords: moveLineBody({ id: dr.id, points: groupOrig.current.draws[dr.id], startAttachment: dr.startAttachment, endAttachment: dr.endAttachment }, [dLng, dLat]) }
        : dr)),
      entities: d.entities.map((e) => (entIds.includes(e.id) && groupOrig.current.ents[e.id] ? { ...e, coord: [groupOrig.current.ents[e.id][0] + dLng, groupOrig.current.ents[e.id][1] + dLat] as LngLat } : e)),
    }))
    if (phase === 'end') {
      endDrag()
      groupOrig.current = { draws: {}, ents: {} }
    }
  }
  // a team marker that carries recorded positions is protected from deletion — its trail is
  // part of the incident record, so it must be cleared deliberately first (plan-board parity)
  const teamEntityLocked = (e: Entity | undefined) => e?.kind === 'team' && (e.trail?.length ?? 0) > 0
  const deleteGroup = async (ids: string[], entIds: string[]) => {
    if (tacticalLocked) return
    const ents = entIds.filter((id) => !liveIds.has(id) && !teamEntityLocked(entities.find((e) => e.id === id)))
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
      : appConfig.copy.log.drawingDeleted)
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
      entities: d.entities.map((e) => (e.id === id ? { ...e, coord: c } : e)),
      drawings: d.drawings.map((dr) => {
        if (dr.kind !== 'line') return dr
        let next = dr
        for (const endpoint of ['start', 'end'] as const) {
          const a = next[endpoint === 'start' ? 'startAttachment' : 'endAttachment']
          if (a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace') next = { ...next, coords: applyRouting(next.coords, endpoint, c, 'trace', 0.000008) }
        }
        return next
      }),
    }))
  }
  const finishEntityMove = (id: string, c: LngLat) => {
    if (tacticalLocked) return
    if (liveIds.has(id)) setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], coord: c } }))
    else {
      // a moved team marker re-stamps its «last moved» time; it does NOT breadcrumb
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, coord: c, ...(e.kind === 'team' ? { t: formatTime(new Date()) } : {}) } : e)) }))
      endDrag()
    }
    log('select', fillTemplate(appConfig.copy.log.objectMoved, { name: entities.find((x) => x.id === id)?.label ?? appConfig.copy.entities.fallbackObjectName }), 'symbol', undefined, id)
    emit(liveIds.has(id) ? 'entity.edit' : 'entity.move', { id, coord: c })
    drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace'))
      .forEach((d) => emit('draw.edit', { id: d.id, patch: { coords: d.coords } }))
  }
  /**
   * A projection on a Modul was dragged — move the object it mirrors.
   *
   * Deliberately the SAME three calls the Karte's own marker drag makes, in the same order: the
   * gesture writes the one source entity, so undo, trace-routed Leitungen, the audit event and the
   * Verlauf row cannot diverge depending on which picture the operator happened to have in front
   * of them. `startEntityMove`'s doc has described this as its second call site since the
   * Georeferenz landed; until 27.08. nothing actually called it that way, so a twin simply
   * ignored every drag and the sheet gave no reason why.
   *
   * A LIVE vehicle behaves exactly as it does on the Karte: `finishEntityMove` writes a position
   * override, which is «Festhalten» — the vehicle stops following the feed until «GPS» hands it
   * back. Dragging one here is the same statement as dragging it there.
   */
  const moveTwinSource = (entityId: string, coord: LngLat, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') startEntityMove(entityId)
    else if (phase === 'move') streamEntityMove(entityId, coord)
    else finishEntityMove(entityId, coord)
  }
  /**
   * A projection of a PLAN annotation was dragged on the Karte — move the source annotation.
   *
   * The mirror of `moveTwinSource`, and the same rule: the write lands on the one source, so the
   * plan and every projection of it agree without anybody reconciling them. `t.fit` is the sheet's
   * own fit, carried on the twin precisely so this fold-back cannot pick a different one.
   *
   * ⚠️ The undo step is pushed HERE rather than by the Whiteboard, because the Whiteboard is not
   * mounted: it lives only while `mode === 'plans'`, and this gesture happens on the Karte with
   * that sheet closed. The per-plan history survives that (it is keyed by plan id and owned up
   * here for exactly this reason — see useBoardDoc · BoardDocDeps), so the move is waiting to be
   * undone when the plan is next opened, checkpointed by the same rule the board itself uses.
   */
  // …for symbol twins AND the mirrored content marks (MapContentTwin): all name the one source
  // annotation the same way, and all write it through the same fold-back. A POINT (symbol, note,
  // shape, Trupp chip) writes x/y; a projected line/area translates every vertex by the drag's
  // plan-space delta (movedTwinPath) — whole-object only, vertex editing stays with the source.
  /** the live whole-path drag — anchored at the press, because the projection follows the source
   *  mid-drag and a delta added to the moving geometry would compound (GeorefTwinsBoard · from) */
  const twinPathDrag = useRef<{ pts: NonNullable<BoardAnno['pts']>; from: { x: number; y: number } } | null>(null)
  const moveMapTwinSource = (t: Pick<MapTwin, 'planId' | 'annoId' | 'fit'> & { anno: BoardAnno }, coord: LngLat, phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    const p = t.fit.toPlan({ lng: coord[0], lat: coord[1] })
    if ((t.anno.kind === 'draw' || t.anno.kind === 'area') && t.anno.pts?.length) {
      // one checkpoint + the anchor for the whole drag, on the first movement
      if (phase === 'start') {
        setPlanHistory((m) => pushBoardPast(m, t.planId, board[t.planId] ?? []))
        twinPathDrag.current = { pts: t.anno.pts, from: p }
        return
      }
      const st = twinPathDrag.current
      if (!st) return
      const pts = movedTwinPath(st.pts, st.from, p)
      setBoard((all) => ({ ...all, [t.planId]: (all[t.planId] ?? []).map((a) => (a.id === t.annoId ? { ...a, pts } : a)) }))
      if (phase !== 'end') return
      twinPathDrag.current = null
      const mid = pts[Math.floor((pts.length - 1) / 2)]
      pushEvent({
        icon: 'move', kind: 'symbol', surface: 'plan', planId: t.planId, annoId: t.annoId, px: mid[0], py: mid[1], floor: t.anno.floor,
        text: fillTemplate(appConfig.copy.log.objectMoved, { name: contentTwinName(t.anno) }),
      })
      emit('board.edit', { planId: t.planId, id: t.annoId, patch: { pts } })
      return
    }
    // one checkpoint for the whole drag, on the first movement — the map's own model
    if (phase === 'start') { setPlanHistory((m) => pushBoardPast(m, t.planId, board[t.planId] ?? [])); return }
    // clamped to the sheet: a plan point outside the paper is not a place on that document
    const x = Math.max(0, Math.min(1, p.x)), y = Math.max(0, Math.min(1, p.y))
    setBoard((all) => ({ ...all, [t.planId]: (all[t.planId] ?? []).map((a) => (a.id === t.annoId ? { ...a, x, y } : a)) }))
    if (phase !== 'end') return
    pushEvent({
      icon: 'move', kind: 'symbol', surface: 'plan', planId: t.planId, annoId: t.annoId, px: x, py: y, floor: t.anno.floor,
      text: fillTemplate(appConfig.copy.log.objectMoved, { name: twinName(t.anno) }),
    })
    emit('board.edit', { planId: t.planId, id: t.annoId, patch: { x, y } })
  }
  /** Ground width of a linked sheet in metres — converts the Hubretter reach across the
   *  Entity⇄BoardAnno boundary (georefTwins · planGroundWidthM). */
  const planWidthMFor = (planId: string, fit: GeorefFit) => {
    const planDoc = planDocs.find((p) => p.id === planId)
    return planDoc ? planGroundWidthM(fit, planAspect(planDoc, stationScales, planScale[planId])) : undefined
  }
  const transferPlanTwinToMap = (t: MapTwin) => {
    if (tacticalLocked || doc.entities.some((e) => e.id === t.annoId)) return
    const entity = boardSymbolToEntity(t.anno, t.coord, appConfig.defaults.operationalLayerId, planWidthMFor(t.planId, t.fit))
    if (!entity) return
    const annos = board[t.planId] ?? []
    // The object is leaving this sheet, so plan Leitungen anchored to it are let go exactly as a
    // DELETE lets them go: the endpoint stays pinned where the symbol stood and the attachment is
    // cleared. Filtering the anno out alone left lines pointing at an id no longer on the board —
    // «Verbunden mit» printed the raw id and trace-routing silently stopped (lib/georefTwinEdit).
    const removal = deleteBoardTwinSource(annos, t.annoId)
    if (!removal) return
    const detachedOriginals = annos.filter((a) => removal.affectedIds.includes(a.id))
    setPlanHistory((m) => pushBoardPast(m, t.planId, annos))
    setBoard((all) => ({ ...all, [t.planId]: removal.next }))
    setDocRaw((d) => ({ ...d, entities: [...d.entities, entity] }))
    setTwinView(null); setSelectedId(entity.id)
    // A transfer is a committed domain action — the object is somewhere else now — so it leaves a
    // Verlauf row and an audit event like every other one. Without them a symbol could move
    // between Modul and Karte and appear in NO record: not the Verlauf, not the Rapport, not the
    // hash chain. See AGENTS.md on what the event log is for.
    // ⚠️ BOTH halves are that record: replay folds board.* and entity.* alike, and with only the
    // `entity.add` the reconstructed picture kept the symbol on the plan beside its new map copy.
    log('move', fillTemplate(appConfig.copy.log.twinTransferredToMap, { name: twinName(t.anno) }), 'symbol', undefined, entity.id)
    emit('board.delete', { planId: t.planId, id: t.annoId })
    removal.affectedIds.forEach((id) => {
      const changed = removal.next.find((n) => n.id === id)
      if (changed) emit('board.edit', { planId: t.planId, id, patch: { pts: changed.pts, startAttachment: changed.startAttachment, endAttachment: changed.endAttachment } })
    })
    emit('entity.add', { entity })
    toast(fillTemplate(appConfig.copy.contextPanel.transferredHere, { name: twinName(t.anno) }), {
      icon: 'move',
      action: {
        label: appConfig.copy.undo,
        onClick: () => {
          setDocRaw((d) => ({ ...d, entities: d.entities.filter((e) => e.id !== entity.id) }))
          // the symbol comes back AND so do its Leitungen — an undo that restored the anno but
          // left the hose lines detached would be a different sheet from the one before the tap
          setBoard((all) => ({
            ...all,
            [t.planId]: [
              ...(all[t.planId] ?? []).filter((a) => a.id !== t.annoId)
                .map((a) => detachedOriginals.find((o) => o.id === a.id) ?? a),
              t.anno,
            ],
          }))
          setSelectedId(null)
          emit('entity.delete', { id: entity.id })
          emit('board.add', { id: t.annoId, anno: t.anno, planId: t.planId })
          detachedOriginals.forEach((o) => emit('board.edit', { planId: t.planId, id: o.id, patch: { pts: o.pts, startAttachment: o.startAttachment, endAttachment: o.endAttachment } }))
        },
      },
    })
  }
  const transferMapTwinToPlan = (entity: Entity, planId: string, pt: { x: number; y: number }) => {
    if (tacticalLocked || entity.live || (board[planId] ?? []).some((a) => a.id === entity.id)) return
    const targetFit = linkedPlans.find((p) => p.id === planId)?.fit
    const anno = entityToBoardSymbol(entity, pt, targetFit ? planWidthMFor(planId, targetFit) : undefined)
    if (!anno) return
    // ⚠️ Leitungen anchored to this object have to be let go, exactly as `deleteEntity` lets them
    // go: the object is leaving the Karte, so an attachment pointing at it would name an id that
    // is no longer there. The endpoint is pinned where the object stood, so the drawn line does
    // not jump. Without this the «Verbunden mit» row fell back to printing the raw id
    // (DrawEditor · attachmentLabels) and trace-routing silently stopped working for good.
    const connected = drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === entity.id))
    setPlanHistory((m) => pushBoardPast(m, planId, board[planId] ?? []))
    setDocRaw((d) => ({
      ...d,
      entities: d.entities.filter((e) => e.id !== entity.id),
      drawings: d.drawings.map((dr) => detachDrawingFrom(dr, entity)),
    }))
    setBoard((all) => ({ ...all, [planId]: [...(all[planId] ?? []), anno] }))
    setSelectedId(null); setTwinView(null)
    log('move', fillTemplate(appConfig.copy.log.twinTransferredToPlan, { name: twinName(entity) }), 'symbol', undefined, entity.id)
    // ⚠️ Both halves, for the same reason as transferPlanTwinToMap: with only the `entity.delete`
    // the replayed picture had the symbol on NEITHER surface after a transfer.
    emit('entity.delete', { id: entity.id })
    emit('board.add', { id: anno.id, anno, planId })
    connected.forEach((dr) => {
      const next = detachDrawingFrom(dr, entity)
      emit('draw.edit', { id: dr.id, patch: { coords: next.coords, startAttachment: next.startAttachment, endAttachment: next.endAttachment } })
    })
    setPlanFocus({ x: pt.x, y: pt.y, floor: 0, annoId: anno.id, nonce: Date.now() })
    toast(fillTemplate(appConfig.copy.contextPanel.transferredHere, { name: twinName(entity) }), {
      icon: 'move',
      action: {
        label: appConfig.copy.undo,
        onClick: () => {
          setBoard((all) => ({ ...all, [planId]: (all[planId] ?? []).filter((a) => a.id !== anno.id) }))
          // the object comes back AND so do its Leitungen — an undo that restored the symbol but
          // left the hose lines loose would be a different picture from the one before the tap
          setDocRaw((d) => ({
            ...d,
            entities: d.entities.some((e) => e.id === entity.id) ? d.entities : [...d.entities, entity],
            drawings: d.drawings.map((dr) => connected.find((c) => c.id === dr.id) ?? dr),
          }))
          emit('entity.add', { entity })
          emit('board.delete', { planId, id: anno.id })
          connected.forEach((dr) => emit('draw.edit', { id: dr.id, patch: { coords: dr.coords, startAttachment: dr.startAttachment, endAttachment: dr.endAttachment } }))
        },
      },
    })
  }
  /** Every Trupp standing somewhere on this Einsatz — Lage markers AND plan chips, Atemschutz
   *  or not (lib/placedTrupps). Feeds the rail's count and the finder's list. */
  const placed = useMemo(() => placedTrupps(entities, board, planDocs, trupps), [entities, board, planDocs, trupps])
  /**
   * Go to the picked Trupp. ⚠️ The SAME two jumps «auf Plan zeigen» makes from the Atemschutz
   * card (useTruppActions · focusTruppOnPlan) — a second way to arrive at a marker would be a
   * second set of rules about what «zeigen» leaves behind: the map jump selects the marker, the
   * plan jump opens its storey and points at the chip.
   */
  /**
   * Tap on a Georeferenz twin — the SAME two jumps `goToTrupp` makes, for the same reason: a
   * twin answers «where is this really?», and there must be exactly one set of rules for what
   * arriving there leaves behind. A twin is never selected; it can also be dragged in place,
   * and that drag writes its source through the helpers above.
   */
  // …for symbol twins AND the mirrored content marks (MapContentTwin) — all name their source
  // annotation the same way, and the jump is the same jump. It is the panel's explicit «Zum
  // Original» now, never the tap itself (E8): tapping a projection opens in place.
  const goToTwinSource = (t: Pick<MapTwin, 'planId' | 'annoId'> & { anno: Pick<BoardAnno, 'x' | 'y' | 'floor' | 'pts'> }) => {
    setPanel(null); setContentTwinView(null)
    setMode('plans'); setActivePlanId(t.planId)
    // a path annotation has no x/y of its own — point at its middle vertex instead
    const mid = t.anno.pts?.length ? t.anno.pts[Math.floor((t.anno.pts.length - 1) / 2)] : undefined
    setPlanFocus({ x: t.anno.x ?? mid?.[0] ?? 0.5, y: t.anno.y ?? mid?.[1] ?? 0.5, floor: t.anno.floor ?? 0, annoId: t.annoId, nonce: Date.now() })
  }
  /** the actual surface swap to a mirrored Karte object's source — the panel's «Zum Original» */
  const jumpToTwinSourceOnMap = (e: Entity) => {
    const layer = effectiveLayer(e)
    if (!isVisible(layer)) toggleLayer(layer)
    setPanel(null); setPlanTwinEntityId(null); setMode('map'); focusEntity(e.id)
  }
  /**
   * Tap on a mirrored Karte object on the Plan. A content mark (team chip, note, shape) opens
   * its in-place source-backed panel HERE — the abrupt surface swap read as a bug (E8) — with
   * «Zum Original» as the explicit jump. Whiteboard's own symbol/vehicle twin panel still calls
   * this from ITS «Zum Original», so those kinds keep jumping directly.
   */
  const goToTwinOnMap = (e: Entity) => {
    if (e.kind === 'team' || e.kind === 'note' || e.kind === 'shape') { setPanel(null); setPlanTwinEntityId(e.id); return }
    jumpToTwinSourceOnMap(e)
  }
  // the plan-side panel's live source — re-derived per render so edits/deletes follow through
  const planTwinEntity = planTwinEntityId ? entities.find((e) => e.id === planTwinEntityId) ?? null : null
  // leaving the Plan surface closes its twin panel; coming back must not resurrect a stale one
  useEffect(() => { if (mode !== 'plans') setPlanTwinEntityId(null) }, [mode])
  const showMapSourceOnPlan = (entity: Entity, target = selectedPlanProjection) => {
    if (!target) return
    showTwinLayer(entity.kind === 'vehicle' ? TWIN_MAP_VEHICLES : TWIN_MAP_SYMBOLS)
    setPanel(null); setMode('plans'); setActivePlanId(target.plan.id)
    setPlanFocus({ x: target.pt.x, y: target.pt.y, floor: 0, twinEntityId: entity.id, nonce: Date.now() })
  }
  const showPlanSourceOnMap = (planId: string, annoId: string, coord: LngLat) => {
    showTwinLayer(twinPlanLayerId(planId))
    setPanel(null); setMode('map')
    const twin = mapTwinList.find((t) => t.planId === planId && t.annoId === annoId)
    if (twin) openTwinView(twin)
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
    // a trail-carrying team stays: clear the trail deliberately first (plan-board parity)
    if (teamEntityLocked(ent)) { toast(appConfig.copy.whiteboard.deleteLocked, { icon: 'warn', tone: 'warn' }); return false }
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
      entities: d.entities.filter((e) => e.id !== id),
      // the same detach «Hierher übertragen» performs — see detachDrawingFrom
      drawings: ent ? d.drawings.map((dr) => detachDrawingFrom(dr, ent)) : d.drawings,
    }))
    if (selectedId === id) setSelectedId(null)
    if (editNoteId === id) setEditNoteId(null)
    log('close', fillTemplate(appConfig.copy.log.objectDeleted, { name: ent?.label ?? appConfig.copy.entities.fallbackObjectName }))
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
    // linked Modul chips count into the numbering — their mirror stands on this map
    mirroredTeamNames: () => linkedPlans.flatMap((p) => (board[p.id] ?? []).filter((a) => a.kind === 'resource').map((a) => a.text ?? '')),
  })
  // --- Atemschutzüberwachung (SCBA monitoring): Trupp mutations live in useTruppActions ---
  const { createTrupp, updateTrupp, moveTrupp, placeTruppOnPlan, placeTruppOnMap, adoptTruppMarker, releaseTruppMarker, askTruppEntry, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, logTruppAlarm, deleteTrupp, restoreTrupp, linkTruppLine, unlinkTruppLine, unlinkLine, syncLineNoToTrupp, showTruppLine, truppsWithLine, truppLineNos, truppColors, setTruppColor } =
    useTruppActions({
      trupps, drawings, entities, setTrupps, board, setBoard, setDocRaw, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus,
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
  // where a Trupp can actually go: always the Lage map (outdoor teams), plus the Gebäude
  // floor-stack ONLY once it's been created from the Umrisse (building != null), plus Modul 6
  // ONLY if this object has that plan. ≥1 target always — the picker adapts (1 → place
  // directly, 2+ → choose).
  const placeTargets = useMemo(() => {
    const t: { id: string; label: string }[] = [{ id: LAGE_TARGET, label: appConfig.copy.atemschutz.placeLage }]
    if (building) t.push({ id: gebaeudeDoc.id, label: gebaeudeDoc.code })
    const m6 = planDocs.find((p) => p.id === 'modul6')
    if (m6) t.push({ id: m6.id, label: m6.code })
    return t
  }, [building, planDocs])
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
  // «Leitung wählen»: arm the pick and leave the Atemschutz board for the Lage — there is nothing
  // to tap on the board itself. The arming survives a surface switch, so a hose drawn on a plan is
  // just as reachable. The toast carries the way out (no modal, no trapped state).
  const pickTruppLine = (id: string) => {
    const az = appConfig.copy.atemschutz
    setLinePickTrupp(id)
    setMode('map')
    // land in Auswahl: with a draw tool still active from earlier, the aiming tap would start a
    // new line instead of picking the one that is already there
    setTool('select'); setPending(null); setPendingShape(null); setDraft([])
    toast(az.linePickHint, { icon: 'drop', action: { label: az.linePickCancel, onClick: () => setLinePickTrupp(null) } })
  }
  // A tap that did NOT land on a hose (a Fläche, the Absperrkreis, a freehand stroke) leaves the
  // pick armed: the operator aimed and missed, and disarming here would look like the feature
  // silently failed. The toast's «Abbrechen» is the way out.
  const onLinePicked = (lineId: string) => {
    if (!linePickTrupp) return
    if (linkTruppLine(linePickTrupp, lineId)) setLinePickTrupp(null)
  }
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
  const attHist = useUndoableSlice(attendance, setAttendance, readOnly)
  attHistClear.current = attHist.clear
  // …and what each person's Bemerkung said, for as long as this incident is open here. The record
  // loses it when a row is cycled to «frei» (the entry goes, as it must); this is what puts it back
  // when the same person is ticked present again — see useAttendanceActions · noteMemory. Per
  // incident by construction: this component remounts with the incident.
  const attNotes = useRef<Record<string, string>>({})
  const { markPresent, markLeft, clearAttendance, setAttendanceTimes, removeAttendanceBlock, setAttendanceNote, setAttendanceOrt, addGuest } = useAttendanceActions({
    attendance, setAttendance: attHist.set, blockedAttendanceIds, noteMemory: attNotes,
    startedAt: incidentMeta.started_at, reportDoneAt: incidentMeta.report_done_at, log,
  })
  /** Step the Anwesenheit back or forward and SAY SO in the Verlauf. The record is append-only, so
   *  the tap's own row stands; this adds the correction beside it, naming whoever moved — which is
   *  the only thing a reader six months later needs from it. */
  const stepAttendance = (dir: 'undo' | 'redo') => {
    const moved = dir === 'undo' ? attHist.undo() : attHist.redo()
    if (!moved) return
    const names = changedAttendanceNames(moved.from, moved.to, rosterById)
    const A = appConfig.copy.anwesenheit
    // ⚠️ icon 'people', not 'undo'. The Bereich column and the Verlauf chip are derived from the
    // icon (lib/report · journalArea) and 'undo' is the Atemschutz-Rückzug's icon — so every
    // «Anwesenheit zurückgenommen» printed under «Atemschutz», on a sheet whose whole job is
    // saying where a row came from. The undo-ness is in the sentence; the icon says the surface.
    log('people', fillTemplate(dir === 'undo' ? A.undone : A.redone, { names: names.join(', ') || '–' }), 'team')
    emit(dir)
  }
  const { saveMittel } = useMittelActions({ mittel, setMittel, authorName: user?.display_name, log })
  // Symbol→Mittel moved OUT of the symbol's card (28.08.): the Material surface itself now shows
  // the «Gesetzt, aber nicht erfasst» strip, fed with every symbol standing on Lage + all plans.
  // The «has this station mapped anything» gate lives inside mittelRecommendations.
  const placedSymbols = useMemo(
    () => [...doc.entities, ...Object.values(board).flat()]
      .filter((x) => !!x.symbol && !(x as { live?: boolean }).live)
      .map((x) => ({ symbol: x.symbol as string, fields: x.fields, extract: x.extract })),
    [doc.entities, board],
  )
  // Schichtenplanung — a PLAN over the same Mannschaft; it never writes the attendance record
  const { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift } = useShiftActions({ shifts, setShifts, startedAt: incidentMeta.started_at })
  // …and the Schichten reading of it: the same shifts, grouped into named windows. Creating a band
  // writes no shift, deleting one deletes no shift — see useBandActions.
  const bandActions = useBandActions({ bands, setBands, shifts, setShifts })
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
    const byId = new Map(linkedTrupps.map((t) => [t.id, t.name]))
    return new Map([...truppOfPerson].map(([personId, truppId]) => [personId, byId.get(truppId) ?? '']))
  }, [truppOfPerson, linkedTrupps])
  const journalVocab = useMemo(
    () => journalVocabulary(pickablePersonnel, attendance, truppNameOfPerson),
    [pickablePersonnel, attendance, truppNameOfPerson],
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
  /** person id → the job they already hold on this Einsatz, read off their Anwesenheits-Bemerkung
   *  («Einsatzleiter», «Fahrer TLF», «Offizier SiBe»). ⚠️ ONE map, handed to EVERY person picker.
   *  The Atemschutz board built its own and the Rapport's Einsatzleiter/Rückmeldung pickers had
   *  none, so the same roster read differently depending on which screen you opened it from —
   *  and the picker that most needs to say «this one is already leading» was the silent one. */
  const rolesById = useMemo(
    () => new Map(
      Object.entries(attendance)
        .map(([id, a]) => [id, (a.note ?? '').trim()] as const)
        .filter(([, note]) => note.length > 0),
    ),
    [attendance],
  )
  // present crew (attendance) — offered first in the Einsatzleiter picker (mirrors Atemschutz)
  const presentIds = useMemo(() => new Set(Object.entries(attendance).filter(([, a]) => isPresent(a)).map(([id]) => id)), [attendance])

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

  const ensurePresentForRole = (ids: (string | undefined)[], roleNote?: string) => {
    const wanted = [...new Set(ids.filter(Boolean) as string[])]
    const fresh = wanted.filter((id) => !isPresent(attendance[id]))
    // ⚠️ APPEND, don't fill-if-empty: one person routinely holds two jobs, and the Fahrer who
    // then goes under Atemschutz is «Fahrer Pio, AS». See lib/roleAssignment · mergeRoleNote for
    // when a part replaces an earlier one instead of joining it.
    const needNote = roleNote
      ? wanted.filter((id) => mergeRoleNote(attendance[id]?.note, roleNote) !== (attendance[id]?.note ?? '').trim())
      : []
    if (!fresh.length && !needNote.length) return
    // through the history, like every other write to this slice — being made Fahrer or EL puts
    // somebody on the Anwesenheit, and «that was the wrong name» is the same mistake as a tap
    attHist.set((cur) => {
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
      for (const id of needNote) if (next[id]) next[id] = { ...next[id], note: mergeRoleNote(next[id].note, roleNote!), noteAt: at }
      return next
    })
    // ONE row per person, not one for the presence and a second for the remark: naming a Fahrer
    // is a single act, and «Meier Anna anwesend» followed by «Meier Anna – Bemerkung: Fahrer TLF»
    // reads like two things happened to her.
    const A = appConfig.copy.anwesenheit
    const noted = new Set(needNote)
    for (const id of fresh) {
      const name = rosterById.get(id)?.displayName ?? id
      log('people', noted.has(id) && roleNote
        ? fillTemplate(A.logPresentAs, { name, role: roleNote })
        : `${name} anwesend`, 'team')
    }
    // somebody already on the list who has just been given the job: the role is the news
    for (const id of needNote) {
      if (fresh.includes(id)) continue
      log('people', fillTemplate(A.logNote, { name: rosterById.get(id)?.displayName ?? id, note: roleNote ?? '–' }), 'team')
    }
  }
  /** ⚠️ Being in a Trupp is a JOB, and the Anwesenheit should say so. It marked the crew present
   *  and wrote nothing, so the list — and the Personalblatt printed from it — could not tell an
   *  AdF who stood at the Magazin from one who was under Atemschutz. The link already existed in
   *  one direction (the Trupp picker says «unter AS» about somebody on the list); this is the
   *  same fact read the other way round. Like every auto-Bemerkung it only fills an EMPTY one,
   *  so anything typed by hand survives. */
  const ensurePresentFromTrupp = (ids: (string | undefined)[]) =>
    ensurePresentForRole(ids, appConfig.copy.anwesenheit.roleAtemschutz)

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
    const before = prev.fields ?? {}
    // ⚠️ A changed FUNKTION has to reach the person too, and the name beside it did not move —
    // so «Meier, SiBe» corrected to «Meier, Atemschutz» would otherwise leave the Anwesenheit
    // saying SiBe forever. The job is what this field records; re-file the name when it changes.
    // `force` = the SYMBOL changed rather than a field — its label is part of what the Bemerkung
    // says, so the same names have to be re-filed against the new one.
    const jobChanged = opts?.force
      || Object.entries(fields).some(([k, v]) => !ROSTER_FIELDS.includes(k) && before[k] !== v)
    for (const [k, v] of Object.entries(fields)) {
      if (!ROSTER_FIELDS.includes(k) || !v.trim()) continue
      if (before[k] === v && !jobChanged) continue
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
  const editMapTwinSource = (id: string, patch: Partial<Entity>, phase: 'live' | 'commit' = 'commit') => {
    if (tacticalLocked || liveIds.has(id)) return
    const before = doc.entities.find((e) => e.id === id)
    if (!before) return
    if (phase === 'live') {
      if (!titleLiveRef.current) { titleLiveRef.current = true; beginDrag() }
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
      return
    }
    if (patch.label != null && titleLiveRef.current) {
      titleLiveRef.current = false
      endDrag()
      emit('entity.edit', { id, patch })
    } else patchEntity(id, patch)
    if (patch.fields) linkRosterFields(before, patch.fields)
    if (patch.label != null) linkRosterFields({ ...before, label: patch.label }, before.fields ?? {}, { force: true })
  }

  /** Edit a plan-owned annotation through its Lage projection (a symbol twin's full editor, or
   *  a mirrored Notiz's text). The plan's history lives above the unmounted Whiteboard, so this
   *  is the same checkpoint/raw-write/audit split as useBoardDoc. */
  const editPlanTwinSource = (t: Pick<MapTwin, 'planId' | 'annoId'> & { coord?: LngLat }, patch: Partial<BoardAnno>, phase: 'live' | 'commit' = 'commit') => {
    if (tacticalLocked) return
    const current = (board[t.planId] ?? []).find((a) => a.id === t.annoId)
    if (!current) return
    const liveKey = `${t.planId}:${t.annoId}`
    if (phase === 'live') {
      if (planTwinTitleLive.current !== liveKey) {
        setPlanHistory((m) => pushBoardPast(m, t.planId, board[t.planId] ?? []))
        planTwinTitleLive.current = liveKey
      }
      setBoard((all) => ({ ...all, [t.planId]: patchBoardTwinSource(all[t.planId] ?? [], t.annoId, patch) }))
      return
    }
    const wasLive = planTwinTitleLive.current === liveKey
    planTwinTitleLive.current = null
    if (!wasLive) setPlanHistory((m) => pushBoardPast(m, t.planId, board[t.planId] ?? []))
    setBoard((all) => ({ ...all, [t.planId]: patchBoardTwinSource(all[t.planId] ?? [], t.annoId, patch) }))
    emit('board.edit', { planId: t.planId, id: t.annoId, patch })
    const source = { ...current, kind: 'symbol' as const, layer: appConfig.defaults.operationalLayerId, coord: t.coord ?? ([0, 0] as LngLat), floor: current.storey } as Entity
    if (patch.fields) linkRosterFields(source, patch.fields)
    if (patch.label != null) linkRosterFields({ ...source, label: patch.label }, current.fields ?? {}, { force: true })
  }

  /** Delete a plan-owned source without navigating away. Attached plan lines are detached and
   *  frozen at the symbol's current plan coordinate, so no dangling object id survives. */
  const deletePlanTwinSource = async (t: Pick<MapTwin, 'planId' | 'annoId'>) => {
    if (tacticalLocked) return
    const annos = board[t.planId] ?? []
    const target = annos.find((a) => a.id === t.annoId)
    if (!target) return
    const affected = annos.filter((a) => [a.startAttachment, a.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === target.id))
    if (affected.length) {
      const ok = await confirmDialog({
        title: fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: target.label ?? appConfig.copy.drawingEditor.drawing }),
        message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }),
        confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
      })
      if (!ok) return
    }
    setPlanHistory((m) => pushBoardPast(m, t.planId, annos))
    const result = deleteBoardTwinSource(annos, target.id)
    if (!result) return
    setBoard((all) => ({ ...all, [t.planId]: result.next }))
    setTwinView(null); setContentTwinView(null)
    emit('board.delete', { planId: t.planId, id: t.annoId })
    result.affectedIds.forEach((id) => {
      const changed = result.next.find((n) => n.id === id)
      if (changed) emit('board.edit', { planId: t.planId, id, patch: { pts: changed.pts, startAttachment: changed.startAttachment, endAttachment: changed.endAttachment } })
    })
  }
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
  const createTruppA = (t: Trupp) => { createTrupp(canonTrupp(t)); ensurePresentFromTrupp([t.leaderPersonId, ...(t.memberPersonIds ?? [])]) }
  const editTruppA = (id: string, f: TruppFields) => { editTrupp(id, canonTrupp(f)); ensurePresentFromTrupp([f.leaderPersonId, ...(f.memberPersonIds ?? [])]) }
  // `standby` MUST be forwarded: this wrapper used to swallow it, so «Bereitstellen» ran the
  // «Wieder einrücken» path — a crew standing at the vehicle with a running contact clock, which
  // is exactly the case the standby fork exists to prevent (see useTruppActions · reactivateTrupp).
  const reactivateTruppA = (id: string, f: TruppFields, standby?: boolean) => { reactivateTrupp(id, canonTrupp(f), standby); ensurePresentFromTrupp([f.leaderPersonId, ...(f.memberPersonIds ?? [])]) }

  // --- checklists ---
  // Ticking is field documentation, not tactical editing, so it's gated by ROLE
  // (editor, incl. on a phone) rather than tacticalLocked — but still blocked for
  // true viewers and during replay. Presence in `ticks` = checked.
  const canTick = canEditIncident
  const { toggleTick, setBranch } = useChecklistActions({ canTick, checklists, setChecklists, authorName: user?.display_name, log, emit })
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
  const detailSlotFree = mapUI && !twinView && !contentTwinView && !journalOpen && panel === null && !viewsOpen

  const annotatedPlanCount = useMemo(() => annotatedPlans(planDocs, board, false, printTwinAnnos).length, [planDocs, board, printTwinAnnos])

  // `maptool-<tool>` on the root drives the map cursor (see .maptool-* in app.css) the way the
  // plan canvas's own `tool-<tool>` does. Gated on mapUI so an armed tool can never leak a
  // crosshair onto Checkliste, Atemschutz or the plan.
  return (
    <div className={`app mode-${mode}${phoneTools ? ' phone-tools' : ''}${georefActive ? ' georef-mode' : ''}${phoneGeoref ? ' phone-georef' : ''}${mapUtility ? ' map-util' : ''}${mapUI ? ` maptool-${tool}` : ''} ${(tool === 'symbol' && pending) || (tool === 'shape' && pendingShape) ? 'placing' : ''}`}>
      <IconSprite />
      <AtemschutzAlarmHost trupps={trupps} muted={atemschutzMuted} active={!replayActive}
        logAlarm={logTruppAlarm} intervalMin={azIntervalMin} graceSec={azGraceSec} onState={setAzAlarm} />

      {sym.ready ? (
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
          onNotePanel={(id) => { setTwinView(null); setContentTwinView(null); setNotePanelId(id) }}
          onNoteWidth={tacticalLocked ? undefined : noteWidthDrag}
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
          onTeamMark={tacticalLocked ? undefined : markTeamPosition}
          onTeamRename={tacticalLocked ? undefined : renameTeam}
          // a marker bound to a Trupp paints the TRUPP (board card + plan chip follow); a loose
          // team marker has no Trupp to write, so it just takes the colour itself
          onTeamColor={tacticalLocked ? undefined : (e, c) => {
            if (e.truppId) setTruppColor(e.truppId, c)
            else patchEntity(e.id, { color: c ?? undefined })
          }}
          onTeamClearTrail={tacticalLocked ? undefined : clearTeamTrail}
          preparedOverlays={preparedOverlays}
          // Georeferenz twins: every linked plan's symbols, mirrored onto the map. Read-only,
          // and never part of `entities` — a twin must not be selectable, printable or countable
          // anywhere (see components/GeorefTwinMark).
          twins={mapTwinList}
          georefPlanContent={mapContentTwinList}
          onTwinOpen={openTwinView}
          onTwinMove={moveMapTwinSource}
          onContentTwinOpen={openContentTwinView}
          onContentTwinMove={moveMapTwinSource}
          // round 8 (full 1:1): node pads / «+» / hold-delete on a selected mirrored plan
          // drawing write straight to the one source annotation, with per-plan undo history
          onContentTwinEdit={(t, patch, phase) => editPlanTwinSource(t, patch, phase)}
          selectedTwinKey={twinView?.key}
          selectedContentTwinKey={contentTwinView?.key}
          georefPlanRasters={georefPlanRasters}
          isVisible={isVisible}
          selectedId={selectedId}
          onSelect={(e) => { setTwinView(null); setContentTwinView(null); setSelectedId(e.id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }}
          onMapClick={onMapClick}
          drawings={drawings}
          drawingsVisible={isVisible(appConfig.defaults.drawingLayerId)}
          draft={draft}
          draftKind={tool === 'area' ? 'area' : lineNodes ? 'line' : null}
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
          picking={coord.mode === 'aim'}
          onCursor={coord.setAim}
          onPick={(c) => {
            coord.setPicked(c); coord.setAim(null)
            coord.setMode('set')
          }}
          pickedPoint={coord.mode === 'set' ? coord.picked : null}
          freehand={tool === 'line' && lineMode === 'freehand'}
          onFreehand={onFreehand}
          circleEnabled={tool === 'circle' && !tacticalLocked}
          onCircle={createCircle}
          drawColor={drawColor}
          drawWidth={drawWidth}
          drawDashed={drawDashed}
          selectedDrawingId={selectedDrawingId}
          flashDrawingId={flashDrawingId}
          onSelectDrawing={(id, at) => {
            setTwinView(null); setContentTwinView(null)
            // «Leitung wählen» armed → this tap assigns the hose to the waiting Trupp
            if (linePickTrupp) { onLinePicked(id); return }
            // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for
            // a drawing too big for its bounds to mean anything. Any other way into the selection
            // (Verlauf jump, a just-finished stroke) leaves a stale id here and is simply ignored.
            setDrawTap(at ? { id, x: at.x, y: at.y } : null)
            setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
          }}
          onUnlockDrawing={tacticalLocked ? undefined : (id) => { setTwinView(null); setContentTwinView(null); patchDrawingById(id, { locked: undefined }); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null) }}
          onDelete={deleteEntity}
          selectedDrawing={selectedDrawing}
          onDrawingEdit={editDrawingCoords}
          onDrawingVertexInsert={insertDrawingVertex}
          onDrawingVertexDelete={deleteDrawingVertex}
          onDrawingDelete={deleteDrawing}
          onDrawingAttachment={setDrawingAttachment}
          onLabelMove={tacticalLocked ? undefined : moveLabel}
          marqueeEnabled={tool === 'lasso' && !tacticalLocked && coord.mode === 'off'}
          selectedDrawIds={selectedDrawIds}
          selectedEntityIds={selectedEntityIds}
          onMarquee={onMarquee}
          onGroupMove={moveGroup}
          onGroupDelete={deleteGroup}
        />
      ) : (
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
        // ⚠️ One pair, wherever you are — and it always means «take back what you last did HERE».
        // Each surface keeps its OWN stack, so stepping back in the Anwesenheit can never reach
        // into the map's document, and switching surfaces changes what ↶ points at rather than
        // what it does.
        onUndo={mode === 'plans' ? () => planHist.current?.undo() : mode === 'anwesenheit' ? () => stepAttendance('undo') : undo}
        onRedo={mode === 'plans' ? () => planHist.current?.redo() : mode === 'anwesenheit' ? () => stepAttendance('redo') : redo}
        canUndo={mode === 'plans' ? planCan.canUndo : mode === 'anwesenheit' ? attHist.canUndo : canUndo}
        canRedo={mode === 'plans' ? planCan.canRedo : mode === 'anwesenheit' ? attHist.canRedo : canRedo}
        // …and it is only offered where there IS something to step through. On the remaining
        // surfaces (Checklisten, Mittel, Atemschutz, Rapport) it would still be the map's document
        // being changed invisibly, so the pair and its separator stay hidden there.
        showHistory={!tacticalLocked && (mode === 'map' || mode === 'plans' || mode === 'anwesenheit')}
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
        // On the phone map surface the floating compass cluster already carries Einpassen
        // (== centerIncident) + Mein Standort, so a top-bar center button here would just
        // duplicate it AND crowd the narrow bar off its right edge (clipping the Atemschutz
        // alarm chip). Plan has no compass cluster, so it keeps its Einpassen button here.
        mapNav={!isPhone ? null
          : mode === 'plans' ? { action: { icon: 'cross', label: appConfig.copy.nav.fit, onClick: () => planFit.current?.() } }
          : null}
        titleSlot={
          <IncidentSwitcher
            active={incidentMeta}
            incidents={incidents}
            isEditor={isEditor}
            syncStatus={syncStatus}
            lastSyncedAt={lastSyncedAt}
            user={{ display_name: user?.display_name ?? '', color: user?.color ?? null, role: user?.role ?? 'viewer' }}
            onSettings={linkScoped ? undefined : () => setSettingsOpen(true)}
            onSwitch={onSwitchIncident}
            onHistory={linkScoped ? undefined : onOpenHistory}
            onEditMeta={canEditIncident && !readOnly ? onEditMeta : undefined}
            onDivera={onOpenDivera}
            onDatenquellen={onOpenDatenquellen}
            // Einsatzrapport (PDF + Drucken) and «Alle Einsätze» are both refused for a link
            // session — one generates a document with everyone's names, the other lists the
            // Einsätze this link has nothing to do with.
            // ⚠️ The SAME confirm the Rapport runs, with the same count in front of it — this row
            // used to archive plainly (see confirmAndComplete). The badge puts the check where it
            // can be read before the row is pressed, not only after.
            onArchive={canEditIncident && !readOnly && !incidentMeta.is_archived ? () => { void confirmAndComplete() } : undefined}
            archiveOpenCount={abschlussMissing.length}
            onHelp={() => setHelpOpen(true)}
            onInstall={isStandalone() || !installOffered(getInstallPlatform()) ? undefined : () => setInstallGuideOpen(true)}
            onOfflineReadiness={() => setOfflineReadyOpen(true)}
            onSyncNow={syncNow}
            // a link session has no login to leave (and no way back in) — see App's landing card
            onLogout={linkScoped ? undefined : () => { void logout() }}
            navKey={`${mode}|${journalOpen ? 'journal' : ''}`}
            sheetOpen={settingsOpen || helpOpen || installGuideOpen || offlineReadyOpen}
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
      <AtemschutzAlarmMeldungen
        trupps={trupps}
        severities={azAlarm.severities}
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
        activePlanId={activePlanId}
        onSelectPlan={(id) => { if (mode !== 'plans') clearMapUi(); setMode('plans'); setActivePlanId(id) }}
        azSeverity={azAlarm.peak}
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
              readOnly={readOnly}
              viewsOpen={viewsOpen}
              onViewsOpenChange={toggleViews}
              coordsOn={coord.mode !== 'off'}
              onToggleCoords={coord.cycle}
              layersOn={panel === 'layers'}
              onToggleLayers={() => togglePanel('layers')}
            />
          )}

          {/* phone: the rail-footer compass is CSS-hidden in the bottom tool bar, which left
              a rotated map with NO way back to north — so the same multi-purpose views button
              (live bearing · Nach Norden · Einpassen · Standort · saved framings) floats
              top-right under the bar instead. NOT on a read-only surface: there the slim rail
              has room for the compass in its footer and the top bar has room for the weather
              (measured: 96px free with no undo/redo/Eintrag), so both go back where they
              belong on every other form factor and the floating cluster disappears. */}
          {isPhone && !slimRail && displayWeather?.wind_dir_deg != null && (
            <div className="phone-wx">
              {/* Wind stays up here. In the top bar it clipped at the screen edge (that bar
                  already carries switcher · Einsatzuhr · undo/redo · Verlauf), and the
                  compass leaving for the tool bar does not free that width. */}
              <WeatherBadge weather={displayWeather} onOpenMeteo={openWeatherDetails} bearing={view.bearing} />
            </div>
          )}

          {/* coordinate readout — bottom-centre; aiming follows the cursor, set is locked.
              hidden during replay so it never stacks under the bottom-centre scrubber */}
          {coord.readout && !replayActive && (
            <div className={`coord-read${coord.mode === 'aim' ? ' aiming' : ''}${tool === 'measure' ? ' coord-read-stacked' : ''}`} role="status">
              <div className="cr-row"><span className="cr-tag">LV95</span><span className="cr-val">{fmtLV95(coord.readout[0], coord.readout[1])}</span></div>
              <div className="cr-row"><span className="cr-tag">WGS84</span><span className="cr-val">{fmtWGS(coord.readout[0], coord.readout[1])}</span></div>
              <div className="cr-hint">{coord.mode === 'aim' ? appConfig.copy.nav.coordsHint : appConfig.copy.nav.coordsLocked}</div>
            </div>
          )}

        </>
      )}

      {/* click-away: a transparent full-screen backdrop closes the open map panel */}
      {/* phone only: a tap-catcher behind the panel sheet to close it. On desktop the panel
          floats as a side card, so NO backdrop — the map stays pannable with Ebenen open. */}
      {/* ⚠️ The Plan half carries `activeLinkedPlan` because its LayerPanel below does. Without
          it the backdrop outlived its own sheet: switching to an UNLINKED sheet keeps `panel`
          on 'layers' (onSelectPlan skips clearMapUi when the mode is already 'plans'), the
          panel then renders nothing — and a full-screen z28 catcher was left sitting over the
          z20 whiteboard, eating the first tap on a board that looked perfectly normal. */}
      {(mapUI || (mode === 'plans' && activeLinkedPlan)) && panel !== null && isPhone && <div className="mapctl-backdrop" onClick={() => setPanel(null)} />}

      {/* the Ebenen dock (.layers-card z201) sits ABOVE the +Eintrag composer / Verlauf
          scrim that covers every other map popup, so it needs an explicit guard to hide
          with them — otherwise it pokes through the modal (parity with the tool popups) */}
      {mapUI && panel === 'layers' && !composerOpen && !journalOpen && !offlineReadyOpen && (
        <LayerPanel
          layers={layers}
          onToggle={toggleLayer}
          onOpacity={setOpacity}
          twins={planTwinRows(linkedPlans, twinLayers, twinLayerOpacity)}
          // …directly under «Lage», wherever the deployment's config calls that group: a
          // mirrored plan symbol is one more tactical symbol on this map, not a reference
          // overlay to be found past Wasser and Gefahren.
          twinsAfterGroup={layers.find((l) => l.id === appConfig.defaults.operationalLayerId)?.group}
          onOfflineReadiness={() => setOfflineReadyOpen(true)}
          onClose={() => setPanel(null)}
        />
      )}

      {/* The SAME dock on the Plan surface — and only the rows that mean anything there: what the
          Karte lends this sheet. No base maps, no reference layers, no offline door; a plan has
          none of those. Rendered by the shell rather than by the Whiteboard because `panel` is
          the shell's state and the Karte's dock has always lived here. */}
      {mode === 'plans' && panel === 'layers' && activeLinkedPlan && !composerOpen && !journalOpen && (
        <LayerPanel
          layers={[]}
          onToggle={toggleLayer}
          onOpacity={setOpacity}
          twins={mapTwinRows(activeLinkedPlan.fit, twinLayers)}
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
          onScale={(f) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, sizeM: Math.max(8, Math.min(800, (e.sizeM ?? SHAPE_DEFS[e.shape ?? 'square'].defaultSizeM) * f)) } : e)) }))}
          onStop={(v) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, stop: v } : e)) }))}
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
          onFloorFrom={selected.kind === 'symbol' && !selected.live ? (f) => patchEntity(selected.id, { floorFrom: f ?? undefined }) : undefined}
          onFloorTo={selected.kind === 'symbol' && !selected.live ? (f) => patchEntity(selected.id, { floorTo: f ?? undefined }) : undefined}
          onSpread={selected.kind === 'symbol' && !selected.live ? (s) => patchEntity(selected.id, { spread: s ?? undefined }) : undefined}
          onCount={selected.kind === 'symbol' && !selected.live ? (n) => patchEntity(selected.id, { count: n && n > 1 ? n : undefined }) : undefined}
          onRotate={selected.kind === 'symbol' && !selected.live ? (deg) => patchEntity(selected.id, { rotation: deg ?? undefined }) : undefined}
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

      {/* A plan-owned source edited through its Lage projection. «Gespiegelt» remains visible in
          the subtitle; every mutation writes the one BoardAnno in its source plan. */}
      {mapUI && !journalOpen && panel === null && !viewsOpen && viewedMapTwin && (
        <GeorefTwinPanel
          // ⚠️ `floor` is remapped, exactly as the plan's own panel does it: on a BoardAnno that
          // name is the floor-stack TILE INDEX, while the panel's `floor` is the signed Stockwerk
          // badge (types · BoardAnno.storey).
          entity={{ ...viewedMapTwin.anno, floor: viewedMapTwin.anno.storey }}
          svg={viewedMapTwin.anno.symbol === appConfig.symbols.vehicleName
            ? vehicleSymbolSvg(twinName(viewedMapTwin.anno), viewedMapTwin.anno.rotation ?? 0)
            : glyphFor(viewedMapTwin.anno, sym.byName)}
          subtitle={fillTemplate(appConfig.copy.whiteboard.georef.twinPanelFromPlan, { plan: viewedMapTwin.planCode })}
          readOnly={tacticalLocked}
          onClose={() => setTwinView(null)}
          onCenter={() => flyToMapVisible(viewedMapTwin.coord, 18.4)}
          onOriginal={() => { const t = viewedMapTwin; setTwinView(null); goToTwinSource(t) }}
          originalLabel={fillTemplate(appConfig.copy.contextPanel.showOnPlan, { plan: viewedMapTwin.planCode })}
          onTransferHere={tacticalLocked ? undefined : () => transferPlanTwinToMap(viewedMapTwin)}
          onTitleLive={(v) => editPlanTwinSource(viewedMapTwin, { label: v }, 'live')}
          onTitle={(v) => editPlanTwinSource(viewedMapTwin, { label: v }, 'commit')}
          onFields={(fields) => editPlanTwinSource(viewedMapTwin, { fields })}
          onNotes={(v) => editPlanTwinSource(viewedMapTwin, { notes: v || undefined })}
          onFloor={(f) => editPlanTwinSource(viewedMapTwin, { storey: f ?? undefined })}
          onFloorFrom={(f) => editPlanTwinSource(viewedMapTwin, { floorFrom: f ?? undefined })}
          onFloorTo={(f) => editPlanTwinSource(viewedMapTwin, { floorTo: f ?? undefined })}
          onSpread={(spread) => editPlanTwinSource(viewedMapTwin, { spread: spread ?? undefined })}
          onCount={(count) => editPlanTwinSource(viewedMapTwin, { count: count && count > 1 ? count : undefined })}
          onRotate={(rotation) => editPlanTwinSource(viewedMapTwin, { rotation: rotation ?? undefined })}
          onRotate2={(rotation2) => editPlanTwinSource(viewedMapTwin, { rotation2: rotation2 ?? undefined })}
          onCaption={(caption) => editPlanTwinSource(viewedMapTwin, { caption })}
          captionDefault={symbolCaptions ?? 'auto'}
          onAirflow={(extract) => editPlanTwinSource(viewedMapTwin, { extract: extract || undefined })}
          controls={symbolControls(viewedMapTwin.anno.symbol, sym.symbols.find((x) => x.name === viewedMapTwin.anno.symbol)?.cat)}
          titleOptions={symbolTitleOptions(viewedMapTwin.anno.symbol, sym.symbols.find((x) => x.name === viewedMapTwin.anno.symbol)?.cat)}
          fieldOptions={symbolFieldOptions(viewedMapTwin.anno.symbol, sym.symbols.find((x) => x.name === viewedMapTwin.anno.symbol)?.cat, rosterNames)}
          rosterRank={rosterRank}
          personStatus={personStatus}
          fieldHints={rosterFieldHints({ kind: 'symbol', symbol: viewedMapTwin.anno.symbol, label: viewedMapTwin.anno.label, fields: viewedMapTwin.anno.fields } as Entity)}
          protectedKeys={new Set(symbolPresetFieldKeys(viewedMapTwin.anno.symbol, sym.symbols.find((x) => x.name === viewedMapTwin.anno.symbol)?.cat))}
          onDelete={() => { void deletePlanTwinSource(viewedMapTwin) }}
        />
      )}

      {/* A mirrored non-symbol object (line, area, note, shape, Trupp chip) viewed through its
          Lage projection. Same rule as the symbol twin above: the panel stays on THIS surface,
          «Gespiegelt von …» carries the provenance, «Zum Original» is the explicit jump. A
          Notiz gets its one cross-surface edit (its text, via the source anno); the other kinds
          read name + provenance until their editors exist cross-surface. */}
      {mapUI && !journalOpen && panel === null && !viewsOpen && viewedContentTwin && (() => {
        const t = viewedContentTwin
        const isNote = t.anno.kind === 'text'
        return (
          <GeorefTwinPanel
            key={t.key}
            entity={{ id: t.annoId, label: contentTwinName(t.anno) }}
            subtitle={fillTemplate(appConfig.copy.whiteboard.georef.twinPanelFromPlan, { plan: t.planCode })}
            readOnly={tacticalLocked || !isNote}
            onClose={() => setContentTwinView(null)}
            onCenter={t.coord ? () => flyToMapVisible(t.coord!, 18.4) : undefined}
            onOriginal={() => goToTwinSource(t)}
            originalLabel={fillTemplate(appConfig.copy.contextPanel.showOnPlan, { plan: t.planCode })}
            onTitleLive={isNote ? (v) => editPlanTwinSource(t, { text: v }, 'live') : undefined}
            onTitle={isNote ? (v) => editPlanTwinSource(t, { text: v }, 'commit') : () => {}}
            onFields={() => {}}
            onDelete={() => { void deletePlanTwinSource(t) }}
          />
        )
      })()}

      {/* The same rule on the PLAN surface (E8): a mirrored Karte Notiz / Form opens in place,
          source-backed — the tap no longer swaps surfaces. The Notiz edits its map source's
          text through the map editor's own mutation path. ⚠️ NOT the team chip any more
          (round 7): the mirrored Truppmarker wears the SAME context bar the original wears
          (GeorefContentBoard · team bar) — the panel here only remains its locked-viewer
          fallback, a name plaque with provenance. */}
      {mode === 'plans' && !journalOpen && planTwinEntity && (
        <GeorefTwinPanel
          key={planTwinEntity.id}
          entity={{ id: planTwinEntity.id, label: contentTwinName(planTwinEntity) }}
          subtitle={appConfig.copy.whiteboard.georef.twinPanelFromMap}
          readOnly={tacticalLocked || planTwinEntity.kind !== 'note'}
          onClose={() => setPlanTwinEntityId(null)}
          onOriginal={() => jumpToTwinSourceOnMap(planTwinEntity)}
          originalLabel={appConfig.copy.contextPanel.showOnMap}
          onTitleLive={planTwinEntity.kind === 'note' ? (v) => editMapTwinSource(planTwinEntity.id, { label: v }, 'live') : undefined}
          onTitle={planTwinEntity.kind === 'note' ? (v) => editMapTwinSource(planTwinEntity.id, { label: v }, 'commit') : () => {}}
          onFields={() => {}}
          onDelete={() => { setPlanTwinEntityId(null); void deleteEntity(planTwinEntity.id) }}
        />
      )}

      {/* note detail panel — the same ContextPanel, but opened from the ⚙ handle rather than by
          selecting (see notePanelId above). The note's TEXT is its title, so the panel's title
          field edits the note itself. */}
      {detailSlotFree && noteEntity && (
        <ContextPanel
          key={noteEntity.id}
          entity={noteEntity}
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
          onNoteWidth={(w) => patchEntity(noteEntity.id, { noteW: w ?? undefined, noteAutoW: undefined })}
          // the S/M/L step keeps following the text, so it re-measures at the new font size
          onNoteSize={(s) => patchEntity(noteEntity.id, noteEntity.noteAutoW
            ? { noteSize: s, noteW: autoNoteWPx(noteEntity.label ?? '', s) }
            : { noteSize: s })}
          onNotePlain={(p) => patchEntity(noteEntity.id, { notePlain: p || undefined })}
          onColor={(c) => patchEntity(noteEntity.id, { color: c || undefined })}
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
          perimeterM={selectedDrawing.kind === 'circle' ? 2 * Math.PI * (selectedDrawing.radiusM ?? 0)
            : selectedDrawing.kind === 'area' && selectedDrawing.coords.length >= 3
              ? pathLengthM([...selectedDrawing.coords, selectedDrawing.coords[0]]) : null}
          supportsDistance
          /* Messung on a line that is already drawn — geodesic length here, and the coords feed
             the collapsible swisstopo Höhenprofil (fetched only once it is opened) */
          lengthM={selectedDrawing.coords.length >= 2 ? pathLengthM(selectedDrawing.coords) : null}
          profileCoords={selectedDrawing.coords}
          onPreset={applyLinePreset}
          onColor={(c) => patchDrawing({ color: c })}
          onWidth={(w) => patchDrawing({ width: w })}
          onDashed={(dashed) => patchDrawing({ dashed })}
          onLabel={(label) => { if (selectedDrawingId) patchDrawingLabelLive(selectedDrawingId, label) }}
          onLabelCommit={(label) => { if (selectedDrawingId) commitDrawingLabel(selectedDrawingId, label) }}
          onMarker={(marker) => patchDrawing({ marker })}
          onArrow={(arrow) => patchDrawing({ arrow })}
          onEnding={(ending) => void changeMapEnding(ending)}
          onReverse={tacticalLocked ? undefined : () => reverseDrawing(selectedDrawing.id)}
          onContent={(content) => patchDrawing({ content })}
          // the anchored Trupp carries a COPY of the number (the AS chip prints it), so a
          // renumbered hose renumbers the Trupp too (useTruppActions · syncLineNoToTrupp)
          onLineNo={(lineNo) => { patchDrawing({ lineNo }); syncLineNoToTrupp(selectedDrawing.id, lineNo) }}
          onFloorTag={(floorTag) => patchDrawing({ floorTag })}
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
          onFillOpacity={(fillOpacity) => patchDrawing({ fillOpacity })}
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
          [{ type: 'colors', value: drawColor, onChange: setDrawColor }],
          [{ type: 'widths', value: drawWidth, onChange: setDrawWidth }],
          [{ type: 'lineStyle', dashed: drawDashed, onChange: setDrawDashed }],
          [{ type: 'info', text: appConfig.copy.dockHints.line }],
        ]} />
      )}
      {mapUI && tool === 'area' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => { setDraft([]); setTool('select') } }],
          [{ type: 'go', disabled: !draftActive, onClick: commitDraft }],
          [{ type: 'colors', value: drawColor, onChange: setDrawColor }],
          [{ type: 'widths', value: drawWidth, onChange: setDrawWidth }],
          [{ type: 'lineStyle', dashed: drawDashed, onChange: setDrawDashed }],
          [{ type: 'info', text: appConfig.copy.dockHints.area }],
        ]} />
      )}
      {/* Notiz armed — the quick actions for the note about to be placed. Safe here (nothing has
          focus yet); after placement they live in the note's detail panel instead. */}
      {mapUI && tool === 'note' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('select') }],
          // glyph, not a word: «Klartext» stretched the whole dock column wide. A bare T reads
          // as text without its paper; the word stays as the tooltip.
          [{ type: 'toggle', icon: 'type', label: appConfig.copy.notes.lookPlain, on: noteDefaults.plain, onClick: () => setNoteDefaults((d) => ({ ...d, plain: !d.plain })) }],
          [
            { type: 'toggle', text: 'S', label: appConfig.copy.notes.sizeS, on: noteDefaults.size === 's', onClick: () => setNoteDefaults((d) => ({ ...d, size: 's' })) },
            { type: 'toggle', text: 'M', label: appConfig.copy.notes.sizeM, on: noteDefaults.size === 'm', onClick: () => setNoteDefaults((d) => ({ ...d, size: 'm' })) },
            { type: 'toggle', text: 'L', label: appConfig.copy.notes.sizeL, on: noteDefaults.size === 'l', onClick: () => setNoteDefaults((d) => ({ ...d, size: 'l' })) },
          ],
          [{ type: 'colors', value: noteDefaults.color, onChange: (c) => setNoteDefaults((d) => ({ ...d, color: c })) }],
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
          [{ type: 'close', onClick: () => { setPendingShape(null); setTool('select') } }],
          [{ type: 'glyph', node: <ShapeGlyph kind={pendingShape} color="#fff" /> }],
          [{ type: 'toggle', icon: 'lock', label: appConfig.copy.keepPlacing, on: placeLock, onClick: () => setPlaceLock((v) => !v) }],
          [{ type: 'info', text: appConfig.copy.dockHints.shape }],
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
              selectable: moving it to the map is a real thing to want. */}
          {trupps.filter((t) => t.status !== 'raus').map((t) => {
            const here = !!t.entityId
            return (
              <button
                key={t.id} className={`wb-trupp-opt${here ? ' placed' : ''}`} disabled={here}
                onClick={() => { placeTruppOnMap(t.id, teamPick); setTeamPick(null); setTool('select') }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {here
                  ? <i>{appConfig.copy.whiteboard.truppPlacedHere}</i>
                  : t.lineNumber ? <i>Ltg {t.lineNumber}</i> : null}
              </button>
            )
          })}
          <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeGenericTeam(teamPick); setTeamPick(null); setTool('select') }}>
            <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
          </button>
        </Overlay>
      )}

      {mode === 'plans' && sym.ready && (
        <Whiteboard
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
          activeId={activePlanId}
          // which object's plans these are — named on the Plan surface itself (it decides what
          // the rail lists). A link session is bound to one object, so it gets no switch.
          objectName={activeObjectName}
          objectAddress={activeObjectAddress}
          onObjectSwitch={linkScoped ? undefined : () => setPickerOpen(true)}
          // A georeferenced Modul has the Karte's real scale, so its tactical symbols follow the
          // Karte setting too. Standalone sheets keep the independent Modul preference.
          symMul={planSymbolScale(symbolScale, !!activeLinkedPlan)}
          captionMode={symbolCaptions}
          mapSuppressedCaptions={mapSuppressedCaptions}
          // the other half of the mirror: the Karte's vehicles + symbols, offered to this sheet.
          // Raw lists — the Whiteboard projects and clips them against its own fit.
          mapTwins={boardTwinSources}
          onTwinJump={goToTwinOnMap}
          // the mirrored Truppmarker's context bar (round 7): the SAME actions the map's icon
          // bar calls, each writing the one source entity — twin equivalence, in the twin's own
          // chrome instead of a stacked panel
          twinTeam={tacticalLocked ? undefined : {
            rename: renameTeam,
            pick: (id, truppId) => { if (truppId) void adoptTruppMarker(truppId, id); else releaseTruppMarker(id) },
            color: (e, c) => { if (e.truppId) setTruppColor(e.truppId, c); else patchEntity(e.id, { color: c ?? undefined }) },
            mark: markTeamPosition,
            clearTrail: (id) => { void clearTeamTrail(id) },
            remove: (id) => { void deleteEntity(id) },
            showTrupp: (truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) },
            toOriginal: jumpToTwinSourceOnMap,
          }}
          onDismissTwinPanels={() => setPlanTwinEntityId(null)}
          onTwinTransferHere={transferMapTwinToPlan}
          onPlanProjection={showPlanSourceOnMap}
          onTwinMove={moveTwinSource}
          onTwinEdit={editMapTwinSource}
          onTwinDelete={deleteEntity}
          onTwinDrawingCoords={editDrawingCoords}
          onTwinDrawingEdit={editTwinDrawing}
          onTwinDrawingEnding={(id, ending) => {
            const drawing = drawings.find((d) => d.id === id)
            if (drawing) void changeMapEnding(ending, drawing)
          }}
          onTwinDrawingReverse={reverseDrawing}
          onTwinDrawingTrupp={(id, truppId) => (truppId ? linkTruppLine(truppId, id) : unlinkLine(id))}
          onTwinDrawingRouting={(id, endpoint, routing) => {
            const drawing = drawings.find((d) => d.id === id)
            if (drawing) setGpsRouting(drawing, endpoint, routing)
          }}
          onTwinDrawingDetach={detachTwinDrawing}
          onTwinDrawingFocusAttachment={focusTwinDrawingAttachment}
          onTwinDrawingDelete={(id) => { void deleteDrawing(id) }}
          layersOn={panel === 'layers'}
          // the Ebenen button appears only on a linked sheet: with no fit the map lends it
          // nothing, and the panel would be an empty room
          onToggleLayers={activeLinkedPlan ? () => togglePanel('layers') : undefined}
          annos={(replayActive ? replayBoard : board)?.[activePlanId] ?? []}
          onChange={(next) => { if (tacticalLocked) return; setBoard((b) => ({ ...b, [activePlanId]: next })) }}
          building={replayActive ? replayBuilding : building}
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
            const markCount = board.gebaeude?.length ?? 0
            const prevBuilding = building
            const prevGebaeude = board.gebaeude ?? []
            const amend = amendBuilding(prevBuilding, { src, orientDeg, geo }, prevGebaeude)
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
            setBuilding({ src, orientDeg, geo, northUp: false, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect, floors: amend.floors })
            setBoard((b) => ({ ...b, gebaeude: amend.annos }))
            setActivePlanId('gebaeude') // auto-jump to the floor-stack
            if (hasWork) {
              // confirm-with-undo: the previous stack (floors + markings) is restorable in place,
              // and the toast repeats the counts — «Gebäude ersetzt» alone never said what happened.
              toast(amend.legacy
                ? (markCount > 0 ? fillTemplate(wb.buildingReplacedMarks, { n: markCount }) : wb.buildingReplaced)
                : amend.dropped > 0 ? fillTemplate(wb.buildingReplacedCarriedDropped, { n: amend.carried, d: amend.dropped })
                : markCount > 0 ? fillTemplate(wb.buildingReplacedCarried, { n: amend.carried })
                : wb.buildingReplacedKept, {
                icon: 'undo',
                action: { label: appConfig.copy.undo, onClick: () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: prevGebaeude })) } },
              })
            }
          }}
          // the two faces of the ONE «Gebäude» rail tile. Both plan ids stay real documents —
          // this only moves the active one, which is what makes the merged tile navigable at all
          // (railPlanTiles reads activePlanId to decide which face the tile wears).
          onBuildingFace={(face) => setActivePlanId(face === 'pick' ? BUILDING_PICK_ID : gebaeudeDoc.id)}
          onReorient={(next) => setBuilding(next)}
          onAddFloor={(dir) => {
            if (!building) return
            const prevBuilding = building
            const newFloor = dir > 0 ? Math.max(...building.floors) + 1 : Math.min(...building.floors) - 1
            setBuilding((b) => (b ? { ...b, floors: dir > 0 ? [...b.floors, newFloor] : [newFloor, ...b.floors] } : b))
            // confirm-with-undo (standing rule): the undo also sweeps any annotation already
            // dropped on the brand-new storey so nothing orphans
            toast(appConfig.copy.whiteboard.floorAdded, {
              icon: 'undo',
              action: { label: appConfig.copy.undo, onClick: () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: (b.gebaeude ?? []).filter((a) => (a.floor ?? 0) !== newFloor) })) } },
            })
          }}
          onRemoveFloor={(floor) => {
            const prevBuilding = building
            const prevGebaeude = board.gebaeude ?? []
            const resolvedBeforeRemoval = new Map(resolvePlanAnnos(prevGebaeude).map((a) => [a.id, a]))
            setBuilding((b) => (b ? { ...b, floors: b.floors.filter((f) => f !== floor) } : b))
            setBoard((b) => {
              const removedIds = new Set((b.gebaeude ?? []).filter((a) => a.pts?.length
                ? a.pts.every((p) => (p[2] ?? a.floor ?? 0) === floor)
                : (a.floor ?? 0) === floor).map((a) => a.id))
              const gebaeude = (b.gebaeude ?? []).filter((a) => !removedIds.has(a.id)).map((a) => {
                const oldPts = a.pts ?? []
                let pts = oldPts.filter((p) => (p[2] ?? a.floor ?? 0) !== floor)
                const droppedStart = oldPts.length > 0 && pts.length > 0 && oldPts[0] !== pts[0]
                const droppedEnd = oldPts.length > 0 && pts.length > 0 && oldPts[oldPts.length - 1] !== pts[pts.length - 1]
                const targetGone = (rel: typeof a.startAttachment) => !!rel && removedIds.has(rel.target.id)
                const resolved = resolvedBeforeRemoval.get(a.id)?.pts
                if (pts.length && resolved && targetGone(a.startAttachment)) pts = pts.map((p, i) => i === 0 ? [resolved[0][0], resolved[0][1], p[2] ?? a.floor ?? 0] : p)
                if (pts.length && resolved && targetGone(a.endAttachment)) pts = pts.map((p, i) => i === pts.length - 1 ? [resolved[resolved.length - 1][0], resolved[resolved.length - 1][1], p[2] ?? a.floor ?? 0] : p)
                return {
                  ...a,
                  ...(a.pts ? { pts } : {}),
                  ...(a.trail ? { trail: a.trail.filter((p) => (p.floor ?? a.floor ?? 0) !== floor) } : {}),
                  ...((droppedStart || targetGone(a.startAttachment)) ? { startAttachment: undefined } : {}),
                  ...((droppedEnd || targetGone(a.endAttachment)) ? { endAttachment: undefined } : {}),
                }
              }).filter((a) => !a.pts || a.pts.length >= (a.kind === 'area' ? 3 : 2))
              return { ...b, gebaeude }
            })
            // confirm-with-undo: the removed storey's annotations come back with it
            toast(appConfig.copy.whiteboard.floorRemoved, {
              icon: 'undo',
              action: { label: appConfig.copy.undo, onClick: () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: prevGebaeude })) } },
            })
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
          onHistoryState={setPlanCan}
          hist={planHistory}
          setHist={setPlanHistory}
          views={planViews}
          fitRef={planFit}
          keysRef={planKeys}
          focus={planFocus}
          trupps={effTrupps}
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
          onPickLine={linePickTrupp ? onLinePicked : undefined}
          onLinkLineTrupp={(annoId, truppId) => (truppId ? linkTruppLine(truppId, annoId) : unlinkLine(annoId))}
          onLineRenumber={syncLineNoToTrupp}
          // the plan chip's twin of the map marker's jump — it points at the card too
          onShowTrupp={(truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) }}
          // the chip's colour grid paints the TRUPP, so its board card and its Lage marker follow
          onTruppColor={tacticalLocked ? undefined : (truppId, c) => setTruppColor(truppId, c)}
          planScale={planScale}
          onCalibrate={(planId, sc) => { if (tacticalLocked) return; setPlanScale((m) => { if (!sc) { const { [planId]: _drop, ...rest } = m; return rest } return { ...m, [planId]: sc } }) }}
        />
      )}

      {pickerOpen && (
        <PlanPicker
          center={incidentView.center}
          activeObjectId={manualObject?.id ?? null}
          onSelect={pickObject}
          onReset={manualObject ? resetObject : undefined}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {mode === 'checklists' && (
        <ChecklistsView
          checklists={checklists}
          canTick={canTick}
          divera={{ title: incidentMeta.title, type: incidentMeta.type ?? undefined }}
          onTick={toggleTick}
          onBranch={setBranch}
          onAction={checklistAction}
        />
      )}

      {mode === 'atemschutz' && (
        <AtemschutzView
          trupps={effTrupps}
          leitungOptions={truppLeitungOptions}
          truppColors={truppColors()}
          showTruppLine={showTruppLine} truppsWithLine={truppsWithLine()} lineNoOf={truppLineNos()}
          pickTruppLine={pickTruppLine} unlinkTruppLine={unlinkTruppLine}
          canEdit={canEditIncident}
          personnel={pickablePersonnel}
          attendance={effAttendance}
          // a Gast under PA was at the Einsatz — record them on the Anwesenheit too. Through
          // assignTypedName, so typing the name of somebody who IS on the list (or already on
          // this Einsatz) links that row instead of opening a second one beside it. No job
          // written here: the Trupp is not formed yet, and submitting it writes «AS» itself.
          onAddGuest={canEditIncident ? (name) => assignTypedName(name, 'presence') : undefined}
          createTrupp={createTruppA}
          placeTrupp={placeTrupp}
          placeTargets={placeTargets}
          // the Trupp symbols already standing on Lage/plan, offered under the placement targets
          markerOptions={truppMarkerOptions}
          adoptMarker={(truppId, markerId) => void adoptTruppMarker(truppId, markerId)}
          focusTruppOnPlan={focusTruppOnPlan}
          recordContact={recordContact}
          recordPressure={recordPressure}
          setTruppStatus={setTruppStatus}
          editTrupp={editTruppA}
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
        />
      )}

      {mode === 'anwesenheit' && (
        <AnwesenheitView
          people={personnel}
          attendance={effAttendance}
          canEdit={canEditIncident}
          loading={personnelLoading}
          error={personnelError}
          blockedIds={blockedAttendanceIds}
          onAddGuest={canEditIncident ? addGuest : undefined}
          onMarkPresent={markPresent}
          onMarkLeft={markLeft}
          onClear={clearAttendance}
          truppOfPerson={truppOfPerson}
          onJumpToTrupp={(truppId) => {
            setMode('atemschutz'); setPanel(null)
            if (truppId) setTruppFocus({ id: truppId, nonce: Date.now() })
          }}
          onReload={() => { void reloadPersonnel() }}
          // the phone's way back: the top bar drops its ↶ ↷ as soon as an Atemschutz-Alarmchip
          // claims the room, which is exactly when this list is tapped fastest (AnwesenheitView · onUndo)
          onUndo={canEditIncident ? () => stepAttendance('undo') : undefined}
          onRedo={canEditIncident ? () => stepAttendance('redo') : undefined}
          canUndo={attHist.canUndo}
          canRedo={attHist.canRedo}
          onSetTimes={canEditIncident ? setAttendanceTimes : undefined}
          onRemoveBlock={canEditIncident ? removeAttendanceBlock : undefined}
          onSetNote={canEditIncident ? setAttendanceNote : undefined}
          onSetOrt={canEditIncident ? setAttendanceOrt : undefined}
          captureUsage={captureUsage}
          shifts={effShifts}
          bands={effBands}
          onCreateBand={canEditIncident ? (label, from, to) => { bandActions.addBand(label, from, to) } : undefined}
          onSaveBand={canEditIncident ? (id, label, from, to) => {
            bandActions.renameBand(id, label)
            void bandActions.askAndSetBandTimes(id, from, to)
          } : undefined}
          onRemoveBand={canEditIncident ? bandActions.removeBand : undefined}
          onCycleCell={canEditIncident ? bandActions.cycleCell : undefined}
          onSetCellState={canEditIncident ? bandActions.setCellState : undefined}
          onPutCellState={canEditIncident ? bandActions.putCellState : undefined}
          startedAt={incidentMeta.started_at}
          onAddShift={canEditIncident ? addShift : undefined}
          onAddShiftSpan={canEditIncident ? addShiftSpan : undefined}
          onReplaceShift={canEditIncident ? replaceShift : undefined}
          onSetShiftTime={canEditIncident ? setShiftTime : undefined}
          onRemoveShift={canEditIncident ? removeShift : undefined}
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
      )}

      {mode === 'mittel' && (
        <MittelView
          entries={effMittel}
          canEdit={canEditIncident}
          onSave={saveMittel}
          captureUsage={captureUsage}
          placedSymbols={placedSymbols}
        />
      )}

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

      {mode === 'rapport' && (
        /* onEditDispatch leaves the preflight open so the Einsatzdaten wizard stacks on top
           (later in DOM, same z-index) — canceling it reveals the rapport again instead of a
           dead end. (Saving still remounts the workspace and returns to the map.) */
        <ReportPreflight
          incident={incidentMeta}
          reportMeta={reportMeta}
          personnel={pickablePersonnel}
          presentIds={presentIds}
          events={timeline}
          annotatedPlanCount={annotatedPlanCount}
          twinAnnos={printTwinAnnos}
          // ⚠️ `allTrupps`, here and on the `trupps` prop below — the two places that print. A Trupp
          // taken off the Tafel was still under PA, and its readings, entry pressure and times are
          // exactly what the Atemschutz page exists to record (types · Trupp.removedAt).
          truppCount={allTrupps.length}
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
          captureUsage={captureUsage}
          attachments={attachments}
          onAddAttachments={canEditIncident && !readOnly ? addAttachments : undefined}
          onCaptionAttachment={canEditIncident && !readOnly ? captionAttachment : undefined}
          onRemoveAttachment={canEditIncident && !readOnly ? removeAttachment : undefined}
          canEdit={canEditIncident && !readOnly}
          onRolePicked={assignRole}
          // the Einsatzleiter / Rückmeldung pickers: a typed name is a Gast, so the EL named on
          // the front page of the rapport is on the Anwesenheit behind it even for a Nachbarwehr
          onAddGuest={canEditIncident && !readOnly ? assignTypedName : undefined}
          onSaveMeta={saveReportMeta}
          onEditDispatch={canEditIncident && !readOnly ? onEditMeta : undefined}
          onOpenAnwesenheit={() => { setMode('anwesenheit'); setRapportReturn(true) }}
          onOpenMittel={() => { setMode('mittel'); setRapportReturn(true) }}
          // Do NOT close the sheet here. On the real path the completion switches the active
          // Einsatz and this whole workspace unmounts, so closing it is redundant; on the demo
          // (and on any refusal) `completeRapport` returns early with a toast — and the sheet
          // had already been shut, so the operator lost their place for an action that never
          // happened. The «Abschliessen» confirm closes itself; that is the only thing that should.
          // ⚠️ The confirm (and the media flush that follows it) lives in `confirmAndComplete`
          // above, shared with the Einsatz-Menü row — one action, one dialog, one wording.
          onComplete={canEditIncident && !readOnly ? confirmAndComplete : undefined}
          onFixTranscripts={() => { setJournalOpen(true); setJournalFromRapport(true) }}
        />
      )}
      {/* unified Verlauf + quick-add — rendered app-level so both open over either surface,
          and AFTER the Rapport sheet so its checklist row can stack the Verlauf on top */}
      {journalOpen && (
        <Journal
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
          mediaStatusOf={media.statusOf}
          onOpenPlayer={(e, seekSec) => setPlayer({ row: e, seekSec })}
          onEditText={!readOnly ? (id, text) => journal.appendPatch(id, { textEdit: text }) : undefined}
        />
      )}
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
          onClose={() => { setComposerOpen(false); setNoteOn(null) }}
          noteOn={noteOn ?? undefined}
          onClearNote={() => setNoteOn(null)}
          // …and the same list the Verlauf pins, so an entry being written can be attached to an
          // open item without going through the Verlauf at all — the sheet offers the ones the
          // sentence already names, and holds a picker for the rest.
          openPendenzen={reminders.open.map((r) => ({ id: r.id, text: r.text, urgent: !!r.urgent }))}
          onLinkPendenz={(pdz) => setNoteOn(pdz)}
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
          onTap={() => setComposerOpen(true)}
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
