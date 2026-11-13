// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLate } from './useLate'

describe('useLate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('turns on only after the state held for the grace, and off at once', () => {
    const { result, rerender } = renderHook(({ on }) => useLate(on, 1000), { initialProps: { on: true } })
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(999) })
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe(true)
    rerender({ on: false })
    expect(result.current).toBe(false)
    // a new spell starts a new clock
    rerender({ on: true })
    expect(result.current).toBe(false)
  })
})
