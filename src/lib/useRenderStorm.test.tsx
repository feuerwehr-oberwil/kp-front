// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./reportError', () => ({ reportClientError: vi.fn() }))
vi.mock('./trouble', () => ({ recordTrouble: vi.fn() }))

import {
  __resetRenderStormsForTests, changedSummary, createStormDetector,
  STORM_COMMITS, STORM_QUIET_MS, STORM_WINDOW_MS, useRenderStorm,
} from './useRenderStorm'
import { reportClientError } from './reportError'
import { recordTrouble } from './trouble'

beforeEach(() => { vi.useFakeTimers(); __resetRenderStormsForTests() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

const reported = (i = 0): string => (vi.mocked(reportClientError).mock.calls[i][0] as Error).message

describe('createStormDetector', () => {
  it('trips exactly once, on the commit that fills the window', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    for (let i = 1; i < STORM_COMMITS; i++) expect(d.commit()).toBe(false)
    expect(d.commit()).toBe(true) // the 200th
    expect(d.commit()).toBe(false) // never again while this storm lasts
  })

  it('an honest trickle never accumulates — the window restarts after quiet', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    for (let i = 0; i < STORM_COMMITS - 10; i++) expect(d.commit()).toBe(false)
    vi.advanceTimersByTime(STORM_WINDOW_MS + 1)
    for (let i = 0; i < STORM_COMMITS - 10; i++) expect(d.commit()).toBe(false)
  })

  it('stays quiet while the storm goes on, however long', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    let trips = 0
    // ten minutes of a storm, 150 commits every second = 300 per window
    for (let s = 0; s < 600; s++) {
      for (let k = 0; k < 150; k++) if (d.commit()) trips++
      vi.advanceTimersByTime(1000)
    }
    expect(trips).toBe(1)
  })

  it('re-arms after a quiet period, so the NEXT storm in the same page load trips again', () => {
    vi.setSystemTime(1_000_000)
    const d = createStormDetector()
    const storm = () => { let t = 0; for (let i = 0; i < STORM_COMMITS * 2; i++) if (d.commit()) t++; return t }
    expect(storm()).toBe(1)
    // a short pause is not the end of it
    vi.advanceTimersByTime(STORM_QUIET_MS / 2)
    expect(storm()).toBe(0)
    // a real quiet period (a few honest commits in it) is
    vi.advanceTimersByTime(STORM_QUIET_MS / 2)
    for (let i = 0; i < 5; i++) { d.commit(); vi.advanceTimersByTime(STORM_QUIET_MS / 5) }
    expect(storm()).toBe(1)
  })
})

describe('changedSummary', () => {
  it('names the busiest values first and skips the still ones', () => {
    expect(changedSummary({ layers: 2, objects: 198, mode: 0 })).toBe('objects×198, layers×2')
    expect(changedSummary({ objects: 0 })).toBe('none of the watched values')
  })
})

describe('useRenderStorm', () => {
  it('reports a storm with its count and records the trouble, past 200 commits in 2 s', () => {
    vi.setSystemTime(1_000_000)
    const { rerender } = renderHook(() => useRenderStorm('probe'))
    for (let i = 0; i < STORM_COMMITS - 2; i++) rerender()
    expect(reportClientError).not.toHaveBeenCalled()
    for (let i = 0; i < 400; i++) rerender()
    expect(reportClientError).toHaveBeenCalledTimes(1)
    expect(reported()).toMatch(/^render storm: probe · 200 commits in \d+ ms$/)
    expect(vi.mocked(reportClientError).mock.calls[0][1]).toEqual({ kind: 'render-storm' })
    expect(recordTrouble).toHaveBeenCalledWith('renderStorm')
    // a remount of the same component does not report the same storm a second time
    const again = renderHook(() => useRenderStorm('probe'))
    for (let i = 0; i < 400; i++) again.rerender()
    expect(reportClientError).toHaveBeenCalledTimes(1)
  })

  it('names the open tab and the watched value that kept changing', () => {
    vi.setSystemTime(1_000_000)
    let objects: object = {}
    const layers = ['base']
    const { rerender } = renderHook(() => useRenderStorm('IncidentWorkspace', { context: 'tab=map', watch: { objects, layers } }))
    for (let i = 0; i < STORM_COMMITS; i++) { objects = {}; rerender() }
    expect(reportClientError).toHaveBeenCalledTimes(1)
    expect(reported()).toMatch(/^render storm: IncidentWorkspace · tab=map · 200 commits in \d+ ms · changed: objects×\d+$/)
  })

  it('reports a later storm again once the first has been over for the quiet period', () => {
    vi.setSystemTime(1_000_000)
    const { rerender } = renderHook(() => useRenderStorm('probe'))
    for (let i = 0; i < 400; i++) rerender()
    expect(reportClientError).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(STORM_QUIET_MS + 1)
    rerender() // an honest commit after the calm
    for (let i = 0; i < 400; i++) rerender()
    expect(reportClientError).toHaveBeenCalledTimes(2)
  })
})
