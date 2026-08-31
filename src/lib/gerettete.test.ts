import { describe, expect, it } from 'vitest'
import { geretteteFromLage, geretteteOffer, type RescueCandidate } from './gerettete'

const r = (extra: Partial<RescueCandidate> = {}): RescueCandidate => ({ symbol: 'VKF Rettungen', ...extra })

describe('geretteteFromLage', () => {
  it('adds up the Anzahl Personen of every Rettungs-Symbol', () => {
    expect(geretteteFromLage([r({ count: 2 }), r({ count: 3 })])).toEqual({ personen: 5, tiere: 0 })
  })

  it('reads an untouched count as the one person the symbol marks', () => {
    expect(geretteteFromLage([r(), r()])).toEqual({ personen: 2, tiere: 0 })
  })

  it('adds the animals from their own field', () => {
    expect(geretteteFromLage([r({ count: 1, fields: { 'Anzahl Tiere': '3' } })]))
      .toEqual({ personen: 1, tiere: 3 })
  })

  // a Stall with twelve cows is «12 Tiere», not «1 Person und 12 Tiere»
  it('invents no person for an animal-only rescue', () => {
    expect(geretteteFromLage([r({ fields: { 'Anzahl Tiere': '12' } })])).toEqual({ personen: 0, tiere: 12 })
  })

  // «vermisst» / «eingesperrt» are states a rescue passes through; the ones still reading
  // «vermisst» at the end are normally the ones nobody went back to re-tap
  it('counts a rescue whatever its Status says', () => {
    const placed = [
      r({ count: 2, fields: { Status: 'gerettet' } }),
      r({ count: 1, fields: { Status: 'vermisst' } }),
      r({ count: 1, fields: { Status: 'eingesperrt' } }),
    ]
    expect(geretteteFromLage(placed)).toEqual({ personen: 4, tiere: 0 })
  })

  it('ignores every other symbol on the Lage', () => {
    expect(geretteteFromLage([{ symbol: 'VKF Feuer', count: 9 }, { symbol: undefined, count: 4 }, r({ count: 1 })]))
      .toEqual({ personen: 1, tiere: 0 })
  })

  it('ignores an unparseable or negative animal count', () => {
    expect(geretteteFromLage([r({ count: 1, fields: { 'Anzahl Tiere': 'viele' } })]))
      .toEqual({ personen: 1, tiere: 0 })
  })
})

describe('geretteteOffer', () => {
  it('offers nothing when the Lage carries no rescue', () => {
    expect(geretteteOffer({ personen: 0, tiere: 0 }, {})).toBeNull()
  })

  it('offers nothing when the form already says the same', () => {
    expect(geretteteOffer({ personen: 2, tiere: 1 }, { personen: 2, tiere: 1 })).toBeNull()
  })

  it('offers again once either side moves', () => {
    expect(geretteteOffer({ personen: 3, tiere: 1 }, { personen: 2, tiere: 1 })).toEqual({ personen: 3, tiere: 1 })
    expect(geretteteOffer({ personen: 2, tiere: 0 }, { personen: 2, tiere: 1 })).toEqual({ personen: 2, tiere: 0 })
  })

  it('treats an empty field as zero, not as «nothing to compare»', () => {
    expect(geretteteOffer({ personen: 2, tiere: 0 }, {})).toEqual({ personen: 2, tiere: 0 })
  })
})
