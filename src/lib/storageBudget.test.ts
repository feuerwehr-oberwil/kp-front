import { describe, expect, it } from 'vitest'
import { PREFETCH_BUDGET_SHARE, TILE_BYTES, estimateStorage, fittedTileCap, fmtBytes, prefetchFit } from './storageBudget'

// Guards «Alles für offline laden» from filling the bucket the incident record has to write into.
// The important asymmetry: a device that WON'T report its quota must still be allowed to try —
// refusing to cache because we couldn't measure would be a worse failure than trying and losing
// some tiles.

const budget = (free: number) => ({ usage: 0, quota: free, free })

describe('prefetchFit', () => {
  it('permits a download that fits inside the allowed share', () => {
    const f = prefetchFit(budget(1000 * TILE_BYTES), 100)
    expect(f.fits).toBe(true)
    expect(f.needBytes).toBe(100 * TILE_BYTES)
  })

  it('refuses one that does not', () => {
    expect(prefetchFit(budget(100 * TILE_BYTES), 1000).fits).toBe(false)
  })

  it('reserves headroom — a download may not consume ALL free space', () => {
    const free = 1000 * TILE_BYTES
    // exactly the free space is refused; the allowance is the share of it
    expect(prefetchFit(budget(free), 1000).fits).toBe(false)
    expect(prefetchFit(budget(free), Math.floor(1000 * PREFETCH_BUDGET_SHARE)).fits).toBe(true)
  })

  it('counts plans/geodata bytes alongside the tiles', () => {
    const free = 100 * TILE_BYTES
    expect(prefetchFit(budget(free), 10).fits).toBe(true)
    expect(prefetchFit(budget(free), 10, free).fits).toBe(false)
  })

  it('permits everything when the budget is UNKNOWN (never refuse on ignorance)', () => {
    const f = prefetchFit(null, 1_000_000)
    expect(f.fits).toBe(true)
    expect(f.allowBytes).toBeNull()
    expect(f.needBytes).toBe(1_000_000 * TILE_BYTES) // still reported, for the copy
  })

  it('refuses on a genuinely full device', () => {
    expect(prefetchFit(budget(0), 1).fits).toBe(false)
  })
})

describe('estimateStorage', () => {
  const withNavigator = async (storage: unknown) => {
    const prev = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', { value: { storage }, configurable: true })
    try { return await estimateStorage() } finally {
      Object.defineProperty(globalThis, 'navigator', { value: prev, configurable: true })
    }
  }

  it('returns usage/quota/free when supported', async () => {
    expect(await withNavigator({ estimate: async () => ({ usage: 400, quota: 1000 }) }))
      .toEqual({ usage: 400, quota: 1000, free: 600 })
  })

  it('floors free at 0 when usage somehow exceeds quota', async () => {
    expect((await withNavigator({ estimate: async () => ({ usage: 1200, quota: 1000 }) }))?.free).toBe(0)
  })

  it('returns null (unknown, not full) when unsupported, incomplete, or throwing', async () => {
    expect(await withNavigator(undefined)).toBeNull()
    expect(await withNavigator({ estimate: async () => ({}) })).toBeNull()
    expect(await withNavigator({ estimate: async () => ({ usage: 1, quota: 0 }) })).toBeNull()
    expect(await withNavigator({ estimate: async () => { throw new Error('no') } })).toBeNull()
  })
})

describe('fmtBytes', () => {
  it('scales the unit and keeps operator-readable precision', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(940 * 1024)).toBe('940 KB')
    expect(fmtBytes(1.5 * 1024 ** 2)).toBe('1.5 MB')
    expect(fmtBytes(120 * 1024 ** 2)).toBe('120 MB')
    expect(fmtBytes(1.4 * 1024 ** 3)).toBe('1.4 GB')
    expect(fmtBytes(20 * 1024 ** 3)).toBe('20 GB')
  })

  it('degrades safely on nonsense', () => {
    expect(fmtBytes(NaN)).toBe('–')
    expect(fmtBytes(-1)).toBe('–')
  })
})

// The "load it reduced" path. Capping the tile list drops the FINEST zoom levels first (
// tilesForBounds walks coarse→fine), so the operator keeps the whole area at lower detail rather
// than a corner of it at full detail — the right thing to sacrifice for orientation at 3am.
describe('fittedTileCap', () => {
  it('returns the number of tiles that fit inside the allowance', () => {
    const free = 1000 * TILE_BYTES
    expect(fittedTileCap(budget(free), 5000)).toBe(Math.floor(1000 * PREFETCH_BUDGET_SHARE))
  })

  it('never exceeds the hard cap even on a roomy device', () => {
    expect(fittedTileCap(budget(1024 ** 4), 1200)).toBe(1200)
  })

  it('subtracts the warm payload (plans/geodata) before dividing', () => {
    const free = 1000 * TILE_BYTES
    const allow = Math.floor(free * PREFETCH_BUDGET_SHARE)
    expect(fittedTileCap(budget(free), 5000, allow - 10 * TILE_BYTES)).toBe(10)
  })

  it('returns 0 when not even the warm payload fits — nothing worth offering', () => {
    expect(fittedTileCap(budget(1000), 1200, 10 * 1024 ** 2)).toBe(0)
    expect(fittedTileCap(budget(0), 1200)).toBe(0)
  })

  it('allows the full cap when the budget is unknown', () => {
    expect(fittedTileCap(null, 1200, 999 * 1024 ** 2)).toBe(1200)
  })
})
