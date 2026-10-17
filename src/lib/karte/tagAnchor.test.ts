import { describe, expect, it } from 'vitest'
import { interiorPoint, tagAnchor } from './tagAnchor'
import { ringContains } from '../footprintPick'
import type { LngLat } from '../../types'

// metres around a synthetic point (Musterdorf)
const O: LngLat = [7.57, 47.52]
const KX = 111_320 * Math.cos((O[1] * Math.PI) / 180)
const at = (e: number, n: number): LngLat => [O[0] + e / KX, O[1] + n / 110_540]
const box = (e0: number, n0: number, e1: number, n1: number): LngLat[] => [at(e0, n0), at(e1, n0), at(e1, n1), at(e0, n1)]

// Mühlemattstrasse 18 / 22 in miniature: two big buildings, 8 m of passage between them
const NORTH = box(0, 68, 100, 140)
const SOUTH = box(0, 0, 100, 60)

describe('tagAnchor', () => {
  it('hangs under the building when the street is free', () => {
    const a = tagAnchor({ main: NORTH }, at(50, 100), [box(300, 0, 340, 40)])
    expect(a.under).toBe(true)
    expect(a.at[1]).toBeCloseTo(at(0, 68)[1], 9)
  })

  it('never on another object\'s building: inside its own instead', () => {
    const a = tagAnchor({ main: NORTH }, at(95, 100), [SOUTH])
    expect(a.under).toBe(false)
    expect(ringContains(NORTH, a.at)).toBe(true)
    expect(ringContains(SOUTH, a.at)).toBe(false)
  })

  it('no building: on the point', () => {
    expect(tagAnchor(undefined, at(5, 5), [SOUTH])).toEqual({ at: at(5, 5), under: false })
  })

  it('an L-shaped building still gets a point inside it', () => {
    const L: LngLat[] = [at(0, 0), at(60, 0), at(60, 10), at(10, 10), at(10, 60), at(0, 60)]
    expect(ringContains(L, interiorPoint(L))).toBe(true)
  })
})
