import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LngLat } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { cx } from '../lib/cx'
import { principalAngleDeg } from '../lib/footprint'
import { idbGet, idbSet } from '../lib/idb'
import s from './OsmOutline.module.css'

// A building footprint as a normalized 0..1 ring in board space (north-up).
type Ring = [number, number][]

const M_PER_LAT = 110540
const cache = new Map<string, Promise<Ring[]>>()
// Resolved outlines by key — lets the component seed its state SYNCHRONOUSLY. The `cache` Map
// only holds the Promise, so even a warm reload flashed "…werden geladen" for one async tick
// while the IDB read settled; seeding from this map skips that flash entirely.
const resolved = new Map<string, Ring[]>()

// The persistent-cache key (rounded bbox) + its bounds — pulled out so the component can compute
// the key up front and check `resolved` before its first paint.
function bboxKey(center: LngLat, radiusM: number) {
  const mPerLon = 111320 * Math.cos((center[1] * Math.PI) / 180)
  const dLat = radiusM / M_PER_LAT
  const dLon = radiusM / mPerLon
  const south = center[1] - dLat, north = center[1] + dLat
  const west = center[0] - dLon, east = center[0] + dLon
  return { key: `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`, south, west, north, east }
}

// Several Overpass mirrors — we race them so the fastest healthy server wins (the public
// overpass-api.de alone is often slow/queued). Kumi is usually the quickest.
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
const CACHE_PREFIX = 'kp.osm.bld.' // persistent (IndexedDB) outline cache, keyed by bbox

// Race the mirrors; the first one to return wins, the slower requests are harmless.
function fetchOverpass(query: string): Promise<{ elements?: any[] }> {
  return Promise.any(OVERPASS_MIRRORS.map((url) =>
    fetch(url, { method: 'POST', body: `data=${encodeURIComponent(query)}` })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
  ))
}

// Fetch building footprints in a square bbox (±radiusM around center) from the
// Overpass API and project them into normalized 0..1 board space (y down). The
// bbox is a metre-square, so reporting aspect 1 keeps the outlines undistorted.
// Cached per bbox so switching documents doesn't refetch.
function loadBuildings(center: LngLat, radiusM: number): Promise<Ring[]> {
  const { key, south, west, north, east } = bboxKey(center, radiusM)
  const hit = cache.get(key)
  if (hit) return hit

  const project = (lon: number, lat: number): [number, number] =>
    [(lon - west) / (east - west), (north - lat) / (north - south)]

  const bbox = `${south},${west},${north},${east}`
  const query = `[out:json][timeout:25];(way["building"](${bbox});relation["building"](${bbox}););out geom;`

  // persistent cache (IndexedDB): a previous fetch (this session or an earlier one) makes the
  // outlines instant on reload, so the Overpass round-trip only happens once per location.
  const cacheKey = CACHE_PREFIX + key
  const p = idbGet<Ring[]>(cacheKey).then((stored) => {
    if (stored) return stored
    return fetchOverpass(query).then((data) => {
      const rings: Ring[] = []
      const toRing = (geom: { lat: number; lon: number }[]) => {
        if (geom && geom.length >= 3) rings.push(geom.map((g) => project(g.lon, g.lat)))
      }
      for (const el of data.elements ?? []) {
        if (el.type === 'way' && el.geometry) toRing(el.geometry)
        else if (el.type === 'relation' && el.members) {
          for (const m of el.members) if (m.type === 'way' && m.geometry && (m.role === 'outer' || !m.role)) toRing(m.geometry)
        }
      }
      void idbSet(cacheKey, rings)
      return rings
    })
  }).then((rings) => { resolved.set(key, rings); return rings }) // seed the sync cache on resolve
  cache.set(key, p)
  p.catch(() => cache.delete(key)) // let a failed fetch be retried on next mount
  return p
}

// Warm the cache ahead of time (called at app start) so opening the Umgebung
// sheet is instant instead of waiting on the Overpass round-trip. Shares the same
// keyed promise the component awaits, so there's no double fetch.
export function prefetchOutlines(center: LngLat, radiusM: number) {
  loadBuildings(center, radiusM).catch(() => {})
}

interface Props {
  center: LngLat
  radiusM: number
  onAspect: (a: number) => void
  /** when true, footprints are tappable to select buildings for transfer */
  interactive?: boolean
  /** called with all selected footprints in ISOTROPIC 0..1 board space (true
   *  proportions, normalized to their COMBINED bbox) plus the auto-orientation angle
   *  (deg, longest-axis-horizontal). The floor-stack derives its rendered views from
   *  these — see lib/footprint + BuildingDoc. */
  onPick?: (src: [number, number][][], orientDeg: number) => void
}

// Live OSM building-outline backdrop for the whiteboard — a traceable base, and
// the surface where the affected building(s) are picked into the floor-stack.
// Tapping footprints toggles a selection; "Übernehmen" transfers them all at once.
export function OsmOutline({ center, radiusM, onAspect, interactive, onPick }: Props) {
  // Seed from the resolved cache so a warm hit (prefetched at boot, or a prior open) paints the
  // outlines immediately instead of flashing the loader while the async IDB read settles.
  const [rings, setRings] = useState<Ring[] | null>(() => resolved.get(bboxKey(center, radiusM).key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })

  // Transfer every selected footprint in ISOTROPIC board space, normalized to their
  // shared (combined) bbox by the LARGER side so true proportions are preserved (the
  // bbox here is a square metre-bbox, so x/y are already isotropic). The floor-stack
  // rotates these to orient the building; orientDeg is the longest-axis-horizontal angle.
  const transfer = () => {
    if (!rings || selected.size === 0) return
    const picked = [...selected].map((i) => rings[i]).filter(Boolean)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const ring of picked) for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1
    const src = picked.map((ring) => ring.map(([x, y]): [number, number] => [(x - minX) / span, (y - minY) / span]))
    onPick?.(src, principalAngleDeg(src))
  }

  useEffect(() => {
    let alive = true
    onAspect(1) // square metre-bbox
    // Only blank to the loader on a COLD key — a warm key keeps the already-painted outlines.
    const warm = resolved.get(bboxKey(center, radiusM).key) ?? null
    setRings(warm); setError(null); setSelected(new Set())
    loadBuildings(center, radiusM)
      .then((r) => { if (alive) setRings(r) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'OSM nicht erreichbar') })
    return () => { alive = false }
  }, [center, radiusM, onAspect])

  // a fresh fetch clears stale selections; also drop selections if interactivity is lost
  useEffect(() => { if (!interactive) setSelected(new Set()) }, [interactive])

  const copy = appConfig.copy.whiteboard

  if (error) return <div className={s['wb-osm-hint']}>{copy.osmError}</div>
  if (!rings) return <div className={s['wb-osm-hint']}>{copy.osmLoading}</div>
  if (rings.length === 0) return <div className={s['wb-osm-hint']}>{copy.osmEmpty}</div>

  const n = selected.size

  return (
    <>
      <svg className={cx(s['wb-osm-svg'], interactive && s.pick)} viewBox="0 0 1 1" preserveAspectRatio="none">
        {rings.map((ring, i) => (
          <polygon
            key={i}
            className={selected.has(i) ? s.sel : undefined}
            points={ring.map((p) => `${p[0]},${p[1]}`).join(' ')}
            vectorEffect="non-scaling-stroke"
            onPointerDown={interactive ? (e) => { e.stopPropagation(); toggle(i) } : undefined}
          />
        ))}
      </svg>
      {/* the bar is portaled to <body> so the transformed/panned plan board doesn't
          drag it around — it stays put at the bottom of the plan viewport */}
      {interactive && createPortal(
        <div className={s['wb-osm-bar']} onPointerDown={(e) => e.stopPropagation()}>
          {n === 0 ? (
            <span className={s['wb-osm-barhint']}>{copy.osmPickHint}</span>
          ) : (
            <>
              <button className={s['wb-osm-clear']} onClick={() => setSelected(new Set())}>{copy.osmClear}</button>
              <button className={s['wb-osm-take']} onClick={transfer}>{fillTemplate(copy.osmTransfer, { n })}</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
