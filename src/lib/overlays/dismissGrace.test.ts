// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDismissGrace } from './dismissGrace'

afterEach(() => vi.useRealTimers())

describe('useDismissGrace', () => {
  it('vetoes the outside press that arrives with the opening gesture (iPadOS echo)', () => {
    const { result } = renderHook(() => useDismissGrace(true))
    // the synthetic mousedown lands a few ms after the pointerup that opened the surface
    expect(result.current('outside-press')).toBe(true)
  })

  it('lets a later outside press through', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDismissGrace(true))
    vi.advanceTimersByTime(1000)
    expect(result.current('outside-press')).toBe(false)
  })

  it('never vetoes Escape, the close button, or any other reason', () => {
    const { result } = renderHook(() => useDismissGrace(true))
    for (const reason of ['escape-key', 'close-press', 'trigger-press', undefined]) {
      expect(result.current(reason)).toBe(false)
    }
  })

  it('restarts the grace window on each open, not just the first', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ open }) => useDismissGrace(open), { initialProps: { open: true } })
    vi.advanceTimersByTime(1000)
    expect(result.current('outside-press')).toBe(false)
    rerender({ open: false })
    rerender({ open: true })
    expect(result.current('outside-press')).toBe(true)
  })
})
