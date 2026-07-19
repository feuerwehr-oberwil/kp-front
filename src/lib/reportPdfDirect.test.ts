import { describe, it, expect } from 'vitest'
import { floorStackPages, planAnnosForPdf } from './reportPdfDirect'
import { TILE_AR } from './whiteboard'
import type { BoardAnno, BuildingDoc, PlanDocument } from '../types'

describe('planAnnosForPdf', () => {
  it('resolves a plan shape to a client-rendered svg glyph with its plan-relative size', () => {
    const annos: BoardAnno[] = [{ id: 'sh1', kind: 'shape', shape: 'cloud', x: 0.5, y: 0.5, sizeN: 0.2, color: '#123456', label: 'Rauch' }]
    const [out] = planAnnosForPdf(annos, {})
    expect(out.kind).toBe('symbol') // travels through the server's existing symbol branch
    expect(String(out.symbolSvg)).toContain('#123456')
    expect(out.sizeN).toBe(0.2)
    expect(out.label).toBeUndefined() // the implicit shape name must not print as a label
  })

  it('falls back to the shape defaults when colour/size were never touched', () => {
    const [out] = planAnnosForPdf([{ id: 'sh2', kind: 'shape', shape: 'arrow', x: 0.1, y: 0.1 }], {})
    expect(String(out.symbolSvg)).toContain('<svg')
    expect(typeof out.sizeN).toBe('number')
  })
})

describe('floorStackPages', () => {
  const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const building: BuildingDoc = { ring, ringAspect: 0.8, floors: [1, 0, -1], src: [ring], orientDeg: 0, northUp: true }
  const plan: PlanDocument = { id: 'gebaeude', code: 'GB', title: 'Gebäude', subtitle: '', imageUrl: '', orientation: 'portrait', floorStack: true }

  it('chunks max 2 storeys per page, top storey first, with matching aspects and labels', () => {
    const pages = floorStackPages(plan, building, [], {})
    expect(pages).toHaveLength(2)
    expect(pages[0].label).toBe('Gebäude · 1. OG – EG')
    expect(pages[0].blankAspect).toBeCloseTo(2 * TILE_AR)
    expect(pages[1].label).toBe('Gebäude · 1. UG')
    expect(pages[1].blankAspect).toBeCloseTo(TILE_AR)
  })

  it('lifts tile-local annos into page space on the right page', () => {
    const annos: BoardAnno[] = [
      { id: 'a', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor: 0 },   // EG → page 1, lower tile
      { id: 'b', kind: 'draw', pts: [[0.2, 0.4], [0.8, 0.6]], floor: -1, color: '#1f6feb' }, // UG → page 2
    ]
    const pages = floorStackPages(plan, building, annos, {})
    const sym = pages[0].annos.find((x) => x.symbol === 'VKF Feuer')!
    expect(sym.y).toBeCloseTo((1 + 0.5) / 2) // second tile of a 2-tile page
    expect(pages[1].annos.some((x) => x.kind === 'draw' && Array.isArray(x.pts) && (x.pts as number[][])[0][1] === 0.4)).toBe(true)
    // an anno on a storey the building no longer has is dropped, not misplaced
    expect(floorStackPages(plan, building, [{ id: 'c', kind: 'text', x: 0.5, y: 0.5, floor: 4, text: 'x' }], {})
      .flatMap((p) => p.annos).some((x) => x.text === 'x')).toBe(false)
  })

  it('draws chrome on every page: outline area, floor-label pill, dial only on the first', () => {
    const pages = floorStackPages(plan, building, [], {})
    for (const p of pages) {
      expect(p.annos.some((x) => x.kind === 'area')).toBe(true)
      expect(p.annos.some((x) => x.kind === 'text')).toBe(true)
    }
    expect(pages[0].annos.some((x) => typeof x.symbolSvg === 'string' && String(x.symbolSvg).includes('>N<'))).toBe(true)
    expect(pages[1].annos.some((x) => typeof x.symbolSvg === 'string' && String(x.symbolSvg).includes('>N<'))).toBe(false)
    // outline points stay inside the page box
    const pts = pages[0].annos.filter((x) => x.kind === 'area').flatMap((x) => x.pts as number[][])
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1) }
  })
})
