import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { idbGet, idbRead, idbSet, idbDel, readThrough, __resetIdbForTests } from './idb'
import { ApiError } from './api'

beforeEach(() => {
  // Fresh in-memory IndexedDB per test; reset the module's cached open promise to match.
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
})

describe('idb key-value store (IndexedDB backend)', () => {
  it('round-trips a structured-clone value (no JSON serialization)', async () => {
    const value = { a: 1, nested: { list: [1, 2, 3] }, flag: true }
    await idbSet('k1', value)
    expect(await idbGet('k1')).toEqual(value)
  })

  it('returns null for a missing key (cache miss)', async () => {
    expect(await idbGet('nope')).toBeNull()
  })

  it('overwrites on a repeated set', async () => {
    await idbSet('k', 1)
    await idbSet('k', 2)
    expect(await idbGet('k')).toBe(2)
  })

  it('deletes a key', async () => {
    await idbSet('k', { x: 1 })
    await idbDel('k')
    expect(await idbGet('k')).toBeNull()
  })
})

// ⚠️ A failed read and a miss used to be the same `null`, so a hydrate that then wrote back
// replaced whatever the store could not deliver (23.09.2026). And a connection the browser
// closed stayed cached for the rest of the session.
describe('idbRead · a miss is not a failure', () => {
  /** Capture every connection this module opens. */
  function trackOpens() {
    const conns: IDBDatabase[] = []
    const factory = globalThis.indexedDB
    const open = factory.open.bind(factory)
    vi.spyOn(factory, 'open').mockImplementation((...args: Parameters<IDBFactory['open']>) => {
      const req = open(...args)
      req.addEventListener('success', () => conns.push(req.result))
      return req
    })
    return conns
  }

  it('answers ok with null for a missing key, and ok with the value for a stored one', async () => {
    expect(await idbRead('nope')).toEqual({ ok: true, value: null })
    await idbSet('k', { x: 1 })
    expect(await idbRead('k')).toEqual({ ok: true, value: { x: 1 } })
  })

  it('answers ok: false when the transaction fails, where idbGet still says null', async () => {
    await idbSet('k', { x: 1 })
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('disk I/O', 'UnknownError')
    })
    try {
      expect(await idbRead('k')).toMatchObject({ ok: false })
      expect(await idbGet('k')).toBeNull()
    } finally { spy.mockRestore() }
    expect(await idbRead('k')).toEqual({ ok: true, value: { x: 1 } })
  })

  it('reopens once when the cached connection was closed under it', async () => {
    const conns = trackOpens()
    await idbSet('k', 1)
    conns[0].close() // every later transaction on it throws InvalidStateError
    expect(await idbRead('k')).toEqual({ ok: true, value: 1 })
    expect(await idbSet('k', 2)).toBe(true)
    expect(conns).toHaveLength(2)
  })

  it('forgets a connection the browser reports closed, and one another tab asks to give up', async () => {
    const conns = trackOpens()
    await idbSet('k', 1)
    conns[0].onclose?.call(conns[0], new Event('close'))
    expect(await idbGet('k')).toBe(1)
    expect(conns).toHaveLength(2)
    const close = vi.spyOn(conns[1], 'close')
    conns[1].onversionchange?.call(conns[1], new Event('versionchange') as IDBVersionChangeEvent)
    expect(close).toHaveBeenCalled()
    expect(await idbGet('k')).toBe(1)
    expect(conns).toHaveLength(3)
  })
})

describe('idb localStorage fallback when IndexedDB is unavailable', () => {
  beforeEach(() => {
    // Shim localStorage for the node env, then make indexedDB.open throw so every call has to
    // fall back — the Safari-private-mode / locked-down-WebView path.
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage
    ;(globalThis as { indexedDB?: unknown }).indexedDB = { open() { throw new Error('no idb') } }
    __resetIdbForTests()
  })

  it('reads and writes through localStorage (JSON) instead', async () => {
    await idbSet('k', { x: 1 })
    expect(await idbGet('k')).toEqual({ x: 1 })
    // All new fallbacks use one namespace, independently of why IDB failed. The plain key is
    // retained only as a read path for data written by older app versions.
    expect(localStorage.getItem('kp-idb-fb:k')).toBe(JSON.stringify({ x: 1 }))
    expect(localStorage.getItem('k')).toBeNull()

    // If IndexedDB is available on the next launch, the namespaced fallback remains canonical;
    // changing browser modes must not strand the value written during the failed launch.
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
    expect(await idbGet('k')).toEqual({ x: 1 })
  })

  it('round-trips delete via the fallback', async () => {
    await idbSet('kp-front-ws-a', 1)
    await idbDel('kp-front-ws-a')
    expect(await idbGet('kp-front-ws-a')).toBeNull()
  })
})

describe('idb open that never answers', () => {
  // WebKit after a page restore, Chromium on a corrupt LevelDB: `indexedDB.open()` fires
  // neither onsuccess nor onerror. Every caller awaits the same cached open, so this used to
  // hold the whole boot path behind the static splash — kill and relaunch repeated it.
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage
    // a request object that never fires anything
    ;(globalThis as { indexedDB?: unknown }).indexedDB = { open: () => ({}) }
    __resetIdbForTests()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('gives up after the bound and falls back to localStorage', async () => {
    const pending = idbSet('k', { x: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBe(true)
    expect(localStorage.getItem('kp-idb-fb:k')).toBe(JSON.stringify({ x: 1 }))
    // and the decision sticks: the next call does not wait another five seconds
    const read = idbGet('k')
    await vi.advanceTimersByTimeAsync(0)
    expect(await read).toEqual({ x: 1 })
  })
})

// The read-through cache: one implementation of «fetch → vet → cache → on failure serve the
// last copy», so the offline predicate cannot drift between call sites again.
describe('readThrough', () => {
  const KEY = 'rt'

  /** Wait for the fire-and-forget cache write. `readThrough` deliberately does not await it
   *  (a wedged IDB open must not delay the value), so the test does. */
  const settled = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
    for (let i = 0; i < 50; i++) {
      const v = await read()
      if (v != null) return v
      await new Promise((r) => setTimeout(r, 0))
    }
    return null
  }

  it('serves a fresh fetch and caches it', async () => {
    const res = await readThrough(KEY, async () => ({ n: 1 }))
    expect(res).toEqual({ value: { n: 1 }, source: 'network' })
    expect(await settled(() => idbGet(KEY))).toEqual({ n: 1 })
  })

  it('falls back to the cache when the server could not be asked', async () => {
    await idbSet(KEY, { n: 7 })
    const res = await readThrough(KEY, () => Promise.reject(new ApiError(503, 'restarting')))
    expect(res).toEqual({ value: { n: 7 }, source: 'cache' })
  })

  it('rethrows a refusal — that is an answer, not silence', async () => {
    await idbSet(KEY, { n: 7 })
    await expect(readThrough(KEY, () => Promise.reject(new ApiError(403, 'nope')))).rejects.toThrow(ApiError)
  })

  it('uses the fallback when neither network nor cache has an answer', async () => {
    const res = await readThrough(KEY, () => Promise.reject(new ApiError(0, 'offline')), { fallback: () => ({ n: 0 }) })
    expect(res).toEqual({ value: { n: 0 }, source: 'fallback' })
  })

  it('treats a fetched value that fails validation as a miss, and never caches it', async () => {
    const res = await readThrough<number[]>(KEY, async () => [], {
      validate: (v): v is number[] => Array.isArray(v) && v.length > 0,
      fallback: () => [-1],
    })
    expect(res).toEqual({ value: [-1], source: 'fallback' })
    await new Promise((r) => setTimeout(r, 0))
    expect(await idbGet(KEY)).toBeNull()
  })
})
