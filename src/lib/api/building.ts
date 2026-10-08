// The Gebäude card of an Einsatz (`GET /api/incidents/{id}/building`, backend/app/api/building.py):
// register hints (GWR, BFE) + the Einsatzobjekt's own Modul-1 notes + its last Objektbesuch.
//
// Cached per Einsatz in IndexedDB (readThrough), so the card is there offline — and merged per
// SOURCE: a fresh answer in which the GWR could not be asked keeps the GWR half of the last good
// one instead of wiping it. Each half fails on its own, on the device as on the server.
import { apiGet } from '../api'
import { idbGet, readThrough } from '../idb'

export type BuildingRegisters = 'on' | 'off' | 'outside_ch' | 'no_location'

export interface BuildingGwr {
  /** the register's export date for this entry (ISO date) */
  stand: string | null
  floors: number | null
  flats: number | null
  year: number | null
  period: string | null
  /** energy keys — gas, oil, wood, district, air, geothermal, water, electricity, solar, waste_heat, unknown, other */
  heating: string[]
  heating_date: string | null
  hot_water: string[]
  shelter: boolean | null
  status: string | null
}

export interface BuildingPlant {
  kind: 'pv' | 'other'
  label: string | null
  power_kw: number | null
  since: string | null
}

export interface BuildingObject {
  id: string
  name: string
  address_match: boolean
  distance_m: number | null
  measures: string | null
  remarks: string | null
  measures_source: string | null
  updated_at: string | null
}

export interface BuildingInfo {
  registers: BuildingRegisters
  egid: string | null
  address: string | null
  gwr: BuildingGwr | null
  gwr_status: 'ok' | 'none' | 'error' | 'skipped'
  plants: BuildingPlant[]
  pv_status: 'ok' | 'error' | 'skipped'
  registers_fetched_at: string | null
  object: BuildingObject | null
  visit: { id: string; visited_at: string | null; findings: number } | null
  /** device-side only: the register half was kept from an earlier answer (the source failed now) */
  gwr_kept_from?: string | null
  pv_kept_from?: string | null
}

export const isBuildingInfo = (v: unknown): v is BuildingInfo =>
  !!v && typeof v === 'object' && typeof (v as BuildingInfo).registers === 'string' && Array.isArray((v as BuildingInfo).plants)

/**
 * A fresh answer, with every source that FAILED this time filled from the last good answer.
 *
 * Only for the same building (EGID) or when the fresh one could not even find out which building
 * (GWR down → no EGID). Never across buildings: an Einsatz whose address was corrected must not
 * carry the old building's gas heating along.
 */
export function mergeBuilding(fresh: BuildingInfo, last: BuildingInfo | null | undefined): BuildingInfo {
  if (!last || fresh.registers !== 'on') return fresh
  const out: BuildingInfo = { ...fresh }
  const sameBuilding = !fresh.egid || fresh.egid === last.egid
  if (fresh.gwr_status === 'error' && last.gwr_status === 'ok' && last.gwr) {
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
export async function buildingResilient(incidentId: string, objectId?: string | null, lang = 'de'): Promise<BuildingInfo | null> {
  const key = BUILDING_CACHE(incidentId)
  try {
    const { value } = await readThrough<BuildingInfo | null>(key, async () => {
      const fresh = await getBuilding(incidentId, objectId, lang)
      const last = await idbGet<unknown>(key).catch(() => null)
      return mergeBuilding(fresh, isBuildingInfo(last) ? last : null)
    }, {
      validate: (v): v is BuildingInfo | null => isBuildingInfo(v),
      fallback: () => null,
    })
    return value
  } catch {
    // the server ANSWERED no (401/403/404/500): not silence, so not the cache's to answer
    return null
  }
}
