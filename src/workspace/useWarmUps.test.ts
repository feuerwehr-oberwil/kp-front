// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prewarmPlans } from '../lib/pdfRaster'
import { loadReportPreflight, loadWhiteboard } from './lazySurfaces'
import { useWarmUps } from './useWarmUps'

vi.mock('./lazySurfaces', () => ({ loadWhiteboard: vi.fn(), loadReportPreflight: vi.fn() }))
vi.mock('../lib/pdfRaster', () => ({ prewarmPlans: vi.fn() }))

const plans = [{ id: 'p1', imageUrl: '/plans/p1.png' }]
const started = () => vi.mocked(loadWhiteboard).mock.calls.length + vi.mocked(loadReportPreflight).mock.calls.length
  + vi.mocked(prewarmPlans).mock.calls.length

// WebKit's shape: no requestIdleCallback, so whenIdle is a plain 600 ms timer
let ric: unknown
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  ric = (window as { requestIdleCallback?: unknown }).requestIdleCallback
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback
})
afterEach(() => {
  vi.useRealTimers()
  if (ric) (window as { requestIdleCallback?: unknown }).requestIdleCallback = ric
})

describe('useWarmUps — speculative warm-ups wait for the opening cover', () => {
  it('starts nothing under the cover, and everything once it is off', () => {
    const { rerender } = renderHook(({ coverOff }) => useWarmUps({ coverOff, asLink: false, resolvedPlanDocs: plans, activePlanId: 'p1' }),
      { initialProps: { coverOff: false } })
    vi.advanceTimersByTime(5_000)
    expect(started()).toBe(0)
    rerender({ coverOff: true })
    vi.advanceTimersByTime(600)
    expect(loadWhiteboard).toHaveBeenCalledTimes(1)
    expect(loadReportPreflight).toHaveBeenCalledTimes(1)
    expect(prewarmPlans).toHaveBeenCalledTimes(1)
  })

  it('warms up a session that opened without a cover', () => {
    renderHook(() => useWarmUps({ coverOff: true, asLink: false, resolvedPlanDocs: plans, activePlanId: 'p1' }))
    vi.advanceTimersByTime(600)
    expect(started()).toBe(3)
  })

  it('never warms up an Atemschutz-Link phone', () => {
    renderHook(() => useWarmUps({ coverOff: true, asLink: true, resolvedPlanDocs: plans, activePlanId: 'p1' }))
    vi.advanceTimersByTime(5_000)
    expect(started()).toBe(0)
  })
})
