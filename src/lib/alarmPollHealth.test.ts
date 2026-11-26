// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { markAlarmPoll, pollReadiness, READY_MAX_AGE_MS, useAlarmPollHealth } from './alarmPollHealth'

describe('pollReadiness', () => {
  it('says nothing before any round has answered', () => {
    expect(pollReadiness({ okAt: null, lastOk: null }, 1_000)).toBeNull()
  })

  it('is ready while the last good answer is younger than 60 s', () => {
    expect(pollReadiness({ okAt: 1_000, lastOk: true }, 1_000 + READY_MAX_AGE_MS - 1)).toBe('ready')
    expect(pollReadiness({ okAt: 1_000, lastOk: true }, 1_000 + READY_MAX_AGE_MS)).toBe('down')
  })

  it('a failed round after the good one is down at once; a good one after it is ready again', () => {
    expect(pollReadiness({ okAt: null, lastOk: false }, 600)).toBe('down')
    expect(pollReadiness({ okAt: 1_000, lastOk: false }, 2_100)).toBe('down')
    expect(pollReadiness({ okAt: 3_000, lastOk: true }, 3_100)).toBe('ready')
  })

  it('two rounds that end in the same millisecond: the later one decides', () => {
    const { result } = renderHook(() => useAlarmPollHealth())
    const t = Date.now()
    act(() => { markAlarmPoll(true, t); markAlarmPoll(false, t) })
    expect(result.current.state).toBe('down')
    act(() => { markAlarmPoll(false, t + 1); markAlarmPoll(true, t + 1) })
    expect(result.current.state).toBe('ready')
  })
})
