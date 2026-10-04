import { listProgress } from '../objectVisits/catalogue'
import type { VisitList } from '../objectVisits/types'

export type ScheduleGroup = 'today' | 'overdue' | 'upcoming' | 'undated' | 'recent' | 'history'

/** How long a finished round stays on the overview («Kürzlich erledigt») before it is history. */
export const RECENT_DAYS = 7

/** Dates describe a calendar day, not UTC midnight. Old cached catalogues remain usable.
 *  `history` (withdrawn rounds, and finished ones older than RECENT_DAYS) is not shown in the
 *  field app — the organizer keeps the record (fwo-admin, the filed reports). */
export function visitSchedule(lists: VisitList[], visits: Parameters<typeof listProgress>[1], today: string) {
  const groups: Record<ScheduleGroup, VisitList[]> = { today: [], overdue: [], upcoming: [], undated: [], recent: [], history: [] }
  const recentFrom = addDays(today, -RECENT_DAYS)
  for (const list of lists) {
    const p = listProgress(list, visits)
    const complete = p.total > 0 && p.done === p.total && !list.unresolved?.length
    const group = list.archived ? 'history'
      : complete ? (finishedOn(p.stops) >= recentFrom ? 'recent' : 'history')
      : !list.scheduledOn ? 'undated'
        : list.scheduledOn === today ? 'today' : list.scheduledOn < today ? 'overdue' : 'upcoming'
    groups[group].push(list)
  }
  for (const [key, group] of Object.entries(groups)) {
    group.sort((a, b) => {
      const dates = (a.scheduledOn ?? '').localeCompare(b.scheduledOn ?? '')
      return (key === 'history' || key === 'recent' ? -dates : dates) || a.title.localeCompare(b.title)
    })
  }
  return groups
}

export function localCalendarDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** The local day the last stop of a finished round was done (a visit, or the organizer's record). */
function finishedOn(stops: ReturnType<typeof listProgress>['stops']): string {
  let last = ''
  for (const stop of stops.values()) {
    const day = stop.visit?.lifecycle === 'completed' && stop.visit.visitedAt
      ? localCalendarDay(new Date(stop.visit.visitedAt))
      : stop.prior?.at ?? ''
    if (day > last) last = day
  }
  return last
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localCalendarDay(new Date(y, m - 1, d + n))
}
