import { describe, expect, it } from 'vitest'
import { circleRing, clipConvex, clipStroke, inSection, markDeg, rectPoly, segmentSpan, storeySections, thinMarks, visibleCentre, type Pt } from './storeyClip'

// one storey's section: the square 0..100 (board px)
const SQ = [rectPoly(0, 0, 100, 100)]
const close = (p: Pt, q: Pt) => { expect(p[0]).toBeCloseTo(q[0], 6); expect(p[1]).toBeCloseTo(q[1], 6) }

describe('clipStroke', () => {
  it('leaves a stroke that stays inside unchanged, with no mark', () => {
    const pts: Pt[] = [[10, 10], [50, 20], [90, 90]]
    const c = clipStroke(pts, SQ)
    expect(c.runs).toEqual([pts])
    expect(c.marks).toEqual([])
    expect(c.cut).toBe(false)
  })

  it('does not draw a stroke that lies wholly outside, and marks nothing', () => {
    const c = clipStroke([[120, 10], [180, 60], [150, 150]], SQ)
    expect(c.runs).toEqual([])
    expect(c.marks).toEqual([])
    expect(c.cut).toBe(true)
  })

  it('cuts a stroke crossing ONE edge at the edge, and marks it pointing outward', () => {
    // the field case: a Leitung that runs down out of the storey's plan
    const c = clipStroke([[50, 40], [50, 80], [50, 160]], SQ)
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0]).toHaveLength(3)
    close(c.runs[0][2], [50, 100])
    expect(c.marks).toHaveLength(1)
    close(c.marks[0].at, [50, 100])
    close(c.marks[0].dir, [0, 1]) // down, the way the stroke leaves
    expect(markDeg(c.marks[0])).toBeCloseTo(90, 6)
    expect(c.cut).toBe(true)
  })

  it('marks both crossings of a stroke that passes through, each pointing away from the inside', () => {
    const c = clipStroke([[-50, 50], [150, 50]], SQ)
    expect(c.runs).toHaveLength(1)
    close(c.runs[0][0], [0, 50])
    close(c.runs[0][1], [100, 50])
    expect(c.marks).toHaveLength(2)
    close(c.marks[0].at, [0, 50]); close(c.marks[0].dir, [-1, 0])
    close(c.marks[1].at, [100, 50]); close(c.marks[1].dir, [1, 0])
  })

  it('splits a stroke that leaves across one edge and comes back across another', () => {
    // out through the right edge, round the corner, back in through the bottom
    const c = clipStroke([[50, 50], [150, 50], [150, 150], [50, 150], [50, 60]], SQ)
    expect(c.runs).toHaveLength(2)
    close(c.runs[0][1], [100, 50])
    close(c.runs[1][0], [50, 100])
    close(c.runs[1][1], [50, 60])
    expect(c.marks.map((m) => m.at)).toEqual([[100, 50], [50, 100]])
    close(c.marks[0].dir, [1, 0])
    close(c.marks[1].dir, [0, 1]) // the stroke came from below — its outside is down
  })

  it('does not cut where two wings of one storey share an edge', () => {
    const wings = [rectPoly(0, 0, 50, 100), rectPoly(50, 0, 100, 100)]
    const c = clipStroke([[10, 50], [90, 50]], wings)
    expect(c.runs).toHaveLength(1)
    expect(c.marks).toEqual([])
    expect(c.cut).toBe(false)
  })

  it('cuts a turned (non-axis) section too', () => {
    const diamond: Pt[] = [[50, 0], [100, 50], [50, 100], [0, 50]]
    const c = clipStroke([[50, 50], [50, 200]], [diamond])
    close(c.runs[0][1], [50, 100])
    expect(c.marks).toHaveLength(1)
  })

  it('walks a ring (an area outline) and joins the run that wraps past its first vertex', () => {
    // a Fläche hanging off the bottom edge: its outline crosses the edge twice
    const ring: Pt[] = [[20, 60], [80, 60], [80, 140], [20, 140]]
    const c = clipStroke(ring, SQ, true)
    expect(c.marks).toHaveLength(2)
    close(c.marks[0].at, [80, 100]); close(c.marks[0].dir, [0, 1])
    close(c.marks[1].at, [20, 100]); close(c.marks[1].dir, [0, 1])
    // one visible run: 20,100 → 20,60 → 80,60 → 80,100
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0]).toHaveLength(4)
    close(c.runs[0][0], [20, 100])
    close(c.runs[0][3], [80, 100])
  })

  it('treats a lone vertex by whether it is inside', () => {
    expect(clipStroke([[10, 10]], SQ).runs).toHaveLength(1)
    expect(clipStroke([[110, 10]], SQ).runs).toHaveLength(0)
  })
})

describe('clipConvex', () => {
  it('cuts an area crossing the edge to the part inside', () => {
    const cut = clipConvex([[20, 60], [80, 60], [80, 140], [20, 140]], SQ[0])
    expect(cut).toHaveLength(4)
    const ys = cut.map((p) => p[1])
    expect(Math.max(...ys)).toBeCloseTo(100, 6)
    expect(Math.min(...ys)).toBeCloseTo(60, 6)
  })

  it('returns nothing for an area wholly outside, and the area itself when it is inside', () => {
    expect(clipConvex([[120, 0], [180, 0], [180, 50]], SQ[0])).toEqual([])
    const inner: Pt[] = [[10, 10], [40, 10], [40, 40]]
    expect(clipConvex(inner, SQ[0])).toEqual(inner)
  })

  it('does not care which way round the clip polygon is wound', () => {
    const cw = clipConvex([[50, 50], [150, 50], [150, 150], [50, 150]], [...SQ[0]].reverse())
    expect(cw).toHaveLength(4)
  })
})

describe('segmentSpan / inSection', () => {
  it('finds the inside part of a segment and ignores a touch', () => {
    expect(segmentSpan([-100, 50], [100, 50], SQ[0])).toEqual([0.5, 1])
    expect(segmentSpan([100, -50], [100, 150], SQ[0])).not.toBeNull() // along the edge is inside
    expect(segmentSpan([150, -50], [50, -150], SQ[0])).toBeNull()
    expect(segmentSpan([-10, 10], [10, -10], SQ[0])).toBeNull() // touches the corner only
  })
  it('knows inside from outside', () => {
    expect(inSection([50, 50], SQ)).toBe(true)
    expect(inSection([100, 100], SQ)).toBe(true)
    expect(inSection([100.5, 50], SQ)).toBe(false)
  })
})

describe('thinMarks / circleRing', () => {
  it('keeps one mark where a freehand stroke frays along the edge', () => {
    const marks = [{ at: [100, 50] as Pt, dir: [1, 0] as Pt }, { at: [100, 53] as Pt, dir: [-1, 0] as Pt }, { at: [100, 90] as Pt, dir: [1, 0] as Pt }]
    expect(thinMarks(marks, 14).map((m) => m.at)).toEqual([[100, 50], [100, 90]])
  })
  it('marks the two crossings of a ring that overhangs one edge', () => {
    const c = clipStroke(circleRing(50, 95, 20), SQ, true)
    expect(c.marks).toHaveLength(2)
    for (const m of c.marks) { expect(m.at[1]).toBeCloseTo(100, 6); expect(m.dir[1]).toBeGreaterThan(0) }
  })
})

describe('visibleCentre', () => {
  it("keeps a Fläche's own centre while it is on the section", () => {
    expect(visibleCentre([[20, 20], [60, 20], [60, 60], [20, 60]], SQ)).toEqual([40, 40])
  })
  it('moves the label onto what is left of a Fläche that overhangs the edge', () => {
    // 20..80 × 80..200: its centre (140) is below the storey; the part left is 80..100
    const c = visibleCentre([[20, 80], [80, 80], [80, 200], [20, 200]], SQ)!
    expect(c[0]).toBeCloseTo(50, 6)
    expect(c[1]).toBeCloseTo(90, 6)
  })
  it('has no place for the label of a Fläche wholly outside', () => {
    expect(visibleCentre([[120, 120], [180, 120], [180, 180]], SQ)).toBeNull()
  })
})

describe('storeySections', () => {
  const box = { w: 80, h: 60 }
  it('is the whole tile for a storey without a plan', () => {
    const s = storeySections({ floorsTTB: [1, 0], sW: 100, sH: 200, box, drawings: () => [] })
    expect(s.get(1)).toEqual([rectPoly(0, 0, 100, 100)])
    expect(s.get(0)).toEqual([rectPoly(0, 100, 100, 200)])
  })
  it("is the drawing's region, placed in the tile's box and cut to it", () => {
    // the drawing fills the left half of the box and overhangs its top
    const s = storeySections({
      floorsTTB: [1, 0], sW: 100, sH: 200, box,
      drawings: (f) => (f === 0 ? [[[0, -0.5], [0.5, -0.5], [0, 1]]] : []),
    })
    const [poly] = s.get(0)!
    // box on the EG tile: x 10..90, y 120..180
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(10, 6)
    expect(Math.max(...xs)).toBeCloseTo(50, 6)
    expect(Math.min(...ys)).toBeCloseTo(120, 6)
    expect(Math.max(...ys)).toBeCloseTo(180, 6)
    expect(s.get(1)).toEqual([rectPoly(0, 0, 100, 100)])
  })
})
