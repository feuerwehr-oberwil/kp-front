// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRadarPlayback } from './useRadarPlayback'
import type { WeatherRadar } from './weatherLayer'

// Ported from kp-rueck (R5, weather-radar-controls.test.tsx).

function radar(keys: string[]): WeatherRadar {
  return {
    frames: keys.map((key) => ({ key, time: `2026-10-08T${key.slice(8, 10)}:${key.slice(10)}:00Z` })),
    coordinates: null,
    data_time: null,
    stale: false,
    stale_after_seconds: 900,
    status: { last_attempt_at: null, last_success_at: null, last_error: null, last_error_at: null },
    legend: [],
    attribution: 'MeteoSchweiz',
    source_url: '',
  }
}

describe('useRadarPlayback', () => {
  it('follows the newest frame until somebody scrubs', () => {
    const { result, rerender } = renderHook(({ r }) => useRadarPlayback(r), {
      initialProps: { r: radar(['202610081700', '202610081705']) },
    })
    expect(result.current.frameIndex).toBe(1)
    rerender({ r: radar(['202610081700', '202610081705', '202610081710']) })
    expect(result.current.frameIndex).toBe(2)
  })

  it('stays on the picked FRAME when the hour shifts by one', () => {
    const { result, rerender } = renderHook(({ r }) => useRadarPlayback(r), {
      initialProps: { r: radar(['202610081700', '202610081705', '202610081710']) },
    })
    act(() => result.current.pick(1)) // 17:05
    rerender({ r: radar(['202610081705', '202610081710', '202610081715']) })
    expect(result.current.frameIndex).toBe(0) // still 17:05, now first in the list
  })

  it('falls back to now when the picked frame aged out, and on reset', () => {
    const { result, rerender } = renderHook(({ r }) => useRadarPlayback(r), {
      initialProps: { r: radar(['202610081700', '202610081705', '202610081710']) },
    })
    act(() => result.current.pick(0)) // 17:00
    rerender({ r: radar(['202610081705', '202610081710', '202610081715']) })
    expect(result.current.frameIndex).toBe(2)
    act(() => result.current.pick(1))
    act(() => result.current.reset())
    expect(result.current.frameIndex).toBe(2)
    expect(result.current.playing).toBe(false)
  })
})
