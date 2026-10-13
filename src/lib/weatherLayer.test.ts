import { describe, expect, it } from 'vitest'
import {
  formatWeatherTime,
  frameAgeMinutes,
  isStale,
  pickedFrameIndex,
  radarIsStale,
  type WeatherRadar,
} from './weatherLayer'

// Ported from kp-rueck (R5, lib/weather.test.ts) — the two apps judge the same feed alike.

const NOW = Date.parse('2026-10-08T17:30:00Z')

const radar: WeatherRadar = {
  frames: [
    { key: '202610081620', time: '2026-10-08T16:20:00+00:00' },
    { key: '202610081720', time: '2026-10-08T17:20:00+00:00' },
  ],
  coordinates: null,
  data_time: '2026-10-08T17:20:00+00:00',
  stale: false,
  stale_after_seconds: 900,
  status: { last_attempt_at: null, last_success_at: null, last_error: null, last_error_at: null },
  legend: [],
  attribution: 'MeteoSchweiz',
  source_url: 'https://www.meteoschweiz.admin.ch',
}

describe('staleness ages on the shared clock, it is not frozen by the last answer', () => {
  it('ages a frame against the limit', () => {
    expect(radarIsStale(radar, NOW)).toBe(false) // 10 min old, limit 15
    expect(radarIsStale(radar, NOW + 6 * 60_000)).toBe(true) // 16 min old — offline, no new answer
  })
  it('trusts the backend when it already called the radar stale', () => {
    expect(radarIsStale({ ...radar, stale: true }, NOW)).toBe(true)
  })
  it('treats no time at all as stale', () => {
    expect(isStale(null, 900, NOW)).toBe(true)
    expect(isStale('not a date', 900, NOW)).toBe(true)
  })
})

describe('frames', () => {
  it('says how far back a scrubbed frame is', () => {
    expect(frameAgeMinutes(radar, 0)).toBe(60)
    expect(frameAgeMinutes(radar, 1)).toBe(0)
  })

  it('follows the newest frame, keeps a picked one by key, and falls back when it aged out', () => {
    expect(pickedFrameIndex(radar, null)).toBe(1)
    expect(pickedFrameIndex(radar, '202610081620')).toBe(0)
    expect(pickedFrameIndex(radar, '202610081500')).toBe(1)
    expect(pickedFrameIndex(null, null)).toBe(-1)
  })

  it('adds the weekday only when the moment is not today', () => {
    const today = formatWeatherTime('2026-10-08T15:05:00Z', NOW, 'de-CH')
    expect(today).toMatch(/^\d{2}:05$/)
    const later = formatWeatherTime('2026-10-10T06:00:00Z', NOW, 'de-CH')
    expect(later).toMatch(/^\S+ \d{2}:00$/)
  })
})
