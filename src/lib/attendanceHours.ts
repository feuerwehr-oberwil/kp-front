// Per-person Einsatzstunden derived from the attendance record. The rapport records the
// hours; billing itself stays in the external system (the colleague transfers by hand) —
// so this is presentation math, not accounting: the presence blocks per person with sensible
// defaults (Alarmierung → Einsatzende when a timestamp is missing) and a column total.

import type { AttendanceState, PresenceInterval } from '../types'
import { intervalsOf, totalMinutes } from './attendanceIntervals'

export interface HoursRow {
  personId: string
  name: string
  /** ISO — the FIRST arrival, else the alarm time fallback */
  from: string | null
  /** ISO — the LAST departure, else the Einsatzende fallback (null while neither exists) */
  to: string | null
  /** whole minutes actually served: the blocks summed, so time spent AWAY between two of them
   *  is not billed. Null when a block's end can't be resolved. */
  minutes: number | null
  /** every executed block, so a surface can show «14:00–18:00, 22:00–02:00» instead of a span */
  intervals: PresenceInterval[]
  /** this person really went home — their last block has a recorded end. False when `to` only
   *  holds the Einsatzende fallback, i.e. they were still there. A surface that flags early
   *  leavers must read THIS, not `to`, or it flags everybody. */
  leftEarly: boolean
}

/**
 * One row per person ever marked present (status 'left' keeps its row — presence is a
 * record, not a live flag). Defaults: missing arrival → alarmedAt; missing departure →
 * endedAt. Rows sort by name for a stable printable table.
 */
export function hoursRows(
  attendance: AttendanceState,
  opts: { alarmedAt: string | null; endedAt: string | null },
): HoursRow[] {
  return Object.entries(attendance)
    .map(([personId, e]) => {
      const intervals = intervalsOf(e)
      const last = intervals[intervals.length - 1]
      return {
        personId,
        name: e.displayNameSnapshot,
        from: intervals[0]?.from ?? opts.alarmedAt ?? null,
        to: last?.to ?? opts.endedAt ?? null,
        leftEarly: !!last?.to,
        minutes: totalMinutes(intervals, opts),
        intervals,
      }
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'de-CH'))
}
