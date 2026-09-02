import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { undoToast } from './ui'
import type { Person, Shift } from '../types'
import { SLOT_MS, draftShift } from './shifts'
import { newId } from './ids'

interface ShiftActionsDeps {
  shifts: Shift[]
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
 * What DOES get the house confirm-with-undo toast: every step that a slip of the finger can
 * trigger on its own — deleting, the sweep that plans a stretch, and a drag that moves or
 * stretches a bar. Deleting had one and the other two did not, which is backwards: a sweep is
 * the easiest of the three to do by accident (a horizontal drag anywhere on an empty lane), and
 * it was the only one with no way back except finding the new bar and deleting it.
 * The planned⇄fix toggle stays quiet on purpose — a second tap undoes it.
 */
export function useShiftActions({ shifts, setShifts, startedAt }: ShiftActionsDeps) {
  const addShift = (p: Person) => {
    const hours = appConfig.shifts.defaultHours
    setShifts((cur) => [...cur, draftShift(p.id, Date.now(), startedAt, hours)])
  }
  /** The grid sweep — exactly the stretch drawn, snapped to the half hour, never shorter than one
   *  slot: a quick flick of the finger should still produce a usable 30-minute block rather than
   *  a zero-length shift that renders as nothing. */
  const addShiftSpan = (p: Person, from: number, to: number) => {
    const end = Math.max(to, from + SLOT_MS)
    const id = newId('sh')
    setShifts((cur) => [...cur, {
      id, personId: p.id,
      from: new Date(from).toISOString(), to: new Date(end).toISOString(),
    }])
    undoToast(fillTemplate(appConfig.copy.zeitplan.added, { name: p.displayName }), () => setShifts((cur) => cur.filter((s) => s.id !== id)))
  }
  /**
   * A drag committed: the whole shift replaces its stored self, so one gesture is one undo step.
   *
   * `undoName` is the offer of a toast, not a label lookup — it is passed only from the drag
   * commit, never from the planned⇄fix toggle, which shares this same handler and would otherwise
   * pop a toast on every tap of a bar.
   */
  const replaceShift = (sh: Shift, undoName?: string) => {
    const prev = shifts.find((s) => s.id === sh.id)
    setShifts((cur) => cur.map((x) => (x.id === sh.id ? sh : x)))
    if (!undoName || !prev) return
    undoToast(fillTemplate(appConfig.copy.zeitplan.moved, { name: undoName }), () => setShifts((cur) => cur.map((s) => (s.id === prev.id ? prev : s))))
  }
  const setShiftTime = (id: string, patch: { from?: string; to?: string }) => {
    setShifts((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  const removeShift = (id: string, personName: string) => {
    const prev = shifts.find((s) => s.id === id)
    if (!prev) return
    setShifts((cur) => cur.filter((s) => s.id !== id))
    undoToast(fillTemplate(appConfig.copy.zeitplan.removed, { name: personName }), () => setShifts((cur) => (cur.some((s) => s.id === id) ? cur : [...cur, prev])))
  }
  return { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift }
}
