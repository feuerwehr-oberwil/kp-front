import { describe, expect, it } from 'vitest'
import type { LngLat } from '../../types'
import { CELL_LNG, cellOf, houseIndex, ringsAround } from './outlines'
import { ringAt } from './places'

// Synthetic: a terraced row of three houses, 10 × 10 m each, that OSM maps as ONE block
// (Karte Haus round 1: Storchenweg 2/4/6).
const M_LNG = 1 / (111_320 * Math.cos((47.52 * Math.PI) / 180))
const M_LAT = 1 / 110_540
const W = 7.5579, S = 47.5241
const box = (e0: number, n0: number, e1: number, n1: number): LngLat[] =>
  [[W + e0 * M_LNG, S + n0 * M_LAT], [W + e1 * M_LNG, S + n0 * M_LAT], [W + e1 * M_LNG, S + n1 * M_LAT], [W + e0 * M_LNG, S + n1 * M_LAT]]
const at = (e: number, n: number): LngLat => [W + e * M_LNG, S + n * M_LAT]
const ROW = [box(0, 0, 10, 10), box(10, 0, 20, 10), box(20, 0, 30, 10)]
const BLOCK = box(0, 0, 30, 10)
const SHED = box(50, 0, 56, 6) // OSM has it, the survey's set does not (outside the Einsatzgebiet)

describe('ringsAround — the house under the finger', () => {
  const houses = houseIndex(ROW)
  const osm = [BLOCK, SHED]

  it('taps ONE house of a terraced row, never the OSM block', () => {
    const p = at(15, 5)
    expect(ringAt(ringsAround(houses, osm, p), p)).toBe(ROW[1])
  })

  it('falls back to OSM where the survey has no house, and when there is no set at all', () => {
    expect(ringAt(ringsAround(houses, osm, at(53, 3)), at(53, 3))).toBe(SHED)
    expect(ringAt(ringsAround(null, osm, at(15, 5)), at(15, 5))).toBe(BLOCK)
    expect(ringsAround(null, undefined, at(15, 5))).toEqual([])
  })

  it('finds a house that straddles a cell edge from either side', () => {
    const edge = Math.ceil(W / CELL_LNG) * CELL_LNG // the next cell boundary east of W
    const across: LngLat[] = [[edge - 5 * M_LNG, S], [edge + 5 * M_LNG, S], [edge + 5 * M_LNG, S + 8 * M_LAT], [edge - 5 * M_LNG, S + 8 * M_LAT]]
    const index = houseIndex([across])
    const west: LngLat = [edge - 2 * M_LNG, S + 4 * M_LAT], east: LngLat = [edge + 2 * M_LNG, S + 4 * M_LAT]
    expect(cellOf(west)).not.toBe(cellOf(east))
    expect(ringAt(ringsAround(index, [], west), west)).toBe(across)
    expect(ringAt(ringsAround(index, [], east), east)).toBe(across)
  })
})
