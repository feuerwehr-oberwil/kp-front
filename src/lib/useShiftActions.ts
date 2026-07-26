import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import type { Person, Shift } from '../types'
import { draftShift } from './shifts'

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
 * Deleting is the one destructive step, so it gets the house confirm-with-undo toast.
 */
export function useShiftActions({ shifts, setShifts, startedAt }: ShiftActionsDeps) {
  const addShift = (p: Person) => {
    const hours = appConfig.shifts.defaultHours
    setShifts((cur) => [...cur, draftShift(p.id, Date.now(), startedAt, hours)])
  }
  const setShiftTime = (id: string, patch: { from?: string; to?: string }) => {
    setShifts((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  const removeShift = (id: string, personName: string) => {
    const prev = shifts.find((s) => s.id === id)
    if (!prev) return
    setShifts((cur) => cur.filter((s) => s.id !== id))
    toast(fillTemplate(appConfig.copy.zeitplan.removed, { name: personName }), {
      icon: 'undo',
      action: { label: appConfig.copy.undo, onClick: () => setShifts((cur) => (cur.some((s) => s.id === id) ? cur : [...cur, prev])) },
    })
  }
  return { addShift, setShiftTime, removeShift }
}
