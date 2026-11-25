import type { Entity } from '../types'
import { haversineM } from './geo'

/** How near a live vehicle of the same name must stand for a placed one to read as its double. */
export const GPS_TWIN_M = 150

/**
 * The live GPS vehicle a hand-placed Fahrzeug doubles (owner picks UX journeys B3·33/34,
 * 25.11.2026): a walker named a placed symbol «TLF» beside the GPS TLF, and three of four could
 * not tell one truck from two. Same name (case and spaces ignored) and less than GPS_TWIN_M
 * apart → that vehicle, the nearest one if there are several. The sheet then offers to hold the
 * GPS vehicle at the symbol's spot instead (useMapActions · holdGpsInstead) – «Festhalten» is
 * THE one vehicle behaviour (copy · editors · pinGps). Doubles in old Einsätze are left alone:
 * this only speaks while the placed one is open.
 * `entities` is the Karte's list, live vehicles included (IncidentWorkspace · entities).
 */
export function gpsTwin(placed: Entity, entities: readonly Entity[]): { vehicle: Entity; distM: number } | null {
  const name = norm(placed.label)
  if (!name || placed.live) return null
  let best: { vehicle: Entity; distM: number } | null = null
  for (const e of entities) {
    if (!e.live || e.kind !== 'vehicle' || norm(e.label) !== name) continue
    const distM = haversineM(placed.coord, e.coord)
    if (distM < GPS_TWIN_M && (!best || distM < best.distM)) best = { vehicle: e, distM }
  }
  return best
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase()
