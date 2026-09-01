import { describe, expect, it } from 'vitest'
import { HATCH_PERIOD_PX, HATCH_WIDTH_PX, LINE_DASH_ML, LINE_DASH_SVG, hatchImageId, hatchPatternId, hatchTile } from './draw'

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

// The FKS draws an affected AREA hatched rather than washed. One geometry serves three renderers
// (SVG pattern on the Plan, a MapLibre fill-pattern tile on the Lage, ruled lines in the print),
// so what matters here is that the two id schemes agree and that a missing canvas degrades.
describe('Schraffur', () => {
  it('names a colour’s tile and its pattern from the same colour', () => {
    expect(hatchImageId('#E8392B')).toBe('hatch-#e8392b')
    expect(hatchPatternId('#e8392b')).toBe('hatch-e8392b')
  })

  // the map builds the image name in a style expression: ['concat', 'hatch-', downcase(color)]
  it('the tile id is exactly what the map’s expression builds', () => {
    for (const c of ['#1f6feb', '#E8392B', '#ffffff']) {
      expect(hatchImageId(c)).toBe(`hatch-${c.toLowerCase()}`)
    }
  })

  it('keeps the line thin against the period, or the hatch reads as a solid fill', () => {
    expect(HATCH_WIDTH_PX).toBeLessThan(HATCH_PERIOD_PX / 4)
  })

  // jsdom has no 2D context; a locked-down browser can refuse one too. Null, never a throw —
  // the Fläche then paints unhatched rather than the map failing to draw at all.
  it('returns null where there is no canvas rather than throwing', () => {
    expect(() => hatchTile('#1f6feb')).not.toThrow()
  })
})
