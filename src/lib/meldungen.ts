// The Meldeleiste's model: what a message IS, and which one gets the row.
//
// What this replaces was not a stack but a PILE: five banners anchored 4px apart on the same
// axis with no awareness of each other, so the z-index decided who could be read — and it
// decided wrong. The 700px «Einsatzdaten prüfen» card (z 57) covered the 440px due-Wiedervorlage
// card (z 45) completely, i.e. the one message whose whole doctrine is «stays up until handled —
// the 3am rule» was the least visible thing on the screen.
//
// The rule here is CLASS BEFORE TIME: what stays until somebody acts always outranks what goes
// away by itself, whatever arrived last. That is what makes «Update bereit» structurally
// incapable of covering an overdue Wiedervorlage — by construction, not by luck.

/** Colour class of a message. Drives the left edge, the glyph and the queue button; never the
 *  ranking (a `warn`-toned Prüfen row does not overtake a due Wiedervorlage). */
export type MeldungTone = 'alarm' | 'warn' | 'info' | 'calm'

/** The ranking, and the whole design in seven lines. Lower gets the row; the rest queue behind
 *  the disclosure button. Adding a kind means deciding, once, where it stands — the point. */
export const MELDUNG_RANK = {
  /** a fresh dispatch, or an Einsatz that appeared without a human in the loop */
  alarm: 1,
  /** a Wiedervorlage that has come due — persists until erledigt, never expires silently */
  reminder: 2,
  /** a vehicle a drawn Leitung is attached to has driven off; its anchor is off-screen */
  gps: 3,
  /** the alarm source's guesses have not been checked yet */
  review: 4,
  /** another tab of this browser holds the edit lock */
  tabLock: 5,
  /** a new build is waiting for the next app start */
  update: 6,
  /** «KP Front als App installieren» */
  install: 7,
} as const

export type MeldungKind = keyof typeof MELDUNG_RANK

/** One button in the row. Two at most: the third action of any message is the row itself. */
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
  /** tapping the row itself, where the message has somewhere of its own to go — the reminder's
   *  «In Verlauf öffnen» is exactly this. See `meldungTap` for what happens without one. */
  onOpen?: () => void
  /** the ✕. Present only where waving the message away is legitimate: a due Wiedervorlage can
   *  be erledigt or verschoben, never dismissed. */
  dismiss?: { label: string; onClick: () => void }
}

export interface RankedMeldungen {
  /** the one message on the strip; null means the strip does not exist */
  lead: Meldung | null
  /** everything else, best first — reachable through the disclosure button, never paged past */
  queue: Meldung[]
  /** tone of the highest-ranked WAITING message, so a queued warning is announced by the button
   *  that hides it instead of sitting behind a neutral counter. Null when nothing waits. */
  pillTone: MeldungTone | null
}

/**
 * Rank the published messages and pick the one that gets the row: purely by class, and inside a
 * class by arrival. There is no operator override any more — until 23.08. tapping a queued row
 * PINNED it onto the strip, because that was the only way to reach its buttons. Now every queued
 * row carries its own buttons (see `Meldeleiste`), so promotion bought nothing and cost a tap;
 * with it went the pin, its rank-1–2 escape clause and the whole `PROTECTED_RANK` notion — the
 * sort alone guarantees the property those were written to protect.
 */
export function rankMeldungen(items: readonly Meldung[]): RankedMeldungen {
  if (items.length === 0) return { lead: null, queue: [], pillTone: null }
  // Array.prototype.sort is stable, so inside one kind the publication order (= arrival) holds:
  // class decides first, time only breaks the tie.
  const [lead, ...queue] = [...items].sort((a, b) => MELDUNG_RANK[a.kind] - MELDUNG_RANK[b.kind])
  return { lead, queue, pillTone: queue[0]?.tone ?? null }
}

/**
 * What tapping the BODY of a row does — the same on the strip and in the queue, which is the
 * point: a queued message is not a preview of a message, it IS the message.
 *
 * `onOpen` is the publisher's own answer where it has one. Where it has none, the FIRST action
 * stands in: every publisher lists the forward move first and the retreat second (Bearbeiten
 * before Passt, Übernehmen before Anhängen, Weiter folgen before Hier lösen), so the first
 * action is the surface the row points at.
 *
 * A message with no filled action makes no forward move at all — «Update bereit» only announces,
 * and its lone «Später» is a retreat wearing an action's clothes. Those rows stay plain text
 * rather than becoming a button that makes the message vanish when you touch it to read it.
 */
export function meldungTap(m: Meldung): (() => void) | null {
  if (m.onOpen) return m.onOpen
  if (!m.actions?.some((a) => a.primary)) return null
  const first = m.actions[0]
  return first.disabled ? null : first.onClick
}
