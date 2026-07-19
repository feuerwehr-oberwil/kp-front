// Alarmierungs-/Ausrückzeiten grid logic (pure, node-testable). The grid rows come from
// deployment config (alarms.groups / fleet.vehicles — empty config hides the grid); the
// values live in reportMeta.gruppen/fahrzeuge, prefilled by the milestone webhook and
// editable in the rapport form. Operator edits stamp `manual: true` so the webhook never
// overwrites a human decision (prefilled ≠ locked, but human beats machine).

import type { FahrzeugZeit, GruppeZeit } from './workspace'
import type { AlarmGroup, FleetVehicle } from './deploymentConfig'

/** Header «Ausgerückt» is DERIVED once any per-vehicle Ausrückzeit exists: the first
 *  physical departure = min of the vehicle times. Null → no vehicle data, the manual
 *  reportMeta.ausgeruecktAt field stays authoritative (analog / no-GPS case). */
export function deriveAusgerueckt(fahrzeuge: FahrzeugZeit[] | undefined): string | null {
  const times = (fahrzeuge ?? []).map((f) => f.ausgerueckt).filter((t): t is string => !!t)
  if (times.length === 0) return null
  return times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
}

/** Upsert an operator-entered group alarm time (stamps `manual`); empty iso removes the
 *  entry entirely so an accidental tap is fully undoable by clearing the field. */
export function setGruppeZeit(list: GruppeZeit[] | undefined, id: string, iso: string | null): GruppeZeit[] {
  const rest = (list ?? []).filter((g) => g.id !== id)
  return iso ? [...rest, { id, alarmedAt: iso, manual: true }] : rest
}

/** Upsert an operator-entered vehicle time (stamps `manual`). Clearing the last field
 *  drops the row; other fields on the row survive a single-field edit. */
export function setFahrzeugZeit(
  list: FahrzeugZeit[] | undefined, id: string,
  field: 'ausgerueckt' | 'vorOrt' | 'zurueck', iso: string | null,
): FahrzeugZeit[] {
  const cur = (list ?? []).find((f) => f.id === id)
  const next: FahrzeugZeit = { ...(cur ?? { id }), manual: true }
  if (iso) next[field] = iso
  else delete next[field]
  const rest = (list ?? []).filter((f) => f.id !== id)
  const hasValue = next.ausgerueckt || next.vorOrt || next.zurueck
  return hasValue ? [...rest, next] : rest
}

/** Grid rows in config order, values joined in; entries whose id is not in the config
 *  append at the end (unmatched — shown, never dropped). */
export function gruppenRows(config: AlarmGroup[], values: GruppeZeit[] | undefined) {
  const byId = new Map((values ?? []).map((g) => [g.id, g]))
  const rows = config.map((c) => ({ config: c, value: byId.get(c.id) }))
  const known = new Set(config.map((c) => c.id))
  const extra = (values ?? []).filter((g) => !known.has(g.id))
    .map((g) => ({ config: { id: g.id, label: g.id } as AlarmGroup, value: g }))
  return [...rows, ...extra]
}

export function fahrzeugRows(config: FleetVehicle[], values: FahrzeugZeit[] | undefined) {
  const byId = new Map((values ?? []).map((f) => [f.id, f]))
  const rows = config.map((c) => ({ config: c, value: byId.get(c.id) }))
  const known = new Set(config.map((c) => c.id))
  const extra = (values ?? []).filter((f) => !known.has(f.id))
    .map((f) => ({ config: { id: f.id, label: f.id.toUpperCase() } as FleetVehicle, value: f }))
  return [...rows, ...extra]
}

/** Tagespikett flag: derived — true when a config group marked `tagespikett` was alarmed. */
export function tagespikettAlarmed(config: AlarmGroup[], values: GruppeZeit[] | undefined): boolean {
  const tgp = new Set(config.filter((g) => g.tagespikett).map((g) => g.id))
  return (values ?? []).some((g) => tgp.has(g.id) && !!g.alarmedAt)
}
