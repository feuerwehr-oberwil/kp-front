import { describe, it, expect } from 'vitest'
import {
  fitSimilarity,
  rematchPairs,
  replacePair,
  residualClaim,
  BASELINE_WARN_M,
  PAIR_EPS_N,
  type GeorefPair,
  type GeoPt,
  type PlanPt,
} from './georef'
import { haversineM } from './geo'

// --- synthetic ground truth ----------------------------------------------------------------
// An INDEPENDENT re-implementation of the projection (same cos(lat)-corrected Web-Mercator) so
// the tests build their truth themselves instead of asking the module under test for it.
const R = 6378137
const DEG = Math.PI / 180
const LAT0 = 47.5 // Oberwil-ish — the latitude the correction is checked at
const K = Math.cos(LAT0 * DEG) * R
const toLngLat = (x: number, y: number): GeoPt => ({
  lng: x / K / DEG,
  lat: (2 * Math.atan(Math.exp(y / K)) - Math.PI / 2) / DEG,
})
const ORIGIN = { x: 0.6 * K * DEG * 12.6, y: K * Math.log(Math.tan(Math.PI / 4 + LAT0 * DEG / 2)) }

const AR = 1.414 // landscape sheet, width / height

/** Place `plan` points through a known similarity: `s` metres per aspect-corrected unit,
 *  rotated `degCcw`, offset by (dx, dy) metres from ORIGIN. Mirrors the module's y-flip. */
function truth(plan: PlanPt[], s: number, degCcw: number, dx = 0, dy = 0, ar = AR): GeorefPair[] {
  const th = degCcw * DEG
  const cos = Math.cos(th), sin = Math.sin(th)
  return plan.map((p) => {
    const x = p.x * ar, y = -p.y
    return {
      plan: p,
      lngLat: toLngLat(ORIGIN.x + dx + s * (cos * x - sin * y), ORIGIN.y + dy + s * (sin * x + cos * y)),
    }
  })
}

const TRIANGLE: PlanPt[] = [{ x: 0.2, y: 0.8 }, { x: 0.8, y: 0.75 }, { x: 0.55, y: 0.2 }]

describe('fitSimilarity — degenerate inputs', () => {
  it('returns null under two pairs', () => {
    expect(fitSimilarity([], AR)).toBeNull()
    expect(fitSimilarity(truth([TRIANGLE[0]], 100, 0), AR)).toBeNull()
  })

  it('returns null when every plan point is the same point', () => {
    const pairs = truth([TRIANGLE[0], TRIANGLE[1]], 100, 0)
    pairs[1].plan = { ...pairs[0].plan }
    expect(fitSimilarity(pairs, AR)).toBeNull()
  })

  it('⚠️ returns null for plan points that are merely NEAR-coincident, not bit-identical', () => {
    // The failure this guards: drag one cross to within a hair of another and the solver used to
    // "succeed" — an absurd scale, residuals near float zero that read as a flawless fit, and
    // warnings saying only «aus 2 Punkten», because the baseline is measured on the MAP side and
    // that side is perfectly healthy. A symbol at the sheet's centre then lands at a FINITE
    // latitude near −90, which sails through every `Number.isFinite` guard downstream.
    const pairs = truth([TRIANGLE[0], TRIANGLE[1]], 100, 0)
    pairs[1].plan = { x: TRIANGLE[0].x + PAIR_EPS_N / 2, y: TRIANGLE[0].y }
    expect(fitSimilarity(pairs, AR)).toBeNull()
  })

  it('still fits two references just far enough apart to BE two landmarks', () => {
    // the threshold is `replacePair`'s own: anything it would treat as a separate landmark has
    // to remain solvable, however tight the sheet is
    const pairs = truth([TRIANGLE[0], TRIANGLE[1]], 100, 0)
    pairs[1].plan = { x: TRIANGLE[0].x + PAIR_EPS_N * 2, y: TRIANGLE[0].y }
    expect(fitSimilarity(pairs, AR)).not.toBeNull()
  })

  it('returns null when every map point is the same point', () => {
    const pairs = truth([TRIANGLE[0], TRIANGLE[1]], 100, 0)
    pairs[1].lngLat = { ...pairs[0].lngLat }
    expect(fitSimilarity(pairs, AR)).toBeNull()
  })

  it('returns null for a non-positive aspect', () => {
    expect(fitSimilarity(truth(TRIANGLE, 100, 0), 0)).toBeNull()
  })
})

describe('fitSimilarity — transform recovery', () => {
  it('recovers scale, rotation and position from an exact fit', () => {
    const pairs = truth(TRIANGLE, 120, 31, 40, -25)
    const fit = fitSimilarity(pairs, AR)!
    expect(fit).not.toBeNull()
    // ~1e-5 relative slack: the fit corrects cos(lat) at the pairs' MEAN latitude, the truth
    // above at a fixed LAT0 — a few ppm apart over a plan-sized extent, and nothing else.
    expect(fit.scaleMPerU).toBeCloseTo(120, 2)
    expect(fit.rotationDeg).toBeCloseTo(31, 3)
    expect(fit.n).toBe(3)
    // every landmark lands back on the metre it was placed at
    for (const p of pairs) {
      const got = fit.toMap(p.plan)
      expect(haversineM([got.lng, got.lat], [p.lngLat.lng, p.lngLat.lat])).toBeLessThan(0.01)
    }
  })

  it('recovers a negative rotation (plan turned the other way)', () => {
    const fit = fitSimilarity(truth(TRIANGLE, 60, -95), AR)!
    expect(fit.rotationDeg).toBeCloseTo(-95, 3)
  })

  it('never mirrors: a plan-space left turn stays a left turn on the map', () => {
    // walk plan-right then plan-up; the cross product of the two map-space steps must stay
    // positive (counter-clockwise) — a mirrored fit would flip its sign
    const fit = fitSimilarity(truth(TRIANGLE, 80, 17), AR)!
    const o = fit.toMap({ x: 0.5, y: 0.5 })
    const right = fit.toMap({ x: 0.6, y: 0.5 })
    const up = fit.toMap({ x: 0.5, y: 0.4 }) // y runs DOWN, so smaller y is "up" on the sheet
    const a = [right.lng - o.lng, right.lat - o.lat]
    const b = [up.lng - o.lng, up.lat - o.lat]
    expect(a[0] * b[1] - a[1] * b[0]).toBeGreaterThan(0)
  })

  it('honours the plan aspect: the same pairs at a different aspect give a different scale', () => {
    const pairs = truth(TRIANGLE, 100, 0, 0, 0, 1)
    expect(fitSimilarity(pairs, 1)!.scaleMPerU).toBeCloseTo(100, 2)
    expect(fitSimilarity(pairs, 2)!.scaleMPerU).not.toBeCloseTo(100, 1)
  })
})

describe('fitSimilarity — round trip', () => {
  it('toPlan(toMap(p)) returns p', () => {
    const fit = fitSimilarity(truth(TRIANGLE, 95, 63, 10, 10), AR)!
    for (const p of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: 0.97, y: 0.03 }, { x: 1.4, y: -0.2 }]) {
      const back = fit.toPlan(fit.toMap(p))
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })

  it('toMap(toPlan(ll)) returns ll', () => {
    const fit = fitSimilarity(truth(TRIANGLE, 95, 63), AR)!
    const ll = { lng: 7.5471, lat: 47.5012 }
    const back = fit.toMap(fit.toPlan(ll))
    expect(haversineM([back.lng, back.lat], [ll.lng, ll.lat])).toBeLessThan(0.001)
  })
})

describe('fitSimilarity — metres are real metres', () => {
  // Without the cos(lat) correction the "metres" would be Web-Mercator metres, ~48 % too long
  // at 47.5° N. Checked against haversine, an independent implementation, in BOTH directions
  // because the Mercator distortion is direction-dependent.
  const fit = fitSimilarity(truth(TRIANGLE, 200, 0), AR)!

  it('an east–west plan span measures scaleMPerU · units on the ground', () => {
    const a = fit.toMap({ x: 0.2, y: 0.5 }), b = fit.toMap({ x: 0.7, y: 0.5 })
    const expected = 0.5 * AR * fit.scaleMPerU
    expect(haversineM([a.lng, a.lat], [b.lng, b.lat])).toBeCloseTo(expected, 0)
  })

  it('a north–south plan span measures scaleMPerU · units on the ground', () => {
    const a = fit.toMap({ x: 0.5, y: 0.2 }), b = fit.toMap({ x: 0.5, y: 0.7 })
    const expected = 0.5 * fit.scaleMPerU
    expect(haversineM([a.lng, a.lat], [b.lng, b.lat])).toBeCloseTo(expected, 0)
  })
})

describe('residual honesty', () => {
  it('two pairs solve exactly and claim nothing', () => {
    const fit = fitSimilarity(truth([TRIANGLE[0], TRIANGLE[1]], 130, 12), AR)!
    expect(fit.n).toBe(2)
    fit.residuals.forEach((d) => expect(d).toBeLessThan(1e-6))
    expect(residualClaim(fit)).toBeNull() // «aus 2 Punkten», never «⌀ 0.0 m»
  })

  it('a clean three-pair fit claims ~0 m', () => {
    const fit = fitSimilarity(truth(TRIANGLE, 130, 12), AR)!
    expect(residualClaim(fit)).toBeLessThan(0.01)
  })

  it('surfaces a mistapped landmark in metres', () => {
    // four references, one of them tapped ~5 m off on the map
    const plan: PlanPt[] = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]
    const pairs = truth(plan, 150, 20)
    const off = pairs[2].lngLat
    pairs[2] = { ...pairs[2], lngLat: { lng: off.lng, lat: off.lat + 5 / 111320 } }
    const fit = fitSimilarity(pairs, AR)!
    // least squares spreads the 5 m over the four pairs, but the culprit stays the worst by far
    expect(fit.maxResidualM).toBeGreaterThan(1)
    expect(fit.maxResidualM).toBeLessThan(5)
    expect(fit.residuals.indexOf(fit.maxResidualM)).toBe(2)
    expect(residualClaim(fit)!).toBeGreaterThan(0.5)
    expect(residualClaim(fit)!).toBeLessThanOrEqual(fit.maxResidualM)
  })

  it('residualClaim is null without a fit', () => {
    expect(residualClaim(null)).toBeNull()
  })
})

describe('baseline and collinearity', () => {
  it('measures the widest span between references', () => {
    // two references 0.5 units apart in x at 100 m/unit → 0.5 · AR · 100 m
    const fit = fitSimilarity(truth([{ x: 0.2, y: 0.5 }, { x: 0.7, y: 0.5 }], 100, 0), AR)!
    expect(fit.baselineM).toBeCloseTo(0.5 * AR * 100, 1)
    expect(fit.baselineM).toBeGreaterThan(BASELINE_WARN_M)
  })

  it('flags references that sit too close together', () => {
    const fit = fitSimilarity(truth([{ x: 0.50, y: 0.5 }, { x: 0.53, y: 0.5 }], 100, 0), AR)!
    expect(fit.baselineM).toBeLessThan(BASELINE_WARN_M)
  })

  it('flags near-collinear references from three pairs on', () => {
    const line: PlanPt[] = [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.502 }, { x: 0.9, y: 0.5 }]
    const fit = fitSimilarity(truth(line, 100, 0), AR)!
    expect(fit.collinear).toBe(true)
    expect(fit.axisRatio!).toBeLessThan(0.08)
  })

  it('does not flag a well-spread triangle', () => {
    const fit = fitSimilarity(truth(TRIANGLE, 100, 0), AR)!
    expect(fit.collinear).toBe(false)
    expect(fit.axisRatio!).toBeGreaterThan(0.3)
  })

  it('says nothing about collinearity at two pairs', () => {
    const fit = fitSimilarity(truth([TRIANGLE[0], TRIANGLE[1]], 100, 0), AR)!
    expect(fit.axisRatio).toBeNull()
    expect(fit.collinear).toBe(false)
  })
})

describe('replacePair', () => {
  const at = (x: number, y: number, kind?: GeorefPair['kind']): GeorefPair => ({
    plan: { x, y },
    lngLat: { lng: 7.5 + x / 1000, lat: 47.5 + y / 1000 },
    kind,
  })

  it('appends a pair on a fresh plan point', () => {
    const next = replacePair([at(0.2, 0.2)], at(0.8, 0.8))
    expect(next).toHaveLength(2)
  })

  it('REPLACES in place when the plan point is within epsilon — never appends', () => {
    const pairs = [at(0.2, 0.2), at(0.8, 0.8)]
    const corrected = at(0.2 + PAIR_EPS_N / 2, 0.2 - PAIR_EPS_N / 2, 'korrigiert')
    const next = replacePair(pairs, corrected)
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(corrected) // same slot, so the fit keeps the pair's order/index
    expect(next[1]).toBe(pairs[1])
  })

  it('treats a point just outside epsilon as a new landmark', () => {
    const next = replacePair([at(0.2, 0.2)], at(0.2 + PAIR_EPS_N * 2, 0.2))
    expect(next).toHaveLength(2)
  })

  it('does not mutate the input', () => {
    const pairs = [at(0.2, 0.2)]
    replacePair(pairs, at(0.2, 0.2, 'korrigiert'))
    expect(pairs).toHaveLength(1)
    expect(pairs[0].kind).toBeUndefined()
  })
})

describe('rematchPairs — the operator numbered the two sides differently', () => {
  const SQUARE: PlanPt[] = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }]

  /** the correct pairs, with the MAP halves dealt to the wrong plan points by `perm` */
  const misdealt = (plan: PlanPt[], perm: number[], s = 80, deg = 20): GeorefPair[] => {
    const good = truth(plan, s, deg)
    return good.map((p, i) => ({ ...p, lngLat: good[perm[i]].lngLat, kind: 'gesetzt' as const }))
  }

  it('restores the assignment the geometry actually supports', () => {
    const shuffled = misdealt(SQUARE, [2, 0, 3, 1])
    expect(residualClaim(fitSimilarity(shuffled, AR))! > 10).toBe(true) // garbage as dealt
    const fixed = rematchPairs(shuffled, AR)
    expect(fixed).not.toBeNull()
    expect(fixed!.fit.meanResidualM).toBeLessThan(0.5)
    // every plan point kept its own position; only the map halves were re-dealt
    fixed!.pairs.forEach((p, i) => expect(p.plan).toEqual(SQUARE[i]))
  })

  it('leaves a correct assignment alone, even an imprecise one', () => {
    const good = truth(SQUARE, 80, 20).map((p) => ({ ...p, kind: 'gesetzt' as const }))
    expect(rematchPairs(good, AR)).toBeNull()
    // …and never re-deals a set that is merely BAD without a clearly better assignment
    const noisy = good.map((p, i) => (i === 0 ? { ...p, plan: { x: p.plan.x + 0.15, y: p.plan.y } } : p))
    const before = fitSimilarity(noisy, AR)!.meanResidualM
    const re = rematchPairs(noisy, AR)
    if (re) expect(re.fit.meanResidualM).toBeLessThan(before / 4) // only a dramatic win may re-deal
  })

  it('needs three pairs to say anything', () => {
    expect(rematchPairs(misdealt(SQUARE, [1, 0, 2, 3]).slice(0, 2), AR)).toBeNull()
  })
})
