import type { LngLat } from '../types'
import { appConfig } from '../config/appConfig'

const M_PER_LAT = 110540

export function circlePolygon(center: LngLat, radiusM: number, n = 96): number[][][] {
  const mPerLon = 111320 * Math.cos((center[1] * Math.PI) / 180)
  const ring: number[][] = []
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n
    ring.push([
      center[0] + (radiusM * Math.cos(a)) / mPerLon,
      center[1] + (radiusM * Math.sin(a)) / M_PER_LAT,
    ])
  }
  return [ring]
}

// WGS84 (lon,lat °) → Schweizer Landeskoordinaten LV95 (E,N in m). swisstopo-Näherungsformel.
export function wgs84ToLV95(lon: number, lat: number): [number, number] {
  const phi = (lat * 3600 - 169028.66) / 10000
  const lam = (lon * 3600 - 26782.5) / 10000
  const E = 2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam ** 3
  const N = 1200147.07 + 308807.95 * phi + 3745.25 * lam * lam + 76.63 * phi * phi - 194.56 * lam * lam * phi + 119.79 * phi ** 3
  return [E, N]
}

// LV95 (E,N in m, EPSG:2056) → WGS84 (lon,lat °). Inverse of wgs84ToLV95, using the
// swisstopo-Näherungsformel (approximate transform, ~1 m accuracy). Returns [lon, lat].
export function lv95ToWgs84(e: number, n: number): [number, number] {
  const y = (e - 2600000) / 1000000
  const x = (n - 1200000) / 1000000
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
  return [(lon * 100) / 36, (lat * 100) / 36]
}

const thin = (n: number) => Math.round(n).toLocaleString(appConfig.locale).replace(/[\u00a0,]/g, "'")
export function fmtLV95(lon: number, lat: number): string {
  const [e, n] = wgs84ToLV95(lon, lat)
  return `${thin(e)} / ${thin(n)}`
}
export function fmtWGS(lon: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

export function fmtMMSS(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const R_EARTH = 6371008.8 // mean Earth radius (m)
/** great-circle distance between two WGS84 points, in metres */
export function haversineM(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(a[0] - b[0]) * -1
  const lat1 = toRad(a[1]), lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** total length of a polyline (sum of segment great-circle distances), in metres */
export function pathLengthM(coords: LngLat[]): number {
  let sum = 0
  for (let i = 1; i < coords.length; i++) sum += haversineM(coords[i - 1], coords[i])
  return sum
}

/** human distance: metres under 1 km, else kilometres with one decimal */
export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toLocaleString(appConfig.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`
}

/** how many hose lengths a run needs: distance + a reserve margin, divided by the nominal
 *  hose length, rounded UP (you can't lay a fraction of a hose). Both the reserve (default
 *  10 %) and the hose length (default 20 m) come from appConfig.drawing. */
export function hoseCount(lenM: number): number {
  const h = appConfig.drawing.hoseLengthM
  const reserve = appConfig.drawing.hoseReservePct ?? 0
  if (!(lenM > 0) || !(h > 0)) return 0
  return Math.ceil((lenM * (1 + reserve)) / h)
}

/** hose-length helper for the Messpfeil label, e.g. "~5 Schläuche" (incl. the reserve). */
export function hoseLengthHint(lenM: number): string {
  return appConfig.copy.hoseHint.replace('{n}', String(hoseCount(lenM)))
}

/** planar area of a polygon (m²), shoelace over LV95 metric coords — accurate for
 *  the local extents this app deals with. Ring is auto-closed. */
export function polygonAreaM2(coords: LngLat[]): number {
  if (coords.length < 3) return 0
  const pts = coords.map(([lon, lat]) => wgs84ToLV95(lon, lat))
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  }
  return Math.abs(a) / 2
}

/** human area: m² under 1 ha, hectares under 1 km², else km² */
export function fmtArea(m2: number): string {
  const num = (n: number, d = 2) => n.toLocaleString(appConfig.locale, { minimumFractionDigits: d, maximumFractionDigits: d })
  if (m2 < 10000) return `${Math.round(m2)} m²`
  if (m2 < 1_000_000) return `${num(m2 / 10000)} ha`
  return `${num(m2 / 1_000_000)} km²`
}
