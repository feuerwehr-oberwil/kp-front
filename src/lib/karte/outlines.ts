// Building outlines for «Karte & Objekte», two sources:
//
//   · the HOUSES (Karte Haus round 1, 19.10.2026 — owner: «no differentiation between Storchenweg
//     2, 4, or 6»): the cadastral survey's footprints, one per house, for the whole Einsatzgebiet
//     (backend app/houses · `GET /api/reference/houses`), loaded ONCE per visit and kept on the
//     device for offline (lib/api/stationReference · loadHouses). `useHouses` → `HouseIndex`;
//   · the OSM footprints the Umriss picker uses (`/api/overpass/buildings`, answered from the
//     station's stored snapshot first — app/reference_buildings), loaded per grid CELL around what
//     is on screen. OSM draws a terraced row as ONE block, so it is only the FALLBACK: outside the
//     Einsatzgebiet, before the houses arrive, or with the source off (`HOUSES_WFS=`).
//
// `ringsAround` picks between them for a point. Every use is by CONTAINMENT only (lib/karte/places ·
// ringAt / outlineFor): a tap on the map opens the building under the finger, and a station object
// with no official buildings is drawn as the OSM outline its own coordinate lies in. No outline
// under a point → no building, never «the nearest one».

import { useEffect, useState } from 'react'
import type { LngLat } from '../../types'
import { apiPost } from '../api'
import { loadHouses, outlineRings } from '../api/stationReference'
import { idbGet, idbSet } from '../idb'
import { ringAt, ringsFromOverpass } from './places'

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

// --- the houses -----------------------------------------------------------------------------------

/** The houses by cell (the OSM grid's): each ring under every cell its box touches, so a tap near
 *  a cell's edge still finds the house that straddles it. */
export type HouseIndex = ReadonlyMap<string, LngLat[][]>

export function houseIndex(rings: readonly LngLat[][]): HouseIndex {
  const m = new Map<string, LngLat[][]>()
  for (const r of rings) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const [x, y] of r) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
    for (let ix = Math.floor(w / CELL_LNG); ix <= Math.floor(e / CELL_LNG); ix++) {
      for (let iy = Math.floor(s / CELL_LAT); iy <= Math.floor(n / CELL_LAT); iy++) {
        const k = cellKey(ix, iy)
        const list = m.get(k)
        if (list) list.push(r); else m.set(k, [r])
      }
    }
  }
  return m
}

/** The rings a point is matched against (`ringAt(ringsAround(…), at)`): the cell's houses when
 *  one of them contains the point, else the cell's OSM outlines. Never both: OSM's block around a
 *  house must not win over the house, nor a house's neighbour over the OSM building it misses. */
export function ringsAround(houses: HouseIndex | null, osm: readonly LngLat[][] | undefined, at: LngLat): readonly LngLat[][] {
  const here = houses?.get(cellOf(at))
  if (here && ringAt(here, at)) return here
  return osm ?? []
}

let housesLoad: Promise<HouseIndex | null> | null = null

/** The Einsatzgebiet's houses, asked once per page load (a second Karte mount reuses the answer);
 *  null until they arrive, and for good when the server has none (off, not asked yet) and the
 *  device holds no copy — the Karte then taps OSM outlines. A failed or empty ask is asked again
 *  on the next mount. */
export function useHouses(): HouseIndex | null {
  const [index, setIndex] = useState<HouseIndex | null>(null)
  useEffect(() => {
    let alive = true
    const p = housesLoad ??= loadHouses().then((set) => {
      const rings = outlineRings(set)
      return rings.length ? houseIndex(rings) : null
    })
    p.then((i) => {
      if (!i && housesLoad === p) housesLoad = null
      if (alive) setIndex(i)
    }, () => { if (housesLoad === p) housesLoad = null })
    return () => { alive = false }
  }, [])
  return index
}
