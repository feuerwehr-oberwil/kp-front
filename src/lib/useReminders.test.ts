// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the alarm layer so the hook's tone/notification side effects don't touch Web Audio /
// Notification in the test env — we're testing the due-derivation timing, not the alert delivery.
vi.mock('./alarm', () => ({ notify: vi.fn(), startAlarm: vi.fn(), stopAlarm: vi.fn() }))

import { useReminders } from './useReminders'
import type { TimelineEvent } from '../types'

const copy = { dueTitle: 'fällig', doneLog: '{text}', snoozeLog: '{mins} {text}' }
const createdRow = (id: string, dueAt: string, at: string): TimelineEvent =>
  ({ id: `e-${id}`, t: '03:00', at, icon: 'clock', text: 'Keller prüfen', kind: 'reminder', reminder: { op: 'created', id, dueAt } }) as TimelineEvent

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('useReminders — overdue recompute on resume', () => {
  it('surfaces an overdue reminder immediately on visibilitychange, not only on the 10s tick', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 30_000).toISOString(), new Date(t0).toISOString())]

    const { result } = renderHook(() => useReminders(timeline, () => {}, copy, true))
    expect(result.current.dueCount).toBe(0) // not due yet

    // Jump the clock past due WITHOUT running timers — a backgrounded/locked device whose
    // 10s interval was frozen. Without a resume handler the in-app due state would stay stale.
    act(() => { vi.setSystemTime(t0 + 31_000) })
    expect(result.current.dueCount).toBe(0)

    // Resuming the app recomputes at once.
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.dueCount).toBe(1)
  })

  it('still detects a due reminder via the periodic 10s tick', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 5_000).toISOString(), new Date(t0).toISOString())]

    const { result } = renderHook(() => useReminders(timeline, () => {}, copy, true))
    expect(result.current.dueCount).toBe(0)

    act(() => { vi.advanceTimersByTime(11_000) }) // the 10s interval fires and recomputes
    expect(result.current.dueCount).toBe(1)
  })

  it('does not recompute (raise) while still hidden — only when visible again', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 30_000).toISOString(), new Date(t0).toISOString())]
    const { result } = renderHook(() => useReminders(timeline, () => {}, copy, true))

    // Simulate the tab being hidden, clock jumps past due, a visibilitychange fires while hidden.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => { vi.setSystemTime(t0 + 31_000); document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.dueCount).toBe(0) // still hidden → no in-app recompute

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.dueCount).toBe(1) // visible again → recompute
  })
})
