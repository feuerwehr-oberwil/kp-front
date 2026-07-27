import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import type { AttendanceState, Person, TimelineEvent } from '../types'
import { closePresence, currentIntervalIndex, intervalsOf, isPresent, openPresence, setIntervalTime, withIntervals } from './attendanceIntervals'

/** A freshly opened block cannot be split again this soon — that is a double tap, not a relief. */
const MIN_BLOCK_MS = 60_000

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
    // Adding a block while one is still running is a relief in place: close the current one at
    // this moment and open the next. Without this the sheet's «Weiterer Block» would leave two
    // open blocks, and `isPresent` reads only the last — the earlier one would never close.
    if (isPresent(attendance[p.id])) {
      const prev = attendance[p.id]
      const open = intervalsOf(prev).slice(-1)[0]
      // A second impatient tap would otherwise split the block again a fraction of a second later
      // and leave a zero-length row — the very fragmentation `openPresence` guards against, which
      // this branch bypasses by closing first.
      if (open?.from && Date.now() - Date.parse(open.from) < MIN_BLOCK_MS) return
      const now = new Date().toISOString()
      setAttendance((cur) => (cur[p.id] ? { ...cur, [p.id]: openPresence(closePresence(cur[p.id], now, p.displayName), now, p.displayName) } : cur))
      log('people', fillTemplate(appConfig.copy.anwesenheit.blockSplit, { name: p.displayName }), 'team')
      // splitting a running block is destructive in the sense that matters here — the earlier
      // block gets an end it never had — so it takes the house confirm-with-undo toast
      toast(fillTemplate(appConfig.copy.anwesenheit.blockSplit, { name: p.displayName }), {
        icon: 'undo',
        action: { label: appConfig.copy.undo, onClick: () => setAttendance((cur) => ({ ...cur, [p.id]: prev })) },
      })
      return
    }
    // First tick: «von» defaults to the alarm time (Vorschlag ab Alarmzeit) — ticking often
    // happens long after arrival, and now() would print an end-of-incident «von» on the rapport.
    // A RETURN opens a fresh block at the real clock instead; the alarm time would be nonsense
    // there, and the earlier block keeps its own von–bis untouched.
    const returning = intervalsOf(attendance[p.id]).length > 0
    const at = returning ? new Date().toISOString() : startedAt
    setAttendance((cur) => ({ ...cur, [p.id]: openPresence(cur[p.id], at, p.displayName) }))
    log('people', `${p.displayName} ${returning ? 'wieder anwesend' : 'anwesend'}`, 'team')
  }
  const markLeft = (p: Person) => {
    if (blockedAttendanceIds.has(p.id) || !isPresent(attendance[p.id])) return
    setAttendance((cur) => (cur[p.id] ? { ...cur, [p.id]: closePresence(cur[p.id], new Date().toISOString(), p.displayName) } : cur))
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
  // Stunden editor (Abschluss-Assistent): correct ONE block's von–bis (`index` defaults to the
  // block the surface is showing). After the Rapport was declared complete, a correction
  // additionally self-documents in the Verlauf (Nachtrag).
  const setAttendanceTimes = (personId: string, patch: { from?: string; to?: string }, index?: number) => {
    const e = attendance[personId]
    if (!e) return
    const i = index ?? currentIntervalIndex(e)
    setAttendance((cur) => (cur[personId] ? { ...cur, [personId]: setIntervalTime(cur[personId], i, patch) } : cur))
    if (reportDoneAt) {
      log('people', fillTemplate(appConfig.copy.abschluss.corrected, { name: e.displayNameSnapshot }), 'team')
    }
  }
  /** Remove ONE recorded block. Removing the last one leaves the person with nothing recorded,
   *  which is «frei» — so the whole entry goes, exactly as the row's third tap would do it. Undo
   *  restores the entry verbatim either way. */
  const removeAttendanceBlock = (personId: string, index: number) => {
    const prev = attendance[personId]
    const list = intervalsOf(prev)
    if (!prev || index < 0 || index >= list.length) return
    const rest = list.filter((_, i) => i !== index)
    setAttendance((cur) => {
      if (!cur[personId]) return cur
      if (!rest.length) { const next = { ...cur }; delete next[personId]; return next }
      return { ...cur, [personId]: withIntervals(cur[personId], rest) }
    })
    toast(fillTemplate(appConfig.copy.anwesenheit.blockRemoved, { name: prev.displayNameSnapshot }), {
      icon: 'undo',
      action: { label: appConfig.copy.undo, onClick: () => setAttendance((cur) => ({ ...cur, [personId]: prev })) },
    })
  }
  return { markPresent, markLeft, clearAttendance, setAttendanceTimes, removeAttendanceBlock }
}
