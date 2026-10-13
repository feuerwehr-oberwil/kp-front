// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { WeatherRadarControls } from './WeatherLayer'
import type { WeatherRadar } from '../lib/weatherLayer'

// Ported from kp-rueck (R5, weather-radar-controls.test.tsx).

afterEach(cleanup)

const NOW = Date.parse('2026-10-08T17:30:00Z')

const radar: WeatherRadar = {
  frames: [
    { key: '202610081620', time: '2026-10-08T16:20:00+00:00' },
    { key: '202610081720', time: '2026-10-08T17:20:00+00:00' },
  ],
  coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]],
  data_time: '2026-10-08T17:20:00+00:00',
  stale: false,
  stale_after_seconds: 900,
  status: { last_attempt_at: null, last_success_at: null, last_error: null, last_error_at: null },
  legend: [],
  attribution: 'MeteoSchweiz',
  source_url: 'https://www.meteoschweiz.admin.ch',
}

describe('WeatherRadarControls', () => {
  it('opens on the newest frame, says how old a scrubbed one is, and names the source', () => {
    const { rerender } = render(<WeatherRadarControls radar={radar} frameIndex={1} playing={false} onPick={() => {}} onTogglePlaying={() => {}} stale={false} now={NOW} />)
    expect(screen.getByText('aktuell')).toBeTruthy()
    expect(screen.getByText('MeteoSchweiz')).toBeTruthy()
    rerender(<WeatherRadarControls radar={radar} frameIndex={0} playing={false} onPick={() => {}} onTogglePlaying={() => {}} stale={false} now={NOW} />)
    expect(screen.getByText('vor 60 min')).toBeTruthy()
  })

  it('says «veraltet» with the time of the data once the radar went stale', () => {
    render(<WeatherRadarControls radar={radar} frameIndex={1} playing={false} onPick={() => {}} onTogglePlaying={() => {}} stale now={NOW + 30 * 60_000} />)
    expect(screen.getByText(/Stand \d{2}:20 – veraltet/)).toBeTruthy()
  })

  it('without frames says so instead of showing an empty scrubber', () => {
    render(<WeatherRadarControls radar={{ ...radar, frames: [], status: { ...radar.status, last_error: 'HTTP 500' } }} frameIndex={-1} playing={false} onPick={() => {}} onTogglePlaying={() => {}} stale now={NOW} />)
    expect(screen.getByText('Radar zurzeit nicht verfügbar.')).toBeTruthy()
  })
})
