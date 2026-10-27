// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentMeta } from './incidents'
import { reportIncidentClosed, reportIncidentReopened } from './incidentClosed'
import { useCloseReopen, useIncidentLifecycle } from './useIncidentLifecycle'

// The wiring the hook owns (the rules themselves are pinned in incidentClosed): a close or reopen
// on ANOTHER device flips the open Einsatz in place and says so; this device's own close and
// reopen are never «elsewhere»; opening an Einsatz forgets the notice.

const server = vi.hoisted(() => ({ meta: null as IncidentMeta | null }))
vi.mock('./incidents', async (orig) => ({
  ...(await orig<typeof import('./incidents')>()),
  getIncident: vi.fn(async () => server.meta),
  reactivateIncident: vi.fn(async () => server.meta),
}))

const meta = (extra: Partial<IncidentMeta> = {}) => ({
  id: 'inc-1', title: 'Brand', started_at: '2026-10-24T18:00:00Z', status: 'offen', is_archived: false, ...extra,
}) as unknown as IncidentMeta

function setup(activeMeta: IncidentMeta) {
  const deps = {
    activeMeta,
    incidents: [activeMeta],
    setActiveMeta: vi.fn(),
    setIncidents: vi.fn(),
    setForceReadOnly: vi.fn(),
    archiveReturnRef: { current: 'inc-0' as string | null },
  }
  return { deps, ...renderHook(() => useIncidentLifecycle(deps)) }
}

beforeEach(() => { server.meta = null })

describe('useIncidentLifecycle', () => {
  it('a close heard from the poll shows the Einsatz closed in place, as happened elsewhere', async () => {
    const closed = meta({ is_archived: true, closed_at: '2026-10-24T19:00:00Z' })
    server.meta = closed
    const { result, deps } = setup(meta())
    act(() => reportIncidentClosed({ incidentId: 'inc-1', source: 'poll' }))
    await waitFor(() => expect(result.current.lifecycleElsewhere?.event).toBe('closed'))
    expect(deps.setActiveMeta).toHaveBeenCalledWith(closed)
    // «Zurück» from here goes to «Alle Einsätze», not into whatever was open before
    expect(deps.archiveReturnRef.current).toBeNull()
    // …and the next open forgets the notice
    act(() => result.current.markOpened())
    expect(result.current.lifecycleElsewhere).toBeNull()
  })

  it("this device's own close is not «closed on another device»", async () => {
    server.meta = meta({ is_archived: true })
    const { result, deps } = setup(meta())
    result.current.closingLocallyRef.current = 'inc-1'
    act(() => reportIncidentClosed({ incidentId: 'inc-1', source: 'poll' }))
    await act(async () => { await Promise.resolve() })
    expect(deps.setActiveMeta).not.toHaveBeenCalled()
    expect(result.current.lifecycleElsewhere).toBeNull()
  })

  it('a reopen elsewhere makes a closed view live again', async () => {
    const running = meta()
    server.meta = running
    const { result, deps } = setup(meta({ is_archived: true }))
    act(() => reportIncidentReopened({ incidentId: 'inc-1', source: 'poll' }))
    await waitFor(() => expect(result.current.lifecycleElsewhere?.event).toBe('reopened'))
    expect(deps.setForceReadOnly).toHaveBeenCalledWith(false)
    expect(deps.setActiveMeta).toHaveBeenCalledWith(running)
  })
})

// Sweep #6 (27.10.2026, owner: «reopening … loaded very slowly»): the Einsatz on screen goes live
// IN PLACE on the PATCH's own answer – no second fetch of it, no remount, the list not awaited.
// Another one (the close toast's, after the screen moved on) still opens, with that same meta.
describe('useCloseReopen · reopenNow', () => {
  function reopen(activeId: string | null) {
    const deps = {
      closingLocallyRef: { current: null }, reopeningLocallyRef: { current: null }, activeId, activeMeta: null,
      incidents: [], syncRef: { current: null }, archiveReturnRef: { current: 'inc-0' as string | null },
      refreshList: vi.fn(() => new Promise<IncidentMeta[]>(() => {})), // never answers: must not be waited for
      selectIncident: vi.fn(async () => {}), markOpened: vi.fn(), setIncidents: vi.fn(), setClosedMedia: vi.fn(),
      setActiveId: vi.fn(), setActiveMeta: vi.fn(), setWorkspace: vi.fn(), setForceReadOnly: vi.fn(),
    }
    return { deps, ...renderHook(() => useCloseReopen(deps)) }
  }

  it('flips the read-only Einsatz on screen live in place', async () => {
    server.meta = meta()
    const { result, deps } = reopen('inc-1')
    await expect(result.current.reopenNow('inc-1')).resolves.toBe('ok')
    expect(deps.selectIncident).not.toHaveBeenCalled()
    expect(deps.setForceReadOnly).toHaveBeenCalledWith(false)
    expect(deps.setActiveMeta).toHaveBeenCalledWith(server.meta)
    expect(deps.markOpened).toHaveBeenCalled()
    expect(deps.archiveReturnRef.current).toBeNull()
  })

  it('opens another Einsatz with the PATCH answer instead of fetching it again', async () => {
    server.meta = meta()
    const { result, deps } = reopen(null)
    await expect(result.current.reopenNow('inc-1')).resolves.toBe('ok')
    expect(deps.selectIncident).toHaveBeenCalledWith('inc-1', { readOnly: false, meta: server.meta })
    expect(deps.setForceReadOnly).not.toHaveBeenCalled()
  })
})
