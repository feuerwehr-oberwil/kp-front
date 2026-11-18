// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LngLat } from '../types'
import { MAGNET_DWELL_MS, TRUPP_AIM_DWELL_MS } from '../lib/lineAttachments'
import { useTruppMarkerAim } from './useTruppMarkerAim'

// A Trupp marker carried past a symbol must not dock to it on the line magnet's 500 ms (round
// 18.11.2026, owner: «Longer. The attachment happens a bit too often.») – it takes the Trupp's own
// hold, and only a closed ring docks or joins on release.
describe('useTruppMarkerAim · the Trupp marker’s longer hold', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // a flat «map»: lng/lat are screen px
  const map = {
    project: ([x, y]: [number, number]) => ({ x, y }),
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
  } as unknown as MlMap
  const trupp = { id: 't', kind: 'team', layer: 'ops', coord: [0, 0], label: 'Bourquin', truppId: 'T1' } as Entity
  const host = { id: 'h', kind: 'symbol', layer: 'ops', coord: [400, 0], symbol: 'hydrant' } as Entity
  const hose = { id: 'l', kind: 'line', coords: [[0, 300], [400, 300]] } as unknown as Drawing

  function mount() {
    const onMarkerDragEnd = vi.fn()
    const { result } = renderHook(() => useTruppMarkerAim({
      mapInst: { current: map }, entities: [trupp, host], openHoseLines: [hose], nativeDrawingChrome: true,
      onMarkerMove: () => {}, onMarkerDragEnd,
    }))
    return { result, onMarkerDragEnd }
  }

  it('docks on a symbol only after the longer hold', () => {
    expect(TRUPP_AIM_DWELL_MS).toBeGreaterThanOrEqual(2 * MAGNET_DWELL_MS)
    const { result, onMarkerDragEnd } = mount()
    const near: LngLat = [380, 10]
    act(() => result.current.teamJoinMarkerMove('t', near))
    act(() => { vi.advanceTimersByTime(TRUPP_AIM_DWELL_MS - 1) })
    expect(result.current.dockAim).toMatchObject({ hostId: 'h', armed: false })
    act(() => result.current.teamJoinMarkerDragEnd('t', near))
    expect(onMarkerDragEnd).toHaveBeenLastCalledWith('t', near, null, null) // carried past: no dock

    act(() => result.current.teamJoinMarkerMove('t', near))
    act(() => { vi.advanceTimersByTime(TRUPP_AIM_DWELL_MS) })
    expect(result.current.dockAim?.armed).toBe(true)
    act(() => result.current.teamJoinMarkerDragEnd('t', near))
    expect(onMarkerDragEnd).toHaveBeenLastCalledWith('t', near, null, { hostId: 'h' })
  })

  it('joins a free hose end only after the same hold', () => {
    const { result, onMarkerDragEnd } = mount()
    const end: LngLat = [395, 300]
    act(() => result.current.teamJoinMarkerMove('t', end))
    act(() => { vi.advanceTimersByTime(TRUPP_AIM_DWELL_MS - 1) })
    expect(result.current.teamJoin).toMatchObject({ lineId: 'l', armed: false })
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.teamJoin?.armed).toBe(true)
    act(() => result.current.teamJoinMarkerDragEnd('t', end))
    expect(onMarkerDragEnd).toHaveBeenLastCalledWith('t', end, { lineId: 'l', endpoint: 'end' }, null)
  })
})
