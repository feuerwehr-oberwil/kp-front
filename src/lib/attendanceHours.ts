// Per-person Einsatzstunden derived from the attendance record. The rapport records the
// hours; billing itself stays in the external system (the colleague transfers by hand) —
// so this is presentation math, not accounting: von–bis per person with sensible defaults
// (Alarmierung → Einsatzende when a timestamp is missing) and a column total.

import type { AttendanceState } from '../types'

export interface HoursRow {
  personId: string
  name: string
  /** ISO — the entry's own timestamp, else the alarm time fallback */
  from: string | null
  /** ISO — leftAt, else the Einsatzende fallback (null while neither exists) */
  to: string | null
  /** whole minutes, ≥ 0; null when either end is unknown */
  minutes: number | null
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : null
}

/**
 * One row per person ever marked present (status 'left' keeps its row — presence is a
 * record, not a live flag). Defaults: missing checkedInAt → alarmedAt; missing leftAt →
 * endedAt. Rows sort by name for a stable printable table.
 */
export function hoursRows(
  attendance: AttendanceState,
  opts: { alarmedAt: string | null; endedAt: string | null },
): HoursRow[] {
  return Object.entries(attendance)
    .map(([personId, e]) => {
      const from = e.checkedInAt ?? opts.alarmedAt ?? null
      const to = e.leftAt ?? opts.endedAt ?? null
      const a = ms(from)
      const b = ms(to)
      const minutes = a != null && b != null ? Math.max(0, Math.round((b - a) / 60_000)) : null
      return { personId, name: e.displayNameSnapshot, from, to, minutes }
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'de-CH'))
}

/** Sum of the known durations in whole minutes (unknown rows count 0). */
export function hoursTotalMinutes(rows: HoursRow[]): number {
  return rows.reduce((sum, r) => sum + (r.minutes ?? 0), 0)
}

/** '7:35' style h:mm for a minute count (used by the Stunden column + total). */
export function fmtMinutesHM(minutes: number | null): string {
  if (minutes == null) return '–'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}`
}
