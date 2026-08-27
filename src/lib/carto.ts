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

/** Built-in CARTO raster templates, keyed at the point a map is rendered. */
export function cartoRasterTiles(style: string, subdomains: readonly string[] = ['a', 'b', 'c', 'd']): string[] {
  return subdomains.map((s) => withCartoBasemapKey(
    `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`,
  ))
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
