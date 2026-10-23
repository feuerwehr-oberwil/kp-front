import { describe, expect, it } from 'vitest'
import type { LngLat } from '../../types'
import type { StationObject } from '../api/stationReference'
import { LABEL_MIN_ZOOM, overlaps, placeTags, samePlacement, tagRank, tagRect, tagSize, type TagCandidate } from './labels'
import { footprintRings, objectBuildings, ringAt } from './places'

// Synthetic station data only.
const tag = (id: string, x: number, y: number, rank = 0, w = 100, h = 26): TagCandidate => ({ id, x, y, w, h, rank })
const VIEW = { width: 390, height: 844 }

describe('name tags — which fit', () => {
  it('places the higher rank and drops the tag that would overlap it', () => {
    const shown = placeTags([tag('a', 200, 400, 1), tag('b', 230, 410, 5), tag('c', 200, 600, 0)], VIEW)
    expect([...shown.keys()].sort()).toEqual(['b', 'c'])
  })

  it('keeps a small gap between tags, not just «no overlap»', () => {
    // 100 px wide tags whose centres are 102 px apart: 2 px apart, inside the 4 px gap
    expect(placeTags([tag('a', 100, 300, 2), tag('b', 202, 300, 1)], VIEW).has('b')).toBe(false)
    expect(placeTags([tag('a', 100, 300, 2), tag('b', 210, 300, 1)], VIEW).has('b')).toBe(true)
  })

  it('never under the chrome, never off the map', () => {
    const topBar = { left: 0, top: 0, right: 390, bottom: 120 }
    const navBar = { left: 0, top: 760, right: 390, bottom: 844 }
    const shown = placeTags([tag('under-bar', 200, 110), tag('under-nav', 200, 770), tag('off', -20, 300), tag('free', 200, 400)], { ...VIEW, occupied: [topBar, navBar] })
    expect([...shown.keys()]).toEqual(['free'])
    expect(shown.get('free')).toBe(0)
  })

  it('a tag at a side edge slides inward, but never off its anchor', () => {
    // centred on x=20 a 100 px tag would start at −30: it slides 34 px right (4 px margin)
    expect(placeTags([tag('edge', 20, 400)], VIEW).get('edge')).toBe(34)
    expect(placeTags([tag('right', 360, 400)], VIEW).get('right')).toBe(-24)
    // 34 px of slide is all a 100 px tag has (50 − 16): an anchor at x=2 stays a dot
    expect(placeTags([tag('far', 2, 400)], VIEW).has('far')).toBe(false)
    // the slid box is what collides
    const both = placeTags([tag('edge', 20, 400, 1), tag('next', 150, 400, 0)], VIEW)
    expect(both.has('next')).toBe(false)
  })

  it('the selected object always carries its tag, whatever it covers', () => {
    const shown = placeTags([tag('big', 200, 400, 99), tag('sel', 210, 405, 0)], { ...VIEW, always: 'sel', occupied: [{ left: 0, top: 380, right: 390, bottom: 420 }] })
    expect(shown.has('sel')).toBe(true)
    expect(shown.has('big')).toBe(false) // it would cover the selected tag
  })

  // owner R3
  it('a tag is centred on its object\'s point — the marker never moves', () => {
    const r = tagRect({ id: 'x', x: 100, y: 50, w: 80, h: 26, rank: 0 })
    expect(r).toEqual({ left: 60, top: 37, right: 140, bottom: 63 })
    expect(overlaps(r, { left: 99, top: 49, right: 101, bottom: 51 })).toBe(true)
  })

  it('ranks selected › Einsatzobjekt › more plans › the rest, and what was shown wins a tie', () => {
    const r = (kind: string, plans: number, selected = false, wasShown = false) => tagRank({ kind, plans, selected, wasShown })
    expect(r('objekt', 0, true)).toBeGreaterThan(r('einsatzobjekt', 9))
    expect(r('einsatzobjekt', 1)).toBeGreaterThan(r('objekt', 9))
    expect(r('einsatzobjekt', 4)).toBeGreaterThan(r('einsatzobjekt', 3, false, true))
    expect(r('objekt', 2, false, true)).toBeGreaterThan(r('objekt', 2))
  })

  it('the placement is stable: the same input, the same answer', () => {
    const cands = [tag('b', 200, 400), tag('a', 210, 405), tag('c', 220, 410)]
    const one = placeTags(cands, VIEW)
    expect(samePlacement(one, placeTags([...cands].reverse(), VIEW))).toBe(true)
    expect([...one.keys()]).toEqual(['a']) // equal rank: by id
  })

  it('an estimated tag is as tall as the CSS one and carries no plan count', () => {
    expect(tagSize(70)).toEqual({ w: 89, h: 26 })
    expect(LABEL_MIN_ZOOM).toBe(16)
  })
})

// ── several buildings per object ─────────────────────────────────────────────────────────────

const sq = (lng: number, lat: number, d = 0.0002): LngLat[] => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d]]
const closed = (r: LngLat[]) => [...r, r[0]]
const HOUSE = sq(7.5700, 47.5200)
const GYM = sq(7.5710, 47.5200)
const obj = (o: Partial<StationObject>): StationObject => ({
  id: 'schule', name: 'Schulhaus Feld', kind: 'einsatzobjekt', address: null, lat: 47.5201, lng: 7.5701, aliases: [], plans: [], floors: [],
  egid: null, footprint: null, lastVisit: null, ...o,
})

describe('the buildings of an object', () => {
  it('the server set wins, every building of it, the one the point is in as `main`', () => {
    const fp = { type: 'MultiPolygon', coordinates: [[closed(HOUSE)], [closed(GYM)]] }
    const b = objectBuildings(obj({ footprint: fp }), [])
    expect(b?.rings).toEqual([HOUSE, GYM])
    expect(b?.main).toEqual(HOUSE)
    // a tap on ANY of them finds the object (KarteApp · onMapClick reads ringAt over the set)
    expect(ringAt(b!.rings, [7.5711, 47.5201])).toEqual(GYM)
  })

  it('without one: the OSM outline the point lies in, as before — never a neighbour', () => {
    const b = objectBuildings(obj({}), [GYM, HOUSE])
    expect(b).toEqual({ rings: [HOUSE], main: HOUSE, under: [] })
    expect(objectBuildings(obj({ lat: 47.5300 }), [GYM, HOUSE])).toBeNull()
  })

  // review round 3
  it('a named row\'s underground garage rides along apart, to be drawn dashed', () => {
    const fp = { type: 'MultiPolygon', coordinates: [[closed(HOUSE)]] }
    const garage = sq(7.5700, 47.5198, 0.0004)
    const b = objectBuildings(obj({ footprint: fp, underground: { type: 'MultiPolygon', coordinates: [[closed(garage)]] } }), [])
    expect(b?.rings).toEqual([HOUSE])
    expect(b?.under).toEqual([garage])
    // a tap on the garage finds the object too (KarteApp · onMapClick reads ringAt over `under`)
    expect(ringAt(b!.under, [7.5702, 47.5199])).toEqual(garage)
  })

  it('a point on the grounds but in none of the buildings still draws them, with no main', () => {
    const fp = { type: 'MultiPolygon', coordinates: [[closed(HOUSE)], [closed(GYM)]] }
    const b = objectBuildings(obj({ footprint: fp, lat: 47.5201, lng: 7.5706 }), [])
    expect(b?.rings).toHaveLength(2)
    expect(b?.main).toBeNull()
  })

  it('a plan-less object has its buildings like any other; garbage is no rings', () => {
    // review round 3: no key-box kind that owns no building
    expect(objectBuildings(obj({ kind: 'objekt', plans: [], footprint: { type: 'Polygon', coordinates: [closed(HOUSE)] } }), [])?.rings).toEqual([HOUSE])
    expect(footprintRings({ type: 'Polygon', coordinates: [closed(HOUSE)] })).toEqual([HOUSE])
    expect(footprintRings({ type: 'Point', coordinates: [7, 47] })).toEqual([])
    expect(footprintRings(null)).toEqual([])
    expect(footprintRings({ type: 'MultiPolygon', coordinates: [[[[7, 47], ['x', 1]]]] })).toEqual([])
  })
})
