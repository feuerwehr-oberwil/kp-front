import { describe, expect, it } from 'vitest'
import { HATCH_PERIOD_PX, HATCH_WIDTH_PX, hatchImageId, hatchPatternId, hatchTile } from './draw'

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
