// An Open-Meteo reading's time is GMT without a zone; read as device-local it showed 1–2 h off
// in the weather details (CET/CEST). These pin the reading rule, whatever zone the test runs in.

import { describe, expect, it } from 'vitest'
import { parseWeatherTime } from './weatherTime'

describe('parseWeatherTime', () => {
  it('reads an Open-Meteo stamp without a zone as UTC, not as device-local time', () => {
    expect(parseWeatherTime('2026-10-09T09:45')?.toISOString()).toBe('2026-10-09T09:45:00.000Z')
    expect(parseWeatherTime('2026-10-09T09:45:30')?.toISOString()).toBe('2026-10-09T09:45:30.000Z')
  })

  it('keeps a zoned stamp (MeteoSwiss) as it is', () => {
    expect(parseWeatherTime('2026-10-09T09:40:00+00:00')?.toISOString()).toBe('2026-10-09T09:40:00.000Z')
    expect(parseWeatherTime('2026-10-09T11:40:00+02:00')?.toISOString()).toBe('2026-10-09T09:40:00.000Z')
    expect(parseWeatherTime('2026-10-09T09:40:00Z')?.toISOString()).toBe('2026-10-09T09:40:00.000Z')
    expect(parseWeatherTime('2026-10-09T11:40:00+0200')?.toISOString()).toBe('2026-10-09T09:40:00.000Z')
  })

  it('nothing readable is null, never an Invalid Date', () => {
    expect(parseWeatherTime(null)).toBeNull()
    expect(parseWeatherTime(undefined)).toBeNull()
    expect(parseWeatherTime('')).toBeNull()
    expect(parseWeatherTime('garbage')).toBeNull()
  })
})
