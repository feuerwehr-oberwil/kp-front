// The base map of the app's small pick-a-place maps – PlanPicker's object mini-map and the intake's
// «Standort auf Karte setzen» (components/MapPicker). Moved here from PlanPicker (sweep 30.10.2026
// #5) so the two cannot drift: the same base layer the Lagekarte draws, its dark raster at night.
import { LABEL_ATTRIBUTION, LABEL_MAXZOOM, LABEL_TILES, labelLayers } from './basemapLabels'
import { cartoRasterTiles, withCartoLabelsBaked } from './carto'
import { MAP_GLYPHS } from './mapView'
import { defaultLayers } from './workspace'

/** the one raster source in the mini-map's style — named, because the tile events below
 *  have to tell OUR base map apart from anything else MapLibre reports on */
export const PICKER_BASE_SOURCE = 'base'

const LABEL_SOURCE = 'labels'

export interface PickerStyleOptions {
  /** the street names as the Lagekarte draws them – vector text over the unlabelled raster,
   *  readable at a phone's zoom (lib/basemapLabels) – instead of the raster's own, which at z15–17
   *  carry almost none and those tiny, worst on the dark base (MapPicker, sweep 30.10.2026 #5) */
  vectorNames?: boolean
}

/**
 * A picker map's style: the SAME base layer the Lagekarte draws, at the screen's tile
 * resolution and with the deployment's CARTO key already on it (workspace · defaultLayers →
 * lib/carto), and its purpose-built dark raster in night mode.
 *
 * It used to hard-code `rastertiles/voyager` on subdomains a+b. That made the preview the one
 * map in the app on its own tile addresses: a day basemap inside a night dialog, outside what
 * the offline prefetch cached (`useOfflinePrefetch` warms the base layer's templates), and
 * dependent on a CARTO key the rest of the surface may not even be using. Owner, round 7
 * point 17: «When opening Andres Objekt the map stayed empty and looks rather sad» — with the
 * flags drawn over it, which is what a style whose tiles never arrive looks like.
 */
export const pickerBaseStyle = (night: boolean, { vectorNames = false }: PickerStyleOptions = {}) => {
  const bases = defaultLayers().filter((l) => l.base)
  const base = bases.find((l) => l.visible) ?? bases[0]
  // the Karte's own names over the unlabelled raster where the base has them (lib/basemapLabels);
  // otherwise a plain raster style: the labelled twin of the base (lib/carto)
  const names = vectorNames && !!base?.labels
  const raw = night && base?.nightTiles?.length ? base.nightTiles : base?.tiles
  const tiles = (names ? raw : raw?.map(withCartoLabelsBaked)) ?? cartoRasterTiles('rastertiles/voyager', ['a', 'b'])
  const raster = { id: PICKER_BASE_SOURCE, type: 'raster' as const, source: PICKER_BASE_SOURCE }
  return {
    version: 8 as const,
    ...(names && { glyphs: MAP_GLYPHS }),
    sources: {
      [PICKER_BASE_SOURCE]: {
        type: 'raster' as const,
        tiles,
        tileSize: 256,
        maxzoom: base?.maxzoom,
        attribution: base?.attribution ?? '© CARTO, © OpenStreetMap-Mitwirkende',
      },
      ...(names && { [LABEL_SOURCE]: { type: 'vector' as const, tiles: LABEL_TILES, maxzoom: LABEL_MAXZOOM, attribution: LABEL_ATTRIBUTION } }),
    },
    layers: names ? [raster, ...labelLayers(LABEL_SOURCE, LABEL_SOURCE, night)] : [raster],
  }
}
