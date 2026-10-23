// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { LONG_POLL_SPACING_MS, SLOW_FOLLOW_MS, type LongPollRound } from './pollBackoff'
import { useLongPoll } from './useLongPoll'

// The loop's mechanics are covered in longPollLoop.test.ts; here: the hook around it — the app's
// cadence, the slow follow, and the restart it hands out. The rounds of the two followers
// (useIncidentSync, useJournal) are tested with them.

/** jsdom reports the tab as visible; the loop reads `document.hidden` on every round. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

beforeEach(() => { vi.useFakeTimers(); setHidden(false) })
// ⚠️ cleanup() FIRST: a hook left mounted keeps polling into the next test's clock.
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useLongPoll', () => {
  it('long-polls while visible and starts the next round right after the answer', async () => {
    // the server holds the request ~20 s, then answers
    const round = vi.fn((_ctx: LongPollRound) => new Promise<boolean>((r) => setTimeout(() => r(true), 20_000)))
    renderHook(() => useLongPoll({ round }, []))

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(round).toHaveBeenCalledTimes(1)
    expect(round.mock.calls[0]![0].hidden).toBe(false) // → the round asks with `wait: true`
    expect(round.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)

    // no beat of its own: the next round follows the answer, spaced only by the floor
    await vi.advanceTimersByTimeAsync(20_000 + LONG_POLL_SPACING_MS)
    expect(round).toHaveBeenCalledTimes(2)
  })

  it('follows once a minute while slowFollow says so, without restarting the loop', async () => {
    const round = vi.fn(async () => false) // every request refused
    const { rerender } = renderHook(({ slow }) => useLongPoll({ round, slowFollow: slow }, []), { initialProps: { slow: true } })
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(round).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SLOW_FOLLOW_MS - 1)
    expect(round).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(round).toHaveBeenCalledTimes(2)

    rerender({ slow: false }) // the reopen: read on the next round, not a restart
    expect(round).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(SLOW_FOLLOW_MS) // the one parked minute is still waited out
    const n = round.mock.calls.length
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMaxMs) // then the ordinary ease-off
    expect(round.mock.calls.length).toBeGreaterThan(n)
  })

  it('restart(0) catches up now, and a change in deps starts a new loop', async () => {
    const round = vi.fn(async () => false)
    const { result, rerender } = renderHook(({ dep }) => useLongPoll({ round }, [dep]), { initialProps: { dep: 1 } })
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(round).toHaveBeenCalledTimes(1)

    result.current(0) // «Jetzt synchronisieren», instead of the eased-off retry
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(2)

    rerender({ dep: 2 })
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs) // the new loop's first round
    expect(round).toHaveBeenCalledTimes(3)
  })
})
