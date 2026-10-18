import { beforeEach, describe, expect, it, vi } from 'vitest'

const deployment = vi.hoisted(() => ({ integrations: {} as { cartoBasemapKey?: string } }))

vi.mock('./deploymentConfig', () => ({ getDeploymentConfig: () => deployment }))

import { cartoRasterTiles, keyCartoTileTemplates, retinaCartoTileTemplates, wantsRetinaTiles, withCartoBasemapKey, withCartoRetina, withoutCartoBasemapKey, withoutCartoRetina } from './carto'

describe('CARTO basemap key', () => {
  beforeEach(() => { deployment.integrations = {} })

  it('adds the runtime key to every built-in raster template', () => {
    deployment.integrations.cartoBasemapKey = 'carto key/+='
    expect(cartoRasterTiles('rastertiles/voyager', ['a', 'b'])).toEqual([
      'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=carto%20key%2F%2B%3D',
      'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=carto%20key%2F%2B%3D',
    ])
  })

  it('preserves existing queries and never replaces an explicit key', () => {
    deployment.integrations.cartoBasemapKey = 'runtime'
    expect(withCartoBasemapKey('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?v=2'))
      .toBe('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?v=2&key=runtime')
    expect(withCartoBasemapKey('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=custom'))
      .toBe('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=custom')
  })

  it('leaves non-CARTO sources alone and keys both day and night layer templates', () => {
    deployment.integrations.cartoBasemapKey = 'runtime'
    const layer = keyCartoTileTemplates({
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      nightTiles: ['https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
    })
    expect(layer.tiles?.[0]).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png')
    expect(layer.nightTiles?.[0].endsWith('.png?key=runtime')).toBe(true)
  })

  // The Rapport payload names the basemap the operator was looking at. The backend holds the
  // same credential and applies its own, so ours must not ride along into a request body.
  it('strips the key again on the way out to our own backend', () => {
    expect(withoutCartoBasemapKey('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=runtime'))
      .toBe('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png')
    // a key in the middle, and one in front of another parameter that must survive intact
    expect(withoutCartoBasemapKey('https://a.tld/{z}/{x}/{y}.png?v=2&key=runtime&lang=de'))
      .toBe('https://a.tld/{z}/{x}/{y}.png?v=2&lang=de')
    expect(withoutCartoBasemapKey('https://a.tld/{z}/{x}/{y}.png?key=runtime&v=2'))
      .toBe('https://a.tld/{z}/{x}/{y}.png?v=2')
  })

  it('leaves a template that never carried a key untouched', () => {
    const bare = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    expect(withoutCartoBasemapKey(bare)).toBe(bare)
    // «monkey=1» is not a key parameter — a substring match would eat it
    expect(withoutCartoBasemapKey('https://a.tld/{z}/{x}/{y}.png?monkey=1'))
      .toBe('https://a.tld/{z}/{x}/{y}.png?monkey=1')
    expect(withoutCartoBasemapKey('https://a.tld/{z}/{x}/{y}.png?key=k#frag'))
      .toBe('https://a.tld/{z}/{x}/{y}.png#frag')
  })

  it('round-trips: what we key for the browser is what we strip for the server', () => {
    deployment.integrations.cartoBasemapKey = 'carto key/+='
    const [tpl] = cartoRasterTiles('rastertiles/voyager', ['a'])
    expect(withoutCartoBasemapKey(tpl)).toBe('https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png')
  })
})

// Review round 4 (owner, iPhone): the map was blurry — a 256 px tile on a 3× screen is every pixel
// blown up three times. A retina screen asks CARTO for the same tile drawn at 512 px.
describe('CARTO retina tiles', () => {
  const DARK = 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'

  it('asks for @2x on a screen with more than one device pixel per CSS pixel', () => {
    expect(wantsRetinaTiles(1)).toBe(false)
    expect(wantsRetinaTiles(2)).toBe(true)
    expect(wantsRetinaTiles(3)).toBe(true)
    expect(withCartoRetina(DARK, true)).toBe('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png')
    expect(withCartoRetina(DARK, false)).toBe(DARK)
  })

  it('keeps the query, is idempotent, and goes back to 1× for our backend', () => {
    const keyed = `${DARK}?key=k`
    const retina = withCartoRetina(keyed, true)
    expect(retina).toBe('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=k')
    expect(withCartoRetina(retina, true)).toBe(retina)
    expect(withoutCartoRetina(retina)).toBe(keyed)
  })

  it('leaves every other host alone — OSM and swisstopo have no 2× tiles', () => {
    const osm = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    expect(withCartoRetina(osm, true)).toBe(osm)
    const layer = retinaCartoTileTemplates({ tiles: [osm], nightTiles: [DARK] }, true)
    expect(layer.tiles).toEqual([osm])
    expect(layer.nightTiles).toEqual(['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'])
    // nothing to change: the same object back (no new layer list on every derivation)
    const plain = { tiles: [osm] }
    expect(retinaCartoTileTemplates(plain, true)).toBe(plain)
  })

  it('keys a retina template like any other', () => {
    deployment.integrations.cartoBasemapKey = 'runtime'
    const layer = keyCartoTileTemplates(retinaCartoTileTemplates({ tiles: [DARK] }, true))
    expect(layer.tiles).toEqual(['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=runtime'])
    expect(withoutCartoBasemapKey(withoutCartoRetina(layer.tiles![0]))).toBe(DARK)
  })
})
