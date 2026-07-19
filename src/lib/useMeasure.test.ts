import { describe, expect, it } from 'vitest'
import { measureLabels } from './useMeasure'
import type { LngLat } from '../types'

// Pure geometry/labelling of the measurement tool (no React). Coords are a Swiss
// sample location so distances are realistic; we assert structure + monotonic growth
// rather than exact localized strings (those depend on appConfig.locale).
const A: LngLat = [7.55, 47.50]
const B: LngLat = [7.56, 47.50]
const C: LngLat = [7.56, 47.51]
const D: LngLat = [7.55, 47.51]

describe('measureLabels — line mode', () => {
  it('returns one cumulative-distance label per segment, last one strong', () => {
    const labels = measureLabels('line', [A, B, C])
    expect(labels).toHaveLength(2) // 3 vertices → 2 segments
    expect(labels[0].coord).toEqual(B)
    expect(labels[1].coord).toEqual(C)
    expect(labels[0].strong).toBe(false)
    expect(labels[1].strong).toBe(true) // pinned to the last vertex
  })

  it('needs at least 2 points', () => {
    expect(measureLabels('line', [])).toEqual([])
    expect(measureLabels('line', [A])).toEqual([])
  })
})

describe('measureLabels — area mode', () => {
  it('returns a single strong label at the polygon centroid', () => {
    const labels = measureLabels('area', [A, B, C, D])
    expect(labels).toHaveLength(1)
    expect(labels[0].strong).toBe(true)
    // centroid of the square is the mean of the corners
    expect(labels[0].coord[0]).toBeCloseTo((A[0] + B[0] + C[0] + D[0]) / 4, 6)
    expect(labels[0].coord[1]).toBeCloseTo((A[1] + B[1] + C[1] + D[1]) / 4, 6)
  })

  it('needs at least 3 points for an area', () => {
    expect(measureLabels('area', [A, B])).toEqual([])
  })
})
