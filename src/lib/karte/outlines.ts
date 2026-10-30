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
// OSM traces roofs from aerial images, the survey walls, so most OSM outlines lie over a house a
// band wider, or over two (Karte Haus round 4, 20.10.2026 — owner: «two outlines … hoverable/
// clickable», Bottmingerstrasse 44, 55 / Talstrasse 1). Such an outline is the same building
// traced again: `osmBeside` drops it, once per cell, so OSM only fills in where the survey has
// nothing (a shed, a carport, outside the Einsatzgebiet).
//
// `ringsAround` picks between them for a point. Every use is by CONTAINMENT only (lib/karte/places ·
// ringAt / outlineFor): a tap on the map opens the building under the finger, and a station object
// with no official buildings is drawn as the OSM outline its own coordinate lies in. No outline
// under a point → no building, never «the nearest one».

import { useEffect, useState } from 'react'
import type { LngLat } from '../../types'
import { apiPost } from '../api'
import { loadHouses, outlineRings } from '../api/stationReference'
import { ringContains } from '../footprintPick'
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
 *  forgotten, so the next pan over the cell asks again. An EMPTY stored cell is asked again once
 *  per session: it may be an Overpass timeout answer stored before the server refused those. */
export function loadCell(key: string): Promise<LngLat[][]> {
  const hit = loads.get(key)
  if (hit) return hit
  const p = idbGet<LngLat[][]>(IDB_PREFIX + key).catch(() => null).then(async (stored) => {
    if (Array.isArray(stored) && stored.length > 0) return stored
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

type Box = { w: number; s: number; e: number; n: number }
const boxOf = (r: readonly LngLat[]): Box => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of r) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
  return { w, s, e, n }
}

export function houseIndex(rings: readonly LngLat[][]): HouseIndex {
  const m = new Map<string, LngLat[][]>()
  for (const r of rings) {
    const { w, s, e, n } = boxOf(r)
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
 *  one of them contains the point, else the cell's OSM outlines that are no house traced again
 *  (`osmBeside`). Never both: OSM's block around a house must not win over the house, nor a
 *  house's neighbour over the OSM building it misses. */
export function ringsAround(houses: HouseIndex | null, osm: readonly LngLat[][] | undefined, at: LngLat): readonly LngLat[][] {
  const here = houses?.get(cellOf(at))
  if (here && ringAt(here, at)) return here
  return osm && houses ? osmBeside(houses, osm) : osm ?? []
}

/** An OSM outline is a survey house traced again when the houses cover this share of it… */
const SAME_SHARE_OF_OSM = 0.1
/** …or it covers this share of one house (a big roof over a small house). Below both it only
 *  touches a house — a neighbour whose shared wall the two traced a little apart, a carport. */
const SAME_SHARE_OF_HOUSE = 0.5
/** the overlap is counted on a grid this fine (metres; a 2 m² shed gets ~30 samples), at most
 *  `MAX_STEPS` per side of a box (a hall's 7 000 m² in 144 samples, not 100 000) */
const SAMPLE_M = 0.25
const MAX_STEPS = 12

// per house set, per cell's OSM list (memory, IndexedDB or Overpass — the same array until the
// cell reloads): the pruned list, so a hover never measures again
const pruned = new WeakMap<HouseIndex, WeakMap<readonly LngLat[][], LngLat[][]>>()

/** The OSM outlines that are NOT a survey house traced again: those that overlap no house by
 *  more than a sliver. Once per (house set, cell), then from memory. */
export function osmBeside(houses: HouseIndex, osm: readonly LngLat[][]): LngLat[][] {
  let byCell = pruned.get(houses)
  if (!byCell) pruned.set(houses, byCell = new WeakMap())
  let out = byCell.get(osm)
  if (!out) byCell.set(osm, out = osm.filter((r) => !tracesAHouse(houses, r)))
  return out
}

const areaDeg = (r: readonly LngLat[]): number => {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return Math.abs(a) / 2
}

/** Does the OSM ring lie over a survey house (`SAME_SHARE_*`)? Bounding boxes first, then the
 *  overlap sampled on a grid (`SAMPLE_M`, `MAX_STEPS`) over the two boxes' intersection. */
function tracesAHouse(houses: HouseIndex, ring: LngLat[]): boolean {
  if (ring.length < 3) return false
  const b = boxOf(ring)
  const near = new Set<LngLat[]>()
  for (let ix = Math.floor(b.w / CELL_LNG); ix <= Math.floor(b.e / CELL_LNG); ix++) {
    for (let iy = Math.floor(b.s / CELL_LAT); iy <= Math.floor(b.n / CELL_LAT); iy++) {
      for (const h of houses.get(cellKey(ix, iy)) ?? []) near.add(h)
    }
  }
  if (!near.size) return false
  const sy = SAMPLE_M / 110_540
  const sx = SAMPLE_M / (111_320 * Math.cos((((b.s + b.n) / 2) * Math.PI) / 180))
  const osmArea = areaDeg(ring)
  let covered = 0
  for (const h of near) {
    const hb = boxOf(h)
    const w = Math.max(b.w, hb.w), e = Math.min(b.e, hb.e), s = Math.max(b.s, hb.s), n = Math.min(b.n, hb.n)
    if (w >= e || s >= n) continue
    const nx = Math.min(Math.ceil((e - w) / sx), MAX_STEPS), ny = Math.min(Math.ceil((n - s) / sy), MAX_STEPS)
    const dx = (e - w) / nx, dy = (n - s) / ny
    let both = 0
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const p: LngLat = [w + (i + 0.5) * dx, s + (j + 0.5) * dy]
        if (ringContains(h, p) && ringContains(ring, p)) both++
      }
    }
    if (!both) continue
    const shared = both * dx * dy
    if (shared >= SAME_SHARE_OF_HOUSE * areaDeg(h)) return true
    covered += shared
    if (covered >= SAME_SHARE_OF_OSM * osmArea) return true
  }
  return false
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
