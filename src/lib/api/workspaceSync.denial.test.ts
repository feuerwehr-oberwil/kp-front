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

  // The HIGH data-loss the round-2 fix still had: every workspace edited offline BEFORE this batch
  // shipped is ownerless AND dirty. On an ONLINE reopen the server fetch would overwrite the only
  // unsynced copy. It must be PARKED first — preserved, and never handed to whoever is signed in.
  it('parks a pre-batch ownerless DIRTY entry on an ONLINE upgrade — never destroyed, never served', async () => {
    const orphan = { workspace: { entities: [{ id: 'orphan' }] }, base: {}, baseRev: 5, dirty: true, lastSyncedAt: 1 }
    const store = backingStore({ 'kp-front-ws-i1': orphan })
    signedInAs('u1')
    getWorkspace.mockResolvedValue({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 })

    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const r = await sync.init()
    expect(r.fromCache).toBe(false)                          // u1 gets the SERVER copy…
    expect(r.workspace).toEqual({ entities: [{ id: 'srv' }] })
    expect(sync.hasUnsynced).toBe(false)                     // …not the orphan's unsynced state
    sync.dispose()                                           // flushes the clean snapshot into the slot
    expect(store.get('kp-front-ws-i1::__preupgrade__')).toEqual(orphan) // the dirty work is preserved
    expect(store.get('kp-front-ws-i1')).toMatchObject({ owner: 'u1', dirty: false }) // slot reused, no loss

    // …and it is NEVER auto-served: u1 reopening offline reads the clean server snapshot, not the orphan.
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const again = new WorkspaceSync('i1', { debounceMs: 0 })
    const r2 = await again.init()
    expect(r2.workspace).toEqual({ entities: [{ id: 'srv' }] })
    expect(again.hasUnsynced).toBe(false)
    again.dispose()
    expect(store.get('kp-front-ws-i1::__preupgrade__')).toEqual(orphan) // still parked, recoverable by hand
  })

  // A storage error during the re-home must not turn parked work into lost work: the parked copy
  // is the ONLY copy, so it is deleted only after the main write is confirmed durable.
  it('keeps the parked copy when the re-home write fails (a full store must not destroy the only copy)', async () => {
    const store = backingStore({ 'kp-front-ws-i1::u1': cachedEdit('u1') }) // u1's work parked; main slot empty
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler')) // offline: only the cache can answer
    idbSet.mockImplementation((k: string, v: unknown) => {
      if (k === 'kp-front-ws-i1') return Promise.resolve(false) // the durable main-slot write is refused
      store.set(k, v); return Promise.resolve(true)
    })

    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const r = await sync.init()
    expect(r.workspace).toEqual({ entities: [{ id: 'mine' }] }) // still served from the parked copy
    sync.dispose()
    expect(store.get('kp-front-ws-i1::u1')).toEqual(cachedEdit('u1')) // …and it was NOT deleted
  })

  // The round-3 fix protected RE-HOMING (delete parked only after the main write lands) but not
  // PARKING: a failed park write was ignored, and the server fetch then overwrote the main slot —
  // destroying the only unsynced copy. Parking must be durable-or-abort too. A full store can still
  // permit the smaller clean-snapshot write, so the abort has to be explicit, not incidental.
  it('does not overwrite user A’s dirty main slot when the (foreign-owned) park write fails — B gets the server, A survives', async () => {
    const aEntry = cachedEdit('u1')
    const store = backingStore({ 'kp-front-ws-i1': aEntry }) // A's unsynced work in the main slot
    signedInAs('u2')
    getWorkspace.mockResolvedValue({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 })
    // Copying A's dirty blob to A's owner key is refused (a full store); the smaller writes still pass.
    idbSet.mockImplementation((k: string, v: unknown) => {
      if (k === 'kp-front-ws-i1::u1') return Promise.resolve(false)
      store.set(k, v); return Promise.resolve(true)
    })

    const b = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const rb = await b.init()
    expect(rb.fromCache).toBe(false)
    expect(rb.workspace).toEqual({ entities: [{ id: 'srv' }] }) // B is served the server, never A's data
    expect(b.hasUnsynced).toBe(false)
    b.dispose() // teardown must NOT flush anything over A's slot
    expect(store.get('kp-front-ws-i1')).toEqual(aEntry) // A's only copy is intact — not overwritten
    expect(idbDel).not.toHaveBeenCalledWith('kp-front-ws-i1')
  })

  it('does not overwrite an ownerless pre-upgrade dirty entry when the orphan park write fails', async () => {
    const orphan = { workspace: { entities: [{ id: 'orphan' }] }, base: {}, baseRev: 5, dirty: true, lastSyncedAt: 1 }
    const store = backingStore({ 'kp-front-ws-i1': orphan })
    signedInAs('u1')
    getWorkspace.mockResolvedValue({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 })
    idbSet.mockImplementation((k: string, v: unknown) => {
      if (k === 'kp-front-ws-i1::__preupgrade__') return Promise.resolve(false) // orphan park refused
      store.set(k, v); return Promise.resolve(true)
    })

    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const r = await sync.init()
    expect(r.fromCache).toBe(false)
    expect(r.workspace).toEqual({ entities: [{ id: 'srv' }] }) // the server, not the unattributable orphan
    expect(sync.hasUnsynced).toBe(false)
    sync.dispose()
    expect(store.get('kp-front-ws-i1')).toEqual(orphan) // the only unsynced copy survives untouched
  })

  // TOCTOU on the RE-HOME (loadReadableEntry): A's parked draft is written back into the main slot,
  // then the parked copy is deleted. If the owner flips to B (who has their OWN parked draft) during
  // the main-slot write, a delete keyed off the live `cacheOwner` would erase B's copy even though
  // only A's was re-homed. The key is captured before the write, so exactly A's copy is cleared.
  it('re-homes A’s parked draft without deleting B’s when the owner flips to B mid-write', async () => {
    const aParked = cachedEdit('u1')
    const bParked = { ...cachedEdit('u2'), workspace: { entities: [{ id: 'b-draft' }] } }
    const store = backingStore({ 'kp-front-ws-i1::u1': aParked, 'kp-front-ws-i1::u2': bParked })
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler')) // offline: only the cache answers

    // The main-slot re-home write is exactly where a login lands — flip the live owner to B there.
    const realSet = idbSet.getMockImplementation()!
    idbSet.mockImplementation((k: string, v: unknown) => {
      if (k === 'kp-front-ws-i1') signedInAs('u2')
      return realSet(k, v)
    })

    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const r = await sync.init()
    expect(r.workspace).toEqual({ entities: [{ id: 'mine' }] }) // A's draft was re-homed and served
    sync.dispose()

    expect(store.get('kp-front-ws-i1::u2')).toEqual(bParked)   // B's parked draft is UNTOUCHED
    expect(store.get('kp-front-ws-i1::u1')).toBeUndefined()    // A's parked copy was the one cleared
    expect(store.get('kp-front-ws-i1')).toMatchObject({ owner: 'u1', workspace: { entities: [{ id: 'mine' }] } })
  })

  // TOCTOU: init() reads the owner, awaits the server, then writes. A login/logout landing during
  // that await must not let the PREVIOUS session's unsynced work be served to — or stamped with —
  // the new identity.
  it('does not serve or mislabel the previous session’s dirty work when identity flips mid-fetch', async () => {
    const store = backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })
    signedInAs('u1')
    getWorkspace.mockImplementation(async () => {
      signedInAs('u2') // a different account signs in while the server fetch is in flight
      return { workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 9 }
    })

    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    const r = await sync.init()
    expect(r.fromCache).toBe(false)                          // u2 (now live) gets the clean server copy…
    expect(r.workspace).toEqual({ entities: [{ id: 'srv' }] })
    expect(sync.hasUnsynced).toBe(false)                     // …never u1's dirty edits
    sync.dispose()
    // u1's work was parked for u1, stamped u1 — not merged/served under u2.
    expect(store.get('kp-front-ws-i1::u1')).toMatchObject({ owner: 'u1', workspace: { entities: [{ id: 'mine' }] } })
    expect(store.get('kp-front-ws-i1')).toMatchObject({ owner: 'u2', dirty: false })
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
