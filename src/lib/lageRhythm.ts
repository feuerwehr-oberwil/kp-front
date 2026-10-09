// The Führungsrhythmus of the Lagemeldung (F3, 09.10.2026) — a chain of ordinary Wiedervorlagen.
//
// There is no recurring-reminder model. «Gemeldet» appends the Lagemeldung row (the ANCHOR, which
// carries the facts it reported — lib/lagemeldung) and one ordinary `created` reminder row with
// `purpose: 'lagemeldung'`, due «now + interval». Everything else already exists: due-ness
// (lib/reminders · isDue), the tone (lib/alarm), the Meldeleiste row (ReminderBanner), +10′, the
// server's Web Push (backend · push.due_reminders), the Pendenzen block in the Verlauf.
//
// ⚠️ The booking's id is DERIVED from the anchor row: `lgm-<anchorRowId>`, and only the booking
// of the NEWEST anchor is open (`currentLageReminderId`). A later Lagemeldung therefore
// supersedes the previous booking without a done row, on every device and on the server alike —
// and two devices sending at once leave two anchors, of which the later one wins.
// ⚠️ Before the first Lagemeldung there is no row to hang a booking on, and nothing is written
// until the EL acts: the first «Lagemeldung fällig» is DERIVED — `firstAfterVorOrtMin` after the
// first vehicle is vor Ort (the moment the ELZ expects the Rückmeldung; owner decision 1 of the
// design, default «ja»). Its id is `lgm-start`; «+10′» on it writes the `created` row then, and
// «Rhythmus aus» a `done` row for that id. The derived start rings in the foreground only — the
// server's push knows only written rows.
// ⚠️ «Aus» is a `done` row on the current booking id; any later `created` (a new Lagemeldung, a
// rhythm picked again) starts it anew.

import type { FahrzeugZeit } from './workspace'
import type { LagemeldungRecord, TimelineEvent } from '../types'
import type { OpenReminder } from './reminders'

export type LageAnchor = LagemeldungRecord
/** The anchor as found in the Verlauf: the newest non-retracted row that carries one. */
export interface LageAnchorRef {
  id: string
  at: number
  anchor: LageAnchor
}

/** The booking before the first Lagemeldung (derived, written only by +10′ / Aus). */
export const LAGE_START_ID = 'lgm-start'
export const LAGE_ID_PREFIX = 'lgm-'
/** The booking that belongs to a Lagemeldung row. */
export const lageReminderId = (anchorRowId: string): string => `${LAGE_ID_PREFIX}${anchorRowId}`

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN)

function isAnchor(v: unknown): v is LageAnchor {
  return !!v && typeof v === 'object' && (v as LageAnchor).v === 1
    && !!(v as LageAnchor).facts && typeof (v as LageAnchor).facts === 'object'
}

/**
 * The last Lagemeldung — the newest row that carries one. Every device finds the same one: no
 * per-device state, survives a reload and a handover, works offline. A retracted row is already
 * gone from the folded Verlauf (and skipped here besides), so «↶» on a Lagemeldung hands the
 * anchor back to the one before.
 */
export function findAnchor(rows: readonly TimelineEvent[]): LageAnchorRef | null {
  let best: LageAnchorRef | null = null
  for (const r of rows) {
    if (r.retracted || !isAnchor(r.lagemeldung)) continue
    const at = ms(r.at)
    if (!Number.isFinite(at)) continue
    if (!best || at > best.at || (at === best.at && r.id > best.id)) best = { id: r.id, at, anchor: r.lagemeldung }
  }
  return best
}

/** The id of the booking that may be open now: the newest anchor's, or the start's. */
export function currentLageReminderId(rows: readonly TimelineEvent[]): string {
  const a = findAnchor(rows)
  return a ? lageReminderId(a.id) : LAGE_START_ID
}

/** The first vehicle on scene — the Rapport's Vor-Ort clock or the server's GPS arrival. */
export function firstVorOrt(fahrzeuge: readonly FahrzeugZeit[] | undefined): number | null {
  let best: number | null = null
  for (const f of fahrzeuge ?? []) {
    for (const t of [ms(f.vorOrt), ms(f.gps?.an)]) {
      if (Number.isFinite(t) && (best == null || t < best)) best = t
    }
  }
  return best
}

export interface LageRhythm {
  anchor: LageAnchorRef | null
  /** the id the next booking / +10′ / Aus acts on */
  reminderId: string
  /** when the next Lagemeldung is due (ms) — null when nothing is booked */
  dueAt: number | null
  /** the due time is the derived first one: no row exists yet */
  derived: boolean
  /** the rhythm was switched off (a done row on the current booking) */
  off: boolean
  /** the interval the next booking uses */
  intervalMin: number
}

/**
 * Where the rhythm stands — pure, from the Verlauf, the open Wiedervorlagen and the vehicle clocks.
 * `open` must come from lib/reminders · deriveReminders over the same rows.
 */
export function lageRhythm(
  rows: readonly TimelineEvent[],
  open: readonly OpenReminder[],
  fahrzeuge: readonly FahrzeugZeit[] | undefined,
  opts: { defaultMin: number; firstAfterMin: number },
): LageRhythm {
  const anchor = findAnchor(rows)
  const reminderId = anchor ? lageReminderId(anchor.id) : LAGE_START_ID
  // the interval: the latest booking that carried one, else the station's
  let intervalMin = opts.defaultMin
  let intervalAt = -Infinity
  let written = false
  for (const r of rows) {
    const rem = r.reminder
    if (!rem || !rem.id.startsWith(LAGE_ID_PREFIX)) continue
    if (rem.id === reminderId) written = true
    const at = ms(r.at)
    if (rem.intervalMin != null && rem.intervalMin > 0 && (at > intervalAt || !Number.isFinite(intervalAt))) {
      intervalMin = rem.intervalMin
      intervalAt = Number.isFinite(at) ? at : intervalAt
    }
  }
  const booked = open.find((r) => r.id === reminderId)
  if (booked) {
    const due = ms(booked.dueAt)
    return { anchor, reminderId, dueAt: Number.isFinite(due) ? due : null, derived: false, off: false, intervalMin }
  }
  if (written) return { anchor, reminderId, dueAt: null, derived: false, off: true, intervalMin }
  if (!anchor) {
    const first = firstVorOrt(fahrzeuge)
    if (first != null) return { anchor, reminderId, dueAt: first + opts.firstAfterMin * 60_000, derived: true, off: false, intervalMin }
  }
  return { anchor, reminderId, dueAt: null, derived: false, off: false, intervalMin }
}

/** The chip's state — «Lage», «Lage · in 4′», «Lage fällig» (amber), red after +5′. */
export function lageChipState(r: Pick<LageRhythm, 'dueAt' | 'off'>, now: number): { kind: 'idle' | 'soon' | 'due' | 'late' | 'off'; mins: number } {
  if (r.off) return { kind: 'off', mins: 0 }
  if (r.dueAt == null) return { kind: 'idle', mins: 0 }
  const left = r.dueAt - now
  if (left > 0) return { kind: 'soon', mins: Math.max(1, Math.ceil(left / 60_000)) }
  return { kind: -left > 5 * 60_000 ? 'late' : 'due', mins: Math.floor(-left / 60_000) }
}

/**
 * The derived first booking as a Wiedervorlage no row stands for yet (`lgm-start`): due
 * `firstAfterMin` after the first vehicle is vor Ort, as long as no Lagemeldung was sent and nothing
 * was written for the start (+10′ writes it, «Aus» closes it). Rings in the foreground and stands
 * in the Meldeleiste like any booking (useReminders · `derived`); null otherwise.
 */
export function derivedStartBooking(
  rows: readonly TimelineEvent[],
  fahrzeuge: readonly FahrzeugZeit[] | undefined,
  opts: { firstAfterMin: number; text: string },
): OpenReminder | null {
  if (findAnchor(rows)) return null
  if (rows.some((r) => r.reminder?.id === LAGE_START_ID)) return null
  const first = firstVorOrt(fahrzeuge)
  if (first == null) return null
  return {
    id: LAGE_START_ID, rowId: '', text: opts.text, createdAt: '', notes: [], purpose: 'lagemeldung',
    dueAt: new Date(first + opts.firstAfterMin * 60_000).toISOString(),
  }
}
