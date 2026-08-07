// Alarmierungs-/Ausrückzeiten grid logic (pure, node-testable). The grid rows come from
// deployment config (alarms.groups / fleet.vehicles — empty config hides the grid); the
// values live in reportMeta.gruppen/fahrzeuge, prefilled by the milestone webhook and
// editable in the rapport form. Operator edits stamp `manual: true` so the webhook never
// overwrites a human decision (prefilled ≠ locked, but human beats machine).

import { applyTimeToIso, isoOnDay } from './abschluss'
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

/**
 * A bare 'HH:MM' typed into one of the incident's own clocks, put on the right calendar day.
 *
 * The grid asks for a clock and nothing else, so the day has to be inferred — and the only
 * sensible anchor is the ALARM, not the day the rapport is being written. An Einsatz alarmed at
 * 23:50 has Ausrückzeiten of 00:15, and stamping that onto the alarm's own day put it 23h35
 * BEFORE the alarm: `zeitIssues` then warned `beforeAlarm` on a perfectly correct entry, and the
 * printed rapport carried the wrong date. Rolling forward past midnight is the same rule the
 * Rückmeldung ELZ field already used.
 *
 * `day` is the escape for everything a single roll cannot reach (day three of an
 * Elementarereignis): it comes back from the picker's day wheel only when the incident spans more
 * than one day and the operator moved it — then the day is known and nothing is inferred at all.
 *
 * Empty `hhmm` → null, which the setters below read as «remove the entry» (an accidental tap
 * stays fully clearable).
 */
export function zeitFromClock(alarmIso: string, hhmm: string, day?: Date): string | null {
  if (!hhmm) return null
  return day ? isoOnDay(day, hhmm) : applyTimeToIso(alarmIso, hhmm, { nextDayIfBefore: alarmIso })
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


/**
 * Plausibility of the incident's own clocks — a WARNING, never a block.
 *
 * The three stamps have one true order: alarmiert → ausgerückt → Ende. A rapport is written
 * hours later, from memory and off a wall clock, and a mistyped year («04.06.2025») or a
 * transposed pair reads as perfectly normal in a field that shows one line. The check says so
 * and stops there: printing must never be blocked by what somebody typed, an Einsatz over
 * midnight is legitimate, and a correction made at 3am is worth more than a form that refuses
 * it. `now` is injected so this stays pure.
 */
export type ZeitKind = 'ausgerueckt' | 'ende'

export interface ZeitIssue {
  /** which stamp the warning hangs off */
  kind: ZeitKind
  /** what is wrong — the caller maps it to copy */
  code: 'beforeAlarm' | 'beforeAusgerueckt' | 'future'
  /** the stamp it contradicts (ISO), for «liegt vor dem Ausrücken (06.08.2026 11:00)» */
  ref?: string
}

/** A clock may sit this far ahead of now without being called out — the tablet's own clock
 *  drifts, and «jetzt» stamped a second ago must never warn about itself. */
const FUTURE_SLACK_MS = 5 * 60 * 1000

const ms = (iso?: string | null): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export function zeitIssues(
  stamps: { alarmiertAt?: string | null; ausgeruecktAt?: string | null; endedAt?: string | null },
  now: number,
): ZeitIssue[] {
  const alarm = ms(stamps.alarmiertAt)
  const aus = ms(stamps.ausgeruecktAt)
  const ende = ms(stamps.endedAt)
  const out: ZeitIssue[] = []

  if (aus != null) {
    if (alarm != null && aus < alarm) out.push({ kind: 'ausgerueckt', code: 'beforeAlarm', ref: stamps.alarmiertAt! })
    if (aus > now + FUTURE_SLACK_MS) out.push({ kind: 'ausgerueckt', code: 'future' })
  }
  if (ende != null) {
    // Only ONE ordering warning per stamp, the most specific first: an Ende before the
    // Ausrücken is almost always also before the alarm, and saying both says nothing twice.
    if (aus != null && ende < aus) out.push({ kind: 'ende', code: 'beforeAusgerueckt', ref: stamps.ausgeruecktAt! })
    else if (alarm != null && ende < alarm) out.push({ kind: 'ende', code: 'beforeAlarm', ref: stamps.alarmiertAt! })
    if (ende > now + FUTURE_SLACK_MS) out.push({ kind: 'ende', code: 'future' })
  }
  return out
}
