import { describe, expect, it } from 'vitest'
import type { Ring } from './footprint'
import { PICK_NEAR_M, pickAtPin, ringContains, ringEdgeDistance } from './footprintPick'

// the picker's square bbox: ±150 m → one unit is 300 m
const SIDE = 300
const m = (v: number) => v / SIDE
/** an axis-aligned box in metres, as a picker ring (0..1, the pin at 0.5/0.5 is the centre) */
const box = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[0.5 + m(x0), 0.5 + m(y0)], [0.5 + m(x1), 0.5 + m(y0)], [0.5 + m(x1), 0.5 + m(y1)], [0.5 + m(x0), 0.5 + m(y1)]]
const PIN: [number, number] = [0.5, 0.5]

describe('footprintPick · geometry', () => {
  it('contains: inside yes, outside no', () => {
    expect(ringContains(box(-5, -5, 5, 5), PIN)).toBe(true)
    expect(ringContains(box(1, 1, 5, 5), PIN)).toBe(false)
  })

  it('edge distance: to the nearest side, also from inside', () => {
    expect(ringEdgeDistance(box(3, -5, 10, 5), PIN) * SIDE).toBeCloseTo(3)
    expect(ringEdgeDistance(box(-2, -5, 10, 5), PIN) * SIDE).toBeCloseTo(2)
    // the corner, not the extended side line
    expect(ringEdgeDistance(box(3, 4, 10, 10), PIN) * SIDE).toBeCloseTo(5)
  })
})

describe('footprintPick · pickAtPin', () => {
  it('(a) the outline that contains the Einsatzort', () => {
    expect(pickAtPin([box(20, 20, 30, 30), box(-4, -4, 4, 4), box(-30, 5, -20, 15)], PIN, SIDE)).toBe(1)
  })

  it('(a) contains wins over a nearer edge of another outline', () => {
    // the pin sits 1 m inside a big hall's wall; a shed's edge is 0.5 m away on the other side
    expect(pickAtPin([box(0.5, -3, 4, 3), box(-30, -30, 1, 30)], PIN, SIDE)).toBe(1)
  })

  it('(a) nested outlines: the smallest one around the pin', () => {
    expect(pickAtPin([box(-40, -40, 40, 40), box(-5, -5, 5, 5)], PIN, SIDE)).toBe(1)
  })

  it('(b) the pin on the street: the house 8 m away, nothing else near', () => {
    expect(pickAtPin([box(8, -6, 20, 6), box(-60, -6, -40, 6)], PIN, SIDE)).toBe(0)
  })

  it('(b) beyond the reach: nothing', () => {
    expect(pickAtPin([box(PICK_NEAR_M + 1, -6, 30, 6)], PIN, SIDE)).toBeNull()
  })

  it('(b) ambiguous: two houses about equally near — nothing, the neighbour is never guessed', () => {
    expect(pickAtPin([box(6, -6, 20, 6), box(-20, -6, -9, 6)], PIN, SIDE)).toBeNull()
  })

  it('(b) the runner-up at twice the distance or more is clear', () => {
    expect(pickAtPin([box(4, -6, 20, 6), box(-20, -6, -8, 6)], PIN, SIDE)).toBe(0)
  })

  it('(b) the runner-up beyond the reach is clear, however close the ratio', () => {
    expect(pickAtPin([box(11, -6, 20, 6), box(-30, -6, -13, 6)], PIN, SIDE)).toBe(0)
  })

  it('(c) no outlines, no pick', () => {
    expect(pickAtPin([], PIN, SIDE)).toBeNull()
  })
})
