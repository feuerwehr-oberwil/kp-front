import { describe, expect, it } from 'vitest'
import { alignmentBounds, alignmentCorners, reviewableAlignment } from './planAlignmentReview'
import { fitSimilarity, type GeorefPair } from './georef'

const pairs: GeorefPair[] = [
  { plan: { x: .1, y: .2 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'auto' },
  { plan: { x: .8, y: .9 }, lngLat: { lng: 7.552, lat: 47.509 }, kind: 'auto' },
]

describe('admin alignment geometry', () => {
  it('projects exact PDF image corners in MapLibre order without swapping latitude or page axes', () => {
    const corners = alignmentCorners(pairs, .7)!
    const fit = fitSimilarity(pairs, .7)!
    const expected = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    corners.forEach(([lng, lat], i) => {
      expect(fit.toPlan({ lng, lat }).x).toBeCloseTo(expected[i].x)
      expect(fit.toPlan({ lng, lat }).y).toBeCloseTo(expected[i].y)
    })
  })
  it('uses actual provider rings to frame a no-match result', () => {
    expect(alignmentBounds([[{ lng: 7.5, lat: 47 }, { lng: 7.6, lat: 48 }]], [])).toEqual([[7.5, 47], [7.6, 48]])
    expect(alignmentBounds([], [])).toBeNull()
  })
  it('refuses missing scale/aspect or a degenerate fit, while accepting genuine manual pairs', () => {
    expect(reviewableAlignment(pairs, null)).toBe(false)
    expect(reviewableAlignment([pairs[0], pairs[0]], 1)).toBe(false)
    expect(reviewableAlignment(pairs.map(p => ({ ...p, kind: 'gesetzt' })), .7)).toBe(true)
  })
})
