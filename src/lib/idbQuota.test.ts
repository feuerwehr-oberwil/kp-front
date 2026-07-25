import { beforeEach, describe, expect, it, vi } from 'vitest'
import { idbDel, idbGet, idbSet, isStorageDegraded, onStorageDegraded, requestPersistentStorage, __resetIdbForTests } from './idb'

// What happens when the origin's storage budget is exhausted — the case the offline cache was
// never told about. fake-indexeddb doesn't model quota, and neither does it need to: the shape
// of a quota failure is simply "put() errors, the store keeps its previous value, get() still
// works". This hand-rolled store reproduces exactly that shape, under our control.
//
// The claim under test (read off the code in idb.ts, not yet observed): a failed write leaves the
// OLDER value readable, and idbGet happily returns it — because `idbUnavailable` is only set when
// the database fails to OPEN, never when a transaction fails. For WorkspaceSync that means a
// stale `workspace` AND a stale `baseRev`/`base`/`dirty` on the next reopen.

type Mode = 'ok' | 'writes-fail'

function installFakeIdb(mode: Mode, seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed))
  let writeAttempts = 0

  const request = <T>(settle: (req: { onsuccess: (() => void) | null; onerror: (() => void) | null; result?: T; error?: unknown }) => void) => {
    const req: { onsuccess: (() => void) | null; onerror: (() => void) | null; result?: T; error?: unknown } = {
      onsuccess: null, onerror: null,
    }
    // async so the caller has attached its handlers first (mirrors real IDB dispatch)
    setTimeout(() => settle(req), 0)
    return req
  }

  const store = {
    get: (k: string) => request<unknown>((req) => { req.result = data.get(k); req.onsuccess?.() }),
    put: (v: unknown, k: string) => request<undefined>((req) => {
      writeAttempts++
      if (mode === 'writes-fail') {
        // Real quota failure: the request errors and the store keeps its previous value.
        req.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        req.onerror?.()
        return
      }
      data.set(k, v)
      req.onsuccess?.()
    }),
    delete: (k: string) => request<undefined>((req) => { data.delete(k); req.onsuccess?.() }),
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
  }

  ;(globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = { result: db, error: null }
      setTimeout(() => (req.onsuccess as (() => void) | undefined)?.(), 0)
      return req
    },
  }
  __resetIdbForTests()
  return { data, writes: () => writeAttempts }
}

// localStorage fallback, absent from this jsdom-less env (see storageMigration.test.ts).
function installLocalStorage(capacityBytes = Infinity) {
  const store = new Map<string, string>()
  let used = 0
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      const s = String(v)
      if (used + s.length > capacityBytes) {
        throw new DOMException('exceeded the quota', 'QuotaExceededError')
      }
      used += s.length
      store.set(k, s)
    },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); used = 0 },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
  return store
}

beforeEach(() => { installLocalStorage() })

describe('idb under an exhausted storage budget', () => {
  it('sanity: the fake round-trips when writes succeed', async () => {
    installFakeIdb('ok')
    await idbSet('k', { rev: 2 })
    expect(await idbGet('k')).toEqual({ rev: 2 })
  })

  it('reports the failure instead of swallowing it (the stale read is now announced)', async () => {
    // rev 1 is already cached from before the device filled up
    installFakeIdb('writes-fail', { 'kp-front-ws-inc1': { workspace: { a: 1 }, baseRev: 1, dirty: false } })
    const ls = installLocalStorage(50) // far too small for a workspace blob → fallback fails too

    const ok = await idbSet('kp-front-ws-inc1', { workspace: { a: 1, b: 2 }, baseRev: 1, dirty: true })

    // Nothing durable was written anywhere — and the caller is TOLD, which is the whole point:
    // WorkspaceSync can now surface it instead of believing the edit is cached.
    expect(ok).toBe(false)
    expect(isStorageDegraded()).toBe(true)
    expect(ls.size).toBe(0)
    // The pre-failure value is still what a read returns — unavoidable, it's all that exists.
    // The bug was never that; it was returning it with no way for anyone to know.
    expect(await idbGet('kp-front-ws-inc1')).toEqual({ workspace: { a: 1 }, baseRev: 1, dirty: false })
  })

  it('notifies subscribers on the degraded transition, once', async () => {
    installFakeIdb('writes-fail', { k: { old: true } })
    installLocalStorage(10)
    const seen: boolean[] = []
    const off = onStorageDegraded((d) => seen.push(d))
    await idbSet('k', { big: 'x'.repeat(5000) })
    await idbSet('k', { big: 'y'.repeat(5000) })
    expect(seen).toEqual([true]) // de-duped, not one event per failed save
    off()
  })

  it('stops re-attempting a localStorage fallback that cannot ever fit', async () => {
    installFakeIdb('writes-fail', { k: { old: true } })
    const ls = installLocalStorage(10)
    const setItem = vi.spyOn(ls === null ? ({} as never) : localStorage, 'setItem')
    await idbSet('k', { big: 'x'.repeat(5000) })
    await idbSet('k', { big: 'x'.repeat(5000) })
    await idbSet('k', { big: 'x'.repeat(5000) })
    // tried once, learned it's hopeless, and stopped paying the large stringify every save
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('a later successful write clears the degraded flag', async () => {
    installFakeIdb('writes-fail', { k: { old: true } })
    installLocalStorage(10)
    await idbSet('k', { big: 'x'.repeat(5000) })
    expect(isStorageDegraded()).toBe(true)
    installFakeIdb('ok') // space freed (e.g. tiles evicted)
    expect(await idbSet('k', { fresh: true })).toBe(true)
    expect(isStorageDegraded()).toBe(false)
  })

  it('finds the localStorage fallback copy again — it is no longer write-only', async () => {
    installFakeIdb('writes-fail')
    const ls = installLocalStorage()
    expect(await idbSet('tiny', { a: 1 })).toBe(true) // small payload really does fit
    expect(ls.get('kp-idb-fb:tiny')).toBe(JSON.stringify({ a: 1 }))
    // idbGet now consults localStorage on an EMPTY IndexedDB read, so the copy is found after a
    // reload too (when nothing in memory remembers that this key was written there).
    __resetIdbForTests()
    expect(await idbGet('tiny')).toEqual({ a: 1 })
  })

  it('never lets a stale IndexedDB entry outrank a newer fallback copy', async () => {
    // IDB holds rev 1; the write of rev 2 fails there and lands in localStorage instead
    const fake = installFakeIdb('writes-fail', { k: { rev: 1 } })
    installLocalStorage()
    await idbSet('k', { rev: 2 })
    // the now-stale IDB entry is dropped, so exactly one source of truth remains
    expect(fake.data.has('k')).toBe(false)
    expect(await idbGet('k')).toEqual({ rev: 2 })
  })

  it('idbDel clears BOTH stores, so no fallback copy can be resurrected', async () => {
    installFakeIdb('writes-fail')
    const ls = installLocalStorage()
    await idbSet('k', { a: 1 })          // lands in the quota fallback
    installFakeIdb('ok', { k: { a: 1 } }) // and suppose IDB also has a copy
    await idbDel('k')
    expect(ls.has('kp-idb-fb:k')).toBe(false)
    expect(await idbGet('k')).toBeNull()
  })
})

describe('requestPersistentStorage', () => {
  it('is a no-op that resolves false when the API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestPersistentStorage()).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('skips the request when persistence is already granted', async () => {
    const persist = vi.fn()
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('requests it when not yet granted, and reports a refusal', async () => {
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => false } })
    await expect(requestPersistentStorage()).resolves.toBe(false)
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => true } })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    vi.unstubAllGlobals()
  })

  it('never throws when the call itself rejects', async () => {
    vi.stubGlobal('navigator', { storage: { persisted: async () => { throw new Error('nope') }, persist: async () => true } })
    await expect(requestPersistentStorage()).resolves.toBe(false)
    vi.unstubAllGlobals()
  })
})
