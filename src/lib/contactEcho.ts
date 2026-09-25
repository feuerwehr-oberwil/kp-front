import type { Trupp, TruppReading } from '../types'

/**
 * «Wurde der Kontakt schon bestätigt – auf einem anderen Gerät?» (24.09.2026, D1 ⑧a).
 *
 * On 23.09. the iPad and the phone both ran T1–T3, and T1 got two contacts 21 s apart: two
 * people answered the same radio call, each on their own device, and neither screen said that the
 * other had just done it. The phone board now asks before it writes a Kontakt that another device
 * confirmed within the last minute (AtemschutzView · askContact).
 *
 * How it tells «another device» apart without device names (item 24 was dropped): every
 * confirmation THIS JS realm writes is noted here by its (Trupp, timestamp) pair, and the synced
 * Trupp log carries every confirmation from everywhere. A confirming row whose stamp this device
 * did not write is somebody else's — a second tablet, a phone, a second tab, a link. That is the
 * whole rule, and it errs towards asking: after a reload this device's own last minute of
 * contacts reads as «anderes Gerät» too, which costs one question and never a missed one.
 *
 * ⚠️ Module scope, not component state: the board unmounts on every surface switch, and a
 * contact tapped a moment ago on this device is still this device's contact when it comes back.
 * Not persisted — the rule is about the last 60 seconds of one session.
 */

/** How long a confirmation from elsewhere answers a tap here with a question. */
export const CONTACT_ECHO_MS = 60_000

/** How far in the FUTURE a stamp may lie and still read as «just now». Two devices on the
 *  deployment clock (lib/serverClock) agree to about a second; a stamp further ahead came from a
 *  device whose clock is off, and answering it with «vor −40 s schon bestätigt» would be a
 *  question about nothing — so it is not an echo at all. */
export const CONTACT_ECHO_FUTURE_MS = 5_000

/** The log rows that confirm a Funkkontakt — every row that resets the contact clock by a radio
 *  answer: a plain Kontakt, a Druckmeldung (and its Alarmdruck crossing), a Rückzug, a Fortsetzen.
 *  NOT the Eintritt: it starts the clock, and «Kontakt wurde schon bestätigt» over a crew that
 *  has just gone in would name something that did not happen. */
const CONFIRMING: ReadonlySet<TruppReading['kind']> = new Set(['contact', 'pressure', 'alarm', 'rueckzug', 'resume'])

const own = new Set<string>()
const key = (truppId: string, at: string) => `${truppId}|${at}`

/** Record a confirmation this device wrote — called by every writer that stamps one
 *  (useTruppActions · recordContact / recordPressure / setTruppStatus). */
export function noteOwnContact(truppId: string, at: string): void {
  own.add(key(truppId, at))
  // bounded: a long Einsatz writes a few hundred of these, and only the last minute matters
  if (own.size > 500) own.delete(own.values().next().value as string)
}

/** Did THIS device write that confirmation? */
export function isOwnContact(truppId: string, at: string): boolean {
  return own.has(key(truppId, at))
}

/** Tests only: forget every noted confirmation. */
export function resetOwnContacts(): void {
  own.clear()
}

/**
 * Seconds since the Trupp's LATEST confirmation, if that confirmation came from another device
 * and is under `CONTACT_ECHO_MS` old — else `null` (nothing to ask).
 *
 * Only the latest one counts: if this device confirmed after the other one did, the operator
 * here is the one who spoke to the Trupp last, and a second tap on the same device is exactly
 * what it always was (the 2 s order freeze, no question — decided with ⑧a).
 */
export function foreignContactAgo(
  t: Pick<Trupp, 'id' | 'readings'>,
  nowMs: number,
  isOwn: (truppId: string, at: string) => boolean = isOwnContact,
): number | null {
  let latest: TruppReading | null = null
  let latestMs = -Infinity
  for (const r of t.readings ?? []) {
    if (!CONFIRMING.has(r.kind)) continue
    const ms = Date.parse(r.t)
    if (Number.isFinite(ms) && ms >= latestMs) { latest = r; latestMs = ms }
  }
  if (!latest) return null
  const age = nowMs - latestMs
  if (age >= CONTACT_ECHO_MS || age < -CONTACT_ECHO_FUTURE_MS) return null
  if (isOwn(t.id, latest.t)) return null
  // a stamp a second or two ahead of this device's reading of the server clock is «just now»
  return Math.max(0, Math.floor(age / 1000))
}
