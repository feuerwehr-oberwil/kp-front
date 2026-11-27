import type { LayerDef, LayerId, LayerPointTarget } from '../types'
import type { LayerData, LayerFeatureCollection } from './layerData'
import { isHydrantLayer, pointsFromGeoJson } from './karte/places'
import { appConfig } from '../config/appConfig'

/**
 * The points of a symbol point Ebene (Hydranten, and any other point layer the station config
 * draws as a symbol) as line-magnet targets: since the white plate (lib/mapImages · onPlate) a
 * layer hydrant reads like a placed symbol, so a Linie end snaps to it the same way (owner, Üben
 * feedback 27.11.2026). Read by MapView · candidatesAt → components/mapMagnetTargets; the
 * attachment it makes is types · LayerPointTarget. Karte only – the Plan draws no Ebenen.
 */
export type LayerPoint = Omit<LayerPointTarget, 'kind'>

/** Does a line end hang on this Ebene's points? A point layer drawn as a symbol on its plate
 *  (MapLayers) – a plain dot layer marks data, not a place a hose ends. */
export const isMagnetLayer = (l: Pick<LayerDef, 'base' | 'geojson' | 'vectorKind' | 'symbol'>): boolean =>
  !l.base && !!l.geojson && l.vectorKind === 'point' && !!l.symbol

/** The name an Ebene's point goes by in the line editor's «Enden» row: the Ebene's noun («Hydrant»
 *  for the hydrant layer, else the Ebene's own label), then what the feature calls itself, if it
 *  says – «Hydrant 1234». A name that already starts with the noun stands alone. */
export function layerPointLabel(noun: string, name?: string): string {
  if (!name) return noun
  return name.toLowerCase().startsWith(noun.toLowerCase()) ? name : `${noun} ${name}`
}

// one parse per loaded collection: the magnet asks on every pointer sample
const cache = new WeakMap<LayerFeatureCollection, { layer: string; noun: string; points: LayerPoint[] }>()

/** Every point of `layer`'s loaded collection `fc`, named (`layerPointLabel`). `id` is the
 *  point's place in the file – stable while the file is, which is all a snap needs (the
 *  attachment carries the point itself). */
export function layerPoints(layer: Pick<LayerDef, 'id' | 'label' | 'geojson' | 'vectorKind' | 'symbol'>, fc: LayerFeatureCollection): LayerPoint[] {
  const noun = isHydrantLayer(layer) ? appConfig.copy.drawingEditor.endHydrant : layer.label
  const hit = cache.get(fc)
  if (hit && hit.layer === layer.id && hit.noun === noun) return hit.points
  const points = pointsFromGeoJson(fc, '').map((p): LayerPoint => ({ layer: layer.id, id: p.id, label: layerPointLabel(noun, p.name), at: p.coord }))
  cache.set(fc, { layer: layer.id, noun, points })
  return points
}

/** What the magnet may reach for right now: the points of every symbol point Ebene that is ON
 *  and loaded, one list per Ebene (components/mapMagnetTargets · MagnetScene.layerPoints). An
 *  Ebene switched off, still loading or drawn as plain dots offers nothing. */
export function magnetLayerPoints(layers: readonly LayerDef[], isVisible: (id: LayerId) => boolean, loads: ReadonlyMap<LayerId, LayerData>): LayerPoint[][] {
  return layers.flatMap((l) => {
    const load = isMagnetLayer(l) && isVisible(l.id) ? loads.get(l.id) : undefined
    return load?.state === 'ready' ? [layerPoints(l, load.data)] : []
  })
}
