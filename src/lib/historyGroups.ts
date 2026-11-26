// Search + time-grouping helpers for the «Alle Einsätze» list. The list grows by one row
// per Einsatz forever, so finding an old one to view/reactivate needs more than scrolling.
// Pure — no React/DOM, node-testable; the HistoryPanel maps group keys to localized labels.

import { matchesAnyQuery, searchQuery } from './search'

/** title/address filter through the one search fold (lib/search: umlauts, one typo); an empty
 *  query passes everything through */
export function filterIncidents<T extends { title: string; address: string | null }>(items: T[], query: string): T[] {
  const q = searchQuery(query)
  if (!q) return items
  return items.filter((i) => matchesAnyQuery(q, i.title, i.address))
}

/** The quick filters over «Alle Einsätze» (owner, 27.10.2026): Ernstfall | Übung (one or the
 *  other, or both when neither is chosen), one Einsatzart, and «Rapport offen» — a CLOSED Einsatz
 *  whose Rapport was never marked done (a running one is open by definition, so it would only
 *  be noise). They combine with AND, and with the search. */
export interface HistoryFilter {
  kind: 'real' | 'exercise' | null
  type: string | null
  rapportOpen: boolean
}
export const NO_HISTORY_FILTER: HistoryFilter = { kind: null, type: null, rapportOpen: false }

type Filterable = { is_archived: boolean; is_exercise: boolean; type?: string | null; report_done_at?: string | null }

export function applyHistoryFilter<T extends Filterable>(items: T[], f: HistoryFilter): T[] {
  return items.filter((i) =>
    (f.kind == null || i.is_exercise === (f.kind === 'exercise'))
    && (f.type == null || i.type === f.type)
    && (!f.rapportOpen || (i.is_archived && !i.report_done_at)))
}

/** The Einsatzarten the list actually holds, for the «Einsatzart» chip's choices — sorted, each once */
export function historyTypes(items: { type?: string | null }[]): string[] {
  return [...new Set(items.map((i) => i.type).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b))
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

/** One heading of «Alle Einsätze» and its rows. */
export interface HistoryGroup<T> { key: string; rows: T[] }

type Groupable = { id: string; is_archived: boolean; started_at: string; closed_at?: string | null; last_closed_at?: string | null }

/**
 * The list's groups, in display order: 'open', then 'last' – the ONE Einsatz closed (or closed
 * again) last, out of its time group – then the time groups as `historyGroupKey` reads them.
 *
 * ⚠️ 'last' is owner pick UX journeys B3·26 (25.11.2026): a walker corrected the wrong Einsatz.
 * The one to correct is nearly always the one closed last, and by alarm time a second Einsatz the
 * same day pushes it to row two (backend sorts by `started_at`). The rest keeps that order.
 * `items` arrive sorted active-first then newest, so a key never comes back and a group opens on
 * every key change.
 */
export function historyGroups<T extends Groupable>(items: readonly T[], now: Date): HistoryGroup<T>[] {
  const closeOf = (i: T) => Date.parse(i.last_closed_at ?? i.closed_at ?? '')
  const last = items.reduce<T | null>((best, i) => (
    i.is_archived && Number.isFinite(closeOf(i)) && (!best || closeOf(i) > closeOf(best)) ? i : best
  ), null)
  const groups: HistoryGroup<T>[] = []
  for (const i of items) {
    if (i === last) continue
    const key = historyGroupKey(i, now)
    const tail = groups[groups.length - 1]
    if (tail?.key === key) tail.rows.push(i)
    else groups.push({ key, rows: [i] })
  }
  if (last) groups.splice(groups[0]?.key === 'open' ? 1 : 0, 0, { key: 'last', rows: [last] })
  return groups
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
 *  Pure: hands back the pieces, the panel words them. `end` is the RAPPORT's Einsatzende
 *  (`report_ended_at`, what the Rapport and the PDF print), the close only when it has none (owner
 *  pick UX journeys B3·20, 25.11.2026 – it was the LAST close, so a Nachtrag next morning made the
 *  Einsatz «run all night» here while the Rapport kept 14:27); null while it runs or when a closed
 *  row has neither. `endDay` is set only when the end fell on another calendar day than the start. */
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
  i: { is_archived: boolean; started_at: string; closed_at?: string | null; last_closed_at?: string | null; report_ended_at?: string | null },
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
  const endIso = i.is_archived ? (i.report_ended_at || i.last_closed_at || i.closed_at || null) : null
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
