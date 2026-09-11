import { describe, expect, it } from 'vitest'
import raw from '../../public/erg.json'
import { ergVersionLabel, lookupErg, __setErgData, type ErgData } from './erg'

// The dataset is a fetched static asset now (lib/staticData): pin that lookups miss (not
// throw) before it lands, then inject the real data the way the boot prefetch would.
const beforeLoad = { hit: lookupErg('1005'), version: ergVersionLabel() }
__setErgData(raw as unknown as ErgData)

describe('before the dataset lands', () => {
  it('lookups miss and the version label is empty, nothing throws', () => {
    expect(beforeLoad.hit).toBeNull()
    expect(beforeLoad.version).toBe('')
  })
})

// The values asserted here were verified against the official NOAA CAMEO pages
// (cameochemicals.noaa.gov/unna/<UN>) on 2026-07-02 — see tools/erg-source/README.md.
describe('lookupErg', () => {
  it('carries the dataset version for the visible source label', () => {
    expect(ergVersionLabel()).toBe('ERG2024')
  })

  it('UN 1005 (ammonia): guide 125, TIH with Table-1 small-spill distances, large → Table 3', () => {
    const e = lookupErg('1005')!
    expect(e.g).toBe(125)
    expect(e.tih?.length).toBeTruthy()
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
    expect(e.tih?.length).toBeFalsy()
  })

  it('UN 1203 (petrol): plain guide entry without distances', () => {
    const e = lookupErg('1203')!
    expect(e.g).toBe(128)
    expect(e.tih?.length).toBeFalsy()
  })

  it('unknown or empty input returns null', () => {
    expect(lookupErg('9999999')).toBeNull()
    expect(lookupErg('')).toBeNull()
    expect(lookupErg('abc')).toBeNull()
  })
})
