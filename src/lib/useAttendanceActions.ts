import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import type { AttendanceState, Person, TimelineEvent } from '../types'

interface AttendanceActionsDeps {
  attendance: AttendanceState
  setAttendance: Dispatch<SetStateAction<AttendanceState>>
  /** person ids locked into an active Trupp — they can't be marked «gegangen». */
  blockedAttendanceIds: Set<string>
  /** incident alarm time (incidentMeta.started_at) — the default «von» for a fresh tick. */
  startedAt: string
  /** Abschluss bookmark (incidentMeta.report_done_at) — a post-completion time correction
   *  additionally self-documents in the Verlauf. */
  reportDoneAt: string | null
  log: (icon: string, text: string, kind?: TimelineEvent['kind']) => void
}

/**
 * Anwesenheit (attendance) domain actions, lifted out of the IncidentWorkspace god-component.
 * Presence is a record: every tick/removal/correction is a Verlauf event, and «frei» is
 * confirm-with-undo. Pure orchestration over the synced attendance slice — no state of its own.
 */
export function useAttendanceActions({ attendance, setAttendance, blockedAttendanceIds, startedAt, reportDoneAt, log }: AttendanceActionsDeps) {
  const markPresent = (p: Person) => {
    if (attendance[p.id]?.status === 'present') return
    // «von» defaults to the alarm time (Vorschlag ab Alarmzeit) — ticking often happens
    // long after arrival, and now() would print an end-of-incident «von» on the rapport
    setAttendance((cur) => ({ ...cur, [p.id]: { status: 'present', checkedInAt: cur[p.id]?.checkedInAt ?? startedAt, leftAt: cur[p.id]?.leftAt, displayNameSnapshot: p.displayName } }))
    log('people', `${p.displayName} anwesend`, 'team')
  }
  const markLeft = (p: Person) => {
    if (blockedAttendanceIds.has(p.id) || attendance[p.id]?.status === 'left') return
    setAttendance((cur) => ({ ...cur, [p.id]: { status: 'left', checkedInAt: cur[p.id]?.checkedInAt, leftAt: new Date().toISOString(), displayNameSnapshot: p.displayName } }))
    log('people', `${p.displayName} gegangen`, 'team')
  }
  const clearAttendance = (p: Person) => {
    const prev = attendance[p.id]
    if (!prev) return
    setAttendance((cur) => { const next = { ...cur }; delete next[p.id]; return next })
    // presence is a record — removing an entry is itself an event worth the Verlauf
    log('people', fillTemplate(appConfig.copy.abschluss.attendanceRemoved, { name: p.displayName }), 'team')
    // confirm-with-undo: a mis-cycle to «frei» silently drops a corrected von/checkedInAt with
    // no way back — restore the exact prior entry (status + times) on undo.
    toast(fillTemplate(appConfig.copy.abschluss.attendanceRemoved, { name: p.displayName }), {
      icon: 'undo',
      action: { label: appConfig.copy.undo, onClick: () => setAttendance((cur) => ({ ...cur, [p.id]: prev })) },
    })
  }
  // Stunden editor (Abschluss-Assistent): correct a person's von–bis. After the Rapport was
  // declared complete, a correction additionally self-documents in the Verlauf (Nachtrag).
  const setAttendanceTimes = (personId: string, patch: { checkedInAt?: string; leftAt?: string }) => {
    const e = attendance[personId]
    if (!e) return
    setAttendance((cur) => (cur[personId] ? { ...cur, [personId]: { ...cur[personId], ...patch } } : cur))
    if (reportDoneAt) {
      log('people', fillTemplate(appConfig.copy.abschluss.corrected, { name: e.displayNameSnapshot }), 'team')
    }
  }
  return { markPresent, markLeft, clearAttendance, setAttendanceTimes }
}
