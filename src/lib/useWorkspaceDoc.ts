import { useState } from 'react'
import type { InitialState } from './workspace'

/** The per-incident SYNCED workspace slices — the operational data that rides the workspace
 *  blob (offline cache + three-way merge sync): the synced per-incident settings (Atemschutz
 *  interval …), the plan board, checklist tick-state, Atemschutz trupps, attendance, Mittel
 *  (material-use log), saved camera views, per-plan scale calibration, Einsatzrapport metadata,
 *  the Gebäude document, the active plan id, and the manually-picked Einsatzobjekt.
 *
 *  Seeded once from deriveInitial() (the component is keyed by incident id, so this runs
 *  exactly once per incident). This hook owns the STATE only — buildPayload / applyWorkspace
 *  (the sync contract) and the trupps auto-free effects stay in the workspace component and
 *  read these values through the returned setters, unchanged. `layers` and `recent` are NOT
 *  here: they carry their own derivation/effects and stay in the component. */
export function useWorkspaceDoc(init: InitialState) {
  const [incidentSettings, setIncidentSettings] = useState(init.settings)
  const [board, setBoard] = useState(init.board)
  const [checklists, setChecklists] = useState(init.checklists)
  const [trupps, setTrupps] = useState(init.trupps)
  const [attendance, setAttendance] = useState(init.attendance)
  const [mittel, setMittel] = useState(init.mittel)
  const [cameraViews, setCameraViews] = useState(init.cameraViews)
  const [planScale, setPlanScale] = useState(init.planScale)
  const [reportMeta, setReportMeta] = useState(init.reportMeta)
  const [building, setBuilding] = useState(init.building)
  const [activePlanId, setActivePlanId] = useState(init.activePlanId)
  const [pickedObjectId, setPickedObjectId] = useState(init.pickedObjectId)
  return {
    incidentSettings, setIncidentSettings,
    board, setBoard,
    checklists, setChecklists,
    trupps, setTrupps,
    attendance, setAttendance,
    mittel, setMittel,
    cameraViews, setCameraViews,
    planScale, setPlanScale,
    reportMeta, setReportMeta,
    building, setBuilding,
    activePlanId, setActivePlanId,
    pickedObjectId, setPickedObjectId,
  }
}
