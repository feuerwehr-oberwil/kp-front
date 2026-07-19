import { describe, expect, it } from 'vitest'
import { clamp01, floorGeometry, floorLabel, planUrl, TILE_AR, TOP_INSET } from './whiteboard'

describe('planUrl', () => {
  it('leaves absolute http(s) URLs untouched', () => {
    expect(planUrl('https://example.com/p.pdf')).toBe('https://example.com/p.pdf')
    expect(planUrl('http://example.com/p.pdf')).toBe('http://example.com/p.pdf')
  })

  it('leaves protocol-relative and root-absolute URLs untouched', () => {
    expect(planUrl('//cdn/p.pdf')).toBe('//cdn/p.pdf')
    expect(planUrl('/api/reference/plan:obj:modul1')).toBe('/api/reference/plan:obj:modul1')
  })

  it('prefixes a relative path with BASE_URL', () => {
    const base = import.meta.env.BASE_URL
    expect(planUrl('plans/x.pdf')).toBe(`${base}plans/x.pdf`)
  })
})

describe('clamp01', () => {
  it('clamps below 0 and above 1', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
  })
  it('passes in-range values through, including the bounds', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(1)).toBe(1)
    expect(clamp01(0.42)).toBe(0.42)
  })
})

describe('floorLabel', () => {
  it('labels the ground floor as EG', () => expect(floorLabel(0)).toBe('EG'))
  it('labels upper floors as "N. OG"', () => {
    expect(floorLabel(1)).toBe('1. OG')
    expect(floorLabel(3)).toBe('3. OG')
  })
  it('labels basements as "N. UG" (sign flipped)', () => {
    expect(floorLabel(-1)).toBe('1. UG')
    expect(floorLabel(-2)).toBe('2. UG')
  })
})

describe('constants', () => {
  it('exposes the tile aspect ratio and top inset', () => {
    expect(TILE_AR).toBeCloseTo(0.72)
    expect(TOP_INSET).toBe(80)
  })
})

describe('floorGeometry — single-sheet (identity) mode', () => {
  const g = floorGeometry(false, [0], 1)
  it('mapY is the identity', () => expect(g.mapY(0, 0.4)).toBe(0.4))
  it('localY is the identity', () => expect(g.localY(0.4, 0)).toBe(0.4))
})

describe('floorGeometry — stack mode', () => {
  // 3 storeys top-to-bottom: [2, 1, 0] (top = highest). N = 3.
  const floorsTTB = [2, 1, 0]
  const g = floorGeometry(true, floorsTTB, 3)

  it('mapY lifts a tile-local y into the storey band (top storey first)', () => {
    // storey 2 is the top tile (idx 0) → y stays in [0, 1/3]
    expect(g.mapY(2, 0)).toBeCloseTo(0)
    expect(g.mapY(2, 1)).toBeCloseTo(1 / 3)
    // storey 0 is the bottom tile (idx 2) → y in [2/3, 1]
    expect(g.mapY(0, 0)).toBeCloseTo(2 / 3)
    expect(g.mapY(0, 1)).toBeCloseTo(1)
  })

  it('mapY treats an unknown floor as the tile-local y (idx < 0)', () => {
    expect(g.mapY(99, 0.5)).toBe(0.5)
    // floor ?? 0 resolves to storey 0, which IS a known floor (idx 2, bottom tile)
    expect(g.mapY(undefined, 0.3)).toBeCloseTo((2 + 0.3) / 3)
  })

  it('localY inverts mapY for a given storey (clamped to [0,1])', () => {
    // board-normalized 0.5 sits in storey 1 (idx 1) → local 0.5
    expect(g.localY(0.5, 1)).toBeCloseTo(0.5)
    // outside the storey band clamps to 0/1
    // storey 2 band is [0,1/3]; ny=0.9 is above it → clamp01(0.9*3 - 0) = 1
    expect(g.localY(0.9, 2)).toBe(1)
    // storey 0 band is [2/3,1]; ny=0.1 is below it → clamp01(0.1*3 - 2) = 0
    expect(g.localY(0.1, 0)).toBe(0)
  })

  it('floorAt resolves which storey a board-normalized y falls into', () => {
    expect(g.floorAt(0.0)).toBe(2) // top tile
    expect(g.floorAt(0.5)).toBe(1) // middle tile
    expect(g.floorAt(0.99)).toBe(0) // bottom tile
  })

  it('floorAt clamps out-of-range y to the first/last storey', () => {
    expect(g.floorAt(-1)).toBe(2)
    expect(g.floorAt(2)).toBe(0)
  })

  it('mapY ∘ localY round-trips a mid-storey point', () => {
    const ny = g.mapY(1, 0.3)
    expect(g.localY(ny, 1)).toBeCloseTo(0.3)
  })
})
