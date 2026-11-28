// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useLocalDay } from './localDay'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 27, 23, 58)) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useLocalDay', () => {
  it('renders its caller again at midnight, and not before', () => {
    let renders = 0
    const { result } = renderHook(() => { renders++; return useLocalDay() })
    const first = result.current
    renders = 0
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(renders).toBe(0)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(renders).toBe(1)
    expect(result.current).not.toBe(first)
    expect(result.current).toBe(new Date(2026, 10, 28).toDateString())
  })

  it('goes on to the midnight after', () => {
    let renders = 0
    renderHook(() => { renders++; return useLocalDay() })
    act(() => { vi.advanceTimersByTime(2 * 60_000) })
    renders = 0
    act(() => { vi.advanceTimersByTime(24 * 3_600_000) })
    expect(renders).toBe(1)
  })

  it('holds no timer while nobody listens, or while it is off', () => {
    const { unmount } = renderHook(() => useLocalDay())
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    renderHook(() => useLocalDay(false))
    expect(vi.getTimerCount()).toBe(0)
  })
})
