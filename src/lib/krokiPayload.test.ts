import { describe, expect, it } from 'vitest'
import type { Drawing, Entity, LayerDef } from '../types'
import { buildKrokiPayload, krokiEntity, krokiSymbolMul, shapeSvgString } from './krokiPayload'
import { appConfig } from '../config/appConfig'

const layers: LayerDef[] = [
  { id: 'base-carto', group: 'Basis', label: 'Carto', icon: 'map', base: true, visible: true, tiles: ['https://tiles/{z}/{x}/{y}.png'], maxzoom: 20, attribution: '© Test' },
  { id: 'taktisch', group: 'Lage', label: 'Taktisch', icon: 'hex', visible: true },
  { id: 'fahrzeuge', group: 'Lage', label: 'Fahrzeuge', icon: 'truck', visible: false },
  { id: 'markup', group: 'Lage', label: 'Skizzen', icon: 'area', visible: true },
]

const sym = (over: Partial<Entity>): Entity => ({
  id: 'e1', kind: 'symbol', layer: 'taktisch', coord: [7.55, 47.51], symbol: 'VKF Feuer', ...over,
})

describe('krokiEntity (glyph resolution for the server compositor)', () => {
  it('passes plain pack symbols by name with their decor', () => {
    const out = krokiEntity(sym({ floor: 2, count: 3, spread: { right: true, rightBounded: true } }), {})
    expect(out).toMatchObject({
      symbol: 'VKF Feuer', floor: 2, count: 3, spread: { right: true, rightBounded: true },
    })
    expect(out?.symbolSvg).toBeUndefined()
  })

  it('passes a pre-2026-08 spread through untouched, for the server to normalise', () => {
    // ⚠️ The payload must not strip what it no longer types. An archived incident still carries
    // the exclusive `h`/`hBounded` shape, and kroki.py (`_spread_dirs`) is the one place that
    // reads it — dropping it here would reprint that Rapport without its arrows.
    const legacy = { h: 'E', hBounded: true } as unknown as Entity['spread']
    expect(krokiEntity(sym({ spread: legacy }), {})).toMatchObject({ spread: { h: 'E', hBounded: true } })
  })

  it('resolves vehicles to a baked SVG (heading in the glyph, no extra rotation)', () => {
    const out = krokiEntity(sym({ symbol: appConfig.symbols.vehicleName, label: 'TLF', rotation: 90 }), {})
    expect(out?.symbolSvg).toContain('<svg')
    expect(out?.symbol).toBeUndefined()
    expect(out?.rotation).toBeUndefined()
  })

  it('keeps a live vehicle\'s pre-resolved glyph', () => {
    const out = krokiEntity(sym({ symbolSvg: '<svg>live</svg>', live: true }), {})
    expect(out?.symbolSvg).toBe('<svg>live</svg>')
  })

  it('maps teams to a caption+colour dot and drops empty notes / photo markers', () => {
    expect(krokiEntity(sym({ kind: 'team', label: 'Trupp 1', color: '#e8392b', symbol: undefined }), {}))
      .toMatchObject({ kind: 'team', caption: 'Trupp 1', color: '#e8392b' })
    expect(krokiEntity(sym({ kind: 'note', label: '', symbol: undefined }), {})).toBeNull()
    expect(krokiEntity(sym({ kind: 'photo', symbol: undefined }), {})).toBeNull()
  })

  it('carries a symbol\'s typed label onto the paper', () => {
    // ⚠️ Only `team` and `note` ever sent a caption, so the Einsatzleiter's name — and every
    // other value typed onto a symbol — was on screen and missing from the printed Kroki.
    // The server has drawn these all along (app/kroki.py · _caption).
    const el = krokiEntity(sym({ symbol: 'Einsatzleiter', fields: { Name: 'Céline Widmer' } }), {})
    expect(el?.caption).toBe('Einsatzleiter · Céline Widmer')
  })

  it('words the legend line for paper, not for the screen it was framed on', () => {
    const e = sym({ symbol: 'Einsatzleiter', fields: { Name: 'Céline Widmer' }, notes: 'ab 21:40' })
    expect(krokiEntity(e, {}, 'off')?.caption).toBeUndefined()
    expect(krokiEntity(e, {}, 'auto')?.caption).toBe('Einsatzleiter · Céline Widmer')
    expect(krokiEntity(e, {}, 'all')?.caption).toContain('ab 21:40')
    // ⚠️ a symbol's own `caption: 'off'` declutters a SCREEN. A legend line clutters nothing, and
    // a glyph with a number but no line is worse than either – so the sheet does not read it.
    expect(krokiEntity({ ...e, caption: 'off' }, {}, 'auto')?.caption).toBe('Einsatzleiter · Céline Widmer')
  })

  it('renders shapes as sized SVG silhouettes', () => {
    const out = krokiEntity(sym({ kind: 'shape', shape: 'cloud', sizeM: 120, symbol: undefined }), {})
    expect(out?.symbolSvg).toContain('<path')
    expect(out?.sizeM).toBe(120)
  })

  it('sends a stretched shape\'s aspect, and only when it stretches', () => {
    const rect = krokiEntity(sym({ kind: 'shape', shape: 'square', sizeM: 60, aspect: 2.5, symbol: undefined }), {})
    expect(rect?.aspect).toBe(2.5)
    // absent / 1 stays off the wire — stored incidents keep printing byte-identical payloads
    expect(krokiEntity(sym({ kind: 'shape', shape: 'square', sizeM: 60, symbol: undefined }), {})?.aspect).toBeUndefined()
    // the Pfeil is aspect-locked (lib/shapes · SHAPE_FREE_ASPECT) — a stray stored value never prints
    expect(krokiEntity(sym({ kind: 'shape', shape: 'arrow', sizeM: 60, aspect: 2.5, symbol: undefined }), {})?.aspect).toBeUndefined()
  })

  it('bakes the arrow\'s Stopp-Balken into the printed glyph, arrow-only', () => {
    const stop = krokiEntity(sym({ kind: 'shape', shape: 'arrow', stop: true, symbol: undefined }), {})
    expect(stop?.symbolSvg).toContain('M20 7 L80 7')
    const plain = krokiEntity(sym({ kind: 'shape', shape: 'arrow', symbol: undefined }), {})
    expect(plain?.symbolSvg).not.toContain('M20 7')
    // a `stop` on a non-arrow shape (impossible via the editor, possible via merge) draws nothing
    const rect = krokiEntity(sym({ kind: 'shape', shape: 'square', stop: true, symbol: undefined }), {})
    expect(rect?.symbolSvg).not.toContain('M20 7')
  })
})

describe('buildKrokiPayload', () => {
  const entities: Entity[] = [
    sym({}),
    sym({ id: 'e2', layer: 'fahrzeuge', symbol: 'VKF Fahrzeug' }), // hidden layer → dropped
  ]
  const drawings: Drawing[] = [
    { id: 'd1', kind: 'line', coords: [[7.55, 47.51], [7.551, 47.511]], color: '#f00', teilstueck: true, lineNo: 1 },
  ]

  it('honours layer visibility and carries the active base layer tiles', () => {
    const p = buildKrokiPayload({ entities, drawings, layers, byName: {}, center: [7.55, 47.51] })
    expect(p).not.toBeNull()
    expect(p!.entities).toHaveLength(1)
    expect(p!.tiles).toBe('https://tiles/{z}/{x}/{y}.png')
    expect(p!.maxTileZoom).toBe(20)
    expect(p!.attribution).toBe('© Test')
    expect(p!.drawings[0]).toMatchObject({ teilstueck: true, lineNo: 1 })
    expect(p!.fitPoints.length).toBeGreaterThan(0)
    expect(p!.center).toBeUndefined()
  })

  it('sends the live view for «aktuelle Ansicht» and drops drawings on a hidden markup layer', () => {
    const hidden = layers.map((l) => (l.id === 'markup' ? { ...l, visible: false } : l))
    const p = buildKrokiPayload({
      entities, drawings, layers: hidden, byName: {}, center: [7.55, 47.51],
      currentView: { center: [7.6, 47.6], zoom: 16.5, bounds: [7.59, 47.59, 7.61, 47.61] },
    })
    expect(p!.drawings).toHaveLength(0)
    expect(p!.center).toEqual([7.6, 47.6])
    expect(p!.zoom).toBe(16.5)
    expect(p!.bounds).toEqual([7.59, 47.59, 7.61, 47.61])
  })

  it('returns null without a raster base layer (nothing to render)', () => {
    expect(buildKrokiPayload({ entities, drawings, layers: layers.slice(1), byName: {}, center: [7.55, 47.51] })).toBeNull()
  })

  // ⚠️ 18.09.2026: this file resolves an attached end against a fixed ~4 m GROUND footprint (it
  // has no projection), while the printed glyph is sized in pixels — on a close crop the hose
  // stopped several glyph widths short of its vehicle. The server re-couples the end to the glyph
  // as printed, and for that it has to be told WHICH end hangs on WHICH entity.
  it('names the entity an attached Leitung end hangs on, and ids only those entities', () => {
    const tlf = sym({ id: 'tlf', symbol: 'Feuer', coord: [7.55, 47.51] })
    const other = sym({ id: 'other', symbol: 'Feuer', coord: [7.5504, 47.5102] })
    const hose: Drawing = {
      id: 'h', kind: 'line', coords: [[7.55001, 47.51001], [7.5503, 47.5102]],
      startAttachment: { target: { kind: 'object', id: 'tlf' }, routing: 'direct' },
    } as Drawing
    const p = buildKrokiPayload({ entities: [tlf, other], drawings: [hose], layers, byName: {}, center: [7.55, 47.51] })!
    expect(p.drawings[0]).toMatchObject({ startAt: 'tlf' })
    expect(p.drawings[0].endAt).toBeUndefined()
    expect(p.entities.map((e) => e.id)).toEqual(['tlf', undefined])
  })

  // The Schraffur is the FKS reading of an AFFECTED area, not a shade of the wash. Left out of the
  // payload it printed as an ordinary fill and the sheet said something else about the ground than
  // the screen it was framed on (field report 02.09.). ⚠️ Mirrored in backend · KrokiDrawingIn.
  it('sends the Fläche’s Schraffur, not only its fill opacity', () => {
    const hatched: Drawing[] = [
      { id: 'a1', kind: 'area', coords: [[7.55, 47.51], [7.56, 47.51], [7.56, 47.52]], color: '#e8392b', hatch: true, fillOpacity: 0.25 },
      { id: 'a2', kind: 'area', coords: [[7.55, 47.51], [7.56, 47.51], [7.56, 47.52]], color: '#e8392b', fillOpacity: 0.25 },
    ]
    const p = buildKrokiPayload({ entities: [], drawings: hatched, layers, byName: {}, center: [7.55, 47.51] })
    expect(p!.drawings[0]).toMatchObject({ hatch: true, fillOpacity: 0.25 })
    expect(p!.drawings[1].hatch).toBeUndefined()
  })
})

describe('krokiSymbolMul', () => {
  // ⚠️ The floor is 85% since 18.08. — held against the live map the printed symbols came out
  // about half the size they read at on screen. The shrink is only there to stop a close-up crop
  // merging four glyphs into one blob, and 70% took far more than that away.
  // ⚠️ Mirrored by `kroki_symbol_mul` in backend/app/kroki.py. If the two drift the framing
  // modal stops showing what the Rapport prints.
  it('only reduces symbols in close-up crops and stops at 85%', () => {
    expect(krokiSymbolMul(16)).toBe(1)
    expect(krokiSymbolMul(17)).toBe(1)
    expect(krokiSymbolMul(18)).toBeCloseTo(0.9)
    expect(krokiSymbolMul(19)).toBeCloseTo(0.85)
    expect(krokiSymbolMul(20)).toBeCloseTo(0.85)
    expect(krokiSymbolMul(22)).toBe(0.85)
  })
})

describe('shapeSvgString', () => {
  it('emits the ShapeGlyph silhouettes with the given colour', () => {
    expect(shapeSvgString('arrow', '#123456')).toContain('fill="#123456"')
    expect(shapeSvgString('square', '#123456')).toContain('<rect')
    expect(shapeSvgString('cloud', '#123456')).toContain('fill-opacity="0.5"')
  })

  it('draws the arrow\'s Stopp-Balken across the tip in the shape\'s colour', () => {
    const svg = shapeSvgString('arrow', '#123456', true)
    expect(svg).toContain('<path d="M20 7 L80 7" stroke="#123456" stroke-width="5"')
    // stays stretch-safe: the bar lives in the same preserveAspectRatio="none" viewBox
    expect(svg).toContain('preserveAspectRatio="none"')
  })
})

describe('kroki payload · Atemschutz on a hose line', () => {
  it('sends the Trupp with the line, resolved and abbreviated for the server', () => {
    const drawings: Drawing[] = [
      { id: 'd1', kind: 'line', coords: [[7.55, 47.51], [7.56, 47.52]], lineNo: 1 },
      { id: 'd2', kind: 'line', coords: [[7.55, 47.51], [7.57, 47.52]], lineNo: 2 },
    ]
    const trupps = [{
      id: 't1', name: 'Müller Hans', lineNo: 1, entryPressureBar: 300,
      entryTime: '2026-08-05T10:00:00Z', lastContactTime: '2026-08-05T10:03:00Z', status: 'aktiv' as const,
    }]
    const p = buildKrokiPayload({ entities: [], drawings, layers, byName: {}, center: [7.55, 47.51], trupps })
    expect(p?.drawings[0]).toMatchObject({ lineNo: 1, trupp: 'Müller H.' })
    // the other Leitung has nobody on it — no tag part, no invented link
    expect(p?.drawings[1].trupp).toBeUndefined()
  })

  it('prints no Trupp when none is monitored (the common case)', () => {
    const drawings: Drawing[] = [{ id: 'd1', kind: 'line', coords: [[7.55, 47.51], [7.56, 47.52]], lineNo: 1 }]
    const p = buildKrokiPayload({ entities: [], drawings, layers, byName: {}, center: [7.55, 47.51] })
    expect(p?.drawings[0].trupp).toBeUndefined()
  })
})
