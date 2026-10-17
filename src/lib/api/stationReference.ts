// «Karte & Objekte» — the station reference reads outside an Einsatz (backend
// app/api/station_reference.py, docs/karte-objekte.md):
//
//   GET /api/reference/objects            every station object, in one payload
//   GET /api/reference/building?lat&lng   the Gebäude card's facts for any point, no incident
//
// Both are kept on the device (lib/idb · readThrough): the catalogue as ONE entry, so the objects
// stay searchable without a network, and each building answer under the place it was asked for
// (`buildingWhere`), so an offline tap on a building already looked at still shows its register
// hints — and a building never wears another one's facts.
import { apiGet } from '../api'
import { idbDel, idbKeys, idbRead, idbSet, readThrough, type ReadThroughSource } from '../idb'
import { buildingWhere, isBuildingInfo, type BuildingInfo } from './building'

/** `einsatzobjekt` carries plans, `objekt` does not. ⚠️ No `depot` (key box) any more (owner,
 *  review round 3, 17.10.2026: every object is a building or a group of buildings): an older
 *  server's or an older cached catalogue's `depot` is read as `objekt` (`withRetiredKinds`). */
export type StationObjectKind = 'einsatzobjekt' | 'objekt'

export interface StationPlan {
  /** the reference dataset id (`plan:<object>:<module>`) — `/api/reference/{id}?v=` opens it */
  id: string
  module: string | null
  /** «1», «2/3» — what the panel prints */
  code: string
  title: string
  /** pages of the current revision when the server already knows them, else null */
  pages: number | null
  /** the current revision carries a station-approved map fit («auf der Karte ausgerichtet») */
  georef: boolean
  version: number
  updatedAt?: string | null
}

/** One Geschoss of an object's floor pack — the words are the app's copy (lib/whiteboard ·
 *  floorLabel), the station's own name wins. */
export interface StationFloor { index: number; name: string | null }

export interface StationObject {
  id: string
  name: string
  kind: StationObjectKind
  /** an address for every object where one is knowable (the station's, else the name when it is
   *  a street + number, else the register's at the pin — docs/karte-objekte.md) */
  address: string | null
  /** the town, only when it is NOT the home town («Therwil»): print «address, locality» */
  locality?: string | null
  lat: number | null
  lng: number | null
  /** the station's outline choice («Lage korrigieren» in /admin): `none` = draw no outline at all,
   *  not even the OSM building at the point; absent (an older server) = `auto` */
  outline?: 'auto' | 'building' | 'none'
  aliases: string[]
  plans: StationPlan[]
  floors: StationFloor[]
  egid: string | null
  /** every building the object stands for, as one GeoJSON MultiPolygon (the server derives it
   *  from the use area / parcel / cadastral survey — backend app/object_footprints); null = the
   *  map's own OSM building its point lies in is used (lib/karte/places · objectBuildings) */
  footprint: unknown
  /** a named row's addresses that have no surface building — the survey's underground garages
   *  and shelters (backend app/object_footprints · ask_range), one MultiPolygon; drawn dashed.
   *  Absent from an older server. */
  underground?: unknown
  measures?: string | null
  remarks?: string | null
  measuresSource?: string | null
  updatedAt?: string | null
  lastVisit: { id: string; checklist: string | null; date: string | null; defects: number } | null
}

export interface StationObjects {
  objects: StationObject[]
  generatedAt: string
}

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
