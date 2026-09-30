// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useExpire } from './useExpire'

// V2 (staging 25.09.2026): the «abgeschlossen / wieder geöffnet» row goes away by itself after
// two minutes — unless it carries entries still to be saved.

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useExpire', () => {
  it('expires a notice after its time, once', () => {
    const onExpire = vi.fn()
    renderHook(() => useExpire(1000, 120_000, false, onExpire))
    vi.advanceTimersByTime(119_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledWith(1000)
    vi.advanceTimersByTime(500_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('holds while the notice carries something owed, and a new notice starts a new clock', () => {
    const onExpire = vi.fn()
    const h = renderHook(({ key, hold }) => useExpire(key, 120_000, hold, onExpire), { initialProps: { key: 1 as number | null, hold: true } })
    vi.advanceTimersByTime(300_000)
    expect(onExpire).not.toHaveBeenCalled()
    h.rerender({ key: 2, hold: false })
    vi.advanceTimersByTime(60_000)
    h.rerender({ key: 3, hold: false }) // a newer change: its own two minutes
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(onExpire).toHaveBeenCalledWith(3)
  })
})
