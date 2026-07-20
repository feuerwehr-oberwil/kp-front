// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as deploymentConfig from './deploymentConfig'
import { useIncidentSync } from './useIncidentSync'
import type { Saved } from './workspace'

// A minimal WorkspaceSync stand-in — only the members useIncidentSync touches. Fake timers keep
// the live-follow poll from ever firing, so pollWorkspaceSince is never called (no network).
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
function render(sync: any) {
  const blob = {} as unknown as Saved
  const { rerender } = renderHook(
    ({ bp }) => useIncidentSync({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sync: sync as any, readOnly: false, incidentId: 'i1', buildPayload: bp,
      applyWorkspace: vi.fn(), flushEvents: vi.fn(), flushEventsBeacon: vi.fn(),
    }),
    { initialProps: { bp: () => blob } },
  )
  // A NEW buildPayload identity re-fires the save effect (the first run is skipped by design).
  rerender({ bp: () => blob })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('useIncidentSync — demo sandbox', () => {
  it('does NOT push a visitor edit to the server in demo mode', () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    const sync = makeSync()
    render(sync)
    expect(sync.save).not.toHaveBeenCalled()
  })

  it('DOES push when not a demo instance (unchanged behavior)', () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    const sync = makeSync()
    render(sync)
    expect(sync.save).toHaveBeenCalledTimes(1)
  })
})
