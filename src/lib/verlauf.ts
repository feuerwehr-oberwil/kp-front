import { appConfig } from '../config/appConfig'
import { formatTime } from './format'
import type { TimelineEvent } from '../types'

/**
 * Verlauf display helpers: localized row times, the Nachtrag boundary, and day grouping.
 *
 * An incident's journal can span days (Hochwasser) or carry corrections appended weeks
 * after the Einsatzende (archive → reopen, the correction path). Bare HH:MM rows made a
 * three-weeks-later Nachtrag look like it happened on incident day — these helpers give
 * the drawer date separators and let rows after `closed_at` carry a Nachtrag badge.
 */

/** Display time from the absolute timestamp when present (server rows ship t='' and the
 *  server clock is UTC — the client localises); legacy rows fall back to their baked t. */
export const rowTime = (e: TimelineEvent): string => (e.at ? formatTime(new Date(e.at)) : e.t)

/** appended after the Einsatzende (closed_at) → renders as a Nachtrag */
export const isNachtrag = (e: TimelineEvent, closedAt?: string | null): boolean =>
  !!closedAt && !!e.at && Date.parse(e.at) > Date.parse(closedAt)

export interface DayGroup {
  /** localized date label for the separator — null for today's rows (no separator) */
  label: string | null
  events: TimelineEvent[]
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Group a newest-first Verlauf into calendar-day runs. Rows without `at` (old data)
 *  stick to the running group rather than fragmenting the list. */
export function groupByDay(events: readonly TimelineEvent[], now: Date = new Date()): DayGroup[] {
  const todayKey = dayKey(now)
  const groups: DayGroup[] = []
  let currentKey: string | undefined
  for (const e of events) {
    const d = e.at ? new Date(e.at) : null
    const k = d && !Number.isNaN(d.getTime()) ? dayKey(d) : (currentKey ?? todayKey)
    if (k !== currentKey || groups.length === 0) {
      currentKey = k
      groups.push({
        label:
          k === todayKey
            ? null
            : (d ?? now).toLocaleDateString(appConfig.locale, {
                weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
              }),
        events: [],
      })
    }
    groups[groups.length - 1].events.push(e)
  }
  return groups
}
