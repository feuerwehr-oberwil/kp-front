// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useArrivalTone } from './useArrivalTone'

const { arrivalTone } = vi.hoisted(() => ({ arrivalTone: vi.fn() }))
vi.mock('./alarm', () => ({ arrivalTone }))

describe('useArrivalTone', () => {
  beforeEach(() => arrivalTone.mockReset())

  it('rings once per new alarm on the Karte, never again for the same row', () => {
    const { rerender } = renderHook(({ k, ring }) => useArrivalTone(k, ring), { initialProps: { k: null as string | null, ring: true } })
    expect(arrivalTone).not.toHaveBeenCalled()
    rerender({ k: 'alarm:7', ring: true })
    expect(arrivalTone).toHaveBeenCalledTimes(1)
    rerender({ k: 'alarm:7', ring: true })
    rerender({ k: null, ring: true })
    rerender({ k: 'alarm:7', ring: true }) // ✕-ed and back: the same alarm
    expect(arrivalTone).toHaveBeenCalledTimes(1)
    rerender({ k: 'incident:a', ring: true })
    expect(arrivalTone).toHaveBeenCalledTimes(2)
  })

  it('an alarm that arrived inside an Einsatz stays quiet when the device goes back to the Karte', () => {
    const { rerender } = renderHook(({ k, ring }) => useArrivalTone(k, ring), { initialProps: { k: 'alarm:9' as string | null, ring: false } })
    rerender({ k: 'alarm:9', ring: true })
    expect(arrivalTone).not.toHaveBeenCalled()
  })
})
