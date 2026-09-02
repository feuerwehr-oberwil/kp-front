import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSymbolPack, SYMBOLS_CACHE_KEY, SYMBOLS_RETRY_DELAYS_MS } from './useSymbols'
import { idbGet, idbSet, __resetIdbForTests } from './idb'
import type { SymbolLibrary } from '../types'

// What is pinned here is the degradation ladder for the symbol pack: a failed fetch is retried
// with backoff, a non-2xx or a malformed body counts as a failure, the last good pack is served
// from IndexedDB when the network gives up, and only with nothing cached does the loader say so.

const PACK: SymbolLibrary = { order: ['Fahrzeuge / Mittel'], symbols: [{ name: 'Fahrzeug', cat: 'Fahrzeuge / Mittel', svg: '<svg/>' }] }
const URL = '/tactical-symbols.json'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
const http = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response

/** a fetch stub whose answers come in order; records every call */
const fetchSeq = (...answers: (Response | Error)[]) => {
  const calls: string[] = []
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    const a = answers.shift()
    if (a instanceof Error) throw a
    if (!a) throw new Error('no answer scripted')
    return a
  }) as unknown as typeof fetch
  return { impl, calls }
}

const memCache = (initial: SymbolLibrary | null = null) => {
  let stored = initial
  return {
    get: vi.fn(async () => stored),
    set: vi.fn(async (p: SymbolLibrary) => { stored = p; return true }),
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('loadSymbolPack', () => {
  it('returns the network pack first time round and caches it', async () => {
    const { impl } = fetchSeq(ok(PACK))
    const cache = memCache()
    const sleep = vi.fn(async (_ms: number) => {})
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep, cache })
    expect(res).toEqual({ pack: PACK, source: 'network' })
    expect(cache.set).toHaveBeenCalledWith(PACK)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries with the backoff delays and succeeds on a later attempt', async () => {
    const { impl, calls } = fetchSeq(new Error('Failed to fetch'), http(503), ok(PACK))
    const sleep = vi.fn(async (_ms: number) => {})
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep, cache: memCache() })
    expect(res?.source).toBe('network')
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(SYMBOLS_RETRY_DELAYS_MS.slice(0, 2))
  })

  it('treats a non-2xx and a malformed body as failures', async () => {
    const { impl, calls } = fetchSeq(http(404), ok({ nope: true }), ok('<html>'), ok(PACK))
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep: async () => {}, cache: memCache() })
    expect(res?.source).toBe('network')
    expect(calls).toHaveLength(4)
  })

  it('serves the cached pack once every attempt has failed', async () => {
    const { impl, calls } = fetchSeq(new Error('a'), new Error('b'), new Error('c'), new Error('d'))
    const cache = memCache(PACK)
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep: async () => {}, cache })
    expect(res).toEqual({ pack: PACK, source: 'cache' })
    // 1 try + one retry per delay, then the cache — never an unbounded loop
    expect(calls).toHaveLength(SYMBOLS_RETRY_DELAYS_MS.length + 1)
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('says so when the network fails and nothing is cached', async () => {
    const { impl } = fetchSeq(new Error('a'), new Error('b'), new Error('c'), new Error('d'))
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep: async () => {}, cache: memCache() })
    expect(res).toBeNull()
  })

  it('does not let a cache write failure lose the pack', async () => {
    const { impl } = fetchSeq(ok(PACK))
    const cache = { get: async () => null, set: async () => { throw new Error('quota') } }
    const res = await loadSymbolPack({ url: URL, fetchImpl: impl, sleep: async () => {}, cache })
    expect(res?.source).toBe('network')
  })

  it('bounds one fetch with a timeout signal', async () => {
    const { impl } = fetchSeq(ok(PACK))
    await loadSymbolPack({ url: URL, fetchImpl: impl, sleep: async () => {}, cache: memCache() })
    const calls = vi.mocked(impl).mock.calls as unknown as [unknown, RequestInit | undefined][]
    const [, init] = calls[0]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('the default cache', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
  })

  it('writes the pack under the documented key and reads it back on failure', async () => {
    const good = fetchSeq(ok(PACK))
    await loadSymbolPack({ url: URL, fetchImpl: good.impl, sleep: async () => {} })
    // the write is fire-and-forget; give it a tick
    await new Promise((r) => setTimeout(r, 0))
    expect(await idbGet<SymbolLibrary>(SYMBOLS_CACHE_KEY)).toEqual(PACK)
    const bad = fetchSeq(new Error('a'), new Error('b'), new Error('c'), new Error('d'))
    expect(await loadSymbolPack({ url: URL, fetchImpl: bad.impl, sleep: async () => {} })).toEqual({ pack: PACK, source: 'cache' })
  })

  it('ignores a cached value that is not a pack', async () => {
    await idbSet(SYMBOLS_CACHE_KEY, { garbage: 1 })
    const bad = fetchSeq(new Error('a'), new Error('b'), new Error('c'), new Error('d'))
    expect(await loadSymbolPack({ url: URL, fetchImpl: bad.impl, sleep: async () => {} })).toBeNull()
  })
})
