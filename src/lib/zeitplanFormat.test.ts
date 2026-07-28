import { describe, expect, it } from 'vitest'
import { incidentDays } from './zeitplanFormat'

// The picker's day wheel is fed from here: the days an incident actually touches, so nobody has to
// steer a month and a year to say «the Wednesday».
describe('incidentDays', () => {
  it('lists every day from the start to the given end, inclusive', () => {
    const days = incidentDays('2026-07-28T08:00:00', Date.parse('2026-07-30T18:00:00'))
    expect(days.map((d) => d.getDate())).toEqual([28, 29, 30])
  })

  it('gives a single day for an incident that starts and ends the same evening', () => {
    const days = incidentDays('2026-07-28T08:00:00', Date.parse('2026-07-28T23:00:00'))
    expect(days).toHaveLength(1)
  })

  it('has nothing to offer without a start', () => {
    expect(incidentDays(null, Date.now())).toEqual([])
    expect(incidentDays('not-a-date', Date.now())).toEqual([])
  })

  // a stale or mistyped start must not render a wheel of a thousand rows
  it('caps a runaway span', () => {
    const days = incidentDays('2020-01-01T00:00:00', Date.parse('2026-07-30T18:00:00'))
    expect(days.length).toBeLessThanOrEqual(14)
  })
})
