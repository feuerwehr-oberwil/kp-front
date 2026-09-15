import { describe, expect, it } from 'vitest'
import { canvasScale, clampZoom, MAX_CANVAS_PX, pageCanvasBudget, pinchZoom, scrollAfterZoom, stepZoom, toggleZoom, ZOOM_MAX, anchorScroll, pageAnchorAt } from './pdfZoom'

describe('pdfZoom – the reader zooms between fit and 4×', () => {
  it('steps multiply, clamp, and snap back to exactly 1 near the fit', () => {
    expect(stepZoom(1, 1.3)).toBe(1.3)
    expect(stepZoom(1.3, 1 / 1.3)).toBe(1)
    expect(stepZoom(1.01, 1 / 1.3)).toBe(1)
    expect(stepZoom(3.9, 1.3)).toBe(ZOOM_MAX)
    expect(clampZoom(0.2)).toBe(1)
  })
  it('a pinch scales from the gesture start and ignores degenerate distances', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2)
    expect(pinchZoom(2, 200, 100)).toBe(1)
    expect(pinchZoom(2, 200, 50)).toBe(1) // clamped at the fit
    expect(pinchZoom(2, 0, 50)).toBe(2)
  })
  it('double tap goes in to 2× and back to the fit', () => {
    expect(toggleZoom(1)).toBe(2)
    expect(toggleZoom(2)).toBe(1)
    expect(toggleZoom(3.5)).toBe(1)
  })
  it('the point under the finger stays put when the column re-scales', () => {
    // a point 100px below the viewport top while scrolled 300px sits at document y=400; at 2× it
    // sits at 800, so the viewport must scroll to 700 to keep it 100px from the top
    expect(scrollAfterZoom({ left: 0, top: 300 }, { x: 0, y: 100 }, 2)).toEqual({ left: 0, top: 700 })
    expect(scrollAfterZoom({ left: 50, top: 700 }, { x: 20, y: 100 }, 0.5)).toEqual({ left: 15, top: 300 })
  })
  it('the backing store never exceeds what iOS Safari will draw – the fit renders at the DPR, a zoomed A4 lowers it', () => {
    // a 1100px column at 2× DPR: 2200 × 3111 = 6.8M px, well inside the budget
    expect(canvasScale(1100, 1556, 2)).toBe(2)
    // the same A4 page at 4×: 4400 × 6222 css px, 2× DPR would be 110M px – blank on an iPad
    // (the reader FLOORS the backing dims, so the integer product is what the budget bounds)
    const px = (w: number, h: number, k: number) => Math.floor(w * k) * Math.floor(h * k)
    const k = canvasScale(4400, 6222, 2)
    expect(k).toBeLessThan(1)
    expect(px(4400, 6222, k)).toBeLessThanOrEqual(MAX_CANVAS_PX)
    expect(px(4400, 6222, k)).toBeGreaterThan(MAX_CANVAS_PX * 0.99)
    // a stitched Modul 6 (four sheets tall) is too tall at the FIT on an iPad Pro already
    expect(px(1100, 4400, canvasScale(1100, 4400, 2))).toBeLessThanOrEqual(MAX_CANVAS_PX)
    // the side limit binds before the area on a very long strip
    expect(canvasScale(600, 12000, 2)).toBeCloseTo(8192 / 12000, 6)
    // degenerate input is left at the DPR rather than NaN
    expect(canvasScale(0, 0, 2)).toBe(2)
  })
  it('a long document shares one budget between its pages', () => {
    expect(pageCanvasBudget(1)).toBe(MAX_CANVAS_PX)
    expect(pageCanvasBudget(5)).toBe(MAX_CANVAS_PX)
    expect(pageCanvasBudget(30)).toBe(3_200_000)
    expect(pageCanvasBudget(0)).toBe(MAX_CANVAS_PX)
  })
})

// A pinch keeps the spot under the fingers (15.09.2026): the column's padding and gaps do not
// scale with the pages, so the scroll is re-derived from a spot ON a page, not multiplied.
describe('the page anchor under a zoom', () => {
  const pages = [
    { left: 20, top: 88, width: 300, height: 400 },
    { left: 20, top: 500, width: 300, height: 400 },
  ]
  it('finds the page and the spot on it as fractions', () => {
    expect(pageAnchorAt(pages, { x: 170, y: 288 })).toEqual({ index: 0, fx: 0.5, fy: 0.5 })
    expect(pageAnchorAt(pages, { x: 20, y: 900 })).toEqual({ index: 1, fx: 0, fy: 1 })
  })
  it('a point in the gap or padding anchors to the nearest page', () => {
    expect(pageAnchorAt(pages, { x: 100, y: 497 })?.index).toBe(1)
    expect(pageAnchorAt(pages, { x: 100, y: 10 })?.index).toBe(0)
    expect(pageAnchorAt([], { x: 0, y: 0 })).toBeNull()
  })
  it('puts the spot back under the focal point once the page is twice as big', () => {
    const scroller = { left: 0, top: 0, width: 390, height: 800 }
    // page 0 laid out at 2×, scrolled to 0: its origin is at content (20, 88), size 600×800
    const zoomed = { left: 20, top: 88, width: 600, height: 800 }
    const anchor = { index: 0, fx: 0.5, fy: 0.5 }
    const focal = { x: 170, y: 288 }
    expect(anchorScroll(scroller, { left: 0, top: 0 }, zoomed, anchor, focal)).toEqual({ left: 150, top: 200 })
    // …and when the scroller was already scrolled, the page box moved with it – same answer
    expect(anchorScroll(scroller, { left: 40, top: 100 }, { ...zoomed, left: -20, top: -12 }, anchor, focal)).toEqual({ left: 150, top: 200 })
  })
  it('never asks for a negative scroll', () => {
    expect(anchorScroll({ left: 0, top: 0, width: 390, height: 800 }, { left: 0, top: 0 }, { left: 20, top: 88, width: 300, height: 400 }, { index: 0, fx: 0, fy: 0 }, { x: 170, y: 288 })).toEqual({ left: 0, top: 0 })
  })
})
