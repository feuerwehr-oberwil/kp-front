import { describe, it, expect } from 'vitest'
import { glyphFor, twinName } from './twinGlyph'
import { GROSSLUEFTER, GROSSLUEFTER_BODY, LUEFTER, LUEFTER_EXTRACT } from './symbolRender'
import { appConfig } from '../config/appConfig'
import type { BoardAnno, Entity } from '../types'

// A Zwilling is drawn from the SAME object as its original, but with less of the machinery around
// it — so `glyphFor` is a chain of deliberate fallbacks, each there for its own reason: a
// composite loses its independently-rotating overlay, a Gefahrentafel is drawn from its number
// rather than from the empty plate, a live vehicle carries its glyph baked in, and an extract
// Lüfter has artwork of its own. These pin those choices; the SVG text itself is not the point.

const TAFEL = appConfig.symbols.placardName
const UN_FIELD = appConfig.copy.contextPanel.unField

const byName: Record<string, string> = {
  [GROSSLUEFTER]: '<svg id="grosslueft-thumb"/>',
  [GROSSLUEFTER_BODY]: '<svg id="fahrzeug"/>',
  [LUEFTER]: '<svg id="luefter"/>',
  [LUEFTER_EXTRACT]: '<svg id="luefter-saugend"/>',
  [TAFEL]: '<svg id="tafel-leer"/>',
  Hydrant: '<svg id="hydrant"/>',
}

const anno = (o: Partial<BoardAnno>): BoardAnno => ({ id: 'a1', kind: 'symbol', ...o })
const entity = (o: Partial<Entity>): Entity =>
  ({ id: 'e1', kind: 'symbol', layer: 'lage', coord: [7.5, 47.5], ...o })

describe('glyphFor', () => {
  it('draws a composite as its BASE body — the overlay belongs to the sheet that owns it', () => {
    // ⚠️ NOT the palette thumbnail, which has the fan baked in at rotation 0 and would state a
    // fan direction the twin cannot honour.
    expect(glyphFor(anno({ symbol: GROSSLUEFTER }), byName)).toBe(byName[GROSSLUEFTER_BODY])
  })

  it('draws a Gefahrentafel from its UN number, and the empty plate without one', () => {
    const filled = glyphFor(anno({ symbol: TAFEL, fields: { [UN_FIELD]: '1203' } }), byName)
    expect(filled).toContain('1203')
    expect(glyphFor(anno({ symbol: TAFEL }), byName)).toBe(byName[TAFEL])
  })

  it('uses an entity’s baked-in glyph — a live vehicle carries its own name and heading', () => {
    expect(glyphFor(entity({ symbol: 'Hydrant', symbolSvg: '<svg id="tlf-1"/>' }), byName)).toBe('<svg id="tlf-1"/>')
  })

  it('swaps in the reversed-airflow artwork for an extract Lüfter only', () => {
    // a placed Lüfter stays named LUEFTER whichever way it blows (see symbolRender · luefterVariant)
    expect(glyphFor(anno({ symbol: LUEFTER, extract: true }), byName)).toBe(byName[LUEFTER_EXTRACT])
    expect(glyphFor(anno({ symbol: LUEFTER }), byName)).toBe(byName[LUEFTER])
  })

  it('falls back to the plain library glyph, and to nothing when there is none', () => {
    expect(glyphFor(anno({ symbol: 'Hydrant' }), byName)).toBe(byName.Hydrant)
    expect(glyphFor(anno({ symbol: 'Nicht im Katalog' }), byName)).toBe('')
    expect(glyphFor(anno({}), byName)).toBe('')
  })
})

describe('twinName', () => {
  it('prefers the label, then the symbol, then the text — a plaque never says nothing', () => {
    expect(twinName({ label: 'TLF 1', symbol: 'VKF Fahrzeug', text: 'Sammelplatz' })).toBe('TLF 1')
    expect(twinName({ label: '  ', symbol: 'VKF Fahrzeug' })).toBe('VKF Fahrzeug')
    expect(twinName({ text: 'Sammelplatz' })).toBe('Sammelplatz')
    expect(twinName({})).toBe(appConfig.copy.whiteboard.georef.twinUnnamed)
  })
})
