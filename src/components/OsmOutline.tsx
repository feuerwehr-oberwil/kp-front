import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { cx } from '../lib/cx'
import { principalAngleDeg } from '../lib/footprint'
import { idbGet, idbSet } from '../lib/idb'
import { apiPost } from '../lib/api'
import { georefFromPick, M_PER_LAT, matchStoredRings, mPerLon } from '../lib/buildingTransfer'
import type { LngLat, SrcGeoref } from '../types'
import s from './OsmOutline.module.css'

// A building footprint as a normalized 0..1 ring in board space (north-up).
type Ring = [number, number][]

const cache = new Map<string, Promise<Ring[]>>()
// Resolved outlines by key — lets the component seed its state SYNCHRONOUSLY. The `cache` Map
// only holds the Promise, so even a warm reload flashed "…werden geladen" for one async tick
// while the IDB read settled; seeding from this map skips that flash entirely.
const resolved = new Map<string, Ring[]>()

// The persistent-cache key (rounded bbox) + its bounds — pulled out so the component can compute
// the key up front and check `resolved` before its first paint.
function bboxKey(center: LngLat, radiusM: number) {
  const dLat = radiusM / M_PER_LAT
  const dLon = radiusM / mPerLon(center[1])
  const south = center[1] - dLat, north = center[1] + dLat
  const west = center[0] - dLon, east = center[0] + dLon
  return { key: `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`, south, west, north, east }
}

const CACHE_PREFIX = 'kp.osm.bld.' // persistent (IndexedDB) outline cache, keyed by bbox
const RETRY_AFTER_MS = 5_000    // show «Erneut laden» once a load has been pending this long

// Ask our OWN backend, which races the Overpass mirrors on our behalf (app/overpass.py).
//
// This used to POST straight to three public Overpass servers from the browser — one of them
// hosted in Russia — which made README's "the browser never calls a third party" false and
// sent the incident's bounding box somewhere PRIVACY.md never mentioned. The surface is
// prefetched on every incident open, so it was the rule rather than the exception.
//
// The mirror race, its per-mirror timeout and the response shape all moved server-side
// unchanged, so everything below this function still works on Overpass' own JSON.
// Only the parts of Overpass' JSON this component reads. A `way` carries its own geometry;
// a `relation` carries member ways, of which the `outer` ones form the footprint.
type OverpassNode = { lat: number; lon: number }
type OverpassElement = {
  type?: string
  geometry?: OverpassNode[]
  members?: { type?: string; role?: string; geometry?: OverpassNode[] }[]
}

function fetchOverpass(
  south: number, west: number, north: number, east: number,
): Promise<{ elements?: OverpassElement[] }> {
  return apiPost<{ elements?: OverpassElement[] }>('/api/overpass/buildings', { south, west, north, east })
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

  // persistent cache (IndexedDB): a previous fetch (this session or an earlier one) makes the
  // outlines instant on reload, so the Overpass round-trip only happens once per location.
  const cacheKey = CACHE_PREFIX + key
  const p = idbGet<Ring[]>(cacheKey).then((stored) => {
    if (stored) return stored
    return fetchOverpass(south, west, north, east).then((data) => {
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
  // let a failed fetch be retried on next mount — identity-guarded so a superseded
  // promise (evicted by «Erneut laden») can't delete its replacement when it settles
  p.catch(() => { if (cache.get(key) === p) cache.delete(key) })
  return p
}

// Drop the cached (possibly still-pending) fetch for a bbox so the «Erneut laden» tap
// starts a fresh request instead of re-awaiting the stuck one.
function evictOutlines(center: LngLat, radiusM: number) {
  cache.delete(bboxKey(center, radiusM).key)
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
  /** a Gebäude already exists, so a pick changes it rather than creating the first one.
   *  Only still says «ersetzt» for a LEGACY building — one without a georeference, which cannot
   *  be pre-selected below and therefore genuinely starts the selection empty. */
  replacing?: boolean
  /** the footprints of the Gebäude that already exists, in its own `src` space, plus where that
   *  space sits on the ground. Given both, the picker lays the saved rings back over the live
   *  Overpass footprints and PRE-SELECTS them — «Anderes Gebäude wählen» is almost always
   *  «ergänzen», and starting from an empty selection made amending look like starting over.
   *  Absent (no building, or one saved before `geo` existed) → the selection starts empty. */
  preselectSrc?: [number, number][][]
  preselectGeo?: SrcGeoref
  /** called with all selected footprints in ISOTROPIC 0..1 board space (true
   *  proportions, normalized to their COMBINED bbox), the auto-orientation angle
   *  (deg, longest-axis-horizontal) and the ground position of that box. The floor-stack derives
   *  its rendered views from the first two and re-anchors its annotations with the third —
   *  see lib/footprint + lib/buildingTransfer + BuildingDoc. */
  onPick?: (src: [number, number][][], orientDeg: number, geo: SrcGeoref) => void
}

// Live OSM building-outline backdrop for the whiteboard — a traceable base, and
// the surface where the affected building(s) are picked into the floor-stack.
// Tapping footprints toggles a selection; "Übernehmen" transfers them all at once.
export function OsmOutline({ center, radiusM, onAspect, interactive, replacing, preselectSrc, preselectGeo, onPick }: Props) {
  // Seed from the resolved cache so a warm hit (prefetched at boot, or a prior open) paints the
  // outlines immediately instead of flashing the loader while the async IDB read settles.
  const [rings, setRings] = useState<Ring[] | null>(() => resolved.get(bboxKey(center, radiusM).key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // saved footprints the current fetch does NOT contain (offline fallback, a moved bbox, an OSM
  // edit). Named rather than quietly left out of the selection — applying would lose them.
  const [missing, setMissing] = useState(0)
  // has the operator changed the pre-selection since it was laid down? Only until then does the
  // note about it tell the truth.
  const [touched, setTouched] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)

  // «Erneut laden» surfaces once a load has been pending for a while (same model as the
  // PDF placeholders — a warm/instant load never flashes the button)
  const loading = !error && !rings
  useEffect(() => {
    if (!loading) { setSlow(false); return }
    setSlow(false)
    const t = setTimeout(() => setSlow(true), RETRY_AFTER_MS)
    return () => clearTimeout(t)
  }, [loading, center, radiusM, attempt])

  // drop the cached fetch (even a stuck-pending one) and start over — in-app recovery
  // that previously required a full page reload
  const retry = () => {
    evictOutlines(center, radiusM)
    setError(null)
    setAttempt((a) => a + 1)
  }

  const toggle = (i: number) => {
    setTouched(true)
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

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
    // …and WHERE that box is: without it the saved building is a rectangle with no address, and
    // neither this pre-selection nor carrying the floor stack across a change is possible.
    onPick?.(src, principalAngleDeg(src), georefFromPick(center, radiusM, picked))
  }

  useEffect(() => {
    let alive = true
    onAspect(1) // square metre-bbox
    // Only blank to the loader on a COLD key — a warm key keeps the already-painted outlines.
    const warm = resolved.get(bboxKey(center, radiusM).key) ?? null
    setRings(warm); setError(null)
    loadBuildings(center, radiusM)
      .then((r) => { if (alive) setRings(r) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'OSM nicht erreichbar') })
    return () => { alive = false }
  }, [center, radiusM, onAspect, attempt])

  // The building that already exists starts SELECTED. Its saved rings are laid back over the live
  // footprints by WORLD POSITION (lib/buildingTransfer · matchStoredRings) — shape alone is
  // scale-ambiguous, and no OSM ids are kept anywhere. Re-runs on every fetch, so a fresh load
  // also clears whatever the previous bbox had selected.
  useEffect(() => {
    setTouched(false)
    if (!rings || !preselectSrc?.length || !preselectGeo) { setSelected(new Set()); setMissing(0); return }
    const m = matchStoredRings(preselectSrc, preselectGeo, center, radiusM, rings)
    setSelected(new Set(m.indices)); setMissing(m.missing)
  }, [rings, preselectSrc, preselectGeo, center, radiusM])

  // drop selections if interactivity is lost
  useEffect(() => { if (!interactive) setSelected(new Set()) }, [interactive])

  const copy = appConfig.copy.whiteboard

  if (error) return (
    <div className={s['wb-osm-hint']}>
      <span>{copy.osmError}</span>
      <button type="button" className={s['wb-osm-retry']} onClick={retry}>{copy.osmRetry}</button>
    </div>
  )
  if (!rings) return (
    <div className={s['wb-osm-hint']}>
      <span>{copy.osmLoading}</span>
      {slow && <button type="button" className={s['wb-osm-retry']} onClick={retry}>{copy.osmRetry}</button>}
    </div>
  )
  if (rings.length === 0) return <div className={s['wb-osm-hint']}>{copy.osmEmpty}</div>

  const n = selected.size
  // the existing building was found and is highlighted — say once that tapping ADDS to it
  const preselected = !touched && !!preselectGeo && !!preselectSrc?.length && n > 0

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
        <div className={s['wb-osm-barwrap']} onPointerDown={(e) => e.stopPropagation()}>
          {/* ONE line of context above the buttons, and the loss always wins it: a saved outline
              that is not in this fetch would otherwise vanish from the selection unannounced. */}
          {missing > 0
            ? <div className={s['wb-osm-warn']}>{fillTemplate(copy.osmPickMissing, { n: missing })}</div>
            : preselected && <div className={s['wb-osm-note']}>{copy.osmPickHintAmend}</div>}
          <div className={s['wb-osm-bar']}>
            {n === 0 ? (
              <span className={s['wb-osm-barhint']}>{replacing ? copy.osmPickHintReplace : copy.osmPickHint}</span>
            ) : (
              <>
                <button className={s['wb-osm-clear']} onClick={() => { setTouched(true); setSelected(new Set()) }}>{copy.osmClear}</button>
                <button className={s['wb-osm-take']} onClick={transfer}>{fillTemplate(copy.osmTransfer, { n })}</button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
