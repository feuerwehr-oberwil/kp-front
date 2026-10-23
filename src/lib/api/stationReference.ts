// «Karte & Objekte» — the station reference reads outside an Einsatz (backend
// app/api/station_reference.py, docs/karte-objekte.md):
//
//   GET /api/reference/objects            every station object, in one payload
//   GET /api/reference/building?lat&lng   the Gebäude card's facts for any point, no incident
//   GET /api/reference/underground        the region's underground buildings (Ebenen row
//                                         «Unterirdische Bauten», backend app/underground)
//   GET /api/reference/houses             the region's houses, one footprint each (a building
//                                         tap, backend app/houses)
//
// Both are kept on the device (lib/idb · readThrough): the catalogue as ONE entry, so the objects
// stay searchable without a network, and each building answer under the place it was asked for
// (`buildingWhere`), so an offline tap on a building already looked at still shows its register
// hints — and a building never wears another one's facts.
import { apiGet, isDenial } from '../api'
import { idbDel, idbKeys, idbRead, idbSet, readThrough, type ReadThroughSource } from '../idb'
import { buildingWhere, isBuildingInfo, type BuildingInfo } from './building'
import type { CachedWithout, Out } from './wire'

/** `einsatzobjekt` carries plans, `objekt` does not. ⚠️ No `depot` (key box) any more (owner,
 *  review round 3, 17.10.2026: every object is a building or a group of buildings): an older
 *  server's or an older cached catalogue's `depot` is read as `objekt` (`withRetiredKinds`). */
export type StationObjectKind = 'einsatzobjekt' | 'objekt'

/** One plan of an object. `id` is the reference dataset id (`plan:<object>:<module>`, opened by
 *  `/api/reference/{id}?v=`), `code` what the panel prints («1», «2/3»), `pages` those of the
 *  current revision when the server already knows them, `georef` = the revision carries a
 *  station-approved map fit. `updatedAt` is absent from an older cached catalogue. */
export type StationPlan = CachedWithout<Out<'ReferencePlanOut'>, 'updatedAt'>

/** One Geschoss of an object's floor pack — the words are the app's copy (lib/whiteboard ·
 *  floorLabel), the station's own name wins. */
export type StationFloor = Out<'ReferenceFloorOut'>

/** One station object. `address` is there wherever one is knowable (the station's, else the
 *  name when it is a street + number, else the register's at the pin – docs/karte-objekte.md);
 *  `locality` only when it is NOT the home town («Therwil»): print «address, locality».
 *  `outline` is the station's choice («Lage korrigieren» in /admin): `none` = no outline at all,
 *  not even the OSM building at the point. `footprint` is every building the object stands for
 *  as one GeoJSON MultiPolygon (backend app/object_footprints; null = the OSM building its
 *  point lies in, lib/karte/places · objectBuildings); `underground` the named row's addresses
 *  without a surface building (one MultiPolygon, drawn dashed). The optional fields are absent
 *  from an older server's or an older cached catalogue (outline absent = `auto`). */
export type StationObject = CachedWithout<Omit<Out<'ReferenceObjectOut'>, 'plans'> & { plans: StationPlan[] },
  'locality' | 'outline' | 'underground' | 'measures' | 'remarks' | 'measuresSource' | 'updatedAt'>

export type StationObjects = Omit<Out<'ReferenceObjectsOut'>, 'objects'> & { objects: StationObject[] }

export const isStationObjects = (v: unknown): v is StationObjects =>
  !!v && typeof v === 'object' && Array.isArray((v as StationObjects).objects)

const OBJECTS_CACHE = 'kp-front-station-objects'

/** The catalogue: fresh when the server answers, the device's copy when it cannot be asked.
 *  A refusal (401/403) still throws — a session that may not read the station must not be shown
 *  yesterday's copy of it. */
export async function loadStationObjects(): Promise<{ value: StationObjects; source: ReadThroughSource }> {
  const r = await readThrough<StationObjects>(OBJECTS_CACHE, () => apiGet<StationObjects>('/api/reference/objects'), {
    validate: isStationObjects,
  })
  return { ...r, value: withRetiredKinds(r.value) }
}

/** The retired `depot` kind (a key box, until review round 3) read as the plan-less `objekt` it
 *  always was. Pure; the same catalogue back when there is nothing to map. */
export function withRetiredKinds(c: StationObjects): StationObjects {
  if (!c.objects.some((o) => (o.kind as string) === 'depot')) return c
  return { ...c, objects: c.objects.map((o) => ((o.kind as string) === 'depot' ? { ...o, kind: 'objekt' as const } : o)) }
}

/** The catalogue as this device holds it — what «Auf diesem Gerät» counts. Null when none is
 *  stored or the store could not be read (never «held» on a guess). */
export async function storedStationObjects(): Promise<StationObjects | null> {
  const r = await idbRead<unknown>(OBJECTS_CACHE)
  return r.ok && isStationObjects(r.value) ? r.value : null
}

const BUILDING_PREFIX = 'kp-front-station-building:'
const BUILDING_CACHE = (where: string) => `${BUILDING_PREFIX}${where}`
/** The buildings asked for, most recent first — so the device keeps the last `BUILDING_KEEP`
 *  and not every building anyone ever tapped (one entry is ~1–2 KB, a tap costs one). */
const BUILDING_INDEX = 'kp-front-station-building-index'
export const BUILDING_KEEP = 300

/** The index after `where` was asked for again: it moves to the front, and whatever falls off
 *  the end beyond `keep` is to be deleted. Pure. */
export function noteBuildingAsked(index: readonly string[], where: string, keep = BUILDING_KEEP): { index: string[]; drop: string[] } {
  const next = [where, ...index.filter((w) => w !== where)]
  return { index: next.slice(0, keep), drop: next.slice(keep) }
}

/** Best-effort bookkeeping after a fresh answer was stored. An index that cannot be READ is left
 *  alone (AGENTS.md · a failed IndexedDB read is not a miss): writing over it would orphan
 *  every entry it named. */
let indexLane: Promise<void> = Promise.resolve()
/** one index update at a time — two quick taps must not each write the index the other read */
function rememberBuilding(where: string): Promise<void> {
  indexLane = indexLane.then(() => updateBuildingIndex(where)).catch(() => {})
  return indexLane
}
async function updateBuildingIndex(where: string): Promise<void> {
  const r = await idbRead<unknown>(BUILDING_INDEX)
  if (!r.ok) return
  const index = Array.isArray(r.value) ? r.value.filter((w): w is string => typeof w === 'string') : []
  const { index: next, drop } = noteBuildingAsked(index, where)
  if (!(await idbSet(BUILDING_INDEX, next))) return
  for (const w of drop) await idbDel(BUILDING_CACHE(w))
}

/** How many buildings' register answers this device holds (0 when the store cannot be read). */
export async function storedBuildingCount(): Promise<number> {
  const r = await idbKeys(BUILDING_PREFIX)
  return r.ok && r.value ? r.value.length : 0
}

export const stationBuildingUrl = (lat: number, lng: number, address?: string | null, lang = 'de'): string => {
  const p = new URLSearchParams({ lat: lat.toFixed(6), lng: lng.toFixed(6), lang })
  if (address?.trim()) p.set('address', address.trim())
  return `/api/reference/building?${p}`
}

/** The register hints for one point. `source` says whether the answer is fresh or the device's
 *  copy for exactly this place; null when the place was never looked at and the server cannot be
 *  asked (offline) — the panel says so instead of drawing nothing. */
export async function loadStationBuilding(lat: number, lng: number, address: string | null | undefined, lang: string): Promise<{ value: BuildingInfo; source: ReadThroughSource } | null> {
  const where = buildingWhere(address, lat, lng)
  try {
    const r = await readThrough<BuildingInfo>(BUILDING_CACHE(where), async () => ({ ...(await apiGet<BuildingInfo>(stationBuildingUrl(lat, lng, address, lang))), where }), {
      validate: isBuildingInfo,
    })
    if (r.source === 'network') void rememberBuilding(where)
    return r
  } catch {
    return null
  }
}

// --- the region's outline sets: «Unterirdische Bauten» and the houses ------------------------------

/** A region's outlines as the server stored them (backend app/underground, app/houses): one
 *  GeoJSON MultiPolygon, an outer ring per building. */
export interface OutlineSet {
  fetchedAt: string
  count: number
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] }
}
/** the underground buildings' set («Unterirdische Bauten») */
export type UndergroundSet = OutlineSet

interface OutlineAnswer {
  enabled: boolean
  fetchedAt?: string | null
  count?: number
  unchanged?: boolean
  geometry?: OutlineSet['geometry']
}

export const isOutlineSet = (v: unknown): v is OutlineSet => {
  const u = v as OutlineSet | null
  return !!u && typeof u === 'object' && typeof u.fetchedAt === 'string' && !!u.geometry
    && u.geometry.type === 'MultiPolygon' && Array.isArray(u.geometry.coordinates)
}

/**
 * A region's outline set — null when there is none: switched off on the server, not asked by the
 * scheduler yet, or offline on a device that never loaded it. Kept on the device like the catalogue
 * (IndexedDB, one entry), and asked with the set it holds (`?have=`), so an unchanged set costs one
 * small answer instead of a megabyte. A refusal (401/403) throws: a session that may not read the
 * station is not shown its copy.
 */
async function loadOutlineSet(path: string, cacheKey: string): Promise<OutlineSet | null> {
  const held = await idbRead<unknown>(cacheKey)
  const mine = held.ok && isOutlineSet(held.value) ? held.value : null
  let r: OutlineAnswer
  try {
    r = await apiGet<OutlineAnswer>(`${path}${mine ? `?have=${encodeURIComponent(mine.fetchedAt)}` : ''}`)
  } catch (e) {
    if (isDenial(e)) throw e
    return mine
  }
  if (!r || r.enabled === false) {
    if (mine) void idbDel(cacheKey) // switched off: nothing left to show offline either
    return null
  }
  if (r.unchanged && mine) return mine
  const fresh = { fetchedAt: r.fetchedAt, count: r.count ?? 0, geometry: r.geometry }
  if (!isOutlineSet(fresh)) return mine // not asked yet on the server: what the device has
  void idbSet(cacheKey, fresh)
  return fresh
}

/** The underground buildings to draw («Unterirdische Bauten», `UNDERGROUND_WFS=` = off). */
export const loadUnderground = () => loadOutlineSet('/api/reference/underground', 'kp-front-station-underground')

/** The region's houses, one cadastral footprint each — what a building tap in the Karte selects
 *  (lib/karte/outlines · useHouses; `HOUSES_WFS=` = off, the Karte then taps OSM outlines). */
export const loadHouses = () => loadOutlineSet('/api/reference/houses', 'kp-front-station-houses')

/** The set's outlines as rings (`[lng, lat]`, open — the map closes them). Pure. */
export function outlineRings(set: OutlineSet | null): [number, number][][] {
  if (!set) return []
  const out: [number, number][][] = []
  for (const poly of set.geometry.coordinates) {
    const ring = poly?.[0]
    if (!Array.isArray(ring) || ring.length < 3) continue
    const pts = ring.map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    const [a, z] = [pts[0], pts[pts.length - 1]]
    const open = a[0] === z[0] && a[1] === z[1] ? pts.slice(0, -1) : pts
    if (open.length >= 3) out.push(open)
  }
  return out
}
