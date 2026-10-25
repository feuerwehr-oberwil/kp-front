// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentMeta } from './incidents'
import { reportIncidentClosed, reportIncidentReopened } from './incidentClosed'
import { useIncidentLifecycle } from './useIncidentLifecycle'

// The wiring the hook owns (the rules themselves are pinned in incidentClosed): a close or reopen
// on ANOTHER device flips the open Einsatz in place and says so; this device's own close and
// reopen are never «elsewhere»; opening an Einsatz forgets the notice.

const server = vi.hoisted(() => ({ meta: null as IncidentMeta | null }))
vi.mock('./incidents', async (orig) => ({
  ...(await orig<typeof import('./incidents')>()),
  getIncident: vi.fn(async () => server.meta),
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
