import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEC-10. The offline cache is the product's core promise, so the engine has exactly ONE reason
// to refuse it: a reachable server that said «no». Silence (airplane mode, a restarting server)
// must still answer from the device — these tests hold both halves apart, because collapsing
// them in either direction is a bug: one way leaks a revoked session's data, the other way
// breaks the cellar with no signal.
const getWorkspace = vi.fn()
const putWorkspace = vi.fn()
vi.mock('./workspace', () => ({
  getWorkspace: (...a: unknown[]) => getWorkspace(...a),
  putWorkspace: (...a: unknown[]) => putWorkspace(...a),
  putWorkspaceBeacon: vi.fn(),
  putWorkspaceTrupps: vi.fn(),
  putWorkspaceTruppsBeacon: vi.fn(),
}))
vi.mock('../idb', () => ({
  idbGet: vi.fn(async () => null),
  idbSet: vi.fn(async () => true),
  idbDel: vi.fn(async () => undefined),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { ApiError } = await import('../api')
const { idbGet, idbSet, idbDel } = vi.mocked(await import('../idb'))
const { WorkspaceSync, denyWorkspaceCache, setWorkspaceCacheOwner } = await import('./workspaceSync')

/** an unsynced edit sitting in this device's cache, owned by `owner` */
const cachedEdit = (owner?: string) => ({
  workspace: { entities: [{ id: 'mine' }] },
  base: {},
  baseRev: 3,
  dirty: true,
  lastSyncedAt: null,
  ...(owner ? { owner } : {}),
})

/** The module-level session gate is device state, not per-instance — reset it between tests.
 *  A user id is what LIFTS a denial (the account is back), so signing in clears both. */
function signedInAs(userId: string | null) {
  setWorkspaceCacheOwner('reset')
  setWorkspaceCacheOwner(userId)
}

beforeEach(() => {
  getWorkspace.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 7 })
  putWorkspace.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  idbGet.mockReset().mockResolvedValue(null)
  idbSet.mockReset().mockResolvedValue(true)
  idbDel.mockReset().mockResolvedValue(undefined)
  signedInAs(null)
})

describe('WorkspaceSync.init · a refusal is not a lost connection', () => {
  it.each([401, 403])('does not answer an explicit %i from the offline cache', async (status) => {
    signedInAs('u1')
    idbGet.mockResolvedValue(cachedEdit('u1'))
    getWorkspace.mockRejectedValue(new ApiError(status, 'Nicht angemeldet'))

    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    await expect(sync.init()).rejects.toBeInstanceOf(ApiError)
    expect(idbDel).not.toHaveBeenCalled() // …and the unsynced edit is kept, not punished
    sync.dispose()
  })

  it.each([0, 502, 503, 504])('still serves the cache when the server could not be asked (%i)', async (status) => {
    signedInAs('u1')
    idbGet.mockResolvedValue(cachedEdit('u1'))
    getWorkspace.mockRejectedValue(new ApiError(status, 'Netzwerkfehler'))

    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    const r = await sync.init()
    expect(r.fromCache).toBe(true)
    expect(r.workspace).toEqual({ entities: [{ id: 'mine' }] })
    expect(sync.hasUnsynced).toBe(true)
    sync.dispose()
  })
})

describe('WorkspaceSync.init · a denied session, and the way back', () => {
  it('locks the cache until the same user signs in again — and hands the edits back then', async () => {
    signedInAs('u1')
    idbGet.mockResolvedValue(cachedEdit('u1'))
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    denyWorkspaceCache() // the server refused this session elsewhere (lib/auth)

    const denied = new WorkspaceSync('i1', { debounceMs: 0 })
    await expect(denied.init()).rejects.toBeInstanceOf(ApiError) // offline is no longer a way in
    denied.dispose()

    signedInAs('u1') // …the same account is back
    const back = new WorkspaceSync('i1', { debounceMs: 0 })
    const r = await back.init()
    expect(r.workspace).toEqual({ entities: [{ id: 'mine' }] }) // the unsynced edit survived
    expect(back.hasUnsynced).toBe(true)
    back.dispose()
  })

  it('never hands the previous user’s unsynced edits to the next one', async () => {
    idbGet.mockResolvedValue(cachedEdit('u1'))
    signedInAs('u2')

    // offline: u2 has no right to u1's copy, so there is simply nothing on this device for them
    getWorkspace.mockRejectedValueOnce(new ApiError(0, 'Netzwerkfehler'))
    const offline = new WorkspaceSync('i1', { debounceMs: 0 })
    await expect(offline.init()).rejects.toBeInstanceOf(ApiError)
    offline.dispose()

    // online: u2 starts from the server, with none of u1's dirty state
    getWorkspace.mockResolvedValueOnce({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 })
    const online = new WorkspaceSync('i1', { debounceMs: 0 })
    const r = await online.init()
    expect(r.fromCache).toBe(false)
    expect(r.workspace).toEqual({ entities: [{ id: 'srv' }] })
    expect(online.hasUnsynced).toBe(false)
    online.dispose()
  })

  it('stamps the owner on every cache write, so the gate has something to key on', async () => {
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    sync.dispose() // teardown flushes the debounced write
    expect(idbSet).toHaveBeenLastCalledWith('kp-front-ws-i1', expect.objectContaining({ owner: 'u1', dirty: true }))
  })

  it('keeps writing while denied — the lock is on reading, never on the operator’s work', async () => {
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    denyWorkspaceCache()
    sync.save({ n: 1 })
    sync.dispose()
    expect(idbSet).toHaveBeenLastCalledWith('kp-front-ws-i1', expect.objectContaining({ workspace: { n: 1 }, dirty: true }))
  })
})
