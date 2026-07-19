import { describe, expect, it } from 'vitest'
import { mapReferenceLayers, stripLocality } from './deploymentConfig'

describe('mapReferenceLayers', () => {
  it('returns [] for missing/empty input', () => {
    expect(mapReferenceLayers(undefined)).toEqual([])
    expect(mapReferenceLayers([])).toEqual([])
  })

  it('maps a geojson point layer with its symbol + colours', () => {
    const [l] = mapReferenceLayers([
      {
        id: 'hydrant', group: 'Wasser', label: 'Hydranten', icon: 'drop', kind: 'geojson',
        geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant',
        color: '#0f52b5', nightColor: '#5b9bff', opacity: 100, attribution: '© FireGIS',
      },
    ])
    expect(l).toMatchObject({
      id: 'hydrant', group: 'Wasser', label: 'Hydranten', base: false, visible: false,
      geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant',
      color: '#0f52b5', nightColor: '#5b9bff', opacity: 100,
    })
  })

  it('defaults vectorKind to line and supplies group/label/icon fallbacks', () => {
    const [l] = mapReferenceLayers([{ id: 'leitung', kind: 'geojson', geojson: '/api/reference/geo:leitung' }])
    expect(l).toMatchObject({ id: 'leitung', group: 'Referenz', label: 'leitung', icon: 'map', vectorKind: 'line' })
  })

  it('passes autoActivate through, dropping an empty list', () => {
    const [a, b] = mapReferenceLayers([
      { id: 'hydrant', kind: 'geojson', geojson: '/api/reference/geo:hydrant', autoActivate: ['Brandbekämpfung'] },
      { id: 'leitung', kind: 'geojson', geojson: '/api/reference/geo:leitung', autoActivate: [] },
    ])
    expect(a.autoActivate).toEqual(['Brandbekämpfung'])
    expect(b.autoActivate).toBeUndefined()
  })

  it('maps a wms/wmts layer to a raster overlay with tiles', () => {
    const [l] = mapReferenceLayers([
      { id: 'flood', group: 'Gefahren', label: 'Hochwasser', kind: 'wms', tiles: ['https://x/{z}/{x}/{y}'], opacity: 65 },
    ])
    expect(l).toMatchObject({ id: 'flood', base: false, tiles: ['https://x/{z}/{x}/{y}'], opacity: 65 })
    expect(l.geojson).toBeUndefined()
  })

  it('skips entries missing an id or their required source', () => {
    expect(mapReferenceLayers([
      { group: 'Wasser', kind: 'geojson', geojson: '/x' },                  // no id
      { id: 'no-url', kind: 'geojson' },                                    // geojson layer, no url
      { id: 'inline', kind: 'geojson', geojson: { type: 'FeatureCollection' } }, // inline object unsupported
      { id: 'no-tiles', kind: 'wms', tiles: [] },                           // wms, no tiles
    ])).toEqual([])
  })
})

describe('stripLocality — home town off compact addresses', () => {
  it('strips the Divera prefix form «Town (KT), street»', () => {
    expect(stripLocality('Musterdorf (BL), Schlossgasse 9', '4104 Musterdorf BL')).toBe('Schlossgasse 9')
    expect(stripLocality('Musterdorf BL, Bachweg 1', 'Musterdorf (BL)')).toBe('Bachweg 1')
  })

  it('strips the swisstopo suffix form «street, PLZ Town»', () => {
    expect(stripLocality('Bachweg 3, 4104 Musterdorf', '4104 Musterdorf BL')).toBe('Bachweg 3')
    expect(stripLocality('Dorfplatz 12, Musterdorf', 'Musterdorf')).toBe('Dorfplatz 12')
  })

  it('leaves OUT-of-town addresses untouched (they should stand out)', () => {
    expect(stripLocality('Nachbarwil (BL), Bahnhofstrasse 2', '4104 Musterdorf BL')).toBe('Nachbarwil (BL), Bahnhofstrasse 2')
    expect(stripLocality('Muristrasse 5, 4054 Basel', '4104 Musterdorf BL')).toBe('Muristrasse 5, 4054 Basel')
  })

  it('never matches inside a longer word (Musterdorferstrasse stays intact)', () => {
    expect(stripLocality('Musterdorferstrasse 5, 4054 Basel', 'Musterdorf')).toBe('Musterdorferstrasse 5, 4054 Basel')
  })

  it('degrades safely: empty locality, and a town-only address returns itself', () => {
    expect(stripLocality('Musterdorf (BL), Bachweg 1', null)).toBe('Musterdorf (BL), Bachweg 1')
    expect(stripLocality('Musterdorf (BL)', '4104 Musterdorf BL')).toBe('Musterdorf (BL)')
  })
})
