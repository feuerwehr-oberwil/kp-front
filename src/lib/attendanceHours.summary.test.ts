import { describe, expect, it } from 'vitest'
import { fmtHours, hoursSummary, roundedMinutes } from './attendanceHours'
import type { HoursRow } from './attendanceHours'

// The rounding rule is a Sold convention, not arithmetic — it is worth pinning by example,
// because «auf die nächste halbe Stunde, aber erst 5 Minuten drüber» has two plausible readings
// and only one of them leaves 0:35 at half an hour.
describe('roundedMinutes', () => {
  it('rounds up only once past the grace', () => {
    const cases: [number, number][] = [
      [0, 0], [5, 0], [6, 30], [30, 30], [35, 30], [36, 60],
      [60, 60], [65, 60], [66, 90], [125, 120], [126, 150],
    ]
    for (const [served, expected] of cases) expect([served, roundedMinutes(served)]).toEqual([served, expected])
  })

  it('honours a deployment own step and grace', () => {
    expect(roundedMinutes(31, { stepMin: 60, graceMin: 10 })).toBe(60)
    expect(roundedMinutes(71, { stepMin: 60, graceMin: 10 })).toBe(120)
    // a grace at or past the step would swallow whole blocks — clamped to just under one
    expect(roundedMinutes(29, { stepMin: 30, graceMin: 90 })).toBe(0)
    expect(roundedMinutes(30, { stepMin: 30, graceMin: 90 })).toBe(30)
  })
})

describe('hoursSummary', () => {
  const row = (minutes: number | null): HoursRow => ({
    personId: String(minutes), name: 'x', from: null, to: null, minutes, intervals: [], leftEarly: false,
  })

  it('rounds per person, not on the total', () => {
    // 3 × 0:20 raw = 1:00; rounded per person = 3 × 0:30 = 1:30. Rounding the total would say 1:00
    // and quietly make the answer depend on how many people happened to come.
    const s = hoursSummary([row(20), row(20), row(20)])
    expect(s).toMatchObject({ present: 3, minutes: 60, rounded: 90, unresolved: 0 })
  })

  it('counts a person whose duration cannot be resolved, but bills nobody for them', () => {
    const s = hoursSummary([row(90), row(null)])
    expect(s).toMatchObject({ present: 2, minutes: 90, rounded: 90, unresolved: 1 })
  })
})

describe('fmtHours', () => {
  it('never prints a decimal hour', () => {
    expect(fmtHours(875)).toBe('14:35')
    expect(fmtHours(60)).toBe('1:00')
    expect(fmtHours(0)).toBe('0:00')
  })
})
