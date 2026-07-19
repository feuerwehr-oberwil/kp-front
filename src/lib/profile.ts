import type { LngLat } from '../types'
import { wgs84ToLV95 } from './geo'

// Height profile along a path, from the swisstopo elevation service. Switzerland
// only (LV95 / EPSG:2056) — outside CH the API returns nothing, so callers treat
// a null result as "no profile available" and just show the distance.
export interface ProfilePoint { dist: number; alt: number }
export interface ProfileResult {
  points: ProfilePoint[]
  min: number          // lowest altitude (m)
  max: number          // highest altitude (m)
  gain: number         // cumulative ascent (m)
  loss: number         // cumulative descent (m)
  start: number        // first altitude (m)
  end: number          // last altitude (m)
}

const ENDPOINT = 'https://api3.geo.admin.ch/rest/services/profile.json'

// raw rows look like { dist, alts: { COMB: 412.3, ... }, easting, northing }
type Row = { dist: number; alts: Record<string, number | null> }
const altOf = (r: Row): number | null => r.alts.COMB ?? r.alts.DTM2 ?? r.alts.DTM25 ?? Object.values(r.alts).find((v) => v != null) ?? null

export async function fetchElevationProfile(coords: LngLat[], signal?: AbortSignal): Promise<ProfileResult | null> {
  if (coords.length < 2) return null
  const geom = JSON.stringify({ type: 'LineString', coordinates: coords.map(([lon, lat]) => wgs84ToLV95(lon, lat)) })
  const url = `${ENDPOINT}?geom=${encodeURIComponent(geom)}&sr=2056&nb_points=200&distinct_points=true`
  let rows: Row[]
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    rows = await res.json()
  } catch { return null }
  if (!Array.isArray(rows) || rows.length < 2) return null

  const points: ProfilePoint[] = []
  for (const r of rows) { const alt = altOf(r); if (alt != null) points.push({ dist: r.dist, alt }) }
  if (points.length < 2) return null

  let min = Infinity, max = -Infinity, gain = 0, loss = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i].alt
    if (a < min) min = a
    if (a > max) max = a
    if (i > 0) { const d = a - points[i - 1].alt; if (d > 0) gain += d; else loss -= d }
  }
  return { points, min, max, gain, loss, start: points[0].alt, end: points[points.length - 1].alt }
}
