import { describe, expect, it } from 'vitest'
import { LABEL_TILES, labelLayers, labelWarmUrls, scaleTextSize } from './basemapLabels'

describe('basemap labels', () => {
  it('scales a fixed size and every zoom stop', () => {
    expect(scaleTextSize(10, 1.3)).toBeCloseTo(13)
    expect(scaleTextSize({ type: 'exponential', stops: [[15, 9], [18, 12]] }, 1.3)).toEqual({ type: 'exponential', stops: [[15, 9 * 1.3], [18, 12 * 1.3]] })
  })

  it('draws the street names bigger than CARTO, on the given source, with prefixed ids', () => {
    const roads = labelLayers('s-base-carto-labels', 'l-base-carto-labels', false).find((l) => l.id === 'l-base-carto-labels-roadname_minor')
    expect(roads).toMatchObject({ source: 's-base-carto-labels', 'source-layer': 'transportation_name' })
    expect(roads!.layout!['text-size']).toBeCloseTo(9 * 1.3)
    // our own glyph sets, never CARTO's font stack
    expect(roads!.layout!['text-font']).toEqual(['NotoSans-Regular'])
  })

  it('keeps CARTO\'s colours by day and paints every name light at night', () => {
    const day = labelLayers('s', 'l', false)
    const night = labelLayers('s', 'l', true)
    expect(day.find((l) => l.id === 'l-roadname_minor')!.paint!['text-color']).toBe('#87919e')
    expect(night.every((l) => l.paint!['text-color'] === '#e4e4e4')).toBe(true)
  })

  it('never asks for an icon – there is no sprite', () => {
    expect(labelLayers('s', 'l', false).some((l) => Object.keys(l.layout ?? {}).some((k) => k.startsWith('icon-')))).toBe(false)
  })

  it('warms the area\'s z14 label tiles and every glyph range for offline', () => {
    const urls = labelWarmUrls({ west: 7.55, south: 47.51, east: 7.56, north: 47.52 })
    const tiles = urls.filter((u) => u.startsWith(LABEL_TILES[0].split('{z}')[0]))
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every((u) => u.includes('/14/'))).toBe(true)
    expect(urls.filter((u) => u.startsWith('/fonts/'))).toHaveLength(12)
  })
})
