import { beforeEach, describe, expect, it, vi } from 'vitest'

const deployment = vi.hoisted(() => ({ integrations: {} as { cartoBasemapKey?: string } }))

vi.mock('./deploymentConfig', () => ({ getDeploymentConfig: () => deployment }))

import { cartoRasterTiles, keyCartoTileTemplates, withCartoBasemapKey } from './carto'

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
})
