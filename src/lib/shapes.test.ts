import { describe, expect, it } from 'vitest'
import { ROTATION_MAX_M, SHAPE_DEFS, SHAPE_FREE_ASPECT, SHAPE_ORDER, rotationInner, rotationViewBox, shapeAspect } from './shapes'
import type { ShapeKind } from '../types'

describe('SHAPE_ORDER / SHAPE_DEFS', () => {
  it('lists the shape kinds in pick order', () => {
    expect(SHAPE_ORDER).toEqual(['arrow', 'cloud', 'square', 'rotation'])
  })

  it('has a def for every kind in the order, and vice-versa', () => {
    const defKeys = Object.keys(SHAPE_DEFS) as ShapeKind[]
    expect(defKeys.sort()).toEqual([...SHAPE_ORDER].sort())
  })

  it('every def carries a hex colour and positive default sizes (map metres + plan fraction)', () => {
    for (const k of SHAPE_ORDER) {
      expect(SHAPE_DEFS[k].defaultColor).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(SHAPE_DEFS[k].defaultSizeM).toBeGreaterThan(0)
      expect(SHAPE_DEFS[k].defaultSizeN).toBeGreaterThan(0)
      expect(SHAPE_DEFS[k].defaultSizeN).toBeLessThan(1)
    }
  })

  it('keeps the tuned per-shape defaults (smoke larger/grey, arrow blue, box red)', () => {
    expect(SHAPE_DEFS.arrow).toEqual({ defaultColor: '#1f6feb', defaultSizeM: 45, defaultSizeN: 0.1 })
    expect(SHAPE_DEFS.cloud).toEqual({ defaultColor: '#6b7280', defaultSizeM: 80, defaultSizeN: 0.18 })
    expect(SHAPE_DEFS.square).toEqual({ defaultColor: '#e8392b', defaultSizeM: 45, defaultSizeN: 0.1 })
    // the smoke cloud starts larger than the arrow/box — on both surfaces
    expect(SHAPE_DEFS.cloud.defaultSizeM).toBeGreaterThan(SHAPE_DEFS.arrow.defaultSizeM)
    expect(SHAPE_DEFS.cloud.defaultSizeN).toBeGreaterThan(SHAPE_DEFS.arrow.defaultSizeN)
  })
})

// The Rotation loop is a shuttle RUN between two places, so it is a stretchable shape rather than
// a symbol dropped at a point (FKS Vegetationsbrand S. 52/53, decision 01.09.).
describe('the Rotation loop', () => {
  it('starts long and flat, and stretches freely', () => {
    expect(SHAPE_FREE_ASPECT.rotation).toBe(true)
    expect(SHAPE_DEFS.rotation.defaultAspect).toBeLessThan(1)
    expect(SHAPE_DEFS.rotation.defaultSizeM).toBeGreaterThan(SHAPE_DEFS.cloud.defaultSizeM)
  })

  // ⚠️ Every other shape is capped at 500 m. A Wasserpendel between the Weiher and the
  // Brandstelle is kilometres, and that cap was why the only way to make the loop long was to
  // make it enormous in both axes (MapMarkers · shapeMove keeps the width and stretches this).
  it('may be drawn far past the 500 m every other shape is capped at', () => {
    expect(ROTATION_MAX_M).toBeGreaterThan(5000)
  })

  it('falls back to its own default aspect, not to square', () => {
    expect(shapeAspect('rotation', undefined)).toBe(SHAPE_DEFS.rotation.defaultAspect)
    expect(shapeAspect('rotation', 0.8)).toBe(0.8)
    // …and an aspect-locked kind still ignores both
    expect(shapeAspect('arrow', 0.4)).toBe(1)
  })

  // ⚠️ The glyph is painted with preserveAspectRatio="none". Its viewBox therefore has to MATCH
  // the aspect, or one unit of y is `asp` units of x — which came out as a fat-ended outline and
  // flattened arrowheads exactly when the loop is long, which is always.
  it('matches its viewBox to the aspect, so the units stay square', () => {
    expect(rotationViewBox(0.25)).toBe('0 0 100 25.00')
    expect(rotationViewBox(1)).toBe('0 0 100 100.00')
  })

  // …and everything drawn in it is sized off the loop's HEIGHT, not the 100-unit width: a user
  // unit is width/100 whatever the aspect, so anything sized as a share of the width grew with
  // the run — a 15 px outline and arrowheads the size of a vehicle on a long Rotation.
  it('scales the stroke off the height, clamped at both ends', () => {
    const sw = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)![1])
    expect(sw(rotationInner('#1f6feb', 0.16))).toBeLessThan(sw(rotationInner('#1f6feb', 0.32)))
    expect(sw(rotationInner('#1f6feb', 0.05))).toBeGreaterThanOrEqual(2)   // floor
    expect(sw(rotationInner('#1f6feb', 5))).toBeLessThanOrEqual(4)         // ceiling
  })

  it('draws the loop and both directions in the shape’s own colour', () => {
    const svg = rotationInner('#e8392b', 0.3)
    expect(svg).toContain('stroke="#e8392b"')
    expect((svg.match(/fill="#e8392b"/g) ?? []).length).toBe(2) // one head per leg
  })
})
