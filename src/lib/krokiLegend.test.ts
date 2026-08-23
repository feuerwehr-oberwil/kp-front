import { describe, expect, it } from 'vitest'
import {
  KROKI_DISC_R, discOffsetPx, krokiLabels, krokiScaleBar, numberKrokiLabels, placeKrokiLabels,
  type KrokiLabel,
} from './krokiLegend'
import type { Drawing, Entity, LngLat } from '../types'

const C: LngLat = [7.5, 47.5]

const sym = (id: string, coord: LngLat, name: string): Entity => ({
  id, kind: 'symbol', layer: 'symbols', coord, symbol: 'Testsymbol', fields: { bezeichnung: name },
})

const BY_NAME = { Testsymbol: '<svg xmlns="http://www.w3.org/2000/svg"/>' }

describe('krokiLabels — only what the sheet turns into a numbered disc', () => {
  it('takes a line\'s distance and label as ONE entry, at the midpoint vertex', () => {
    const line: Drawing = {
      id: 'l1', kind: 'line', coords: [[7.5, 47.5], [7.501, 47.5], [7.502, 47.5]],
      showDistance: true, label: 'Angriffsleitung',
    }
    const [l] = krokiLabels({ drawings: [line], entities: [], byName: BY_NAME })
    expect(l.at).toEqual([7.501, 47.5])
    expect(l.text).toMatch(/^\d+ m · .+ · Angriffsleitung$/)
    expect(l.glyph).toBeNull()
  })

  it('labels a circle with its radius, and leaves one without a radius unlabelled', () => {
    const circle: Drawing = { id: 'c1', kind: 'circle', coords: [C], radiusM: 60 }
    const bare: Drawing = { id: 'c2', kind: 'circle', coords: [C] }
    const out = krokiLabels({ drawings: [circle, bare], entities: [], byName: BY_NAME })
    expect(out.map((l) => l.text)).toEqual(['r = 60 m'])
    // 45° on the ring — up and to the right of the centre, like kroki.py's `pts[len // 8]`
    expect(out[0].at[0]).toBeGreaterThan(C[0])
    expect(out[0].at[1]).toBeGreaterThan(C[1])
  })

  it('numbers a symbol caption but NOT a Trupp chip or a Notizzettel — those print inline', () => {
    const entities: Entity[] = [
      sym('s1', C, 'Widmer Céline'),
      { id: 't1', kind: 'team', layer: 'symbols', coord: C, label: 'Schmid Peter' },
      { id: 'n1', kind: 'note', layer: 'symbols', coord: C, label: 'Zugang Hof gesperrt' },
    ]
    const out = krokiLabels({ drawings: [], entities, byName: BY_NAME })
    expect(out.map((l) => l.key)).toEqual(['es1'])
    expect(out[0].text).toBe('Widmer Céline')
    // a caption hangs under its glyph, so its disc does too
    expect(out[0].glyph).not.toBeNull()
  })

  it('keeps the server\'s order: drawings first, then symbols', () => {
    const line: Drawing = { id: 'l1', kind: 'line', coords: [C, [7.501, 47.5]], label: 'Leitung' }
    const out = krokiLabels({ drawings: [line], entities: [sym('s1', C, 'Meier A.')], byName: BY_NAME })
    expect(out.map((l) => l.key)).toEqual(['dl1', 'es1'])
  })
})

describe('the disc: two radii, and only the true one decides the legend', () => {
  const label = (key: string): KrokiLabel => ({ key, at: C, text: key, glyph: null })
  /** a fake projection: each label gets the pixel position keyed into this map */
  const at = (pts: Record<string, [number, number]>, keys: string[]) => {
    let i = 0
    return () => { const p = pts[keys[i++]]; return { x: p[0], y: p[1] } }
  }
  const frame = { width: 460, height: 270, zoom: 16, printScale: 460 / 1050 }
  const r = KROKI_DISC_R * frame.printScale // ~4.2px — the disc as the sheet prints it

  it('drops a disc whose TRUE radius overhangs the frame, and keeps one just inside', () => {
    const keys = ['in', 'out']
    const labels = keys.map(label)
    const placed = placeKrokiLabels(labels, at({ in: [r + 0.5, 100], out: [r - 0.5, 100] }, keys), frame)
    expect(placed.map((p) => p.fits)).toEqual([true, false])
    // both are still ON the picture, so the one that fell out is worth a hollow ring
    expect(placed.every((p) => p.onPicture)).toBe(true)
  })

  it('would keep both if it tested at the DRAWN 15px radius — which is why it does not', () => {
    const keys = ['a']
    const placed = placeKrokiLabels([label('a')], at({ a: [10, 100] }, keys), frame)
    // 10px in: outside a 15px-diameter drawn disc's half-width would still be "inside", but the
    // printed disc is 4.2px and the sheet prints it, so the preview must not drop it
    expect(placed[0].fits).toBe(true)
  })

  it('numbers what fits, in label order, and counts the rest as unnumbered', () => {
    const keys = ['a', 'b', 'c', 'far']
    const labels = keys.map(label)
    const placed = placeKrokiLabels(labels, at({
      a: [100, 100], b: [1, 100], c: [200, 200], far: [-400, 100],
    }, keys), frame)
    const legend = numberKrokiLabels(labels, placed)
    expect(legend.numbers).toEqual({ a: 1, c: 2 })
    expect(legend.lines).toEqual(['a', 'c'])
    // «b» touches the edge and loses its line; «far» is off the picture entirely and is the
    // «{n} ausserhalb» pill's business, not the legend's
    expect(legend.unnumbered).toBe(1)
  })

  it('hangs a symbol caption\'s disc below the glyph, and centres a drawing label on its anchor', () => {
    const plain: KrokiLabel = { key: 'd', at: C, text: 'x', glyph: null }
    const caption: KrokiLabel = { key: 'e', at: C, text: 'x', glyph: { kind: 'symbol', lat: 47.5 } }
    expect(discOffsetPx(plain, 16, 0.5)).toBe(0)
    expect(discOffsetPx(caption, 16, 0.5)).toBeGreaterThan(KROKI_DISC_R * 0.5)
  })
})

describe('krokiScaleBar', () => {
  it('picks the ladder rung nearest 16 % of the width', () => {
    // 1 px per metre, 460px wide → target 73.6 m → 50 is nearer than 100
    expect(krokiScaleBar(1, 460, 0.44)?.metres).toBe(50)
    expect(krokiScaleBar(1, 460, 0.44)?.barPx).toBe(50)
    // …and at half the ground scale the next rung up is the honest one
    expect(krokiScaleBar(0.5, 460, 0.44)?.metres).toBe(100)
  })

  it('leaves the plate off at a degenerate zoom rather than drawing a wrong bar', () => {
    // every rung is either under 6 % or over 40 % of the width
    expect(krokiScaleBar(0.0005, 460, 0.44)).toBeNull()
  })

  it('reserves room for the label beside the bar — the plate is wider than the bar', () => {
    const bar = krokiScaleBar(1, 460, 0.44)!
    expect(bar.platePx).toBeGreaterThan(bar.barPx)
  })
})
