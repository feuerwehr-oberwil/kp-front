// The Meldeleiste's model: what a message IS, and in which order the messages stand.
//
// What this replaces was not a stack but a PILE: five banners anchored 4px apart on the same
// axis with no awareness of each other, so the z-index decided who could be read — and it
// decided wrong. The 700px «Einsatzdaten prüfen» card (z 57) covered the 440px due-Wiedervorlage
// card (z 45) completely, i.e. the one message whose whole doctrine is «stays up until handled —
// the 3am rule» was the least visible thing on the screen.
//
// The rule here is CLASS BEFORE TIME: what stays until somebody acts always outranks what goes
// away by itself, whatever arrived last. That is what makes «Update bereit» structurally
// incapable of standing above an overdue Wiedervorlage — by construction, not by luck.

/** Colour class of a message. Drives the row's left edge and its glyph; never the order (a
 *  `warn`-toned Prüfen row does not overtake a due Wiedervorlage). */
export type MeldungTone = 'alarm' | 'warn' | 'info' | 'calm'

/** The ranking, and the whole design in eight lines. Lower stands higher on the strip. Adding a
 *  kind means deciding, once, where it stands — the point. */
export const MELDUNG_RANK = {
  /** an Atemschutztrupp is überfällig or has reached its Alarmdruck — the audible alarm's own
   *  row, and the ONLY message on this strip about somebody who can die in the next minutes.
   *  It outranks the dispatch on purpose: a fresh alarm can wait twenty seconds, a Trupp out of
   *  contact cannot, and it belongs to the Einsatz the operator is already in. Its own kind
   *  rather than `alarm` so `useMeldungKindPending('alarm')` keeps meaning «a dispatch is
   *  waiting to be taken» — see ReviewBanner, which must not blink out and back every time a
   *  contact clock runs over. */
  atemschutz: 1,
  /** a fresh dispatch, or an Einsatz that appeared without a human in the loop */
  alarm: 2,
  /** a Wiedervorlage that has come due — persists until erledigt, never expires silently */
  reminder: 3,
  /** a vehicle a drawn Leitung is attached to has driven off; its anchor is off-screen */
  gps: 4,
  /** the alarm source's guesses have not been checked yet */
  review: 5,
  /** another tab of this browser holds the edit lock */
  tabLock: 6,
  /** a new build is waiting for the next app start */
  update: 7,
  /** «KP Front als App installieren» */
  install: 8,
} as const

export type MeldungKind = keyof typeof MELDUNG_RANK

/** One button in the row. Two at most — and, together with the ✕ and the row's title where it has
 *  an `onOpen`, the ONLY things in a row that do anything: the rest of the body is inert (see
 *  `Meldeleiste`). */
export interface MeldungAction {
  label: string
  icon?: string
  /** spin the glyph — the action is running (taking an alarm reaches the server) */
  busy?: boolean
  onClick: () => void
  /** the row's one filled action (AGENTS.md button spec) */
  primary?: boolean
  disabled?: boolean
}

/** A message, as a record. Every banner this layer replaced used to be a component with its own
 *  geometry, z-index and live region; now each is one of these and the strip owns all three. */
export interface Meldung {
  /** stable per source — the reminder's row keeps its identity while its text changes */
  id: string
  kind: MeldungKind
  tone: MeldungTone
  /** sprite id from lib/icons */
  icon: string
  title: string
  sub?: string
  actions?: MeldungAction[]
  /** Where this message LEADS — and, if it is set, the row's title becomes the way there.
   *  The title only: the sub-line, the glyph and the space beside them stay dead, because a row
   *  whose whole body acts is what let a tap meant to READ a message take an alarm (23.08.).
   *  `label` is the full sentence («In Verlauf öffnen»): the visible title says what the message
   *  is about, never what following it does, so the accessible name has to carry both. */
  onOpen?: { label: string; onClick: () => void }
  /** the ✕. Present only where waving the message away is legitimate: a due Wiedervorlage can
   *  be erledigt or verschoben, never dismissed. */
  dismiss?: { label: string; onClick: () => void }
}

/**
 * Order the published messages: purely by class, and inside a class by arrival. Every one of them
 * becomes a row — the strip has no head, no queue and no disclosure since 23.08., because the
 * numbers said it almost always holds zero or one message and a permanent mechanism was being
 * paid for a pile-up that only happens when a Wiedervorlage with a Fälligkeit meets an alarm.
 *
 * The order is therefore the only guarantee left, and it is enough: a rank-1–2 message is at the
 * top, and nothing below it is hidden.
 */
export function rankMeldungen(items: readonly Meldung[]): Meldung[] {
  // Array.prototype.sort is stable, so inside one kind the publication order (= arrival) holds:
  // class decides first, time only breaks the tie.
  return [...items].sort((a, b) => MELDUNG_RANK[a.kind] - MELDUNG_RANK[b.kind])
}
