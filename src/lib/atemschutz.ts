// Atemschutzüberwachung (SCBA breathing-apparatus monitoring) — the pure contact-timer math.
//
// Doctrine: Swiss FKS/CSSP. The Atemschutzüberwacher's job is to track the time since the
// Trupp's last contact (Funkkontakt) and raise the alarm when it runs past the interval —
// NOT to predict air consumption. Air is the wearer's own responsibility. Pressure is logged
// for the record (and counts as a contact) but never drives the alarm.
//
// This module is framework-free so the clock/threshold logic is unit-testable in isolation.
// The view layer (AtemschutzView) feeds it a Trupp + the current wall-clock time and renders
// the derived live numbers + the contact-clock alarm tier.

import type { Trupp } from '../types'

export interface TruppLive {
  /** seconds elapsed since entry (entryTime → now) — the total Einsatzzeit */
  elapsedSec: number
  /** seconds since the last contact; null while not in the field (angemeldet / raus) */
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
  const elapsedSec = entry ? Math.max(0, Math.round((now - entry) / SEC)) : 0
  const currentBar = t.lastPressureBar ?? t.entryPressureBar
  const lowestBar = t.lowestBar ?? currentBar

  // "in the field" = entered and not yet out — robust to any non-terminal status (incl. legacy
  // data), so the contact clock is never silently dead for a Trupp that is actually inside.
  const inField = entry > 0 && t.status !== 'angemeldet' && t.status !== 'raus' && !t.exitTime
  const contactT = ms(t.lastContactTime) || entry // fall back to entry until the first contact
  const sinceContactSec = inField ? Math.max(0, Math.round((now - contactT) / SEC)) : null
  const overdue = sinceContactSec != null && sinceContactSec >= contactIntervalMin * 60 + contactGraceSec

  let status: Trupp['status']
  if (t.status === 'raus' || t.exitTime) status = 'raus'
  else if (t.status === 'angemeldet') status = 'angemeldet'
  else if (overdue) status = 'ueberfaellig'
  else if (t.status === 'rueckzug') status = 'rueckzug'
  else status = 'aktiv'

  return { elapsedSec, sinceContactSec, currentBar, lowestBar, overdue, status }
}

/**
 * True while a Trupp's contact clock is running — entered the field and not yet out. This is the
 * same "in the field" condition `deriveTruppLive` uses, but time-independent, so it can gate the
 * app-wide per-second tick: when NO Trupp is in the field (the common case for much of a shift —
 * none deployed yet, or all already raus) there is nothing to count down, so the whole 1 Hz clock
 * (and the top-to-bottom re-render it drives) can stay off. Mirrors the `inField` local above.
 */
export function truppInField(t: Trupp): boolean {
  return ms(t.entryTime) > 0 && t.status !== 'angemeldet' && t.status !== 'raus' && !t.exitTime
}

/** Whether any Trupp needs the contact clock right now — the gate for the app-wide 1 Hz tick. */
export function anyTruppInField(trupps: Trupp[]): boolean {
  return trupps.some(truppInField)
}

/**
 * Alarm tier from the contact clock alone: 0 silent · 1 fällig · 2 overdue.
 * Tier 1 is the amber "Kontakt fällig" from the interval mark (FKS-Standard: 5 min); tier 2 is
 * the hard überfällig alarm once the `contactGraceSec` on top has passed too (default: +1 min).
 */
export function contactSeverity(sinceContactSec: number | null, contactIntervalMin: number, contactGraceSec: number): 0 | 1 | 2 {
  if (sinceContactSec == null) return 0
  const interval = contactIntervalMin * 60
  if (sinceContactSec >= interval + contactGraceSec) return 2
  if (sinceContactSec >= interval) return 1
  return 0
}

/** The most-urgent Trupp for the cross-surface badge/chip, plus the loudest tier overall. */
export interface AtemschutzAlarmState {
  /** loudest contact-clock tier across all in-field Trupps: 0 silent · 1 fällig · 2 überfällig */
  peak: 0 | 1 | 2
  /** the Trupp driving the alarm (highest tier, then longest since contact) — null when silent.
   *  `contactAt` (ms epoch of the last contact) lets the chip tick its own clock, so this state
   *  object can stay REFERENCE-STABLE between transitions (the 1 Hz tick must not re-render App). */
  urgent: { id: string; name: string; sinceContactSec: number; contactAt: number; severity: 1 | 2 } | null
}

/**
 * Fold every Trupp's contact clock into the single state that drives the app-wide alarm surfaces
 * (NavRail dot + TopBar chip): the peak tier and the most-urgent Trupp. Pure — one place computes
 * "is any Trupp due, and which is worst" so the badge, the chip and the tone never disagree.
 */
export function peakAtemschutzAlarm(
  trupps: Trupp[], now: number, contactIntervalMin: number, contactGraceSec: number,
): AtemschutzAlarmState {
  let peak: 0 | 1 | 2 = 0
  let urgent: AtemschutzAlarmState['urgent'] = null
  let bestRank = -1
  for (const t of trupps) {
    const { sinceContactSec } = deriveTruppLive(t, now, contactIntervalMin, contactGraceSec)
    if (sinceContactSec == null) continue // not in the field → no contact clock
    const sev = contactSeverity(sinceContactSec, contactIntervalMin, contactGraceSec)
    if (sev > peak) peak = sev
    if (sev === 0) continue // narrows sev to 1 | 2 for the urgent record below
    // rank by tier first, then by how long since contact — the worst, longest-waiting Trupp wins
    const rank = sev * 1_000_000 + sinceContactSec
    if (rank > bestRank) {
      bestRank = rank
      urgent = { id: t.id, name: t.name, sinceContactSec, contactAt: now - sinceContactSec * 1000, severity: sev }
    }
  }
  return { peak, urgent }
}

export interface PressureEstimate {
  bar: number
  /** measured pressure loss, or the configured assumed-rate fallback before enough history exists */
  source: 'history' | 'assumption'
  rateBarPerMin: number
  /** latest real pressure value anchoring the projection */
  basedAt: string
  /** entry baseline + confirmed pressure readings in the current non-increasing segment */
  sampleCount: number
}

/**
 * Planungshilfe only — expected pressure projected from the Trupp's confirmed pressure history.
 * Entry + actual `pressure` readings form timestamped samples; ordinary contact rows are ignored
 * because they merely repeat the last pressure and are not new measurements. A pressure increase
 * starts a fresh segment (new cylinder/correction) rather than becoming negative consumption.
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
    if (reading.kind !== 'pressure') continue
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

  // Only the latest continuous segment is meaningful. A rise indicates a new pressure basis,
  // normally a cylinder change or correction, so older consumption must not leak across it.
  let segment: Sample[] = []
  for (const sample of unique) {
    if (segment.length && sample.bar > segment[segment.length - 1].bar) segment = [sample]
    else segment.push(sample)
  }

  const first = segment[0]
  const latest = segment[segment.length - 1]
  const elapsedMin = (latest.at - first.at) / 60000
  const measuredRate = elapsedMin > 0 ? (first.bar - latest.bar) / elapsedMin : 0
  const hasMeasuredConsumption = segment.length >= 2 && measuredRate > 0
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
    sampleCount: segment.length,
  }
}

/** mm:ss for a non-negative second count; an em-dash for null/unknown. */
export function fmtClock(sec: number | null): string {
  if (sec == null) return '–:––'
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
