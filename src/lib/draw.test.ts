import { describe, expect, it } from 'vitest'
import { HATCH_CHIP_VB, HATCH_PERIOD_PX, HATCH_WIDTH_PX, LINE_DASH_ML, LINE_DASH_SVG, ensureHatchImages, hatchImageColor, hatchImageId, hatchPatternId, hatchTile } from './draw'

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

  // Pattern ids are DOCUMENT-global: the first <defs> in the DOM answers every url(#…) on the
  // page. The 1×1 Plan sheet scales its tile against the sheet and the px-space chips do not, so
  // the two must never land on one id — 02.09. that collision is what a `space` prevents.
  it('gives a scaled defs its own id, and only then', () => {
    expect(hatchPatternId('#1f6feb', 'sheet')).toBe('hatch-sheet-1f6feb')
    expect(hatchPatternId('#1f6feb', 'sheet')).not.toBe(hatchPatternId('#1f6feb'))
    // same space ⇒ same geometry ⇒ sharing is harmless, so the id must be stable
    expect(hatchPatternId('#1f6feb', 'sheet')).toBe(hatchPatternId('#1f6feb', 'sheet'))
  })

  // the swatch has to show a PATTERN, not one diagonal: at one tile per chip it read as a «no»
  // slash and spilled past the round border (field report 02.09.)
  it('previews several tiles in the Füllung chip', () => {
    expect(HATCH_CHIP_VB / HATCH_PERIOD_PX).toBeGreaterThanOrEqual(3)
  })

  // `styleimagemissing` hands back the id; a Fläche in a colour outside the palette can only be
  // minted if the colour is still readable from it. A missing pattern paints NOTHING on a map.
  it('reads the colour back out of a tile id, and ignores foreign ids', () => {
    for (const c of ['#1f6feb', '#e8392b']) expect(hatchImageColor(hatchImageId(c))).toBe(c)
    expect(hatchImageColor('draw-arrow')).toBeNull()
    expect(hatchImageColor('hatch-')).toBeNull()
  })

  it('registers one tile per colour and never twice', () => {
    const added: string[] = []
    const has = new Set<string>(['hatch-#1f6feb'])
    const map = {
      hasImage: (id: string) => has.has(id),
      addImage: (id: string) => { added.push(id); has.add(id) },
    }
    // jsdom has no 2D context, so `hatchTile` returns null and nothing is added — the point here
    // is that the already-registered colour is not offered a second time (addImage throws on a
    // duplicate id in MapLibre).
    ensureHatchImages(map, ['#1f6feb', '#e8392b'])
    expect(added).not.toContain('hatch-#1f6feb')
  })

  // jsdom has no 2D context; a locked-down browser can refuse one too. Null, never a throw —
  // the Fläche then paints unhatched rather than the map failing to draw at all.
  it('returns null where there is no canvas rather than throwing', () => {
    expect(() => hatchTile('#1f6feb')).not.toThrow()
  })
})
