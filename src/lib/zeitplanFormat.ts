import { appConfig } from '../config/appConfig'

/** «Mo 27.07.» — the midnight tick on a multi-day Zeitplan axis. Over several days a bare
 *  «00:00» says nothing about WHICH night, and «Tag 2, 03:00» is a different decision from
 *  «heute, 03:00». */
export function fmtDayShort(d: Date): string {
  return d.toLocaleDateString(appConfig.locale, { weekday: 'short', day: '2-digit', month: '2-digit' })
}

/** True when two instants fall on different calendar days (local time). */
export function isOtherDay(a: Date, b: Date): boolean {
  return a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear()
}

/**
 * The calendar days an incident touches, from its start to `until` (now, or the last planned end).
 *
 * Feeds the picker's day wheel. Bounded on purpose: an incident spans a handful of days and all of
 * them are known, so the operator picks from a list instead of steering a month and a year. One
 * day in, no wheel appears — which is every incident that finishes the same evening.
 * Capped at MAX_DAYS so a stale or mistyped start cannot render a wheel of a thousand rows.
 */
const MAX_DAYS = 14
export function incidentDays(startedAt: string | null | undefined, until: number): Date[] {
  const s = startedAt ? new Date(startedAt) : null
  if (!s || !Number.isFinite(s.getTime())) return []
  const end = new Date(Number.isFinite(until) ? until : s.getTime())
  const out: Date[] = []
  const d = new Date(s.getFullYear(), s.getMonth(), s.getDate())
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  while (d <= last && out.length < MAX_DAYS) {
    out.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

/**
 * A head count that may not be whole — «8», «7,6».
 *
 * The Schichten grid counts a deviating shift pro rata (see shifts.bandCoverFraction), so its
 * column totals land between the integers. Rounding to «8» would state something the grid cannot
 * back up; one decimal, with the German comma, says what it is. One decimal and no more: the
 * question is «roughly how many do I have in this window», and a second digit is spurious
 * precision on a plan that changes with the next phone call.
 */
export function fmtCount(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',')
}

/**
 * What the «ab Einsatzbeginn» shortcut shows as its value.
 *
 * The clock alone — «ab Beginn 10:56» — is a promise you cannot check on day three of an
 * Elementarereignis: 10:56 of WHICH morning. When the incident spans more than one day the weekday
 * comes with it; on a single-day incident it would be noise, so it stays off.
 */
export function fmtStartValue(startedAt: string, days: Date[]): string {
  const d = new Date(startedAt)
  if (!Number.isFinite(d.getTime())) return ''
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return days.length > 1 ? `${fmtDayShort(d)} ${t}` : t
}
