import { describe, expect, it, test } from 'vitest'
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

  // Decided 11.09.: an unset count is the ONE person the panel shows («Anzahl Personen: 1»,
  // stepper floor 1) — even with animals set. An animals-only rescue is unrepresentable in the
  // editor; a Stall with twelve cows reads «1 Person und 12 Tiere» until the stepper can say 0.
  it('counts the panel’s one person even when animals are set', () => {
    expect(geretteteFromLage([r({ fields: { 'Anzahl Tiere': '12' } })])).toEqual({ personen: 1, tiere: 12 })
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

  // Since unified objects the caller's union is entities + board, and ONE record shows up in
  // both — the same id, `count` carried verbatim. Three rescued people were offered as six.
  it('counts one record once, however many views of it arrive', () => {
    const onLage = r({ id: 'obj-1', count: 3 })
    const onPlan = r({ id: 'obj-1', count: 3 })
    expect(geretteteFromLage([onLage, onPlan])).toEqual({ personen: 3, tiere: 0 })
    // two georeferenced plans project the same record onto both
    expect(geretteteFromLage([onLage, onPlan, r({ id: 'obj-1', count: 3 })])).toEqual({ personen: 3, tiere: 0 })
  })

  it('still sums two genuinely different symbols', () => {
    expect(geretteteFromLage([r({ id: 'obj-1', count: 3 }), r({ id: 'obj-2', count: 2 })]))
      .toEqual({ personen: 5, tiere: 0 })
  })

  // The editors normalise a count of 1 to `undefined` (IncidentWorkspace · Whiteboard) — this
  // used to read as 0 Personen once animals were set, losing the person the panel showed.
  test('a symbol stating 1 Person and 3 Tiere offers that one person', () => {
    expect(geretteteFromLage([r({ fields: { 'Anzahl Tiere': '3' } })])).toEqual({ personen: 1, tiere: 3 })
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
