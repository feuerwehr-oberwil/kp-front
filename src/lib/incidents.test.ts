import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer but keep the REAL ApiError so WorkspaceSync's `e instanceof ApiError`
// 409 branch still fires. getWorkspace/putWorkspace live in ./incidents itself and call
// apiGet/apiPut under the hood, so mocking ./api intercepts them without touching the SUT.
const { apiGet, apiPut, apiBeacon } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiBeacon: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPut, apiBeacon, apiGetRaw: vi.fn() }
})

import { ApiError } from './api'
import { __resetIdbForTests } from './idb'
import { WorkspaceSync, objectsNearIncidentResilient, getObjectResilient } from './incidents'

const ID = '11111111-1111-1111-1111-111111111111'
const wsPut = (rev: number) => ({ workspace: null, workspace_rev: rev })

// The offline cache now lives in IndexedDB (idb.ts). WorkspaceSync writes it fire-and-forget
// (the in-memory entry is authoritative), so a test that reopens the cache must let the pending
// IDB put commit first — flushIdb() drains a macrotask, which fake-indexeddb uses to settle.
const flushIdb = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  // Fresh in-memory IndexedDB per test so cached workspaces never leak across cases, and reset
  // idb.ts's cached open promise so it reopens against the new factory.
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  apiGet.mockReset()
  apiPut.mockReset()
  apiBeacon.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspaceSync.flush — happy path', () => {
  it('pushes a dirty workspace and advances baseRev, clearing dirty', async () => {
    apiPut.mockResolvedValue(wsPut(5))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    expect(sync.hasUnsynced).toBe(true)

    await sync.flush()

    expect(apiPut).toHaveBeenCalledTimes(1)
    expect(apiPut).toHaveBeenCalledWith(
      `/api/incidents/${ID}/workspace`,
      expect.objectContaining({ workspace: { a: 1 }, base_rev: 0 }),
    )
    expect(sync.rev).toBe(5)
    expect(sync.hasUnsynced).toBe(false)
  })
})

describe('WorkspaceSync.flushKeepalive — teardown beacon', () => {
  it('beacons the dirty workspace at the current baseRev (survives page unload)', () => {
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })

    sync.flushKeepalive()

    expect(apiBeacon).toHaveBeenCalledTimes(1)
    expect(apiBeacon).toHaveBeenCalledWith(
      `/api/incidents/${ID}/workspace`,
      { workspace: { a: 1 }, base_rev: 0 },
      'PUT',
    )
    // fire-and-forget: dirty stays set so a same-device reopen / next flush still reconciles
    expect(sync.hasUnsynced).toBe(true)
    // and it never touches the normal async transport
    expect(apiPut).not.toHaveBeenCalled()
    sync.dispose() // clear the armed debounce timer so it can't fire into a later test
  })

  it('is a no-op when there is nothing dirty to flush', () => {
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.flushKeepalive()
    expect(apiBeacon).not.toHaveBeenCalled()
  })

  it('is a no-op after dispose()', () => {
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    sync.dispose()
    sync.flushKeepalive()
    expect(apiBeacon).not.toHaveBeenCalled()
  })
})

const ids = (arr: { id: string }[]) => arr.map((x) => x.id)

describe('WorkspaceSync conflict resolution (409) — three-way auto-merge', () => {
  it('unions concurrent additions and pushes the merged result, applied in place', async () => {
    // First PUT conflicts; resolveConflict reads the server (rev 9), merges, second PUT wins.
    apiPut
      .mockRejectedValueOnce(new ApiError(409, 'conflict'))
      .mockResolvedValueOnce(wsPut(10))
    apiGet.mockResolvedValueOnce({ workspace: { drawings: [{ id: 'd1' }], entities: [] }, workspace_rev: 9 })

    const onMerged = vi.fn()
    const applied: [unknown, number][] = []
    const sync = new WorkspaceSync(ID, { debounceMs: 0, onMerged })
    sync.onApplyMerged = (ws, rev) => applied.push([ws, rev])
    sync.save({ drawings: [{ id: 'd2' }], entities: [] }) // I added d2; they added d1
    await sync.flush()

    expect(apiPut).toHaveBeenCalledTimes(2)
    const body = apiPut.mock.calls[1][1] as { workspace: { drawings: { id: string }[] }; base_rev: number }
    expect(body.base_rev).toBe(9)
    expect(ids(body.workspace.drawings)).toEqual(['d1', 'd2']) // both survive, server order then mine
    expect(applied).toHaveLength(1) // merged result surfaced in place (no remount)
    expect(ids((applied[0][0] as { drawings: { id: string }[] }).drawings)).toEqual(['d1', 'd2'])
    expect(onMerged).toHaveBeenCalledTimes(1)
    expect(sync.rev).toBe(10)
    expect(sync.hasUnsynced).toBe(false)
  })

  it('a local delete beats a concurrent remote edit (object stays gone)', async () => {
    apiGet.mockResolvedValueOnce({ workspace: { drawings: [{ id: 'a' }] }, workspace_rev: 1 }) // init → ancestor
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    await sync.init()

    sync.save({ drawings: [] }) // I deleted 'a'
    apiPut.mockRejectedValueOnce(new ApiError(409, 'conflict')).mockResolvedValueOnce(wsPut(3))
    apiGet.mockResolvedValueOnce({ workspace: { drawings: [{ id: 'a', x: 9 }] }, workspace_rev: 2 }) // they moved 'a'
    await sync.flush()

    const body = apiPut.mock.calls[1][1] as { workspace: { drawings: { id: string }[] } }
    expect(body.workspace.drawings).toEqual([]) // delete wins over the concurrent edit
    expect(sync.rev).toBe(3)
    expect(sync.hasUnsynced).toBe(false)
  })

  it('re-bases a local edit that lands during the merge PUT, keeping the remote addition', async () => {
    // call0: the conflicting PUT (409). call1: the merge PUT (slow, so we can sneak an edit in).
    // call2: the re-armed flush pushing the re-merged content.
    let resolveMergePut!: (v: unknown) => void
    apiPut
      .mockRejectedValueOnce(new ApiError(409, 'conflict'))
      .mockImplementationOnce(() => new Promise((res) => { resolveMergePut = res }))
      .mockResolvedValueOnce(wsPut(3))
    apiGet.mockResolvedValueOnce({ workspace: { drawings: [{ id: 'x' }] }, workspace_rev: 2 }) // they added x

    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ drawings: [{ id: 'm1' }] }) // I added m1
    const flushP = sync.flush()
    // let the 409 → getWorkspace → merge PUT chain run until the (slow) merge PUT is in flight
    for (let i = 0; i < 20 && !resolveMergePut; i++) await Promise.resolve()

    sync.save({ drawings: [{ id: 'm1' }, { id: 'm2' }] }) // I draw m2 while the merge PUT is in flight
    resolveMergePut(wsPut(2))
    await flushP
    await new Promise((r) => setTimeout(r, 0)) // drain the re-armed flush
    await new Promise((r) => setTimeout(r, 0))

    const last = apiPut.mock.calls[apiPut.mock.calls.length - 1][1] as { workspace: { drawings: { id: string }[] } }
    expect(ids(last.workspace.drawings).sort()).toEqual(['m1', 'm2', 'x']) // remote x + both my edits
    expect(sync.hasUnsynced).toBe(false)
  })

  it('falls back to onServerWorkspace (remount) when no in-place applier is registered', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(409, 'conflict')).mockResolvedValueOnce(wsPut(12))
    apiGet.mockResolvedValueOnce({ workspace: { entities: [{ id: 'e1' }], drawings: [] }, workspace_rev: 11 })

    const onServerWorkspace = vi.fn()
    const sync = new WorkspaceSync(ID, { debounceMs: 0, onServerWorkspace })
    sync.save({ entities: [], drawings: [] })
    await sync.flush()

    expect(onServerWorkspace).toHaveBeenCalledTimes(1)
    expect(sync.rev).toBe(12)
  })
})

describe('WorkspaceSync — flush must not drop the newest edit', () => {
  it('keeps dirty when a save() lands mid-PUT, and re-flushes the newest content', async () => {
    // Make the in-flight PUT slow so we can sneak a save() in while it's pending. The first
    // PUT resolves at rev 1; because saveSeq advanced during it, the engine keeps the newest
    // edit dirty and re-arms a flush, which pushes the newest content at the advanced base.
    let resolveFirst!: (v: unknown) => void
    apiPut
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce(wsPut(2))

    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ v: 1 })
    const flushP = sync.flush() // begins the slow first PUT

    // A newer edit arrives while the PUT is still in flight.
    sync.save({ v: 2 })
    resolveFirst(wsPut(1))
    await flushP

    // The newest edit must NOT have been silently marked synced.
    expect(sync.hasUnsynced).toBe(true)

    // The re-armed flush (debounceMs 0) pushes the newest content; drain microtasks/timers.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(apiPut).toHaveBeenCalledTimes(2)
    expect(apiPut.mock.calls[1][1]).toMatchObject({ workspace: { v: 2 } })
    expect(sync.rev).toBe(2)
    expect(sync.hasUnsynced).toBe(false)
  })
})

describe('WorkspaceSync.syncStatus — lifecycle surfaced to the UI', () => {
  it('goes pending on save and synced after a successful flush, notifying onStatus', async () => {
    apiPut.mockResolvedValue(wsPut(1))
    const seen: string[] = []
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.onStatus = (s) => seen.push(s)
    expect(sync.syncStatus).toBe('synced')

    sync.save({ a: 1 })
    expect(sync.syncStatus).toBe('pending')

    await sync.flush()
    expect(sync.syncStatus).toBe('synced')
    expect(seen).toEqual(['pending', 'synced'])
  })

  it('reports offline when a flush fails on the network (status 0), staying dirty', async () => {
    apiPut.mockRejectedValue(new ApiError(0, 'offline'))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()

    expect(sync.syncStatus).toBe('offline')
    expect(sync.hasUnsynced).toBe(true) // not dropped — retried later
  })

  it('reports error on a non-network failure (e.g. 500), staying dirty', async () => {
    apiPut.mockRejectedValue(new ApiError(500, 'boom'))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()

    expect(sync.syncStatus).toBe('error')
    expect(sync.hasUnsynced).toBe(true)
  })

  it('returns to synced after recovering from an offline flush', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(0, 'offline')).mockResolvedValueOnce(wsPut(1))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()
    expect(sync.syncStatus).toBe('offline')

    await sync.flush() // reconnected — retry succeeds
    expect(sync.syncStatus).toBe('synced')
    expect(sync.hasUnsynced).toBe(false)
  })
})

describe('WorkspaceSync.init — reopen / offline reload (don\'t lose the record)', () => {
  // Simulate "a previous session left unsynced edits in the offline cache" by saving on one
  // instance, disposing it (clears its armed flush timer), then opening a fresh instance on the
  // same incident id — exactly what a tab reload / app relaunch does.
  async function withCachedDirtyEdit(edit: Record<string, unknown>) {
    const prior = new WorkspaceSync(ID, { debounceMs: 0 })
    prior.save(edit)
    prior.dispose() // keep the cache, drop the timer so it can't flush into a later assertion
    await flushIdb() // let the fire-and-forget IDB write commit before we reopen the incident
  }

  it('preserves unsynced offline edits across a reload when the server rev is unchanged', async () => {
    await withCachedDirtyEdit({ entities: [{ id: 'mine' }] }) // edited offline at baseRev 0
    apiGet.mockResolvedValueOnce({ workspace: {}, workspace_rev: 0 }) // server still at 0

    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    const r = await sync.init()
    // init() reads the offline cache (now in IndexedDB, hence async), rehydrating the engine as
    // pending and returning my unsynced edit even though the server rev is unchanged.
    expect(r.fromCache).toBe(true)
    expect((r.workspace as { entities: { id: string }[] }).entities).toEqual([{ id: 'mine' }])
    expect(sync.hasUnsynced).toBe(true) // my offline edit survived the reopen, still queued
    expect(sync.syncStatus).toBe('pending')
  })

  it('returns the cached workspace when the server is unreachable (offline reopen)', async () => {
    await withCachedDirtyEdit({ entities: [{ id: 'x' }] })
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))

    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    const r = await sync.init()
    expect(r.fromCache).toBe(true)
    expect((r.workspace as { entities: { id: string }[] }).entities).toEqual([{ id: 'x' }])
    expect(sync.rev).toBe(0)
    expect(sync.hasUnsynced).toBe(true) // not lost — a later flush still pushes it
  })

  it('throws when offline AND nothing is cached (a genuinely cold, offline first load)', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    const sync = new WorkspaceSync('99999999-9999-9999-9999-999999999999', { debounceMs: 0 })
    await expect(sync.init()).rejects.toBeInstanceOf(ApiError)
  })

  it('adopts the server revision when the local cache is clean', async () => {
    apiGet.mockResolvedValueOnce({ workspace: { entities: [{ id: 'srv' }] }, workspace_rev: 7 })
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })

    const r = await sync.init()
    expect(r.fromCache).toBe(false)
    expect(sync.rev).toBe(7)
    expect(sync.hasUnsynced).toBe(false)
    expect(sync.syncStatus).toBe('synced')
  })

  // Stale unsynced edits (an OLDER base than the server, because another device advanced the rev
  // while we were offline) are three-way MERGED against the server on reopen — the cold-reopen
  // analogue of the live 409 path — not dropped. Independent additions on both sides survive.
  it('merges stale unsynced offline edits against the advanced server on reopen (no data loss)', async () => {
    // Device first loads at rev 1 (so a real common ancestor is cached), edits offline, then the
    // server advances to rev 4 via another device before the reopen.
    apiGet.mockResolvedValueOnce({ workspace: { entities: [{ id: 'shared' }] }, workspace_rev: 1 })
    const prior = new WorkspaceSync(ID, { debounceMs: 0 })
    await prior.init() // base = {shared} @ rev 1
    prior.save({ entities: [{ id: 'shared' }, { id: 'mine' }] }) // offline add 'mine', dirty @ base 1
    prior.dispose()
    await flushIdb() // let the fire-and-forget IDB write commit before we reopen the incident

    apiGet.mockResolvedValueOnce({ workspace: { entities: [{ id: 'shared' }, { id: 'theirs' }] }, workspace_rev: 4 })
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    const r = await sync.init()

    expect(r.fromCache).toBe(true)
    expect(sync.rev).toBe(4)
    expect(sync.hasUnsynced).toBe(true) // the merged edits still need pushing at the new rev
    const got = (r.workspace as { entities: { id: string }[] }).entities.map((e) => e.id).sort()
    expect(got).toEqual(['mine', 'shared', 'theirs']) // my add survived AND theirs merged in
  })
})

describe('WorkspaceSync.adoptServer — live-follow rebase', () => {
  it('rebases the cache onto a polled rev, clears dirty, and updates rev + status', () => {
    const onRev = vi.fn()
    const sync = new WorkspaceSync(ID, { debounceMs: 0, onRev })
    sync.save({ entities: [{ id: 'local' }] }) // pretend a local edit is pending
    expect(sync.hasUnsynced).toBe(true)

    sync.adoptServer({ entities: [{ id: 'server' }] }, 12)

    expect(sync.rev).toBe(12)
    expect(sync.hasUnsynced).toBe(false) // adopt drops local dirty — callers gate on !hasUnsynced
    expect(sync.syncStatus).toBe('synced')
    expect(onRev).toHaveBeenCalledWith(12)
    sync.dispose() // clear the save()'s armed debounce so it can't fire into a later test
  })

  it('is a no-op after dispose()', () => {
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.dispose()
    sync.adoptServer({ a: 1 }, 5)
    expect(sync.rev).toBe(0) // unchanged
  })
})

describe('objectsNearIncidentResilient — offline object/plan listing survives an incident switch', () => {
  it('caches the listing on success and serves it on a later offline call', async () => {
    const objs = [{ id: 'o1', plans: [{ id: 'modul1' }] }]
    apiGet.mockResolvedValueOnce(objs)
    expect(await objectsNearIncidentResilient(ID)).toEqual(objs)
    await flushIdb() // let the fire-and-forget cache write commit

    // now offline (status 0): the same incident returns the cached listing instead of empty —
    // this is the fix: switching back to an incident offline still surfaces its plans.
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await objectsNearIncidentResilient(ID)).toEqual(objs)
  })

  it('returns an empty list when offline with nothing cached (degrade, do not throw)', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await objectsNearIncidentResilient('cold-id')).toEqual([])
  })

  it('rethrows a non-network error so a real failure is not masked as "no objects"', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(500, 'boom'))
    await expect(objectsNearIncidentResilient(ID)).rejects.toBeInstanceOf(ApiError)
  })
})

describe('getObjectResilient — offline picked-object cache', () => {
  it('caches on success and serves the cache offline', async () => {
    const obj = { id: 'o1', name: 'Schule', plans: [] }
    apiGet.mockResolvedValueOnce(obj)
    expect(await getObjectResilient('o1')).toEqual(obj)
    await flushIdb()

    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await getObjectResilient('o1')).toEqual(obj)
  })

  it('rethrows when offline and nothing is cached', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    await expect(getObjectResilient('missing')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('WorkspaceSync — automatic retry backoff (stuck-dirty recovery)', () => {
  it('re-flushes on its own after a server error, backing off, until the push lands', async () => {
    vi.useFakeTimers()
    apiPut
      .mockRejectedValueOnce(new ApiError(500, 'boom'))
      .mockRejectedValueOnce(new ApiError(500, 'boom'))
      .mockResolvedValueOnce(wsPut(3))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()
    expect(sync.syncStatus).toBe('error')
    expect(apiPut).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000) // 1st retry after 5s — still failing
    expect(apiPut).toHaveBeenCalledTimes(2)
    expect(sync.syncStatus).toBe('error')

    await vi.advanceTimersByTimeAsync(5_000) // 2nd retry backs off to 10s — not yet
    expect(apiPut).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000) // 10s reached — retry lands
    expect(apiPut).toHaveBeenCalledTimes(3)
    expect(sync.syncStatus).toBe('synced')
    expect(sync.hasUnsynced).toBe(false)
    sync.dispose()
  })

  it('also arms the retry when the failure is a network drop (offline)', async () => {
    vi.useFakeTimers()
    apiPut.mockRejectedValueOnce(new ApiError(0, 'offline')).mockResolvedValueOnce(wsPut(1))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()
    expect(sync.syncStatus).toBe('offline')

    await vi.advanceTimersByTimeAsync(5_000) // captive-portal style: no `online` event needed
    expect(sync.syncStatus).toBe('synced')
    sync.dispose()
  })

  it('stops retrying after dispose()', async () => {
    vi.useFakeTimers()
    apiPut.mockRejectedValue(new ApiError(500, 'boom'))
    const sync = new WorkspaceSync(ID, { debounceMs: 0 })
    sync.save({ a: 1 })
    await sync.flush()
    expect(apiPut).toHaveBeenCalledTimes(1)

    sync.dispose()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(apiPut).toHaveBeenCalledTimes(1) // no zombie flushes from a torn-down incident
  })
})
