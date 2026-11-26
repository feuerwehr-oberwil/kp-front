// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEinsatzuhr } from './einsatzuhr'
import { noteServerTime, resetServerClock } from './serverClock'

// an Einsatz opened at :37 past the minute — its clock flips at :37, never at :00
const START = '2026-11-26T14:02:37.000Z'
const S = Date.parse(START)
const min = (m: number, s = 0) => S + m * 60_000 + s * 1000

beforeEach(() => { vi.useFakeTimers(); resetServerClock() })
afterEach(() => { vi.useRealTimers(); resetServerClock() })

describe('useEinsatzuhr', () => {
  it('flips on the minute of the ELAPSED time, and renders once a minute for it', () => {
    vi.setSystemTime(min(5, 59))
    let renders = 0
    const { result } = renderHook(() => { renders++; return useEinsatzuhr(START) })
    expect(result.current).toBe('0:05')
    act(() => { vi.advanceTimersByTime(999) })
    expect(result.current).toBe('0:05')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('0:06')
    const before = renders
    // the wall clock's minute (14:09:00) passes in here: nothing happens on it
    for (let s = 0; s < 60; s++) act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBe('0:07')
    expect(renders - before).toBe(1)
  })

  it('a page back from sleep or from hidden shows the right minute at once', () => {
    vi.setSystemTime(min(10, 5))
    const { result } = renderHook(() => useEinsatzuhr(START))
    expect(result.current).toBe('0:10')
    // asleep: the clock moved, no timer ran
    vi.setSystemTime(min(25, 0))
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current).toBe('0:25')
  })

  it('a server-clock correction reaches the clock within ten seconds, not at the next minute', () => {
    vi.setSystemTime(min(10, 20))
    const { result } = renderHook(() => useEinsatzuhr(START))
    expect(result.current).toBe('0:10')
    // the deployment is 45 s ahead of this device: 10:20 elapsed is really 11:05
    act(() => { noteServerTime(new Date(Date.now() + 45_000).toISOString()) })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(result.current).toBe('0:11')
  })

  it('an Einsatz that is over shows its frozen duration and runs no timer', () => {
    vi.setSystemTime(min(600))
    const { result } = renderHook(() => useEinsatzuhr(START, new Date(min(40, 30)).toISOString()))
    expect(result.current).toBe('0:40')
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(result.current).toBe('0:40')
  })

  it('a start that does not parse prints nothing, and an idle reader runs no timer', () => {
    vi.setSystemTime(min(3))
    expect(renderHook(() => useEinsatzuhr('not a date')).result.current).toBe('')
    expect(renderHook(() => useEinsatzuhr(START, null, true)).result.current).toBe('0:03')
    expect(vi.getTimerCount()).toBe(0)
  })
})
