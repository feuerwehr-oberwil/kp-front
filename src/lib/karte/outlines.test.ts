import { describe, expect, it, vi } from 'vitest'
import type { LngLat } from '../../types'

const io = vi.hoisted(() => ({
  idbGet: vi.fn<(key: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}))
vi.mock('../idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../idb')>()),
  idbGet: io.idbGet, idbSet: vi.fn(async () => true),
}))
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiPost: io.apiPost,
}))

import { CELL_LNG, cellOf, houseIndex, loadCell, osmBeside, ringsAround } from './outlines'
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

// Karte Haus round 4 (Bottmingerstrasse 44, 55 / Talstrasse 1): OSM traces the roof, the survey
// the walls, so OSM's outline sticks out of the house by a band, or covers two houses.
describe('osmBeside — an OSM outline over a survey house is that house traced again', () => {
  const HOUSE = box(0, 0, 10, 16)
  const ROOF = box(-1, -1, 11.5, 17) // the same building, a band wider
  const L_BLOCK: LngLat[] = [at(20, 0), at(40, 0), at(40, 10), at(30, 10), at(30, 20), at(20, 20)]
  const PAIR = [box(20.5, 0.5, 39.5, 9.5), box(20.5, 10, 29.5, 19.5)] // the two houses under the L
  const NEIGHBOUR = box(-12, 0, 0.3, 16) // a house the survey misses, its wall drawn 30 cm into ours
  const houses = houseIndex([HOUSE, ...PAIR])
  const osm = [ROOF, L_BLOCK, NEIGHBOUR, SHED]
  const tap = (p: LngLat) => ringAt(ringsAround(houses, osm, p), p)

  it('a point in the band around a house opens nothing, never the roof outline', () => {
    expect(tap(at(10.8, 8))).toBeNull()
    expect(tap(at(5, 8))).toBe(HOUSE)
  })

  it('an OSM block over two houses is dropped: each house alone, nothing in between', () => {
    expect(tap(at(30, 5))).toBe(PAIR[0])
    expect(tap(at(25, 15))).toBe(PAIR[1])
    expect(tap(at(25, 9.8))).toBeNull()
  })

  it('keeps what only touches a house, and what the survey has nothing for', () => {
    expect(osmBeside(houses, osm)).toEqual([NEIGHBOUR, SHED])
    expect(tap(at(-6, 8))).toBe(NEIGHBOUR)
    expect(tap(at(53, 3))).toBe(SHED)
  })

  it('measures a cell once per house set', () => {
    expect(osmBeside(houses, osm)).toBe(osmBeside(houses, osm))
  })
})

describe('loadCell', () => {
  it('asks the server again for a cell the device stored EMPTY (an old Overpass timeout answer)', async () => {
    io.idbGet.mockResolvedValue([])
    io.apiPost.mockResolvedValue({ elements: [] })
    await loadCell('9001:9001')
    expect(io.apiPost).toHaveBeenCalledTimes(1)
  })

  it('serves a stored cell with outlines without asking the server', async () => {
    io.apiPost.mockClear()
    io.idbGet.mockResolvedValue([[[7.55, 47.52], [7.56, 47.52], [7.56, 47.53]]])
    expect(await loadCell('9002:9002')).toHaveLength(1)
    expect(io.apiPost).not.toHaveBeenCalled()
  })
})
