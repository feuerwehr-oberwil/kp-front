import { describe, it, expect } from 'vitest'
import { principalAngleDeg, buildView, northVec, remapPoint, type Ring, type Pt } from './footprint'

const rad = (d: number) => (d * Math.PI) / 180
// rotate a point around a center (matches the lib's screen-space convention)
function rot([x, y]: Pt, deg: number, [cx, cy]: Pt): Pt {
  const a = rad(deg), c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy
  return [cx + dx * c - dy * s, cy + dx * s + dy * c]
}
// a 2:1 rectangle (long axis horizontal), isotropic 0..1-ish board space
const RECT: Ring[] = [[[0, 0], [1, 0], [1, 0.5], [0, 0.5]]]

describe('principalAngleDeg', () => {
  it('leaves an axis-aligned rectangle north-up (snaps to 0)', () => {
    expect(principalAngleDeg(RECT)).toBe(0)
  })

  it('treats a near-square footprint as north-up', () => {
    const square: Ring[] = [[[0, 0], [1, 0], [1, 0.97], [0, 0.97]]]
    expect(principalAngleDeg(square)).toBe(0)
  })

  it('orients a rotated rectangle so its longest axis becomes horizontal', () => {
    const turned = RECT.map((ring) => ring.map((p) => rot(p, 30, [0.5, 0.25])))
    const angle = principalAngleDeg(turned)
    // applying the returned angle must flatten it back to the wide 2:1 box (h/w ≈ 0.5)
    expect(buildView(turned, angle).aspect).toBeCloseTo(0.5, 2)
  })

  it('handles an arbitrary rotation (47°) the same way', () => {
    const turned = RECT.map((ring) => ring.map((p) => rot(p, 47, [0.5, 0.25])))
    expect(buildView(turned, principalAngleDeg(turned)).aspect).toBeCloseTo(0.5, 2)
  })

  // ⚠️ The guard used to ask whether the rotated BOUNDING BOX is nearly square, which is a
  // page-fit question. An L-shaped building answers it «yes» while its walls run unmistakably
  // in one direction — so the Schloss stayed tilted 21° on the sheet, corners and all.
  it('turns an L-shaped building whose walls agree, even when its box is square', () => {
    const L: Ring[] = [[[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]]]
    const turned = L.map((ring) => ring.map((p) => rot(p, 21, [0.5, 0.5])))
    const angle = principalAngleDeg(turned)
    // the walls end up square to the sheet again — and by the SHORTER turn of the two that do
    // it (−21° rather than +69°), so the sheet stays as close to north-up as squaring allows
    expect(angle).toBeCloseTo(-21, 0)
    // …and the box they end up in is the nearly-square one the old guard vetoed on
    expect(buildView(turned, angle).aspect).toBeGreaterThan(0.92)
  })

  it('sits a diamond back down on its side', () => {
    const square: Ring[] = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    const diamond = square.map((ring) => ring.map((p) => rot(p, 45, [0.5, 0.5])))
    expect(Math.abs(principalAngleDeg(diamond))).toBeCloseTo(45, 0)
  })

  // …and a footprint with no dominant direction has no «longest axis» worth turning to
  it('leaves a round outline north-up', () => {
    const circle: Ring[] = [Array.from({ length: 48 }, (_, i): Pt => {
      const a = (i / 48) * Math.PI * 2
      return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]
    })]
    expect(principalAngleDeg(circle)).toBe(0)
  })
})

describe('buildView', () => {
  it('toNorm/fromNorm are inverses', () => {
    const v = buildView(RECT, 23)
    for (const n of [[0.2, 0.7], [0, 0], [1, 1], [0.5, 0.5]] as Pt[]) {
      const back = v.toNorm(v.fromNorm(n))
      expect(back[0]).toBeCloseTo(n[0], 9)
      expect(back[1]).toBeCloseTo(n[1], 9)
    }
  })

  it('reports aspect = bbox h/w', () => {
    expect(buildView(RECT, 0).aspect).toBeCloseTo(0.5, 9)
  })
})

describe('northVec', () => {
  it('points straight up when unrotated', () => {
    expect(northVec(0)).toEqual([0, -1])
  })
  it('rotates clockwise with the footprint', () => {
    const [x, y] = northVec(90)
    expect(x).toBeCloseTo(1, 9) // 90° → north now points to the right
    expect(y).toBeCloseTo(0, 9)
  })
})

describe('remapPoint', () => {
  const layout = { boardW: 1000, boardH: 1200, floors: 3 }
  const turned = RECT.map((ring) => ring.map((p) => rot(p, 30, [0.5, 0.25])))
  const orientDeg = principalAngleDeg(turned)

  it('round-trips a chip there-and-back to its original tile position', () => {
    for (const p of [[0.5, 0.5], [0.3, 0.62], [0.8, 0.4]] as Pt[]) {
      const moved = remapPoint(turned, orientDeg, 0, layout, p)
      const back = remapPoint(turned, 0, orientDeg, layout, moved)
      expect(back[0]).toBeCloseTo(p[0], 9)
      expect(back[1]).toBeCloseTo(p[1], 9)
    }
  })

  it('is identity when the orientation does not change', () => {
    const p: Pt = [0.42, 0.58]
    const same = remapPoint(turned, orientDeg, orientDeg, layout, p)
    expect(same[0]).toBeCloseTo(p[0], 9)
    expect(same[1]).toBeCloseTo(p[1], 9)
  })
})
