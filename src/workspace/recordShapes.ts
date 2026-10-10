// The record shapes of the workspace's undoable slices (split out of IncidentWorkspace, E1
// 09.10.2026).

import type { ChecklistState } from '../lib/checklists'
import { REPORT_MACHINE_FIELDS } from '../lib/reportUndo'
import { fieldsOf, listById, recordByKey, type RecordShape } from '../lib/undoKeys'
import type { ReportMeta } from '../lib/workspace'
import type { AttendanceState, MittelEntry, Shift, ShiftBand } from '../types'

/** How each undoable slice is made of records (lib/undoKeys) — the merge's own unit for each, so a
 *  remote merge keeps every step that writes records it did not change. Module-level: a shape is
 *  a constant, and the slice hooks take it as a stable argument. */
export const ATTENDANCE_RECORDS = recordByKey<AttendanceState[string]>('attendance')
export const MITTEL_RECORDS = listById<MittelEntry>('mittel')
export const CHECKLIST_RECORDS = recordByKey<ChecklistState[string]>('checklists')
/** the app's own bookkeeping rides outside the Rapport's snapshots (lib/reportUndo), so it is no
 *  record of a step either */
export const REPORT_RECORDS = recordByKey<ReportMeta[keyof ReportMeta]>('reportMeta', REPORT_MACHINE_FIELDS) as unknown as RecordShape<ReportMeta>
export const ZEITPLAN_RECORDS = fieldsOf<{ shifts: Shift[]; bands: ShiftBand[] }>({ shifts: listById<Shift>('shifts'), bands: listById<ShiftBand>('bands') })
