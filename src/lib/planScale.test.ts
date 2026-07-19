import { describe, it, expect } from 'vitest'
import { unitLen, pathUnits, calibrate, pathMetres, polyAreaM2, isStale, type NPoint } from './planScale'

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
