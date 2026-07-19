import { describe, expect, it } from 'vitest'
import { LINE_DASH_ML, LINE_DASH_SVG } from './draw'

// The line-style constants are the single source of truth shared by the MapLibre
// (line-width-multiple units) and SVG (px units) renderers, so a regression here
// would silently desync dashed lines between the Lage map and Plan whiteboard.
describe('line dash constants', () => {
  it('exposes a 2-tuple MapLibre dasharray (units = line-width multiples)', () => {
    expect(LINE_DASH_ML).toEqual([2, 1.6])
    expect(LINE_DASH_ML).toHaveLength(2)
    for (const n of LINE_DASH_ML) expect(n).toBeGreaterThan(0)
  })

  it('exposes the SVG stroke-dasharray string (units = px)', () => {
    expect(LINE_DASH_SVG).toBe('6 5')
    // two positive px values, space-separated
    const parts = LINE_DASH_SVG.split(' ').map(Number)
    expect(parts).toHaveLength(2)
    for (const n of parts) expect(n).toBeGreaterThan(0)
  })
})
