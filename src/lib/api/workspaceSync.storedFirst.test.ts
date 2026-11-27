import { beforeEach, describe, expect, it, vi } from 'vitest'

// The boot that stopped waiting for the server (lib/bootWait, finding 27): `storedFirst` answers
// init() from the stored copy at once – only from a copy every guard of open() lets through. How
// the server's state then arrives: lib/bootWait.follow.test.ts.
const getWorkspace = vi.fn()
const putWorkspace = vi.fn()
vi.mock('./workspace', () => ({
  getWorkspace: (...a: unknown[]) => getWorkspace(...a),
  putWorkspace: (...a: unknown[]) => putWorkspace(...a),
  putWorkspaceTrupps: vi.fn(),
  putWorkspaceTruppsBeacon: vi.fn(),
  putWorkspaceRecord: vi.fn(),
  putWorkspaceRecordBeacon: vi.fn(),
}))
const store = new Map<string, unknown>()
let unreadable = false
vi.mock('../idb', () => ({
  idbGet: vi.fn(async (k: string) => store.get(k) ?? null),
  idbRead: vi.fn(async (k: string) => (unreadable ? { ok: false } : { ok: true, value: store.get(k) ?? null })),
  idbSet: vi.fn(async (k: string, v: unknown) => { store.set(k, v); return true }),
  idbDel: vi.fn(async (k: string) => { store.delete(k) }),
  idbKeys: vi.fn(async () => [...store.keys()]),
  idbUpdate: vi.fn(async (k: string, f: (v: unknown) => unknown) => { store.set(k, f(store.get(k))); return true }),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { ApiError } = await import('../api')
const { WorkspaceSync, setWorkspaceCacheOwner, storedCopy } = await import('./workspaceSync')

const BASE = { entities: [{ id: 'e1' }] }
const slot = (over: Record<string, unknown> = {}) =>
  ({ workspace: BASE, base: BASE, baseRev: 4, dirty: false, lastSyncedAt: 1, owner: 'u1', ...over })

/** a workspace request the test answers by hand */
function pending() {
  let answer!: (v: { workspace: unknown; workspace_rev: number }) => void
  let refuse!: (e: unknown) => void
  getWorkspace.mockReturnValueOnce(new Promise((res, rej) => { answer = res; refuse = rej }))
  return { answer, refuse }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

/** whether init() answered before the server did */
async function answeredAtOnce(init: Promise<unknown>) {
  let done = false
  void init.then(() => { done = true }, () => { done = true })
  await settle()
  return done
}

beforeEach(() => {
  store.clear()
  unreadable = false
  getWorkspace.mockReset()
  putWorkspace.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 9 })
  setWorkspaceCacheOwner('reset')
  setWorkspaceCacheOwner('u1')
})

describe('storedFirst: the stored copy now', () => {
  it('serves this session’s own copy at once, while the request goes on', async () => {
    store.set('kp-front-ws-i1', slot())
    pending()
    const sync = new WorkspaceSync('i1', { storedFirst: true })
    const opened = await sync.init()
    expect(opened).toEqual({ workspace: BASE, rev: 4, fromCache: true })
    expect(getWorkspace).toHaveBeenCalledTimes(1)
    sync.dispose()
  })

  // ⚠️ each of open()'s guards still holds: these wait for the server as before
  it('never serves another user’s unsynced work: it is parked for them, and the open waits', async () => {
    store.set('kp-front-ws-i1', slot({ owner: 'u2', dirty: true }))
    const req = pending()
    const sync = new WorkspaceSync('i1', { storedFirst: true })
    const init = sync.init()
    expect(await answeredAtOnce(init)).toBe(false)
    expect(store.get('kp-front-ws-i1::u2')).toMatchObject({ owner: 'u2', dirty: true })
    req.answer({ workspace: { from: 'server' }, workspace_rev: 6 })
    expect((await init).workspace).toEqual({ from: 'server' })
    sync.dispose()
  })

  it('does not take an unreadable slot for an empty one: the open waits for the server', async () => {
    unreadable = true
    pending()
    const init = new WorkspaceSync('i1', { storedFirst: true }).init()
    expect(await answeredAtOnce(init)).toBe(false)
  })

  it('a denied session gets no stored copy', async () => {
    store.set('kp-front-ws-i1', slot())
    const { denyWorkspaceCache } = await import('./workspaceSync')
    denyWorkspaceCache()
    expect(await storedCopy('i1')).toBeNull()
    pending()
    expect(await answeredAtOnce(new WorkspaceSync('i1', { storedFirst: true }).init())).toBe(false)
  })

  it('parks a wider role’s unsynced work first, then serves the copy', async () => {
    store.set('kp-front-ws-i1', slot({ dirty: true, shape: 'all', workspace: { ...BASE, lage: 1 } }))
    pending()
    const sync = new WorkspaceSync('i1', { storedFirst: true, slice: 'record' })
    expect((await sync.init()).fromCache).toBe(true)
    expect(store.get('kp-front-ws-i1::__role__:u1')).toEqual([expect.objectContaining({ workspace: { ...BASE, lage: 1 } })])
    sync.dispose()
  })
})

describe('storedFirst: the request goes on', () => {
  // the narrowing: the open's own answer is never applied – an older one least of all
  it('an answer older than the copy changes nothing on screen or in the cache', async () => {
    store.set('kp-front-ws-i1', slot())
    const req = pending()
    const handed: unknown[] = []
    const sync = new WorkspaceSync('i1', { storedFirst: true, onServerWorkspace: (ws) => handed.push(ws) })
    await sync.init()
    req.answer({ workspace: { from: 'older' }, workspace_rev: 3 })
    await settle()
    await settle()
    expect(handed).toEqual([])
    expect(sync.workspace).toEqual(BASE)
    expect(sync.rev).toBe(4)
    expect(store.get('kp-front-ws-i1')).toMatchObject({ workspace: BASE, baseRev: 4 })
    sync.dispose()
  })

  it('a 401 closes the cached reads; silence leaves the copy', async () => {
    store.set('kp-front-ws-i1', slot())
    const silent = pending()
    const a = new WorkspaceSync('i1', { storedFirst: true })
    await a.init()
    silent.refuse(new ApiError(0, 'offline'))
    await settle()
    expect(await storedCopy('i1')).not.toBeNull()
    a.dispose()

    const refused = pending()
    const b = new WorkspaceSync('i1', { storedFirst: true })
    await b.init()
    refused.refuse(new ApiError(401, 'nein'))
    await settle()
    expect(await storedCopy('i1')).toBeNull()
    b.dispose()
  })
})
