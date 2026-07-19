import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { idbGet, idbSet, idbDel, idbKeys, __resetIdbForTests } from './idb'

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

  it('lists all keys, and filters by prefix (enumerating workspace caches)', async () => {
    await idbSet('kp-front-ws-a', 1)
    await idbSet('kp-front-ws-b', 2)
    await idbSet('kp-front-incidents', 3)
    expect((await idbKeys()).sort()).toEqual(['kp-front-incidents', 'kp-front-ws-a', 'kp-front-ws-b'])
    expect((await idbKeys('kp-front-ws-')).sort()).toEqual(['kp-front-ws-a', 'kp-front-ws-b'])
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
    // stored as a JSON string, since localStorage is string-only
    expect(localStorage.getItem('k')).toBe(JSON.stringify({ x: 1 }))
  })

  it('round-trips delete and key listing via the fallback', async () => {
    await idbSet('kp-front-ws-a', 1)
    await idbSet('kp-front-ws-b', 2)
    expect((await idbKeys('kp-front-ws-')).sort()).toEqual(['kp-front-ws-a', 'kp-front-ws-b'])
    await idbDel('kp-front-ws-a')
    expect(await idbGet('kp-front-ws-a')).toBeNull()
  })
})
