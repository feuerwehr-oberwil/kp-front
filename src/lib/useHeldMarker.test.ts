// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useHeldMarker } from './useHeldMarker'

// a render re-seats the Marker on its props (react-map-gl); the held one goes back under the finger
describe('useHeldMarker', () => {
  it('moves the held Marker, re-seats it after every render until the release, then lets go', () => {
    const marker = { setLngLat: vi.fn() }
    const { result, rerender } = renderHook(() => useHeldMarker())
    act(() => { result.current.refOf('s1')(marker) })
    act(() => { result.current.hold('s1', [7.6, 47.5]) })
    expect(marker.setLngLat).toHaveBeenLastCalledWith([7.6, 47.5])
    marker.setLngLat.mockClear()
    rerender()
    expect(marker.setLngLat).toHaveBeenCalledExactlyOnceWith([7.6, 47.5])
    act(() => { result.current.release() })
    marker.setLngLat.mockClear()
    rerender()
    expect(marker.setLngLat).not.toHaveBeenCalled()
  })

  it('holds nothing for a marker that is gone', () => {
    const marker = { setLngLat: vi.fn() }
    const { result } = renderHook(() => useHeldMarker())
    act(() => { result.current.refOf('s1')(marker) })
    act(() => { result.current.refOf('s1')(null) })
    act(() => { result.current.hold('s1', [1, 2]) })
    expect(marker.setLngLat).not.toHaveBeenCalled()
  })
})
