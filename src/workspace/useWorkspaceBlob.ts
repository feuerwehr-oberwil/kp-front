// The workspace blob, both ways: the load gate's honest Meldungen (and, for a blob from a newer
// build, the reload into that build — swUpdate · requireNewerBuild), `applyWorkspace` (a merged or
// polled blob written into every synced slice, the undo timeline carried through the merge) and
// `buildPayload` (the slices back into the blob the sync saves) — plus this device's own Ebenen,
// which deliberately never ride the blob. Split out of IncidentWorkspace (E1, 09.10.2026)
// verbatim; useIncidentSync, which drives both, is still called by the workspace.

import { type Dispatch, type SetStateAction, type RefObject, useRef, useCallback, useEffect, useState } from 'react'
import { type BoardHistory, keepPlanSteps } from '../components/useBoardDoc'
import { appConfig } from '../config/appConfig'
import { prefs } from './bootPrefs'
import type { ChecklistState } from '../lib/checklists'
import { fillTemplate } from '../lib/format'
import type { IncidentPlanBinding } from '../lib/incidentPlanBindings'
import type { IncidentMeta, Workspace } from '../lib/incidents'
import { saveLayerPrefs } from '../lib/layerPrefs'
import { type TacticalObject, type PlanFit, viewsOf } from '../lib/tacticalObjects'
import type { TruppTrail } from '../lib/truppTrails'
import { toast } from '../lib/ui'
import { NEWER_BUILD_MELDUNG_ID } from '../lib/meldungen'
import { useMeldung } from '../lib/useMeldung'
import { carryUndoThroughMerge, workspaceChanges, planViewChanges } from '../lib/undoKeys'
import type { UndoTimeline } from '../lib/undoTimeline'
import type { useJournal } from '../lib/useJournal'
import { boardViewOf } from '../lib/useObjectStore'
import { onNewerBuildMissing, requireNewerBuild, updateForNewerData } from '../lib/swUpdate'
import type { VehicleOverrides } from '../lib/useVehicleLayer'
import { type WorkspaceGate, type PlanScales, type ReportMeta, type IncidentSettings, type Saved, type InitialState, gateReport, sanitizeWorkspace, deriveInitial, applyInitialState, WORKSPACE_SCHEMA_VERSION } from '../lib/workspace'
import type { LayerDef, BuildingDoc, Trupp, AttendanceState, MittelEntry, Shift, ShiftBand, CameraView, ReportAttachment, BoardDoc } from '../types'
import type { ReportSignature } from '../lib/reportSignature'

export interface UseWorkspaceBlobInputs {
  bootGate: WorkspaceGate
  /** the blob came from a NEWER build — the workspace's read-only state (workspace/access ·
   *  olderBuild), owned up there because the flags are derived before this hook runs */
  olderBuild: boolean
  setOlderBuild: Dispatch<SetStateAction<boolean>>
  incidentMeta: IncidentMeta
  setLayers: Dispatch<SetStateAction<LayerDef[]>>
  journal: ReturnType<typeof useJournal>
  setRecent: Dispatch<SetStateAction<string[]>>
  setBuilding: Dispatch<SetStateAction<BuildingDoc | null>>
  setVehicleOverrides: Dispatch<SetStateAction<VehicleOverrides>>
  setChecklists: Dispatch<SetStateAction<ChecklistState>>
  setTrupps: Dispatch<SetStateAction<Trupp[]>>
  setAttendance: Dispatch<SetStateAction<AttendanceState>>
  setMittel: Dispatch<SetStateAction<MittelEntry[]>>
  setShifts: Dispatch<SetStateAction<Shift[]>>
  setBands: Dispatch<SetStateAction<ShiftBand[]>>
  setCameraViews: Dispatch<SetStateAction<CameraView[]>>
  setTrails: Dispatch<SetStateAction<TruppTrail[]>>
  setPlanScale: Dispatch<SetStateAction<PlanScales>>
  setReportMeta: Dispatch<SetStateAction<ReportMeta>>
  setAttachments: Dispatch<SetStateAction<ReportAttachment[]>>
  setReportSignatures: Dispatch<SetStateAction<ReportSignature[]>>
  setIncidentSettings: Dispatch<SetStateAction<IncidentSettings>>
  setPlanBindings: Dispatch<SetStateAction<IncidentPlanBinding[]>>
  setPickedObjectId: Dispatch<SetStateAction<string | undefined>>
  setIntakeReviewedAt: Dispatch<SetStateAction<string | undefined>>
  undoHist: UndoTimeline
  liveWs: RefObject<Partial<Record<keyof Saved, unknown>>>
  liveObjects: () => TacticalObject[]
  boardRef: RefObject<BoardDoc>
  getFits: () => Map<string, PlanFit>
  rebaseObjects: (objects: TacticalObject[], keep: (step: string) => boolean) => void
  replaceObjects: (objects: TacticalObject[]) => void
  setPlanHistory: Dispatch<SetStateAction<BoardHistory>>
  lastReportStepRef: RefObject<{ key: string; at: number } | null>
  lastCaptionStepRef: RefObject<{ key: string; at: number; from: string | undefined; drop: () => void } | null>
  lastReorientRef: RefObject<{ at: number; from: BuildingDoc; drop: () => void } | null>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setSelectedDrawingId: Dispatch<SetStateAction<string | null>>
  setSelectedDrawIds: Dispatch<SetStateAction<string[]>>
  objects: TacticalObject[]
  recent: string[]
  activePlanId: string
  pickedObjectId: string | undefined
  building: BuildingDoc | null
  vehicleOverrides: VehicleOverrides
  checklists: ChecklistState
  allTrupps: Trupp[]
  attendance: AttendanceState
  mittel: MittelEntry[]
  shifts: Shift[]
  bands: ShiftBand[]
  cameraViews: CameraView[]
  trails: TruppTrail[]
  planScale: PlanScales
  reportMeta: ReportMeta
  attachments: ReportAttachment[]
  reportSignatures: ReportSignature[]
  incidentSettings: IncidentSettings
  planBindings: IncidentPlanBinding[]
  intakeReviewedAt: string | undefined
  layers: LayerDef[]
}

export function useWorkspaceBlob({
  bootGate, olderBuild, setOlderBuild, incidentMeta, setLayers, journal, setRecent, setBuilding, setVehicleOverrides,
  setChecklists, setTrupps, setAttendance, setMittel, setShifts, setBands, setCameraViews, setTrails,
  setPlanScale, setReportMeta, setAttachments, setReportSignatures, setIncidentSettings, setPlanBindings, setPickedObjectId,
  setIntakeReviewedAt, undoHist, liveWs, liveObjects, boardRef, getFits, rebaseObjects, replaceObjects,
  setPlanHistory, lastReportStepRef, lastCaptionStepRef, lastReorientRef, setSelectedId, setSelectedDrawingId,
  setSelectedDrawIds, objects, recent, activePlanId, pickedObjectId, building, vehicleOverrides,
  checklists, allTrupps, attendance, mittel, shifts, bands, cameraViews, trails, planScale, reportMeta,
  attachments, reportSignatures, incidentSettings, planBindings, intakeReviewedAt, layers,
}: UseWorkspaceBlobInputs) {
  // Honest reporting for the workspace load gate — as Meldungen that stand WHILE TRUE (S3,
  // 20.10.2026). They were ~5 s toasts, once per mount: an operator who looked up six seconds
  // later never learned that this build is older than the data, or that entries were skipped.
  // The gate is re-read on every poll (applyWorkspace). «skipped» can be waved away (nobody on
  // site can repair the blob), and comes back only if the count changes. Same state written
  // again is no re-render.
  // A blob from a NEWER build (sweep 30.10.2026 #19, the owner's first open of an Atemschutz-
  // Link on an old cached build): the workspace goes read-only and this build fetches the newer
  // one and reloads into it by itself (swUpdate · requireNewerBuild). Only when none can be had
  // (offline, nothing deployed) does ONE row stand, with «Aktualisieren»; what the old build
  // skipped is not reported as damage (lib/workspace · gateReport).
  const [skipped, setSkipped] = useState(() => gateReport(bootGate).skipped)
  const [skippedSeen, setSkippedSeen] = useState(0)
  const reportGate = useCallback((g: WorkspaceGate) => {
    const r = gateReport(g)
    setOlderBuild(r.newer)
    setSkipped(r.skipped)
  }, [setOlderBuild])
  const [buildMissing, setBuildMissing] = useState(false)
  useEffect(() => {
    if (!olderBuild) return
    requireNewerBuild()
    return onNewerBuildMissing(setBuildMissing)
  }, [olderBuild])
  const C = appConfig.copy.offline
  useMeldung(!olderBuild || !buildMissing ? null : {
    id: NEWER_BUILD_MELDUNG_ID, kind: 'workspace', tone: 'warn', icon: 'warn', title: C.wsNewer, sub: C.wsNewerSub, wrap: true,
    actions: [{ label: C.wsNewerAction, primary: true, onClick: updateForNewerData }],
  })
  useMeldung(skipped === 0 || skipped === skippedSeen ? null : {
    id: 'workspace:dropped', kind: 'workspace', tone: 'warn', icon: 'warn', wrap: true,
    title: fillTemplate(C.wsDropped, { n: skipped }),
    dismiss: { label: C.wsDroppedDismiss, onClick: () => setSkippedSeen(skipped) },
  })

  // Write an authoritative workspace (conflict take-server or live-follow poll) into App's
  // state slices. useIncidentSync wraps this with its skip-save guard and drives it from the
  // poll/auto-merge paths; the state lives here, so the writer does too.
  // …reached through a ref because the Anwesenheit's history is created much further down (it
  // needs the roster and the attendance actions), while this merge path has to exist up here.
  // Same shape as `planHist` below.
  const sliceRebase = useRef<((next: InitialState, keep: ((step: string) => boolean) | null) => void) | null>(null)
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
  const applyWorkspace = useCallback((ws: Workspace) => {
    const gate = sanitizeWorkspace(ws)
    reportGate(gate)
    syncedLayerState.current = gate.ws?.layerState ?? []
    const next = deriveInitial(gate.ws, incidentMeta.id, prefs, incidentMeta.type)
    // every synced slice takes the merged value (the objects come in with their history below)
    // ⚠️ One setter per slice, typed (lib/workspace · WorkspaceAppliers): a synced slice without
    // a line here fails tsc. This was a hand-kept list until 25.09.2026, and it had lost `mittel`.
    applyInitialState(next, {
      // the store swaps in below, WITH its history (carryUndoThroughMerge: `rebaseObjects`, or
      // `replaceObjects` when the bookkeeping fails) — a replace here would drop every Karte step
      objects: () => {},
      layers: setLayers, timeline: journal.ingestLegacy,
      recent: setRecent, building: setBuilding,
      vehicleOverrides: setVehicleOverrides, checklists: setChecklists, trupps: setTrupps, attendance: setAttendance, mittel: setMittel, shifts: setShifts, bands: setBands, cameraViews: setCameraViews, trails: setTrails, planScale: setPlanScale, reportMeta: setReportMeta, attachments: setAttachments, reportSignatures: setReportSignatures, settings: setIncidentSettings, planBindings: setPlanBindings, pickedObjectId: setPickedObjectId, intakeReviewedAt: setIntakeReviewedAt,
    })
    /* ⚠️ WHAT THE MERGE CHANGED, record by record — and the undo timeline keeps everything else
     * (25.09.2026, reversing 08.09.: this path used to drop the whole timeline, and with three
     * devices on an Einsatz that greyed ↶ out within seconds of any save anywhere).
     * `changed` is every record whose value differs between the live state and the one being
     * written (lib/undoKeys · workspaceChanges — the objects read LIVE, the slices as rendered),
     * plus every plan sheet whose drawn view that moves (derived only when an object changed).
     * The timeline drops each entry whose inverse touches one of them (and the older ones behind
     * a dropped one that touch what it touched); each domain then keeps exactly the steps whose
     * entries survived, re-laid onto the merged state: the store per object, the slices per
     * record, a plan's stack whole (useBoardDoc · planStackTouches); still-standing undo toasts
     * are spent where their records moved. An echo changes nothing and drops nothing.
     * ⚠️ All or nothing (undoKeys · carryUndoThroughMerge): if any of it throws, the old rule
     * applies — the whole timeline and every history go — and the merged state still lands. */
    carryUndoThroughMerge(undoHist, () => {
      const changed = workspaceChanges({ ...liveWs.current, objects: liveObjects() }, next)
      for (const k of planViewChanges(boardRef.current, () => boardViewOf(next.objects, getFits()), changed)) changed.add(k)
      return changed
    }, [
      // the whole store swaps in — the Karte AND every sheet, they are one collection now
      { rebase: (keep) => rebaseObjects(next.objects, keep), drop: () => replaceObjects(next.objects) },
      // Anwesenheit, Mittel, Checklisten, Rapport, Zeitplan
      { rebase: (keep) => sliceRebase.current?.(next, keep), drop: () => sliceRebase.current?.(next, null) },
      // `keep` is a set captured by the merge — never re-read inside the lazy updater
      { rebase: (keep) => setPlanHistory((h) => keepPlanSteps(h, keep)), drop: () => setPlanHistory({}) },
    ], {
      onFail: (e) => console.error('undo bookkeeping failed on merge — history dropped', e),
      // F8: ↶ must never quietly turn into an older act on another surface — say it once
      onTopDropped: (e) => toast(fillTemplate(appConfig.copy.undoTopDropped, { what: appConfig.copy.undoDroppedWhat[e.domain] }), { icon: 'warn' }),
    })
    // …and the ghost-trail reconciliation re-seeds instead of running: the store was REPLACED, so
    // every marker on it would read as «vanished» and the merge would ghost the whole picture.
    // Through a ref, because the hook that owns it is declared further down this component.
    ghostReseedRef.current?.()
    // …and every OPEN fold window with them — the Rapport's typing burst, the Bildlegende, the
    // Gebäude-Drehung (the plan sheet-step token is re-opened by the store itself when its step
    // went, useObjectStore · rebaseObjects). A burst still collecting points at a state the merge has replaced:
    // folding the next write into it would write a pre-merge value back, and — worse — lay no
    // step of its own, so the edit that followed a merge would be the one thing with no way back.
    lastReportStepRef.current = null; lastCaptionStepRef.current = null; lastReorientRef.current = null
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
    /* ⚠️ A LEGACY `photo` entity never rides the blob: its `photoUrl` is a session `blob:` URL
     * that means nothing on another device or after a reload. It is kept on screen for as long
     * as the incident is open and dropped HERE — at the wire, from the store and from its views
     * together, so the two cannot disagree about what was saved. A photo marker placed from a
     * Verlauf picture (F16) names that picture by row + index (`photoOf`, lib/photoGeo), which
     * every device can resolve, and is part of the record like any placed object. */
    const persisted = objects.filter((o) => o.entity?.kind !== 'photo' || !!o.entity.photoOf)
    const views = viewsOf(persisted)
    return {
    objects: persisted,
    entities: views.entities,
    drawings: views.drawings, recent, board: views.board, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, trupps: allTrupps, attendance, mittel, shifts, bands, cameraViews, trails, planScale, reportMeta, attachments, reportSignatures, settings: incidentSettings, planBindings, intakeReviewedAt,
    // ⚠️ NOT `layers` — the Ebenen this device is looking at stay on this device (see
    // syncedLayerState above and lib/layerPrefs). The record's own value goes back unchanged.
    layerState: syncedLayerState.current,
    // Verlauf rows live in the journal store now; the blob echoes an older incident's legacy
    // rows only until they're safely on the server, then ships empty forever (see JournalStore).
    timeline: journal.blobTimeline,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
  }
  }, [objects, journal.blobTimeline, recent, activePlanId, pickedObjectId, building, vehicleOverrides, checklists, allTrupps, attendance, mittel, shifts, bands, cameraViews, trails, planScale, reportMeta, attachments, reportSignatures, incidentSettings, planBindings, intakeReviewedAt])

  // …and they are remembered here instead, per incident, on this device only. Written on every
  // change (not just on a deliberate toggle) so the set derived at boot — including the
  // category pre-activation — is what this device comes back to.
  useEffect(() => {
    saveLayerPrefs(incidentMeta.id, layers.map((l) => ({ id: l.id, visible: l.visible, opacity: l.opacity })))
  }, [layers, incidentMeta.id])
  return { buildPayload, applyWorkspace, ghostReseedRef, sliceRebase }
}
