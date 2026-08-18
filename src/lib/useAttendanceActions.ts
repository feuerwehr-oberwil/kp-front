import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import type { AttendanceState, Person, TimelineEvent } from '../types'
import { closePresence, currentIntervalIndex, intervalsOf, isPresent, openPresence, setIntervalTime, withIntervals } from './attendanceIntervals'
import { ortOf, otherOrt } from './attendanceOrt'

/** Monotonic suffix for guest ids. `Date.now()` alone collides: two people walking in together
 *  are entered in the same millisecond, and the second entry then OVERWRITES the first — one of
 *  them silently missing from the Anwesenheit and from the Rapport. Module-level so it survives
 *  a remount mid-incident. */
let guestSeq = 0

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
  /** What each person's Bemerkung said, for as long as this incident is open on this device.
   *
   * ⚠️ «frei» DELETES the attendance entry, note and all — that is what «nothing recorded» means,
   * and keeping an empty entry instead would print somebody on the Personalblatt as present for
   * the whole Einsatz (report · personalForPdf fills missing blocks from the incident bounds). But
   * the Bemerkung is not a presence: «Fahrer TLF», «verletzt, abgelöst 21:40» is what this person
   * DID here, and cycling a row past «frei» by accident threw it away with no way back. So it is
   * remembered beside the record and written back when the same person is ticked present again.
   * A ref, not state: nothing re-renders on it, and it must not travel to other devices — the
   * note that IS recorded is on the entry, where it always was. */
  noteMemory: { current: Record<string, string> }
  log: (icon: string, text: string, kind?: TimelineEvent['kind']) => void
}

/**
 * Anwesenheit (attendance) domain actions, lifted out of the IncidentWorkspace god-component.
 * Presence is a record: every tick/removal/correction is a Verlauf event, and «frei» is
 * confirm-with-undo. Pure orchestration over the synced attendance slice — no state of its own.
 */
export function useAttendanceActions({ attendance, setAttendance, blockedAttendanceIds, startedAt, reportDoneAt, noteMemory, log }: AttendanceActionsDeps) {
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
    // …and whatever this person's Bemerkung said before the row was cycled to «frei» comes back
    // with them. Only when the entry itself has none — a note still on the record always wins.
    const remembered = noteMemory.current[p.id]
    setAttendance((cur) => {
      const next = openPresence(cur[p.id], at, p.displayName)
      return { ...cur, [p.id]: remembered && !next.note ? { ...next, note: remembered } : next }
    })
    log('people', fillTemplate(returning ? appConfig.copy.anwesenheit.logPresentAgain : appConfig.copy.anwesenheit.logPresent, { name: p.displayName }), 'team')
  }
  const markLeft = (p: Person) => {
    if (blockedAttendanceIds.has(p.id) || !isPresent(attendance[p.id])) return
    setAttendance((cur) => (cur[p.id] ? { ...cur, [p.id]: closePresence(cur[p.id], new Date().toISOString(), p.displayName) } : cur))
    log('people', fillTemplate(appConfig.copy.anwesenheit.logLeft, { name: p.displayName }), 'team')
  }
  const clearAttendance = (p: Person) => {
    const prev = attendance[p.id]
    if (!prev) return
    if (prev.note?.trim()) noteMemory.current[p.id] = prev.note.trim()
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
    // removing the LAST block deletes the entry, exactly like «frei» — so the Bemerkung is kept
    // the same way it is there (see noteMemory)
    if (!rest.length && prev.note?.trim()) noteMemory.current[personId] = prev.note.trim()
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
  /** Write (or clear) the free remark on a person's attendance row. Not a presence change, so
   *  it touches no interval and writes no «anwesend/gegangen» Verlauf line — but it IS part of
   *  the record, so it is logged once as its own row. */
  const setAttendanceNote = (personId: string, note: string) => {
    const e = attendance[personId]
    if (!e) return
    const next = note.trim() || undefined
    if ((e.note ?? undefined) === next) return
    setAttendance((cur) => (cur[personId] ? { ...cur, [personId]: { ...cur[personId], note: next, noteAt: new Date().toISOString() } } : cur))
    // remember it too, so a row cycled to «frei» and back keeps what was written about this person
    if (next) noteMemory.current[personId] = next
    else delete noteMemory.current[personId]
    log('people', fillTemplate(appConfig.copy.anwesenheit.logNote, { name: e.displayNameSnapshot, note: next ?? '–' }), 'team')
  }

  /**
   * At the Einsatzort or still in the Magazin — the answer to «wen könnte ich noch nachziehen».
   *
   * A toggle, so it takes no argument: there are two states and the tap means «the other one».
   * Written only for somebody who is actually present; on anybody else the control is not
   * offered, because «wo ist jemand, der gegangen ist» has no answer worth storing.
   */
  const setAttendanceOrt = (p: Person) => {
    const e = attendance[p.id]
    if (!e || !isPresent(e)) return
    const next = otherOrt(ortOf(e))
    setAttendance((cur) => (cur[p.id] ? { ...cur, [p.id]: { ...cur[p.id], ort: next } } : cur))
    // The Verlauf is where the HISTORY of this lives — the entry itself only ever holds the
    // current state, so «wann kam die zweite Gruppe nach» is answerable here and nowhere else.
    const A = appConfig.copy.anwesenheit
    log('people', fillTemplate(next === 'station' ? A.logOrtStation : A.logOrtScene, { name: p.displayName }), 'team')
  }

  /**
   * Somebody is on scene who is not on the Mannschaftsliste — a guest, mutual aid, an AdF whose
   * roster entry never synced. The record has always been able to HOLD them (the Rapport prints
   * attendance entries with no roster row as guest lines); there was simply no way to create one
   * without an admin adding a Personnel row mid-incident.
   *
   * Deliberately NOT a roster entry: this person was here tonight, which is a statement about
   * this Einsatz and not about the Wehr's membership. Same shape as «Anderes Mittel».
   *
   * `note` is the job the name was typed into — «Fahrer TLF», «Einsatzleiter». It is written
   * HERE rather than by a following role assignment, because the row does not exist yet: the
   * caller cannot mark somebody present who is only about to be created, and the Verlauf line it
   * would write knows the id but not the name. One act, one row, one line.
   */
  const addGuest = (name: string, note?: string): string | undefined => {
    const display = name.trim()
    if (!display) return undefined
    guestSeq += 1
    const id = `g${Date.now().toString(36)}-${guestSeq}`
    const job = note?.trim()
    setAttendance((cur) => ({
      ...cur,
      [id]: { ...openPresence(undefined, startedAt, display), ...(job ? { note: job } : {}) },
    }))
    const A = appConfig.copy.anwesenheit
    log('people', job
      ? fillTemplate(A.logGuestAddedAs, { name: display, role: job })
      : fillTemplate(A.logGuestAdded, { name: display }), 'team')
    return id
  }

  return { markPresent, markLeft, clearAttendance, setAttendanceTimes, removeAttendanceBlock, setAttendanceNote, setAttendanceOrt, addGuest }
}
