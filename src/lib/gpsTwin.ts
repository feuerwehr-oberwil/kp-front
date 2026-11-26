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
 * this only speaks while the placed one is open. Once the operator said «Sind zwei» for this
 * symbol (`gpsTwinOk`, owner sign-off note, 25.11.2026) it does not ask again – until the symbol
 * is renamed (`relabel`).
 * `entities` is the Karte's list, live vehicles included (IncidentWorkspace · entities).
 */
export function gpsTwin(placed: Entity, entities: readonly Entity[]): { vehicle: Entity; distM: number } | null {
  const name = norm(placed.label)
  if (!name || placed.live || placed.gpsTwinOk) return null
  let best: { vehicle: Entity; distM: number } | null = null
  for (const e of entities) {
    if (!e.live || e.kind !== 'vehicle' || norm(e.label) !== name) continue
    const distM = haversineM(placed.coord, e.coord)
    if (distM < GPS_TWIN_M && (!best || distM < best.distM)) best = { vehicle: e, distM }
  }
  return best
}

/**
 * A symbol with a new Bezeichnung – every write of a typed title goes through here (the sheet's
 * title live and on commit, IncidentWorkspace · patchEntity). A RENAME takes back «Sind zwei»
 * (owner pick, morning round 26.11.2026): the operator said that about THIS name beside THAT GPS
 * vehicle, so a «TLF» renamed to «MTF» beside the GPS MTF is checked again. The same name (case
 * and spaces ignored, as gpsTwin compares) keeps it. Clearing it with the rename puts it in the
 * rename's own undo step, so ↶ brings both back.
 */
export function relabel<E extends Entity>(e: E, label: string): E {
  return e.gpsTwinOk && norm(label) !== norm(e.label) ? { ...e, label, gpsTwinOk: undefined } : { ...e, label }
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase()
