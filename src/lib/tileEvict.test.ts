import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVICT_BATCH, evictOldTiles, withTileEviction } from './tileEvict'

// The precedence this encodes: a map tile is re-downloadable in a second, the Lagekarte is not.
// So when the device is full it is the scenery that goes, not the incident record.

function installCaches(names: string[], keys: string[]) {
  const deleted: string[] = []
  const cache = {
    keys: async () => keys.map((url) => ({ url })),
    delete: async (r: { url: string }) => { deleted.push(r.url); return true },
  }
  vi.stubGlobal('caches', {
    has: async (n: string) => names.includes(n),
    open: async () => cache,
  })
  return { deleted }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('evictOldTiles', () => {
  it('drops the OLDEST entries first (cache.keys is insertion-ordered)', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const { deleted } = installCaches(['map-tiles'], urls)
    expect(await evictOldTiles(3)).toBe(3)
    expect(deleted).toEqual(['t0', 't1', 't2'])
  })

  it('caps at the batch size, so one rescue cannot wipe a prefetched area', async () => {
    const urls = Array.from({ length: EVICT_BATCH + 250 }, (_, i) => `t${i}`)
    const { deleted } = installCaches(['map-tiles'], urls)
    expect(await evictOldTiles()).toBe(EVICT_BATCH)
    expect(deleted).toHaveLength(EVICT_BATCH)
  })

  it('is a no-op when there is no tile cache, or it is empty', async () => {
    installCaches([], ['t0'])
    expect(await evictOldTiles()).toBe(0)
    installCaches(['map-tiles'], [])
    expect(await evictOldTiles()).toBe(0)
  })

  it('never becomes its own failure', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(evictOldTiles()).resolves.toBe(0)
    vi.stubGlobal('caches', { has: async () => { throw new Error('denied') } })
    await expect(evictOldTiles()).resolves.toBe(0)
  })
})

describe('withTileEviction', () => {
  it('does not touch the cache when the write succeeds', async () => {
    const { deleted } = installCaches(['map-tiles'], ['t0'])
    const write = vi.fn().mockResolvedValue(true)
    expect(await withTileEviction(write)).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(deleted).toEqual([]) // nothing sacrificed for a write that was fine
  })

  it('evicts and retries once when the write is refused', async () => {
    const { deleted } = installCaches(['map-tiles'], ['t0', 't1'])
    const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await withTileEviction(write)).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(deleted.length).toBeGreaterThan(0)
  })

  it('retries ONCE, not in a loop — if tiles were not the problem, stop destroying them', async () => {
    installCaches(['map-tiles'], Array.from({ length: 5000 }, (_, i) => `t${i}`))
    const write = vi.fn().mockResolvedValue(false)
    expect(await withTileEviction(write)).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not retry when there was nothing to evict', async () => {
    installCaches(['map-tiles'], [])
    const write = vi.fn().mockResolvedValue(false)
    expect(await withTileEviction(write)).toBe(false)
    expect(write).toHaveBeenCalledTimes(1) // no point re-running against unchanged space
  })
})
