import { describe, it, expect } from 'vitest'
import { unitLen, pathUnits, calibrate, pathMetres, polyAreaM2, isStale, circleRadiusM, circleRadiusN, circleRingN, type NPoint } from './planScale'

describe('unitLen — aspect correction', () => {
  it('is plain Euclidean on a square page (ar = 1)', () => {
    expect(unitLen([0, 0], [0.3, 0.4], 1)).toBeCloseTo(0.5, 10)
  })
  it('stretches the x axis by the aspect ratio', () => {
    // a wide page (ar = 2): a horizontal normalized span counts double a vertical one
    expect(unitLen([0, 0], [0.5, 0], 2)).toBeCloseTo(1.0, 10)
    expect(unitLen([0, 0], [0, 0.5], 2)).toBeCloseTo(0.5, 10)
  })
})

describe('pathUnits', () => {
  it('sums segment lengths along a polyline', () => {
    const pts: NPoint[] = [[0, 0], [0.5, 0], [0.5, 0.5]]
    expect(pathUnits(pts, 1)).toBeCloseTo(1.0, 10)
  })
})

describe('calibrate → pathMetres round-trip', () => {
  it('measuring the reference segment returns exactly the entered length', () => {
    const a: NPoint = [0.1, 0.2], b: NPoint = [0.6, 0.5]
    const ar = 1.414
    const s = calibrate(a, b, 10, ar)!
    expect(s).not.toBeNull()
    expect(pathMetres([a, b], s.mPerU, ar)).toBeCloseTo(10, 9)
  })

  it('a segment twice the reference length reads twice the metres', () => {
    const ar = 0.72 // a floor-stack tile aspect
    const s = calibrate([0, 0], [0.2, 0], 5, ar)!
    expect(pathMetres([[0, 0], [0.4, 0]], s.mPerU, ar)).toBeCloseTo(10, 9)
  })

  it('respects aspect: a vertical span of the same normalized size on a wide page is shorter', () => {
    const ar = 2
    const s = calibrate([0, 0], [0.5, 0], 20, ar)! // horizontal reference: 0.5*2 = 1 unit → 20 m
    // same 0.5 normalized run but vertical = 0.5 units → half the metres
    expect(pathMetres([[0, 0], [0, 0.5]], s.mPerU, ar)).toBeCloseTo(10, 9)
  })

  it('rejects a degenerate (zero-length or non-positive) reference', () => {
    expect(calibrate([0.2, 0.2], [0.2, 0.2], 10, 1)).toBeNull()
    expect(calibrate([0, 0], [0.5, 0], 0, 1)).toBeNull()
    expect(calibrate([0, 0], [0.5, 0], 10, 0)).toBeNull()
  })
})

describe('polyAreaM2', () => {
  const unitSquare: NPoint[] = [[0, 0], [1, 0], [1, 1], [0, 1]]
  it('is the plain area on a square page (ar = 1, 1 unit = 1 m)', () => {
    const s = calibrate([0, 0], [1, 0], 1, 1)! // mPerU = 1
    expect(polyAreaM2(unitSquare, s.mPerU, 1)).toBeCloseTo(1, 9)
    expect(polyAreaM2([[0, 0], [10, 0], [10, 10], [0, 10]], s.mPerU, 1)).toBeCloseTo(100, 9)
  })
  it('aspect-corrects: a normalized square on a 2:1 page is 1 m × 2 m = 2 m²', () => {
    const s = calibrate([0, 0], [0, 1], 1, 2)! // vertical 1 unit = 1 m → mPerU = 1
    expect(polyAreaM2(unitSquare, s.mPerU, 2)).toBeCloseTo(2, 9)
  })
  it('is zero for fewer than 3 points', () => {
    expect(polyAreaM2([[0, 0], [1, 1]], 1, 1)).toBe(0)
  })
})

describe('isStale', () => {
  it('is false when the aspect is unchanged', () => {
    const s = calibrate([0, 0], [0.5, 0], 10, 1.414)!
    expect(isStale(s, 1.414)).toBe(false)
  })
  it('is true once the plan aspect drifts past the threshold', () => {
    const s = calibrate([0, 0], [0.5, 0], 10, 1.414)!
    expect(isStale(s, 0.7)).toBe(true)
  })
})

// ── Absperrkreis on a plan (types · BoardAnno.radiusN) ──────────────────────────────────────
// The radius is stored as a fraction of the plan WIDTH, so every answer about it has to run
// through the same aspect correction a length does — otherwise a cordon on a 2:1 sheet reads
// (and prints) as an ellipse, or states half the metres it covers.
describe('circleRadiusM / circleRadiusN', () => {
  it('is the plain radius on a square page (ar = 1, 1 unit = 1 m)', () => {
    const s = calibrate([0, 0], [1, 0], 1, 1)! // mPerU = 1
    expect(circleRadiusM(0.25, s.mPerU, 1)).toBeCloseTo(0.25, 9)
  })

  it('aspect-corrects: the same fraction covers more ground on a wide sheet', () => {
    expect(circleRadiusM(0.25, 4, 2)).toBeCloseTo(2, 9) // 0.25 · 2 · 4
  })

  it('round-trips metres → fraction → metres', () => {
    const n = circleRadiusN(25, 4, 1.5)!
    expect(circleRadiusM(n, 4, 1.5)).toBeCloseTo(25, 9)
  })

  it('answers null where the sheet cannot say — no factor, degenerate aspect', () => {
    expect(circleRadiusN(25, 0, 1.5)).toBeNull()
    expect(circleRadiusN(25, 4, 0)).toBeNull()
  })
})

describe('circleRingN', () => {
  it('is round in PIXELS, not in normalized units: the y radius carries the aspect', () => {
    const ring = circleRingN(0.5, 0.5, 0.2, 2, 4)
    expect(ring).toHaveLength(4)
    expect(ring[0][0]).toBeCloseTo(0.7, 9)   // east: x + radiusN
    expect(ring[0][1]).toBeCloseTo(0.5, 9)
    expect(ring[1][0]).toBeCloseTo(0.5, 9)   // south: y + radiusN · ar
    expect(ring[1][1]).toBeCloseTo(0.9, 9)
  })

  it('is open (last point is not the first), like every other normalized ring here', () => {
    const ring = circleRingN(0.5, 0.5, 0.1, 1, 8)
    expect(ring).toHaveLength(8)
    expect(ring[7]).not.toEqual(ring[0])
  })
})
