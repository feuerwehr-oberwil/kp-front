import { getDeploymentConfig } from './deploymentConfig'

const CARTO_RASTER_HOST = /^https:\/\/(?:[a-d]\.)?basemaps\.cartocdn\.com\//i

/**
 * Add the deployment's CARTO Basemaps key to a raster tile template.
 *
 * CARTO's basemap key is a browser credential by design: it is sent as `?key=` on every
 * tile request and should be restricted to this deployment's domains in CARTO. Keeping it
 * in the runtime deployment response means it is never committed or baked into the image.
 */
export function withCartoBasemapKey(url: string): string {
  const key = getDeploymentConfig().integrations?.cartoBasemapKey?.trim()
  if (!key || !CARTO_RASTER_HOST.test(url) || /(?:[?&])key=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`
}

/** Built-in CARTO raster templates, keyed and sized for this screen at the point a map is rendered. */
export function cartoRasterTiles(style: string, subdomains: readonly string[] = ['a', 'b', 'c', 'd']): string[] {
  return subdomains.map((s) => withCartoBasemapKey(withCartoRetina(
    `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`,
  )))
}

/**
 * Retina CARTO tiles — why the map was blurry (owner, review round 4, 17.10.2026, iPhone).
 *
 * Every base raster is a 256 px tile on MapLibre's 512 px zoom grid (MapLayers · tileSize 256),
 * so each tile is painted across 256 CSS px. On a 3× iPhone that is 768 device pixels made from
 * 256: every source pixel blown up three times, the street names and house edges smeared. CARTO
 * serves the same tile drawn at twice the resolution as `…/{y}@2x.png` (512 px, same area, same
 * label size), which MapLibre paints into the same 256 CSS px — 1.5× on a phone, 1:1 on a 2×
 * iPad. A 1× screen keeps the 1× tile: the 2× one costs ~3× the bytes for nothing it can show.
 *
 * ⚠️ The suffix is part of the tile's ADDRESS, so it is decided once, here, for every consumer of
 * a layer's templates (workspace · builtinAndConfigLayers): the map, the offline download, the
 * coverage probe and the readiness sheet must all name the same URL, or the cache holds tiles the
 * map never asks for. What leaves for our backend is 1× again (`withoutCartoRetina`): the Rapport's
 * compositor (backend app/kroki) lays tiles on a 256 px grid. The 1× tiles a retina device cached
 * before are dropped once (lib/tilePurge · `carto-retina-2026-10`).
 */
export function wantsRetinaTiles(dpr: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): boolean {
  return dpr > 1
}

/** `{y}.png` / `{y}@2x.png` at the end of a CARTO raster template's path (before any query) */
const CARTO_TILE_END = /\{y\}(?:@2x)?\.png(?=$|[?#])/

/** A CARTO raster template at the resolution this screen wants (other hosts untouched). */
export function withCartoRetina(url: string, retina: boolean = wantsRetinaTiles()): string {
  if (!CARTO_RASTER_HOST.test(url)) return url
  return url.replace(CARTO_TILE_END, retina ? '{y}@2x.png' : '{y}.png')
}

/** A CARTO raster template back at 1× — for our own backend, whose compositor is 256 px. */
export const withoutCartoRetina = (url: string): string => withCartoRetina(url, false)

/** The labelled twin of each unlabelled CARTO style (other hosts and styles untouched). */
const CARTO_NOLABELS = /\/(rastertiles\/voyager|dark|light)_nolabels\//
const LABELLED: Record<string, string> = { 'rastertiles/voyager': 'rastertiles/voyager', dark: 'dark_all', light: 'light_all' }

/**
 * A CARTO template with the names baked in again – for the surfaces that draw the raster ALONE.
 * The app's base is the unlabelled raster with vector names on top (lib/basemapLabels); paper
 * (the Rapport's Kroki and the Tafel box, composited by the backend) and the plain raster pickers
 * get no vector layer, so they ask for the labelled tiles instead.
 */
export function withCartoLabelsBaked(url: string): string {
  return url.replace(CARTO_NOLABELS, (_, style: string) => `/${LABELLED[style]}/`)
}

/** Apply the screen's tile resolution to a layer's CARTO templates (day and night). */
export function retinaCartoTileTemplates<T extends { tiles?: string[]; nightTiles?: string[] }>(layer: T, retina: boolean = wantsRetinaTiles()): T {
  const tiles = layer.tiles?.map((u) => withCartoRetina(u, retina))
  const nightTiles = layer.nightTiles?.map((u) => withCartoRetina(u, retina))
  const same = (a?: string[], b?: string[]) => a === b || (!!a && !!b && a.every((u, i) => u === b[i]))
  return same(tiles, layer.tiles) && same(nightTiles, layer.nightTiles) ? layer : { ...layer, tiles, nightTiles }
}

/** Apply the runtime key to a possibly persisted/custom layer without touching other hosts. */
export function keyCartoTileTemplates<T extends { tiles?: string[]; nightTiles?: string[] }>(layer: T): T {
  const tiles = layer.tiles?.map(withCartoBasemapKey)
  const nightTiles = layer.nightTiles?.map(withCartoBasemapKey)
  return tiles === layer.tiles && nightTiles === layer.nightTiles ? layer : { ...layer, tiles, nightTiles }
}

/**
 * Strip any `key=` parameter from a tile template.
 *
 * Used on the way OUT to our own backend (the Rapport/Kroki payload names the basemap the
 * operator was looking at). The server holds the same credential and applies its own — see
 * backend `app/carto.py` — so sending ours would only copy it into a request body, the
 * application log and the on-disk tile-cache filenames.
 *
 * Host-agnostic on purpose: a key pasted into a station's own custom layer is no more ours to
 * forward than CARTO's is.
 *
 * ⚠️ Parses the query rather than pattern-matching it. `new URL()` is not an option — it
 * percent-encodes the `{z}/{x}/{y}` slots and hands back something MapLibre cannot fill — but
 * substring surgery on a URL is how `monkey=1` gets eaten, so split on the real separators and
 * drop whole parameters.
 */
export function withoutCartoBasemapKey(url: string): string {
  const hash = url.indexOf('#')
  const frag = hash < 0 ? '' : url.slice(hash)
  const base = hash < 0 ? url : url.slice(0, hash)
  const q = base.indexOf('?')
  if (q < 0) return url
  const kept = base
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '' && p !== 'key' && !p.startsWith('key='))
  return (kept.length ? `${base.slice(0, q)}?${kept.join('&')}` : base.slice(0, q)) + frag
}
