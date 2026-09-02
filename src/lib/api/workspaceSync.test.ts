import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { ApiError } = await import('../api')
const { idbSet } = vi.mocked(await import('../idb'))
const { CACHE_DEBOUNCE_MS, WorkspaceSync } = await import('./workspaceSync')

const trupp = { id: 'tr1', name: 'Trupp 1', status: 'aktiv' }
const blob = { trupps: [trupp], drawings: [{ id: 'd1' }] }

beforeEach(() => {
  getWorkspace.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 7 })
  putWorkspace.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceBeacon.mockReset()
  putWorkspaceTrupps.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceTruppsBeacon.mockReset()
  idbSet.mockClear()
})
afterEach(() => { vi.useRealTimers() })

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

// The 409 resolver used to run its GET and its merge OUTSIDE the try: a server blob this app
// did not write (`entities: {}`) threw in the merge, the throw escaped flush() as an unhandled
// rejection, no status was ever set, and the backoff re-threw it every 5–60 s — the badge stuck
// on «ausstehend» with no toast. Now the merge coerces, and whatever still fails lands in a
// status the UI answers with the sync toast and «Jetzt synchronisieren».
describe('WorkspaceSync · the 409 resolver', () => {
  const conflict = () => new ApiError(409, 'stale')

  it('a server blob with entities: {} merges without throwing and pushes an empty list', async () => {
    putWorkspace.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ workspace: null, workspace_rev: 10 })
    getWorkspace.mockResolvedValueOnce({ workspace: {}, workspace_rev: 7 }).mockResolvedValueOnce({ workspace: { entities: {} }, workspace_rev: 9 })
    const status: string[] = []
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    sync.onStatus = (s) => status.push(s)
    await sync.init()
    sync.save({ entities: [] })
    await sync.flush()
    const merged = putWorkspace.mock.calls[1][1] as { entities: unknown }
    expect(merged.entities).toEqual([])
    expect(putWorkspace.mock.calls[1][2]).toBe(9)
    expect(status[status.length - 1]).toBe('synced')
    sync.dispose()
  })

  it('a fetch that dies inside the resolver lands in «offline», a merge that throws in «error» — never an unhandled rejection', async () => {
    putWorkspace.mockRejectedValue(conflict())
    getWorkspace.mockResolvedValueOnce({ workspace: {}, workspace_rev: 7 }).mockRejectedValueOnce(new ApiError(0, 'network'))
    const status: string[] = []
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    sync.onStatus = (s) => status.push(s)
    await sync.init()
    sync.save({ entities: [] })
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(status[status.length - 1]).toBe('offline')
    expect(sync.hasUnsynced).toBe(true) // the edits stay dirty in the cache for the retry

    getWorkspace.mockRejectedValueOnce(new Error('boom'))
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(status[status.length - 1]).toBe('error')
    sync.dispose()
  })
})

// The offline cache used to be written on EVERY save() — a structured clone plus an IDB put of
// the whole blob per keystroke, and on a full device a 500-tile eviction per key.
describe('WorkspaceSync · the cache write is debounced', () => {
  it('a burst of saves lands once, with the latest content, after the debounce', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS) // init's own write
    idbSet.mockClear()
    sync.save({ n: 1 }); sync.save({ n: 2 }); sync.save({ n: 3 })
    expect(idbSet).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    expect(idbSet).toHaveBeenCalledTimes(1)
    expect(idbSet.mock.calls[0][1]).toMatchObject({ workspace: { n: 3 }, dirty: true })
    sync.dispose()
  })

  it('teardown and the server push flush it synchronously — the debounce never loses the last edit', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    idbSet.mockClear()
    sync.save({ n: 1 })
    sync.flushKeepalive()
    expect(idbSet).toHaveBeenCalledTimes(1) // no timer advance needed
    expect(idbSet.mock.calls[0][1]).toMatchObject({ workspace: { n: 1 } })

    sync.save({ n: 2 })
    await sync.flush() // the push flushes first, then writes the synced entry (debounced again)
    expect(idbSet.mock.calls[1][1]).toMatchObject({ workspace: { n: 2 }, dirty: true })
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    expect(idbSet.mock.calls[2][1]).toMatchObject({ workspace: { n: 2 }, dirty: false })

    sync.save({ n: 3 })
    sync.dispose()
    expect(idbSet).toHaveBeenCalledTimes(4)
    expect(idbSet.mock.calls[3][1]).toMatchObject({ workspace: { n: 3 } })
  })
})
