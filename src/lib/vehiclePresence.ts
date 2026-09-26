// What the SERVER observed about the vehicles (24.09.2026, D2 — «the server observes; devices
// never write observations»), read for display. Nothing here writes anything.
//
// The scheduler's 30 s GPS sweep (backend · app/vehicle_presence) detects «vor Ort» / «hat den
// Einsatzort verlassen» on the GPS FIX time and keeps, per station vehicle, a `gps` block on
// `reportMeta.fahrzeuge[]`: the zone it is in, its first arrival, its last departure and how
// many stays on scene it made. This module turns that into the rows of the «Fahrzeuge GPS ·
// live» table in the Rapport, and into the «n Fahrten» the printed Rapport carries — and picks
// the wind-shift rows the server writes (app/observations) that the Meldeleiste shows once.
//
// It replaced `useVehiclePresenceLog`, which ran the same rings on every editor device and
// stamped a transition when THAT device noticed it (the Übung of 23.09.2026: all five vehicles
// «vor Ort» at 19:43, the moment a tablet woke up; GPS said 19:23–19:28).

import { appConfig } from '../config/appConfig'
import { fahrzeugRows } from './alarmzeiten'
import { fillTemplate } from './format'
import type { FleetVehicle } from './deploymentConfig'
import type { FahrzeugZeit } from './workspace'
import type { TimelineEvent } from '../types'

/** One line of the table. `fixAgeMs` is null when the feed has no fix for this tracker. */
export interface VehicleTableRow {
  id: string
  label: string
  zone: 'scene' | 'away'
  an?: string
  ab?: string
  fahrten: number
  fixAgeMs: number | null
}

/**
 * The table's rows: every station vehicle the server has observed (a row with a `gps` block),
 * in the Fahrzeugzeiten grid's order, with the age of its tracker's latest fix beside it.
 *
 * `fixes` is keyed by Traccar device id → ISO report time (Traccar `deviceTime`), read straight off the positions feed —
 * NOT off the map's vehicle entities, whose change signature deliberately ignores a fix that did
 * not move the truck (a parked vehicle would otherwise re-render the whole map every 15 s), so
 * their age would read «stale» for a tracker that is reporting perfectly well.
 */
export function vehicleTableRows(
  fleet: FleetVehicle[],
  fahrzeuge: FahrzeugZeit[] | undefined,
  fixes: ReadonlyMap<number, string>,
  nowMs: number,
): VehicleTableRow[] {
  return fahrzeugRows(fleet, fahrzeuge).flatMap(({ config, value }) => {
    const gps = value?.gps
    if (!gps || (gps.zone !== 'scene' && gps.zone !== 'away')) return []
    const fix = gps.device != null ? fixes.get(gps.device) : undefined
    const fixMs = fix ? Date.parse(fix) : Number.NaN
    return [{
      id: config.id,
      label: config.label,
      zone: gps.zone,
      an: gps.an,
      ab: gps.ab,
      fahrten: gps.fahrten ?? 0,
      fixAgeMs: Number.isFinite(fixMs) ? Math.max(0, nowMs - fixMs) : null,
    }]
  })
}

/** A fix older than this is shown as stale (amber) — the vehicle is still drawn where it was
 *  last seen, and the table is where that is said out loud. Five missed Traccar reports. */
export const FIX_STALE_MS = 5 * 60_000

/** «vor 12 s» · «vor 3 min» · «vor 2 h». */
export function fixAgeText(ms: number): string {
  const P = appConfig.copy.preflight
  const s = Math.floor(ms / 1000)
  if (s < 60) return fillTemplate(P.gpsAgeSec, { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return fillTemplate(P.gpsAgeMin, { n: m })
  return fillTemplate(P.gpsAgeHour, { n: Math.floor(m / 60) })
}

/** «3 Fahrten» where a vehicle made more than one stay on scene — the shuttle the Verlauf
 *  deliberately does not list (D2-a) — else nothing. Screen and paper say the same words. */
export function fahrtenText(v: FahrzeugZeit | undefined): string {
  const n = v?.gps?.fahrten ?? 0
  return n > 1 ? fillTemplate(appConfig.copy.preflight.fahrtenCount, { n }) : ''
}

// --- the wind shift ------------------------------------------------------------------------

/** The prefix of the Verlauf row the server writes for a wind shift (backend · observations ·
 *  SHIFT_ROW_PREFIX). The id is derived from the confirming observation, so every device sees
 *  the same one. */
export const WIND_SHIFT_ROW_PREFIX = 'wxd-'

/** How long after the shift ARRIVED the Meldeleiste still shows it. A device opened an hour later
 *  reads it in the Verlauf; a banner for an hour-old fact would be noise, not news. */
export const WIND_SHIFT_FRESH_MS = 30 * 60_000

/** When the row ARRIVED: the server stamps `writtenAt` on its wind-shift rows. `at` is the
 *  reading's own time, which is often 20–30 min old by then (the provider's publishing lag plus
 *  the 10-min observation cadence) — timed from `at`, the notice was gone before it came. A row
 *  without the stamp falls back to `at`. */
const arrivedAt = (r: TimelineEvent): number => Date.parse(r.writtenAt ?? r.at ?? '')

/**
 * The wind-shift row the Meldeleiste should show NOW, if any: the newest one, still fresh, not
 * yet waved away on this device. Title and sub are the row's own words split at its last « · »
 * («Wind dreht: W → NO (286° → 66°)» · «Lüfter prüfen»), so strip and Verlauf say one thing.
 */
export function freshWindShift(
  rows: readonly TimelineEvent[],
  nowMs: number,
  dismissed: ReadonlySet<string>,
): { id: string; title: string; sub?: string } | null {
  let best: TimelineEvent | null = null
  for (const r of rows) {
    if (!r.id.startsWith(WIND_SHIFT_ROW_PREFIX) || dismissed.has(r.id)) continue
    const at = arrivedAt(r)
    if (!Number.isFinite(at) || nowMs - at > WIND_SHIFT_FRESH_MS || at - nowMs > WIND_SHIFT_FRESH_MS) continue
    if (!best || at > arrivedAt(best)) best = r
  }
  if (!best) return null
  const cut = best.text.lastIndexOf(' · ')
  return cut > 0
    ? { id: best.id, title: best.text.slice(0, cut), sub: best.text.slice(cut + 3) }
    : { id: best.id, title: best.text }
}
