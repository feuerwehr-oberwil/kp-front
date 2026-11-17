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
 
  putWorkspaceTrupps: (...a: unknown[]) => putWorkspaceTrupps(...a),
  putWorkspaceTruppsBeacon: vi.fn(),
}))
vi.mock('../idb', () => {
  const idbGet = vi.fn(async (_key: string): Promise<unknown> => null)
  return {
    idbGet,
    // the hydrate paths read through `idbRead`; it answers from the same mocked store
    idbRead: vi.fn(async (key: string) => ({ ok: true, value: await idbGet(key) })),
    idbSet: vi.fn(async () => true),
    idbDel: vi.fn(async () => undefined),
  }
})
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { ApiError } = await import('../api')
const { idbGet, idbRead, idbSet, idbDel } = vi.mocked(await import('../idb'))
const { CACHE_DEBOUNCE_MS, SLOT_PROBE_MS, WorkspaceSync, denyWorkspaceCache, setWorkspaceCacheOwner } = await import('./workspaceSync')

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

function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

describe('late answers after a workspace handover', () => {
  it.each([
    ['ordinary PUT', 'success', true], ['merge PUT', 'success', true],
    ['ordinary PUT', 'success', false], ['merge PUT', 'success', false],
    ['ordinary PUT', '401', true], ['merge PUT', '401', false],
  ] as const)('%s %s cannot touch the next account (dispose: %s)', async (route, outcome, dispose) => {
    vi.useFakeTimers()
    const store = backingStore()
    signedInAs('anna')
    const onRev = vi.fn(), onMerged = vi.fn()
    const anna = new WorkspaceSync('i1', { onRev, onMerged, debounceMs: 60_000 })
    let ben: typeof anna | undefined
    try {
      await anna.init()
      anna.save({ note: 'Anna' })
      let sent!: () => void
      const inFlight = new Promise<void>((resolve) => { sent = resolve })
      let settle!: () => void
      if (route === 'merge PUT') putWorkspace.mockRejectedValueOnce(new ApiError(409, 'revision'))
      putWorkspace.mockImplementationOnce(() => new Promise((resolve, reject) => {
        settle = () => outcome === '401'
          ? reject(new ApiError(401, 'expired'))
          : resolve({ workspace_rev: 9 })
        sent()
      }))
      const saving = anna.flush()
      await inFlight
      if (dispose) {
        anna.save({ note: 'Anna’s final edit' })
        anna.dispose() // synchronous final cache write before Ben opens the Einsatz
      }
      signedInAs('ben')
      ben = new WorkspaceSync('i1', { debounceMs: 60_000 })
      await ben.init()
      ben.save({ note: 'Ben' })
      ben.flushKeepalive() // persist Ben's dirty state without a full-document upload
      const main = 'kp-front-ws-i1'
      const parked = main + '::anna'
      const benEntry = store.get(main)
      const annaEntry = store.get(parked)
      expect(benEntry).toMatchObject({ owner: 'ben', dirty: true, workspace: { note: 'Ben' } })
      expect(annaEntry).toMatchObject({ owner: 'anna', dirty: true, workspace: { note: dispose ? 'Anna’s final edit' : 'Anna' } })
      onRev.mockClear(); onMerged.mockClear()
      settle()
      await saving
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
      expect(store.get(main)).toEqual(benEntry)
      expect(store.get(parked)).toEqual(annaEntry)
      expect(onRev).not.toHaveBeenCalled()
      expect(onMerged).not.toHaveBeenCalled()
      // A late denial must not lock the new authenticated engine.
      await ben.flush()
      expect(ben.hasUnsynced).toBe(false)
    } finally {
      anna.dispose()
      ben?.dispose()
      vi.useRealTimers()
    }
  })
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

describe('WorkspaceSync · a different user cannot destroy or inherit another’s unsynced work', () => {
  it('user B opening the incident never clobbers user A’s dirty cache — A recovers it on return (SEC-10 regression)', async () => {
    backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })

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

  it('leaves each owner’s parked draft recoverable when a handover interrupts a re-home write', async () => {
    const main = 'kp-front-ws-i1'
    const aParked = cachedEdit('u1')
    const bParked = { ...cachedEdit('u2'), workspace: { entities: [{ id: 'b-draft' }] } }
    const store = backingStore({ [main + '::u1']: aParked, [main + '::u2']: bParked })
    signedInAs('u1')
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    idbSet.mockImplementationOnce(async (key, entry) => {
      store.set(key, entry)
      signedInAs('u2')
      return true
    })
    const a = new WorkspaceSync('i1')
    await expect(a.init()).rejects.toThrow('Incident selection cancelled')
    a.dispose()
    expect(store.get(main + '::u2')).toEqual(bParked)
    const b = new WorkspaceSync('i1')
    expect((await b.init()).workspace).toEqual(bParked.workspace)
    b.dispose()
    signedInAs('u1')
    const returned = new WorkspaceSync('i1')
    expect((await returned.init()).workspace).toEqual(aParked.workspace)
    expect(store.get(main + '::u1')).toBeUndefined()
    expect(store.get(main + '::u2')).toEqual(bParked)
    returned.dispose()
  })

  it.each(['success', 'offline', '401'] as const)('ignores a late init GET %s after another account opens and edits', async (reply) => {
    const main = 'kp-front-ws-i1'
    const mine = cachedEdit('u1')
    const incoming = { entities: [{ id: 'incoming draft' }] }
    const server = { entities: [{ id: 'server' }] }
    const store = backingStore({ [main]: mine })
    signedInAs('u1')
    const started = gate(), finish = gate()
    getWorkspace.mockImplementationOnce(async () => {
      started.open()
      await finish.wait
      if (reply !== 'success') throw new ApiError(reply === '401' ? 401 : 0, reply)
      return { workspace: { entities: [{ id: 'first account server copy' }] }, workspace_rev: 8 }
    }).mockResolvedValue({ workspace: server, workspace_rev: 9 })
    const onRev = vi.fn()
    const a = new WorkspaceSync('i1', { onRev })
    const opening = a.init()
    await started.wait
    signedInAs('u2')
    const b = new WorkspaceSync('i1')
    expect((await b.init()).workspace).toEqual(server)
    b.save(incoming)
    b.flushKeepalive()
    finish.open()
    await expect(opening).rejects.toThrow('Incident selection cancelled')
    a.dispose()
    expect(onRev).not.toHaveBeenCalled()
    expect(store.get(main + '::u1')).toEqual(mine)
    expect(store.get(main)).toMatchObject({ owner: 'u2', dirty: true, workspace: incoming })
    await b.flush()
    expect(b.hasUnsynced).toBe(false)
    b.dispose()
  })

  it.each(['main read', 'parked read', 'role write'] as const)('cancels the old init after its %s while the next owner is editing', async (step) => {
    const main = 'kp-front-ws-i1', parked = main + '::u1'
    const mine = { ...cachedEdit('u1'), shape: 'all' }
    const store = backingStore({ [step === 'parked read' ? parked : main]: mine })
    signedInAs('u1')
    const started = gate(), finish = gate()
    const pause = async () => { started.open(); await finish.wait }
    if (step === 'role write') {
      idbSet.mockImplementationOnce(async (key, entry) => { store.set(key, entry); await pause(); return true })
    } else {
      let once = true
      idbGet.mockImplementation(async (key) => {
        const result = store.get(key) ?? null
        if (once && key === (step === 'parked read' ? parked : main)) { once = false; await pause() }
        return result as never
      })
    }
    const a = new WorkspaceSync('i1', { slice: 'record' })
    const opening = a.init()
    await started.wait
    signedInAs('u2')
    const b = new WorkspaceSync('i1')
    expect((await b.init()).workspace).toEqual({})
    const incoming = { entities: [{ id: 'incoming draft' }] }
    b.save(incoming)
    b.flushKeepalive()
    finish.open()
    await expect(opening).rejects.toThrow('Incident selection cancelled')
    a.dispose()
    expect(store.get(main)).toMatchObject({ owner: 'u2', dirty: true, workspace: incoming })
    expect(store.get(parked)).toEqual(mine)
    expect(getWorkspace).toHaveBeenCalledTimes(1) // only the current selection got as far as its GET
    b.dispose()
  })
})

// ⚠️ A main slot that could not be READ is not an empty one (23.09.2026). Taken for «no cache»,
// init() adopted the server copy and wrote it over the slot — on a device back from being offline,
// the only copy of its unsynced edits.
describe('WorkspaceSync.init · an unreadable cache is not an empty one', () => {
  it('never writes the server copy over a slot it could not read, and says the cache is not durable', async () => {
    signedInAs('u1')
    const store = backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') }) // the main slot, once
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') }) // …and the probe on the first write
    vi.useFakeTimers()
    try {
      const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
      const statuses: string[] = []
      sync.onStatus = (s) => statuses.push(s)
      const { fromCache } = await sync.init()
      expect(fromCache).toBe(false)
      sync.save({ entities: [{ id: 'server-side-edit' }] })
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
      expect(idbSet).not.toHaveBeenCalledWith('kp-front-ws-i1', expect.anything())
      expect(store.get('kp-front-ws-i1')).toEqual(cachedEdit('u1'))
      expect(statuses[statuses.length - 1]).toBe('storage')
      sync.dispose()
    } finally { vi.useRealTimers() }
  })

  it('lifts the block once a later read answers and the slot holds nothing unsynced', async () => {
    signedInAs('u1')
    const store = backingStore()
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') })
    vi.useFakeTimers()
    try {
      const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
      await sync.init()
      sync.save({ entities: [{ id: 'e1' }] })
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS) // blocked: probes the slot, finds it empty
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS) // …and the re-armed write lands
      expect(store.get('kp-front-ws-i1')).toMatchObject({ workspace: { entities: [{ id: 'e1' }] }, dirty: true })
      sync.dispose()
    } finally { vi.useRealTimers() }
  })
})

// ⚠️ …and while it stays unread, or turns out to hold unsynced edits, the badge may not be green
// (24.09.2026): the late read used to leave those edits in the slot until a reload, neither
// merged nor pushed, with the session reporting 'synced'.
describe('WorkspaceSync · the unread slot is re-read, and its unsynced edits are merged and pushed', () => {
  it('reports storage from init on, without waiting for a save', async () => {
    signedInAs('u1')
    backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') })
    vi.useFakeTimers()
    try {
      const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
      await sync.init()
      expect(sync.syncStatus).toBe('storage')
      sync.dispose()
    } finally { vi.useRealTimers() }
  })

  it('a later read that finds this user’s unsynced edits merges them over the session and pushes the union', async () => {
    signedInAs('u1')
    const store = backingStore({ 'kp-front-ws-i1': cachedEdit('u1') })
    getWorkspace.mockResolvedValue({ workspace: { entities: [{ id: 'remote' }] }, workspace_rev: 7 })
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') }) // init's read
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') }) // the first re-read, too
    vi.useFakeTimers()
    try {
      const sync = new WorkspaceSync('i1', { debounceMs: 1_000 })
      const applied: unknown[] = []
      sync.onApplyMerged = (ws) => applied.push(ws)
      await sync.init()
      expect(sync.syncStatus).toBe('storage')
      await vi.advanceTimersByTimeAsync(SLOT_PROBE_MS) // still unreadable: stays storage, tries again
      expect(sync.syncStatus).toBe('storage')
      expect(sync.hasUnsynced).toBe(false)

      await vi.advanceTimersByTimeAsync(SLOT_PROBE_MS) // this one answers: the slot holds 'mine'
      const union = { entities: [{ id: 'remote' }, { id: 'mine' }] }
      expect(applied).toEqual([expect.objectContaining({ entities: expect.arrayContaining(union.entities) })])
      expect(sync.hasUnsynced).toBe(true)
      expect(sync.syncStatus).toBe('storage') // the union is in memory only…
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
      expect(store.get('kp-front-ws-i1')).toMatchObject({ dirty: true, baseRev: 7 })
      expect(sync.syncStatus).toBe('pending') // …until the slot holds it

      await vi.advanceTimersByTimeAsync(1_000) // the debounce pushes the union at the server's rev
      expect(putWorkspace).toHaveBeenCalledTimes(1)
      const [, pushed, rev] = putWorkspace.mock.calls[0] as [string, { entities: { id: string }[] }, number]
      expect(rev).toBe(7)
      expect(pushed.entities.map((e) => e.id).sort()).toEqual(['mine', 'remote'])
      expect(sync.syncStatus).toBe('synced')
      // …and the slot is written again, now with what the server has
      await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
      expect(store.get('kp-front-ws-i1')).toMatchObject({ dirty: false, baseRev: 8 })
      sync.dispose()
    } finally { vi.useRealTimers() }
  })

  it('a later read that finds the slot clean lifts the storage status without any save', async () => {
    signedInAs('u1')
    backingStore()
    idbRead.mockResolvedValueOnce({ ok: false, error: new Error('io') })
    vi.useFakeTimers()
    try {
      const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
      await sync.init()
      expect(sync.syncStatus).toBe('storage')
      await vi.advanceTimersByTimeAsync(SLOT_PROBE_MS)
      expect(sync.syncStatus).toBe('synced')
      sync.dispose()
    } finally { vi.useRealTimers() }
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

  it('a 401 on the follow-on PUT denies reads before the shared drain finishes', async () => {
    const store = backingStore()
    signedInAs('u1')
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    putWorkspace.mockImplementationOnce(async () => {
      sync.save({ n: 2 }) // a newer edit lands while the first request is in flight
      return { workspace: null, workspace_rev: 8 }
    }).mockRejectedValueOnce(new ApiError(401, 'Nicht angemeldet'))

    await Promise.all([sync.flush(), sync.flush()])

    expect(putWorkspace).toHaveBeenCalledTimes(2)
    expect(sync.hasUnsynced).toBe(true)
    expect(sync.syncStatus).toBe('error')
    sync.dispose()
    expect(store.get('kp-front-ws-i1')).toMatchObject({ workspace: { n: 2 }, owner: 'u1', dirty: true })
    store.set('kp-front-ws-i2', cachedEdit('u1'))
    getWorkspace.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const other = new WorkspaceSync('i2')
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
