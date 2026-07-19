import { describe, expect, it } from 'vitest'
import { SHAPE_DEFS, SHAPE_ORDER } from './shapes'
import type { ShapeKind } from '../types'

describe('SHAPE_ORDER / SHAPE_DEFS', () => {
  it('lists the three shape kinds in pick order', () => {
    expect(SHAPE_ORDER).toEqual(['arrow', 'cloud', 'square'])
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
