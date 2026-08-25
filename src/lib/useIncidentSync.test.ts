// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The live-follow loop's only network call. Mocked at the module boundary (the hook imports the
// binding, so a spy on the re-export wouldn't take).
const { pollWorkspaceSince } = vi.hoisted(() => ({ pollWorkspaceSince: vi.fn() }))
vi.mock('./incidents', async () => {
  const actual = await vi.importActual<typeof import('./incidents')>('./incidents')
  return { ...actual, pollWorkspaceSince }
})

import { appConfig } from '../config/appConfig'
import * as deploymentConfig from './deploymentConfig'
import { LONG_POLL_SPACING_MS } from './pollBackoff'
import { useIncidentSync } from './useIncidentSync'
import type { Saved } from './workspace'

// A minimal WorkspaceSync stand-in — only the members useIncidentSync touches. In the
// persistence tests fake timers keep the live-follow loop from ever firing (no network).
function makeSync() {
  return {
    save: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    flushKeepalive: vi.fn(),
    adoptServer: vi.fn(),
    drainAttendanceConflicts: vi.fn().mockReturnValue([]),
    hasUnsynced: false,
    rev: 0,
    syncStatus: 'synced' as const,
    lastSyncedAt: null,
    onAttendanceConflicts: undefined,
    onApplyMerged: undefined,
    onStatus: undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mount(sync: any) {
  const blob = {} as unknown as Saved
  return renderHook(
    ({ bp }) => useIncidentSync({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sync: sync as any, readOnly: false, incidentId: 'i1', buildPayload: bp,
      applyWorkspace: vi.fn(), flushEvents: vi.fn(), flushEventsBeacon: vi.fn(),
    }),
    { initialProps: { bp: () => blob } },
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(sync: any) {
  const blob = {} as unknown as Saved
  const { rerender } = mount(sync)
  // A NEW buildPayload identity re-fires the save effect (the first run is skipped by design).
  rerender({ bp: () => blob })
}

/** jsdom reports the tab as visible; the loop reads `document.hidden` on every round. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

beforeEach(() => { vi.useFakeTimers(); pollWorkspaceSince.mockReset(); setHidden(false) })
// ⚠️ cleanup() FIRST: a hook left mounted keeps its live-follow loop running into the next
// test's clock, where its rounds count against that test's mock.
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('useIncidentSync — persistence', () => {
  it('DOES push a visitor edit in demo mode (edits persist + are shared; reset happens nightly)', () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    const sync = makeSync()
    render(sync)
    expect(sync.save).toHaveBeenCalledTimes(1)
  })

  it('DOES push when not a demo instance (unchanged behavior)', () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    const sync = makeSync()
    render(sync)
    expect(sync.save).toHaveBeenCalledTimes(1)
  })
})

describe('useIncidentSync — live-follow loop', () => {
  it('long-polls while visible and starts the next round right after the answer', async () => {
    pollWorkspaceSince.mockResolvedValue(null) // 304: nothing new
    const sync = makeSync()
    mount(sync)

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1)
    const [id, since, opts] = pollWorkspaceSince.mock.calls[0]
    expect([id, since]).toEqual(['i1', 0])
    expect(opts.wait).toBe(true)        // the server holds the request — that IS the cadence
    expect(opts.signal).toBeInstanceOf(AbortSignal)

    // no 2 s beat any more: the next round follows the answer, spaced only by the floor
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(2)
  })

  it('does NOT hold a connection while the tab is hidden — flat slow poll instead', async () => {
    pollWorkspaceSince.mockResolvedValue(null)
    setHidden(true)
    const sync = makeSync()
    mount(sync)

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince.mock.calls[0][2].wait).toBe(false)

    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1) // still asleep
    await vi.advanceTimersByTimeAsync(appConfig.sync.hiddenPollMs)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(2)
  })

  it('eases off after a failed round instead of retrying at the spacing floor', async () => {
    pollWorkspaceSince.mockRejectedValue(new Error('offline'))
    const sync = makeSync()
    mount(sync)

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1) // a dead server is not hammered
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * appConfig.sync.livePollMs) // and doubles from there
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(3)
  })

  it('skips the round while local edits are unsynced (the guard that prevents clobbering)', async () => {
    pollWorkspaceSince.mockResolvedValue(null)
    const sync = makeSync()
    sync.hasUnsynced = true
    mount(sync)

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince).not.toHaveBeenCalled()
  })

  it('aborts the held request on teardown so a 20 s hold cannot outlive the loop', async () => {
    let held: AbortSignal | undefined
    pollWorkspaceSince.mockImplementation((_id: string, _since: number, o: { signal: AbortSignal }) => {
      held = o.signal
      return new Promise(() => {}) // the server is holding it
    })
    const sync = makeSync()
    const { unmount } = mount(sync)

    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(held?.aborted).toBe(false)
    unmount()
    expect(held?.aborted).toBe(true)
  })

  it('drops the held request when the tab goes away, and catches up on return', async () => {
    pollWorkspaceSince.mockResolvedValue(null)
    const sync = makeSync()
    mount(sync)
    await vi.advanceTimersByTimeAsync(appConfig.sync.livePollMs)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1)

    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(LONG_POLL_SPACING_MS)
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(1) // parked at the hidden cadence

    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1) // visible again → catch up at once
    expect(pollWorkspaceSince).toHaveBeenCalledTimes(2)
    expect(pollWorkspaceSince.mock.calls[1][2].wait).toBe(true)
  })
})
