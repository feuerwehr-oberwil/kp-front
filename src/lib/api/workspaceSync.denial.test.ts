import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEC-10. The offline cache is the product's core promise, so the engine has exactly ONE reason
// to refuse it: a reachable server that said «no». Silence (airplane mode, a restarting server)
// must still answer from the device — these tests hold both halves apart, because collapsing
// them in either direction is a bug: one way leaks a revoked session's data, the other way
// breaks the cellar with no signal.
const getWorkspace = vi.fn()
const putWorkspace = vi.fn()
const putWorkspaceTrupps = vi.fn()
vi.mock('./workspace', () => ({
  getWorkspace: (...a: unknown[]) => getWorkspace(...a),
  putWorkspace: (...a: unknown[]) => putWorkspace(...a),
  putWorkspaceBeacon: vi.fn(),
  putWorkspaceTrupps: (...a: unknown[]) => putWorkspaceTrupps(...a),
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
  putWorkspaceTrupps.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  idbGet.mockReset().mockResolvedValue(null)
  idbSet.mockReset().mockResolvedValue(true)
  idbDel.mockReset().mockResolvedValue(undefined)
  signedInAs(null)
})

/** A key-aware IndexedDB, so the parking/adoption logic (which touches several keys) is exercised
 *  for real — the naive shared-value mock above can't tell the main slot from an owner bucket. */
function backingStore(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed))
  idbGet.mockImplementation((k: string) => Promise.resolve((store.get(k) ?? null) as never))
  idbSet.mockImplementation((k: string, v: unknown) => { store.set(k, v); return Promise.resolve(true) })
  idbDel.mockImplementation((k: string) => { store.delete(k); return Promise.resolve() })
  return store
}

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

describe('WorkspaceSync · a different user cannot destroy or inherit another’s unsynced work', () => {
  it('user B opening the incident never clobbers user A’s dirty cache — A recovers it on return (SEC-10 regression)', async () => {
    const store = backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })

    // B opens the SAME incident, online. B has no right to A's entry, so B starts from the server.
    signedInAs('u2')
    getWorkspace.mockResolvedValue({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 })
    const b = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const rb = await b.init()
    expect(rb.fromCache).toBe(false)
    expect(rb.workspace).toEqual({ entities: [{ id: 'srv' }] })
    expect(b.hasUnsynced).toBe(false)
    b.dispose() // B's clean snapshot lands in the main slot (owner u2) — the old bug destroyed A here

    // A signs back in — the unsynced edit is still on the device, even offline.
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const a = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const ra = await a.init()
    expect(ra.workspace).toEqual({ entities: [{ id: 'mine' }] }) // survived B's whole session
    expect(a.hasUnsynced).toBe(true)
    a.dispose()
    expect(idbDel).not.toHaveBeenCalledWith('kp-front-ws-i1') // A's work was parked, never deleted
  })

  it('stamps the ENQUEUING session, not the one live when the debounced write lands (owner race)', async () => {
    const store = backingStore()
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })  // A enqueues an edit
    signedInAs('u2')     // …the identity flips before the debounced cache write lands
    sync.dispose()       // teardown flushes it
    expect(store.get('kp-front-ws-i1')).toMatchObject({ owner: 'u1', workspace: { n: 1 } })
  })

  it('adopts an ownerless CLEAN entry to the first reader, so the next user can’t inherit it', async () => {
    const store = backingStore({
      'kp-front-ws-i1': { workspace: { entities: [{ id: 'old' }] }, base: {}, baseRev: 5, dirty: false, lastSyncedAt: 1 },
    })
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler')) // offline: only the cache can answer
    const a = new WorkspaceSync('i1', { debounceMs: 0 })
    const ra = await a.init()
    expect(ra.workspace).toEqual({ entities: [{ id: 'old' }] }) // the first reader is served
    a.dispose()
    expect(store.get('kp-front-ws-i1')).toMatchObject({ owner: 'u1' }) // …and it is now theirs

    signedInAs('u2') // a DIFFERENT user, offline, inherits nothing
    const b = new WorkspaceSync('i1', { debounceMs: 0 })
    await expect(b.init()).rejects.toBeInstanceOf(ApiError)
    b.dispose()
  })

  it('preserves an ownerless DIRTY entry but never serves it to a user who can’t claim it', async () => {
    const orphan = { workspace: { entities: [{ id: 'orphan' }] }, base: {}, baseRev: 5, dirty: true, lastSyncedAt: 1 }
    const store = backingStore({ 'kp-front-ws-i1': orphan })
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const a = new WorkspaceSync('i1', { debounceMs: 0 })
    await expect(a.init()).rejects.toBeInstanceOf(ApiError) // unattributable — not served
    a.dispose()
    expect(store.get('kp-front-ws-i1')).toEqual(orphan) // …but left untouched
  })
})

describe('WorkspaceSync.flush · a revoked session locks the cache mid-flush', () => {
  it('a 401 on the write path denies the cache device-wide, and keeps the dirty work', async () => {
    backingStore()
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    putWorkspace.mockRejectedValueOnce(new ApiError(401, 'Nicht angemeldet'))
    await sync.flush()
    expect(sync.hasUnsynced).toBe(true) // the operator's work is kept, not lost
    sync.dispose()

    // …and the denial is device-wide: another incident this SAME user owns is now locked offline.
    backingStore({ 'kp-front-ws-i2': cachedEdit('u1') })
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const other = new WorkspaceSync('i2', { debounceMs: 0 })
    await expect(other.init()).rejects.toBeInstanceOf(ApiError)
    other.dispose()
  })

  it('a 403 on the write path does NOT deny — it can be the Atemschutz-Link slice legitimately refused', async () => {
    backingStore()
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000, slice: 'trupps' })
    await sync.init()
    sync.save({ trupps: [] })
    putWorkspaceTrupps.mockRejectedValueOnce(new ApiError(403, 'nur Trupps'))
    await sync.flush()
    expect(sync.hasUnsynced).toBe(true)
    sync.dispose()

    // NOT device-wide: the same user still reads another incident's cache offline.
    backingStore({ 'kp-front-ws-i2': cachedEdit('u1') })
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const other = new WorkspaceSync('i2', { debounceMs: 0 })
    const r = await other.init()
    expect(r.fromCache).toBe(true)
    other.dispose()
  })
})
