// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useFreshPoint } from './useFreshPoint'
import { TAP_GAP_MS } from './tapDragZoom'

afterEach(() => { vi.useRealTimers() })

// Messen (sweep 27.10.2026 #8): the point a tap just placed lets the tap pair's second press
// through to the zoom for one tap gap, then is an ordinary handle again
describe('useFreshPoint', () => {
  it('marks the point just added, for one tap gap', () => {
    vi.useFakeTimers()
    const h = renderHook(({ n }) => useFreshPoint(n), { initialProps: { n: 1 } })
    expect(h.result.current).toBeNull() // what was there on mount is not new
    h.rerender({ n: 2 })
    expect(h.result.current).toBe(1)
    act(() => { vi.advanceTimersByTime(TAP_GAP_MS - 1) })
    expect(h.result.current).toBe(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(h.result.current).toBeNull()
  })

  it('a second point restarts the window on the newest one', () => {
    vi.useFakeTimers()
    const h = renderHook(({ n }) => useFreshPoint(n), { initialProps: { n: 0 } })
    h.rerender({ n: 1 })
    act(() => { vi.advanceTimersByTime(TAP_GAP_MS - 100) })
    h.rerender({ n: 2 })
    act(() => { vi.advanceTimersByTime(200) })
    expect(h.result.current).toBe(1)
  })

  it('a deleted point or a reset is nothing new', () => {
    const h = renderHook(({ n }) => useFreshPoint(n), { initialProps: { n: 3 } })
    h.rerender({ n: 4 })
    h.rerender({ n: 3 })
    expect(h.result.current).toBeNull()
    h.rerender({ n: 0 })
    expect(h.result.current).toBeNull()
  })
})
