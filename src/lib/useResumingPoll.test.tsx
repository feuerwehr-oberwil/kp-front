// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResumingPoll, WATCH_POLL_MS, WATCH_RESUME_GAP_MS } from './useResumingPoll'

// The two watches (useIncidentWatch, useDiveraWatch) share this runner for exactly two
// properties, and both are invisible until they break on a tablet:
//
//   · ONE round at a time. A round may take the full request bound, and the cadence does not
//     wait for it — an unguarded tick stacked round-trips on a phone that had gone to sleep
//     mid-request. The manual round a caller fires by hand shares the same guard.
//   · a FLOOR under the foreground resume. A tablet is picked up and put down constantly; a
//     resume within WATCH_RESUME_GAP_MS of the last round is skipped, because the interval is
//     already keeping things fresh.

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000) })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

const OPTS = { pollMs: WATCH_POLL_MS, resumeGapMs: WATCH_RESUME_GAP_MS }

/** A round the test decides when to finish. */
function gate() {
  let land!: () => void
  const promise = new Promise<void>((resolve) => { land = resolve })
  return { promise, land }
}

describe('useResumingPoll', () => {
  it('runs one round at a time — ticks and manual calls during a round are dropped', async () => {
    const round = gate()
    const refresh = vi.fn(() => round.promise)
    const { result } = renderHook(() => useResumingPoll(true, refresh, OPTS))
    expect(refresh).toHaveBeenCalledTimes(1) // mount fires immediately

    // three cadence ticks and a caller's own round, all while the first is still in flight
    await act(async () => {
      vi.advanceTimersByTime(WATCH_POLL_MS * 3)
      await result.current()
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    // once it lands, the next tick is served again
    await act(async () => { round.land(); await round.promise })
    await act(async () => { vi.advanceTimersByTime(WATCH_POLL_MS) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('skips a foreground resume inside the gap and takes the one beyond it', async () => {
    const refresh = vi.fn(async () => {})
    renderHook(() => useResumingPoll(true, refresh, OPTS))
    await act(async () => {})
    expect(refresh).toHaveBeenCalledTimes(1)

    // put down and picked straight back up — nothing to fetch, the interval has it
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(refresh).toHaveBeenCalledTimes(1)

    // quiet for the whole gap (still short of a cadence tick), then back to the foreground
    await act(async () => { vi.advanceTimersByTime(WATCH_RESUME_GAP_MS) })
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
