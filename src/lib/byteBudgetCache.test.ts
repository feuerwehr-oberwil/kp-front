import { describe, expect, it } from 'vitest'
import { ByteBudgetCache } from './byteBudgetCache'

/** Entries weigh what they say — a stand-in for `bitmap.width * bitmap.height * 4`. */
const weighed = (budget: number) => new ByteBudgetCache<number>(() => budget, (mb) => mb)

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('ByteBudgetCache', () => {
  it('evicts the least recently used entries until the bytes fit', async () => {
    const cache = weighed(100)
    cache.set('a', Promise.resolve(40))
    cache.set('b', Promise.resolve(40))
    cache.set('c', Promise.resolve(40))
    await settle()
    expect(cache.has('a')).toBe(false)
    expect([cache.has('b'), cache.has('c')]).toEqual([true, true])
    expect(cache.bytes).toBe(80)
  })

  it('a read is a touch — the entry read last survives the next eviction', async () => {
    const cache = weighed(100)
    cache.set('a', Promise.resolve(40))
    cache.set('b', Promise.resolve(40))
    await settle()
    cache.get('a')
    cache.set('c', Promise.resolve(40))
    await settle()
    expect(cache.has('b')).toBe(false)
    expect([cache.has('a'), cache.has('c')]).toEqual([true, true])
  })

  it('never drops the newest entry, even when it alone is over budget', async () => {
    const cache = weighed(50)
    cache.set('small', Promise.resolve(10))
    cache.set('huge', Promise.resolve(83))
    await settle()
    expect(cache.has('huge')).toBe(true)
    expect(cache.has('small')).toBe(false)
  })

  it('weighs a pending entry as nothing and skips it when evicting', async () => {
    const cache = weighed(50)
    let resolve!: (v: number) => void
    cache.set('pending', new Promise<number>((r) => { resolve = r }))
    cache.set('a', Promise.resolve(30))
    cache.set('b', Promise.resolve(30))
    await settle()
    // `a` goes, not the pending bake that frees nothing
    expect([cache.has('pending'), cache.has('a'), cache.has('b')]).toEqual([true, false, true])
    resolve(30)
    await settle()
    // …and once it lands it is counted: 30 + 30 > 50, the older one goes
    expect(cache.has('pending')).toBe(false)
    expect(cache.bytes).toBe(30)
  })

  it('reads the budget live, so a shrunk budget trims on the next eviction', async () => {
    let budget = 200
    const cache = new ByteBudgetCache<number>(() => budget, (mb) => mb)
    cache.set('a', Promise.resolve(60))
    cache.set('b', Promise.resolve(60))
    await settle()
    expect(cache.size).toBe(2)
    budget = 60
    cache.evict()
    expect([cache.has('a'), cache.has('b')]).toEqual([false, true])
  })

  it('forgets a rejected entry so the next get misses and can retry', async () => {
    const cache = weighed(100)
    const p = Promise.reject(new Error('load failed'))
    p.catch(() => {})
    cache.set('a', p)
    await settle()
    expect(cache.get('a')).toBeUndefined()
  })

  it('a replaced entry does not count its old bytes', async () => {
    const cache = weighed(100)
    cache.set('a', Promise.resolve(90))
    await settle()
    cache.set('a', Promise.resolve(20))
    await settle()
    expect(cache.bytes).toBe(20)
    expect(cache.size).toBe(1)
  })
})
