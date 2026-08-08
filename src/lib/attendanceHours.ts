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

/** Default rounding rule when the deployment configures none — see `docs/CONFIGURATION.md` §1b.
 *  The rule is NOT printed on the rapport: it is the same on every sheet a station produces, so
 *  it belongs in the Weisung. The raw figure prints beside the rounded one, which is what makes
 *  the rounded one checkable. */
export const DEFAULT_HOURS_ROUNDING = { stepMin: 30, graceMin: 5 }

/**
 * One person's minutes rounded the way a Sold sheet counts them: **up to the next
 * `stepMin` block, but only once `graceMin` past the previous one**. With the default
 * 30 / 5 that reads:
 *
 * | served | counts as |
 * | --- | --- |
 * | 0:00 – 0:05 | 0:00 |
 * | 0:06 – 0:35 | 0:30 |
 * | 0:36 – 1:05 | 1:00 |
 * | 1:06 – 1:35 | 1:30 |
 *
 * The grace is what stops a crew that stayed three minutes over the half hour from being
 * counted a full block for it. It is per PERSON, then summed — rounding the total instead
 * would quietly give the same Einsatz a different answer depending on how many people came.
 */
export function roundedMinutes(minutes: number, rule = DEFAULT_HOURS_ROUNDING): number {
  const step = Math.max(1, Math.round(rule.stepMin))
  const grace = Math.max(0, Math.min(Math.round(rule.graceMin), step - 1))
  if (minutes <= grace) return 0
  return step * Math.ceil((minutes - grace) / step)
}

export interface HoursSummary {
  /** people who were marked present at some point — a record, not a live headcount */
  present: number
  /** raw minutes served, summed. The primary number: what actually happened. */
  minutes: number
  /** the same, each person rounded first (see `roundedMinutes`) */
  rounded: number
  /** people whose block could not be resolved to a duration, so they are in neither total */
  unresolved: number
}

/** The two numbers the printed rapport carries under the roster. */
export function hoursSummary(rows: HoursRow[], rule = DEFAULT_HOURS_ROUNDING): HoursSummary {
  let minutes = 0
  let rounded = 0
  let unresolved = 0
  for (const r of rows) {
    if (r.minutes == null) { unresolved += 1; continue }
    minutes += r.minutes
    rounded += roundedMinutes(r.minutes, rule)
  }
  return { present: rows.length, minutes, rounded, unresolved }
}

/** «14:35» — hours and minutes, never a decimal: 14.58 h is not a number anybody checks. */
export function fmtHours(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
}

/**
 * The rows whose times somebody actually has to go and fix — as opposed to the rows that carry
 * no duration for the ordinary reason that the Einsatz is still running.
 *
 * ⚠️ `minutes == null` alone is NOT a fault. An open block borrows the Einsatzende, so before
 * there is one EVERY person still on scene totals to nothing — on the demo's running Zimmerbrand
 * that named all 23 present crew under «Zeiten laufen rückwärts oder fehlen», which is neither
 * true nor actionable: nothing is wrong, the Einsatz has not ended. The print path has drawn
 * this line since it was written (`reportPdfDirect` prints the headcount alone and reports zero
 * unresolved while `endedAt` is unset); the closing checklist had not.
 *
 * What survives the filter is the real case: blocks that are all CLOSED and still cannot be
 * totalled, i.e. a departure recorded before its arrival. Those are wrong whether or not the
 * Einsatz has ended, and they stay named.
 */
export function unresolvedHoursRows(rows: HoursRow[], opts: { endedAt: string | null }): HoursRow[] {
  return rows.filter((r) => {
    if (r.minutes != null) return false
    // still here, and nothing to measure against yet — the normal state of a running Einsatz
    if (!opts.endedAt && !r.leftEarly) return false
    return true
  })
}
