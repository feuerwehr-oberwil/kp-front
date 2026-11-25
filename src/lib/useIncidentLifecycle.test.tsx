// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentMeta, WorkspaceSync } from './incidents'
import { appConfig } from '../config/appConfig'
import { patchIncident } from './incidents'
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
  patchIncident: vi.fn(),
}))

const { confirmDialog, getWorkspace } = vi.hoisted(() => ({ confirmDialog: vi.fn(), getWorkspace: vi.fn() }))
vi.mock('./ui', async (orig) => ({ ...(await orig<typeof import('./ui')>()), confirmDialog }))
vi.mock('./mediaQueue', () => ({ clearUploadedMedia: vi.fn(async () => 0) }))
vi.mock('./api/workspace', async (orig) => ({ ...(await orig<typeof import('./api/workspace')>()), getWorkspace }))

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
      isSessionCurrent: vi.fn(() => true),
      closingLocallyRef: { current: null }, reopeningLocallyRef: { current: null }, activeId, activeMeta: null,
      incidents: [], syncRef: { current: null, close: vi.fn() }, archiveReturnRef: { current: 'inc-0' as string | null },
      refreshList: vi.fn(() => new Promise<IncidentMeta[]>(() => {})), // never answers: must not be waited for
      selectIncident: vi.fn(async () => {}), markOpened: vi.fn(), setIncidents: vi.fn(), setClosedMedia: vi.fn(),
      setActiveId: vi.fn(), setActiveMeta: vi.fn(), setWorkspace: vi.fn(), setForceReadOnly: vi.fn(),
      abschlussHereRef: { current: null }, showEinsatz: vi.fn(),
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

// Sweep 09.11.2026, UX.10: «Abschliessen» in «Alle Einsätze» asked the plain question for every
// Einsatz — also for one with crews still inside.
describe('useCloseReopen · archiveFromList', () => {
  const other = meta({ id: 'inc-2', title: 'Ölspur', started_at: '2026-11-17T08:42:00Z', is_exercise: false })
  function list(activeId: string | null, abschlussHere: (() => Promise<boolean>) | null = null, incidents: IncidentMeta[] = []) {
    const deps = {
      isSessionCurrent: vi.fn(() => true),
      closingLocallyRef: { current: null }, reopeningLocallyRef: { current: null }, activeId, activeMeta: null,
      incidents, syncRef: { current: null as WorkspaceSync | null, close: vi.fn() }, archiveReturnRef: { current: null },
      refreshList: vi.fn(async () => []), selectIncident: vi.fn(async () => {}), markOpened: vi.fn(),
      setIncidents: vi.fn(), setClosedMedia: vi.fn(), setActiveId: vi.fn(), setActiveMeta: vi.fn(),
      setWorkspace: vi.fn(), setForceReadOnly: vi.fn(),
      abschlussHereRef: { current: abschlussHere }, showEinsatz: vi.fn(),
    }
    return { deps, ...renderHook((id: string | null) => useCloseReopen({ ...deps, activeId: id }), { initialProps: activeId }) }
  }
  beforeEach(() => { confirmDialog.mockReset().mockResolvedValue(false); getWorkspace.mockReset(); vi.mocked(patchIncident).mockReset() })

  it('closes the Einsatz open on this device through its own counting confirm', async () => {
    const here = vi.fn(async () => false)
    const { result, deps } = list('inc-1', here)
    await result.current.archiveFromList(meta())
    expect(deps.showEinsatz).toHaveBeenCalled()
    expect(here).toHaveBeenCalledOnce()
    expect(confirmDialog).not.toHaveBeenCalled() // not the plain question on top
  })

  it('keeps the newly opened Einsatz when the previous close is acknowledged late', async () => {
    let acknowledge!: () => void
    const waiting = new Promise<void>((resolve) => { acknowledge = resolve })
    vi.mocked(patchIncident).mockImplementationOnce(async () => {
      await waiting
      return { ...meta({ is_archived: true }), text: null, map_workspace_json: null, details_json: null }
    })
    const { result, deps, rerender } = list('inc-1')
    const old = { incidentId: 'inc-1', dispose: vi.fn(), flush: vi.fn(async () => {}) }
    const next = { incidentId: 'inc-2' }
    deps.syncRef.current = old as unknown as WorkspaceSync
    const close = result.current.completeRapport('inc-1')
    await waitFor(() => expect(patchIncident).toHaveBeenCalledOnce())
    deps.syncRef.current = next as unknown as WorkspaceSync
    rerender('inc-2')
    acknowledge()
    await expect(close).resolves.toBe(true)
    expect(deps.syncRef.close).not.toHaveBeenCalled()
    expect(deps.setActiveId).not.toHaveBeenCalled()
    expect(deps.refreshList).toHaveBeenCalledOnce()
  })

  it('names the Trupps still inside another Einsatz before closing it', async () => {
    getWorkspace.mockResolvedValue({ workspace_rev: 4, workspace: { trupps: [
      { id: 't1', no: 1, name: 'Muster Leo', members: ['Graf Eva'], status: 'aktiv', entryTime: '2026-11-09T02:10:00Z' },
      { id: 't2', no: 2, name: 'Keller Jan', status: 'raus', entryTime: '2026-11-09T02:00:00Z', exitTime: '2026-11-09T02:20:00Z' },
    ] } })
    const { result } = list('inc-1', vi.fn())
    await result.current.archiveFromList(other)
    expect(getWorkspace).toHaveBeenCalledWith('inc-2')
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: appConfig.copy.abschluss.insideTitle,
      message: appConfig.copy.abschluss.insideOne,
      confirmLabel: appConfig.copy.abschluss.insideClose,
    }))
  })

  it('asks the plain question after verifying that nobody is inside', async () => {
    getWorkspace.mockResolvedValue({ workspace_rev: 0, workspace: null })
    const { result } = list(null)
    await result.current.archiveFromList(other)
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: appConfig.copy.history.archiveConfirmTitle }))
  })

  it.each([[], { trupps: 'unreadable' }])('treats a malformed roster as unknown', async (workspace) => {
    getWorkspace.mockResolvedValue({ workspace })
    const { result } = list(null)
    await result.current.archiveFromList(other)
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: appConfig.copy.abschluss.crewStatusUnknown }))
    expect(patchIncident).not.toHaveBeenCalled()
  })

  it('offers retry as the safe answer when the roster is unknown, then checks it again', async () => {
    getWorkspace.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      workspace: { trupps: [{ id: 't1', no: 1, name: 'A', status: 'aktiv', entryTime: '2026-11-17T03:00:00Z' }] },
    })
    confirmDialog.mockResolvedValueOnce('alt')
    const { result } = list(null)
    await result.current.archiveFromList(other)
    const C = appConfig.copy.abschluss
    expect(confirmDialog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: C.crewStatusUnknown, altLabel: C.checkCrewsAgain, safeAnswer: 'alt', confirmLabel: C.insideClose,
    }))
    expect(confirmDialog).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: C.insideTitle }))
    expect(patchIncident).not.toHaveBeenCalled()
  })

  it('submits the explicit override and the completion stamp together', async () => {
    getWorkspace.mockRejectedValueOnce(new Error('offline'))
    confirmDialog.mockResolvedValueOnce(true)
    vi.mocked(patchIncident).mockRejectedValueOnce(new Error('offline'))
    const { result } = list(null)
    await result.current.archiveFromList(other)
    expect(patchIncident).toHaveBeenCalledExactlyOnceWith('inc-2', {
      is_archived: true, report_done_at: expect.any(String),
    })
  })

  it('does not submit a pending close under the next account', async () => {
    const { result, deps } = list(null)
    getWorkspace.mockResolvedValue({ workspace: null })
    confirmDialog.mockImplementationOnce(async () => { deps.isSessionCurrent.mockReturnValue(false); return true })
    await result.current.archiveFromList(other)
    expect(patchIncident).not.toHaveBeenCalled()
    expect(deps.refreshList).not.toHaveBeenCalled()
  })

  it('names the selected row when the switcher still holds an older title', async () => {
    getWorkspace.mockRejectedValue(new Error('offline'))
    const { result } = list(null, null, [{ ...other, title: 'Brand' }])
    await result.current.archiveFromList(other)
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.objectContaining({ head: 'Ölspur' }) }))
  })
})
