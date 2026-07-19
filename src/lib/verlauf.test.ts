import { describe, expect, it } from 'vitest'
import { groupByDay, isNachtrag, rowTime } from './verlauf'
import type { TimelineEvent } from '../types'

const row = (id: string, at?: string): TimelineEvent =>
  ({ id, t: '09:00', at, icon: 'flag', text: id })

const NOW = new Date('2026-07-02T15:00:00')

describe('groupByDay', () => {
  it('keeps a single-day (today) journal as one unlabeled group', () => {
    const g = groupByDay([row('b', '2026-07-02T14:00:00'), row('a', '2026-07-02T09:00:00')], NOW)
    expect(g).toHaveLength(1)
    expect(g[0].label).toBeNull()
    expect(g[0].events.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('separates calendar days and labels the older ones', () => {
    const g = groupByDay(
      [row('new', '2026-07-02T10:00:00'), row('mid', '2026-07-01T22:00:00'), row('old', '2026-06-10T08:00:00')],
      NOW,
    )
    expect(g).toHaveLength(3)
    expect(g[0].label).toBeNull() // today
    expect(g[1].label).toMatch(/01\.07\.2026|07\/01\/2026|2026/)
    expect(g[2].label).toMatch(/10\.06\.2026|06\/10\/2026|2026/)
  })

  it('rows without `at` (old data) stick to the running group instead of fragmenting', () => {
    const g = groupByDay([row('a', '2026-07-02T10:00:00'), row('legacy'), row('b', '2026-07-02T08:00:00')], NOW)
    expect(g).toHaveLength(1)
    expect(g[0].events.map((e) => e.id)).toEqual(['a', 'legacy', 'b'])
  })
})

describe('isNachtrag', () => {
  const closed = '2026-07-02T18:00:00Z'
  it('flags rows after the Einsatzende, not rows during the incident', () => {
    expect(isNachtrag(row('during', '2026-07-02T14:00:00Z'), closed)).toBe(false)
    expect(isNachtrag(row('after', '2026-07-20T10:00:00Z'), closed)).toBe(true)
    expect(isNachtrag(row('after', '2026-07-20T10:00:00Z'), null)).toBe(false) // never closed
    expect(isNachtrag(row('no-at'), closed)).toBe(false) // legacy rows can't be judged
  })
})

describe('rowTime', () => {
  it('localises from `at` when present (server rows ship t="")', () => {
    const t = rowTime({ ...row('x', '2026-07-02T14:05:00'), t: '' })
    expect(t).toMatch(/14:05|02:05/) // local vs 12h formats
  })
  it('falls back to the baked t for legacy rows', () => {
    expect(rowTime(row('x'))).toBe('09:00')
  })
})
