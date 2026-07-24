import { describe, expect, it } from 'vitest'
import { hoursRows } from './attendanceHours'
import type { AttendanceState } from '../types'

const ALARM = '2026-07-08T03:12:00Z'
const ENDE = '2026-07-08T05:42:00Z'

describe('hoursRows', () => {
  it('uses own timestamps when present, fallbacks when missing', () => {
    const att: AttendanceState = {
      p1: { status: 'present', checkedInAt: '2026-07-08T03:20:00Z', displayNameSnapshot: 'Meier' },
      p2: { status: 'left', checkedInAt: '2026-07-08T03:15:00Z', leftAt: '2026-07-08T04:15:00Z', displayNameSnapshot: 'Huber' },
      p3: { status: 'present', displayNameSnapshot: 'Arnold' }, // no timestamps at all
    }
    const rows = hoursRows(att, { alarmedAt: ALARM, endedAt: ENDE })
    expect(rows.map((r) => r.name)).toEqual(['Arnold', 'Huber', 'Meier']) // stable name sort
    const by = Object.fromEntries(rows.map((r) => [r.personId, r]))
    expect(by.p2.minutes).toBe(60) // own von–bis
    expect(by.p1.minutes).toBe(142) // 03:20 → Einsatzende fallback
    expect(by.p3.from).toBe(ALARM) // full fallback span
    expect(by.p3.to).toBe(ENDE)
    expect(by.p3.minutes).toBe(150)
  })

  it('yields null minutes while the Einsatzende is unknown, never negative ones', () => {
    const att: AttendanceState = {
      p1: { status: 'present', checkedInAt: ALARM, displayNameSnapshot: 'Meier' },
      p2: { status: 'left', checkedInAt: ENDE, leftAt: ALARM, displayNameSnapshot: 'Huber' }, // inverted
    }
    const rows = hoursRows(att, { alarmedAt: ALARM, endedAt: null })
    const by = Object.fromEntries(rows.map((r) => [r.personId, r]))
    expect(by.p1.minutes).toBeNull()
    expect(by.p2.minutes).toBe(0)
  })

  it('keeps rows for people who left — presence is a record', () => {
    const att: AttendanceState = {
      p1: { status: 'left', checkedInAt: ALARM, leftAt: '2026-07-08T04:12:00Z', displayNameSnapshot: 'Weg' },
    }
    expect(hoursRows(att, { alarmedAt: ALARM, endedAt: ENDE })).toHaveLength(1)
  })
})
