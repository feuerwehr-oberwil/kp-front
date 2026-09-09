import { useState } from 'react'
import type { InitialState } from './workspace'

/** The per-incident SYNCED workspace slices — the operational data that rides the workspace
 *  blob (offline cache + three-way merge sync): the synced per-incident settings (Atemschutz
 *  interval …), checklist tick-state, Atemschutz trupps, attendance, Mittel
 *  (material-use log), the Schichtenplanung and its bands, saved camera views, per-plan scale calibration, Einsatzrapport metadata,
 *  the Gebäude document, the active plan id, the manually-picked Einsatzobjekt, and the shared
 *  «Einsatzdaten geprüft» stamp.
 *
 *  Seeded once from deriveInitial() (the component is keyed by incident id, so this runs
 *  exactly once per incident). This hook owns the STATE only — buildPayload / applyWorkspace
 *  (the sync contract) and the trupps auto-free effects stay in the workspace component and
 *  read these values through the returned setters, unchanged. `layers` and `recent` are NOT
 *  here: they carry their own derivation/effects and stay in the component. Neither is the
 *  plan `board`: it is a VIEW of the tactical store now, and its setter an adapter over the
 *  same collection the Karte writes (lib/useObjectStore). */
export function useWorkspaceDoc(init: InitialState) {
  const [incidentSettings, setIncidentSettings] = useState(init.settings)
  const [checklists, setChecklists] = useState(init.checklists)
  const [trupps, setTrupps] = useState(init.trupps)
  const [attendance, setAttendance] = useState(init.attendance)
  const [mittel, setMittel] = useState(init.mittel)
  const [shifts, setShifts] = useState(init.shifts)
  const [bands, setBands] = useState(init.bands)
  const [cameraViews, setCameraViews] = useState(init.cameraViews)
  const [planScale, setPlanScale] = useState(init.planScale)
  const [reportMeta, setReportMeta] = useState(init.reportMeta)
  const [attachments, setAttachments] = useState(init.attachments)
  const [building, setBuilding] = useState(init.building)
  const [activePlanId, setActivePlanId] = useState(init.activePlanId)
  const [pickedObjectId, setPickedObjectId] = useState(init.pickedObjectId)
  const [intakeReviewedAt, setIntakeReviewedAt] = useState(init.intakeReviewedAt)
  return {
    incidentSettings, setIncidentSettings,
    checklists, setChecklists,
    trupps, setTrupps,
    attendance, setAttendance,
    mittel, setMittel,
    shifts, setShifts,
    bands, setBands,
    cameraViews, setCameraViews,
    planScale, setPlanScale,
    reportMeta, setReportMeta,
    attachments, setAttachments,
    building, setBuilding,
    activePlanId, setActivePlanId,
    pickedObjectId, setPickedObjectId,
    intakeReviewedAt, setIntakeReviewedAt,
  }
}
