// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPollLoop, LONG_POLL_SPACING_MS, type LongPollLoop, type LongPollRound } from './pollBackoff'

const BASE_MS = 2_000
const MAX_MS = 8_000
const HIDDEN_MS = 60_000

/** jsdom cannot background a tab — override the two properties the loop reads, then fire the
 *  event the browser would fire. Both are own properties, so afterEach can drop them again. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

let loop: LongPollLoop | null = null

function makeLoop(opts: Partial<Parameters<typeof createLongPollLoop>[0]> = {}) {
  loop = createLongPollLoop({
    round: async () => true,
    baseMs: BASE_MS,
    maxMs: MAX_MS,
    hiddenMs: () => HIDDEN_MS,
    ...opts,
  })
  return loop
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  loop?.stop()
  loop = null
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('createLongPollLoop', () => {
  it('runs the first round after the start delay, then back-to-back on the spacing floor', async () => {
    const round = vi.fn(async (_ctx: LongPollRound) => true)
    makeLoop({ round }).start(1_000)

    expect(round).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(999)
    expect(round).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(round).toHaveBeenCalledTimes(1)
    expect(round.mock.calls[0]![0]).toMatchObject({ hidden: false })

    // the server did the waiting → only the spacing floor between rounds
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(round).toHaveBeenCalledTimes(2)
  })

  it('eases off while rounds stay unanswered, and snaps back once one answers', async () => {
    let answer = false
    const round = vi.fn(async () => answer)
    makeLoop({ round }).start(0)

    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BASE_MS - 1)
    expect(round).toHaveBeenCalledTimes(1) // not on the spacing floor — this one fetched nothing
    await vi.advanceTimersByTimeAsync(1)
    expect(round).toHaveBeenCalledTimes(2)

    answer = true
    await vi.advanceTimersByTimeAsync(2 * BASE_MS) // the doubled ease-off delay
    expect(round).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS) // answered → back to the floor
    expect(round).toHaveBeenCalledTimes(4)
  })

  it('a round that throws counts as unanswered instead of killing the loop', async () => {
    const round = vi.fn(async () => { throw new Error('offline') })
    makeLoop({ round }).start(0)

    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BASE_MS)
    expect(round).toHaveBeenCalledTimes(2)
  })

  it('aborts a held round on restart and ignores its late answer (stale generation)', async () => {
    const signals: AbortSignal[] = []
    const resolvers: ((answered: boolean) => void)[] = []
    const round = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return new Promise<boolean>((resolve) => resolvers.push(resolve))
    })
    const l = makeLoop({ round })
    l.start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)

    l.start(0) // e.g. «Jetzt synchronisieren» while the server still holds the first request
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(2)

    // the abandoned round answers late: it must schedule nothing — the round in flight owns the
    // loop now, and a stale round rescheduling would run two chains at once.
    resolvers[0]!(true)
    await vi.advanceTimersByTimeAsync(10 * MAX_MS)
    expect(round).toHaveBeenCalledTimes(2)
  })

  it('parks on the hidden cadence when the tab goes away and catches up on return', async () => {
    const round = vi.fn(async (_ctx: LongPollRound) => true)
    const onSuspend = vi.fn()
    makeLoop({ round, onSuspend }).start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)

    setHidden(true)
    expect(onSuspend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HIDDEN_MS - 1)
    expect(round).toHaveBeenCalledTimes(1) // no back-to-back rounds while backgrounded
    await vi.advanceTimersByTimeAsync(1)
    expect(round).toHaveBeenCalledTimes(2)
    expect(round.mock.calls[1]![0]).toMatchObject({ hidden: true }) // no held request

    setHidden(false)
    await vi.advanceTimersByTimeAsync(0) // returning to the foreground catches up at once
    expect(round).toHaveBeenCalledTimes(3)
  })

  it('pagehide suspends without killing the loop', async () => {
    const round = vi.fn(async () => true)
    const onSuspend = vi.fn()
    makeLoop({ round, onSuspend }).start(0)
    await vi.advanceTimersByTimeAsync(0)

    window.dispatchEvent(new Event('pagehide'))
    expect(onSuspend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HIDDEN_MS)
    expect(round).toHaveBeenCalledTimes(2) // parked, not dead — a bfcache restore keeps polling
  })

  it('catches up at once when the device comes back online', async () => {
    const round = vi.fn(async () => false) // dead link: the loop has eased off
    const onOnline = vi.fn()
    makeLoop({ round, onOnline }).start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    expect(onOnline).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(2) // not after the parked ease-off delay
  })

  it('stop() ends the loop and unregisters its listeners', async () => {
    const round = vi.fn(async () => true)
    const onSuspend = vi.fn()
    const l = makeLoop({ round, onSuspend })
    l.start(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(round).toHaveBeenCalledTimes(1)

    l.stop()
    window.dispatchEvent(new Event('online'))
    setHidden(true)
    setHidden(false)
    l.start(0) // a stopped loop stays stopped
    await vi.advanceTimersByTimeAsync(10 * MAX_MS)
    expect(round).toHaveBeenCalledTimes(1)
    expect(onSuspend).not.toHaveBeenCalled()
  })
})
