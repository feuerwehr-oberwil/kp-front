import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Atemschutz-Link session writes the Überwachungstafel and nothing else — the full
// workspace PUT 403s for it. What is worth pinning is that `slice: 'trupps'` changes ONLY the
// route the push takes: the same engine, the same base_rev, and never a whole-blob write that
// the server would refuse (leaving a link holder's Kontakt stuck in the offline cache).
const getWorkspace = vi.fn()
const putWorkspace = vi.fn()
const putWorkspaceBeacon = vi.fn()
const putWorkspaceTrupps = vi.fn()
const putWorkspaceTruppsBeacon = vi.fn()
vi.mock('./workspace', () => ({
  getWorkspace: (...a: unknown[]) => getWorkspace(...a),
  putWorkspace: (...a: unknown[]) => putWorkspace(...a),
  putWorkspaceBeacon: (...a: unknown[]) => putWorkspaceBeacon(...a),
  putWorkspaceTrupps: (...a: unknown[]) => putWorkspaceTrupps(...a),
  putWorkspaceTruppsBeacon: (...a: unknown[]) => putWorkspaceTruppsBeacon(...a),
}))
vi.mock('../idb', () => ({
  idbGet: vi.fn(async () => null),
  idbSet: vi.fn(async () => true),
  idbDel: vi.fn(async () => undefined),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { WorkspaceSync } = await import('./workspaceSync')

const trupp = { id: 'tr1', name: 'Trupp 1', status: 'aktiv' }
const blob = { trupps: [trupp], drawings: [{ id: 'd1' }] }

beforeEach(() => {
  getWorkspace.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 7 })
  putWorkspace.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceBeacon.mockReset()
  putWorkspaceTrupps.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceTruppsBeacon.mockReset()
})

describe('WorkspaceSync · slice: «trupps»', () => {
  it('pushes only the Trupps, at the revision the whole blob is based on', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'trupps', debounceMs: 0 })
    await sync.init()
    sync.save(blob)
    await sync.flush()
    expect(putWorkspaceTrupps).toHaveBeenCalledWith('i1', [trupp], 7)
    expect(putWorkspace).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('sends the teardown beacon down the same slice route', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'trupps', debounceMs: 10_000 })
    await sync.init()
    sync.save(blob)
    sync.flushKeepalive()
    expect(putWorkspaceTruppsBeacon).toHaveBeenCalledWith('i1', [trupp], 7)
    expect(putWorkspaceBeacon).not.toHaveBeenCalled()
    sync.dispose()
  })

  // …and an ordinary editor session is untouched by any of it.
  it('writes the whole document without the option', async () => {
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    await sync.init()
    sync.save(blob)
    await sync.flush()
    expect(putWorkspace).toHaveBeenCalledWith('i1', blob, 7)
    expect(putWorkspaceTrupps).not.toHaveBeenCalled()
    sync.dispose()
  })
})
