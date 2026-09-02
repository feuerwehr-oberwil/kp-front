// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./reportError', () => ({ reportClientError: vi.fn() }))
vi.mock('./trouble', () => ({ recordTrouble: vi.fn() }))

import { createStormDetector, STORM_COMMITS, STORM_WINDOW_MS, useRenderStorm } from './useRenderStorm'
import { reportClientError } from './reportError'
import { recordTrouble } from './trouble'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('createStormDetector', () => {
  it('trips exactly once, on the commit that fills the window', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    for (let i = 1; i < STORM_COMMITS; i++) expect(d.commit()).toBe(false)
    expect(d.commit()).toBe(true) // the 200th
    expect(d.commit()).toBe(false) // never again for this detector
  })

  it('an honest trickle never accumulates — the window restarts after quiet', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    for (let i = 0; i < STORM_COMMITS - 10; i++) expect(d.commit()).toBe(false)
    vi.advanceTimersByTime(STORM_WINDOW_MS + 1)
    for (let i = 0; i < STORM_COMMITS - 10; i++) expect(d.commit()).toBe(false)
  })
})

describe('useRenderStorm', () => {
  it('reports once per session and records the trouble, past 200 commits in 2 s', () => {
    vi.setSystemTime(1_000_000)
    const { rerender } = renderHook(() => useRenderStorm('probe'))
    for (let i = 0; i < STORM_COMMITS - 2; i++) rerender()
    expect(reportClientError).not.toHaveBeenCalled()
    for (let i = 0; i < 400; i++) rerender()
    expect(reportClientError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reportClientError).mock.calls[0][0]).toEqual(new Error('render storm: probe'))
    expect(recordTrouble).toHaveBeenCalledWith('renderStorm')
    // a remount of the same component does not report a second time this session
    const again = renderHook(() => useRenderStorm('probe'))
    for (let i = 0; i < 400; i++) again.rerender()
    expect(reportClientError).toHaveBeenCalledTimes(1)
  })
})
