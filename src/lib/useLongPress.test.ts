// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

// The hook fires onLongPress only after a still hold past DELAY_MS (500). Any movement past
// MOVE_TOL_PX (8), a release, a pointercancel, or an explicit cancel() (the path the map's
// Marker.onDrag uses) aborts the press. Movement/release are tracked on window (capture), so
// the tests dispatch real PointerEvents on window to drive those branches.
const down = (x = 100, y = 100) =>
  ({ clientX: x, clientY: y }) as unknown as React.PointerEvent

function winEvent(type: string, x: number, y: number) {
  // jsdom has no PointerEvent constructor; the hook only reads clientX/clientY off the event
  const ev = new Event(type)
  ;(ev as unknown as { clientX: number; clientY: number }).clientX = x
  ;(ev as unknown as { clientX: number; clientY: number }).clientY = y
  act(() => void window.dispatchEvent(ev))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('useLongPress', () => {
  it('fires onLongPress after a still hold past the delay', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(fn).onPointerDown(down()))
    act(() => void vi.advanceTimersByTime(520))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire if released before the delay', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(fn).onPointerDown(down(100, 100)))
    act(() => void vi.advanceTimersByTime(200))
    winEvent('pointerup', 100, 100)
    act(() => void vi.advanceTimersByTime(520))
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancels when the finger moves past the tolerance (a drag, not a press)', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(fn).onPointerDown(down(100, 100)))
    winEvent('pointermove', 100, 120) // 20px > 8px tolerance
    act(() => void vi.advanceTimersByTime(520))
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps charging through a tiny jitter under the tolerance', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(fn).onPointerDown(down(100, 100)))
    winEvent('pointermove', 104, 103) // 5px < 8px tolerance
    act(() => void vi.advanceTimersByTime(520))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('explicit cancel() aborts the press (the Marker.onDrag path)', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(fn).onPointerDown(down()))
    act(() => void vi.advanceTimersByTime(200))
    act(() => result.current.cancel())
    act(() => void vi.advanceTimersByTime(520))
    expect(fn).not.toHaveBeenCalled()
  })

  it('a fresh press supersedes a previous still-pending one', () => {
    const first = vi.fn(); const second = vi.fn()
    const { result } = renderHook(() => useLongPress())
    act(() => result.current.press(first).onPointerDown(down(10, 10)))
    act(() => void vi.advanceTimersByTime(100))
    act(() => result.current.press(second).onPointerDown(down(200, 200)))
    act(() => void vi.advanceTimersByTime(520))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
