import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import './app.css'
import { IconSprite, Icon } from './lib/icons'
import { useSymbols } from './lib/useSymbols'
import { vehicleSymbolSvg } from './lib/useVehiclePositions'
import { useVehicleLayer } from './lib/useVehicleLayer'
import { autoActivateLayers, deriveInitial, sanitizeWorkspace, WORKSPACE_SCHEMA_VERSION, type Doc, type Saved, type WorkspaceGate } from './lib/workspace'
import { useReplay } from './lib/useReplay'
import { resolveHotkey, isTypingTarget } from './lib/hotkeys'
import { moduleNumbers } from './lib/navRail'
import { incident as demoIncident, planDocuments, gebaeudeDoc, preparedOverlays } from './data/demoIncident'
import type { CameraView, Drawing, Entity, Incident, LayerDef, LayerId, LngLat, MittelEntry, ShapeKind, TimelineEvent, Trupp, TruppFields } from './types'
import { appConfig } from './config/appConfig'
import { atemschutzDoctrine, getDeploymentConfig, deploymentDefaultCenter, isDemoMode } from './lib/deploymentConfig'
import { fillTemplate, formatSymbolName, formatTime } from './lib/format'
import { formatAudioDuration } from './lib/audioImport'
import { seedSymbolProps, symbolControls, symbolTitleOptions, symbolFieldOptions, symbolPresetFieldKeys } from './lib/symbols'
import { circlePolygon, fmtLV95, fmtWGS, haversineM } from './lib/geo'
import { lineLabel } from './lib/lineDecor'
import { panelNudge, panelNudgeUp, panelNudgeBox, panelNudgeBoxUp, isBottomSheet } from './lib/panelNudge'
import { useMeasure } from './lib/useMeasure'
import { useCoordPicker } from './lib/useCoordPicker'
import { useVoiceMemo } from './lib/useVoiceMemo'
import { useUndoableDoc } from './lib/useUndoableDoc'
import { useJournal } from './lib/useJournal'
import { useWakeLock } from './lib/useWakeLock'
import { toast, confirmDialog } from './lib/ui'
import { loadPrefs, savePrefs, symbolMul } from './lib/prefs'
import { useAttendanceActions } from './lib/useAttendanceActions'
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
import { useSectionSwipe, SWIPE_SECTIONS } from './lib/useSectionSwipe'
import { useOnline } from './lib/useOnline'
import { MapView } from './components/MapView'
import { Splash } from './components/Splash'
import { TopBar, WeatherBadge } from './components/TopBar'
import { NavRail } from './components/NavRail'
import { MapUtility } from './components/MapUtility'
import { MapViewsButton, type ViewsApi } from './components/MapViewsMenu'
import { LayerPanel } from './components/LayerPanel'
import { ToolRail } from './components/ToolRail'
import { Palette } from './components/Palette'
import { ContextPanel } from './components/ContextPanel'
import { DrawEditor } from './components/DrawEditor'
import { ToolDock } from './components/ToolDock'
import { ShapeEditor } from './components/ShapeEditor'
import { MeasurePanel } from './components/MeasurePanel'
import { SHAPE_DEFS, ShapeGlyph } from './lib/shapes'
import { Journal } from './components/Journal'
import { JournalComposer, type JournalDraft } from './components/JournalComposer'
import { AudioPlayerSheet } from './components/AudioPlayerSheet'
import { ReminderBanner } from './components/ReminderBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { InstallBanner } from './components/InstallBanner'
import { InstallGuide } from './components/InstallGuide'
import { getInstallPlatform, isStandalone } from './lib/installPrompt'
import { installOffered } from './lib/installPolicy'
import { claimBootNotifyTarget } from './lib/notifyTarget'
import { TabLockBanner } from './components/TabLockBanner'
import { ArchivedBanner } from './components/ArchivedBanner'
import { useReminders } from './lib/useReminders'
import { useMediaQueue } from './lib/useMediaQueue'
import { AtemschutzAlarmHost } from './lib/useAtemschutzAlarm'
import type { AtemschutzAlarmState } from './lib/atemschutz'
import { ensureNotifyPermission } from './lib/alarm'
import { Whiteboard } from './components/Whiteboard'
import { ReplayBar } from './components/ReplayBar'
import { FabEntry } from './components/FabEntry'
import { prewarmPlans } from './components/PdfViewport'
import { prefetchOutlines } from './components/OsmOutline'
import { buildView } from './lib/footprint'
import { useAuth } from './lib/auth'
import {
  WorkspaceSync, uploadMedia,
  referenceUrl,
  type IncidentMeta,
} from './lib/incidents'
import { useAuditEvents } from './lib/useAuditEvents'
import { useMapDrawing } from './lib/useMapDrawing'
import { applyRouting, moveLineBody, resolveMapDrawings, resolvePlanAnnos } from './lib/lineAttachments'
import { useIncidentSync } from './lib/useIncidentSync'
import { useTruppActions, LAGE_TARGET } from './lib/useTruppActions'
import { useObjectPlans } from './lib/useObjectPlans'
import { PlanPicker } from './components/PlanPicker'
import { IncidentSwitcher, ReviewBanner, SettingsSheet, OfflineReadinessSheet } from './components/panels'
import { HelpOverlay } from './components/HelpOverlay'
import { useWeather } from './lib/useWeather'
import { predownloadArea } from './lib/offlineTiles'
import { ChecklistsView } from './components/ChecklistsView'
import { AtemschutzView } from './components/AtemschutzView'
import { AnwesenheitView } from './components/AnwesenheitView'
import { MittelView } from './components/MittelView'
import { usePersonnel } from './lib/usePersonnel'
import { assignedPersonIds } from './lib/personnel'
import type { Item } from './lib/checklists'
import { ReportPreflight } from './components/ReportPreflight'
import { annotatedPlans } from './lib/report'
import { mittelLineCount } from './lib/mittel'

const prefs = loadPrefs()
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
  onEditMeta: () => void
  onPatchMeta: (patch: Partial<IncidentMeta>) => void
  /** Abschluss-Assistent finished (already confirmed): stamp report_done_at + archive */
  onCompleteRapport: () => void
  /** archive the active incident (confirm dialog included) — the switcher-menu shortcut */
  onArchiveActive?: () => void
  /** reactivate the ARCHIVED active incident (confirm dialog included) — the banner action */
  onReactivateActive?: () => void
  /** leave the archived read-only view — back to the previously active incident, else the
   *  «Alle Einsätze» list it was entered from (everyone, not just editors) */
  onBackFromArchive?: () => void
}


export function IncidentWorkspace({
  incidentMeta, incidents, workspace, sync, forceReadOnly, tabLockLost, onTakeOverTab, onCompleteRapport,
  onSwitchIncident, onOpenHistory, onOpenDivera, onOpenDatenquellen, onArchiveActive, onReactivateActive, onBackFromArchive,
  needsReview, onReviewDone, onEditMeta, onPatchMeta,
}: WorkspaceProps) {
  // Identity + permissions. Viewers get a read-only picture: they can pan / zoom /
  // inspect, but every editing affordance is hidden and commit() is neutered so
  // nothing can mutate the document (defense in depth).
  const { user, logout } = useAuth()
  const baseReadOnly = user?.role !== 'editor' || forceReadOnly || tabLockLost
  const isEditor = user?.role === 'editor'
  // Phones are a live viewer + field-capture device: lock all TACTICAL editing (tools,
  // map drawing/placing, plan annotation) even for a editor — but keep journal capture
  // + sync alive (those hang off `readOnly`, which stays false for a editor). Tablets
  // and desktop keep full editing.
  const isPhone = useIsPhone()
  // Time-travel replay is a read-only past view: while active it locks ALL editing
  // (folded into both readOnly and tacticalLocked) and swaps the live doc for the
  // reconstructed state. Owned by useReplay; `active` feeds the lock derivations below.
  const { active: replayActive, setActive: setReplayActive, ws: replayWs, onState: onReplayState, onVehicles: onReplayVehicles, exit: exitReplay, entities: replayEntities, board: replayBoard, building: replayBuilding } = useReplay()
  const readOnly = baseReadOnly || replayActive
  // Einsatzleiter-Ansicht: an EDITOR's deliberate hands-off mode — tactical editing locked
  // like a phone, but journal capture and read-only symbol details stay live. Device toggle
  // (Einstellungen), seeded by the login's server-side default (el_view_default) so a
  // dedicated «Einsatzleiter» account starts hands-off without per-device setup.
  const [elViewPref, setElViewPref] = useState<boolean | null>(() => loadPrefs().elView ?? null)
  const elView = isEditor && (elViewPref ?? user?.el_view_default ?? false)
  const setElView = (v: boolean) => { setElViewPref(v); savePrefs({ ...loadPrefs(), elView: v }) }
  // «not edit anything» is broader than the tactical surfaces: EL view also locks the
  // Atemschutz / Mittel / checklist / dispatch actions that hang off this flag.
  const canEditIncident = isEditor && !replayActive && !elView
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

  // --- document (undoable) — doc + history funnel extracted to useUndoableDoc ---
  const { doc, setDocRaw, commit, beginDrag, endDrag, undo: undoDoc, redo: redoDoc, canUndo, canRedo, replace: replaceDoc } = useUndoableDoc<Doc>(init.doc, readOnly)
  // Live vehicles from kp-rueck's GPS feed — kept out of the editable document so
  // they auto-update and never get persisted. The operator can drag a vehicle to
  // reposition it and drag its handle to orient it; those overrides live here
  // (persisted) and win over the GPS value until reset via the "GPS" button.
  const { liveVehicles, liveIds, overrides: vehicleOverrides, setOverrides: setVehicleOverrides } = useVehicleLayer(init.vehicleOverrides)

  // Session-only tactical editing state (active tool, place gesture, selection) — see
  // useTacticalSelection. Declared before enterReplay (which clears it) so its setters are in
  // scope for that callback; threaded into useMapDrawing below just as before.
  const { selectedId, setSelectedId, tool, setTool, teamPick, setTeamPick, pending, setPending, pendingShape, setPendingShape, placeLock, setPlaceLock, selectedDrawingId, setSelectedDrawingId, selectedDrawIds, setSelectedDrawIds, selectedEntityIds, setSelectedEntityIds } = useTacticalSelection()

  // Per-incident SYNCED workspace slices (board, checklists, trupps, attendance, mittel, camera
  // views, plan scale, report meta, Gebäude, active plan, picked object, synced settings) — see
  // useWorkspaceDoc. State only; buildPayload/applyWorkspace + the trupps auto-free effects stay
  // below and read these. layers/recent stay in the component (own derivation/effects).
  const {
    incidentSettings, setIncidentSettings, board, setBoard, checklists, setChecklists,
    trupps, setTrupps, attendance, setAttendance, mittel, setMittel, cameraViews, setCameraViews,
    planScale, setPlanScale, reportMeta, setReportMeta, building, setBuilding,
    activePlanId, setActivePlanId, pickedObjectId, setPickedObjectId,
  } = useWorkspaceDoc(init)

  // --- time-travel replay (read-only past view) — state/reconstruction owned by useReplay ---
  // Enter replay WITHOUT forcing a surface: one timeline drives both the Lagekarte and the
  // Plan, so the user can toggle Lage/Plan during playback to inspect each surface at the
  // scrubbed instant. Editing stays locked (replayActive feeds readOnly/tacticalLocked); here
  // we just clear any in-progress tactical gesture so nothing is mid-edit on entry.
  const enterReplay = useCallback(() => { setReplayActive(true); setPanel(null); setSelectedId(null); setSelectedDrawingId(null); setTool('select'); setPending(null); setPendingShape(null); setDraft([]) }, [])

  // map entities/drawings: the live doc + GPS, or the reconstructed past blob during replay.
  const entities = useMemo(
    () => (replayActive ? replayEntities : [...doc.entities, ...liveVehicles]),
    [replayActive, replayEntities, doc.entities, liveVehicles],
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
  // the Plan exposes its fit-to-view here so the phone top bar can offer Fit (the plan's
  // equivalent of the map's locate) instead of a floating zoom cluster on a small screen.
  const planFit = useRef<(() => void) | null>(null)
  // the Plan exposes tool-pick + zoom here so the global keyboard-shortcut layer can drive it
  // while the Plan is the active surface (parity with how it drives the Lage map).
  const planKeys = useRef<{ pickTool: (tool: string) => void; zoom: (f: number) => void } | null>(null)
  // always-fresh keydown dispatcher — assigned every render (below, once all handlers exist) so
  // the single window listener never re-subscribes yet never closes over stale state.
  const hotkeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  // one place that edits a single map entity: a discrete undo step + the audit
  // emit, so every field edit (label/fields/notes/floor/count/rotation) is recorded
  // identically — previously notes/floor/count silently skipped the audit stream.
  const patchEntity = (id: string, patch: Partial<Entity>) => {
    commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
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
  const timeline = journal.rows
  const rowSeq = useRef(0) // per-mount suffix so same-millisecond rows get distinct ids
  const [recent, setRecent] = useState<string[]>(init.recent)
  // most-recently-used symbols (shared by both surfaces' palettes) — newest first, deduped, capped
  const addRecent = (name: string) => setRecent((r) => [name, ...r.filter((x) => x !== name)].slice(0, 12))
  // overlay / popover / sheet open-state (views popover, symbol palette, Einstellungen,
  // Objekt-Picker, Hilfe, Installations-Guide, Offline-Bereitschaft, Rapport-Preflight,
  // layers panel) — grouped in useSheets; switching to a tool closes the views popover + panel.
  const { viewsOpen, setViewsOpen, paletteOpen, setPaletteOpen, settingsOpen, setSettingsOpen, pickerOpen, setPickerOpen, helpOpen, setHelpOpen, installGuideOpen, setInstallGuideOpen, offlineReadyOpen, setOfflineReadyOpen, reportPreflightOpen, setReportPreflightOpen } = useSheets()
  // the layers side panel shares the tool docks' on-screen slot, so switching to any drawing
  // tool closes it + the views popover. Kept here (not in useSheets) next to the tactical
  // gesture state it's cleared alongside (enterReplay), so those stay plain useState setters.
  const [panel, setPanel] = useState<'layers' | null>(null)
  useEffect(() => { if (tool !== 'select') { setViewsOpen(false); setPanel(null) } }, [tool])
  // measurement tool (distance/height-profile line, or area) — extracted to useMeasure.
  // All ephemeral (never saved); gated on the measure tool being active.
  const measure = useMeasure(tool === 'measure')
  // surface + active plan are remembered across reloads via a cookie
  const [mode, setMode] = useState<'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'>(prefs.mode ?? 'map')
  // `phoneTools` (the second, stacked tool bar → its extra bottom clearances) is computed below,
  // once `planDocs` is known: a viewer-only plan renders NO tool bar, so it must reserve one bar,
  // not two.
  // #10: horizontal swipe pages between sections in nav order. Non-canvas surfaces swipe anywhere;
  // the map/plan canvas swipes from a phone screen edge (they keep pan/zoom). The wiring that needs
  // the ordered plan list lives below planDocs; the refs + the canvas gate are here.
  const sectionPagerRef = useRef<HTMLDivElement>(null)
  const edgeLRef = useRef<HTMLDivElement>(null)
  const edgeRRef = useRef<HTMLDivElement>(null)
  const canvasEdge = isPhone && (mode === 'map' || mode === 'plans')
  // global tactical-symbol size (S/M/L), captions, offline cache radius, keep-screen-on —
  // device prefs shared with the landing Einstellungen (see useDevicePrefs; lazy loadPrefs
  // seed). Their persistence rides the mode/activePlanId effect below.
  const { symbolSize, setSymbolSize, symbolCaptions, setSymbolCaptions, offlineRadiusM, setOfflineRadiusM, keepScreenOn, setKeepScreenOn } = useDevicePrefs()
  const symMul = symbolMul(symbolSize)
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
  // alarm audibility — per-device, localStorage-backed, app-wide (see useAtemschutzMute).
  const { muted: atemschutzMuted, toggle: toggleAtemschutzMuted } = useAtemschutzMute()
  // a Rapport checklist row navigated to Anwesenheit/Mittel → offer the one-tap way back
  const [rapportReturn, setRapportReturn] = useState(false)
  // the Verlauf drawer sits BELOW the Rapport sheet (z 61 vs 80), so opening it from the
  // checklist closes the sheet and reopens it when the Verlauf closes — a real round trip
  const [journalFromRapport, setJournalFromRapport] = useState(false)
  // leaving those surfaces for anything else ends the round trip (no stale chip later)
  useEffect(() => { if (mode !== 'anwesenheit' && mode !== 'mittel') setRapportReturn(false) }, [mode])
  // per-object backend module plans (auto-surfaced near object, or a manual PlanPicker override),
  // plus the resolved plan-doc list with module PDFs swapped in — see useObjectPlans
  const { backendPlans, resolvedPlanDocs, manualObject, activeObjectName, pickObject, resetObject } = useObjectPlans(incidentMeta.id, incidentView.center, setActivePlanId, pickedObjectId, setPickedObjectId)

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
  const downloadOffline = useCallback(async () => {
    const map = mapRef.current?.getMap()
    if (!map) return
    const base = layers.find((l) => l.base && l.visible)
    const templates = base?.tiles ?? ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png']
    const bounds = incidentBounds
    // warm: per-object plan PDFs, the symbol library, and the geojson overlays cropped to the box
    const warmUrls = [
      ...Object.values(backendPlans),
      referenceUrl('symbols:tactical'),
      ...layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
    ]
    setOfflineProgress({ done: 0, total: 1 })
    // throttle progress to whole-percent changes so we don't re-render this (huge) component
    // ~750× during the download — a real contributor to memory/CPU pressure on the device.
    let lastPct = -1
    try {
      const res = await predownloadArea({
        templates,
        bounds,
        minZoom: 14,
        // z17 (building-level), not 18: z18 ~4× the tiles and OOMs an iPad mid-download
        maxZoom: 17,
        cap: 1200,
        warmUrls,
        onProgress: (done, total) => {
          const pct = total ? Math.floor((done / total) * 100) : 0
          if (pct !== lastPct) { lastPct = pct; setOfflineProgress({ done, total }) }
        },
      })
      toast(
        fillTemplate(res.capped ? appConfig.copy.offline.dlDoneCapped : appConfig.copy.offline.dlDone, { n: res.fetched }),
        { icon: 'map', tone: 'success' },
      )
    } catch {
      toast(appConfig.copy.offline.dlFailed, { icon: 'map', tone: 'warn' })
    } finally {
      setOfflineProgress(null)
    }
  }, [layers, backendPlans, incidentBounds, withGeoBbox])
  // the Gebäude (floor-stack) document only exists once a building is picked; it sits
  // directly under "Umgebung" (the OSM outline you pick the building from)
  // during replay the floor-stack tab follows the RECONSTRUCTED building, so the past
  // plan list matches the past state (Gebäude appears iff a building existed back then)
  const effBuilding = replayActive ? replayBuilding : building
  // during replay the Atemschutz/Anwesenheit surfaces show the RECONSTRUCTED past state (the
  // views are read-only then) so scrubbing moves Trupp status + attendance back in time too
  const effTrupps = replayActive ? (replayWs?.trupps ?? []) : trupps
  const effAttendance = replayActive ? (replayWs?.attendance ?? {}) : attendance
  // during replay the Mittel log is reconstructed from the scrubbed-instant workspace blob
  const effMittel = replayActive ? ((replayWs?.mittel as MittelEntry[] | undefined) ?? []) : mittel
  const planDocs = useMemo(() => {
    if (!effBuilding) return resolvedPlanDocs
    const out = [...resolvedPlanDocs]
    const osmIdx = out.findIndex((p) => p.id === 'osm')
    out.splice(osmIdx >= 0 ? osmIdx + 1 : out.length, 0, gebaeudeDoc)
    return out
  }, [effBuilding, resolvedPlanDocs])

  // both bars are stacked on the two drawing surfaces (tool bar above the surface bar) — this drives
  // the extra bottom clearances for FAB / docks / stage / whiteboard on phones. A viewer-only plan
  // (e.g. Modul 6 Gebäudepläne) renders no tool bar, so it gets ONE bar of clearance, not two —
  // otherwise the empty tool-bar lane blocks the PDF from scrolling to the bottom nav.
  const activePlanViewer = mode === 'plans' && planDocs.find((p) => p.id === activePlanId)?.viewer === true
  const phoneTools = isPhone && !tacticalLocked && (mode === 'map' || (mode === 'plans' && !activePlanViewer))

  // #10: the flat nav order (matches NavRail) — map, EACH plan doc, then the four sections. A swipe
  // steps one destination at a time, so it walks through the modules individually instead of
  // collapsing to whatever plan was last open (the Gebäude). Same target list for both the
  // non-canvas content-swipe and the phone canvas edge-swipe.
  const navList = useMemo(() => [
    { mode: 'map' as const },
    ...planDocs.map((d) => ({ mode: 'plans' as const, planId: d.id })),
    { mode: 'checklists' as const },
    { mode: 'atemschutz' as const },
    { mode: 'anwesenheit' as const },
    { mode: 'mittel' as const },
  ], [planDocs])
  const goToNav = (dir: -1 | 1) => {
    const cur = navList.findIndex((n) => n.mode === mode && (n.mode !== 'plans' || n.planId === activePlanId))
    const next = cur >= 0 ? navList[cur + dir] : undefined
    if (!next) return
    if (next.mode === 'plans') { setMode('plans'); setActivePlanId(next.planId); setPanel(null) }
    else setMode(next.mode)
  }
  useSectionSwipe(sectionPagerRef, {
    enabled: (SWIPE_SECTIONS as readonly string[]).includes(mode),
    onPrev: () => goToNav(-1), onNext: () => goToNav(1),
  })
  // left edge inward-swipe (→) = previous; right edge inward-swipe (←) = next
  useSectionSwipe(edgeLRef, { enabled: canvasEdge, onPrev: () => goToNav(-1), onNext: () => goToNav(1) })
  useSectionSwipe(edgeRRef, { enabled: canvasEdge, onPrev: () => goToNav(-1), onNext: () => goToNav(1) })
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

  // a tapped system notification (handled in public/sw-notify.js) posts here to open the
  // relevant tab — an Atemschutz alarm jumps to the Atemschutz view, a due Wiedervorlage
  // opens the Verlauf where reminders live. If the tap COLD-STARTED a killed app the target
  // arrives as the ?kpn= boot param instead (a postMessage would land before this listener
  // exists); claim is one-shot so an incident switch can't re-route the same tap.
  useEffect(() => {
    const route = (target: unknown) => {
      if (target === 'atemschutz') setMode('atemschutz')
      else if (target === 'journal') setJournalOpen(true)
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
  // the moment the Eintrag composer opened — used as the entry timestamp (the info was usually
  // relevant / the order given then, not when Erfassen is finally pressed)
  const composerOpenedAt = useRef<string | null>(null)
  useEffect(() => { if (composerOpen) composerOpenedAt.current = new Date().toISOString() }, [composerOpen])
  // a Verlauf row can ask the plan to revisit a point; nonce makes each request distinct
  const [planFocus, setPlanFocus] = useState<{ x: number; y: number; floor: number; annoId?: string; nonce: number } | null>(null)
  // last reported plan-view centre, so a journal pin on the plan anchors to "here"
  const planCenter = useRef<{ x: number; y: number; floor: number }>({ x: 0.5, y: 0.5, floor: 0 })
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null)
  // the note being edited inline with raw text directly on the map — exactly like the Plan
  // whiteboard's text notes (placement auto-edits; double-click re-enters; single tap just selects)
  const [editNoteId, setEditNoteId] = useState<string | null>(null)
  // true once a live title edit has snapshotted for undo, so we beginDrag once per edit
  // session and fold the whole keystroke stream into a single undo step on blur
  const titleLiveRef = useRef(false)
  // stream a note's raw text live (silent — snapshot once for undo), then fold the whole
  // edit into one undo step + a single audit event on blur. Mirrors the title editor.
  const noteTextLive = (id: string, v: string) => {
    if (!titleLiveRef.current) { titleLiveRef.current = true; beginDrag() }
    setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, label: v } : e)) }))
  }
  const noteTextCommit = (id: string, v: string) => {
    if (titleLiveRef.current) { titleLiveRef.current = false; endDrag(); emit('entity.edit', { id, patch: { label: v } }) }
    else patchEntity(id, { label: v })
    setEditNoteId(null)
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
  const applyWorkspace = useCallback((ws: Saved) => {
    const gate = sanitizeWorkspace(ws)
    reportGate(gate)
    const next = deriveInitial(gate.ws, incidentMeta.id, prefs, incidentMeta.type)
    // replaceDoc swaps the doc AND drops undo history (the local stacks no longer apply to
    // remote/merged state — undoing into it would resurrect remotely-deleted content).
    replaceDoc(next.doc); setLayers(next.layers); journal.ingestLegacy(next.timeline)
    setRecent(next.recent); setBoard(next.board); setBuilding(next.building)
    setVehicleOverrides(next.vehicleOverrides); setChecklists(next.checklists); setTrupps(next.trupps); setAttendance(next.attendance); setCameraViews(next.cameraViews); setPlanScale(next.planScale); setReportMeta(next.reportMeta); setIncidentSettings(next.settings); setPickedObjectId(next.pickedObjectId)
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
    drawings: doc.drawings, recent, board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, trupps, attendance, mittel, cameraViews, planScale, reportMeta, settings: incidentSettings,
    layerState: layers.map((l) => ({ id: l.id, visible: l.visible, opacity: l.opacity })),
    // Verlauf rows live in the journal store now; the blob echoes an older incident's legacy
    // rows only until they're safely on the server, then ships empty forever (see JournalStore).
    timeline: journal.blobTimeline,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
  }), [doc, layers, journal.blobTimeline, recent, board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, trupps, attendance, mittel, cameraViews, planScale, reportMeta, incidentSettings])

  // persistence, teardown beacons, live-follow poll (with the tablet sync-race guard),
  // in-place auto-merge apply, and the reactive sync-status badge all live in useIncidentSync.
  const { syncStatus, lastSyncedAt, syncNow } = useIncidentSync({
    sync, readOnly, incidentId: incidentMeta.id,
    buildPayload, applyWorkspace, flushEvents, flushEventsBeacon,
    // attendance-divergence note (both sides changed the same person → one Verlauf row)
    appendJournal: journal.append,
  })

  // Keep the screen awake while an incident workspace is open (this component only mounts for an
  // open incident) — so the map never dims/sleeps mid-operation on a station/vehicle tablet.
  // Default on, but a per-device toggle (Einstellungen) lets a personal/background device opt out
  // and save battery. No-ops on browsers without the Wake Lock API.
  useWakeLock(keepScreenOn)

  // Offline media queue: reattaches queued captures to their rows after a reload, retries on
  // reconnect, and swaps a row's local blob: URL for the persistent server URL on success.
  const swapRowMedia = useCallback((rowId: string, kind: 'photo' | 'audio', url: string) => {
    const field = kind === 'audio' ? 'audioUrl' : 'photoUrl'
    // a persistent server URL becomes an appended enrichment patch (the record stays
    // append-only); a session blob: URL (queue restore) is a display-only overlay
    if (url.startsWith('blob:')) journal.overlaySession(rowId, { [field]: url })
    else journal.appendPatch(rowId, { [field]: url })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const media = useMediaQueue({
    incidentId: incidentMeta.id, readOnly,
    onUploaded: swapRowMedia, onRestore: swapRowMedia,
  })

  // upload a captured photo/audio blob and swap the timeline row's session blob: URL for the
  // persistent server URL (so history keeps the media). On failure the blob is persisted to the
  // offline queue so the capture survives a reload and re-uploads when connectivity returns.
  const uploadMediaForRow = useCallback(async (rowId: string, localUrl: string, kind: 'photo' | 'audio') => {
    if (readOnly) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return /* the blob: URL is already gone — nothing to persist */ }
    try {
      const { url } = await uploadMedia(incidentMeta.id, blob, kind)
      swapRowMedia(rowId, kind, url)
    } catch {
      // offline / server error — keep the blob for later instead of losing it this session
      await media.enqueue(rowId, kind, blob, `${kind}-${rowId}`, new Date().toISOString())
    }
  }, [incidentMeta.id, readOnly, media, swapRowMedia])

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
      if (pending || pendingShape) { setPending(null); setPendingShape(null); setTool('select') }
      else if (panel || viewsOpen) { setPanel(null); setViewsOpen(false) }
      else if (selectedId || selectedDrawingId || selectedDrawIds.length || selectedEntityIds.length) { setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, pendingShape, panel, viewsOpen, selectedId, selectedDrawingId, selectedDrawIds, selectedEntityIds])

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
    if (changedToSelection) { setPanel(null); setViewsOpen(false); setTool('select'); setPending(null); setPendingShape(null); setDraft([]) }
  }, [selKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || reportPreflightOpen || composerOpen || journalOpen || teamPick) setPanel(null)
  }, [settingsOpen, paletteOpen, pickerOpen, helpOpen, installGuideOpen, offlineReadyOpen, reportPreflightOpen, composerOpen, journalOpen, teamPick])

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
  useEffect(() => { savePrefs({ ...loadPrefs(), mode, activePlanId, symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn }) }, [mode, activePlanId, symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn])

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
    linePreset, setLinePreset, lineMode, setLineMode,
    draftActive, lineNodes, selectedDrawing,
    commitDraft, onFreehand, setDraftPointAttachment, createCircle, applyLinePreset, patchDrawing, patchDrawingById,
    editDrawingCoords, moveLabel, insertDrawingVertex, deleteDrawingVertex, deleteDrawing, setDrawingAttachment,
  } = useMapDrawing({
    drawings, resolvedDrawings: resolvedMapDrawings, selectedDrawingId, tacticalLocked, tool, setTool,
    commit, setDocRaw, beginDrag, endDrag, emit, log,
    setSelectedDrawingId, setSelectedId, setSelectedDrawIds, setSelectedEntityIds,
  })
  const changeMapEnding = async (ending: 'none' | 'arrow' | 'teilstueck') => {
    if (!selectedDrawing) return
    const incoming = selectedDrawing.teilstueck && ending !== 'teilstueck'
      ? drawings.flatMap((d) => (['start', 'end'] as const).filter((endpoint) => {
        const a = endpoint === 'start' ? d.startAttachment : d.endAttachment
        return a?.target.kind === 'line' && a.target.id === selectedDrawing.id && a.target.endpoint === 'end'
      }).map((endpoint) => ({ id: d.id, endpoint }))) : []
    if (incoming.length) {
      const ok = await confirmDialog({ title: appConfig.copy.drawingEditor.endingTeilstueck, message: fillTemplate(appConfig.copy.drawingEditor.removeEMessage, { n: incoming.length }), confirmLabel: appConfig.copy.confirm.ok, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    const resolvedTarget = resolvedMapDrawings.find((d) => d.id === selectedDrawing.id)
    const fallback = resolvedTarget?.coords[resolvedTarget.coords.length - 1] ?? selectedDrawing.coords[selectedDrawing.coords.length - 1]
    commit((doc) => ({ ...doc, drawings: doc.drawings.map((d) => {
      if (d.id === selectedDrawing.id) return { ...d, arrow: ending === 'arrow' || undefined, teilstueck: ending === 'teilstueck' || undefined }
      let next = d
      for (const endpoint of ['start', 'end'] as const) {
        const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
        if (!incoming.some((x) => x.id === d.id && x.endpoint === endpoint) || !a || next.coords.length < 2) continue
        const coords = next.coords.map((p, i) => i === (endpoint === 'start' ? 0 : next.coords.length - 1) ? fallback : p)
        next = { ...next, coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
      }
      return next
    }) }))
    emit('draw.edit', { id: selectedDrawing.id, patch: { arrow: ending === 'arrow' || undefined, teilstueck: ending === 'teilstueck' || undefined } })
    incoming.forEach(({ id, endpoint }) => {
      const line = drawings.find((d) => d.id === id)
      if (!line) return
      const coords = line.coords.map((p, i) => i === (endpoint === 'start' ? 0 : line.coords.length - 1) ? fallback : p)
      emit('draw.edit', { id, patch: { coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) } })
    })
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
    const target = layers.find((l) => l.id === id)
    emit('layer.toggle', { id, base: !!target?.base, visible: target?.base ? true : !(target?.visible ?? true) })
    setLayers((ls) => {
      const target = ls.find((l) => l.id === id)
      if (!target) return ls
      if (target.base) return ls.map((l) => (l.base ? { ...l, visible: l.id === id } : l))
      return ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    })
  }
  const setOpacity = (id: LayerId, v: number) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: v } : l)))
  // Ebenen shares the dock slot with the views popover and the tool docks — opening it
  // drops the active tool and closes the views menu (mirror of toggleViews below).
  const togglePanel = (name: 'layers') => {
    if (panel === name) { setPanel(null); return }
    setTool('select'); setPending(null); setPendingShape(null); setDraft([])
    setViewsOpen(false)
    setPanel(name)
  }

  // navigate from a Verlauf row back to wherever the event happened, then close
  // the drawer. Plan rows switch surface + document and (when located) recenter.
  const focusEvent = (e: TimelineEvent) => {
    if (e.surface === 'plan' && e.planId) {
      if (e.planId === gebaeudeDoc.id && !building) { setJournalOpen(false); return } // floor-stack gone
      setMode('plans'); setPanel(null); setActivePlanId(e.planId)
      if (e.px != null && e.py != null) setPlanFocus({ x: e.px, y: e.py, floor: e.floor ?? 0, annoId: e.annoId, nonce: Date.now() })
    } else if (e.coord) {
      setMode('map'); mapRef.current?.flyTo({ center: e.coord, zoom: 18 })
    } else if (e.entityId) {
      setMode('map'); focusEntity(e.entityId)
    }
    setJournalOpen(false)
  }

  // quick-add a journal entry (text and/or voice memo), optionally pinned to the
  // current view so the row becomes a clickable, located marker.
  const addJournal = (d: JournalDraft) => {
    const onPlan = mode === 'plans'
    // Wiedervorlage: an appended `created` reminder row (never a mutable status field — see
    // lib/reminders.ts). Ask for notification permission here, on the user's submit gesture.
    if (d.dueAt) {
      const rid = `rem${Date.now()}`
      pushEvent({
        icon: 'clock', text: d.text, kind: 'reminder', at: composerOpenedAt.current ?? undefined,
        surface: onPlan ? 'plan' : 'map', planId: onPlan ? activePlanId : undefined,
        reminder: { op: 'created', id: rid, dueAt: d.dueAt },
      })
      void ensureNotifyPermission()
      emit('reminder.create', { id: rid, dueAt: d.dueAt })
      setComposerOpen(false); setJournalOpen(true)
      toast(appConfig.copy.journal.reminderSaved, { icon: 'clock', tone: 'success' })
      return
    }
    let coord: LngLat | undefined, px: number | undefined, py: number | undefined, floor: number | undefined
    if (d.pin) {
      if (onPlan) { ({ x: px, y: py, floor } = planCenter.current) }
      else { const c = mapRef.current?.getMap().getCenter(); if (c) coord = [c.lng, c.lat] }
    }
    const pinned = d.pin && (coord != null || px != null)
    const icon = d.audioUrl ? 'mic' : d.photoUrl ? 'photo' : 'type'
    const kind = d.audioUrl ? 'audio' : d.photoUrl ? 'photo' : 'journal'
    const imported = d.audioMeta?.source === 'imported'
    const body = d.text
      || (imported
        ? fillTemplate(appConfig.copy.journal.audioImportedNote, { duration: d.audioMeta?.durationSec != null ? formatAudioDuration(d.audioMeta.durationSec) : '–' })
        : d.audioUrl ? `${appConfig.copy.log.audioNote}${d.secs ? ` (${d.secs}s)` : ''}` : d.photoUrl ? appConfig.copy.journal.photoNote : appConfig.copy.log.journalNote)
    const rowId = `e${Date.now()}-j`
    pushEvent({
      icon, text: body, kind, audioUrl: d.audioUrl, photoUrl: d.photoUrl, audioMeta: d.audioMeta,
      // an imported memo lands at its confirmed recording start; everything else at composer-open
      at: (imported ? d.audioMeta?.startedAt : undefined) ?? composerOpenedAt.current ?? undefined,
      surface: onPlan ? 'plan' : 'map', planId: onPlan ? activePlanId : undefined, coord, px, py, floor, pinned,
    }, rowId)
    if (d.photoUrl) void uploadMediaForRow(rowId, d.photoUrl, 'photo')
    // an imported memo's audioUrl is already the server URL (uploaded during save) — only a
    // session blob: URL (in-app recording) still needs the upload/queue path
    if (d.audioUrl?.startsWith('blob:')) void uploadMediaForRow(rowId, d.audioUrl, 'audio')
    emit('journal.add', { id: rowId, kind })
    setComposerOpen(false); setJournalOpen(true)
    toast(appConfig.copy.journal.saved, { icon, tone: 'success' })
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
    { dueTitle: appConfig.copy.journal.dueTitle, doneLog: appConfig.copy.journal.doneLog, snoozeLog: appConfig.copy.journal.snoozeLog },
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

  const pick = (id: string) => {
    if (id === 'symbol') { setPaletteOpen(true); return }
    // Auswahl (select) is the default navigate state: one finger pans the map, a tap
    // selects, a drag on an object moves it. There is no separate pan mode any more —
    // panning is always available — so tapping Auswahl while active just clears any
    // current selection rather than toggling into a hidden mode.
    if (id === 'select' && tool === 'select') {
      setSelectedId(null); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
      return
    }
    // tapping the already-active tool again exits it → back to Auswahl (closes its option dock)
    if (id === tool) { setTool('select'); setPending(null); setPendingShape(null); setDraft([]); return }
    setTool(id); setPending(null); setPendingShape(null); setDraft([])
  }

  const pickShape = (kind: ShapeKind) => { setTool('shape'); setPending(null); setPendingShape(kind); setPaletteOpen(false) }

  const onMapClick = (c: LngLat) => {
    // a map tap dismisses an open Ebenen panel first (parity with the phone backdrop) —
    // the panel is map chrome, so tapping the map behind it should just close it
    if (panel !== null) { setPanel(null); return }
    if (tool === 'shape' && pendingShape) {
      const id = `sh${Date.now()}`; const def = SHAPE_DEFS[pendingShape]
      const name = appConfig.copy.shapes.names[pendingShape]
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, coord: c, shape: pendingShape, color: def.defaultColor, sizeM: def.defaultSizeM, rotation: 0, label: name }] }))
      // unlocked: place once, then drop back to select with the new shape active so
      // its edit handles are immediately usable. locked: stay in place-mode (no
      // selection so the editor doesn't interrupt) to drop several in a row.
      if (placeLock) { setSelectedId(null); setSelectedDrawingId(null) }
      else { setPendingShape(null); setTool('select'); setSelectedId(id); setSelectedDrawingId(null) }
      log('area', fillTemplate(appConfig.copy.log.shapePlaced, { name }), 'symbol', undefined, id)
      emit('entity.add', { id, kind: 'shape', entity: { id, kind: 'shape', layer: appConfig.defaults.drawingLayerId, coord: c, shape: pendingShape, color: def.defaultColor, sizeM: def.defaultSizeM, rotation: 0, label: name } })
    } else if (tool === 'symbol' && pending) {
      const id = `p${Date.now()}`; const s = pending
      // shared seeding (label / subtitle / fields / vehicle rotation) — identical to
      // the Plan placement path so a symbol carries the same structure on both surfaces
      const entity: Entity = { id, kind: 'symbol', layer: appConfig.defaults.operationalLayerId, coord: c, ...seedSymbolProps(s, sym.symbols) }
      commit((d) => ({ ...d, entities: [...d.entities, entity] }))
      addRecent(s)
      if (placeLock) { setSelectedId(null); setSelectedDrawingId(null) }
      else { setPending(null); setTool('select'); setSelectedId(id); setSelectedDrawingId(null) }
      log('hex', fillTemplate(appConfig.copy.log.symbolPlaced, { name: entity.label || formatSymbolName(s) }), 'symbol', undefined, id)
      emit('entity.add', { id, symbol: s, entity })
      offerMittelCapture(s)
    } else if (tool === 'note') {
      const id = `n${Date.now()}`
      commit((d) => ({ ...d, entities: [...d.entities, { id, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: c, label: '', subtitle: appConfig.copy.entities.noteSubtitle }] }))
      setSelectedId(id); setSelectedDrawingId(null); setEditNoteId(id); setTool('select'); log('type', appConfig.copy.log.notePlaced, 'note', undefined, id)
      emit('entity.add', { id, kind: 'note', entity: { id, kind: 'note', layer: appConfig.defaults.drawingLayerId, coord: c, label: '', subtitle: appConfig.copy.entities.noteSubtitle } })
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
      map.flyTo({ center: incidentView.center, zoom: 17.6 })
    } else {
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 96, maxZoom: 17.6, duration: 600 })
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
    onGo: (v) => mapRef.current?.flyTo({ center: v.center, zoom: v.zoom, bearing: v.bearing, duration: 600 }),
    onResetNorth: () => mapRef.current?.resetNorth(),
    onFit: centerIncident,
    onLocate: () => setLocateReq((n) => n + 1),
    onSave: () => {
      const n = cameraViews.length + 1
      const v: CameraView = { id: 'v' + Date.now(), name: fillTemplate(appConfig.copy.mapViews.defaultName, { n }), center: view.center, zoom: view.zoom, bearing: view.bearing }
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
    if (open) { setTool('select'); setPending(null); setPendingShape(null); setDraft([]); setPanel(null) }
    setViewsOpen(open)
  }

  // --- keyboard shortcuts ---------------------------------------------------------------------
  // Duplicate the current selection (Cmd/Ctrl+D) — a small nudge so the copy is visibly offset and
  // separately selectable. Single symbol/shape/note OR single drawing; live GPS markers can't be
  // copied. Multi-select duplicate isn't wired (rare; would need per-item id remap).
  const DUP_OFFSET = 0.00008 // ~6–9 m in WGS84 at Swiss latitudes
  const duplicateSelection = () => {
    if (readOnly) return
    if (selectedId && !tacticalLocked) {
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
  const goToModule = (n: number) => {
    const doc = planDocs.find((p) => moduleNumbers(p).includes(n))
    if (!doc) return
    setMode('plans'); setActivePlanId(doc.id); setPanel(null)
  }

  // Reassigned every render (effect, no deps) so the mount-once listener (above) always sees
  // live handlers/state without re-subscribing — the latest-ref pattern.
  useEffect(() => { hotkeyRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(document.activeElement)) return
    // a modal sheet owns the screen — its own focus trap / Esc handle keys; stay inert behind it.
    if (settingsOpen || paletteOpen || pickerOpen || helpOpen || installGuideOpen || offlineReadyOpen || reportPreflightOpen || composerOpen) return
    const cmd = resolveHotkey(e)
    if (!cmd) return
    const onMap = mode === 'map', onPlan = mode === 'plans', drawing = onMap || onPlan
    switch (cmd.type) {
      case 'module': e.preventDefault(); goToModule(cmd.n); break
      case 'surface': e.preventDefault(); if (cmd.surface === 'map') setPanel(null); setMode(cmd.surface); break
      case 'nav': e.preventDefault(); goToNav(cmd.dir); break
      case 'fit':
        e.preventDefault()
        if (onPlan) planFit.current?.(); else if (onMap) centerIncident()
        break
      case 'undo': e.preventDefault(); if (onPlan) planHist.current?.undo(); else undo(); break
      case 'redo': e.preventDefault(); if (onPlan) planHist.current?.redo(); else redo(); break
      case 'duplicate': if (onMap) { e.preventDefault(); duplicateSelection() } break
      case 'tool':
        if (!drawing || readOnly || tacticalLocked) break
        e.preventDefault()
        if (onMap) pick(cmd.tool); else planKeys.current?.pickTool(cmd.tool)
        break
      case 'panel':
        switch (cmd.panel) {
          case 'journal': e.preventDefault(); setJournalOpen((v) => !v); break
          case 'composer': if (!readOnly) { e.preventDefault(); setComposerOpen(true) } break
          case 'layers': if (onMap) { e.preventDefault(); togglePanel('layers') } break
          case 'picker': e.preventDefault(); setPickerOpen(true); break
          case 'settings': e.preventDefault(); setSettingsOpen(true); break
          case 'help': e.preventDefault(); setHelpOpen(true); break
        }
        break
      case 'view':
        switch (cmd.view) {
          case 'zoomIn': e.preventDefault(); if (onPlan) planKeys.current?.zoom(1.3); else mapRef.current?.zoomIn(); break
          case 'zoomOut': e.preventDefault(); if (onPlan) planKeys.current?.zoom(1 / 1.3); else mapRef.current?.zoomOut(); break
          case 'locate': if (onMap) { e.preventDefault(); setLocateReq((n) => n + 1) } break
          case 'coord': if (onMap) { e.preventDefault(); coord.cycle() } break
          case 'north': if (onMap) { e.preventDefault(); mapRef.current?.resetNorth() } break
        }
        break
    }
  } })

  const DRAW_COLORS = appConfig.drawing.colors
  const DRAW_WIDTHS = appConfig.drawing.widths

  const selected = entities.find((e) => e.id === selectedId) ?? null

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
      const r = panelEl.getBoundingClientRect()
      if (!r.width) return // panel present but CSS-hidden — nothing occludes
      const pt = m.project(selected.coord)
      // phone bottom sheet → nudge up; desktop/tablet side panel → nudge left
      const nudge = isBottomSheet(r.width, cont.width)
        ? panelNudgeUp(pt, { top: r.top - cont.top })
        : panelNudge(pt, { left: r.left - cont.left, top: r.top - cont.top, bottom: r.bottom - cont.top })
      if (nudge) m.panBy(nudge, { duration: 350 })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mode])
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
      const r = panelEl.getBoundingClientRect()
      if (!r.width) return // panel present but CSS-hidden — nothing occludes
      const coords = d.kind === 'circle' && d.radiusM
        ? (circlePolygon(d.coords[0], d.radiusM, 16)[0] as LngLat[])
        : d.coords
      const pts = coords.map((c) => m.project(c))
      const box = {
        minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
      }
      const nudge = isBottomSheet(r.width, cont.width)
        ? panelNudgeBoxUp(box, { top: r.top - cont.top })
        : panelNudgeBox(box, { left: r.left - cont.left, top: r.top - cont.top, bottom: r.bottom - cont.top })
      if (nudge) m.panBy(nudge, { duration: 350 })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingId, mode])
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
      const ok = await confirmDialog({ title: appConfig.copy.whiteboard.groupDeleted, message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }), confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
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
    setSelectedDrawIds([]); setSelectedEntityIds([]); log('close', appConfig.copy.log.drawingDeleted)
  }

  // select + fly to an object — used by clickable Verlauf rows
  const focusEntity = (id: string) => {
    const e = entities.find((x) => x.id === id); if (!e) return
    setSelectedId(id); setSelectedDrawingId(null); mapRef.current?.flyTo({ center: e.coord, zoom: 18.4 })
  }
  const focusDrawing = (id: string) => {
    const d = drawings.find((x) => x.id === id); if (!d?.coords[0]) return
    setSelectedDrawingId(id); setSelectedId(null); mapRef.current?.flyTo({ center: d.coords[0], zoom: 17.8 })
  }
  const deleteEntity = async (id: string) => {
    const ent = entities.find((e) => e.id === id)
    // a trail-carrying team stays: clear the trail deliberately first (plan-board parity)
    if (teamEntityLocked(ent)) { toast(appConfig.copy.whiteboard.deleteLocked, { icon: 'lock', tone: 'warn' }); return }
    const connected = drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === id))
    // Written notes and any indirectly detached lines ask once before the structural change.
    if ((ent?.kind === 'note' && (ent.label ?? '').trim()) || connected.length) {
      const ok = await confirmDialog({
        title: connected.length ? fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: ent?.label ?? appConfig.copy.entities.fallbackObjectName }) : appConfig.copy.notes.deleteTitle,
        message: connected.length ? fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: connected.length }) : appConfig.copy.notes.deleteMsg,
        confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
      })
      if (!ok) return
    }
    commit((d) => ({
      ...d,
      entities: d.entities.filter((e) => e.id !== id),
      drawings: d.drawings.map((dr) => {
        let next = dr
        for (const endpoint of ['start', 'end'] as const) {
          const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
          if (a?.target.kind !== 'object' || a.target.id !== id || !ent || next.coords.length < 2) continue
          const coords = next.coords.map((p, i) => i === (endpoint === 'start' ? 0 : next.coords.length - 1) ? ent.coord : p)
          next = { ...next, coords, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
        }
        return next
      }),
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
  }
  // a generic (untracked) team marker — the map twin of the plan's placeTeamChip
  const { placeGenericTeam, markTeamPosition, clearTeamTrail } = useTeamMarkerActions({ entities, commit, log, emit, setSelectedId, setSelectedDrawingId })
  // --- Atemschutzüberwachung (SCBA monitoring): Trupp mutations live in useTruppActions ---
  const { createTrupp, updateTrupp, placeTruppOnPlan, placeTruppOnMap, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, logTruppAlarm, deleteTrupp, restoreTrupp } =
    useTruppActions({
      trupps, setTrupps, board, setBoard, setDocRaw, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus,
      // a new map marker lands at the current map centre (the operator drags it to position);
      // fall back to the Einsatzort when the map hasn't been opened yet this session
      mapCenter: () => {
        const c = mapRef.current?.getMap()?.getCenter()
        return c ? [c.lng, c.lat] as LngLat : incidentView.center
      },
      // jump-to for a team marker: coord is passed on placement (state not yet committed);
      // later focuses look the entity up like a Verlauf row does. fly=false selects without
      // moving the camera (tap-placed markers are already in view).
      focusMapEntity: (entityId, coord, fly = true) => {
        setMode('map')
        if (!fly) { setSelectedId(entityId); setSelectedDrawingId(null); return }
        if (coord) { setSelectedId(entityId); setSelectedDrawingId(null); mapRef.current?.flyTo({ center: coord, zoom: 18.4 }) }
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
  // SCBA contact-clock alarm runs app-wide (not just on the Atemschutz surface) so an überfällig
  // Trupp alerts no matter which page is open. Paused during replay (read-only past view).
  // Hosted in a null-rendering child (see AtemschutzAlarmHost): its 1 Hz tick must NOT re-render
  // App — that repainted the whole tree every second a Trupp was in the field (battery drain).
  const [azAlarm, setAzAlarm] = useState<AtemschutzAlarmState>({ peak: 0, urgent: null })

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
    return {
      tiles,
      plan: Object.values(backendPlans)[0] ?? null,
      // every reference/Leitungs layer (Wasser/Gas/Strom/Abwasser/Hydranten), cropped to the
      // incident box — same URLs the warm caches, so the probe reflects real offline presence.
      geojsons: layers.filter((l) => l.geojson).map((l) => withGeoBbox(l.geojson as string)),
    }
  }, [layers, incidentView.center, backendPlans, withGeoBbox])
  const blockedAttendanceIds = useMemo(() => assignedPersonIds(trupps), [trupps])
  const { markPresent, markLeft, clearAttendance, setAttendanceTimes } = useAttendanceActions({
    attendance, setAttendance, blockedAttendanceIds,
    startedAt: incidentMeta.started_at, reportDoneAt: incidentMeta.report_done_at, log,
  })
  const { saveMittel, offerMittelCapture } = useMittelActions({ mittel, setMittel, authorName: user?.display_name, log })
  // assigning someone to a Trupp implies they're on scene — mark every roster-linked member
  // present (even at "angemeldet"). Only the newly-present are logged, so re-edits don't spam.
  const rosterById = useMemo(() => new Map(personnel.map((p) => [p.id, p])), [personnel])
  // active-member names feeding the symbol detail comboboxes (Einsatzleiter / Offizier / Fahrer)
  const rosterNames = useMemo(() => personnel.filter((p) => p.active).map((p) => p.displayName), [personnel])
  // name → rank key, for the officer-first sort + "nur Offiziere" filter on leadership symbols
  const rosterRank = useMemo(
    () => Object.fromEntries(personnel.filter((p) => p.active).map((p) => [p.displayName, p.rank])),
    [personnel],
  )
  // present crew (attendance) — offered first in the Einsatzleiter picker (mirrors Atemschutz)
  const presentIds = useMemo(() => new Set(Object.entries(attendance).filter(([, a]) => a.status === 'present').map(([id]) => id)), [attendance])
  const ensurePresentFromTrupp = (ids: (string | undefined)[]) => {
    const fresh = [...new Set(ids.filter(Boolean) as string[])].filter((id) => attendance[id]?.status !== 'present')
    if (!fresh.length) return
    const now = new Date().toISOString()
    setAttendance((cur) => {
      const next = { ...cur }
      for (const id of fresh) {
        const name = rosterById.get(id)?.displayName ?? cur[id]?.displayNameSnapshot ?? id
        next[id] = { status: 'present', checkedInAt: cur[id]?.checkedInAt ?? incidentMeta.started_at, leftAt: cur[id]?.leftAt, displayNameSnapshot: name }
      }
      return next
    })
    for (const id of fresh) log('people', `${rosterById.get(id)?.displayName ?? id} anwesend`, 'team')
  }
  const createTruppA = (t: Trupp) => { createTrupp(t); ensurePresentFromTrupp([t.leaderPersonId, ...(t.memberPersonIds ?? [])]) }
  const editTruppA = (id: string, f: TruppFields) => { editTrupp(id, f); ensurePresentFromTrupp([f.leaderPersonId, ...(f.memberPersonIds ?? [])]) }
  const reactivateTruppA = (id: string, f: TruppFields) => { reactivateTrupp(id, f); ensurePresentFromTrupp([f.leaderPersonId, ...(f.memberPersonIds ?? [])]) }

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
    else if (a === 'plan') { setMode('plans'); setPanel(null) }
    else if (a === 'draw') { setMode('map'); setTool('line') }
  }

  const mapUI = mode === 'map'

  const annotatedPlanCount = useMemo(() => annotatedPlans(planDocs, board, false).length, [planDocs, board])

  return (
    <div className={`app mode-${mode}${phoneTools ? ' phone-tools' : ''} ${(tool === 'symbol' && pending) || (tool === 'shape' && pendingShape) ? 'placing' : ''}`}>
      <IconSprite />
      {/* #10 phase 2: phone-only edge-swipe strips over the map/plan canvas — swipe inward from a
          screen edge to change section (the canvas keeps its pan/zoom everywhere else). */}
      {canvasEdge && <div className="edge-swipe edge-swipe-l" ref={edgeLRef} aria-hidden />}
      {canvasEdge && <div className="edge-swipe edge-swipe-r" ref={edgeRRef} aria-hidden />}
      <AtemschutzAlarmHost trupps={trupps} muted={atemschutzMuted} active={!replayActive}
        logAlarm={logTruppAlarm} intervalMin={azIntervalMin} graceSec={azGraceSec} onState={setAzAlarm} />

      {sym.ready ? (
        <MapView
          ref={mapRef}
          entities={entities}
          layers={mapLayers}
          byName={sym.byName}
          symMul={symMul}
          captionMode={symbolCaptions}
          initialCenter={incidentView.center}
          fitPoints={initialFitPoints}
          locateNonce={locateReq}
          mapActive={mapUI}
          weather={displayWeather}
          onOpenWeather={openWeatherDetails}
          replayActive={replayActive}
          editNoteId={editNoteId}
          onNoteText={noteTextLive}
          onNoteCommit={noteTextCommit}
          onNoteEdit={(id) => { setSelectedId(id); setSelectedDrawingId(null); setEditNoteId(id) }}
          trupps={trupps}
          onShowTrupp={() => { setMode('atemschutz'); setPanel(null) }}
          onTeamMark={tacticalLocked ? undefined : markTeamPosition}
          onTeamClearTrail={tacticalLocked ? undefined : clearTeamTrail}
          preparedOverlays={preparedOverlays}
          isVisible={isVisible}
          selectedId={selectedId}
          onSelect={(e) => { setSelectedId(e.id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }}
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
          onMarkerDragStart={(id) => { if (!liveIds.has(id)) beginDrag() }}
          onMarkerMove={(id, c) => {
            if (tacticalLocked) return
            if (liveIds.has(id)) setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], coord: c } }))
            else setDocRaw((d) => ({
              ...d,
              entities: d.entities.map((e) => (e.id === id ? { ...e, coord: c } : e)),
              drawings: d.drawings.map((dr) => {
                if (dr.kind !== 'line') return dr
                let next = dr
                for (const endpoint of ['start', 'end'] as const) {
                  const a = endpoint === 'start' ? next.startAttachment : next.endAttachment
                  if (a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace') next = { ...next, coords: applyRouting(next.coords, endpoint, c, 'trace', 0.000008) }
                }
                return next
              }),
            }))
          }}
          onMarkerDragEnd={(id, c) => {
            if (tacticalLocked) return
            if (liveIds.has(id)) {
              setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], coord: c } }))
            } else {
              // a moved team marker re-stamps its «last moved» time (plan-chip parity);
              // it does NOT breadcrumb — positions are recorded only via markTeamPosition
              setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, coord: c, ...(e.kind === 'team' ? { t: formatTime(new Date()) } : {}) } : e)) }))
              endDrag()
            }
            log('select', fillTemplate(appConfig.copy.log.objectMoved, { name: entities.find((x) => x.id === id)?.label ?? appConfig.copy.entities.fallbackObjectName }), 'symbol', undefined, id)
            emit(liveIds.has(id) ? 'entity.edit' : 'entity.move', { id, coord: c })
            drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === id && a.routing === 'trace'))
              .forEach((d) => emit('draw.edit', { id: d.id, patch: { coords: d.coords } }))
          }}
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
          onSelectDrawing={(id) => { setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null) }}
          onUnlockDrawing={(id) => { patchDrawingById(id, { locked: undefined }); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null) }}
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
        recording={voice.recording}
        recStartedAt={voice.recStartedAt}
        journalOpen={journalOpen}
        onToggleJournal={() => setJournalOpen((v) => !v)}
        reminderCount={reminders.openCount}
        onAddEntry={() => setComposerOpen(true)}
        onHoldStart={startVoiceMemo}
        onHoldEnd={voice.stop}
        onUndo={mode === 'plans' ? () => planHist.current?.undo() : undo}
        onRedo={mode === 'plans' ? () => planHist.current?.redo() : redo}
        canUndo={mode === 'plans' ? planCan.canUndo : canUndo}
        canRedo={mode === 'plans' ? planCan.canRedo : canRedo}
        // undo/redo act on the drawing documents — off the drawing surfaces they'd
        // invisibly mutate the map, so the pair (and its separator) hides there
        showHistory={!tacticalLocked && (mode === 'map' || mode === 'plans')}
        weather={mapUI ? displayWeather : null}
        onOpenWeather={openWeatherDetails}
        bearing={view.bearing}
        azAlarm={azAlarm}
        onOpenAtemschutz={() => { setMode('atemschutz'); setPanel(null) }}
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
            onSettings={() => setSettingsOpen(true)}
            onSwitch={onSwitchIncident}
            onHistory={onOpenHistory}
            onDivera={onOpenDivera}
            onDatenquellen={onOpenDatenquellen}
            onReportPrint={() => setReportPreflightOpen(true)}
            onArchive={canEditIncident && !readOnly ? onArchiveActive : undefined}
            onHelp={() => setHelpOpen(true)}
            onInstall={isStandalone() || !installOffered(getInstallPlatform()) ? undefined : () => setInstallGuideOpen(true)}
            onOfflineReadiness={() => setOfflineReadyOpen(true)}
            onSyncNow={syncNow}
            onLogout={() => { void logout() }}
            navKey={`${mode}|${journalOpen ? 'journal' : ''}`}
            objectName={activeObjectName}
            onObjectSwitch={() => setPickerOpen(true)}
          />
        }
      />

      <ReminderBanner
        due={reminders.due}
        onDone={reminders.markDone}
        onSnooze={(r) => reminders.snooze(r, 10)}
        onOpen={() => setJournalOpen(true)}
      />

      {mapUI && !tacticalLocked && pausedGpsConnections.length > 0 && (
        <div className="gps-follow-prompts" role="status">
          {pausedGpsConnections.map(({ drawing, endpoint, attachment }) => (
            <div className="gps-follow-prompt" key={`${drawing.id}:${endpoint}`}>
              <Icon id="warn" />
              <span><b>{appConfig.copy.drawingEditor.gpsMovingAway}</b><small>{entities.find((e) => e.id === attachment.target.id)?.label ?? drawing.label ?? appConfig.copy.drawingEditor.drawing}</small></span>
              <button onClick={() => setGpsRouting(drawing, endpoint, 'trace')}>{appConfig.copy.drawingEditor.gpsContinue}</button>
              <button onClick={() => detachGpsHere(drawing, endpoint)}>{appConfig.copy.drawingEditor.gpsDetachHere}</button>
            </div>
          ))}
        </div>
      )}

      {/* one-tap way back after a Rapport checklist row navigated here — without it, the
          round trip went through the incident menu every time (feedback 2026-07-08) */}
      {rapportReturn && !reportPreflightOpen && (mode === 'anwesenheit' || mode === 'mittel') && (
        <button
          type="button"
          className="rp-return"
          onClick={() => { setRapportReturn(false); setReportPreflightOpen(true) }}
        >
          <Icon id="doc" /> {appConfig.copy.abschluss.backToRapport}
        </button>
      )}

      {/* non-blocking "new build ready" prompt — waits for the operator instead of auto-reloading */}
      <UpdateBanner />

      {/* "Als App installieren" nudge — browser-tab only, one «Später» dismisses it for good
          on this device (the menu keeps the permanent entry); must stay ADJACENT to
          UpdateBanner: a CSS sibling rule stacks the two when both are visible.
          Hidden on the demo: a visitor isn't installing the demo as their command app. */}
      {!isDemoMode() && <InstallBanner onOpenGuide={() => setInstallGuideOpen(true)} />}

      {/* No demo «Zurücksetzen» button: it sat bottom-centre over the map's bottom controls
          (obstructing them on a phone), and a plain page reload already restores the pristine
          scene — the sandbox keeps a visitor's edits in React state only (see useIncidentSync),
          so reloading re-fetches the curated seed. The welcome modal spells this out. */}

      {/* another tab of this browser is editing this incident → this one is read-only; one tap
          moves editing here (only meaningful for editors — viewers are read-only anyway) */}
      {tabLockLost && user?.role === 'editor' && <TabLockBanner onTakeOver={onTakeOverTab} />}

      {/* archived incident open read-only (via «Alle Einsätze») → name the state so the
          missing tools read as policy, not breakage; editors get the deliberate exit */}
      {incidentMeta.is_archived && <ArchivedBanner onBack={onBackFromArchive} onReactivate={onReactivateActive} />}

      {/* correct-in-place: a one-tap Divera take lands here operational immediately; the
          banner lets the EL fix category inline or open the edit panel for address/location */}
      {needsReview && !readOnly && (
        <ReviewBanner
          meta={incidentMeta}
          categories={appConfig.copy.intake.kategorien}
          onPatchType={(k) => onPatchMeta({ type: k })}
          onEdit={onEditMeta}
          onDone={onReviewDone}
        />
      )}

      {/* single left navigation rail — all surfaces; switches Karte / object Pläne / Checkliste */}
      <NavRail
        mode={mode}
        onMode={(m) => { setMode(m); if (m !== 'map') setPanel(null) }}
        planDocs={planDocs}
        activePlanId={activePlanId}
        onSelectPlan={(id) => { setMode('plans'); setActivePlanId(id); setPanel(null) }}
        azSeverity={azAlarm.peak}
        mapControls={mapUI && isPhone ? (
          // PHONE ONLY: the bottom surface bar keeps the Ebenen launcher (the right tool
          // rail's footer is CSS-hidden in the phone bar); desktop/tablet pin it in the
          // right ToolRail footer / MapUtility instead, so the left rail is identical on
          // every surface. Basiskarte selection lives INSIDE the Ebenen panel everywhere.
          <>
            <div className="nav-sep" />
            <button className={`nav-item${panel === 'layers' ? ' on' : ''}`} aria-pressed={panel === 'layers'} aria-label={appConfig.copy.panels.layers} onClick={() => togglePanel('layers')}>
              <span className="nav-glyph"><Icon id="layers" /></span><span className="nav-label">{appConfig.copy.panels.layers}</span>
            </button>
          </>
        ) : undefined}
      />

      {mapUI && (
        <>
          {/* zoom + locate — normally folded into the right ToolRail footer; floats
              top-right only on desktop where the rail is gone (read-only / replay). On a
              phone, the floating .phone-compass cluster below carries Einpassen · Standort ·
              wind, so this cluster isn't rendered there at all. */}
          {tacticalLocked && !isPhone && (
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
              top-right under the bar instead, for editors and viewers alike. */}
          {isPhone && (
            <div className="phone-compass">
              <MapViewsButton api={viewsApi} bearing={view.bearing} readOnly={readOnly} variant="util" btnClassName="pc-btn" activeClassName="on" glyphClassName="pc-glyph" open={viewsOpen} onOpenChange={toggleViews} coordsOn={coord.mode !== 'off'} onToggleCoords={coord.cycle} />
              {/* wind rides with the compass on phones — in the bar it clipped at the screen
                  edge (the bar already carries switcher · Einsatzuhr · locate · undo/redo · Verlauf) */}
              {displayWeather?.wind_dir_deg != null && <WeatherBadge weather={displayWeather} onOpenMeteo={openWeatherDetails} bearing={view.bearing} />}
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
      {mapUI && panel !== null && isPhone && <div className="mapctl-backdrop" onClick={() => setPanel(null)} />}

      {/* the Ebenen dock (.layers-card z201) sits ABOVE the +Eintrag composer / Verlauf
          scrim that covers every other map popup, so it needs an explicit guard to hide
          with them — otherwise it pokes through the modal (parity with the tool popups) */}
      {mapUI && panel === 'layers' && !composerOpen && !journalOpen && (
        <LayerPanel
          layers={layers}
          onToggle={toggleLayer}
          onOpacity={setOpacity}
          onDownloadOffline={downloadOffline}
          offlineProgress={offlineProgress}
          onClose={() => setPanel(null)}
        />
      )}

      {mapUI && !tacticalLocked && !journalOpen && selected && selected.kind === 'shape' && (
        <ShapeEditor
          key={selected.id}
          entity={selected}
          onColor={(c) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, color: c } : e)) }))}
          onScale={(f) => commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === selected.id ? { ...e, sizeM: Math.max(8, Math.min(800, (e.sizeM ?? SHAPE_DEFS[e.shape ?? 'square'].defaultSizeM) * f)) } : e)) }))}
          onCenter={() => mapRef.current?.flyTo({ center: selected.coord, zoom: 18.4 })}
          onDelete={() => deleteEntity(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* rendered even when tactical editing is locked (viewer / EL view — NOT phones, where
          the .ctx overlay is CSS-hidden): tapping a symbol always shows its details; the
          forced readOnly strips every edit affordance inside the panel. */}
      {mapUI && !journalOpen && selected && selected.kind !== 'shape' && selected.kind !== 'note' && selected.kind !== 'team' && tool !== 'symbol' && (
        <ContextPanel
          key={selected.id}
          entity={selected}
          readOnly={selected.live || tacticalLocked}
          svg={selected.symbolSvg ?? (selected.symbol === appConfig.symbols.vehicleName ? vehicleSymbolSvg(selected.label ?? '', selected.rotation ?? 0) : selected.symbol ? sym.byName[selected.symbol] : undefined)}
          autoFocusTitle={autoFocusId === selected.id}
          onClose={() => setSelectedId(null)}
          onCenter={() => mapRef.current?.flyTo({ center: selected.coord, zoom: 18.4 })}
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
          }}
          onFields={(fields) => patchEntity(selected.id, { fields })}
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
          protectedKeys={selected.kind === 'symbol' ? new Set(symbolPresetFieldKeys(selected.symbol, sym.symbols.find((x) => x.name === selected.symbol)?.cat)) : undefined}
          onDelete={() => deleteEntity(selected.id)}
          hasOverride={vehicleOverrides[selected.id] != null}
          onResetGps={selected.live ? () => setVehicleOverrides((m) => { const { [selected.id]: _drop, ...rest } = m; return rest }) : undefined}
          connectedLines={drawings.filter((d) => [d.startAttachment, d.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === selected.id)).map((d) => ({ id: d.id, label: lineLabel(d) }))}
          onFocusLine={focusDrawing}
        />
      )}

      {mapUI && !tacticalLocked && !journalOpen && selectedDrawing && (
        <DrawEditor
          drawing={selectedDrawing}
          pointCount={selectedDrawing.coords.length}
          supportsDistance
          onPreset={applyLinePreset}
          onColor={(c) => patchDrawing({ color: c })}
          onWidth={(w) => patchDrawing({ width: w })}
          onDashed={(dashed) => patchDrawing({ dashed })}
          onLabel={(label) => patchDrawing({ label })}
          onMarker={(marker) => patchDrawing({ marker })}
          onArrow={(arrow) => patchDrawing({ arrow })}
          onEnding={(ending) => void changeMapEnding(ending)}
          onContent={(content) => patchDrawing({ content })}
          onLineNo={(lineNo) => patchDrawing({ lineNo })}
          onFloorTag={(floorTag) => patchDrawing({ floorTag })}
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
          onRouting={(endpoint, routing) => setGpsRouting(selectedDrawing, endpoint, routing)}
          onDetach={(endpoint) => {
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
          onToggleLock={() => { patchDrawing({ locked: selectedDrawing.locked ? undefined : true }); if (!selectedDrawing.locked) setSelectedDrawingId(null) }}
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
        <MeasurePanel mode={measure.mode} coords={measure.path} profile={measure.profile} profileLoading={measure.loading} />
      )}

      {/* the Verlauf drawer now docks INBOARD of this rail (see .journal-drawer /
          .journal-scrim), so the rail — and its pinned zoom/fit footer — stays put
          instead of being buried + replaced by a floating cluster. */}
      {mapUI && !tacticalLocked && (
        <ToolRail
          className="tool-rail"
          primary={appConfig.copy.primarySymbol}
          tools={appConfig.copy.mapTools}
          active={voice.recording ? 'audio' : tool}
          onPick={pick}
          footer={(() => {
            const c = appConfig.copy.nav
            return (
              <>
                {/* Ebenen — PINNED so it never scrolls out of reach on short iPads; the
                    Basiskarte choice lives inside its panel (the BaseSwitcher popover and
                    the standalone Koordinaten button are folded away — coords is a row in
                    the compass menu now, testing feedback 2026-07-14) */}
                <button className={`vrail-nbtn ${panel === 'layers' ? 'on' : ''}`} title={appConfig.copy.panels.layers} aria-label={appConfig.copy.panels.layers} aria-pressed={panel === 'layers'} onClick={() => togglePanel('layers')}><span className="vrail-glyph"><Icon id="layers" /></span><span className="vrail-label">{appConfig.copy.panels.layers}</span></button>
                {/* multi-purpose compass: always shown, rotates to the live bearing, and opens the
                    saved-views menu (Nach Norden · Einpassen · Standort · Koordinaten · saved
                    framings · Ansicht speichern). */}
                <MapViewsButton api={viewsApi} bearing={view.bearing} readOnly={readOnly} variant="rail" btnClassName="vrail-nbtn" activeClassName="on" glyphClassName="vrail-compass" label={appConfig.copy.mapViews.title} open={viewsOpen} onOpenChange={toggleViews} coordsOn={coord.mode !== 'off'} onToggleCoords={coord.cycle} />
                <button className="vrail-nbtn" title={c.zoomOut} aria-label={c.zoomOut} onClick={() => mapRef.current?.zoomOut()}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{c.zoomOut}</span></button>
                <button className="vrail-nbtn" title={c.zoomIn} aria-label={c.zoomIn} onClick={() => mapRef.current?.zoomIn()}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{c.zoomIn}</span></button>
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
        <div className="wb-trupp-scrim" onPointerDown={() => { setTeamPick(null); setTool('select') }}>
          <div className="wb-trupp-pick" onPointerDown={(e) => e.stopPropagation()}>
            <div className="wb-trupp-pick-head">{appConfig.copy.whiteboard.selectTrupp}</div>
            {trupps.filter((t) => t.status !== 'raus').map((t) => (
              <button
                key={t.id} className="wb-trupp-opt"
                onClick={() => { placeTruppOnMap(t.id, teamPick); setTeamPick(null); setTool('select') }}
              >
                <span className="wb-trupp-cap" /><b>{t.name}</b>
                {t.lineNumber && <i>Ltg {t.lineNumber}</i>}
              </button>
            ))}
            <button className="wb-trupp-opt wb-trupp-generic" onClick={() => { placeGenericTeam(teamPick); setTeamPick(null); setTool('select') }}>
              <Icon id="plus" />{appConfig.copy.whiteboard.newTeam}
            </button>
          </div>
        </div>
      )}

      {mode === 'plans' && sym.ready && (
        <Whiteboard
          plans={planDocs}
          onSymbolPlaced={offerMittelCapture}
          // on desktop the Verlauf drawer docks beside the plan's tool rail (same as the
          // map), so the rail + its zoom/fit footer stay live. Only a phone still parks
          // the plan read-only while Verlauf is open (there it's a full-width bottom sheet).
          readOnly={tacticalLocked || (isPhone && journalOpen)}
          activeId={activePlanId}
          symMul={symMul}
          captionMode={symbolCaptions}
          annos={(replayActive ? replayBoard : board)?.[activePlanId] ?? []}
          onChange={(next) => { if (tacticalLocked) return; setBoard((b) => ({ ...b, [activePlanId]: next })) }}
          building={replayActive ? replayBuilding : building}
          onSelectBuilding={async (src, orientDeg) => {
            // picking new footprint(s) replaces the floor-stack; if the current
            // Gebäude already carries work (sketches or extra storeys), confirm
            // before discarding it
            if (!src.length) return
            const hasWork = !!building && ((board.gebaeude?.length ?? 0) > 0 || building.floors.length > 1)
            if (hasWork) {
              const ok = await confirmDialog({
                title: appConfig.copy.whiteboard.replaceBuilding,
                message: appConfig.copy.whiteboard.replaceBuildingConfirm,
                confirmLabel: appConfig.copy.whiteboard.replaceBuilding, cancelLabel: appConfig.copy.cancel, danger: true,
              })
              if (!ok) return
            }
            // auto-orient to longest-axis-horizontal by default; rings/ring/ringAspect
            // mirror the active (oriented) view for back-compat renderers + the north arrow
            const view = buildView(src, orientDeg)
            const prevBuilding = building
            const prevGebaeude = board.gebaeude ?? []
            setBuilding({ src, orientDeg, northUp: false, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect, floors: [0] })
            setBoard((b) => ({ ...b, gebaeude: [] })) // fresh stack for the new building
            setActivePlanId('gebaeude') // auto-jump to the new floor-stack
            if (hasWork) {
              // confirm-with-undo: the replaced stack (floors + sketches) is restorable in place
              toast(appConfig.copy.whiteboard.buildingReplaced, {
                icon: 'undo',
                action: { label: appConfig.copy.undo, onClick: () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: prevGebaeude })) } },
              })
            }
          }}
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
          onRecent={addRecent}
          log={logPlan}
          emit={emit}
          historyRef={planHist}
          onHistoryState={setPlanCan}
          fitRef={planFit}
          keysRef={planKeys}
          focus={planFocus}
          onView={(c) => { planCenter.current = c }}
          trupps={trupps}
          onLinkTrupp={(annoId, truppId) => updateTrupp(truppId, { annoId, planId: activePlanId })}
          onShowTrupp={() => { setMode('atemschutz'); setPanel(null) }}
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

      {(SWIPE_SECTIONS as readonly string[]).includes(mode) && (
      <div className="section-pager" ref={sectionPagerRef}>
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
          canEdit={canEditIncident}
          personnel={personnel}
          attendance={effAttendance}
          createTrupp={createTruppA}
          placeTrupp={placeTrupp}
          placeTargets={placeTargets}
          focusTruppOnPlan={focusTruppOnPlan}
          recordContact={recordContact}
          recordPressure={recordPressure}
          setTruppStatus={setTruppStatus}
          editTrupp={editTruppA}
          reactivateTrupp={reactivateTruppA}
          deleteTrupp={deleteTrupp}
          restoreTrupp={restoreTrupp}
          muted={atemschutzMuted}
          onToggleMuted={toggleAtemschutzMuted}
          intervalMin={azIntervalMin}
          graceSec={azGraceSec}
          defaultFunkkanal={azFunkkanal}
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
          onMarkPresent={markPresent}
          onMarkLeft={markLeft}
          onClear={clearAttendance}
          onJumpToTrupp={() => { setMode('atemschutz'); setPanel(null) }}
          onReload={() => { void reloadPersonnel() }}
          onSetTimes={canEditIncident ? setAttendanceTimes : undefined}
          captureUsage={captureUsage}
        />
      )}

      {mode === 'mittel' && (
        <MittelView
          entries={effMittel}
          canEdit={canEditIncident}
          onSave={saveMittel}
          captureUsage={captureUsage}
        />
      )}
      </div>
      )}

      {/* time-travel replay scrubber — read-only past view, owns the playhead + fold */}
      {replayActive && (
        <ReplayBar
          incidentId={incidentMeta.id}
          startedAt={incidentMeta.started_at}
          onState={onReplayState}
          onVehicles={onReplayVehicles}
          onExit={exitReplay}
        />
      )}

      {reportPreflightOpen && (
        /* onEditDispatch leaves the preflight open so the Einsatzdaten wizard stacks on top
           (later in DOM, same z-index) — canceling it reveals the rapport again instead of a
           dead end. (Saving still remounts the workspace and returns to the map.) */
        <ReportPreflight
          incident={incidentMeta}
          reportMeta={reportMeta}
          personnel={personnel}
          presentIds={presentIds}
          events={timeline}
          annotatedPlanCount={annotatedPlanCount}
          truppCount={trupps.length}
          attendanceCount={Object.keys(attendance).length}
          mittelCount={mittelLineCount(mittel)}
          mittel={mittel}
          mapContentCount={entities.length + drawings.length}
          pendingMediaCount={media.pendingCount}
          attendance={attendance}
          trupps={trupps}
          plans={planDocs}
          scene={{ entities, drawings, layers: mapLayers, byName: sym.byName, center: incidentView.center, view: { center: view.center, zoom: view.zoom } }}
          board={board}
          building={effBuilding}
          captureUsage={captureUsage}
          onSaveMeta={setReportMeta}
          onEditDispatch={canEditIncident && !readOnly ? onEditMeta : undefined}
          onOpenAnwesenheit={() => { setReportPreflightOpen(false); setMode('anwesenheit'); setRapportReturn(true) }}
          onOpenMittel={() => { setReportPreflightOpen(false); setMode('mittel'); setRapportReturn(true) }}
          onComplete={canEditIncident && !readOnly ? () => { setReportPreflightOpen(false); onCompleteRapport() } : undefined}
          onClose={() => setReportPreflightOpen(false)}
          onFixTranscripts={() => { setReportPreflightOpen(false); setJournalOpen(true); setJournalFromRapport(true) }}
        />
      )}
      {/* unified Verlauf + quick-add — rendered app-level so both open over either surface,
          and AFTER the Rapport sheet so its checklist row can stack the Verlauf on top */}
      {journalOpen && (
        <Journal
          events={timeline}
          closedAt={incidentMeta.closed_at}
          plans={planDocs}
          onSelect={focusEvent}
          onClose={() => { setJournalOpen(false); if (journalFromRapport) { setJournalFromRapport(false); setReportPreflightOpen(true) } }}
          onTranscript={!readOnly ? (id, transcript) => journal.appendPatch(id, { transcript: transcript.trim() }) : undefined}
          onReplay={!replayActive ? () => { setJournalOpen(false); enterReplay() } : undefined}
          openReminders={reminders.open}
          onReminderDone={!readOnly ? reminders.markDone : undefined}
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
          onAddEntry={!readOnly ? addPlayerEntry : undefined}
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
          surface={mode === 'plans' ? 'plan' : 'map'}
          onSubmit={addJournal}
          onClose={() => setComposerOpen(false)}
          incidentStartAt={incidentMeta.started_at}
          uploadAudio={(blob, filename) => uploadMedia(incidentMeta.id, blob, 'audio', filename)}
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
      {settingsOpen && (
        <SettingsSheet
          onClose={() => setSettingsOpen(false)}
          symbolSize={symbolSize}
          onSymbolSize={setSymbolSize}
          symbolCaptions={symbolCaptions}
          onSymbolCaptions={setSymbolCaptions}
          offlineRadiusM={offlineRadiusM}
          onOfflineRadius={setOfflineRadiusM}
          keepScreenOn={keepScreenOn}
          onKeepScreenOn={setKeepScreenOn}
          themeCoord={incidentMeta.lng != null && incidentMeta.lat != null ? [incidentMeta.lng, incidentMeta.lat] : null}
          settings={incidentSettings}
          onSettings={setIncidentSettings}
          canEdit={canEditIncident}
          elView={elView}
          onElView={isEditor ? setElView : undefined}
        />
      )}

      {/* phone field-capture: a editor can't draw tactical symbols on a phone, but can
          always add a journal entry / photo / voice memo from the field — tap to compose,
          hold to record a voice memo (same gesture as the desktop TopBar Eintrag) */}
      {isPhone && !readOnly && !composerOpen && !panel && (
        <FabEntry
          recording={voice.recording}
          recStartedAt={voice.recStartedAt}
          onTap={() => setComposerOpen(true)}
          onHoldStart={startVoiceMemo}
          onHoldStop={voice.stop}
        />
      )}

    </div>
  )
}
