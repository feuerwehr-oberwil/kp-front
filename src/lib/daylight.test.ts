import { describe, it, expect } from 'vitest'
import { isDaytime, solarElevationDeg, FALLBACK_COORD, type Coord } from './daylight'

const SAMPLE_COORD: Coord = [7.55, 47.49]

describe('isDaytime (sample location ~47.5°N)', () => {
  it('is day at summer midday', () => {
    // 2026-06-21 12:00 UTC = 14:00 CEST — sun high
    expect(isDaytime(SAMPLE_COORD, new Date('2026-06-21T12:00:00Z'))).toBe(true)
  })
  it('is night in the small hours of a summer night', () => {
    // 2026-06-21 23:00 UTC = 01:00 CEST
    expect(isDaytime(SAMPLE_COORD, new Date('2026-06-21T23:00:00Z'))).toBe(false)
  })
  it('is day at winter midday', () => {
    // 2026-12-21 11:00 UTC = 12:00 CET
    expect(isDaytime(SAMPLE_COORD, new Date('2026-12-21T11:00:00Z'))).toBe(true)
  })
  it('is night on a winter evening after sunset', () => {
    // 2026-12-21 20:00 UTC = 21:00 CET (sunset ~16:40 local)
    expect(isDaytime(SAMPLE_COORD, new Date('2026-12-21T20:00:00Z'))).toBe(false)
  })
})

describe('solarElevationDeg', () => {
  it('peaks near solar noon and is well below the horizon at night', () => {
    const noon = solarElevationDeg(SAMPLE_COORD, new Date('2026-06-21T11:30:00Z')) // ~solar noon
    const night = solarElevationDeg(SAMPLE_COORD, new Date('2026-06-21T23:00:00Z'))
    expect(noon).toBeGreaterThan(55) // ~66° at the summer solstice for 47.5°N
    expect(night).toBeLessThan(0)
  })

  it('falls back to the neutral national centroid when no coordinate is given', () => {
    const withFallback = solarElevationDeg(FALLBACK_COORD, new Date('2026-06-21T12:00:00Z'))
    const withNull = isDaytime(null, new Date('2026-06-21T12:00:00Z'))
    expect(withFallback).toBeGreaterThan(0)
    expect(withNull).toBe(true)
  })
})
