import { listProgress } from '../objectVisits/catalogue'
import type { VisitList } from '../objectVisits/types'

export type ScheduleGroup = 'today' | 'overdue' | 'upcoming' | 'undated' | 'history'

/** Dates describe a calendar day, not UTC midnight. Old cached catalogues remain usable. */
export function visitSchedule(lists: VisitList[], visits: Parameters<typeof listProgress>[1], today: string) {
  const groups: Record<ScheduleGroup, VisitList[]> = { today: [], overdue: [], upcoming: [], undated: [], history: [] }
  for (const list of lists) {
    const p = listProgress(list, visits)
    const complete = p.total > 0 && p.done === p.total && !list.unresolved?.length
    const group = list.archived || complete ? 'history'
      : !list.scheduledOn ? 'undated'
        : list.scheduledOn === today ? 'today' : list.scheduledOn < today ? 'overdue' : 'upcoming'
    groups[group].push(list)
  }
  for (const [key, group] of Object.entries(groups)) {
    group.sort((a, b) => {
      const dates = (a.scheduledOn ?? '').localeCompare(b.scheduledOn ?? '')
      return (key === 'history' ? -dates : dates) || a.title.localeCompare(b.title)
    })
  }
  return groups
}

export function localCalendarDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
