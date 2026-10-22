// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../lib/useWeatherLayer', () => ({
  useWeatherLayer: () => ({ data: { enabled: true, generated_at: null, radar: null }, now: 0 }),
}))

import { loadPrefs, savePrefs } from '../lib/prefs'
import { einsatzRadarStore, useKarteWeather } from './useKarteWeather'

// The Ebenen quick-taps reach the radar (10.10.2026, owner: «Standard» must not show the radar):
// IncidentWorkspace · resetLayers / setAllLayers(false) call `setRadar(false)`.

beforeEach(() => savePrefs({}))

describe('useKarteWeather · setRadar', () => {
  it('switches the radar off and remembers it on the device, and its own toggle still works', () => {
    savePrefs({ weatherRadarIn: 'e1' })
    const { result } = renderHook(() => useKarteWeather(true, einsatzRadarStore('e1')))
    expect(result.current.radarOn).toBe(true)
    act(() => result.current.setRadar(false))
    expect(result.current.radarOn).toBe(false)
    expect(loadPrefs().weatherRadarIn).toBeUndefined()
    act(() => result.current.toggleRadar())
    expect(result.current.radarOn).toBe(true)
    expect(loadPrefs().weatherRadarIn).toBe('e1')
  })

  it('leaves an already-off radar (and its pref) alone', () => {
    const { result } = renderHook(() => useKarteWeather(true, einsatzRadarStore('e1')))
    act(() => result.current.setRadar(false))
    expect(result.current.radarOn).toBe(false)
    expect(loadPrefs()).toEqual({})
  })
})

// owner, 22.10.2026: a radar switched on in one Einsatz opened every later one with its playback bar
describe('einsatzRadarStore', () => {
  it('keeps the radar for its own Einsatz only; the transparency is the device\'s', () => {
    const first = renderHook(() => useKarteWeather(true, einsatzRadarStore('e1')))
    act(() => { first.result.current.toggleRadar(); first.result.current.setRadarOpacity(40) })
    expect(renderHook(() => useKarteWeather(true, einsatzRadarStore('e1'))).result.current.radarOn).toBe(true)
    const next = renderHook(() => useKarteWeather(true, einsatzRadarStore('e2'))).result.current
    expect(next.radarOn).toBe(false)
    expect(next.radarOpacity).toBe(40)
  })
})
