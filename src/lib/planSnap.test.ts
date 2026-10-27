import { describe, expect, it } from 'vitest'
import { backtracks, snapPoint, type SnapTargets } from './planSnap'

// The Grundriss snap (27.10.2026): a ring, no text – where a tapped point lands.

const none: SnapTargets = { segs: [], ends: [], centres: [] }
// a 200 × 100 outline with its corners, and a Durchgang at (100, 0)
const box: SnapTargets = {
  segs: [[[0, 0], [200, 0]], [[200, 0], [200, 100]], [[200, 100], [0, 100]], [[0, 100], [0, 0]]],
  ends: [[0, 0], [200, 0], [200, 100], [0, 100]],
  centres: [[100, 0]],
}

describe('snapPoint · Wand / Raum', () => {
  it('lands a first point on a corner, else on the nearest segment, else free', () => {
    expect(snapPoint([5, 6], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [0, 0], snapped: true })
    expect(snapPoint([60, 8], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [60, 0], snapped: true })
    expect(snapPoint([60, 50], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [60, 50], snapped: false })
  })

  it('runs every next point straight or at a right angle from the last one', () => {
    expect(snapPoint([90, 57], { mode: 'wand', draft: [[60, 50]], targets: none })).toEqual({ p: [90, 50], snapped: false })
    expect(snapPoint([66, 20], { mode: 'raum', draft: [[60, 50]], targets: none })).toEqual({ p: [60, 20], snapped: false })
  })

  it('catches a crossing wall or the outline along the axis, within the pull', () => {
    // heading right from (60, 50): the outline's right edge stands at x = 200
    expect(snapPoint([190, 53], { mode: 'wand', draft: [[60, 50]], targets: box })).toEqual({ p: [200, 50], snapped: true })
    // too far from it: free on the axis
    expect(snapPoint([150, 53], { mode: 'wand', draft: [[60, 50]], targets: box }).snapped).toBe(false)
  })

  it('finishes on the last point and closes on the first of three or more', () => {
    const draft: [number, number][] = [[0, 0], [100, 0], [100, 80]]
    expect(snapPoint([102, 84], { mode: 'wand', draft, targets: none })).toMatchObject({ p: [100, 80], finish: true })
    expect(snapPoint([4, 3], { mode: 'raum', draft, targets: none })).toMatchObject({ p: [0, 0], close: true })
    // two points are a line, not a ring: no close yet
    expect(snapPoint([4, 3], { mode: 'wand', draft: draft.slice(0, 2), targets: none }).close).toBeUndefined()
  })
})

describe('snapPoint · Weg and Linie', () => {
  it('lets a Weg run free, onto a door or a wall end', () => {
    expect(snapPoint([140, 60], { mode: 'weg', draft: [[60, 50]], targets: box })).toEqual({ p: [140, 60], snapped: false })
    expect(snapPoint([104, 5], { mode: 'weg', draft: [[60, 50]], targets: box })).toEqual({ p: [100, 0], snapped: true })
  })

  it('pulls a Leitung only onto a Durchgang / Treppe centre – never onto walls', () => {
    expect(snapPoint([103, 6], { mode: 'line', draft: [[0, 50]], targets: box })).toEqual({ p: [100, 0], snapped: true })
    expect(snapPoint([2, 99], { mode: 'line', draft: [], targets: box })).toEqual({ p: [2, 99], snapped: false })
    // a Leitung has no «tap the last point to finish»
    expect(snapPoint([1, 50], { mode: 'line', draft: [[0, 50]], targets: box }).finish).toBeUndefined()
  })
})

describe('backtracks', () => {
  it('is true only for a point straight back along the piece just drawn', () => {
    expect(backtracks([0, 0], [100, 0], [40, 0])).toBe(true)
    expect(backtracks([0, 0], [100, 0], [-40, 0])).toBe(true)
    expect(backtracks([0, 0], [100, 0], [160, 0])).toBe(false) // onwards
    expect(backtracks([0, 0], [100, 0], [100, 60])).toBe(false) // a corner
  })
})
