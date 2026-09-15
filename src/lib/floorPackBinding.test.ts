import { describe, expect, it } from 'vitest'
import { floorPackOf, frameAspect, joinShifts } from './floorPackBinding'
import { inheritPlanBinding } from './incidentPlanBindings'
import type { GeorefPair } from './georef'

const pairs: GeorefPair[] = [
  { plan: { x: 0.1, y: 0.8 }, lngLat: { lng: 7.555, lat: 47.511 }, kind: 'gesetzt' },
  { plan: { x: 0.9, y: 0.8 }, lngLat: { lng: 7.556, lat: 47.5117 }, kind: 'gesetzt' },
]
const sheet = { id: 'object:wyss:plan:modul6', objectId: 'wyss', planId: 'modul6', datasetId: 'plan:wyss:modul6', planVersion: 2, title: 'Modul 6' }
const approval = { id: 1, pairs, aspect: 1.414, approved_at: '2026-09-14' }

describe('a floor pack as the stack sees it', () => {
  it('one floor per page: whole pages, no shift, the fit page\'s floor 0 is the frame', () => {
    const floors = [{ page: 0, index: 1, name: null }, { page: 1, index: 0, name: 'EG' }, { page: 2, index: -1, name: null }]
    const b = { ...inheritPlanBinding(sheet, approval, null, false, floors), page: 1 }
    const pack = floorPackOf([b], 'wyss')!
    expect(pack.frame).toEqual([0, 0, 1, 1])
    expect(pack.tiles[1]).toMatchObject({ url: '/api/reference/plan%3Awyss%3Amodul6?v=2#page=1', clip: [0, 0, 1, 1], shift: [0, 0] })
    expect(pack.fit).toBeTruthy()
    expect(floorPackOf([b], 'other')).toBeNull()
  })
  it('regions of one A0: the reference clip is the frame, siblings shift through their joins', () => {
    const floors = [
      { page: 0, index: 1, name: null, clip: [0.02, 0.5, 0.35, 0.95] as [number, number, number, number], join: { to: 0, at: [0.05, 0.9] as [number, number], there: [0.41, 0.45] as [number, number] } },
      { page: 0, index: 0, name: 'EG', clip: [0.38, 0.02, 0.98, 0.5] as [number, number, number, number] },
    ]
    const pack = floorPackOf([{ ...inheritPlanBinding(sheet, approval, null, false, floors), page: 0 }], 'wyss')!
    expect(pack.frame).toEqual([0.38, 0.02, 0.98, 0.5])
    expect(pack.tiles[0].shift).toEqual([0, 0])
    expect(pack.tiles[1].shift[0]).toBeCloseTo(0.36); expect(pack.tiles[1].shift[1]).toBeCloseTo(-0.45)
    expect(pack.tiles[1].clip).toEqual([0.02, 0.5, 0.35, 0.95])
    // a landscape A0 (w/h 1.414) region 0.6 wide × 0.48 tall → box h/w ≈ 0.566
    expect(frameAspect(pack.frame, 1.414)).toBeCloseTo(0.48 / (0.6 * 1.414), 3)
  })
})

describe('joins chain in both directions', () => {
  const sheetB = { ...sheet }
  it('A joins B, C joins B, D is joined FROM C – all four resolve; an island falls back to its corner', () => {
    const c = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0, y0, x1, y1]
    const floors = [
      { page: 0, index: 0, name: null, clip: c(0.5, 0.5, 0.9, 0.9) }, // B, the reference
      { page: 0, index: 1, name: null, clip: c(0.0, 0.5, 0.4, 0.9), join: { to: 0, at: [0.1, 0.6] as [number, number], there: [0.6, 0.6] as [number, number] } }, // A → B
      { page: 0, index: 2, name: null, clip: c(0.0, 0.0, 0.4, 0.4), join: { to: 0, at: [0.1, 0.1] as [number, number], there: [0.6, 0.6] as [number, number] } }, // C → B
      { page: 0, index: 3, name: null, clip: c(0.5, 0.0, 0.9, 0.4) }, // D, joined from C below
      { page: 0, index: -1, name: null, clip: c(0.2, 0.2, 0.3, 0.3) }, // island
    ]
    floors[2] = { ...floors[2], join: floors[2].join } // keep C → B
    const withD = floors.map((f) => f.index === 2 ? f : f)
    // C also says «my 0.1/0.1 is D's 0.6/0.1»? no – D joins from C: add that join on C's side is impossible (one join per floor), so D joins C
    withD[3] = { ...withD[3], join: { to: 2, at: [0.6, 0.1], there: [0.1, 0.1] } }
    const pack = floorPackOf([{ ...inheritPlanBinding(sheetB, approval, null, false, withD), page: 0 }], 'wyss')!
    expect(pack.tiles[1].shift.map((v) => +v.toFixed(3))).toEqual([0.5, 0])
    expect(pack.tiles[2].shift.map((v) => +v.toFixed(3))).toEqual([0.5, 0.5])
    expect(pack.tiles[3].shift.map((v) => +v.toFixed(3))).toEqual([0, 0.5]) // through C
    expect(pack.tiles[-1].shift.map((v) => +v.toFixed(3))).toEqual([0.3, 0.3]) // corner fallback: ref x0 − island x0
  })
})


it('resolves joins across pages and within non-reference pages before defaults', () => {
  const ref = { page: 0, index: 0, name: null }
  const shifts = joinShifts([
    ref,
    { page: 1, index: 1, name: null, join: { to: 0, at: [0.2, 0.3], there: [0.6, 0.7] } },
    { page: 1, index: 2, name: null, join: { to: 1, at: [0.1, 0.1], there: [0.2, 0.3] } },
    { page: 2, index: 3, name: null },
    { page: 2, index: 4, name: null, join: { to: 3, at: [0.1, 0.1], there: [0.5, 0.6] } },
  ], ref)
  expect(shifts.get(1)?.map(v => +v.toFixed(3))).toEqual([0.4, 0.4])
  expect(shifts.get(2)?.map(v => +v.toFixed(3))).toEqual([0.5, 0.6])
  expect(shifts.get(3)).toEqual([0, 0])
  expect(shifts.get(4)?.map(v => +v.toFixed(3))).toEqual([0.4, 0.5])
})


it('resolves a cross-page join pointing away from the reference', () => {
  const ref = { page: 0, index: 0, name: null, join: { to: 1, at: [0.6, 0.7] as [number, number], there: [0.2, 0.3] as [number, number] } }
  const shifts = joinShifts([ref, { page: 1, index: 1, name: null }], ref)
  expect(shifts.get(1)?.map(v => +v.toFixed(3))).toEqual([0.4, 0.4])
})
