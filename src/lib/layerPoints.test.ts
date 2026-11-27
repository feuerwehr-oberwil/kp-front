import { describe, expect, it } from 'vitest'
import type { LayerDef } from '../types'
import type { LayerData, LayerFeatureCollection } from './layerData'
import { layerPointLabel, magnetLayerPoints } from './layerPoints'

const fc = (props: Record<string, unknown>[]): LayerFeatureCollection => ({
  type: 'FeatureCollection',
  features: props.map((properties, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [7.5 + i / 1000, 47.5] }, properties })),
})
const hyd: LayerDef = { id: 'hydranten', group: 'Wasser', label: 'Hydranten', icon: 'drop', visible: true, geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant' }
const ready = (data: LayerFeatureCollection): LayerData => ({ state: 'ready', features: data.features.length, data })

describe('magnetLayerPoints — what a line end may hang on among the Ebenen', () => {
  const loads = new Map([['hydranten', ready(fc([{ nr: 1234 }, {}]))]])

  it('the points of a symbol point Ebene that is on, named after the feature', () => {
    const [points] = magnetLayerPoints([hyd], () => true, loads)
    expect(points).toEqual([
      { layer: 'hydranten', id: '0', label: 'Hydrant 1234', at: [7.5, 47.5] },
      { layer: 'hydranten', id: '1', label: 'Hydrant', at: [7.501, 47.5] },
    ])
  })

  it('nothing from an Ebene that is off, still loading, or drawn as plain dots', () => {
    expect(magnetLayerPoints([hyd], () => false, loads)).toEqual([])
    expect(magnetLayerPoints([hyd], () => true, new Map([['hydranten', { state: 'loading', loaded: 0, total: null } as const]]))).toEqual([])
    expect(magnetLayerPoints([{ ...hyd, symbol: undefined }], () => true, loads)).toEqual([])
    expect(magnetLayerPoints([{ ...hyd, opacity: 0 }], () => true, loads)).toEqual([])
  })

  it('another symbol Ebene goes by its own name', () => {
    const defi = { ...hyd, id: 'defi', label: 'Defibrillator', symbol: 'Defi' }
    const [points] = magnetLayerPoints([defi], () => true, new Map([['defi', ready(fc([{ name: 'Schulhaus' }]))]]))
    expect(points[0].label).toBe('Defibrillator Schulhaus')
  })
})

describe('layerPointLabel', () => {
  it('puts the noun before the feature\'s own name, once', () => {
    expect(layerPointLabel('Hydrant', 'H-142')).toBe('Hydrant H-142')
    expect(layerPointLabel('Hydrant', 'hydrant 7')).toBe('hydrant 7')
    expect(layerPointLabel('Hydrant')).toBe('Hydrant')
  })
})
