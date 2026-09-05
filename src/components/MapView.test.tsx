// @vitest-environment jsdom
/**
 * Where a «+» insert grip sits on a SELECTED Zeichnung.
 *
 * Until 05.09. the row was all-or-nothing: it appeared only while every stored vertex still had a
 * pad, so the default line tool (freehand) never got one on a phone, where the pads are thinned
 * hardest. The grip is now placed half-way ALONG the ink between two pads instead of across the
 * chord between them — which is what makes it honest on a thinned stroke: the node it leaves lies
 * on the line, so inserting it changes no geometry at all.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { LngLat } from '../types'

// the module renders MapLibre; only its two pure geometry helpers are under test here
vi.mock('react-map-gl/maplibre', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Marker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Source: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Layer: () => null,
}))

// maplibre-gl mints its worker URL from a Blob at import time; jsdom has no createObjectURL
window.URL.createObjectURL ??= () => 'blob:test'

const { handleGaps, subPathInsert } = await import('./MapView')

describe('handleGaps — one «+» per gap between shown pads', () => {
  it('pairs consecutive pads on a line, and adds no closing gap', () => {
    expect(handleGaps([0, 1, 2, 3], 4, false)).toEqual([[0, 1], [1, 2], [2, 3]])
  })

  it('…and on a thinned stroke pairs the pads that are actually shown', () => {
    expect(handleGaps([0, 7, 20, 41], 42, false)).toEqual([[0, 7], [7, 20], [20, 41]])
  })

  it('an area also gets the closing gap, back through the wrap', () => {
    expect(handleGaps([0, 1, 2], 3, true)).toEqual([[0, 1], [1, 2], [2, 0]])
  })

  it('a single pad has no gap to sit in', () => {
    expect(handleGaps([0], 1, true)).toEqual([])
  })
})

describe('subPathInsert — the grip sits ON the ink', () => {
  const line: LngLat[] = [[0, 0], [1, 0], [2, 0], [3, 0]]

  it('is the plain segment midpoint when both pads are adjacent', () => {
    expect(subPathInsert(line, 1, 2)).toEqual({ index: 2, coord: [1.5, 0] })
  })

  it('walks the stored path when vertices are hidden between the two pads', () => {
    // 0 → 3 is three equal segments; half-way along lands in the middle of the second one,
    // i.e. on the line and NOT on the chord's own midpoint by accident of a straight path
    expect(subPathInsert(line, 0, 3)).toEqual({ index: 2, coord: [1.5, 0] })
  })

  it('follows a bend rather than cutting across it', () => {
    // an L: right 1, then up 3. Half-way (2 of 4) is a third of the way up the long leg — the
    // chord's own midpoint would be [0.5, 1.5], which is nowhere near the ink
    const bent: LngLat[] = [[0, 0], [1, 0], [1, 3]]
    const { index, coord } = subPathInsert(bent, 0, 2)
    expect(index).toBe(2)
    expect(coord[0]).toBeCloseTo(1)
    expect(coord[1]).toBeCloseTo(1)
  })

  it('inserts the area\'s closing grip past the last vertex', () => {
    const ring: LngLat[] = [[0, 0], [2, 0], [2, 2]]
    expect(subPathInsert(ring, 2, 0)).toEqual({ index: 3, coord: [1, 1] })
  })

  it('hands back a usable point when the two pads sit on the same coordinate', () => {
    const flat: LngLat[] = [[5, 5], [5, 5]]
    expect(subPathInsert(flat, 0, 1)).toEqual({ index: 1, coord: [5, 5] })
  })
})
