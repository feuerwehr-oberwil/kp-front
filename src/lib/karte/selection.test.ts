import { describe, expect, it } from 'vitest'
import type { LngLat } from '../../types'
import type { StationObject } from '../api/stationReference'
import { objectAt, selPoint, type ObjectOutlines } from './selection'

// Synthetic Musterdorf: a row of two houses named by its addresses («Reihe 1-3»), whose second
// house is also an object of its own («Haus 3»), and the row's underground garage.
const sq = (x: number, y: number): LngLat[] => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]
const H1 = sq(0, 0)
const H3 = sq(2, 0)
const GARAGE = sq(0, 5)
const OUTLINES: ObjectOutlines = new Map([
  ['reihe', { rings: [H1, H3], main: H1, under: [GARAGE] }],
  ['haus3', { rings: [H3], main: H3, under: [] }],
])
const none = () => false

describe('objectAt · which object a point on the map hits', () => {
  it('a house two objects claim is the one whose point stands in it', () => {
    expect(objectAt(OUTLINES, [2.5, 0.5], none)).toEqual({ id: 'haus3', ring: H3 })
    expect(objectAt(OUTLINES, [0.5, 0.5], none)).toEqual({ id: 'reihe', ring: H1 })
  })

  it('an object\'s underground structure finds the object, with no building ring', () => {
    expect(objectAt(OUTLINES, [0.5, 5.5], none)).toEqual({ id: 'reihe', ring: null })
  })

  it('a hidden object is passed over: the row still takes its house', () => {
    expect(objectAt(OUTLINES, [2.5, 0.5], (id) => id === 'haus3')).toEqual({ id: 'reihe', ring: H3 })
    expect(objectAt(OUTLINES, [9, 9], none)).toBeNull()
  })
})

describe('selPoint · where a selection stands', () => {
  const obj = (o: Partial<StationObject> & Pick<StationObject, 'id'>): StationObject => ({
    name: o.id, kind: 'objekt', address: null, lat: null, lng: null, aliases: [], plans: [], floors: [], egid: null,
    footprint: null, lastVisit: null, ...o,
  })
  const byId = new Map([
    ['schloss', obj({ id: 'schloss', lat: 47.5238, lng: 7.5702 })],
    ['ohne', obj({ id: 'ohne', address: 'Schlossgasse 9' })],
  ])

  it('an object at its point, else where its address was geocoded to', () => {
    expect(selPoint({ kind: 'object', id: 'schloss', approxAt: [1, 1] }, byId)).toEqual([7.5702, 47.5238])
    expect(selPoint({ kind: 'object', id: 'ohne', approxAt: [7.57, 47.52] }, byId)).toEqual([7.57, 47.52])
    expect(selPoint({ kind: 'object', id: 'ohne' }, byId)).toBeNull()
  })

  it('a building and a pin where they were tapped', () => {
    expect(selPoint({ kind: 'building', at: [7.1, 47.1], ring: null, address: null }, byId)).toEqual([7.1, 47.1])
    expect(selPoint({ kind: 'pin', at: [7.2, 47.2] }, byId)).toEqual([7.2, 47.2])
    expect(selPoint(null, byId)).toBeNull()
  })
})
