import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import type { Person, Shift } from '../types'
import { SLOT_MS, draftShift } from './shifts'
import { newId } from './ids'

interface ShiftActionsDeps {
  setShifts: Dispatch<SetStateAction<Shift[]>>
  /** incident alarm time — a shift drafted before the incident starts anchors there, not to now */
  startedAt: string | null
}

/**
 * Schichtenplanung actions. Deliberately quiet compared to `useAttendanceActions`: attendance is a
 * RECORD, so every tick is a Verlauf event — a plan is not, and logging each nudge of a chip would
 * bury the operational journal under bookkeeping. What the plan produces that IS a record is the
 * attendance tick when a shift is actually carried out, and that logs itself.
 *
 * No toasts (owner pick 28, 17.11.2026): every write here goes through the Zeitplan slice, which
 * is ONE step on the Einsatz's ↶ timeline (workspace/useRecordSlices · zeitplanWrite) – a slipped
 * sweep, a double «Schicht erstellen», a drag or a delete is taken back by the header's ↶.
 */
export function useShiftActions({ setShifts, startedAt }: ShiftActionsDeps) {
  /** «Schicht erstellen» in the person's sheet: a planned shift from the next half hour (its
   *  button holds a ✓ meanwhile, TimeBlockSheet · addedLabel). */
  const addShift = (p: Person) => {
    const hours = appConfig.shifts.defaultHours
    const shift = draftShift(p.id, Date.now(), startedAt, hours)
    setShifts((cur) => [...cur, shift])
  }
  /** The grid sweep — exactly the stretch drawn, snapped to the half hour, never shorter than one
   *  slot: a quick flick of the finger should still produce a usable 30-minute block rather than
   *  a zero-length shift that renders as nothing. */
  const addShiftSpan = (p: Person, from: number, to: number) => {
    const end = Math.max(to, from + SLOT_MS)
    setShifts((cur) => [...cur, {
      id: newId('sh'), personId: p.id,
      from: new Date(from).toISOString(), to: new Date(end).toISOString(),
    }])
  }
  /** A drag committed (or the planned⇄fix toggle): the whole shift replaces its stored self, so
   *  one gesture is one undo step. */
  const replaceShift = (sh: Shift) => {
    setShifts((cur) => cur.map((x) => (x.id === sh.id ? sh : x)))
  }
  const setShiftTime = (id: string, patch: { from?: string; to?: string }) => {
    setShifts((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  const removeShift = (id: string) => {
    setShifts((cur) => cur.filter((s) => s.id !== id))
  }
  return { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift }
}
