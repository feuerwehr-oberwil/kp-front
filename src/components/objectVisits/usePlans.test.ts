// @vitest-environment jsdom
// The plan reader's close: a double tap on its ‹ must not leave the visit (reported on v0.12.0).

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePlanReader } from './usePlans'

afterEach(() => { vi.useRealTimers() })

describe('usePlanReader', () => {
  it('settles briefly after closing, so the visit ‹ underneath ignores the second tap', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePlanReader())
    expect(result.current.settling()).toBe(false)
    act(() => result.current.open(1))
    act(() => { result.current.close(); result.current.close() })
    expect(result.current.index).toBeNull()
    expect(result.current.settling()).toBe(true)
    vi.advanceTimersByTime(600)
    expect(result.current.settling()).toBe(false)
  })
})
