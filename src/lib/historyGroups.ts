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
