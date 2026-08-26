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
