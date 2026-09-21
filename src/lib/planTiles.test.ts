import { describe, expect, it } from 'vitest'
import {
  allTileUrls, paperMaxScale, pickLevel, ptToMm, sheetLayout, sourcePages, tileManifestUrl, tileSource, tileUrl,
  underlayLevel, visibleTiles, type TileManifest, type TilePage,
} from './planTiles'

/** the Gymnasium's A1 (Allschwilerstrasse 100 · Modul 6), exactly as app/plan_tiles states it */
const dims: [number, number][] = [[219, 310], [438, 621], [877, 1242], [1754, 2483], [3508, 4967], [7016, 9934], [14032, 19868]]
const a1: TilePage = {
  page: 0, widthPt: 1683.84, heightPt: 2384.16,
  levels: dims.map(([width, height], z) => ({ z, width, height, cols: Math.ceil(width / 512), rows: Math.ceil(height / 512) })),
}
const manifest: TileManifest = { tileSize: 512, complete: true, pages: [a1] }

describe('tileSource', () => {
  it('reads dataset, pinned revision and floor page off a reference URL', () => {
    const s = tileSource('/api/reference/plan%3Aabc%3Amodul6?v=11#page=0')
    expect(s).toEqual({ base: '/api/reference/plan%3Aabc%3Amodul6', version: 11, page: 0 })
    expect(tileManifestUrl(s!)).toBe('/api/reference/plan%3Aabc%3Amodul6/tiles?v=11')
    expect(tileUrl(s!, 0, 6, 27, 38)).toBe('/api/reference/plan%3Aabc%3Amodul6/tiles/11/0/6/27/38')
  })
  it('has no tiles for an unpinned address or a bundled PDF – those keep pdf.js', () => {
    expect(tileSource('/api/reference/plan%3Aabc%3Amodul6')).toBeNull()
    expect(tileSource('/plans/demo.pdf?v=2')).toBeNull()
  })
})

describe('pickLevel', () => {
  it('takes the smallest level that needs no more than a √2 stretch', () => {
    expect(pickLevel(a1, 1074).z).toBe(2)       // a fitted tablet view at dpr 2: 877 px, ×1.22
    expect(pickLevel(a1, 1300).z).toBe(3)       // …past √2 the next level takes over
    expect(pickLevel(a1, 4296).z).toBe(4)       // zoom 4: 3508 px stretched ×1.22, not 7016 shrunk
  })
  it('stays on the top level past it – upscaled, never blank', () => {
    expect(pickLevel(a1, 60_000).z).toBe(6)
  })
})

describe('underlayLevel', () => {
  it('is the largest level of at most a handful of tiles', () => {
    const l = underlayLevel(a1)
    expect(l.z).toBe(2)
    expect(l.cols * l.rows).toBeLessThanOrEqual(6)
  })
})

describe('visibleTiles', () => {
  const top = a1.levels[6]
  it('covers exactly the rect, and the tiles tile it without gap or overlap', () => {
    const tiles = visibleTiles(top, 512, [0.5, 0.25, 0.6, 0.3])
    const xs = [...new Set(tiles.map((t) => t.x))], ys = [...new Set(tiles.map((t) => t.y))]
    expect(xs).toEqual([13, 14, 15, 16])
    expect(ys).toEqual([9, 10, 11])
    expect(tiles).toHaveLength(12)
    const first = tiles[0], next = tiles[1]
    expect(first.left + first.width).toBeCloseTo(next.left, 10)
    expect(first.left).toBeLessThanOrEqual(0.5)
  })
  it('gives the last column and row their own narrower box', () => {
    const last = visibleTiles(top, 512, [0.999, 0.999, 1, 1])[0]
    expect([last.x, last.y]).toEqual([27, 38])
    expect(last.left + last.width).toBeCloseTo(1, 10)
    expect(last.top + last.height).toBeCloseTo(1, 10)
    expect(last.width).toBeLessThan(512 / top.width)
  })
  it('adds a clamped ring of margin tiles and answers nothing for an empty rect', () => {
    expect(visibleTiles(top, 512, [0, 0, 0.01, 0.01], 1)).toHaveLength(4)
    expect(visibleTiles(top, 512, [0.4, 0.4, 0.4, 0.5])).toEqual([])
  })
  it('keeps a tablet screen at depth to a few dozen tiles, whatever the sheet', () => {
    // 2200 × 1520 device px of the 600 dpi level, plus the ring
    const rect: [number, number, number, number] = [0.3, 0.3, 0.3 + 2200 / top.width, 0.3 + 1520 / top.height]
    expect(visibleTiles(top, 512, rect, 1).length).toBeLessThanOrEqual(42)
  })
})

describe('sheetLayout', () => {
  it('is the page itself for one page', () => {
    const { aspect, boxes } = sheetLayout([a1])
    expect(aspect).toBeCloseTo(2384.16 / 1683.84, 6)
    expect(boxes[0]).toMatchObject({ left: 0, top: 0, width: 1, height: 1 })
  })
  it('stacks pages top-down at the widest page\'s width, a narrower one centred – as the bake stitched them', () => {
    const narrow: TilePage = { ...a1, page: 1, widthPt: 841.92, heightPt: 595 }
    const { aspect, boxes } = sheetLayout([a1, narrow])
    expect(aspect).toBeCloseTo((2384.16 + 595) / 1683.84, 6)
    expect(boxes[1].left).toBeCloseTo(0.25, 6)
    expect(boxes[1].width).toBeCloseTo(0.5, 6)
    expect(boxes[0].height + boxes[1].height).toBeCloseTo(1, 10)
    expect(boxes[1].top).toBeCloseTo(boxes[0].height, 10)
  })
})

describe('sourcePages / allTileUrls', () => {
  it('a floor sheet is its one page, a plain sheet the whole document', () => {
    const two: TileManifest = { ...manifest, pages: [a1, { ...a1, page: 1 }] }
    expect(sourcePages(two, { base: '/api/reference/x', version: 1, page: 1 }).map((p) => p.page)).toEqual([1])
    expect(sourcePages(two, { base: '/api/reference/x', version: 1, page: null })).toHaveLength(2)
  })
  it('lists every tile of the pyramid once', () => {
    const urls = allTileUrls(manifest, { base: '/api/reference/x', version: 11, page: null })
    expect(urls).toHaveLength(a1.levels.reduce((n, l) => n + l.cols * l.rows, 0))
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('paperMaxScale', () => {
  it('lets a big sheet zoom as far in real terms as a small one', () => {
    // the A1 fitted by height on a landscape tablet: 537 CSS px across 594 mm
    expect(paperMaxScale(537, ptToMm(a1.widthPt), 8)).toBeCloseTo(30.97, 1)
    // an A4 filling the same width was already past that at 8 – it keeps its 8
    expect(paperMaxScale(1100, 210, 8)).toBe(8)
  })
  it('falls back to the old ceiling without a paper size', () => {
    expect(paperMaxScale(0, 594, 8)).toBe(8)
    expect(paperMaxScale(537, 0, 10.4)).toBe(10.4)
  })
})
