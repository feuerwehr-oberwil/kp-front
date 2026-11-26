// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiveraAlarm } from './incidents'

const { getDiveraPool, markAlarmPoll } = vi.hoisted(() => ({ getDiveraPool: vi.fn(), markAlarmPoll: vi.fn() }))
vi.mock('./incidents', () => ({ getDiveraPool }))
vi.mock('./alarmPollHealth', () => ({ markAlarmPoll }))
const { useDiveraWatch } = await import('./useDiveraWatch')

const alarm = { divera_id: 36591264, title: 'Brandmeldeanlage', address: 'Bachweg 1', received_at: '2026-11-26T10:00:00Z' } as DiveraAlarm

beforeEach(() => { getDiveraPool.mockReset(); markAlarmPoll.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('useDiveraWatch', () => {
  it('a round that answers after sign-out does not touch the readiness sign', async () => {
    let answer: (pool: never[]) => void = () => {}
    getDiveraPool.mockReturnValueOnce(new Promise((r) => { answer = r }))
    const { unmount } = renderHook(() => useDiveraWatch(true))
    expect(getDiveraPool).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => { answer([]) })
    expect(markAlarmPoll).not.toHaveBeenCalled()
  })

  // perf sweep 26.11.2026: every round handed App a NEW (usually empty) array, and App with the
  // whole workspace rendered every 30 s for nothing
  it('an unchanged pool costs no render, and every round still reports to the readiness sign', async () => {
    vi.useFakeTimers()
    getDiveraPool.mockImplementation(async () => [{ ...alarm }])
    let renders = 0
    const { result } = renderHook(() => { renders++; return useDiveraWatch(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(markAlarmPoll).toHaveBeenCalledTimes(1)
    expect(result.current.alarms).toEqual([alarm])
    const before = renders
    const first = result.current.alarms
    // one act per round: a single act around all four would batch them into one render
    for (let round = 0; round < 4; round++) await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(markAlarmPoll).toHaveBeenCalledTimes(5)
    expect(renders - before).toBe(0)
    expect(result.current.alarms).toBe(first)
  })

  it('a new alarm in the pool reaches the UI in the same round', async () => {
    vi.useFakeTimers()
    getDiveraPool.mockImplementation(async () => [])
    const { result } = renderHook(() => useDiveraWatch(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.alarms).toEqual([])
    getDiveraPool.mockImplementation(async () => [{ ...alarm }])
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.alarms).toEqual([alarm])
  })
})
