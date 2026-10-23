import type { SymbolLayerSpecification } from 'maplibre-gl'
import vendored from '../data/cartoLabelLayers.json'
import { fillTileTemplate, tilesForBounds, type LngLatBounds } from './offlineTiles'

// The CARTO base's street, place and house-number names, drawn as VECTOR text over the
// unlabelled raster (owner pick «C», 21.10.2026). CARTO's labelled raster tiles carry almost no
// street names at the zooms a phone uses (Oberwil at z16, day and night: Hauptstrasse and
// Bahnhofstrasse unnamed, house numbers present), and the few they carry were too small to read.
// Vector names are placed across tiles, sharp on any screen, and sized here. The printed map
// keeps the labelled raster (lib/carto · withCartoLabelsBaked).
//
// The layers are CARTO's own (scripts/vendor-map-labels.mjs, from the Voyager GL style the raster
// is rendered from): the same names in the same places. Day keeps CARTO's colours; night paints
// them light on a black halo, the way the dark raster's own labels were lifted to white.

/** CARTO's vector tiles behind its basemaps – no key needed. TileJSON maxzoom is 14; MapLibre
 *  overzooms from there, so one zoom level carries every name down to the house numbers. */
export const LABEL_TILES = ['a', 'b', 'c', 'd'].map((s) => `https://tiles-${s}.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt`)
export const LABEL_MAXZOOM = 14
/** The vector tiles follow the OpenMapTiles schema, whose terms want it credited on the map
 *  (CARTO's style licence, NOTICE); CARTO and OSM are credited by the base already. */
export const LABEL_ATTRIBUTION = '© OpenMapTiles'
/** Every glyph range we ship (public/fonts, served at lib/mapView · MAP_GLYPHS). */
const GLYPH_FILES = ['NotoSans-Regular', 'NotoSans-Bold'].flatMap((font) =>
  ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447'].map((range) => `/fonts/${font}/${range}.pbf`))

/** CARTO's sizes × this – the factor the owner picked between 1.3 and 1.6 on a phone. */
const LABEL_SCALE = 1.3
const NIGHT_PAINT = { 'text-color': '#e4e4e4', 'text-halo-color': '#000000', 'text-halo-width': 1.2 }

// Vendored from a style MapLibre itself renders; the JSON's inferred types are just wider.
const LAYERS = vendored as unknown as readonly SymbolLayerSpecification[]

type TextSize = NonNullable<NonNullable<SymbolLayerSpecification['layout']>['text-size']>

/** A `text-size` × f, in the two forms CARTO's style uses: a number and legacy zoom stops. */
export function scaleTextSize(size: TextSize, f: number): TextSize {
  if (typeof size === 'number') return size * f
  if (typeof size === 'object' && size !== null && 'stops' in size && Array.isArray(size.stops)) {
    return { ...size, stops: size.stops.map(([z, s]) => [z, typeof s === 'number' ? s * f : s]) } as TextSize
  }
  return size
}

/** The label layers for one source, ids `<prefix>-<CARTO id>`, painted for the theme. */
export function labelLayers(source: string, idPrefix: string, night: boolean): SymbolLayerSpecification[] {
  return LAYERS.map((l) => ({
    ...l,
    id: `${idPrefix}-${l.id}`,
    source,
    layout: { ...l.layout, ...(l.layout?.['text-size'] != null && { 'text-size': scaleTextSize(l.layout['text-size'], LABEL_SCALE) }) },
    paint: night ? { ...l.paint, ...NIGHT_PAINT } : l.paint,
  }))
}

/** What one of `labelWarmUrls` costs in storage – a z14 tile ~80 KB, a glyph range ≤130 KB –
 *  for the download's pre-flight, where a warm item is otherwise priced as a plan PDF. */
export const LABEL_WARM_BYTES = 100 * 1024

/** What an offline download warms so the names are there without a network: the area's label
 *  tiles (z14 only – everything above is overzoomed from them) and every glyph range. */
export function labelWarmUrls(bounds: LngLatBounds): string[] {
  return [
    ...tilesForBounds(bounds, LABEL_MAXZOOM, LABEL_MAXZOOM).map((t) => fillTileTemplate(LABEL_TILES[0], t.z, t.x, t.y)),
    ...GLYPH_FILES,
  ]
}
