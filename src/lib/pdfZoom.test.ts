import { describe, expect, it } from 'vitest'
import { clampZoom, pinchZoom, scrollAfterZoom, stepZoom, toggleZoom, ZOOM_MAX } from './pdfZoom'

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
})
