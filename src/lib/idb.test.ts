import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { idbGet, idbSet, idbDel, __resetIdbForTests } from './idb'

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
