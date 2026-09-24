import { describe, expect, it } from 'vitest'
import { clipPolygon, clipPolyline, clipSegment, continuationChevrons, insideRect, longestRunMid, type Rect } from './tileClip'

// A storey tile of the Gebäude, in board px: 300 wide, the middle band of a 600-px stack.
const TILE: Rect = { x0: 0, y0: 200, x1: 300, y1: 400 }

const inside = (p: readonly [number, number]) => insideRect(p, TILE)

describe('clipSegment (Liang–Barsky)', () => {
  it('keeps what is inside and says where along the segment it is', () => {
    expect(clipSegment([100, 300], [200, 300], TILE)).toEqual([0, 1])
    const [t0, t1] = clipSegment([150, 300], [150, 500], TILE)!
    expect(t0).toBe(0)
    expect(t1).toBeCloseTo(0.5, 12)
    expect(clipSegment([10, 10], [290, 10], TILE)).toBeNull()
  })
})

describe('clipPolyline — one storey tile, and where the line goes on', () => {
  it('a line fully inside comes back unchanged, with no mark', () => {
    const pts: [number, number][] = [[20, 220], [150, 300], [280, 380]]
    const cut = clipPolyline(pts, TILE)
    expect(cut.runs).toEqual([pts])
    expect(cut.exits).toEqual([])
  })

  it('a segment crossing the edge ends ON the edge, with one mark pointing out', () => {
    const cut = clipPolyline([[150, 300], [150, 500]], TILE)
    expect(cut.runs).toEqual([[[150, 300], [150, 400]]])
    expect(cut.exits).toHaveLength(1)
    expect(cut.exits[0].at).toEqual([150, 400])
    expect(cut.exits[0].dir[0]).toBeCloseTo(0, 12)
    expect(cut.exits[0].dir[1]).toBeCloseTo(1, 12) // down, out of the bottom edge
  })

  it('a line that exits and re-enters is two runs and TWO marks — one per crossing, not per vertex', () => {
    // in, out below through three vertices, back in
    const cut = clipPolyline([[50, 300], [50, 500], [150, 550], [250, 500], [250, 300]], TILE)
    expect(cut.runs).toHaveLength(2)
    expect(cut.runs[0]).toEqual([[50, 300], [50, 400]])
    expect(cut.runs[1]).toEqual([[250, 400], [250, 300]])
    expect(cut.exits).toHaveLength(2)
    expect(cut.exits[0]).toMatchObject({ at: [50, 400] })
    expect(cut.exits[0].dir[1]).toBeCloseTo(1, 12)
    // the second one points back the way the line came from: out of the tile again
    expect(cut.exits[1]).toMatchObject({ at: [250, 400] })
    expect(cut.exits[1].dir[1]).toBeCloseTo(1, 12)
  })

  it('a line fully outside is not drawn and has no mark', () => {
    expect(clipPolyline([[20, 450], [280, 500], [100, 590]], TILE)).toEqual({ runs: [], exits: [] })
    // …nor is one that only grazes the tile's corner
    expect(clipPolyline([[-100, 300], [100, 100]], TILE)).toEqual({ runs: [], exits: [] })
  })

  it('a line passing straight through is one run with a mark at each end', () => {
    const cut = clipPolyline([[150, 100], [150, 500]], TILE)
    expect(cut.runs).toEqual([[[150, 200], [150, 400]]])
    expect(cut.exits.map((e) => e.at)).toEqual([[150, 200], [150, 400]])
    expect(cut.exits[0].dir[1]).toBeCloseTo(-1, 12)
    expect(cut.exits[1].dir[1]).toBeCloseTo(1, 12)
  })

  it('a vertex exactly ON the edge leaves once, not twice', () => {
    const cut = clipPolyline([[150, 300], [150, 400], [150, 500]], TILE)
    expect(cut.runs).toEqual([[[150, 300], [150, 400]]])
    expect(cut.exits).toHaveLength(1)
    expect(cut.exits[0].at).toEqual([150, 400])
    // …and coming back in through a vertex on the edge is marked too
    const back = clipPolyline([[150, 500], [150, 400], [150, 300]], TILE)
    expect(back.runs).toEqual([[[150, 400], [150, 300]]])
    expect(back.exits).toHaveLength(1)
    expect(back.exits[0].dir[1]).toBeCloseTo(1, 12)
  })

  it('a single vertex is kept inside and dropped outside', () => {
    expect(clipPolyline([[10, 210]], TILE).runs).toEqual([[[10, 210]]])
    expect(clipPolyline([[10, 10]], TILE).runs).toEqual([])
  })
})

describe('clipPolygon (Sutherland–Hodgman)', () => {
  it('cuts an area to the tile, and drops one wholly outside', () => {
    const seen = clipPolygon([[100, 300], [200, 300], [200, 500], [100, 500]], TILE)
    expect(seen.every(inside)).toBe(true)
    expect(Math.max(...seen.map((p) => p[1]))).toBe(400)
    expect(clipPolygon([[0, 450], [100, 450], [50, 550]], TILE)).toEqual([])
  })
})

describe('the «geht weiter» mark', () => {
  it('is two open chevrons pointing out, wholly inside the tile', () => {
    const [exit] = clipPolyline([[150, 300], [150, 500]], TILE).exits
    const chev = continuationChevrons(exit, 8)
    expect(chev).toHaveLength(2)
    for (const c of chev) {
      expect(c).toHaveLength(3) // open: two arms, no closing edge, no fill
      expect(c.every(inside)).toBe(true)
      expect(c[1][1]).toBeGreaterThan(c[0][1]) // the point leads, downward, toward the edge
    }
  })

  it('steps back along the line at a corner, so neither arm is cut by the other edge', () => {
    const [exit] = clipPolyline([[60, 390], [-20, 398]], TILE).exits // leaves the left edge 4 px above the corner
    expect(continuationChevrons(exit, 8).flat().every(inside)).toBe(false)
    expect(continuationChevrons(exit, 8, TILE).flat().every(inside)).toBe(true)
  })

  it('a label falls back to the middle of the longest visible piece', () => {
    expect(longestRunMid([[[0, 0], [10, 0]], [[0, 50], [0, 150]]])).toEqual([0, 100])
    expect(longestRunMid([])).toBeNull()
  })
})
