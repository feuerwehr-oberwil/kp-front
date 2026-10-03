// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOT_COVER_FADE_MS, BOOT_COVER_MAX_MS, useBootCover } from './bootCover'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useBootCover — an Einsatz opens behind the snail, never stays behind it', () => {
  it('holds while the workspace assembles, then fades out once and reports done', () => {
    const onDone = vi.fn()
    const { result, rerender } = renderHook(({ ready }) => useBootCover(true, ready, onDone), { initialProps: { ready: false } })
    expect(result.current).toBe('on')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(result.current).toBe('on')
    rerender({ ready: true })
    expect(result.current).toBe('leaving')
    act(() => { vi.advanceTimersByTime(BOOT_COVER_FADE_MS) })
    expect(result.current).toBe('off')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('lifts at the cap when something never arrives (offline tiles, a weather backend down)', () => {
    const { result } = renderHook(() => useBootCover(true, false))
    act(() => { vi.advanceTimersByTime(BOOT_COVER_MAX_MS) })
    expect(result.current).toBe('leaving')
    act(() => { vi.advanceTimersByTime(BOOT_COVER_FADE_MS) })
    expect(result.current).toBe('off')
  })

  it('finishes its fade even when a condition drops back meanwhile', () => {
    const { result, rerender } = renderHook(({ ready }) => useBootCover(true, ready), { initialProps: { ready: true } })
    expect(result.current).toBe('leaving')
    rerender({ ready: false })
    act(() => { vi.advanceTimersByTime(BOOT_COVER_FADE_MS) })
    expect(result.current).toBe('off')
  })

  it('never shows on a mount that was not an opening (background remount)', () => {
    const onDone = vi.fn()
    const { result, rerender } = renderHook(({ ready }) => useBootCover(false, ready, onDone), { initialProps: { ready: false } })
    expect(result.current).toBe('off')
    rerender({ ready: true })
    act(() => { vi.advanceTimersByTime(BOOT_COVER_MAX_MS) })
    expect(result.current).toBe('off')
    expect(onDone).not.toHaveBeenCalled()
  })
})
