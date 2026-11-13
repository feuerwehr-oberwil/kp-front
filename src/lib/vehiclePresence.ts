// What the SERVER observed about the vehicles (24.09.2026, D2 — «the server observes; devices
// never write observations»), read for display. Nothing here writes anything.
//
// The scheduler's 30 s GPS sweep (backend · app/vehicle_presence) detects «vor Ort» / «hat den
// Einsatzort verlassen» on the GPS FIX time and keeps, per station vehicle, a `gps` block on
// `reportMeta.fahrzeuge[]`: the zone it is in, its first arrival, its last departure and how
// many stays on scene it made. This module turns that into the «n Fahrten» the Rapport's
// Zeiten section and the printed Rapport carry — and picks the wind-shift rows the server
// writes (app/observations) that the Meldeleiste shows once.
//
// It replaced `useVehiclePresenceLog`, which ran the same rings on every editor device and
// stamped a transition when THAT device noticed it (the Übung of 23.09.2026: all five vehicles
// «vor Ort» at 19:43, the moment a tablet woke up; GPS said 19:23–19:28).

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { FahrzeugZeit } from './workspace'
import type { TimelineEvent } from '../types'

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
