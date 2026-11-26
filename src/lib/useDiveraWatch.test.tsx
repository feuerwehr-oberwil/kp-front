// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { getDiveraPool, markAlarmPoll } = vi.hoisted(() => ({ getDiveraPool: vi.fn(), markAlarmPoll: vi.fn() }))
vi.mock('./incidents', () => ({ getDiveraPool }))
vi.mock('./alarmPollHealth', () => ({ markAlarmPoll }))
const { useDiveraWatch } = await import('./useDiveraWatch')

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
})
