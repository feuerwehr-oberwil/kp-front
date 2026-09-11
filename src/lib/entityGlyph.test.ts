import { describe, it, expect } from 'vitest'
import { glyphFor, twinName } from './entityGlyph'
import { GROSSLUEFTER, GROSSLUEFTER_BODY, HUBRETTER, LUEFTER, LUEFTER_EXTRACT } from './symbolRender'
import { appConfig } from '../config/appConfig'
import type { BoardAnno, Entity } from '../types'
// The ADR dataset is a fetched static asset now (lib/staticData) — inject it the way the
// boot prefetch would, so the derived values (Kemler on the plate, ERG rows) are real.
import unData from '../../public/un-hazard.json'
import { __setUnHazardData, type UnHazardEntry } from './unHazard'
__setUnHazardData(unData as UnHazardEntry[])


// A Zwilling is drawn from the SAME object as its original, but with less of the machinery around
// it — so `glyphFor` is a chain of deliberate fallbacks, each there for its own reason: a
// composite draws its base body (the part rides on top via overlayFor), a Gefahrentafel is drawn from its number
// rather than from the empty plate, a live vehicle carries its glyph baked in, and an extract
// Lüfter has artwork of its own. These pin those choices; the SVG text itself is not the point.

const TAFEL = appConfig.symbols.placardName
const UN_FIELD = appConfig.copy.contextPanel.unField

const byName: Record<string, string> = {
  [GROSSLUEFTER]: '<svg id="grosslueft-thumb"/>',
  [GROSSLUEFTER_BODY]: '<svg id="fahrzeug"/>',
  // ⚠️ no separate fan entry: GROSSLUEFTER_FAN IS the Lüfter glyph (same library name)
  [LUEFTER]: '<svg id="luefter"/>',
  [LUEFTER_EXTRACT]: '<svg id="luefter-saugend"/>',
  [TAFEL]: '<svg id="tafel-leer"/>',
  [HUBRETTER]: '<svg id="vkf-hubretter"/>',
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

  // D-20: the pack DOES carry a «VKF Hubretter» artwork, so the plain lookup resolved a
  // different vehicle than the original — which composes the plain body plus a live boom.
  it('draws a Hubretter as the plain Fahrzeug body, never the pack’s own Hubretter plate', () => {
    expect(glyphFor(anno({ symbol: HUBRETTER }), byName)).toBe(byName[appConfig.symbols.vehicleName])
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

