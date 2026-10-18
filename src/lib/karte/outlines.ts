// Building outlines for «Karte & Objekte»: the OSM footprints the Umriss picker already uses
// (`/api/overpass/buildings`, answered from the station's stored snapshot first — app/
// reference_buildings), loaded per grid CELL around what is on screen, so panning the station
// asks the server a handful of times and never twice for the same block.
//
// Two uses, both by CONTAINMENT only (lib/karte/places · ringAt / outlineFor): a tap on the map
// opens the building under the finger, and a station object is drawn as the outline its own
// coordinate lies in. No outline under a point → no building, never «the nearest one».

import type { LngLat } from '../../types'
import { apiPost } from '../api'
import { idbGet, idbSet } from '../idb'
import { ringsFromOverpass } from './places'

/** A cell is ~330 × 300 m at Swiss latitudes — a few cells cover a tablet screen at z16. */
export const CELL_LAT = 0.003
export const CELL_LNG = 0.0045
/** below this zoom the outlines are too small to tap and too many to load */
export const OUTLINE_MIN_ZOOM = 15
/** never ask for more cells than this at once (a zoomed-out pan) */
export const MAX_CELLS = 12

export const cellKey = (ix: number, iy: number): string => `${ix}:${iy}`

/** The cells a WGS84 box touches, nearest-to-centre first, at most `MAX_CELLS`. */
export function cellsFor(west: number, south: number, east: number, north: number): string[] {
  const x0 = Math.floor(west / CELL_LNG), x1 = Math.floor(east / CELL_LNG)
  const y0 = Math.floor(south / CELL_LAT), y1 = Math.floor(north / CELL_LAT)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const out: { k: string; d: number }[] = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ k: cellKey(x, y), d: Math.hypot(x - cx, y - cy) })
  out.sort((a, b) => a.d - b.d)
  return out.slice(0, MAX_CELLS).map((c) => c.k)
}

/** The cell a point lies in. */
export function cellOf([lng, lat]: LngLat): string {
  return cellKey(Math.floor(lng / CELL_LNG), Math.floor(lat / CELL_LAT))
}

export function cellBox(key: string): { south: number; west: number; north: number; east: number } {
  const [ix, iy] = key.split(':').map(Number)
  return { south: iy * CELL_LAT, west: ix * CELL_LNG, north: (iy + 1) * CELL_LAT, east: (ix + 1) * CELL_LNG }
}

const IDB_PREFIX = 'kp.karte.bld.'
const loads = new Map<string, Promise<LngLat[][]>>()

/** One cell's outlines: memory, then the device (IndexedDB), then the server. A failed load is
 *  forgotten, so the next pan over the cell asks again. */
export function loadCell(key: string): Promise<LngLat[][]> {
  const hit = loads.get(key)
  if (hit) return hit
  const p = idbGet<LngLat[][]>(IDB_PREFIX + key).catch(() => null).then(async (stored) => {
    if (stored && Array.isArray(stored)) return stored
    const rings = ringsFromOverpass(await apiPost<unknown>('/api/overpass/buildings', cellBox(key)))
    void idbSet(IDB_PREFIX + key, rings).catch(() => {})
    return rings
  })
  loads.set(key, p)
  p.catch(() => { if (loads.get(key) === p) loads.delete(key) })
  return p
}
