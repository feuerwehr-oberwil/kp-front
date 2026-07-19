import { describe, expect, it } from 'vitest'
import { filterIncidents, historyGroupKey, monthLabel } from './historyGroups'

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
