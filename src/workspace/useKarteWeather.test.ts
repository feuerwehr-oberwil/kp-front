// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../lib/useWeatherLayer', () => ({
  useWeatherLayer: () => ({ data: { enabled: true, generated_at: null, radar: null }, now: 0 }),
}))

import { loadPrefs, savePrefs } from '../lib/prefs'
import { useKarteWeather } from './useKarteWeather'

// The Ebenen quick-taps reach the radar (10.10.2026, owner: «Standard» must not show the radar):
// IncidentWorkspace · resetLayers / setAllLayers(false) call `setRadar(false)`.

beforeEach(() => savePrefs({}))

describe('useKarteWeather · setRadar', () => {
  it('switches the radar off and remembers it on the device, and its own toggle still works', () => {
    savePrefs({ weatherRadar: true })
    const { result } = renderHook(() => useKarteWeather(true))
    expect(result.current.radarOn).toBe(true)
    act(() => result.current.setRadar(false))
    expect(result.current.radarOn).toBe(false)
    expect(loadPrefs().weatherRadar).toBe(false)
    act(() => result.current.toggleRadar())
    expect(result.current.radarOn).toBe(true)
    expect(loadPrefs().weatherRadar).toBe(true)
  })

  it('leaves an already-off radar (and its pref) alone', () => {
    const { result } = renderHook(() => useKarteWeather(true))
    act(() => result.current.setRadar(false))
    expect(result.current.radarOn).toBe(false)
    expect(loadPrefs().weatherRadar).toBeUndefined()
  })
})
