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
