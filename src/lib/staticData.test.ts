import { describe, expect, it, vi } from 'vitest'
import { createStaticDataset, STATIC_DATA_RETRY_MS } from './staticData'

// The loader under the fetched hazard datasets (lib/unHazard, lib/erg). What matters in
// the field: ONE fetch however many surfaces ask, data survives a flaky first request, a
// dead network never throws into a render, and subscribers hear about arrival exactly once.

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response
const fail = () => ({ ok: false, json: async () => null }) as Response
const noSleep = async () => {}

describe('createStaticDataset', () => {
  it('is null before the load, fetches once for any number of ensure() calls', async () => {
    const impl = vi.fn(async () => ok(['x']))
    const ds = createStaticDataset<string[]>('d.json', impl, noSleep)
    expect(ds.get()).toBeNull()
    const [a, b] = await Promise.all([ds.ensure(), ds.ensure()])
    await ds.ensure()
    expect(a).toEqual(['x'])
    expect(b).toEqual(['x'])
    expect(ds.get()).toEqual(['x'])
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('retries a failed fetch on the backoff and succeeds', async () => {
    let calls = 0
    const impl = vi.fn(async () => (++calls < 2 ? fail() : ok({ v: 1 })))
    const slept: number[] = []
    const ds = createStaticDataset<{ v: number }>('d.json', impl, async (ms) => { slept.push(ms) })
    expect(await ds.ensure()).toEqual({ v: 1 })
    expect(slept).toEqual([STATIC_DATA_RETRY_MS[0]])
  })

  it('gives up after the backoff without throwing; a later ensure() starts over', async () => {
    let dead = true
    const impl = vi.fn(async () => { if (dead) throw new TypeError('offline'); return ok(7) })
    const ds = createStaticDataset<number>('d.json', impl, noSleep)
    expect(await ds.ensure()).toBeNull()
    expect(impl).toHaveBeenCalledTimes(1 + STATIC_DATA_RETRY_MS.length)
    dead = false
    expect(await ds.ensure()).toBe(7)
  })

  it('bumps version and notifies subscribers when data lands (set() included)', () => {
    const ds = createStaticDataset<string>('d.json', vi.fn(), noSleep)
    const heard = vi.fn()
    const off = ds.subscribe(heard)
    expect(ds.version()).toBe(0)
    ds.set('data')
    expect(ds.version()).toBe(1)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    ds.set('again')
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
