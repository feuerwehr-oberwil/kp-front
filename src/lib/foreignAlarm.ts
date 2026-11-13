// What this device does with ANOTHER Einsatz's Atemschutz alarm (FLOW.1, 13.11.2026) — pure.
//
// The alarm host and the Meldeleiste rows are fed by the workspace on screen, so an overdue Trupp
// in Einsatz A vanished the moment this device stood in Einsatz B. The incident list now carries
// each running Einsatz's Trupps at the alarm tier (`IncidentMeta.atemschutz_due`, the server's
// push computation, refreshed by the 30 s watch). What that may do here is the owner's rule:
//
//  · every other running Einsatz with such a Trupp gets a red mark on its row in the Einsatz list
//    (AppMenuRows) — and that is ALL, while this device works a live Ernstfall of its own: two
//    real Einsätze in parallel are run by two teams, and one must not be distracted by the other.
//  · a device NOT working a live Ernstfall (it stands in an Übung, or in a closed Einsatz) gets
//    the full alarm for a live Ernstfall's Trupps: the red row with the Einsatz's name in front,
//    and the tone (AtemschutzAlarmMeldung · ForeignAtemschutzMeldungen).
//  · an Übung's Trupps never do more than the mark, on any device.
//
// ⚠️ Not on the Atemschutz-Link: it is bound to one Einsatz and its list is not polled.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { isIncidentRunning, type IncidentMeta } from './incidents'

export type ForeignDue = NonNullable<IncidentMeta['atemschutz_due']>[number]

/** The switcher row's red mark: its word (a Notfall says so, everything else is «Alarm») and the
 *  names behind it for the row's title. Null when the Einsatz has nothing at the alarm tier. */
export function foreignMark(i: IncidentMeta): { word: string; names: string } | null {
  const due = isIncidentRunning(i) ? i.atemschutz_due ?? [] : []
  if (!due.length) return null
  const c = appConfig.copy.atemschutz.foreign
  return {
    word: due.some((t) => t.reason === 'notfall') ? c.markNotfall : c.mark,
    names: fillTemplate(c.markTitle, { names: due.map((t) => t.name).join(' · ') }),
  }
}

/** Is this device working a live Ernstfall — the Einsatz on screen is real and still running? */
export function worksLiveErnstfall(here: IncidentMeta | null | undefined): boolean {
  return !!here && !here.is_exercise && isIncidentRunning(here)
}

/** The other Einsätze whose alarm this device raises in full: none while it works a live
 *  Ernstfall itself, and never an Übung's. Newest first, like the list. */
export function loudForeignAlarms(incidents: readonly IncidentMeta[], here: IncidentMeta | null | undefined): IncidentMeta[] {
  if (worksLiveErnstfall(here)) return []
  const seen = new Set<string>()
  return incidents
    .filter((i) => {
      if (seen.has(i.id)) return false
      seen.add(i.id)
      return i.id !== here?.id && !i.is_exercise && isIncidentRunning(i) && !!i.atemschutz_due?.length
    })
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
}

/** The Karte home's red alarm chip (M1, owner's pick A, 13.11.2026): the newest live Ernstfall
 *  with Trupps at the alarm tier, its most urgent reason (Notfall › überfällig › Alarmdruck) and
 *  the Trupp to land on. The chip only SHOWS it – no tone, no Meldeleiste row on the home; an
 *  Übung's Trupps keep to their mark in the list. Null when no live Ernstfall has one. */
export function homeAlarm(running: readonly IncidentMeta[]): { incident: IncidentMeta; reason: ForeignDue['reason']; due: ForeignDue[] } | null {
  const [incident] = loudForeignAlarms(running, null)
  if (!incident) return null
  const due = incident.atemschutz_due ?? []
  const reason = (['notfall', 'contact', 'pressure'] as const).find((r) => due.some((t) => t.reason === r)) ?? 'contact'
  return { incident, reason, due: [...due.filter((t) => t.reason === reason), ...due.filter((t) => t.reason !== reason)] }
}
