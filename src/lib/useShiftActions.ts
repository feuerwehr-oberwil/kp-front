import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import type { Person, Shift } from '../types'
import { SLOT_MS, draftShift, mergeOverlappingShifts } from './shifts'

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
  // Every write goes through here so a person's availability stays ONE set of times. Nobody is
  // available twice over the same minute, so an edit that would overlap folds into the block it
  // touches instead of stacking a second bar on it (and double-counting them in the Deckung).
  //
  // The merge is announced, never silent: a row that vanishes under the finger without a word is
  // worse than the overlap was. Undo restores the exact pre-merge list — the merge is lossy
  // (two blocks become one), so it must be reversible in a single tap.
  const commit = (next: (cur: Shift[]) => Shift[]) => {
    const before = shifts
    setShifts((cur) => mergeOverlappingShifts(next(cur)))
    // decided from the snapshot rather than inside the updater: a toast is a side effect and the
    // updater must stay pure (React invokes it twice in StrictMode)
    const merged = mergeOverlappingShifts(next(before))
    if (merged.length < next(before).length) {
      toast(appConfig.copy.zeitplan.mergedOverlap, {
        icon: 'undo',
        action: { label: appConfig.copy.undo, onClick: () => setShifts(before) },
      })
    }
  }

  const addShift = (p: Person) => {
    const hours = appConfig.shifts.defaultHours
    commit((cur) => [...cur, draftShift(p.id, Date.now(), startedAt, hours)])
  }
  /** The grid sweep — exactly the stretch drawn, snapped to the half hour, never shorter than one
   *  slot: a quick flick of the finger should still produce a usable 30-minute block rather than
   *  a zero-length shift that renders as nothing. */
  const addShiftSpan = (p: Person, from: number, to: number) => {
    const end = Math.max(to, from + SLOT_MS)
    commit((cur) => [...cur, {
      id: `sh${Date.now()}`, personId: p.id,
      from: new Date(from).toISOString(), to: new Date(end).toISOString(),
    }])
  }
  /** a drag committed: the whole shift replaces its stored self, so one gesture is one undo step */
  const replaceShift = (sh: Shift) => {
    commit((cur) => cur.map((x) => (x.id === sh.id ? sh : x)))
  }
  const setShiftTime = (id: string, patch: { from?: string; to?: string }) => {
    commit((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)))
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
  return { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift }
}
