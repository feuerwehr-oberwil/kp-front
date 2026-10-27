import { describe, expect, it } from 'vitest'
import { NO_HISTORY_FILTER, applyHistoryFilter, filterIncidents, historyGroupKey, historyTypes, historyWhen, monthLabel } from './historyGroups'

const NOW = new Date('2026-07-12T18:00:00')
const inc = (over: { is_archived?: boolean; started_at?: string; title?: string; address?: string | null }) => ({
  is_archived: true, started_at: '2026-07-01T10:00:00', title: 'Brand', address: null, ...over,
})

describe('filterIncidents', () => {
  const items = [
    inc({ title: 'Chemieunfall', address: 'Löchlimattstrasse 1' }),
    inc({ title: 'Gebäudebrand', address: 'Im Wasen 3a' }),
    inc({ title: 'Ölspur', address: null }),
  ]
  it('passes everything through on an empty/whitespace query', () => {
    expect(filterIncidents(items, '')).toHaveLength(3)
    expect(filterIncidents(items, '   ')).toHaveLength(3)
  })
  it('matches the title case-insensitively', () => {
    expect(filterIncidents(items, 'chemie')).toEqual([items[0]])
  })
  it('matches the address', () => {
    expect(filterIncidents(items, 'wasen')).toEqual([items[1]])
  })
  it('tolerates a null address', () => {
    expect(filterIncidents(items, 'ölspur')).toEqual([items[2]])
  })
  it('returns empty on no match', () => {
    expect(filterIncidents(items, 'zzz')).toEqual([])
  })
})

describe('historyGroupKey', () => {
  it('open incidents group as open regardless of age', () =>
    expect(historyGroupKey(inc({ is_archived: false, started_at: '2026-01-01T00:00:00' }), NOW)).toBe('open'))
  it('same calendar day → today', () =>
    expect(historyGroupKey(inc({ started_at: '2026-07-12T06:30:00' }), NOW)).toBe('today'))
  it('within the last 7 days → week', () =>
    expect(historyGroupKey(inc({ started_at: '2026-07-08T12:00:00' }), NOW)).toBe('week'))
  it('older → month bucket', () =>
    expect(historyGroupKey(inc({ started_at: '2026-06-27T18:25:00' }), NOW)).toBe('m:2026-6'))
  it('a different year keeps its own bucket', () =>
    expect(historyGroupKey(inc({ started_at: '2025-12-31T23:00:00' }), NOW)).toBe('m:2025-12'))
  it('a malformed date lands in the fallback bucket instead of throwing', () =>
    expect(historyGroupKey(inc({ started_at: 'not-a-date' }), NOW)).toBe('m:0-0'))
})

describe('monthLabel', () => {
  it('formats a month key in the given locale', () =>
    expect(monthLabel('m:2026-6', 'de-CH')).toBe('Juni 2026'))
  it('falls back to — for the malformed-date bucket', () =>
    expect(monthLabel('m:0-0', 'de-CH')).toBe('—'))
  it('passes non-month keys through', () => expect(monthLabel('today', 'de-CH')).toBe('today'))
})

describe('historyWhen — when an Einsatz ran, for its row', () => {
  it('a closed one: day, start–end and how long', () => {
    const w = historyWhen({ is_archived: true, started_at: '2026-07-12T12:24:00', closed_at: '2026-07-12T13:00:00', last_closed_at: '2026-07-12T13:47:00' }, NOW, 'de-CH')!
    expect(w.start).toBe('12:24')
    expect(w.end).toBe('13:47') // the LAST close, as the clock and the Rapport read it
    expect(w.endDay).toBeNull()
    expect(w.durationMs).toBe(83 * 60_000)
    expect(w.day).toMatch(/12\.07/)
    expect(w.day).not.toMatch(/2026/) // this year's needs no year
  })
  it('a running one: no end, the duration runs to now', () => {
    const w = historyWhen({ is_archived: false, started_at: '2026-07-12T17:30:00', closed_at: null }, NOW, 'de-CH')!
    expect(w.end).toBeNull()
    expect(w.durationMs).toBe(30 * 60_000)
  })
  it('names the end day when the Einsatz ran past midnight', () => {
    const w = historyWhen({ is_archived: true, started_at: '2026-07-10T23:10:00', closed_at: '2026-07-11T01:05:00' }, NOW, 'de-CH')!
    expect(w.end).toBe('01:05')
    expect(w.endDay).toMatch(/11\.07/)
  })
  it('a closed one without a close time says no duration rather than inventing one', () => {
    const w = historyWhen({ is_archived: true, started_at: '2026-07-10T23:10:00', closed_at: null }, NOW, 'de-CH')!
    expect(w.end).toBeNull()
    expect(w.durationMs).toBeNull()
  })
  it('carries the year for an Einsatz from another year', () => {
    expect(historyWhen({ is_archived: true, started_at: '2025-09-12T10:00:00' }, NOW, 'de-CH')!.day).toMatch(/2025/)
  })
  it('gives up on an unreadable start', () => {
    expect(historyWhen({ is_archived: true, started_at: 'nope' }, NOW, 'de-CH')).toBeNull()
  })
})

describe('applyHistoryFilter', () => {
  const row = (id: string, over: { is_archived?: boolean; is_exercise?: boolean; type?: string | null; report_done_at?: string | null }) =>
    ({ id, is_archived: true, is_exercise: false, type: 'Brand', report_done_at: '2026-07-01T12:00:00Z', ...over })
  const items = [
    row('brand', {}),
    row('drill', { is_exercise: true, type: 'Technische Hilfe' }),
    row('unfinished', { report_done_at: null }),
    row('running', { is_archived: false, report_done_at: null }),
  ]
  const ids = (f: Partial<typeof NO_HISTORY_FILTER>) => applyHistoryFilter(items, { ...NO_HISTORY_FILTER, ...f }).map((i) => i.id)

  it('splits Ernstfall from Übung', () => {
    expect(ids({ kind: 'exercise' })).toEqual(['drill'])
    expect(ids({ kind: 'real' })).toEqual(['brand', 'unfinished', 'running'])
  })
  it('«Rapport offen» is a closed Einsatz without a done Rapport, never a running one', () => {
    expect(ids({ rapportOpen: true })).toEqual(['unfinished'])
  })
  it('combines with AND', () => {
    expect(ids({ kind: 'real', type: 'Technische Hilfe' })).toEqual([])
    expect(ids({ type: 'Brand', rapportOpen: true })).toEqual(['unfinished'])
  })
  it('lists each Einsatzart once, sorted, without the empty ones', () => {
    expect(historyTypes([...items, row('x', { type: null })])).toEqual(['Brand', 'Technische Hilfe'])
  })
})
