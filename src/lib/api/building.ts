// The Gebäude card of an Einsatz (`GET /api/incidents/{id}/building`, backend/app/api/building.py):
// register hints (GWR, BFE) + the Einsatzobjekt's own Modul-1 notes + its last Objektbesuch.
//
// Cached per Einsatz in IndexedDB (readThrough), so the card is there offline — and merged per
// SOURCE: a fresh answer in which the GWR could not be asked keeps the GWR half of the last good
// one instead of wiping it. Each half fails on its own, on the device as on the server.
import { apiGet } from '../api'
import { idbGet, readThrough } from '../idb'
import type { CachedWithout, Out } from './wire'

/** One heating or hot-water system. `generator`: heat_pump, solar_thermal, boiler, stove, chp,
 *  electric_storage, electric_direct, heat_exchanger, electric_boiler; `energy` as in
 *  `BuildingGwr.heating`; `shared`: serves several buildings (the generator may stand in another). */
export type BuildingSystem = Out<'BuildingSystemOut'>

/** The GWR half. `stand` is the register's export date (ISO date); `heating`/`hot_water` are
 *  energy keys (gas, oil, wood, district, air, geothermal, water, electricity, solar, waste_heat,
 *  unknown, other); `building_class` a Gebäudeklasse key (single_family, multi_family, home,
 *  school, hospital, …); `flats_by_floor` the existing flats whose entrance is on each storey
 *  (0 = Parterre, 1 = 1. Stock, -1 = 1. UG), lowest storey first, empty when not every flat names
 *  its storey. The six fields added 20.10.2026 are optional: a card cached before has none. */
export type BuildingGwr = CachedWithout<Out<'BuildingGwrOut'>,
  'building_class' | 'heaters' | 'water_heaters' | 'flats_by_floor' | 'rooms_min' | 'rooms_max'>

export type BuildingInfo = Omit<Out<'BuildingOut'>, 'gwr'> & {
  gwr: BuildingGwr | null
  /** device-side only: WHERE this answer was asked for (`buildingWhere`) — a cached copy or a
   *  kept half is only ever reused for the same Einsatzort */
  where?: string
  /** device-side only: the register half was kept from an earlier answer (the source failed now) */
  gwr_kept_from?: string | null
  pv_kept_from?: string | null
}

export const isBuildingInfo = (v: unknown): v is BuildingInfo =>
  !!v && typeof v === 'object' && typeof (v as BuildingInfo).registers === 'string' && Array.isArray((v as BuildingInfo).plants)

/** The Einsatzort a card answers for: address + point (5 decimals ≈ 1 m). The cache and the
 *  per-source merge are keyed on it, so a corrected address never wears the old building's facts. */
export function buildingWhere(address: string | null | undefined, lat: number | null | undefined, lng: number | null | undefined): string {
  const a = (address ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
  const p = (n: number | null | undefined) => (n == null ? '' : n.toFixed(5))
  return `${a}|${p(lat)}|${p(lng)}`
}

/**
 * A fresh answer, with every source that FAILED this time filled from the last good answer.
 *
 * Only for the SAME building: the GWR half (and the PV that hangs off its EGID) only when the
 * last answer was asked for the same Einsatzort (`where`) — a GWR outage leaves no EGID to compare,
 * so the place is the only proof — and the PV half alone only for the same EGID. Never across
 * buildings: an Einsatz whose address was corrected must not carry the old building's gas heating.
 */
export function mergeBuilding(fresh: BuildingInfo, last: BuildingInfo | null | undefined): BuildingInfo {
  if (!last || fresh.registers !== 'on') return fresh
  const out: BuildingInfo = { ...fresh }
  const samePlace = fresh.where != null && fresh.where === last.where
  const sameBuilding = !!fresh.egid && fresh.egid === last.egid
  if (fresh.gwr_status === 'error' && samePlace && last.gwr_status === 'ok' && last.gwr) {
    out.gwr = last.gwr
    out.gwr_status = 'ok'
    out.egid = last.egid
    out.address = last.address
    out.gwr_kept_from = last.gwr_kept_from ?? last.registers_fetched_at
    // the PV join hangs off the EGID, so a GWR outage skipped it — the last one stands too
    if (fresh.pv_status !== 'ok' && last.pv_status === 'ok') {
      out.plants = last.plants
      out.pv_status = 'ok'
      out.pv_kept_from = last.pv_kept_from ?? last.registers_fetched_at
    }
    return out
  }
  if (sameBuilding && fresh.pv_status === 'error' && last.pv_status === 'ok') {
    out.plants = last.plants
    out.pv_status = 'ok'
    out.pv_kept_from = last.pv_kept_from ?? last.registers_fetched_at
  }
  return out
}

const BUILDING_CACHE = (incidentId: string) => `kp-front-building-${incidentId}`

export const getBuilding = (incidentId: string, objectId?: string | null, lang = 'de') => {
  const p = new URLSearchParams({ lang })
  if (objectId) p.set('object', objectId)
  return apiGet<BuildingInfo>(`/api/incidents/${encodeURIComponent(incidentId)}/building?${p}`)
}

/** The card for one Einsatz: fresh when the server answers, the last copy when it cannot be
 *  asked, null when there never was one. Never throws — the card is a hint, not a gate. */
export async function buildingResilient(incidentId: string, objectId: string | null | undefined, lang: string, where: string): Promise<BuildingInfo | null> {
  const key = BUILDING_CACHE(incidentId)
  try {
    const { value } = await readThrough<BuildingInfo | null>(key, async () => {
      const fresh = { ...(await getBuilding(incidentId, objectId, lang)), where }
      const last = await idbGet<unknown>(key).catch(() => null)
      return mergeBuilding(fresh, isBuildingInfo(last) ? last : null)
    }, {
      // the stored copy counts only for the Einsatzort it was asked for: offline after an
      // address correction there is no card rather than the previous building's
      validate: (v): v is BuildingInfo | null => isBuildingInfo(v) && v.where === where,
      fallback: () => null,
    })
    return value
  } catch {
    // the server ANSWERED no (401/403/404/500): not silence, so not the cache's to answer
    return null
  }
}
