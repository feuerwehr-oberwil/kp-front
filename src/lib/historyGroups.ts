// Search + time-grouping helpers for the «Alle Einsätze» list. The list grows by one row
// per Einsatz forever, so finding an old one to view/reactivate needs more than scrolling.
// Pure — no React/DOM, node-testable; the HistoryPanel maps group keys to localized labels.

/** case-insensitive title/address filter; an empty query passes everything through */
export function filterIncidents<T extends { title: string; address: string | null }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => i.title.toLowerCase().includes(q) || (i.address ?? '').toLowerCase().includes(q))
}

/** Bucket key for a list row: 'open' · 'today' · 'week' (last 7 days) · 'm:YYYY-M'.
 *  The list is already sorted active-first then newest-first, so emitting a header whenever
 *  the key CHANGES yields the groups in display order with no separate sort. */
export function historyGroupKey(i: { is_archived: boolean; started_at: string }, now: Date): string {
  if (!i.is_archived) return 'open'
  const d = new Date(i.started_at)
  if (Number.isNaN(d.getTime())) return 'm:0-0' // malformed date → the label falls back to '—'
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return 'today'
  if (now.getTime() - d.getTime() < 7 * 24 * 3600_000 && d.getTime() <= now.getTime()) return 'week'
  return `m:${d.getFullYear()}-${d.getMonth() + 1}`
}

/** Format an 'm:YYYY-M' key as a localized month heading («Juli 2026»); '—' for the
 *  malformed-date bucket. Non-month keys are the caller's to label from copy. */
export function monthLabel(key: string, locale: string): string {
  const m = /^m:(\d+)-(\d+)$/.exec(key)
  if (!m) return key
  const year = Number(m[1]), month = Number(m[2])
  if (year < 1970 || month < 1 || month > 12) return '—'
  try {
    return new Date(year, month - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  } catch {
    return `${month}/${year}`
  }
}

/** When an Einsatz ran, for its row in «Alle Einsätze» (05.10.2026, owner: «in Verlauf also show
 *  start times of emergencies»). The start time used to trail the address unlabelled
 *  («Hauptstrasse 12 · 05.10., 12:24») and the end was nowhere. Now the row says the day, the
 *  span and how long it took — «Mo., 05.10. · 12:24–13:47 · 1 h 23» — and a running one «seit».
 *
 *  Pure: hands back the pieces, the panel words them. `end` is the Einsatzende the clock and the
 *  Rapport use (`closeTimeOf`: the LAST close); null while it runs or when a closed row has
 *  none. `endDay` is set only when the end fell on another calendar day than the start. */
export interface HistoryWhen {
  day: string
  start: string
  end: string | null
  endDay: string | null
  /** start → end, or start → now while it runs; null when the start is unreadable */
  durationMs: number | null
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const pad = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function historyWhen(
  i: { is_archived: boolean; started_at: string; closed_at?: string | null; last_closed_at?: string | null },
  now: Date,
  locale: string,
): HistoryWhen | null {
  const s = new Date(i.started_at)
  if (Number.isNaN(s.getTime())) return null
  // the year only when it is not this one — «Fr., 12.09.2025» for last year's, never for today's
  const dayOf = (d: Date) => {
    try {
      return d.toLocaleDateString(locale, {
        weekday: 'short', day: '2-digit', month: '2-digit',
        ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
      })
    } catch {
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`
    }
  }
  const endIso = i.is_archived ? (i.last_closed_at ?? i.closed_at ?? null) : null
  const e = endIso ? new Date(endIso) : null
  const end = e && !Number.isNaN(e.getTime()) && e.getTime() >= s.getTime() ? e : null
  const until = end ?? (i.is_archived ? null : now)
  return {
    day: dayOf(s),
    start: clock(s),
    end: end ? clock(end) : null,
    endDay: end && !sameDay(s, end) ? dayOf(end) : null,
    durationMs: until ? Math.max(0, until.getTime() - s.getTime()) : null,
  }
}
