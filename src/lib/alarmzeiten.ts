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

/**
 * A readable name for a group the deployment config cannot name.
 *
 * ⚠️ The fallback used to be the raw id, and it reached PAPER: the rapport of 08.08. carried
 * «fwo-offiziere» and «fwo-gruppe6» in the Alarmierungszeiten instead of «Gr. 1 (Kdo)» and
 * «Gr. 6 (Alle)». That happens whenever the values outlive the config that names them — a
 * device holding a cached config from before a group was added, an offline first launch, an id
 * the milestone webhook wrote that the station later renamed. The times are real and must
 * print either way; what must never print is a slug, because a signed document with a database
 * key on it is one nobody can read and nobody can check.
 *
 * `shared` is the leading segment every id has in common (the station prefix, «fwo-») — it
 * carries no information once it is on all of them, so it comes off.
 */
export function humanizeGroupId(id: string, shared?: string): string {
  const rest = shared && id.startsWith(`${shared}-`) ? id.slice(shared.length + 1) : id
  const words = rest
    .replace(/[-_]+/g, ' ')
    // «gruppe6» is two words that were never spaced — the digits are the number of the thing
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return id
  return words
    // a short token with no vowel is an abbreviation, not a word: «tgp» → «TGP», «wkh» → «WKH»
    .map((w) => (w.length <= 4 && !/[aeiouäöü]/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/**
 * The leading `-` segment shared by every id, else undefined (nothing to strip).
 *
 * Deliberately strict — it must be on ALL of them, and there must be at least two. One id in
 * isolation says nothing about which of its segments is a station prefix, and stripping on a
 * sample of one would turn «zug-2» into «2». A prefix that only some ids carry is not a prefix;
 * the honest outcome there is a slightly clumsy «Fwo Pio 1», which is still a name somebody can
 * read, rather than a guess that deletes the meaningful half of one.
 */
function sharedPrefix(ids: string[]): string | undefined {
  if (ids.length < 2) return undefined
  const heads = ids.map((id) => (id.includes('-') ? id.split('-')[0] : null))
  const first = heads[0]
  return first && heads.every((h) => h === first) ? first : undefined
}

/** Grid rows in config order, values joined in; entries whose id is not in the config
 *  append at the end (unmatched — shown, never dropped, and never shown as a raw id). */
export function gruppenRows(config: AlarmGroup[], values: GruppeZeit[] | undefined) {
  const byId = new Map((values ?? []).map((g) => [g.id, g]))
  const rows = config.map((c) => ({ config: c, value: byId.get(c.id) }))
  const known = new Set(config.map((c) => c.id))
  const orphans = (values ?? []).filter((g) => !known.has(g.id))
  // the prefix is read off the WHOLE picture, config included, so a single unmatched group
  // among eight configured ones still loses the «fwo-» the other eight never showed
  const shared = sharedPrefix([...config.map((c) => c.id), ...orphans.map((g) => g.id)])
  const extra = orphans
    .map((g) => ({ config: { id: g.id, label: humanizeGroupId(g.id, shared) } as AlarmGroup, value: g }))
  return [...rows, ...extra]
}

export function fahrzeugRows(config: FleetVehicle[], values: FahrzeugZeit[] | undefined) {
  const byId = new Map((values ?? []).map((f) => [f.id, f]))
  const rows = config.map((c) => ({ config: c, value: byId.get(c.id) }))
  const known = new Set(config.map((c) => c.id))
  const orphans = (values ?? []).filter((f) => !known.has(f.id))
  // ⚠️ A vehicle id is the Traccar device name, which is usually already the call sign («tlf»),
  // so uppercasing it lands on the right word. It is NOT always: «fwo-pio-1» has to lose the
  // station prefix like a group id does, or the sheet carries a slug (see humanizeGroupId).
  const shared = sharedPrefix([...config.map((c) => c.id), ...orphans.map((f) => f.id)])
  const extra = orphans
    .map((f) => ({
      config: {
        id: f.id,
        label: f.id.includes('-') ? humanizeGroupId(f.id, shared) : f.id.toUpperCase(),
      } as FleetVehicle,
      value: f,
    }))
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

/**
 * A stamp truncated to the MINUTE, which is the only precision any of these clocks has.
 *
 * ⚠️ The Alarmierung comes off the dispatch webhook and carries seconds («22:11:37»); every
 * clock a human enters is typed as HH:MM and lands on :00. So an Ausrückzeit typed as the same
 * minute as the alarm — which happens, and is correct: the Ausrücken of the crew already at the
 * Magazin — parsed as 37 seconds BEFORE it, and the form warned «Liegt vor der Alarmierung» on
 * a perfectly good entry (08.08. Einsatz). Only a stamp that is fully an earlier MINUTE is
 * genuinely out of order; equal minutes are simultaneous, and simultaneous is possible.
 */
const minuteMs = (iso?: string | null): number | null => {
  const t = ms(iso)
  return t == null ? null : Math.floor(t / 60_000)
}

const ms = (iso?: string | null): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export function zeitIssues(
  stamps: { alarmiertAt?: string | null; ausgeruecktAt?: string | null; endedAt?: string | null },
  now: number,
): ZeitIssue[] {
  // ORDER is judged to the minute (see minuteMs); the future check keeps the full stamp,
  // because that one is measured against a live clock and not against a typed one.
  const alarm = minuteMs(stamps.alarmiertAt)
  const aus = minuteMs(stamps.ausgeruecktAt)
  const ende = minuteMs(stamps.endedAt)
  // …the FUTURE check keeps full precision: it is measured against the tablet's live clock,
  // not against another typed stamp, so there is no rounding mismatch to absorb.
  const ausAbs = ms(stamps.ausgeruecktAt)
  const endeAbs = ms(stamps.endedAt)
  const out: ZeitIssue[] = []

  if (aus != null) {
    if (alarm != null && aus < alarm) out.push({ kind: 'ausgerueckt', code: 'beforeAlarm', ref: stamps.alarmiertAt! })
    if (ausAbs != null && ausAbs > now + FUTURE_SLACK_MS) out.push({ kind: 'ausgerueckt', code: 'future' })
  }
  if (ende != null) {
    // Only ONE ordering warning per stamp, the most specific first: an Ende before the
    // Ausrücken is almost always also before the alarm, and saying both says nothing twice.
    if (aus != null && ende < aus) out.push({ kind: 'ende', code: 'beforeAusgerueckt', ref: stamps.ausgeruecktAt! })
    else if (alarm != null && ende < alarm) out.push({ kind: 'ende', code: 'beforeAlarm', ref: stamps.alarmiertAt! })
    if (endeAbs != null && endeAbs > now + FUTURE_SLACK_MS) out.push({ kind: 'ende', code: 'future' })
  }
  return out
}
