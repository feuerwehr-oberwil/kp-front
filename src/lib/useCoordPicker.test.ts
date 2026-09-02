// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCoordPicker } from './useCoordPicker'
import type { LngLat } from '../types'

// The one rule this hook has to keep since 02.09.: a locked point ENDS on the next press of the
// button, it does not re-arm the crosshair. `set → aim` was the cycle that swallowed the map tap
// after a pick — the operator had read the coordinate, tapped the button to be done, and the map
// was silently aiming again.

const CENTER: LngLat = [7.55, 47.51]

describe('useCoordPicker', () => {
  it('cycles off → aim → off from the button', () => {
    const { result } = renderHook(() => useCoordPicker(false, CENTER))
    expect(result.current.mode).toBe('off')
    expect(result.current.readout).toBeNull()
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('aim')
    // aiming with no cursor yet reads the map centre
    expect(result.current.readout).toEqual(CENTER)
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('off')
  })

  it('ends a locked point on the button instead of aiming again', () => {
    const { result } = renderHook(() => useCoordPicker(false, CENTER))
    act(() => result.current.cycle())
    act(() => { result.current.setPicked([7.6, 47.5]); result.current.setMode('set') })
    expect(result.current.readout).toEqual([7.6, 47.5])
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('off')
    expect(result.current.readout).toBeNull()
    expect(result.current.picked).toBeNull()
  })

  it('drops straight into aim when the intake form asks for a map location', () => {
    const { result, rerender } = renderHook(({ pick }) => useCoordPicker(pick, CENTER), { initialProps: { pick: false } })
    rerender({ pick: true })
    expect(result.current.mode).toBe('aim')
  })
})
