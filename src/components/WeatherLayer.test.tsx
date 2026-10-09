// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WeatherFloats, WeatherRadarControls, WeatherWarningChip } from './WeatherLayer'
import type { ApiWeatherLayer, WeatherRadar, WeatherWarning } from '../lib/weatherLayer'

// Ported from kp-rueck (R5, weather-warning-chip.test.tsx): the chip names the warning in the
// source's own word and opens the full text UNALTERED (MetO art. 5).

afterEach(cleanup)

const NOW = Date.parse('2026-10-08T17:30:00Z')

// The BL fire-danger alert as Alertswiss carried it on 08.10.2026 (shortened to two instructions).
const fireBan: WeatherWarning = {
  id: 'alertswiss:POA-1355976462-5',
  source: 'alertswiss',
  level: 2,
  color: null,
  kind: null,
  sent: '2026-09-11T10:23:21+00:00',
  onset: null,
  expires: null,
  sender: 'Kanton Basel-Landschaft',
  link: 'https://bit.ly/4xKMLH5',
  region: 'Ganzer Kanton Basel-Landschaft',
  texts: {
    de: {
      event: 'Feuerverbot',
      headline: 'Erhebliche Waldbrandgefahr (Stufe 3); Vorsicht vor Astabbrüchen',
      description: 'Aufgrund der anhaltenden Trockenheit gelten im Kanton Basel-Landschaft bis auf Weiteres verschiedene Massnahmen.\n\nDie Trockenheit führt zu einer erheblichen Waldbrandgefahr und zum Austrocknen von Bächen.',
      instructions: ['Es besteht ein Feuerwerksverbot.', 'Das Steigenlassen von  Himmelslaternen ist verboten.'],
    },
  },
  fetched_at: '2026-10-08T17:25:00+00:00',
}

function layer(items: WeatherWarning[], radar: WeatherRadar | null = null): ApiWeatherLayer {
  return {
    enabled: true,
    point: true,
    generated_at: '2026-10-08T17:29:00+00:00',
    radar,
    warnings: { items, sources: {}, stale_after_seconds: 1500 },
  }
}

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

describe('WeatherWarningChip', () => {
  it('names the warning in the source’s own word and opens the full text unaltered', async () => {
    render(<WeatherWarningChip layer={layer([fireBan])} now={NOW} />)
    const chip = screen.getByRole('button', { name: /Wetterwarnungen \(1\): Feuerverbot · bis auf Widerruf/ })
    fireEvent.click(chip)

    expect(await screen.findByText(fireBan.texts.de.headline)).toBeTruthy()
    // Verbatim – double space and line breaks included; nothing is trimmed or rephrased.
    expect(screen.getByText('Das Steigenlassen von  Himmelslaternen ist verboten.', { normalizer: (x) => x })).toBeTruthy()
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === fireBan.texts.de.description)).toBeTruthy()
    expect(screen.getByText('Kanton Basel-Landschaft (via Alertswiss)')).toBeTruthy()
    expect(screen.getByText(/Ganzer Kanton Basel-Landschaft/)).toBeTruthy()
    expect(screen.getByText('Originaltext der Quelle, unverändert.')).toBeTruthy()
  })

  it('labels a warning whose source went quiet with the time it is from', async () => {
    const later = NOW + 40 * 60_000 // fetched 17:25, limit 25 min
    render(<WeatherWarningChip layer={layer([fireBan])} now={later} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/Stand \d{2}:25 – Quelle zurzeit nicht erreichbar/)).toBeTruthy()
  })

  it('shows nothing without a warning, and an expired one is gone', () => {
    const { container } = render(<WeatherWarningChip layer={layer([{ ...fireBan, expires: '2026-10-08T17:00:00+00:00' }])} now={NOW} />)
    expect(container.innerHTML).toBe('')
  })
})

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

describe('WeatherFloats', () => {
  it('shows the warning with the radar off, and the radar pill only when it is on', () => {
    const props = { layer: layer([fireBan], radar), now: NOW, isPhone: false, radarStale: false, frameIndex: 1, playing: false, onPick: () => {}, onTogglePlaying: () => {} }
    const { rerender } = render(<WeatherFloats {...props} radarOn={false} />)
    expect(screen.getByRole('button', { name: /Wetterwarnungen/ })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Niederschlagsradar' })).toBeNull()
    rerender(<WeatherFloats {...props} radarOn />)
    expect(screen.getByRole('group', { name: 'Niederschlagsradar' })).toBeTruthy()
  })
})
