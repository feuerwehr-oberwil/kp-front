// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store itself is covered in journalStore.test.ts — what is under test here is the
// live-follow LOOP around it: long-poll while visible, slow no-wait poll while hidden, ease off
// when the server doesn't answer, and never leave a held request behind.
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
  it('long-polls while visible and starts the next round right after the answer', async () => {
    mount()
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pull).toHaveBeenCalledTimes(1)
    expect(pull.mock.calls[0][0].wait).toBe(true)
    expect(pull.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)

    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pull).toHaveBeenCalledTimes(2)
  })

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
