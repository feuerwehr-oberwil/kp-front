import { describe, expect, it } from 'vitest'
import { ERG_VERSION, isTih, lookupErg } from './erg'

// The values asserted here were verified against the official NOAA CAMEO pages
// (cameochemicals.noaa.gov/unna/<UN>) on 2026-07-02 — see tools/erg-source/README.md.
describe('lookupErg', () => {
  it('carries the dataset version for the visible source label', () => {
    expect(ERG_VERSION).toBe('ERG2024')
  })

  it('UN 1005 (ammonia): guide 125, TIH with Table-1 small-spill distances, large → Table 3', () => {
    const e = lookupErg('1005')!
    expect(e.g).toBe(125)
    expect(isTih(e)).toBe(true)
    expect(e.tih![0]).toMatchObject({ si: '30 m', pd: '0.1 km', pn: '0.2 km', l: 'T3' })
  })

  it('UN 1017 (chlorine): guide 124 with the verified night distance', () => {
    const e = lookupErg('UN 1017')! // tolerant of the "UN " prefix
    expect(e.g).toBe(124)
    expect(e.tih![0].pn).toBe('1.5 km')
  })

  it('UN 1010 (butadienes): polymerization-flagged, not TIH', () => {
    const e = lookupErg('1010')!
    expect(e.g).toBe(116)
    expect(e.p).toBe(true)
    expect(isTih(e)).toBe(false)
  })

  it('UN 1203 (petrol): plain guide entry without distances', () => {
    const e = lookupErg('1203')!
    expect(e.g).toBe(128)
    expect(isTih(e)).toBe(false)
  })

  it('unknown or empty input returns null', () => {
    expect(lookupErg('9999999')).toBeNull()
    expect(lookupErg('')).toBeNull()
    expect(lookupErg('abc')).toBeNull()
  })
})
