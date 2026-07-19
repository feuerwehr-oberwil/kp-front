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
    const out = krokiEntity(sym({ floor: 2, count: 3, spread: { h: 'E' } }), {})
    expect(out).toMatchObject({ symbol: 'VKF Feuer', floor: 2, count: 3, spread: { h: 'E' } })
    expect(out?.symbolSvg).toBeUndefined()
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

  it('renders shapes as sized SVG silhouettes', () => {
    const out = krokiEntity(sym({ kind: 'shape', shape: 'cloud', sizeM: 120, symbol: undefined }), {})
    expect(out?.symbolSvg).toContain('<path')
    expect(out?.sizeM).toBe(120)
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
})

describe('krokiSymbolMul', () => {
  it('only reduces symbols in close-up crops and stops at 70%', () => {
    expect(krokiSymbolMul(16)).toBe(1)
    expect(krokiSymbolMul(17)).toBe(1)
    expect(krokiSymbolMul(18)).toBeCloseTo(0.9)
    expect(krokiSymbolMul(19)).toBeCloseTo(0.8)
    expect(krokiSymbolMul(20)).toBeCloseTo(0.7)
    expect(krokiSymbolMul(22)).toBe(0.7)
  })
})

describe('shapeSvgString', () => {
  it('emits the ShapeGlyph silhouettes with the given colour', () => {
    expect(shapeSvgString('arrow', '#123456')).toContain('fill="#123456"')
    expect(shapeSvgString('square', '#123456')).toContain('<rect')
    expect(shapeSvgString('cloud', '#123456')).toContain('fill-opacity="0.5"')
  })
})
