// Atemschutzüberwachung (SCBA breathing-apparatus monitoring) — the pure contact-timer math.
//
// Doctrine: Swiss FKS/CSSP. The Atemschutzüberwacher's job is to track the time since the
// Trupp's last contact (Funkkontakt) and raise the alarm when it runs past the interval —
// NOT to predict air consumption. Air is the wearer's own responsibility, so nothing here
// PREDICTS it: the expected-pressure Schätzung stays a Planungshilfe and never alarms.
// The one measured pressure that does is the Alarmdruck (10.08.): a Trupp at or below its
// turn-back line has to turn round NOW, exactly like one out of contact, so it is tier 2 —
// see `truppAlarm`, the one place the tier is decided for tone, chip, card, row and sort.
//
// This module is framework-free so the clock/threshold logic is unit-testable in isolation.
// The view layer (AtemschutzView) feeds it a Trupp + the current wall-clock time and renders
// the derived live numbers + the contact-clock alarm tier.

import type { Trupp, TruppKind, TruppReading } from '../types'
import { pad2 } from './format'

/**
 * Is this Trupp under Atemschutz — i.e. does anything in this module apply to it at all?
 *
 * ⚠️ THE one place the discriminator is resolved. `Trupp.kind` is absent on every Trupp recorded
 * before 03.09. and absent means `atemschutz` (see types · TruppKind), so a raw `t.kind ===
 * 'atemschutz'` test would silently drop every historical crew out of the monitoring. Read it
 * through here and that mistake is unavailable.
 */
export function isAtemschutzTrupp(t: { kind?: TruppKind }): boolean {
  return (t.kind ?? 'atemschutz') === 'atemschutz'
}

export interface TruppLive {
  /** seconds under PA: entryTime → exitTime, or → now while still in. A Trupp that is out has
   *  FINISHED its Einsatzzeit — letting the number keep running past the exit made a crew that
   *  had been standing at the vehicle for half an hour read as a 40-minute deployment, both on
   *  the card and on anything that quotes it. */
  elapsedSec: number
  /** seconds since the Trupp came out (exitTime → now); null while it is still in. The break
   *  clock: how long this crew has been resting / re-equipping before it can go back in. */
  outSec: number | null
  /** seconds since the last contact; null while not in the field (angemeldet / raus) — and always
   *  null for a Trupp that is not under PA, which has no contact clock at all (see below) */
  sinceContactSec: number | null
  /** the current pressure to display (last logged, or entry pressure until the first reading) */
  currentBar: number
  /** lowest pressure seen so far (bar) — the record's worst case */
  lowestBar: number
  /** true once the contact clock has run past the interval */
  overdue: boolean
  /** derived status: raus / angemeldet are explicit; ueberfaellig overlays an overdue contact */
  status: Trupp['status']
}

const SEC = 1000

/** Parse an ISO timestamp to epoch ms; returns NaN-safe 0 on bad/empty input. */
function ms(iso?: string): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Derive the live monitoring numbers for one Trupp at wall-clock time `now` (epoch ms).
 *
 * The contact clock runs only while the Trupp is in the field (aktiv / rueckzug). Contact is
 * *fällig* at `contactIntervalMin`; once the extra `contactGraceSec` passes too, the Trupp is
 * overdue and its status overlays to `ueberfaellig` (which beats a manual Rückzug, so the
 * louder state wins).
 */
export function deriveTruppLive(
  t: Trupp, now: number, contactIntervalMin: number, contactGraceSec: number,
): TruppLive {
  const entry = ms(t.entryTime)
  const exit = ms(t.exitTime)
  // the Einsatzzeit stops at the exit — a Trupp that is out is no longer accumulating time
  const elapsedSec = entry ? Math.max(0, Math.round(((exit || now) - entry) / SEC)) : 0
  const outSec = exit ? Math.max(0, Math.round((now - exit) / SEC)) : null
  const currentBar = t.lastPressureBar ?? t.entryPressureBar
  const lowestBar = t.lowestBar ?? currentBar

  // "in the field" = entered and not yet out — robust to any non-terminal status (incl. legacy
  // data), so the contact clock is never silently dead for a Trupp that is actually inside.
  //
  // ⚠️ …and only for a Trupp under PA. A plain work squad (types · TruppKind `einfach`) has no
  // cylinder and no Funkkontakt-Intervall, so it has no contact clock — and `sinceContactSec ===
  // null` is what the whole alarm path already reads as «nothing is being watched here»:
  // `truppAlarm` returns tier 0 outright, `peakAtemschutzAlarm` skips the Trupp, the board's card
  // tone, sort and header badge follow, and the status below can never overlay to `ueberfaellig`.
  // One line, and every downstream surface is right — rather than a `kind` check at each of them.
  const inField = isAtemschutzTrupp(t)
    && entry > 0 && t.status !== 'angemeldet' && t.status !== 'raus' && !t.exitTime
  const contactT = ms(t.lastContactTime) || entry // fall back to entry until the first contact
  const sinceContactSec = inField ? Math.max(0, Math.round((now - contactT) / SEC)) : null
  const overdue = sinceContactSec != null && sinceContactSec >= contactIntervalMin * 60 + contactGraceSec

  let status: Trupp['status']
  if (t.status === 'raus' || t.exitTime) status = 'raus'
  else if (t.status === 'angemeldet') status = 'angemeldet'
  else if (overdue) status = 'ueberfaellig'
  else if (t.status === 'rueckzug') status = 'rueckzug'
  else status = 'aktiv'

  return { elapsedSec, outSec, sinceContactSec, currentBar, lowestBar, overdue, status }
}

/**
 * True while a Trupp's contact clock is running — entered the field and not yet out. This is the
 * same "in the field" condition `deriveTruppLive` uses, but time-independent, so it can gate the
 * app-wide per-second tick: when NO Trupp is in the field (the common case for much of a shift —
 * none deployed yet, or all already raus) there is nothing to count down, so the whole 1 Hz clock
 * (and the top-to-bottom re-render it drives) can stay off. Mirrors the `inField` local above,
 * the kind gate included — a plain work squad running its Einsatzzeit needs no app-wide 1 Hz tick,
 * because nothing outside the board is watching a clock for it. (The board's own tick is
 * unconditional, so its Einsatzzeit still counts up while it is on screen.)
 */
export function truppInField(t: Trupp): boolean {
  return isAtemschutzTrupp(t)
    && ms(t.entryTime) > 0 && t.status !== 'angemeldet' && t.status !== 'raus' && !t.exitTime
}

/** Whether any Trupp needs the contact clock right now — the gate for the app-wide 1 Hz tick. */
export function anyTruppInField(trupps: Trupp[]): boolean {
  return trupps.some(truppInField)
}

/**
 * Still out there: eingerückt and never reported back — whatever kind of Trupp it is.
 *
 * ⚠️ NOT `truppInField`. That one gates the ALARM, so it asks the alarm's question — a cylinder
 * and a Funkkontakt-Intervall — and deliberately skips a work squad. The Abschluss asks a
 * different one: is anybody still on the record as being out there? A Trupp ohne Atemschutz whose
 * Einsatzzeit is still running is exactly that, and closing the Einsatz over it is how a Trupp
 * ends up on the paper with no Austritt.
 */
export function truppStillDeployed(t: Trupp): boolean {
  return ms(t.entryTime) > 0 && t.status !== 'angemeldet' && t.status !== 'raus' && !t.exitTime
}

/**
 * Registered at the Tafel and still standing there — angemeldet, never eingerückt.
 *
 * The one state where putting the Trupp's symbol somewhere and its record disagree: the picture
 * says the crew is at that spot, the board says nobody went in and no contact clock is running.
 * So placing (or joining) a marker asks whether to einrücken now — see useTruppActions ·
 * askTruppEntry. Covers a re-deployed Sicherungstrupp too (reactivateTrupp · standby), which is
 * angemeldet again with an empty entryTime.
 */
export function truppAwaitsEntry(t: Trupp): boolean {
  return !t.removedAt && t.status === 'angemeldet' && !t.entryTime
}

/**
 * Registered, then closed WITHOUT ever going under PA — the Sicherungstrupp that was never needed.
 *
 * It shares the `raus` state (2026-08-09): the crew is finished, off the active board, and can be
 * sent in later with a fresh cylinder — which is exactly what `raus` already means, and the break
 * clock beside it is the useful number for a crew that is standing at the vehicle. Only the WORD
 * differs, everywhere it is printed or shown: «draussen» claims the Trupp came out of something,
 * and on a legal record that is a statement about where people were.
 *
 * Derived from the absence of an `entryTime` rather than stored, so no old record has to be
 * migrated and no two fields can disagree about whether somebody went in.
 */
export function truppNeverDeployed(t: Trupp): boolean {
  return t.status === 'raus' && !t.entryTime
}

/**
 * Alarm tier from the contact clock alone: 0 silent · 1 fällig · 2 overdue.
 * Tier 1 is the amber "Kontakt fällig" from the interval mark (FKS-Standard: 5 min); tier 2 is
 * the hard überfällig alarm once the `contactGraceSec` on top has passed too (default: +1 min).
 */
/**
 * Where the CURRENT deployment starts in a Trupp's pressure log.
 *
 * ⚠️ The log spans every deployment a Trupp has had (17.08.): «Wieder einrücken» used to replace
 * `readings` wholesale, so the first Einsatz's entry pressure and every Kontakt/Druck taken during
 * it vanished from the Atemschutz page of the Rapport — a safety document losing exactly the half
 * that was under PA the longest. It appends now, and everything that is about the RUNNING
 * deployment (correcting the Eingangsdruck, the lowest pressure on the card) has to start here
 * rather than at index 0.
 *
 * The marker is the last `entry`/`registered` row: both open a deployment (going straight in vs.
 * being held as Sicherungstrupp). No such row ⇒ 0, which is the whole log.
 */
export function currentRunStart(readings: readonly TruppReading[] | undefined): number {
  if (!readings?.length) return 0
  for (let i = readings.length - 1; i >= 0; i--) {
    if (readings[i].kind === 'entry' || readings[i].kind === 'registered') return i
  }
  return 0
}

export function contactSeverity(sinceContactSec: number | null, contactIntervalMin: number, contactGraceSec: number): 0 | 1 | 2 {
  if (sinceContactSec == null) return 0
  const interval = contactIntervalMin * 60
  if (sinceContactSec >= interval + contactGraceSec) return 2
  if (sinceContactSec >= interval) return 1
  return 0
}

/**
 * Has the Trupp reached its Alarmdruck – the one pressure at which it turns back?
 *
 * ONE threshold on purpose. A second, lower «Mindestdruck» tier was tried and dropped
 * (2026-07-27, Atemschutz-Verantwortlicher): by the time a Trupp is below its turn-back
 * pressure it is already on the way out, so a second colour further down says nothing new
 * and only teaches the Überwacher that the first one was survivable.
 *
 * Applied to the logged Druck and to the expected-pressure Schätzung alike, but only the LOGGED
 * one raises the alarm — `truppAlarm` folds it in as tier 2, the Schätzung stays a Planungshilfe
 * that tints its own row and nothing else (air is the wearer's own responsibility, so a
 * projection must never be the thing that screams — see the module header).
 *
 * A configured 0 switches the threshold off without the caller needing a special case.
 */
export function pressureAlarm(bar: number | null, alarmBar: number): boolean {
  if (bar == null || !Number.isFinite(bar)) return false
  return alarmBar > 0 && bar <= alarmBar
}

/**
 * The threshold THIS Trupp is measured against.
 *
 * ⚠️ A second tier, and deliberately so — it reopens one half of the 27.07. decision above. That
 * decision was about a second line on the way IN («Mindestdruck» under the Alarmdruck), and it
 * stands: a crew still working has one turn-back pressure. This is the other side of it. Once a
 * Trupp is in **Rückzug** the order has been given and they are on their way out; holding them to
 * the same line means the card screams for the whole walk back, which is exactly how a warning
 * stops meaning anything. Below the Rückzug line it speaks up again — that is a crew that is late
 * getting out.
 *
 * Configurable per station (`atemschutzDoctrine().alarmBarRueckzug`); set it equal to `alarmBar`
 * and the app behaves exactly as it did before.
 */
export function alarmBarFor(
  t: Pick<Trupp, 'status'>,
  doctrine: { alarmBar: number; alarmBarRueckzug?: number },
): number {
  return t.status === 'rueckzug' ? doctrine.alarmBarRueckzug ?? doctrine.alarmBar : doctrine.alarmBar
}

/** One Trupp's alarm state — the tier plus WHY, because the two emergencies read differently. */
export interface TruppAlarm {
  /** 0 silent · 1 «Kontakt fällig» · 2 alarm (überfällig OR at the Alarmdruck) */
  sev: 0 | 1 | 2
  /** what the tier is ABOUT — null while silent. The card shows a clock for `contact` and the
   *  bar it dropped to for `pressure`; the word must never say «überfällig» for a pressure
   *  alarm, because the Verlauf and the Rapport record two different events. */
  reason: 'contact' | 'pressure' | null
  /** the Alarmdruck line THIS Trupp is held to (see alarmBarFor); null when none is configured */
  line: number | null
}

/**
 * THE tier — the single computation behind the tone, the NavRail dot, the TopBar chip, the
 * Atemschutz card, its compact row, the header badge and the «Dringlichkeit» sort.
 *
 * ⚠️ It exists because they disagreed. From 10.08. the app alarmed on the Alarmdruck while the
 * board itself still read the contact clock alone, so a Trupp at 40 bar with a fresh Funkkontakt
 * had the whole app screaming beside a green, unbadged, unsorted card — the one failure this
 * surface exists to prevent. Everything that draws a tier calls this now.
 *
 * Low pressure is tier 2 outright: there is no «fällig» half-step for it, because the Alarmdruck
 * IS the deadline rather than a lead-up to one. It also OUTRANKS the contact clock as the reason,
 * so a Trupp that is both overdue and out of air is shown as the emergency you cannot fix with a
 * radio check. Silent (`sev 0`) whenever the Trupp is not in the field — `sinceContactSec` is
 * null there, so no clock and no cylinder are being watched.
 */
export function truppAlarm(
  t: Pick<Trupp, 'status'>,
  live: Pick<TruppLive, 'sinceContactSec' | 'currentBar'>,
  contactIntervalMin: number, contactGraceSec: number,
  doctrine: { alarmBar?: number; alarmBarRueckzug?: number },
): TruppAlarm {
  if (live.sinceContactSec == null) return { sev: 0, reason: null, line: null }
  const line = doctrine.alarmBar == null ? null
    : alarmBarFor(t, { alarmBar: doctrine.alarmBar, alarmBarRueckzug: doctrine.alarmBarRueckzug })
  if (line != null && pressureAlarm(live.currentBar, line)) return { sev: 2, reason: 'pressure', line }
  const sev = contactSeverity(live.sinceContactSec, contactIntervalMin, contactGraceSec)
  return { sev, reason: sev > 0 ? 'contact' : null, line }
}

/** The most-urgent Trupp for the cross-surface badge/chip, plus the loudest tier overall. */
export interface AtemschutzAlarmState {
  /** loudest tier across all in-field Trupps (truppAlarm): 0 silent · 1 fällig · 2 alarm —
   *  which since 10.08. is überfällig OR at the Alarmdruck, not the contact clock alone */
  peak: 0 | 1 | 2
  /** the Trupp driving the alarm (highest tier, then longest since contact) — null when silent.
   *  `contactAt` (ms epoch of the last contact) lets the chip tick its own clock, so this state
   *  object can stay REFERENCE-STABLE between transitions (the 1 Hz tick must not re-render App). */
  urgent: {
    id: string; name: string; sinceContactSec: number; contactAt: number; severity: 1 | 2
    /** WHY this Trupp is the loudest — the two are different emergencies and the chip has to
     *  say which one. `contact` ticks a clock; `pressure` shows the bar it dropped to. */
    reason: 'contact' | 'pressure'
    /** the cylinder pressure, on a `pressure` alarm */
    bar?: number
  } | null
  /** per-Trupp tier for the surfaces that draw a Trupp somewhere else — today the hose line its
   *  Trupp works on (lib/truppLines). Only Trupps ABOVE 0 appear, so the object stays small and
   *  changes rarely: the alarm host compares it by content and pushes to App only when a tier
   *  actually flips, which is what keeps the 1 Hz tick out of the map (see AtemschutzAlarmHost). */
  severities: Record<string, 1 | 2>
}

/**
 * Fold every Trupp's contact clock into the single state that drives the app-wide alarm surfaces
 * (NavRail dot + TopBar chip): the peak tier and the most-urgent Trupp. Pure — one place computes
 * "is any Trupp due, and which is worst" so the badge, the chip and the tone never disagree.
 */
export function peakAtemschutzAlarm(
  trupps: Trupp[], now: number, contactIntervalMin: number, contactGraceSec: number,
  /** the Alarmdruck (bar). A Trupp at or below it is the same order of emergency as one out of
   *  contact — it has to turn round NOW — and until 10.08. it was visible on its card and
   *  nowhere else: the operator had to be looking at the Atemschutz board to learn about it. */
  alarmBar?: number,
  /** the lower line a Trupp in Rückzug is held to — see alarmBarFor. Omitted ⇒ same as alarmBar. */
  alarmBarRueckzug?: number,
): AtemschutzAlarmState {
  let peak: 0 | 1 | 2 = 0
  let urgent: AtemschutzAlarmState['urgent'] = null
  const severities: Record<string, 1 | 2> = {}
  let bestRank = -1
  for (const t of trupps) {
    const { sinceContactSec, currentBar } = deriveTruppLive(t, now, contactIntervalMin, contactGraceSec)
    if (sinceContactSec == null) continue // not in the field → no contact clock, no PA
    // the shared tier — the same one the board's cards, rows, badge and sort read (truppAlarm)
    const { sev, reason, line } = truppAlarm(t, { sinceContactSec, currentBar }, contactIntervalMin, contactGraceSec, { alarmBar, alarmBarRueckzug })
    if (sev > peak) peak = sev
    if (sev === 0) continue // narrows sev to 1 | 2 for the urgent record below
    severities[t.id] = sev
    // Rank by tier, then reason, then how far past the line. The TopBar has ONE slot: a confirmed
    // Alarmdruck must occupy it ahead of a missed contact, otherwise the app can be sounding for
    // low air while its only app-wide words still talk about radio. Among pressure alarms, the
    // one with the least air left wins; among contact alarms, the longest-overdue one wins.
    const lowPressure = reason === 'pressure'
    const overBy = lowPressure ? (line! - currentBar) * 60 : sinceContactSec
    const rank = sev * 1_000_000_000 + (lowPressure ? 100_000_000 : 0) + overBy
    if (rank > bestRank) {
      bestRank = rank
      urgent = {
        id: t.id, name: t.name, sinceContactSec, contactAt: now - sinceContactSec * 1000, severity: sev,
        reason: lowPressure ? 'pressure' : 'contact',
        bar: lowPressure ? currentBar : undefined,
      }
    }
  }
  return { peak, urgent, severities }
}

export interface PressureEstimate {
  bar: number
  /** measured pressure loss, or the configured assumed-rate fallback before enough history exists */
  source: 'history' | 'assumption'
  rateBarPerMin: number
  /** latest real pressure value anchoring the projection */
  basedAt: string
  /** entry baseline + every confirmed pressure reading since (the rate itself is measured from
   *  the FIRST of them to the latest — see estimatePressure) */
  sampleCount: number
}

/**
 * Planungshilfe only — expected pressure projected from the Trupp's confirmed pressure history.
 * Entry + actual `pressure` readings form timestamped samples; ordinary contact rows are ignored
 * because they merely repeat the last pressure and are not new measurements. The rate is the
 * EINGANGSDRUCK against the latest reading over the whole time under PA — see the note at the
 * calculation for why a rise no longer restarts it.
 *
 * Until a segment contains a measured pressure drop, the configured L/min assumption remains as
 * an explicitly labelled fallback. Deliberately OUT of `deriveTruppLive` and the alarm path: this
 * estimate never replaces a logged reading or drives an alarm.
 */
export function estimatePressure(
  t: Trupp, now: number, cylinderLiters: number, consumptionLPerMin: number,
): PressureEstimate | null {
  const entry = ms(t.entryTime)
  if (!entry || !Number.isFinite(now) || !Number.isFinite(t.entryPressureBar) || t.entryPressureBar < 0) return null

  type Sample = { at: number; bar: number }
  const validSample = (at: number, bar: number): boolean =>
    at >= entry && at <= now && Number.isFinite(bar) && bar >= 0
  const samples: Sample[] = [{ at: entry, bar: t.entryPressureBar }]

  for (const reading of t.readings ?? []) {
    // ⚠️ `alarm` IS a Druckmeldung — it is the reading that happened to cross the Alarmdruck, and
    // it is filed under its own kind only so the printed Journal can name that moment. Excluding
    // it would drop a real measurement out of the projection.
    if (reading.kind !== 'pressure' && reading.kind !== 'alarm') continue
    const at = ms(reading.t)
    if (validSample(at, reading.bar)) samples.push({ at, bar: reading.bar })
  }
  const lastAt = ms(t.lastPressureTime)
  if (t.lastPressureBar != null && validSample(lastAt, t.lastPressureBar)) {
    samples.push({ at: lastAt, bar: t.lastPressureBar })
  }

  samples.sort((a, b) => a.at - b.at)
  const unique = samples.filter((sample, i) =>
    i === 0 || sample.at !== samples[i - 1].at || sample.bar !== samples[i - 1].bar)

  // ⚠️ EINGANGSDRUCK vs. the latest reading, over the whole time under PA (revised 11.08.).
  //
  // It used to restart on any rise — a higher value was read as a new pressure basis, so
  // everything before it was thrown away. That is not what a rise means here: a Trupp does not
  // change cylinders inside a burning building, so a value going up is a correction of what was
  // typed, and the Eingangsdruck itself is now the field that gets corrected (useTruppActions ·
  // editTrupp). Meanwhile the reset had a real cost: one fat-fingered high reading left the
  // Schätzung computing consumption from two minutes of history for the rest of the Einsatz,
  // which is the least reliable window there is.
  //
  // Two points, the whole span, at any time. Nothing in between changes the answer, and a
  // «current» that is somehow ABOVE the Eingangsdruck yields no positive rate and falls back to
  // the configured assumption — which is the honest answer to a record that contradicts itself.
  const first = unique[0]
  const latest = unique[unique.length - 1]
  const elapsedMin = (latest.at - first.at) / 60000
  const measuredRate = elapsedMin > 0 ? (first.bar - latest.bar) / elapsedMin : 0
  const hasMeasuredConsumption = unique.length >= 2 && measuredRate > 0
  const fallbackRate = cylinderLiters > 0 && consumptionLPerMin > 0
    ? consumptionLPerMin / cylinderLiters
    : 0
  const rateBarPerMin = hasMeasuredConsumption ? measuredRate : fallbackRate
  if (!(rateBarPerMin > 0)) return null

  const projectedMin = Math.max(0, (now - latest.at) / 60000)
  return {
    bar: Math.max(0, Math.min(latest.bar, Math.round(latest.bar - rateBarPerMin * projectedMin))),
    source: hasMeasuredConsumption ? 'history' : 'assumption',
    rateBarPerMin,
    basedAt: new Date(latest.at).toISOString(),
    sampleCount: unique.length,
  }
}

/** mm:ss for a non-negative second count; an em-dash for null/unknown. */
export function fmtClock(sec: number | null): string {
  if (sec == null) return '–:––'
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${pad2(r)}`
}
