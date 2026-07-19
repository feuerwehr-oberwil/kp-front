// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AtemschutzAlarmHost } from './useAtemschutzAlarm'
import type { AtemschutzAlarmState } from './atemschutz'
import type { Trupp } from '../types'

// The host exists so the 1 Hz contact-clock tick re-renders only itself — App must hear
// about the alarm ONLY on real transitions (tier / Trupp), never on plain clock ticks
// (a per-second whole-app re-render was a measured phone battery drain).

const T0 = Date.parse('2026-06-21T10:00:00Z')
const trupp = (over: Partial<Trupp> = {}): Trupp => ({
  id: 't1',
  name: 'Müller',
  entryPressureBar: 300,
  entryTime: new Date(T0).toISOString(),
  lastContactTime: new Date(T0).toISOString(),
  status: 'aktiv',
  ...over,
})

const host = (trupps: Trupp[], onState: (s: AtemschutzAlarmState) => void) => (
  <AtemschutzAlarmHost trupps={trupps} muted active logAlarm={() => {}}
    intervalMin={5} graceSec={60} onState={onState} />
)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('AtemschutzAlarmHost', () => {
  it('reports transitions only — clock ticks alone never reach onState', () => {
    const onState = vi.fn()
    render(host([trupp()], onState))
    expect(onState).not.toHaveBeenCalled() // silent initial state === App's initial state

    // 3 minutes of ticking well below the 5-min interval: still silent, still zero calls
    act(() => { vi.advanceTimersByTime(3 * 60_000) })
    expect(onState).not.toHaveBeenCalled()

    // crossing the interval mark (5:00) → ONE transition to tier 1
    act(() => { vi.advanceTimersByTime(2 * 60_000 + 1000) })
    expect(onState).toHaveBeenCalledTimes(1)
    const s: AtemschutzAlarmState = onState.mock.calls[0][0]
    expect(s.peak).toBe(1)
    expect(s.urgent).toMatchObject({ id: 't1', severity: 1, contactAt: T0 })

    // 30 more seconds inside tier 1: the clock advances, but no new report
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(onState).toHaveBeenCalledTimes(1)
  })

  it('reports the tier-2 crossing as a second transition', () => {
    const onState = vi.fn()
    render(host([trupp()], onState))
    // straight past interval (5 min) + Nachfrist (60 s): tier 1 then tier 2, two reports
    act(() => { vi.advanceTimersByTime(5 * 60_000 + 1000) })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(onState).toHaveBeenCalledTimes(2)
    expect(onState.mock.lastCall![0].peak).toBe(2)
  })
})
