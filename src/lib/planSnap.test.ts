import { describe, expect, it } from 'vitest'
import { backtracks, snapPoint, snapWall, type SnapTargets } from './planSnap'

// The Grundriss snap (27.10.2026): a ring, no text – where a tapped point lands.

const none: SnapTargets = { segs: [], ends: [], centres: [] }
// a 200 × 100 outline with its corners, and a Durchgang at (100, 0)
const box: SnapTargets = {
  segs: [[[0, 0], [200, 0]], [[200, 0], [200, 100]], [[200, 100], [0, 100]], [[0, 100], [0, 0]]],
  ends: [[0, 0], [200, 0], [200, 100], [0, 100]],
  centres: [[100, 0]],
}

describe('snapPoint · Wand', () => {
  it('lands a first point on a corner, else on the nearest segment, else free', () => {
    expect(snapPoint([5, 6], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [0, 0], snapped: true })
    expect(snapPoint([60, 8], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [60, 0], snapped: true })
    expect(snapPoint([60, 50], { mode: 'wand', draft: [], targets: box })).toEqual({ p: [60, 50], snapped: false })
  })

  it('locks a point near a right angle onto it, and lets any other angle stand (round 2)', () => {
    // 7° off horizontal: straight
    expect(snapPoint([160, 62.3], { mode: 'wand', draft: [[60, 50]], targets: none }).p).toEqual([160, 50])
    // 7° off vertical: straight up
    const up = snapPoint([72.3, -50], { mode: 'wand', draft: [[60, 50]], targets: none }).p
    expect(up[0]).toBeCloseTo(60, 9); expect(up[1]).toBeCloseTo(-50, 9)
    // 30°: free, exactly where it was tapped
    expect(snapPoint([146.6, 100], { mode: 'wand', draft: [[60, 50]], targets: none })).toEqual({ p: [146.6, 100], snapped: false })
  })

  it('also locks along and across a slanted piece before it', () => {
    // the piece runs at 45°: a point 5° off its perpendicular lands on the perpendicular
    const draft: [number, number][] = [[0, 0], [100, 100]]
    const r = Math.hypot(60, 60), th = (-45 + 5) * (Math.PI / 180)
    const p = snapPoint([100 + r * Math.cos(th), 100 + r * Math.sin(th)], { mode: 'wand', draft, targets: none }).p
    expect(p[0] - 100).toBeCloseTo(-(p[1] - 100), 6)
  })

  it('lets a target win over the angle: the outline edge off the locked axis, a corner diagonal from it', () => {
    // heading right-ish from (60, 50) but the pointer is 4 px above the bottom edge (y = 100):
    // without the edge it would lock horizontal at y = 50
    expect(snapPoint([140, 96], { mode: 'wand', draft: [[60, 50]], targets: box })).toEqual({ p: [140, 100], snapped: true })
    // the corner (200, 100) diagonal from the last point
    expect(snapPoint([196, 97], { mode: 'wand', draft: [[60, 30]], targets: box })).toEqual({ p: [200, 100], snapped: true })
  })

  it('lands where the locked line crosses an edge in reach', () => {
    // 3° off horizontal from (60, 50), 8 px short of the right edge: on the edge AND level
    expect(snapPoint([192, 56.9], { mode: 'wand', draft: [[60, 50]], targets: box })).toEqual({ p: [200, 50], snapped: true })
  })

  it('finishes on the last point and closes on the first of three or more', () => {
    const draft: [number, number][] = [[0, 0], [100, 0], [100, 80]]
    expect(snapPoint([102, 84], { mode: 'wand', draft, targets: none })).toMatchObject({ p: [100, 80], finish: true })
    expect(snapPoint([4, 3], { mode: 'wand', draft, targets: none })).toMatchObject({ p: [0, 0], close: true })
    // two points are a line, not a ring: no close yet
    expect(snapPoint([4, 3], { mode: 'wand', draft: draft.slice(0, 2), targets: none }).close).toBeUndefined()
  })
})

describe('snapWall · a dragged corner', () => {
  it('squares a corner against both neighbours', () => {
    // neighbours (0, 0) and (100, 100): the square corner is (100, 0) – or (0, 100)
    const anchors = [{ from: [0, 0] as const }, { from: [100, 100] as const }]
    expect(snapWall([96, 6], { anchors, targets: none }).p.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([100, 0])
  })

  it('lands on a Fläche edge in reach before squaring', () => {
    const area: SnapTargets = { segs: [[[40, -20], [40, 60]]], ends: [], centres: [] }
    expect(snapWall([44, 2], { anchors: [{ from: [0, 0] }], targets: area })).toEqual({ p: [40, 0], snapped: true })
  })
})

describe('snapPoint · Linie', () => {
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
