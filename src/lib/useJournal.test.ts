// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store itself is covered in journalStore.test.ts, the loop's mechanics in useLongPoll.test.ts
// and longPollLoop.test.ts — what is under test here is the Verlauf's ROUND on that loop: hold
// the request while visible, a slow no-wait poll while hidden, ease off when the server doesn't
// answer, push before the pull, and never leave a held request behind.
const { pull, flush, instances } = vi.hoisted(() => ({
  pull: vi.fn(),
  flush: vi.fn(),
  instances: [] as unknown[],
}))
vi.mock('./journalStore', () => {
  class FakeStore {
    isDisposed = false
    onChange: (() => void) | undefined
    pendingCount = 0
    pull = pull
    flush = flush
    revive = vi.fn()
    init = vi.fn().mockResolvedValue(undefined)
    flushKeepalive = vi.fn()
    dispose = vi.fn()
    setReadOnly = vi.fn()
    display = vi.fn().mockReturnValue([])
    blobTimeline = vi.fn().mockReturnValue([])
    unsentRowIds = vi.fn().mockReturnValue(new Set())
    private readonly snapshot = { rowsKey: '', syncStatus: 'synced', pendingCount: 0, rejectedCount: 0, refusedCount: 0, unsentIds: new Set(), blobTimeline: [] }
    view = () => this.snapshot
    constructor() { instances.push(this) }
  }
  return { JournalStore: FakeStore }
})

import { appConfig } from '../config/appConfig'
import { LONG_POLL_SPACING_MS } from './pollBackoff'
import { useJournal } from './useJournal'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

const mount = () => renderHook(() => useJournal({ incidentId: 'i1', readOnly: false, legacy: [] }))

beforeEach(() => {
  vi.useFakeTimers()
  pull.mockReset().mockResolvedValue('none')
  flush.mockReset().mockResolvedValue(undefined)
  instances.length = 0
  setHidden(false)
})
// ⚠️ cleanup() FIRST: a hook left mounted keeps polling into the next test's clock.
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('useJournal — live-follow loop', () => {
  it('does NOT hold a connection while the tab is hidden', async () => {
    setHidden(true)
    mount()
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pull.mock.calls[0][0].wait).toBe(false)

    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(appConfig.sync.hiddenPollMs)
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('eases off when the round did not reach the server', async () => {
    pull.mockResolvedValue('failed')
    mount()
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('pushes the outbox BEFORE holding the long poll, not only on its answer', async () => {
    // A recovery nobody announced (no `online` event) must not leave offline rows waiting for
    // the server to release a ~20 s hold (e2e «offline journal entries survive reload…»).
    pull.mockImplementation(() => new Promise(() => {}))
    mount()
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pull).toHaveBeenCalledTimes(1)
    expect(pull.mock.calls[0][0]).toMatchObject({ wait: true, signal: expect.any(AbortSignal) })
    expect(flush).toHaveBeenCalled()
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(pull.mock.invocationCallOrder[0])
  })

  it('aborts the held request on teardown', async () => {
    let held: AbortSignal | undefined
    pull.mockImplementation((o: { signal: AbortSignal }) => { held = o.signal; return new Promise(() => {}) })
    const { unmount } = mount()
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(held?.aborted).toBe(false)
    unmount()
    expect(held?.aborted).toBe(true)
  })
})

// Requests in 30 s after a 40 s warm-up, for a server whose answer to every poll is `answer`
// after `holdMs` (0 = the proxy that does not hold `wait=1`).
async function pullsPer30s(answer: 'none' | 'new', holdMs: number) {
  pull.mockImplementation(() => new Promise((res) => setTimeout(() => { res(answer) }, holdMs)))
  mount()
  await vi.advanceTimersByTimeAsync(40_000)
  const before = pull.mock.calls.length
  await vi.advanceTimersByTimeAsync(30_000)
  return pull.mock.calls.length - before
}

describe('useJournal — a long poll the server does not hold', () => {
  it('eases off when every held poll answers «nothing new» at once', async () => {
    // the ease-off ceiling (livePollMaxMs, 15 s) – the workspace loop's number in this model
    expect(await pullsPer30s('none', 0)).toBe(2)
  })

  it('a poll held its normal time loops at once – the healthy link keeps its rhythm', async () => {
    // one round = 20 s hold + the spacing floor
    expect(await pullsPer30s('none', 20_000)).toBe(2)
  })

  it('new rows are followed at once, also when they came back fast (a real wake)', async () => {
    // the base never eased off and keeps the spacing floor – the same count as before the guard
    expect(await pullsPer30s('new', 0)).toBe(119)
  })

  it('the first held poll after a back-off brings the normal rhythm back', async () => {
    const calledAt: number[] = []
    pull.mockImplementation(() => { calledAt.push(Date.now()); return Promise.resolve('none') })
    mount()
    await vi.advanceTimersByTimeAsync(40_000) // parked on the ease-off ceiling
    pull.mockImplementationOnce(() => {
      calledAt.push(Date.now())
      return new Promise((res) => setTimeout(() => { res('none') }, 20_000))
    })
    const held = calledAt.length
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMaxMs + 20_000 + LONG_POLL_SPACING_MS)
    expect(calledAt[held + 1] - calledAt[held]).toBe(20_000 + LONG_POLL_SPACING_MS)
  })
})
